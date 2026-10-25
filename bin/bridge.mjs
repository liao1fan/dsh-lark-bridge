#!/usr/bin/env node
/**
 * dsh-lark-bridge — 在飞书里指挥 dsh 会话的桥接守护进程
 */
import { spawn, execFileSync } from "node:child_process";
import { Writable, Readable } from "node:stream";
import { accessSync, constants, readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, statSync, readdirSync } from "node:fs";
import { isAbsolute, resolve, basename, dirname, join } from "node:path";
import { homedir } from "node:os";

const HERE = new URL(".", import.meta.url).pathname;

// ---------------- 运行时路径发现（可移植，不写死安装路径） ----------------
const HOME = process.env.HOME || homedir();
// dsh 数据目录：优先环境变量，默认 ~/.dsh
const DSH_DATA = process.env.DSH_HOME || process.env.DSH_CONFIG_DIR || join(HOME, ".dsh");
const DSH_SESSIONS_ROOT = join(DSH_DATA, "sessions");
const WORKSPACE_JSON = join(DSH_DATA, "storages", "workspace.json");

function looksLikeDsh(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return pkg?.name === "@deepseek-ai/dsh" && existsSync(join(dir, "node_modules/@agentclientprotocol/sdk/dist/acp.js"));
  } catch { return false; }
}
function findDsh() {
  const cands = [];
  if (process.env.DSH_ROOT) cands.push(process.env.DSH_ROOT);
  // 1) which dsh → 向上找包根
  try {
    const bin = execFileSync("readlink", ["-f", execFileSync("which", ["dsh"], { encoding: "utf8" }).trim()], { encoding: "utf8" }).trim();
    let d = dirname(bin);
    for (let i = 0; i < 6 && d !== dirname(d); i++, d = dirname(d)) {
      cands.push(d);
      if (looksLikeDsh(d)) break;
    }
  } catch { }
  // 2) npm root -g
  try { cands.push(join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@deepseek-ai/dsh")); } catch { }
  // 3) 常见全局路径
  cands.push("/usr/local/lib/node_modules/@deepseek-ai/dsh", "/usr/lib/node_modules/@deepseek-ai/dsh");
  // 4) nvm/fnm/volta
  for (const base of [join(HOME, ".nvm", "versions", "node"), join(HOME, ".local", "share", "fnm", "node-versions"), join(HOME, ".volta", "tools", "image", "node")]) {
    try {
      for (const v of readdirSync(base)) {
        cands.push(join(base, v, "lib", "node_modules", "@deepseek-ai", "dsh"));
        cands.push(join(base, v, "installation", "lib", "node_modules", "@deepseek-ai", "dsh"));
      }
    } catch { }
  }
  return cands.find(looksLikeDsh) ?? null;
}
const DSH = findDsh();
if (!DSH) {
  console.error(new Date().toISOString(), "❌ 未找到 dsh 安装目录，请设置 DSH_ROOT 环境变量指向 @deepseek-ai/dsh 包路径");
  process.exit(1);
}
const { client, ndJsonStream, methods, PROTOCOL_VERSION } = await import(DSH + "/node_modules/@agentclientprotocol/sdk/dist/acp.js");

// ---------------- config / state ----------------
const CONFIG = JSON.parse(readFileSync(HERE + "../config/bridge.config.json", "utf8"));
const STATE_PATH = HERE + "../config/state.json";
let STATE = { chats: {} };
try { STATE = { chats: {}, ...JSON.parse(readFileSync(STATE_PATH, "utf8")) }; } catch { }
function saveState() {
  try {
    writeFileSync(STATE_PATH, JSON.stringify(STATE, (k, v) => (k === "pendingImage" || k === "pendingFile") ? undefined : v, 2));
  } catch (e) { log("state save failed", e.message); }
}
const log = (...a) => console.error(new Date().toISOString(), ...a);

// ---------------- lark helpers ----------------
function runLark(args, stdinData) {
  return new Promise((res) => {
    const p = spawn("lark-cli", args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => res({ ok: false, error: e.message, stderr: err }));
    p.on("close", (code) => {
      let json = null; try { json = JSON.parse(out); } catch { }
      res({ ok: code === 0 && json?.ok === true, json, raw: out, stderr: err, code });
    });
    if (stdinData != null) { p.stdin.write(stdinData); p.stdin.end(); } else p.stdin.end();
  });
}
async function sendMarkdown(chatId, md) {
  const r = await runLark(["im", "+messages-send", "--as", "bot", "--chat-id", chatId, "--markdown", "-"], md);
  if (!r.ok) { log("sendMarkdown failed", (r.stderr || r.raw || "").slice(-300)); return null; }
  return r.json?.data?.message_id ?? null;
}
async function sendText(chatId, text) {
  const r = await runLark(["im", "+messages-send", "--as", "bot", "--chat-id", chatId, "--text", "-"], text);
  if (!r.ok) { log("sendText failed", (r.stderr || r.raw || "").slice(-300)); return null; }
  return r.json?.data?.message_id ?? null;
}
async function sendCard(chatId, cardJson) {
  const r = await runLark(["im", "+messages-send", "--as", "bot", "--chat-id", chatId, "--msg-type", "interactive", "--content", "-"], JSON.stringify(cardJson));
  if (!r.ok) { log("sendCard failed", (r.stderr || r.raw || "").slice(-500)); return null; }
  return r.json?.data?.message_id ?? null;
}
async function editMarkdown(messageId, md) {
  const r = await runLark(["im", "+messages-edit", "--as", "bot", "--message-id", messageId, "--markdown", "-"], md);
  if (!r.ok) { log("editMarkdown failed", (r.stderr || r.raw || "").slice(-300)); return false; }
  return true;
}
async function updateCard(token, cardJson) {
  const r = await runLark(["api", "POST", "/open-apis/interactive/v1/card/update", "--as", "bot", "--data", "-"], JSON.stringify({ token, card: cardJson }));
  if (!r.ok) { log("updateCard failed", (r.stderr || r.raw || "").slice(-300)); return false; }
  return true;
}
async function patchCardMessage(messageId, cardJson) {
  const r = await runLark(["im", "messages", "patch", "--as", "bot", "--message-id", messageId, "--data", "-"], JSON.stringify({ content: JSON.stringify(cardJson) }));
  if (!r.ok) { log("patchCardMessage failed", (r.stderr || r.raw || "").slice(-200)); return false; }
  return true;
}
async function ackReaction(messageId) {
  const r = await runLark(["im", "reactions", "create", "--as", "bot", "--message-id", messageId, "--data", "-"], JSON.stringify({ reaction_type: { emoji_type: "Get" } }));
  if (!r.ok) log("ackReaction failed", messageId);
}
async function pinMessage(chatId, messageId) {
  const r = await runLark(["im", "pins", "create", "--as", "bot", "--data", "-"], JSON.stringify({ message_id: messageId }));
  if (!r.ok) { log("pin failed", (r.stderr || r.raw || "").slice(-200)); return false; }
  return true;
}

// ---------------- streaming card (cardkit) ----------------
const STREAM_ELEMENT_ID = "md";
async function createStreamingCard(summary, stopValue = { do: "stop" }) {
  const card = {
    schema: "2.0",
    config: {
      update_multi: true, streaming_mode: true,
      streaming_config: { print_frequency_ms: { default: 70 }, print_step: { default: 1 }, print_strategy: "fast" },
      summary: { content: summary },
    },
    body: { elements: [
      { tag: "markdown", content: "💭 收到指令，正在处理…", element_id: STREAM_ELEMENT_ID },
      { tag: "button", element_id: "stopbtn", text: { tag: "plain_text", content: "⏹ 停止" }, type: "danger", size: "medium", width: "fill", behaviors: [{ type: "callback", value: stopValue }] },
    ] },
  };
  const r = await runLark(["api", "POST", "/open-apis/cardkit/v1/cards", "--as", "bot", "--data", "-"], JSON.stringify({ type: "card_json", data: JSON.stringify(card) }));
  if (!r.ok) throw new Error("cardkit create: " + (r.stderr || r.raw || "").slice(-200));
  const cardId = r.json?.data?.card_id;
  if (!cardId) throw new Error("no card_id");
  return cardId;
}
async function sendCardEntity(chatId, cardId) {
  const r = await runLark(["im", "+messages-send", "--as", "bot", "--chat-id", chatId, "--msg-type", "interactive", "--content", "-"], JSON.stringify({ type: "card", data: { card_id: cardId } }));
  if (!r.ok) throw new Error("send card entity: " + (r.stderr || r.raw || "").slice(-200));
  return r.json?.data?.message_id ?? null;
}
class StreamCard {
  constructor(cardId) { this.cardId = cardId; this.seq = 0; this.closed = false; }
  async rawPush(content) {
    this.seq++;
    return runLark(["api", "PUT", `/open-apis/cardkit/v1/cards/${this.cardId}/elements/${STREAM_ELEMENT_ID}/content`, "--as", "bot", "--data", "-"], JSON.stringify({ content, sequence: this.seq }));
  }
  async push(content) {
    if (this.closed) return;
    let r = await this.rawPush(content);
    if (!r.ok && /300309|200850|streaming mode is closed/.test((r.stderr || "") + (r.raw || ""))) {
      this.seq++;
      const s2 = await runLark(["api", "PATCH", `/open-apis/cardkit/v1/cards/${this.cardId}/settings`, "--as", "bot", "--data", "-"], JSON.stringify({ settings: JSON.stringify({ config: { streaming_mode: true, streaming_config: { print_frequency_ms: { default: 70 }, print_step: { default: 1 }, print_strategy: "fast" } } }), sequence: this.seq }));
      if (s2.ok) { log("stream re-enabled", this.cardId); r = await this.rawPush(content); }
    }
    if (!r.ok) log("stream push failed seq", this.seq, (r.stderr || r.raw || "").slice(-200));
  }
  async removeElement(elementId) {
    if (this.closed) return;
    this.seq++;
    const r = await runLark(["api", "DELETE", `/open-apis/cardkit/v1/cards/${this.cardId}/elements/${elementId}`, "--as", "bot", "--data", "-"], JSON.stringify({ sequence: this.seq }));
    if (!r.ok) log("stream removeElement failed", (r.stderr || r.raw || "").slice(-200));
  }
  async close(summary) {
    if (this.closed) return;
    this.closed = true; this.seq++;
    const settings = { config: { streaming_mode: false } };
    if (summary) settings.config.summary = { content: summary };
    const r = await runLark(["api", "PATCH", `/open-apis/cardkit/v1/cards/${this.cardId}/settings`, "--as", "bot", "--data", "-"], JSON.stringify({ settings: JSON.stringify(settings), sequence: this.seq }));
    if (!r.ok) log("stream close failed", (r.stderr || r.raw || "").slice(-200));
  }
}
class StreamBuf {
  constructor(sc, capBytes = 22000) { this.sc = sc; this.capBytes = capBytes; this.buf = ""; this.pushed = null; this.truncated = false; }
  seed(s) { if (this.pushed === null) this.buf = s; else this.append(s); }
  append(s) {
    if (Buffer.byteLength(this.buf, "utf8") >= this.capBytes) {
      if (!this.truncated) { this.buf += "\n\n（内容超限，完整内容见后续消息…）"; this.truncated = true; }
      return;
    }
    this.buf += s;
  }
  get full() { return this.buf; }
  async flush() { if (this.buf !== this.pushed && !this.sc?.closed) { this.pushed = this.buf; await this.sc.push(this.buf); } }
}

// ---------------- ACP agent ----------------
class Acp {
  constructor() { this.ctx = null; this.active = new Set(); this.configOptions = new Map(); this.promptAborts = new Map(); this.updateListeners = new Map(); this.spawn(); }
  spawn() {
    const proc = spawn("dsh", ["--profile", "acp"], { stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    const stream = ndJsonStream(Writable.toWeb(proc.stdin), Readable.toWeb(proc.stdout));
    const app = client({ name: "dsh-lark-bridge" })
      .onRequest(methods.client.session.requestPermission, async (c) => {
        const opts = c.params.options ?? [];
        const title = c.params.toolCall?.title ?? "(untitled)";
        log("permission request:", title, "->", CONFIG.autoApprovePermissions ? "auto-approve" : "reject");
        this.emitActivity(c.params.sessionId, `🔐 授权请求：${title}`);
        if (!CONFIG.autoApprovePermissions) return { outcome: { outcome: "rejected" } };
        const pick = opts.find((o) => /once/i.test(o.name ?? "")) ?? opts.find((o) => /always/i.test(o.name ?? "")) ?? opts[0];
        return { outcome: { outcome: "selected", optionId: pick?.optionId ?? "" } };
      })
      .onNotification(methods.client.session.update, (c) => {
        this.emitActivity(c.params.sessionId, describeUpdate(c.params.update));
        (this.updateListeners.get(c.params.sessionId) ?? []).forEach((fn) => fn(c.params.update));
      });
    app.connectWith(stream, async (ctx) => {
      await ctx.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
      this.ctx = ctx;
      log("acp initialized");
      await new Promise(() => { });
    }).catch((e) => { log("acp connection error:", e?.message); this.ctx = null; this.active.clear(); this.configOptions.clear(); setTimeout(() => { if (!this.stopped) this.spawn(); }, 3000); });
    proc.on("exit", (code) => {
      if (this.stopped) return;
      log("acp exited code=", code, "— restarting in 3s");
      this.ctx = null; this.active.clear(); this.configOptions.clear();
      setTimeout(() => { if (!this.stopped) this.spawn(); }, 3000);
    });
  }
  stop() { this.stopped = true; try { this.proc.kill(); } catch { } }
  ready() { return this.ctx != null; }
  onSessionUpdates(sid, fn) { if (!this.updateListeners.has(sid)) this.updateListeners.set(sid, []); this.updateListeners.get(sid).push(fn); return () => { this.updateListeners.set(sid, (this.updateListeners.get(sid) ?? []).filter((f) => f !== fn)); }; }
  emitActivity(sid, text) { (this.activityHandlers ??= new Map()); (this.activityHandlers.get(sid) ?? []).forEach((fn) => fn(text)); }
  onActivity(sid, fn) { (this.activityHandlers ??= new Map()); if (!this.activityHandlers.has(sid)) this.activityHandlers.set(sid, []); this.activityHandlers.get(sid).push(fn); return () => { this.activityHandlers.set(sid, this.activityHandlers.get(sid).filter((f) => f !== fn)); }; }
  async list() { return (await this.ctx.request(methods.agent.session.list, {})).sessions ?? []; }
  async newSession(cwd) {
    const r = await this.ctx.request(methods.agent.session.new, { cwd, mcpServers: [] });
    this.active.add(r.sessionId); if (r.configOptions) this.configOptions.set(r.sessionId, r.configOptions);
    try { await this.applyDefaultModel(r.sessionId); } catch (e) { log("apply defaultModel failed", e?.message); }
    try { await registerSessionInGui(r.sessionId, cwd); } catch (e) { log("register failed", e?.message); }
    return r;
  }
  // 把 CONFIG.defaultModel 套到新会话上（profile 里的 provider/model 只用于能力声明，例如图片能力）
  async applyDefaultModel(sessionId) {
    const want = CONFIG.defaultModel; if (!want) return null;
    const co = this.getConfigOptions(sessionId) ?? [];
    const m = co.find((o) => o.id === "model"); if (!m) return null;
    const flat = []; for (const g of m.options ?? []) for (const o of g.options ?? []) flat.push({ group: g.group ?? g.name, name: o.name, value: o.value });
    const kw = String(want).toLowerCase();
    const hit = flat.find((o) => o.value.toLowerCase().includes(kw) || `${o.group} ${o.name}`.toLowerCase().includes(kw));
    if (!hit || m.currentValue === hit.value) return null;
    await this.setConfigOption(sessionId, "model", hit.value);
    log("defaultModel applied", sessionId.slice(0, 8), "->", hit.name);
    return hit.name;
  }
  async ensureActive(sessionId, cwd) {
    if (this.active.has(sessionId)) return;
    try {
      const r = await this.ctx.request(methods.agent.session.resume, { sessionId, cwd, mcpServers: [] });
      this.active.add(sessionId); if (r?.configOptions) this.configOptions.set(sessionId, r.configOptions);
    } catch (e) { if (/already active/i.test(e?.message ?? "")) { this.active.add(sessionId); return; } throw e; }
  }
  async closeSession(sessionId) { try { await this.ctx.request(methods.agent.session.close, { sessionId }); } finally { this.active.delete(sessionId); this.promptAborts.delete(sessionId); } }
  async setConfigOption(sessionId, configId, value) { const r = await this.ctx.request(methods.agent.session.setConfigOption, { sessionId, configId, value }); if (r?.configOptions) this.configOptions.set(sessionId, r.configOptions); return r; }
  getConfigOptions(sessionId) { return this.configOptions.get(sessionId) ?? null; }
  cancel(sessionId) { const ac = this.promptAborts.get(sessionId); if (ac) ac.abort(); return ac != null; }
  async prompt(sessionId, text, image, files) {
    const ac = new AbortController(); this.promptAborts.set(sessionId, ac);
    const blocks = [];
    // ACP 的图片块字段是 mimeType（不是 mediaType），写错会被 dsh 判为 Invalid params
    if (image) blocks.push({ type: "image", data: image.data, mimeType: image.mediaType });
    for (const f of files ?? []) blocks.push({ type: "resource_link", name: f.name, uri: `file://${f.path}` });
    blocks.push({ type: "text", text });
    try { return await this.ctx.request(methods.agent.session.prompt, { sessionId, prompt: blocks }, { cancellationSignal: ac.signal }); }
    finally { this.promptAborts.delete(sessionId); }
  }
}
function describeUpdate(u) {
  switch (u.sessionUpdate) {
    case "agent_message_chunk": return u.content?.type === "text" ? null : "💬 回复中…";
    case "agent_thought_chunk": return "💭 思考中…";
    case "tool_call": { const n = u.name ?? "tool"; return `🔧 ${n}`; }
    case "tool_call_update": return `🔧 ${u.title ?? u.toolCallId ?? ""}（${u.status ?? ""}）`;
    default: return null;
  }
}

// ---------------- session log reading ----------------
let sessionStore = null;
async function openSessionStore() {
  if (sessionStore) return sessionStore;
  const { Context } = await import(DSH + "/node_modules/@deepseek-ai/cordis/lib/index.js");
  const mod = await import(DSH + "/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js");
  sessionStore = new mod.default(new Context(), { root: DSH_SESSIONS_ROOT });
  return sessionStore;
}
async function readSessionEvents(sessionId) {
  try {
    const store = await openSessionStore();
    const h = await store.open(sessionId, "read");
    try { return (await h.read(0)).events ?? []; } finally { await h.close(); }
  } catch (e) { log("readSessionEvents failed", shortId(sessionId), e.message); return []; }
}
function blocksText(content) { if (!Array.isArray(content)) return ""; return content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("").trim(); }
function extractRounds(events) {
  const rounds = []; let cur = null;
  const flush = () => { if (cur && (cur.user || cur.assistant.length)) rounds.push(cur); cur = null; };
  for (const e of events) {
    if (e.type === "user/message") {
      if (e.data?.source?.kind !== "user") continue;
      flush(); cur = { time: e.time ?? null, user: blocksText(e.data?.content), assistant: [], tools: [] };
    } else if (e.type === "assistant/message") {
      const t = blocksText(e.data?.message?.content);
      if (!t) continue;
      if (cur) cur.assistant.push(t); else cur = { time: e.time ?? null, user: "", assistant: [t], tools: [] };
    } else if (e.type === "tool/call") {
      const name = e.data?.name ?? "tool";
      let line = `🔧 ${name}`;
      try { const a = JSON.parse(e.data?.arguments ?? "{}"); const hint = a.description ?? a.command ?? a.file_path ?? a.path ?? a.pattern ?? ""; if (hint) line = `🔧 ${name}：${oneLine(String(hint), 60)}`; } catch { }
      if (cur) cur.tools.push(name); if (cur) { } // tools counted by name
      if (cur) { } // line not pushed to steps (steps are for spectator)
    }
  }
  flush(); return rounds;
}
const oneLine = (s, n) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + "…" : t; };
const clip = (s, n) => { const t = s.trim(); return t.length > n ? t.slice(0, n) + "\n\n…（超长截断，完整内容见会话）" : t; };
const fmtTime = (ms) => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "—");
const shortId = (sid) => (sid ?? "").replace(/^session-/, "").slice(0, 8);

// ---------------- cross-terminal status engine ----------------
const tailCache = new Map();
const runningSet = new Set();
const chatBusyBySession = new Map();
function sessionLogStat(cwd, sessionId) { const dir = sessionDirFor(cwd, sessionId); if (!dir) return null; try { return statSync(dir + "/session.v3.jsonl.zstd"); } catch { return null; } }
function deriveTurnStatus(events) {
  let turnStartIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) { if (events[i].type === "turn/start") { turnStartIdx = i; break; } }
  if (turnStartIdx < 0) return { running: false, startedAt: null, prompt: "", steps: [], lastActivity: "", endReason: null };
  let prompt = "", lastActivity = "", endReason = null;
  const steps = []; let running = true;
  for (let i = turnStartIdx; i < events.length; i++) {
    const e = events[i];
    if (e.type === "turn/end") { running = false; endReason = e.data?.reason?.kind ?? null; continue; }
    if (e.type === "user/message" && e.data?.source?.kind === "user") { if (!prompt) prompt = oneLine(blocksText(e.data?.content), 120); }
    else if (e.type === "tool/call") {
      const name = e.data?.name ?? "tool";
      let line = `🔧 ${name}`;
      try { const a = JSON.parse(e.data?.arguments ?? "{}"); const hint = a.description ?? a.command ?? a.file_path ?? a.path ?? a.pattern ?? ""; if (hint) line = `🔧 ${name}：${oneLine(String(hint), 60)}`; } catch { }
      lastActivity = line; steps.push(line);
    } else if (e.type === "assistant/message") {
      const t = blocksText(e.data?.message?.content);
      if (t) { lastActivity = `💬 ${oneLine(t, 80)}`; steps.push(t); }
    }
  }
  return { running, startedAt: events[turnStartIdx].time ?? null, prompt, steps, lastActivity, endReason };
}
async function sessionTurnStatus(sessionId, cwd) {
  const st = sessionLogStat(cwd, sessionId); if (!st) return null;
  const key = `${st.mtimeMs}:${st.size}`;
  const cached = tailCache.get(sessionId); const isRunning = runningSet.has(sessionId);
  if (cached && cached.key === key) return cached.status;
  if (cached && Date.now() - (cached.readAt ?? 0) < 3500) return cached.status;
  if (!isRunning && Date.now() - st.mtimeMs > 45000 && cached) return cached.status;
  const status = deriveTurnStatus(await readSessionEvents(sessionId));
  if (status.running && Date.now() - st.mtimeMs > (CONFIG.stalledTurnMs ?? 120000)) { status.running = false; status.stalled = true; }
  status.steps = (status.steps ?? []).slice(-40).map((s) => (s.startsWith("🔧") ? s : (s.length > 4000 ? s.slice(0, 4000) + "…" : s)));
  tailCache.set(sessionId, { key, status, readAt: Date.now() });
  if (status.running) runningSet.add(sessionId); else runningSet.delete(sessionId);
  return status;
}
async function annotateSessions(sessions) {
  const out = [];
  for (let i = 0; i < sessions.length; i += 3) {
    const batch = await Promise.all(sessions.slice(i, i + 3).map(async (s) => {
      if (ACP?.active?.has(s.sessionId)) { s.held = false; s.running = !!chatBusyBySession.get(s.sessionId); }
      else { const dir = sessionDirFor(s.cwd, s.sessionId); s.held = dir ? await flockHeld(dir + "/session.lock") : false; }
      s.turn = await sessionTurnStatus(s.sessionId, s.cwd);
      return s;
    }));
    out.push(...batch);
  }
  return out;
}
async function mergedSessions() {
  const sessions = await ACP.list();
  const known = new Set(sessions.map((s) => s.sessionId));
  for (const [chatId, ctx] of Object.entries(STATE.chats)) { if (ctx.sessionId && !known.has(ctx.sessionId)) sessions.unshift({ sessionId: ctx.sessionId, cwd: ctx.cwd ?? CONFIG.defaultCwd }); }
  try {
    const wsDoc = JSON.parse(readFileSync(WORKSPACE_JSON, "utf8"));
    const archived = new Set((wsDoc.global?.archivedSessionIds ?? []).map((id) => id.replace(/^session-/, "")));
    for (const w of Object.values(wsDoc.tables?.workspaces ?? { })) {
      for (const id of w.sessionIds ?? []) {
        const bare = id.replace(/^session-/, "");
        const hit = sessions.find((s) => s.sessionId === id || s.sessionId.replace(/^session-/, "") === bare);
        if (hit) { hit.archived = archived.has(bare); continue; }
        sessions.push({ sessionId: id, cwd: w.path, registeredOnly: true, archived: archived.has(bare) });
      }
    }
  } catch (e) { log("workspace union failed", e.message); }
  return sessions;
}

// ---------------- write-lock / session dir ----------------
function flockHeld(lockPath) {
  return new Promise((res) => {
    const p = spawn("flock", ["-n", lockPath, "-c", "true"]);
    p.on("error", () => res(false));
    p.on("exit", (code) => res(code !== 0));
  });
}
let sessionContainerCache = null;
function sessionContainers() {
  if (!sessionContainerCache) { try { sessionContainerCache = readdirSync(DSH_SESSIONS_ROOT).filter((n) => n.startsWith("--")); } catch { sessionContainerCache = []; } }
  return sessionContainerCache;
}
function sessionDirFor(cwd, sessionId) {
  for (const idc of [sessionId, sessionId.replace(/^session-/, "")]) {
    for (const name of sessionContainers()) {
      const dir = `${DSH_SESSIONS_ROOT}/${name}/${idc}`;
      if (existsSync(dir + "/session.v3.jsonl.zstd") || existsSync(dir + "/session.lock")) return dir;
    }
  }
  return null;
}
const registeredInWeb = new Set();
async function registerSessionInGui(sessionId, cwd) {
  if (registeredInWeb.has(sessionId)) return;
  registeredInWeb.add(sessionId);
  if (registeredInWeb.size > 500) registeredInWeb.delete(registeredInWeb.values().next().value);
  // 先让 web 进程通过服务 API 挂进内存注册表（重启后侧边栏立刻可见）
  try {
    const r = await webControl("register", { sessionId, cwd });
    if (r?.ok) { log("registered in web sidebar", shortId(sessionId)); return; }
    if (r && r.error) log("web register skipped:", String(r.error).slice(0, 140));
  } catch (e) { log("web register error", e?.message); }
  try {
    const d = JSON.parse(readFileSync(WORKSPACE_JSON, "utf8"));
    const tables = (d.tables ??= {}); const ws = (tables.workspaces ??= {});
    let targetId = null;
    for (const [id, w] of Object.entries(ws)) if (w?.path === cwd) { targetId = id; break; }
    const now = new Date().toISOString();
    if (!targetId) { targetId = randomUUID(); ws[targetId] = { path: cwd, title: basename(cwd) || cwd, sessionIds: [], createdAt: now, updatedAt: now }; (d.global ??= {}).workspaceIds = [targetId, ...(d.global.workspaceIds ?? []).filter((x) => x !== targetId)]; }
    const w = ws[targetId];
    if ((w.sessionIds ?? []).includes(sessionId)) return;
    w.sessionIds = [sessionId, ...w.sessionIds]; w.updatedAt = now;
    const tmp = WORKSPACE_JSON + ".tmp-bridge";
    writeFileSync(tmp, JSON.stringify(d, null, 2)); renameSync(tmp, WORKSPACE_JSON);
  } catch (e) { log("GUI registration failed", shortId(sessionId), e.message); }
}
function dirExists(p) { try { accessSync(p, constants.R_OK); return true; } catch { return false; } }
function readSessionMeta(sessionId) {
  const bare = sessionId.replace(/^session-/, "");
  for (const key of [sessionId, bare, "session-" + bare]) {
    try {
      const d = JSON.parse(readFileSync(join(DSH_DATA, "storages", "session_projcache", "sessions", `${key}.json`), "utf8"));
      const rec = d?.record ?? { };
      const title = rec?.rows?.title?.val ?? "";
      const createdAt = rec?.identity?.createdAt;
      return { title: String(title).replace(/\s+/g, " ").slice(0, 36), date: createdAt ? new Date(createdAt).toISOString().slice(5, 16).replace("T", " ") : "" };
    } catch { }
  }
  return { title: "", date: "" };
}
function resolveSession(chatId, arg) {
  const ctx = chatCtx(chatId);
  if (/^\d+$/.test(arg)) { const idx = parseInt(arg, 10) - 1; return (idx >= 0 && idx < ctx.lastList.length) ? ctx.lastList[idx] : null; }
  const match = (id) => id && (id.startsWith(arg) || ("session-" + id).startsWith(arg) || id.replace(/^session-/, "").startsWith(arg));
  if (match(ctx.sessionId)) return { sessionId: ctx.sessionId, cwd: ctx.cwd ?? CONFIG.defaultCwd };
  const hit = ctx.lastList.find((l) => match(l.sessionId)); if (hit) return hit;
  const sessions = ACP.ready() ? ACP.list() : Promise.resolve([]);
  return sessions.then((ss) => ss.find((s) => match(s.sessionId)) ?? null);
}

// ---------------- web relay ----------------
let webControlBase = null; let webControlLastProbe = 0;
async function webControl(action, payload = { }) {
  let token = ""; try { token = readFileSync(HERE + "../config/web-control-token", "utf8").trim(); } catch { }
  if (!token) return { ok: false, error: "no control token" };
  const body = JSON.stringify({ action, ...payload });
  const candidates = [];
  if (webControlBase) candidates.push(webControlBase);
  const cfg = CONFIG.webControl?.url ?? "http://127.0.0.1:3090/bridge-control";
  if (!candidates.includes(cfg)) candidates.push(cfg);
  if (Date.now() - webControlLastProbe > 5000) for (let p = 3090; p <= 3099; p++) { const u = `http://127.0.0.1:${p}/bridge-control`; if (!candidates.includes(u)) candidates.push(u); }
  for (const url of candidates) {
    const fast = url !== webControlBase && url !== cfg;
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-bridge-token": token }, body, signal: AbortSignal.timeout(fast ? 800 : 20000) });
      const j = await res.json().catch(() => null);
      if (j && typeof j.ok === "boolean") { if (url !== webControlBase) { webControlBase = url; log("web control endpoint:", url); } webControlLastProbe = 0; return j; }
    } catch { }
  }
  webControlLastProbe = Date.now();
  return { ok: false, error: "bridge-control 不可达" };
}
async function relayPromptTurn(chatId, sid, cwd, sc, startAt) {
  const meta = readSessionMeta(sid); const title = (meta.title || shortId(sid)).slice(0, 30);
  const sb = new StreamBuf(sc);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let st = null;
  for (let i = 0; i < 4; i++) { st = await sessionTurnStatus(sid, cwd); if (st?.prompt) break; await sleep(2500); }
  sb.seed(`🔗 **Web 中继** · ${title}\n\n🗣 ${st?.prompt ?? "…"}`);
  await sb.flush();
  let seen = 0;
  for (;;) {
    st = await sessionTurnStatus(sid, cwd);
    if (!st) { await sleep(2500); continue; }
    if (st.prompt && sb.pushed !== null && !sb.full.includes(st.prompt)) sb.append(`\n\n🗣 ${st.prompt}`);
    for (; seen < (st.steps?.length ?? 0); seen++) {
      const s = st.steps[seen];
      sb.append("\n\n" + (s.startsWith("🔧") ? s : "💬\n" + clip(s, 3000)));
    }
    await sb.flush();
    if (!st.running) {
      const answer = [...(st.steps ?? [])].reverse().find((s) => !s.startsWith("🔧")) ?? "";
      const elapsed = Math.round((Date.now() - startAt) / 1000);
      sb.append(`${st.endReason === "cancelled" ? "\n\n⛔ **已中断**" : ""}\n\n---\n⏱ ${elapsed}s · 会话 \`${shortId(sid)}\` · \`${cwd}\` · 🔗Web中继`);
      await sb.flush();
      return { answer, stopped: st.endReason === "cancelled", full: sb.full };
    }
    await sleep(2500);
  }
}

