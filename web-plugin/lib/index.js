/**
 * dsh-bridge-control — 飞书桥的 web 内嵌控制端点（仅本机回环 + token 鉴权）。
 * POST /bridge-control (X-Bridge-Token)
 *   {"action":"status"}  -> {ok, held:[{sessionId,cwd}], version:2}
 *   {"action":"send",...} -> {ok, accepted}
 *   {"action":"cancel",..}-> {ok, accepted}
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Token 路径优先级：环境变量 > dsh-lark-bridge 标准路径
const TOKEN_PATH = process.env.DSH_BRIDGE_TOKEN_FILE
	?? join(homedir(), ".dsh", "dsh-lark-bridge", "config", "web-control-token");

const name = "bridge-control";
const inject = ["sessionController", "agents", "webServer"];

// 每次请求都重新读 token：支持安装后才生成 / 轮换 token 而无需重启 dsh web
function readToken() {
	try { return readFileSync(TOKEN_PATH, "utf8").trim(); } catch { return ""; }
}

function apply(ctx) {
	ctx.inject(inject, (c) => {
		const remove = c.webServer.register({
			kind: "exact",
			path: "/bridge-control",
			handler: async (req, res) => {
				const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };
				try {
					const remote = req.socket.remoteAddress ?? "";
					if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") return send(403, { ok: false, error: "loopback only" });
					const token = readToken();
					if (!token) return send(500, { ok: false, error: `control token not configured (${TOKEN_PATH})` });
					if (req.headers["x-bridge-token"] !== token) return send(401, { ok: false, error: "bad token" });
					let body = "";
					for await (const chunk of req) body += chunk;
					const { action, sessionId, text, image } = JSON.parse(body || "{}");
					if (action === "status") {
						const held = c.agents.list().map((a) => ({ sessionId: a.session.id, cwd: a.session.header.cwd }));
						return send(200, { ok: true, held, version: 2 });
					}
					if (action === "send") {
						if (typeof sessionId !== "string" || typeof text !== "string" || !text.trim()) return send(400, { ok: false, error: "sessionId and non-empty text required" });
						const content = [];
						if (image && typeof image.mediaType === "string" && typeof image.data === "string") {
							content.push({ type: "image", data: image.data, mimeType: image.mediaType });
						}
						content.push({ type: "text", text });
						const accepted = await c.sessionController.prompt({ requestId: randomUUID(), sessionId, mode: "queue", content }, AbortSignal.timeout(15000));
						return send(200, { ok: true, accepted: accepted.accepted === true });
					}
					if (action === "cancel") {
						if (typeof sessionId !== "string") return send(400, { ok: false, error: "sessionId required" });
						const accepted = await c.sessionController.cancel({ sessionId });
						return send(200, { ok: true, accepted: accepted.accepted === true });
					}
					return send(400, { ok: false, error: `unknown action ${String(action)}` });
				} catch (error) {
					return send(500, { ok: false, error: String(error?.message ?? error) });
				}
			},
		});
		c.effect(() => remove, "bridge-control.route()");
		c.logger?.info?.("bridge-control: /bridge-control ready (loopback + token, v2)");
	});
}

export { name, inject, apply };