// ---------------- spectator / dashboard / takeover ----------------
const watchRegistry = new Map();
const pendingTakeovers = new Map();
const dashboardRunning = new Map();
async function stopSpectator(chatId, sessionId, tail) {
  const key = `${chatId}:${sessionId}`; const w = watchRegistry.get(key); if (!w) return;
  watchRegistry.delete(key); clearInterval(w.timer);
  try { if (w.sb) { w.sb.append(`\n\n${tail ?? ""}`); await w.sb.flush(); } await w.sc.removeElement("stopbtn"); await w.sc.close("观看结束"); } catch { }
}
async function startSpectator(chatId, sessionId, cwd) {
  const key = `${chatId}:${sessionId}`;
  if (watchRegistry.has(key)) { await sendText(chatId, "已在观看该会话（卡片见上方）。"); return; }
  const meta = readSessionMeta(sessionId); const title = (meta.title || shortId(sessionId)).slice(0, 30);
  try {
    const cardId = await createStreamingCard(`👀 ${title.slice(0, 40)}`, { do: "stopwatch", sessionId });
    await sendCardEntity(chatId, cardId);
    const sc = new StreamCard(cardId);
    const sb = new StreamBuf(sc);
    const w = { sc, sb, timer: null, startedAt: Date.now() };
    watchRegistry.set(key, w);
    let seen = 0; let promptShown = false;
    const tick = async () => {
      try {
        const st = await sessionTurnStatus(sessionId, cwd); if (!st) return;
        if (sb.pushed === null) sb.seed(`👀 **观看** · ${title}\n\n（${st.running ? "任务执行中" : "任务已结束"}）`);
        if (st.prompt && !promptShown) { promptShown = true; sb.append(`\n\n🗣 ${st.prompt}`); }
        for (; seen < (st.steps?.length ?? 0); seen++) {
          const s = st.steps[seen];
          sb.append("\n\n" + (s.startsWith("🔧") ? s : "💬\n" + clip(s, 3000)));
        }
        await sb.flush();
        if (!st.running) await stopSpectator(chatId, sessionId, st.endReason === "cancelled" ? "\n\n⛔ **已中断**" : "\n\n✅ **任务结束**");
      } catch (e) { log("spectator tick error", e.message); }
    };
    w.timer = setInterval(tick, 2500);
    await tick();
    setTimeout(() => stopSpectator(chatId, sessionId, "\n\n⏱ 观看超时自动结束"), CONFIG.watch?.timeoutMs ?? 1800000);
  } catch (e) { await sendText(chatId, `❌ 观看失败：${e?.message ?? e}`); }
}
async function trySwitch(chatId, sessionId, cwd) {
  const ctx = chatCtx(chatId); const prev = ctx.sessionId;
  await ACP.ensureActive(sessionId, cwd);
  ctx.sessionId = sessionId; ctx.cwd = cwd; ctx.relay = false; ctx.intendedSession = null; saveState();
  registerSessionInGui(sessionId, cwd);
  if (prev && prev !== sessionId && ACP.active.has(prev) && !chatBusyBySession.get(prev)) {
    try { await ACP.closeSession(prev); log("auto-released", shortId(prev)); } catch (e) { log("auto-release failed", e.message); }
  }
  await sendMarkdown(chatId, `✅ 已切换到会话 \`${shortId(sessionId)}\`（工作区 \`${cwd}\`）\n\n直接发消息继续对话，历史上下文已恢复。最近对话马上发来（全文）：`);
  await sendFullHistory(chatId, sessionId, 3);
}
async function tryRelaySwitch(chatId, sessionId, cwd) {
  const ctx0 = chatCtx(chatId);
  const probe = await webControl("status");
  if (!probe.ok) { ctx0.relayError = String(probe.error ?? "web 控制端点不可达").slice(0, 160); saveState(); return false; }
  ctx0.relayError = null; saveState();
  const heldIds = new Set((probe.held ?? []).map((h) => h.sessionId));
  const bare = sessionId.replace(/^session-/, "");
  if (!heldIds.has(sessionId) && !heldIds.has(bare) && !heldIds.has("session-" + bare)) return false;
  const ctx = chatCtx(chatId);
  ctx.sessionId = sessionId; ctx.cwd = cwd; ctx.relay = true; ctx.intendedSession = null; saveState();
  log("relay switch", chatId, "->", sessionId);
  await sendMarkdown(chatId, `✅ 已切换到会话 \`${shortId(sessionId)}\`（工作区 \`${cwd}\` · 🔗**Web中继**）\n\n该会话被 Web 持有：你的消息将经 dsh web 进程执行，Web 侧同步可见，无需等锁。最近对话马上发来（全文）：`);
  await sendFullHistory(chatId, sessionId, 3);
  return true;
}
function explainSwitchError(e) {
  const details = [e?.data?.details, e?.message, String(e)].join(" ");
  if (/already owned/.test(details)) return `🔒 该会话正被 **Web GUI 持有写锁**。请归档该会话或重启 dsh web 后再试。`;
  return `❌ 切换失败：${e?.message ?? String(e)}`;
}
async function dashboardTick() {
  if (!ACP.ready()) return;
  const sessions = await mergedSessions();
  const annotated = await annotateSessions(sessions);
  const anyRunning = annotated.some((s) => s.turn?.running);
  for (const chatId of CONFIG.poll?.chats ?? []) {
    const ctx = chatCtx(chatId);
    for (const [key, t] of [...pendingTakeovers]) {
      if (t.chatId !== chatId) continue;
      if (Date.now() - t.addedAt > (CONFIG.takeover?.timeoutMs ?? 300000)) {
        pendingTakeovers.delete(key);
        const why = ctx.relayError ? `（Web 中继不可用：\`${ctx.relayError}\`）` : "";
        await sendText(chatId, `⌛ 等待 \`${shortId(t.sessionId)}\` 的锁超时${why}，已停止自动切换。\n\n**注意：现在没有绑定会话**——下次发消息会再重试切换到它；想直接开始请发 \`/new <路径>\`。`);
        continue;
      }
      const dir = sessionDirFor(t.cwd, t.sessionId);
      const held = dir ? await flockHeld(dir + "/session.lock") : false;
      if (!held) {
        pendingTakeovers.delete(key);
        try { await trySwitch(chatId, t.sessionId, t.cwd); ctx.browserView = { view: "ws", cwd: t.cwd }; await patchCardMessage(ctx.browserMessageId, browserWsCard(t.cwd, (await annotateSessions(await mergedSessions())).filter((s) => s.cwd === t.cwd), t.sessionId, `✅ 锁已释放，已切换到 \`${shortId(t.sessionId)}\``)); }
        catch (e) { await sendText(chatId, explainSwitchError(e)); }
      }
    }
    if (ctx.sessionId && !ctx.busy) {
      const st = await sessionTurnStatus(ctx.sessionId, ctx.cwd ?? CONFIG.defaultCwd);
      const running = st?.running === true;
      ctx.foreignRunning = running;
      if (running && st.startedAt && ctx.lastForeignTurnStart !== st.startedAt) {
        ctx.lastForeignTurnStart = st.startedAt;
        if (!watchRegistry.has(`${chatId}:${ctx.sessionId}`)) {
          await sendText(chatId, "📥 当前会话在 Web 侧开始了新任务，自动直播：");
          startSpectator(chatId, ctx.sessionId, ctx.cwd ?? CONFIG.defaultCwd).catch((e) => log("auto spectator failed", e.message));
        }
      }
      const busyNow = ctx.busy || running;
      if (ctx.panelMessageId && ctx.panelBusyShown !== busyNow) { ctx.panelBusyShown = busyNow; await patchCardMessage(ctx.panelMessageId, panelCard(ctx)).catch(() => { }); }
    }
    if (!ctx.browserMessageId) continue;
    ctx.browserView ??= { view: "home" };
    if (ctx.browserBrokenUntil && Date.now() < ctx.browserBrokenUntil) continue;
    const sig = annotated.map((s) => s.sessionId + (s.turn?.running ? "+" : "")).join(",");
    const sigChanged = sig !== (ctx.browserSig ?? "");
    const wasRunning = dashboardRunning.get(chatId) ?? false;
    if (!anyRunning && !wasRunning && !sigChanged) continue;
    if (sigChanged) ctx.browserSig = sig;
    dashboardRunning.set(chatId, anyRunning);
    let card;
    if (ctx.browserView.view === "ws") card = browserWsCard(ctx.browserView.cwd, annotated.filter((s) => s.cwd === ctx.browserView.cwd), ctx.sessionId, undefined, ctx.browserView.page ?? 0);
    else card = browserHomeCard(annotated, ctx, undefined);
    const ok = await patchCardMessage(ctx.browserMessageId, card);
    ctx.browserPatchFails = ok ? 0 : (ctx.browserPatchFails ?? 0) + 1;
    if (ctx.browserPatchFails > 2) { ctx.browserBrokenUntil = Date.now() + 600000; ctx.browserPatchFails = 0; log("dashboard patch backing off 10min"); }
  }
}

// ---------------- history / export ----------------
async function sendLongMarkdown(chatId, md, title) {
  const size = 7000;
  const chunks = [];
  for (let i = 0; i < md.length; i += size) chunks.push(md.slice(i, i + size));
  for (const [i, chunk] of chunks.entries()) {
    const card = {
      schema: "2.0", config: { update_multi: true, width_mode: "default" },
      ...(title && i === 0 ? { header: { title: { tag: "plain_text", content: title }, template: "blue" } } : {}),
      body: { elements: [{ tag: "markdown", content: chunk + (chunks.length > 1 ? `\n\n*（${i + 1}/${chunks.length}）*` : "") }] },
    };
    const ok = await sendCard(chatId, card); if (!ok) await sendMarkdown(chatId, chunk);
  }
}
async function sendFullHistory(chatId, sessionId, roundCount = 3) {
  try {
    const rounds = extractRounds(await readSessionEvents(sessionId)).slice(-roundCount);
    if (!rounds.length) { await sendText(chatId, "（该会话还没有对话记录）"); return; }
    const parts = [];
    rounds.forEach((r, i) => {
      const p = [`**第 ${i + 1} 轮 · ${fmtTime(r.time)}**`];
      if (r.user) p.push(`🗣 你：\n${r.user}`);
      for (const a of r.assistant.slice(0, 2)) p.push(`🤖 助手：\n${a}`);
      if (r.tools.length) p.push(`🔧 ${[...new Set(r.tools)].join("、")} ×${r.tools.length}（已折叠）`);
      parts.push(p.join("\n\n"));
    });
    await sendLongMarkdown(chatId, parts.join("\n\n---\n\n"), "📋 最近对话（全文）");
  } catch (e) { log("sendFullHistory failed", shortId(sessionId), e.message); }
}
async function peekHistory(chatId, sessionId, cwd, roundCount = 5) {
  const meta = readSessionMeta(sessionId);
  const rounds = extractRounds(await readSessionEvents(sessionId)).slice(-roundCount);
  const head = `📋 **${(meta.title || shortId(sessionId)).slice(0, 30)}** · \`${cwd}\` 的最近 ${rounds.length} 轮对话${ACP?.active?.has(sessionId) ? "" : "（🔒Web占用，只读）"}\n\n`;
  if (!rounds.length) { await sendMarkdown(chatId, head + "（该会话还没有对话记录）"); return; }
  const body = rounds.map((r, i) => {
    const parts = [`**${i + 1}** · ${fmtTime(r.time)}`];
    if (r.user) parts.push(`🗣 你：\n${r.user}`);
    for (const a of r.assistant.slice(0, 2)) parts.push(`🤖 助手：\n${a}`);
    if (r.tools.length) parts.push(`🔧 ${[...new Set(r.tools)].join("、")} ×${r.tools.length}`);
    return parts.join("\n\n");
  }).join("\n\n---\n\n");
  await sendLongMarkdown(chatId, body + `\n\n> 更早记录可发 \`/history <序号> 20\` 或点「导出」生成飞书文档`, `📋 ${meta.title || shortId(sessionId)}`);
}
function sessionDocMarkdown(sessionId, cwd, rounds) {
  const meta = readSessionMeta(sessionId);
  return [
    `# 会话记录 · ${meta.title || shortId(sessionId)}`, "", `- **工作区**：\`${cwd}\``, `- **会话 ID**：\`${sessionId}\``, `- **导出时间**：${fmtTime(Date.now())}`, `- **对话轮数**：${rounds.length}`, "", "---", "",
    ...rounds.map((r, i) => {
      const parts = [`## 第 ${i + 1} 轮 · ${fmtTime(r.time)}`, ""];
      if (r.user) parts.push(`**你**`, "", r.user, "");
      for (const a of r.assistant) parts.push(`**助手**`, "", a, "");
      if (r.tools.length) parts.push(`> 🔧 工具调用：${[...new Set(r.tools)].join("、")} ×${r.tools.length}`, "");
      return parts.join("\n");
    }),
  ].join("\n---\n\n");
}
async function exportSessionDoc(chatId, sessionId, cwd, opts = { }) {
  if (!opts.quiet) await sendText(chatId, "⏳ 正在读取会话并生成文档…");
  try {
    const rounds = extractRounds(await readSessionEvents(sessionId));
    if (!rounds.length) { await sendText(chatId, "该会话没有对话记录，无需导出。"); return; }
    let folderToken = STATE.exportFolderToken;
    if (!folderToken) {
      const sr = await runLark(["drive", "+search", "--query", "dsh-会话记录", "--doc-types", "folder", "--only-title", "--as", "user"]);
      const results = sr.ok ? (sr.json?.data?.results ?? []) : [];
      const stripHl = (s) => String(s ?? "").replace(/<\/?h>/g, "").trim();
      const hit = results.find((r) => stripHl(r?.title_highlighted) === "dsh-会话记录");
      folderToken = hit?.result_meta?.token ?? null;
      if (!folderToken) { const cr = await runLark(["drive", "+create-folder", "--name", "dsh-会话记录", "--as", "user"]); if (!cr.ok) throw new Error("create folder: " + (cr.stderr || "").slice(-200)); folderToken = cr.json?.data?.token ?? cr.json?.data?.folder?.token ?? null; }
      STATE.exportFolderToken = folderToken; saveState();
    }
    mkdirSync("/tmp/dsh-bridge-exports", { recursive: true });
    const meta = readSessionMeta(sessionId);
    const fname = `/tmp/dsh-bridge-exports/session-${shortId(sessionId)}.md`;
    writeFileSync(fname, sessionDocMarkdown(sessionId, cwd, rounds));
    const ir = await runLark(["drive", "+import", "--file", fname, "--folder-token", folderToken, "--type", "docx", "--name", `会话记录 · ${meta.title || shortId(sessionId)}`, "--as", "user"]);
    if (!ir.ok) throw new Error("import: " + (ir.stderr || ir.raw || "").slice(-300));
    const d = ir.json?.data ?? { };
    const token = d.token ?? d.doc_token ?? null;
    const url = d.url ?? (token ? `https://feishu.cn/docx/${token}` : null);
    await sendMarkdown(chatId, `✅ 已导出会话记录（${rounds.length} 轮对话）${url ? `\n\n📄 [${meta.title || shortId(sessionId)}](${url})` : ""}\n\n存放在云空间 \`dsh-会话记录/\` 文件夹。`);
  } catch (e) { await sendText(chatId, `❌ 导出失败：${e?.message ?? e}`); }
}

// ---------------- card builders ----------------
function mkBtn(label, value, opt = { }) {
  return { tag: "button", text: { tag: "plain_text", content: label }, type: opt.type ?? "default", size: opt.size ?? "medium", width: opt.width ?? "fill", ...(opt.disabled ? { disabled: true, disabled_tips: { tag: "plain_text", content: opt.tips ?? "不可用" } } : {}), behaviors: [{ type: "callback", value }] };
}
function panelStatusLine(ctx) {
  const sid = ctx.sessionId ? `\`${shortId(ctx.sessionId)}\`` : "无";
  let model = "";
  try { const co = ctx.sessionId ? ACP.getConfigOptions(ctx.sessionId) : null; const m = (co ?? []).find((o) => o.id === "model"); if (m?.currentValue) { let name = m.currentValue; for (const g of m.options ?? []) for (const o of g.options ?? []) if (o.value === m.currentValue) name = o.name; model = ` · ${name}`; } } catch { }
  const busyLabel = ctx.busy ? "⏳ 执行中" : ctx.foreignRunning ? "🏃 Web侧执行中" : "空闲";
  return `**${busyLabel}** · 会话 ${sid} · \`${ctx.cwd ?? CONFIG.defaultCwd}\`${ctx.relay ? " · 🔗Web中继" : ""}${model}`;
}
function panelCard(ctx, note) {
  const els = [{ tag: "markdown", content: panelStatusLine(ctx) }];
  if (note) els.push({ tag: "markdown", content: note });
  els.push({ tag: "column_set", flex_mode: "bisect", horizontal_spacing: "medium", columns: [
    { tag: "column", width: "weighted", weight: 1, elements: [mkBtn("＋ 新建会话", { do: "newform" }, { type: "primary_filled" })] },
    { tag: "column", width: "weighted", weight: 1, elements: [mkBtn("模型设置", { do: "modelcfg" })] },
    { tag: "column", width: "weighted", weight: 1, elements: [mkBtn("停止任务", { do: "stop" })] },
    { tag: "column", width: "weighted", weight: 1, elements: [mkBtn("刷新", { do: "status" })] },
  ] });
  return { schema: "2.0", config: { update_multi: true, width_mode: "compact" }, header: { title: { tag: "plain_text", content: "dsh 控制台" }, subtitle: { tag: "plain_text", content: "点按钮原地操作 · 发文字即对话" }, template: "blue" }, body: { padding: "12px 12px 16px 12px", elements: els } };
}
function pickerCard(workspaces, err) {
  const options = workspaces.slice(0, 12).map((w) => ({ text: { tag: "plain_text", content: w }, value: w }));
  const els = [{ tag: "markdown", content: "工作区 = 新会话的工作目录，会话内相对路径以它为基准。可下拉选择最近的，或直接输入绝对路径。" }];
  if (err) els.push({ tag: "markdown", content: `❌ ${err}` });
  els.push({ tag: "form", name: "wsform", elements: [
    { tag: "select_static", name: "ws", placeholder: { tag: "plain_text", content: "选择最近的工作区" }, options },
    { tag: "input", name: "path", placeholder: { tag: "plain_text", content: "或输入自定义绝对路径（优先于左侧选择）" }, input_type: "text", max_length: 500 },
    { tag: "button", name: "submit", text: { tag: "plain_text", content: "创建会话" }, type: "primary", form_action_type: "submit", width: "fill" },
  ] });
  els.push({ tag: "button", text: { tag: "plain_text", content: "← 取消" }, type: "text", size: "small", behaviors: [{ type: "callback", value: { do: "home" } }] });
  return { schema: "2.0", config: { update_multi: true, width_mode: "default" }, header: { title: { tag: "plain_text", content: "新建 dsh 会话" }, template: "blue" }, body: { padding: "12px 12px 16px 12px", elements: els } };
}
function pickerDoneCard(cwd, sessionId) {
  return { schema: "2.0", config: { update_multi: true }, header: { title: { tag: "plain_text", content: "✅ 会话已创建" }, template: "green" }, body: { elements: [
    { tag: "markdown", content: `已在 **${cwd}** 创建会话 \`${shortId(sessionId)}\`\n\n直接发消息即可开始干活。` },
    { tag: "button", text: { tag: "plain_text", content: "← 返回控制台" }, type: "text", size: "small", width: "fill", behaviors: [{ type: "callback", value: { do: "home" } }] },
  ] } };
}
function modelSettingsCard(configOptions, sessionId, done) {
  const model = (configOptions ?? []).find((o) => o.id === "model");
  const effort = (configOptions ?? []).find((o) => o.id === "reasoning_effort");
  const currentModel = model?.currentValue ?? ""; let currentModelName = currentModel; const flat = [];
  for (const g of model?.options ?? []) for (const o of g.options ?? []) { flat.push({ group: g.group ?? g.name, name: o.name, value: o.value }); if (o.value === currentModel) currentModelName = `${g.group ?? g.name} · ${o.name}`; }
  const effName = (v) => v === "" ? "跟随提供商默认" : v;
  const els = [
    { tag: "markdown", content: `当前模型：**${currentModelName}**\n思考深度：**${effName(effort?.currentValue ?? "")}**\n\n修改后从下一个任务开始生效。` },
    { tag: "form", name: "cfgform", elements: [
      { tag: "select_static", name: "model", placeholder: { tag: "plain_text", content: "选择模型" }, initial_option: currentModel || undefined, options: flat.map((o) => ({ text: { tag: "plain_text", content: `${o.group} · ${o.name}` }, value: o.value })) },
      { tag: "select_static", name: "effort", placeholder: { tag: "plain_text", content: "选择思考深度" }, initial_option: effort?.currentValue ?? "", options: (effort?.options ?? [{ value: "", name: "Provider default" }, { value: "low" }, { value: "high" }, { value: "max" }]).map((o) => ({ text: { tag: "plain_text", content: effName(o.value ?? o) }, value: o.value ?? o })) },
      { tag: "button", name: "cfg_submit", text: { tag: "plain_text", content: done ? "再次修改" : "应用设置" }, type: "primary", form_action_type: "submit", width: "fill" },
    ] },
    { tag: "button", text: { tag: "plain_text", content: "← 返回控制台" }, type: "text", size: "small", behaviors: [{ type: "callback", value: { do: "home" } }] },
  ];
  return { schema: "2.0", config: { update_multi: true }, header: { title: { tag: "plain_text", content: done ? "✅ 设置已应用" : "模型与思考深度" }, subtitle: { tag: "plain_text", content: `会话 ${shortId(sessionId)}` }, template: done ? "green" : "blue" }, body: { padding: "12px 12px 20px 12px", elements: els } };
}
function fmtSessionLine(i, s, currentId) {
  const meta = readSessionMeta(s.sessionId);
  const cur = s.sessionId === currentId ? " ✅当前" : "";
  const held = s.held && s.sessionId !== currentId ? " · 🔒Web占用" : "";
  const arch = s.archived ? " · 📦已归档" : "";
  let run = "";
  if (s.turn?.running) { const el = s.turn.startedAt ? Math.round((Date.now() - s.turn.startedAt) / 1000) : "?"; run = ` · 🏃${el}s`; }
  const name = meta.title ? `**${meta.title}**` : `\`${shortId(s.sessionId)}\``;
  return `${i + 1}. ${name}${meta.date ? ` · ${meta.date}` : ""}${run}${held}${arch}${cur}`;
}
function browserHomeCard(sessions, ctx, note) {
  const groups = new Map();
  for (const s of sessions) { if (!groups.has(s.cwd)) groups.set(s.cwd, []); groups.get(s.cwd).push(s); }
  const wsList = [...groups.entries()].slice(0, 8);
  const els = [];
  if (note) els.push({ tag: "markdown", content: note });
  els.push({ tag: "markdown", content: `当前：\`${shortId(ctx.sessionId ?? "")}\` @ \`${ctx.cwd ?? "无"}\`\n\n${wsList.map(([cwd, arr], i) => { const rn = arr.filter((s) => s.turn?.running).length; return `${i + 1}. **${basename(cwd) || cwd}** · ${arr.length} 个会话${rn ? ` · 🏃${rn}` : ""}`; }).join("\n") || "（暂无会话）"}` });
  for (const [cwd] of wsList) els.push(mkBtn(`打开 ${basename(cwd) || cwd}`, { do: "wsopen", cwd }, { size: "small", width: "default" }));
  return { schema: "2.0", config: { update_multi: true }, header: { title: { tag: "plain_text", content: "dsh 会话" }, subtitle: { tag: "plain_text", content: "按工作区浏览与切换" }, template: "blue" }, body: { padding: "12px 12px 16px 12px", elements: els } };
}
function browserWsCard(cwd, sessions, currentId, note, page = 0) {
  const pageSize = 10;
  const pages = Math.max(1, Math.ceil(sessions.length / pageSize));
  const p = Math.min(Math.max(page, 0), pages - 1);
  const shown = sessions.slice(p * pageSize, p * pageSize + pageSize);
  const els = [];
  if (note) els.push({ tag: "markdown", content: note });
  els.push({ tag: "markdown", content: `**${basename(cwd) || cwd}** · \`${cwd}\`${sessions.length > pageSize ? `（第 ${p + 1}/${pages} 页 · 共 ${sessions.length} 个）` : ""}\n\n${shown.map((s, i) => fmtSessionLine(p * pageSize + i, s, currentId)).join("\n") || "（暂无会话）"}` });
  for (const [i, s] of shown.entries()) {
    const isCur = s.sessionId === currentId;
    const cols = [
      { tag: "column", width: "weighted", weight: 1, elements: [mkBtn(isCur ? `${p * pageSize + i + 1}· 当前` : `切换 ${p * pageSize + i + 1}`, { do: "use", sessionId: s.sessionId, cwd: s.cwd, from: "ws" }, { size: "small", disabled: isCur, tips: "已是当前会话" })] },
      { tag: "column", width: "weighted", weight: 1, elements: [mkBtn("查看", { do: "peek", sessionId: s.sessionId, cwd: s.cwd }, { size: "small" })] },
    ];
    if (s.turn?.running) cols.push({ tag: "column", width: "weighted", weight: 1, elements: [mkBtn("👀 直播", { do: "watch", sessionId: s.sessionId, cwd: s.cwd }, { type: "primary_text", size: "small" })] });
    cols.push({ tag: "column", width: "weighted", weight: 1, elements: [mkBtn("导出", { do: "export", sessionId: s.sessionId, cwd: s.cwd }, { type: "text", size: "small" })] });
    els.push({ tag: "column_set", flex_mode: "trisect", horizontal_spacing: "small", columns: cols });
  }
  if (pages > 1) els.push({ tag: "column_set", flex_mode: "bisect", columns: [
    { tag: "column", width: "weighted", weight: 1, elements: [mkBtn(p > 0 ? "← 上一页" : "·", { do: "wspage", delta: -1, cwd }, { size: "small", disabled: p === 0 })] },
    { tag: "column", width: "weighted", weight: 1, elements: [mkBtn(p < pages - 1 ? "下一页 →" : "·", { do: "wspage", delta: 1, cwd }, { size: "small", disabled: p >= pages - 1 })] },
  ] });
  els.push({ tag: "column_set", flex_mode: "bisect", columns: [
    { tag: "column", width: "weighted", weight: 1, elements: [mkBtn("＋ 在此新建", { do: "newin", cwd }, { type: "primary_filled" })] },
    { tag: "column", width: "weighted", weight: 1, elements: [mkBtn("← 工作区列表", { do: "back" }, { type: "text" })] },
  ] });
  return { schema: "2.0", config: { update_multi: true }, header: { title: { tag: "plain_text", content: `dsh 会话 · ${basename(cwd) || cwd}` }, subtitle: { tag: "plain_text", content: cwd }, template: "blue" }, body: { padding: "12px 12px 16px 12px", elements: els } };
}

// ---------------- chat context ----------------
function chatCtx(chatId) {
  if (!STATE.chats[chatId]) STATE.chats[chatId] = { sessionId: null, cwd: null, lastList: [], busy: false };
  return STATE.chats[chatId];
}
async function recentWorkspaces() {
  const ws = []; const seen = new Set();
  const push = (w) => { if (w && !seen.has(w)) { seen.add(w); ws.push(w); } };
  push(CONFIG.defaultCwd);
  try { for (const s of await ACP.list()) push(s.cwd); } catch { }
  return ws.slice(0, CONFIG.recentWorkspaceCount);
}
async function sendFreshCards(chatId) {
  const ctx = chatCtx(chatId);
  const pmid = await sendCard(chatId, panelCard(ctx));
  if (pmid) ctx.panelMessageId = pmid;
  if (ACP.ready()) { const bmid = await sendCard(chatId, browserHomeCard(await mergedSessions(), ctx)); if (bmid) { ctx.browserMessageId = bmid; ctx.browserView = { view: "home" }; } }
  saveState();
}

// ---------------- image / file handling ----------------
// 事件流与轮询兜底可能重复投递同一张图/同一个文件，按 message_id 去重
const handledMedia = new Set();
function seenMedia(id) {
  if (!id) return false;
  if (handledMedia.has(id)) return true;
  handledMedia.add(id);
  if (handledMedia.size > 300) handledMedia.delete(handledMedia.values().next().value);
  return false;
}
function sniffImage(buf) {
  if (buf.length > 3 && buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf.length > 12 && buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP") return "image/webp";
  if (buf.length > 3 && buf.slice(0, 3).toString() === "GIF") return "image/gif";
  return "image/png";
}
async function handleImageMessage(chatId, ev) {
  if (seenMedia(ev.message_id)) { log("image dup ignored", ev.message_id); return; }
  const ctx = chatCtx(chatId);
  let imageKey = "";
  try { imageKey = JSON.parse(ev.content ?? "{}").image_key ?? ""; } catch { }
  if (!imageKey) {
    const m = String(ev.content ?? "").match(/\[Image:\s*(img_[\w-]+)\]/) ?? String(ev.content ?? "").match(/key="(img_[^"]+)"/) ?? String(ev.content ?? "").match(/(img_v[\w-]+)/);
    if (m) imageKey = m[1];
  }
  if (!imageKey) { log("image unparseable:", String(ev.content ?? "").slice(0, 200)); await sendText(chatId, "❌ 无法解析图片消息。"); return; }
  const base = `/tmp/dsh-bridge-img-${(ev.message_id ?? "").replace(/^om_/, "")}`;
  const r = await runLark(["im", "+messages-resources-download", "--as", "bot", "--file-key", imageKey, "--message-id", ev.message_id, "--type", "image", "--output", base]);
  if (!r.ok) { await sendText(chatId, "❌ 图片下载失败：" + ((r.stderr || r.raw || "").slice(-120))); return; }
  try {
    let path = null;
    for (const cand of [base, `${base}.png`, `${base}.jpg`, `${base}.jpeg`, `${base}.webp`, `${base}.gif`]) { if (existsSync(cand)) { path = cand; break; } }
    if (!path) { for (const n of readdirSync("/tmp")) if (n.startsWith(base.split("/").pop())) { path = `/tmp/${n}`; break; } }
    if (!path) throw new Error("下载文件未找到");
    const buf = readFileSync(path);
    ctx.pendingImage = { data: buf.toString("base64"), mediaType: sniffImage(buf), at: Date.now() };
    log("image received", ev.message_id, buf.length, "bytes");
    log("image ack sending", chatId);
    const ackMid = await sendText(chatId, `🖼 图片已接收（${buf.length < 1024 ? `${buf.length}B` : `${Math.round(buf.length / 1024)}KB`}）。直接发文字说明，我会把图片连同文字一起发给当前会话——5 分钟内有效。若当前模型不支持图片输入，先发 /model 切到支持视觉的模型。`);
    log("image ack sent", ackMid);
  } catch (e) { log("image handle error", e?.stack ?? e?.message ?? String(e)); await sendText(chatId, `❌ 图片处理失败：${e.message}`); }
}
async function handleFileMessage(chatId, ev) {
  if (seenMedia(ev.message_id)) { log("file dup ignored", ev.message_id); return; }
  const ctx = chatCtx(chatId);
  let fileKey = "", fileName = "";
  try { const c = JSON.parse(ev.content ?? "{}"); fileKey = c.file_key ?? ""; fileName = c.file_name ?? ""; } catch { }
  if (!fileKey) {
    const raw = String(ev.content ?? "");
    const m = raw.match(/key="([^"]+)"/) ?? raw.match(/(file_v[\w-]+)/);
    if (m) { fileKey = m[1]; fileName = raw.match(/name="([^"]+)"/)?.[1] ?? ""; }
  }
  if (!fileKey) { log("file unparseable:", String(ev.content ?? "").slice(0, 200)); await sendText(chatId, "❌ 无法解析文件消息。"); return; }
  if (!fileName) fileName = `file_${Date.now()}`;
  fileName = fileName.replace(/[^a-zA-Z0-9._\-\u4e00-\u9fff]/g, "_").slice(0, 100);
  mkdirSync("/tmp/dsh-bridge-files", { recursive: true });
  const out = `/tmp/dsh-bridge-files/${fileName}`;
  const r = await runLark(["im", "+messages-resources-download", "--as", "bot", "--file-key", fileKey, "--message-id", ev.message_id, "--type", "file", "--output", out]);
  if (!r.ok) { await sendText(chatId, "❌ 文件下载失败：" + ((r.stderr || r.raw || "").slice(-120))); return; }
  try {
    let path = out;
    if (!existsSync(path)) { const stem = fileName.split(".")[0]; for (const n of readdirSync("/tmp/dsh-bridge-files")) { if (n.startsWith(stem)) { path = `/tmp/dsh-bridge-files/${n}`; fileName = n; break; } } }
    if (!existsSync(path)) throw new Error("下载文件未找到");
    const stat = statSync(path);
    ctx.pendingFile ??= []; ctx.pendingFile.push({ name: fileName, path, at: Date.now() });
    log("file received", fileName, stat.size, "bytes");
    await sendText(chatId, `📎 已收到文件 **${fileName}**（${Math.round(stat.size / 1024)}KB），已保存到 \`${path}\`\n\n直接发文字说明要怎么处理，我会把文件路径一起传给会话。5 分钟内有效。`);
  } catch (e) { await sendText(chatId, `❌ 文件处理失败：${e.message}`); }
}
const imageUnsupported = (msg) => /does not support image|MODEL_DOES_NOT_SUPPORT_IMAGES|image input|attachment-invalid|not accepted by this deployment|不支持图片/i.test(String(msg));
// 当前会话的模型展示名（不写死任何具体模型 / 网关名）
function currentModelLabel(sessionId) {
  try {
    const model = (ACP.getConfigOptions(sessionId) ?? []).find((o) => o.id === "model");
    const val = model?.currentValue;
    if (!val) return "当前模型";
    for (const g of model?.options ?? []) for (const o of g.options ?? []) if (o.value === val) return `当前模型（${g.group ?? g.name} · ${o.name}）`;
    return `当前模型（${val}）`;
  } catch { return "当前模型"; }
}

// ---------------- runPrompt ----------------
async function runPrompt(chatId, text) {
  const ctx = chatCtx(chatId);
  if (!ACP.ready()) { await sendMarkdown(chatId, "❌ dsh ACP 服务未就绪（正在重连），请稍后再试。"); return; }
  if (!ctx.sessionId) {
    const want = ctx.intendedSession;
    if (want) {
      // 上次切换被 Web 锁挡住：先自动重试一次，仍被占用就明确告知，绝不静默新建会话
      const dir = sessionDirFor(want.cwd, want.sessionId);
      const held = dir ? await flockHeld(dir + "/session.lock") : false;
      if (!held) {
        try { await trySwitch(chatId, want.sessionId, want.cwd); }
        catch (e) { await sendText(chatId, explainSwitchError(e)); return; }
      } else if (!(await tryRelaySwitch(chatId, want.sessionId, want.cwd))) {
        const why = ctx.relayError ? `\n\nWeb 中继不可用：\`${ctx.relayError}\`` : "";
        await sendText(chatId, `🔒 上次要切换的会话 \`${shortId(want.sessionId)}\` 仍被 Web 持有，这条消息**没有发送**（避免误写进新会话）。${why}\n\n· 发 \`/use ${shortId(want.sessionId)}\` 重试\n· 发 \`/new <路径>\` 新建会话\n· 在 Web 里归档该会话或重启 dsh web 即可释放锁`);
        return;
      }
    } else {
      const cwd = ctx.cwd ?? CONFIG.defaultCwd;
      try {
        const s = await ACP.newSession(cwd);
        ctx.sessionId = s.sessionId; ctx.cwd = cwd; ctx.relay = false; ctx.intendedSession = null; saveState();
        registerSessionInGui(s.sessionId, cwd);
        await sendText(chatId, `ℹ️ 当前没有绑定会话，已在 \`${cwd}\` 新建 \`${shortId(s.sessionId)}\`。发 \`/new <路径>\` 可指定工作区，\`/use\` 可切换已有会话。`);
      }
      catch (e) { await sendMarkdown(chatId, `❌ 自动创建会话失败：${e?.message ?? e}`); return; }
    }
  }
  if (ctx.busy) { await sendMarkdown(chatId, "⏳ 当前会话正在执行任务，请等它完成或发 `/stop` 中断。"); return; }
  const sid = ctx.sessionId; const startAt = Date.now();
  const img = (ctx.pendingImage && Date.now() - ctx.pendingImage.at < 300000) ? ctx.pendingImage : null;
  ctx.pendingImage = null;
  const files = (ctx.pendingFile ?? []).filter((f) => Date.now() - f.at < 300000);
  ctx.pendingFile = null;

  // ===== 写锁检查：被其它进程持有就直接转中继，中继不可用则明确拒绝（绝不静默卡住/新建） =====
  if (!ctx.relay && !ACP.active.has(sid)) {
    const dir = sessionDirFor(ctx.cwd ?? CONFIG.defaultCwd, sid);
    if (dir && await flockHeld(dir + "/session.lock")) {
      const probe = await webControl("status");
      if (probe.ok) { ctx.relay = true; log("lock held -> relay", shortId(sid)); saveState(); }
      else {
        ctx.relayError = String(probe.error ?? "web 控制端点不可达").slice(0, 160); saveState();
        await sendText(chatId, `🔒 会话 \`${shortId(sid)}\` 正被 Web 持有写锁，而 Web 中继不可用（\`${ctx.relayError}\`），这条消息**没有发送**。\n\n· 在 Web 里归档该会话或重启 dsh web 释放锁后重发\n· 或发 \`/new <路径>\` 新建会话`);
        return;
      }
    }
  }

  // ===== Web 中继模式 =====
  if (ctx.relay && ACP.ready() && ACP.active.has(sid)) { ctx.relay = false; saveState(); }
  if (ctx.relay) {
    const dir0 = sessionDirFor(ctx.cwd ?? CONFIG.defaultCwd, sid);
    const held0 = dir0 ? await flockHeld(dir0 + "/session.lock") : false;
    if (!held0 && ACP.ready()) { try { await ACP.ensureActive(sid, ctx.cwd ?? CONFIG.defaultCwd); ctx.relay = false; saveState(); } catch { } }
  }
  if (ctx.relay) {
    const probe = await webControl("status");
    if (!probe.ok) { await sendMarkdown(chatId, "❌ Web 中继不可用（web 未启动或未载控制插件）。该会话仍被 Web 持有；可等待锁释放或重启 dsh web。"); return; }
    const st0 = await sessionTurnStatus(sid, ctx.cwd ?? CONFIG.defaultCwd);
    if (st0?.running) { await sendMarkdown(chatId, "⏳ 该会话在 Web 侧正在执行任务，等它完成或发 `/stop` 中断。"); return; }
    ctx.busy = true; chatBusyBySession.set(sid, true);
    let sc = null;
    try { const cardId = await createStreamingCard(text.slice(0, 60).replace(/\n/g, " ")); await sendCardEntity(chatId, cardId); sc = new StreamCard(cardId); }
    catch (e) { log("relay streaming card unavailable:", e.message); }
    let relayText = text;
    if (files.length) relayText = `（用户上传了文件：${files.map((f) => `${f.name} 在 ${f.path}`).join("、")}）\n\n${text}`;
    const sendPayload = { sessionId: sid, text: relayText };
    if (img) {
      if ((probe.version ?? 0) >= 3) sendPayload.image = { mediaType: img.mediaType, data: img.data };
      else await sendText(chatId, "⚠️ 中继模式图片支持需要 web 侧插件为 v3（重启 dsh web 后生效），本次仅发送文字。");
    }
    const r = await webControl("send", sendPayload);
    const errStr = String(r.error ?? "") + " " + JSON.stringify(r);
    log("relay send result:", r.ok ? "ok" : errStr.slice(0, 200));
    if (!r.ok && img && imageUnsupported(errStr)) {
      ctx.pendingImage = img;
      await sendText(chatId, `🖼 **${currentModelLabel(sid)}不支持图片输入。**\n\n1. 发 \`/model\` 切到支持图片的模型\n2. 直接再发一条文字（图片已保留，不用重新传）`);
      ctx.busy = false; chatBusyBySession.set(sid, false); return;
    }
    if (!r.ok) {
      if (sc) { await sc.removeElement("stopbtn"); await sc.push(`❌ 中继发送失败：${r.error}`); await sc.close(); }
      else await sendText(chatId, `❌ 中继发送失败：${r.error}`);
      ctx.busy = false; chatBusyBySession.set(sid, false); return;
    }
    try {
      const { answer, stopped, full } = sc ? await relayPromptTurn(chatId, sid, ctx.cwd ?? CONFIG.defaultCwd, sc, startAt) : await relayPromptTurn(chatId, sid, ctx.cwd ?? CONFIG.defaultCwd, { closed: true, push: async () => { } }, startAt);
      if (sc) {
        const maxCard = CONFIG.stream?.maxCardChars ?? 20000;
        if (full && full.length > maxCard) for (let i = maxCard; i < full.length; i += CONFIG.maxMessageChars) await sendMarkdown(chatId, full.slice(i, i + CONFIG.maxMessageChars));
        if (answer.length > 3000) await sendLongMarkdown(chatId, answer, "📄 完整回复");
        await sc.removeElement("stopbtn"); await sc.close(oneLine(answer, 50) || "已完成");
      } else {
        await sendLongMarkdown(chatId, (stopped ? "⛔ **已中断**\n\n" : "") + (answer || "（无文本回复）") + `\n\n---\n⏱ ${Math.round((Date.now() - startAt) / 1000)}s · 🔗Web中继`, "💬 回复");
      }
    } finally { ctx.busy = false; chatBusyBySession.set(sid, false); ctx.lastTurnEndedAt = Date.now(); }
    return;
  }

  // ===== 原生模式 =====
  ctx.busy = true; chatBusyBySession.set(sid, true);
  let sc = null;
  try { const cardId = await createStreamingCard(text.slice(0, 60).replace(/\n/g, " ")); await sendCardEntity(chatId, cardId); sc = new StreamCard(cardId); }
  catch (e) { log("streaming card unavailable:", e.message); }
  const chunks = []; const sb = sc ? new StreamBuf(sc) : null;
  if (sb) sb.seed("💭 收到指令，正在处理…");
  let answerStarted = false;
  const offUpd = ACP.onSessionUpdates(sid, (u) => {
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content?.type === "text") { chunks.push(u.content.text); if (!answerStarted) { answerStarted = true; sb?.append("\n\n💬 **回复**\n\n"); } sb?.append(u.content.text); }
        break;
      case "tool_call": sb?.append(`\n\n🔧 ${u.title ?? u.name ?? "工具调用"}`); break;
    }
  });
  let streamTimer = null;
  if (sb) streamTimer = setInterval(() => { sb.flush().catch(() => { }); }, CONFIG.stream?.intervalMs ?? 2000);
  let statusMsgId = null; let fallbackTimer = null;
  if (!sc) {
    const lastAct = "💭 思考中…";
    fallbackTimer = setTimeout(function loop() {
      const md = `⏳ **任务进行中**\n\n${lastAct}`;
      if (statusMsgId == null) sendMarkdown(chatId, md).then((id) => { statusMsgId = id; });
      else editMarkdown(statusMsgId, md);
      fallbackTimer = setTimeout(loop, CONFIG.statusIntervalMs);
    }, CONFIG.firstStatusDelayMs);
  }
  const finalize = async (answer, stopReason, errMsg) => {
    const elapsed = Math.round((Date.now() - startAt) / 1000);
    const tail = (stopReason === "cancelled" ? "\n\n⛔ **已中断**" : stopReason === "error" ? `\n\n❌ 执行出错：${errMsg ?? ""}` : stopReason && stopReason !== "end_turn" ? `\n\n⚠️ 结束原因：${stopReason}` : "") + `\n\n---\n⏱ ${elapsed}s · 会话 \`${shortId(sid)}\` · \`${ctx.cwd}\``;
    const maxCard = CONFIG.stream?.maxCardChars ?? 20000;
    if (sc && sb) {
      clearInterval(streamTimer);
      if (!answer.trim()) sb.append("\n\n（无文本回复）");
      sb.append(tail); await sb.flush();
      if (sb.truncated && answer) await sendLongMarkdown(chatId, answer, "📄 完整回复");
      await sc.removeElement("stopbtn"); await sc.close(oneLine(answer, 50) || "已完成");
      return;
    }
    if (fallbackTimer) clearTimeout(fallbackTimer);
    const head = stopReason === "cancelled" ? "⛔ **已中断**\n\n" : stopReason === "error" ? `❌ 执行出错：${errMsg ?? ""}\n\n` : stopReason && stopReason !== "end_turn" ? `⚠️ 结束原因：${stopReason}\n\n` : "";
    const md = head + (answer || "（无文本回复）") + `\n\n---\n⏱ ${elapsed}s · 会话 \`${shortId(sid)}\` · \`${ctx.cwd}\``;
    if (statusMsgId != null) { const ok = await editMarkdown(statusMsgId, "✅ 任务完成，回复见下方卡片。"); if (ok) { await sendLongMarkdown(chatId, md, "💬 回复"); return; } }
    await sendLongMarkdown(chatId, md, "💬 回复");
  };
  try {
    await ACP.ensureActive(sid, ctx.cwd ?? CONFIG.defaultCwd);
    const stop = await ACP.prompt(sid, text, img, files);
    await finalize(chunks.join("").trim(), stop.stopReason);
  } catch (e) {
    const msg = e?.message ?? String(e);
    if (img && (imageUnsupported(msg) || /image/i.test(msg) && /not support|unsupported|invalid/i.test(msg))) {
      ctx.pendingImage = img;
      await sendText(chatId, `🖼 **${currentModelLabel(sid)}不支持图片输入。**\n\n1. 发 \`/model\` 切到支持图片的模型\n2. 直接再发一条文字（图片已保留）`);
    } else {
      await finalize(chunks.join("").trim(), "error", msg);
    }
  } finally {
    if (streamTimer) clearInterval(streamTimer);
    if (fallbackTimer) clearTimeout(fallbackTimer);
    offUpd();
    ctx.busy = false; chatBusyBySession.set(sid, false); ctx.lastTurnEndedAt = Date.now();
  }
}

// ---------------- card actions ----------------
async function handleCardAction(ev) {
  if (!CONFIG.allowUsers.includes(ev.operator_id)) return;
  const chatId = ev.chat_id; const tag = ev.action_tag; const token = ev.token;
  const parseActionValue = () => { try { return JSON.parse(ev.action_value); } catch { return {}; } };
  const parseForm = () => { try { return JSON.parse(ev.form_value); } catch { return {}; } };
  if (tag === "button" && ev.form_value) {
    const form = parseForm();
    const ctx = chatCtx(chatId);
    if (ev.action_name === "cfg_submit") {
      if (!ctx.sessionId) { await sendText(chatId, "❌ 当前没有会话。"); return; }
      if (!ACP.ready()) { await sendText(chatId, "❌ dsh ACP 未就绪。"); return; }
      const modelVal = (form.model ?? "").trim(); const effortVal = (form.effort ?? "").trim();
      if (!modelVal && !effortVal) { await sendText(chatId, "❌ 请先选择模型或思考深度。"); return; }
      try {
        await ACP.ensureActive(ctx.sessionId, ctx.cwd ?? CONFIG.defaultCwd);
        let applied = [];
        if (modelVal) { await ACP.setConfigOption(ctx.sessionId, "model", modelVal); const co = ACP.getConfigOptions(ctx.sessionId) ?? []; const m = co.find((o) => o.id === "model"); let name = modelVal; for (const g of m?.options ?? []) for (const o of g.options ?? []) if (o.value === modelVal) name = `${g.group ?? g.name} · ${o.name}`; applied.push(`模型 → **${name}**`); }
        if (effortVal) { await ACP.setConfigOption(ctx.sessionId, "reasoning_effort", effortVal); applied.push(`思考深度 → **${effortVal === "" ? "默认" : effortVal}**`); }
        const card = modelSettingsCard(ACP.getConfigOptions(ctx.sessionId), ctx.sessionId, true);
        if (!(await updateCard(token, card))) await sendCard(chatId, card);
      } catch (e) { await sendText(chatId, `❌ 设置失败：${e?.message ?? e}`); }
      return;
    }
    let cwd = (form.path ?? "").trim() || (form.ws ?? "").trim();
    if (!cwd) { await sendText(chatId, "❌ 请选择工作区或输入路径。"); return; }
    const abs = resolve(cwd);
    if (!isAbsolute(abs) || !dirExists(abs)) { await sendText(chatId, `❌ 目录不存在或不可读：${abs}`); return; }
    if (!ACP.ready()) { await sendText(chatId, "❌ dsh ACP 未就绪。"); return; }
    try {
      const s = await ACP.newSession(abs);
      const ctx2 = chatCtx(chatId);
      ctx2.sessionId = s.sessionId; ctx2.cwd = abs; ctx2.relay = false; saveState();
      registerSessionInGui(s.sessionId, abs);
      const card = pickerDoneCard(abs, s.sessionId);
      if (!(await updateCard(token, card))) await sendCard(chatId, card);
    } catch (e) { await sendText(chatId, `❌ 创建会话失败：${e?.message ?? e}`); }
    return;
  }
  if (tag === "button") {
    const v = parseActionValue(); const ctx = chatCtx(chatId);
    const render = async (card) => { if (token) { const ok = await updateCard(token, card); return ok; } return false; };
    if (v.do === "newform" || v.do === "new") {
      if (!ACP.ready()) { await sendText(chatId, "❌ dsh ACP 未就绪。"); return; }
      const card = pickerCard(await recentWorkspaces());
      if (!(await render(card))) await sendCard(chatId, card);
      return;
    }
    if (v.do === "home" || v.do === "status") { await render(panelCard(ctx)); return; }
    if (v.do === "modelcfg") {
      if (!ctx.sessionId) { await sendText(chatId, "❌ 当前没有会话。"); return; }
      if (!ACP.ready()) { await sendText(chatId, "❌ dsh ACP 未就绪。"); return; }
      try { await ACP.ensureActive(ctx.sessionId, ctx.cwd ?? CONFIG.defaultCwd); const card = modelSettingsCard(ACP.getConfigOptions(ctx.sessionId), ctx.sessionId); if (!(await render(card))) await sendCard(chatId, card); }
      catch (e) { await sendText(chatId, `❌ 会话不可用：${e?.message ?? e}`); }
      return;
    }
    if (v.do === "stop") {
      if (!ctx.sessionId || !ctx.busy) { await sendText(chatId, "当前没有正在执行的任务。"); return; }
      if (ctx.relay) { const r = await webControl("cancel", { sessionId: ctx.sessionId }); if (!r.ok) await sendText(chatId, `❌ 中继中断失败：${r.error}`); }
      else { const hit = ACP.cancel(ctx.sessionId); if (!hit) await sendText(chatId, "当前没有正在执行的任务。"); }
      return;
    }
    if (v.do === "help") { await sendText(chatId, HELP); return; }
    if (v.do === "list") {
      if (!ACP.ready()) { await sendText(chatId, "❌ dsh ACP 未就绪。"); return; }
      const sessions = await mergedSessions();
      ctx.lastList = sessions.map((s) => ({ sessionId: s.sessionId, cwd: s.cwd })); saveState();
      if (!(await render(browserHomeCard(sessions, ctx)))) await sendCard(chatId, browserHomeCard(sessions, ctx));
      return;
    }
    if (v.do === "back" || v.do === "browse") {
      if (!ACP.ready()) { await sendText(chatId, "❌ dsh ACP 未就绪。"); return; }
      const card = browserHomeCard(await mergedSessions(), ctx);
      ctx.browserView = { view: "home" }; saveState();
      if (!(await render(card))) await sendCard(chatId, card);
      return;
    }
    if (v.do === "wsopen") {
      if (!ACP.ready()) { await sendText(chatId, "❌ dsh ACP 未就绪。"); return; }
      const all = await mergedSessions();
      ctx.lastList = all.map((s) => ({ sessionId: s.sessionId, cwd: s.cwd })); saveState();
      const card = browserWsCard(v.cwd, await annotateSessions(all.filter((s) => s.cwd === v.cwd)), ctx.sessionId, undefined, 0);
      ctx.browserView = { view: "ws", cwd: v.cwd, page: 0 }; saveState();
      const ok = await render(card);
      if (!ok) { const ok2 = await sendCard(chatId, card); if (!ok2) await sendText(chatId, "❌ 会话列表渲染失败。"); }
      return;
    }
    if (v.do === "wspage") {
      ctx.browserView ??= { view: "ws", cwd: v.cwd };
      ctx.browserView.page = Math.max(0, (ctx.browserView.page ?? 0) + (v.delta ?? 0)); saveState();
      const all = await mergedSessions();
      const card = browserWsCard(v.cwd, await annotateSessions(all.filter((s) => s.cwd === v.cwd)), ctx.sessionId, undefined, ctx.browserView.page);
      if (!(await render(card))) await sendCard(chatId, card);
      return;
    }
    if (v.do === "newin") {
      if (!ACP.ready()) { await sendText(chatId, "❌ dsh ACP 未就绪。"); return; }
      if (!dirExists(v.cwd)) { await sendText(chatId, `❌ 目录不存在：${v.cwd}`); return; }
      try {
        const s = await ACP.newSession(v.cwd);
        ctx.sessionId = s.sessionId; ctx.cwd = v.cwd; ctx.relay = false; ctx.intendedSession = null; saveState();
        registerSessionInGui(s.sessionId, v.cwd);
        const card = browserWsCard(v.cwd, await annotateSessions((await mergedSessions()).filter((s2) => s2.cwd === v.cwd)), s.sessionId, `✅ 已在 **${v.cwd}** 创建会话 \`${shortId(s.sessionId)}\`，直接发消息开始。`);
        ctx.browserView = { view: "ws", cwd: v.cwd }; saveState();
        await render(card);
      } catch (e) { await sendText(chatId, `❌ 创建会话失败：${e?.message ?? e}`); }
      return;
    }
    if (v.do === "peek") { await peekHistory(chatId, v.sessionId, v.cwd); return; }
    if (v.do === "watch") { if (!watchRegistry.has(`${chatId}:${v.sessionId}`)) await startSpectator(chatId, v.sessionId, v.cwd); return; }
    if (v.do === "stopwatch") { await stopSpectator(chatId, v.sessionId, "\n\n⏹ 已停止观看"); return; }
    if (v.do === "export") {
      const sessionTitle = readSessionMeta(v.sessionId).title || shortId(v.sessionId);
      await render(browserWsCard(v.cwd, [], ctx.sessionId, `⏳ 正在导出「${sessionTitle.slice(0, 20)}」的记录…`));
      await exportSessionDoc(chatId, v.sessionId, v.cwd, { quiet: true });
      return;
    }
    if (v.do === "use") {
      if (!ACP.ready()) { await sendText(chatId, "❌ dsh ACP 未就绪。"); return; }
      if (!ACP.active.has(v.sessionId)) {
        const dir = sessionDirFor(v.cwd, v.sessionId);
        if (dir && await flockHeld(dir + "/session.lock")) {
          if (await tryRelaySwitch(chatId, v.sessionId, v.cwd)) {
            if (v.from === "ws" && token) {
              ctx.browserView = { view: "ws", cwd: v.cwd }; saveState();
              await render(browserWsCard(v.cwd, await annotateSessions((await mergedSessions()).filter((s) => s.cwd === v.cwd)), v.sessionId, `✅ 已切换到 \`${shortId(v.sessionId)}\`（🔗Web中继）`));
            }
            return;
          }
          const key = `${chatId}:${v.sessionId}`;
          if (pendingTakeovers.has(key)) { await sendText(chatId, "已在等待该会话的锁释放。"); return; }
          pendingTakeovers.set(key, { chatId, sessionId: v.sessionId, cwd: v.cwd, addedAt: Date.now() });
          ctx.intendedSession = { sessionId: v.sessionId, cwd: v.cwd }; saveState();
          const meta = readSessionMeta(v.sessionId);
          await sendText(chatId, `🔒 「${(meta.title || shortId(v.sessionId)).slice(0, 24)}」正被 Web GUI 持有，已开始监视锁——释放后自动切换。点「查看」随时可读它的聊天记录。`);
          await peekHistory(chatId, v.sessionId, v.cwd, 3);
          return;
        }
      }
      try {
        log("switched", chatId, "->", v.sessionId);
        await trySwitch(chatId, v.sessionId, v.cwd);
        if (v.from === "ws" && token) {
          ctx.browserView = { view: "ws", cwd: v.cwd }; saveState();
          await render(browserWsCard(v.cwd, await annotateSessions((await mergedSessions()).filter((s) => s.cwd === v.cwd)), v.sessionId, `✅ 已切换到 \`${shortId(v.sessionId)}\``));
        }
      } catch (e) { await sendText(chatId, explainSwitchError(e)); }
      return;
    }
  }
}

// ---------------- commands ----------------
const HELP = `**dsh 飞书桥** — 直接发消息即指挥当前 dsh 会话。

**命令**
- \`/help\` — 本帮助
- \`/new [路径]\` — 新建会话（不带路径弹出工作区选择卡片）
- \`/sessions\` — 按工作区浏览会话：选工作目录 → 看该目录下的会话 → 点切换接着聊
- \`/use <序号|id前缀>\` — 切换会话
- \`/stop\` — 中断当前正在执行的任务
- \`/model\` — 模型与思考深度设置卡片
- \`/effort <low|high|max|default>\` — 思考深度
- \`/watch\` — 直播正在运行的任务
- \`/history [序号|id前缀] [轮数]\` — 查看会话最近对话
- \`/export [序号|id前缀]\` — 导出会话记录为飞书文档
- \`/panel\` — 发送最新面板（控制台 + 会话卡）
- \`/cancel-takeover\` — 取消等待中的锁接管
- \`/status\` — 当前会话状态

**也可以完全不用命令**：发 \`/panel\` 获取控制台和会话卡（不置顶，随聊天流滚动）。上传图片/文件后直接发文字即可一并处理。`;
async function handleCommand(chatId, cmd, arg) {
  const ctx = chatCtx(chatId);
  switch (cmd) {
    case "help": case "帮助": await sendText(chatId, HELP); return;
    case "new": case "新建":
      if (!ACP.ready()) { await sendText(chatId, "❌ dsh ACP 未就绪。"); return; }
      if (arg) {
        const cwd = resolve(arg);
        if (!isAbsolute(cwd) || !dirExists(cwd)) { await sendText(chatId, `❌ 目录不存在：${cwd}`); return; }
        try { const s = await ACP.newSession(cwd); ctx.sessionId = s.sessionId; ctx.cwd = cwd; ctx.relay = false; ctx.intendedSession = null; saveState(); registerSessionInGui(s.sessionId, cwd); await sendText(chatId, `✅ 已在 **${cwd}** 创建会话 \`${shortId(s.sessionId)}\`。直接发消息即可开始。`); } catch (e) { await sendText(chatId, `❌ 创建会话失败：${e?.message ?? e}`); }
      } else await sendCard(chatId, pickerCard(await recentWorkspaces()));
      return;
    case "sessions": case "工作区会话": case "浏览": case "list": case "列表": case "会话": {
      if (!ACP.ready()) { await sendText(chatId, "❌ dsh ACP 未就绪。"); return; }
      const sessions = await mergedSessions();
      ctx.lastList = sessions.map((s) => ({ sessionId: s.sessionId, cwd: s.cwd })); saveState();
      await sendCard(chatId, browserHomeCard(sessions, ctx));
      return;
    }
    case "use": case "切换": {
      if (!ACP.ready()) { await sendText(chatId, "❌ dsh ACP 未就绪。"); return; }
      const target = arg ? await resolveSession(chatId, arg) : null;
      if (!target) { await sendText(chatId, "用法：`/use <序号|id前缀>`"); return; }
      if (!ACP.active.has(target.sessionId)) {
        const dir = sessionDirFor(target.cwd, target.sessionId);
        if (dir && await flockHeld(dir + "/session.lock")) {
          if (await tryRelaySwitch(chatId, target.sessionId, target.cwd)) return;
          const key = `${chatId}:${target.sessionId}`;
          ctx.intendedSession = { sessionId: target.sessionId, cwd: target.cwd }; saveState();
          if (!pendingTakeovers.has(key)) {
            pendingTakeovers.set(key, { chatId, sessionId: target.sessionId, cwd: target.cwd, addedAt: Date.now() });
            const meta = readSessionMeta(target.sessionId);
            const why = ctx.relayError ? `\nWeb 中继不可用：\`${ctx.relayError}\`` : "";
            await sendText(chatId, `🔒 「${(meta.title || shortId(target.sessionId)).slice(0, 24)}」正被 Web 持有，已开始监视锁——释放后自动切换。${why}`);
          }
          return;
        }
      }
      try { log("switched", chatId, "->", target.sessionId); await trySwitch(chatId, target.sessionId, target.cwd); } catch (e) { await sendText(chatId, explainSwitchError(e)); }
      return;
    }
    case "stop": case "中断": {
      if (ctx.sessionId && ctx.busy) {
        if (ctx.relay) { const r = await webControl("cancel", { sessionId: ctx.sessionId }); if (!r.ok) await sendText(chatId, `❌ 中继中断失败：${r.error}`); }
        else { const hit = ACP.cancel(ctx.sessionId); if (!hit) await sendText(chatId, "当前没有正在执行的任务。"); }
      } else await sendText(chatId, "当前没有正在执行的任务。");
      return;
    }
    case "status": case "状态": await sendText(chatId, `**当前会话**：${ctx.sessionId ? `\`${shortId(ctx.sessionId)}\`` : "无"}\n**工作区**：\`${ctx.cwd ?? CONFIG.defaultCwd}\`\n**状态**：${ctx.busy ? "⏳ 执行中" : "空闲"}${ctx.relay ? " · 🔗Web中继" : ""}\n\n发 \`/panel\` 获取面板，\`/list\` 查看全部会话。`); return;
    case "model": case "模型": {
      if (!ctx.sessionId) { await sendText(chatId, "当前没有会话。"); return; }
      if (!ACP.ready()) { await sendText(chatId, "❌ dsh ACP 未就绪。"); return; }
      if (!arg) { try { await ACP.ensureActive(ctx.sessionId, ctx.cwd ?? CONFIG.defaultCwd); await sendCard(chatId, modelSettingsCard(ACP.getConfigOptions(ctx.sessionId), ctx.sessionId)); } catch (e) { await sendText(chatId, `❌ ${e?.message ?? e}`); } return; }
      try { await ACP.ensureActive(ctx.sessionId, ctx.cwd ?? CONFIG.defaultCwd); } catch (e) { await sendText(chatId, `❌ 会话激活失败：${e?.message ?? e}`); return; }
      const co = ACP.getConfigOptions(ctx.sessionId); const m = (co ?? []).find((o) => o.id === "model"); const flat = [];
      for (const g of m?.options ?? []) for (const o of g.options ?? []) flat.push({ group: g.group ?? g.name, name: o.name, value: o.value });
      const kw = arg.toLowerCase();
      const hits = flat.filter((o) => (`${o.group} ${o.name}`.toLowerCase().includes(kw)) || o.value.toLowerCase().includes(kw));
      if (hits.length === 0) { await sendText(chatId, `❌ 没有匹配「${arg}」的模型。`); return; }
      if (hits.length > 1) { await sendText(chatId, `⚠️ 匹配到多个：${hits.map((o) => o.name).join("、")}`); return; }
      try {
        await ACP.setConfigOption(ctx.sessionId, "model", hits[0].value);
        const m2 = (ACP.getConfigOptions(ctx.sessionId) ?? []).find((o) => o.id === "model");
        const okNow = m2?.currentValue === hits[0].value;
        await sendText(chatId, okNow ? `✅ 模型已切换为 **${hits[0].name}**（下一个任务生效）` : `⚠️ 已提交切换，但服务端当前值仍为 \`${m2?.currentValue ?? "未知"}\`，请再试或用 /model 卡片确认。`);
      } catch (e) { await sendText(chatId, `❌ 切换失败：${e?.message ?? e}`); }
      return;
    }
    case "effort": case "深度": case "思考": case "思考深度": {
      if (!ctx.sessionId) { await sendText(chatId, "当前没有会话。"); return; }
      if (!arg) { try { await ACP.ensureActive(ctx.sessionId, ctx.cwd ?? CONFIG.defaultCwd); await sendCard(chatId, modelSettingsCard(ACP.getConfigOptions(ctx.sessionId), ctx.sessionId)); } catch (e) { await sendText(chatId, `❌ ${e?.message ?? e}`); } return; }
      const kw = arg.toLowerCase();
      const v = ["default", "provider default", "默认", ""].includes(kw) ? "" : ["low", "低"].includes(kw) ? "low" : ["high", "高"].includes(kw) ? "high" : ["max", "最大"].includes(kw) ? "max" : null;
      if (v === null) { await sendText(chatId, "用法：`/effort default|low|high|max`"); return; }
      try { await ACP.setConfigOption(ctx.sessionId, "reasoning_effort", v); await sendText(chatId, `✅ 思考深度已设为 **${v || "默认"}**`); } catch (e) { await sendText(chatId, `❌ ${e?.message ?? e}`); }
      return;
    }
    case "watch": case "观看": {
      if (!arg) { if (ctx.sessionId && (chatBusyBySession.get(ctx.sessionId) || runningSet.has(ctx.sessionId))) { await startSpectator(chatId, ctx.sessionId, ctx.cwd ?? CONFIG.defaultCwd); return; } await sendText(chatId, "用法：`/watch` 或 `/watch <序号|id前缀>`"); return; }
      const target = await resolveSession(chatId, arg);
      if (!target) { await sendText(chatId, "❌ 找不到该会话。"); return; }
      await startSpectator(chatId, target.sessionId, target.cwd);
      return;
    }
    case "history": case "记录": {
      const parts = arg.split(/\s+/).filter(Boolean);
      const target = parts[0] ? await resolveSession(chatId, parts[0]) : { sessionId: ctx.sessionId, cwd: ctx.cwd ?? CONFIG.defaultCwd };
      if (!target) { await sendText(chatId, "❌ 找不到该会话。"); return; }
      const n = Math.min(Math.max(parseInt(parts[1] ?? "5", 10) || 5, 1), 20);
      await peekHistory(chatId, target.sessionId, target.cwd, n);
      return;
    }
    case "export": case "导出": {
      const target = arg ? await resolveSession(chatId, arg) : { sessionId: ctx.sessionId, cwd: ctx.cwd ?? CONFIG.defaultCwd };
      if (!target) { await sendText(chatId, "❌ 找不到该会话。"); return; }
      await exportSessionDoc(chatId, target.sessionId, target.cwd);
      return;
    }
    case "panel": case "面板": {
      await sendFreshCards(chatId);
      await sendText(chatId, "✅ 已发送最新面板（控制台 + 会话卡）：不置顶、随聊天流滚动；最新一张的数据会实时自动更新。之后随时再发 /panel 取新的。");
      return;
    }
    case "cancel-takeover": case "取消接管": {
      let n = 0;
      for (const [key, t] of [...pendingTakeovers]) if (t.chatId === chatId) { pendingTakeovers.delete(key); n++; }
      ctx.intendedSession = null; saveState();
      await sendText(chatId, n ? `已取消 ${n} 个接管等待。` : "没有等待中的接管。");
      return;
    }
    case "ws": case "工作区": {
      if (!ACP.ready()) { await sendText(chatId, "❌ dsh ACP 未就绪。"); return; }
      await sendCard(chatId, pickerCard(await recentWorkspaces()));
      return;
    }
    default: await sendText(chatId, `未知命令 \`/${cmd}\`，发 \`/help\` 查看用法。`);
  }
}

// ---------------- message handler ----------------
const seenMessages = new Set();
async function handleMessage(ev) {
  if (!["text", "post", "image", "file"].includes(ev.message_type)) return;
  if (seenMessages.has(ev.message_id)) return;
  seenMessages.add(ev.message_id);
  if (seenMessages.size > 5000) { seenMessages.clear(); seenMessages.add(ev.message_id); }
  const chatId = ev.chat_id;
  if (ev.message_type === "image") { await handleImageMessage(chatId, ev); return; }
  if (ev.message_type === "file") { await handleFileMessage(chatId, ev); return; }
  if (["audio", "media", "sticker", "share_chat", "share_user", "system"].includes(ev.message_type)) return;
  let text = ev.content ?? "";
  try { const j = JSON.parse(text); if (j && typeof j === "object" && typeof j.text === "string") text = j.text; } catch { }
  text = text.replace(/^(<at[^>]*>\s*<\/at>\s*)+/, "");
  const m0 = ev.mentions?.[0];
  if (m0?.name && text.startsWith("@" + m0.name)) text = text.slice(("@" + m0.name).length).trim();
  else if (ev.mentions?.length && text.startsWith("@")) text = text.replace(/^@\S+\s*/, "").trim();
  text = text.trim();
  if (!text) return;
  const isTestGroup = ev.chat_type === "group" && (CONFIG.testChats ?? []).includes(ev.chat_id);
  if (ev.chat_type !== "p2p" && !isTestGroup) return;
  if (!CONFIG.allowUsers.includes(ev.sender_id)) return;
  log("message from", ev.sender_id, "in", chatId, ":", text.slice(0, 100));
  ackReaction(ev.message_id).catch((e) => log("ackReaction error", e.message));
  if (text.startsWith("/") || text.startsWith("／")) {
    const body = text.replace(/^[\/／]/, "").trim();
    const [cmd, ...rest] = body.split(/\s+/);
    const arg = rest.join(" ");
    try { await handleCommand(chatId, cmd.toLowerCase(), arg); } catch (e) { await sendText(chatId, `❌ 命令执行失败：${e?.message ?? e}`); }
    return;
  }
  await runPrompt(chatId, text);
}

// ---------------- event consumers / polling / dashboard ----------------
function startConsumer(eventKey, onEvent) {
  let stopped = false;
  const start = async () => {
    while (!stopped) {
      await new Promise((done) => {
        const p = spawn("lark-cli", ["event", "consume", eventKey, "--as", "bot"], { stdio: ["pipe", "pipe", "pipe"] });
        let buf = ""; let ready = false;
        p.stdout.on("data", (d) => {
          buf += d; let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (!line) continue;
            try { const ev = JSON.parse(line); log(eventKey, "EVENT", JSON.stringify(ev).slice(0, 400)); onEvent(ev); } catch (e) { }
          }
        });
        p.stderr.on("data", (d) => { const s = d.toString(); if (!ready && s.includes("[event] ready")) { ready = true; log(eventKey, "consumer ready"); } });
        const restart = (why) => { if (stopped) return done(); setTimeout(done, 5000); };
        p.on("exit", () => restart("exit"));
        p.on("error", () => restart("error"));
      });
    }
  };
  start();
  return () => { stopped = true; };
}
const pollBaselined = new Set();
async function pollChatOnce(chatId) {
  const as = (CONFIG.testChats ?? []).includes(chatId) ? "user" : "bot";
  const r = await runLark(["im", "+chat-messages-list", "--as", as, "--chat-id", chatId]);
  if (!r.ok) return;
  const msgs = ((r.json?.data?.messages ?? []).filter((m) => !m.deleted)).slice(0, 30);
  msgs.reverse();
  const firstPass = !pollBaselined.has(chatId);
  for (const m of msgs) {
    if (seenMessages.has(m.message_id)) continue;
    if (firstPass) { seenMessages.add(m.message_id); continue; }
    if (m.sender?.sender_type !== "user") { seenMessages.add(m.message_id); continue; }
    handleMessage({ message_id: m.message_id, chat_id: chatId, chat_type: CONFIG.testChats?.includes(chatId) ? "group" : "p2p", sender_id: m.sender.id, message_type: m.msg_type, content: m.content }).catch((e) => log("poll handleMessage error", e));
  }
  pollBaselined.add(chatId);
}
function startPolling() {
  const { enabled, intervalMs, chats } = CONFIG.poll ?? { };
  if (!enabled) return;
  const loop = async () => { for (const c of chats ?? []) { try { await pollChatOnce(c); } catch (e) { log("poll error", e.message); } } };
  loop();
  setInterval(loop, intervalMs ?? 3000);
}
function startDashboard() {
  setInterval(() => dashboardTick().catch((e) => log("dashboardTick error", e.message)), CONFIG.dashboard?.intervalMs ?? 5000);
  setInterval(async () => {
    if (!ACP.ready()) return;
    const idleMs = CONFIG.idleReleaseMs ?? 600000;
    for (const [chatId, ctx] of Object.entries(STATE.chats)) {
      if (ctx.sessionId && !ctx.busy && ACP.active.has(ctx.sessionId) && ctx.lastTurnEndedAt && Date.now() - ctx.lastTurnEndedAt > idleMs) {
        try { await ACP.closeSession(ctx.sessionId); log("idle-released", shortId(ctx.sessionId)); } catch (e) { log("idle-release failed", e.message); }
      }
    }
  }, 60000);
}

// ---------------- main ----------------
const ACP = new Acp();
startConsumer("im.message.receive_v1", (ev) => { handleMessage(ev).catch((e) => log("handleMessage error", e)); });
startConsumer("card.action.trigger", (ev) => { handleCardAction(ev).catch((e) => log("handleCardAction error", e)); });
startPolling();
startDashboard();
log("bridge started; allowed users:", CONFIG.allowUsers.join(","));
setTimeout(async () => {
  let busyCleared = false;
  for (const [chatId, c] of Object.entries(STATE.chats)) {
    if (c.busy) { c.busy = false; busyCleared = true; }
    if (c.sessionId) registerSessionInGui(c.sessionId, c.cwd ?? CONFIG.defaultCwd);
  }
  if (busyCleared) log("cleared stale busy flags");
  saveState();
}, 6000);
if (CONFIG.greetOnStart) {
  setTimeout(async () => {
    for (const ou of CONFIG.allowUsers) {
      const r = await runLark(["im", "+messages-send", "--as", "bot", "--user-id", ou, "--markdown", "-"], `🟢 **dsh 飞书桥已上线**\n\n直接发消息即可指挥本机 dsh 会话；发 \`/help\` 查看命令，\`/panel\` 获取面板。`);
      log("greet", ou, r.ok ? "ok" : "failed");
    }
  }, 8000);
}
setInterval(() => { }, 60000);
