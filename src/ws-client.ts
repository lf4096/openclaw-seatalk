import * as crypto from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import WebSocket from "ws";
import { listEnabledSeaTalkAccounts, resolveSeaTalkAccount } from "./accounts.js";
import { dispatchSeaTalkEvent } from "./bot.js";
import { resolveSeaTalkClient } from "./client.js";
import { logger } from "./log.js";
import type { MonitorSeaTalkOpts } from "./monitor.js";
import type { ResolvedSeaTalkAccount, SeaTalkCallbackRequest } from "./types.js";

// SeaTalk Open Platform developer-bot WebSocket endpoint (fixed; official SDK default).
const WS_URL = "wss://ws-openapi.haiserve.com/ws/bot";

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const BACKOFF_MULTIPLIER = 2;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const DEFAULT_PING_INTERVAL_MS = 15_000;
const STALE_TIMEOUT_MS = 75_000;
const READ_LIMIT_BYTES = 1024 * 1024;

const REGISTER_REJECTED = "SeaTalk register rejected";

type WsHeader = {
	app_id?: string;
	app_secret?: string;
	token?: string;
	sid?: string;
	callback_id?: string;
	rid?: string;
};

type WsEnvelope = {
	cmd: string;
	header?: WsHeader;
	data?: unknown;
	code?: number;
	message?: string;
};

function newRid(): string {
	return crypto.randomBytes(16).toString("hex");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function connectSingleAccount(params: {
	cfg: OpenClawConfig;
	account: ResolvedSeaTalkAccount;
	runtime?: RuntimeEnv;
	abortSignal?: AbortSignal;
}): Promise<void> {
	const { cfg, account, runtime, abortSignal } = params;
	const { accountId } = account;
	const log = logger("ws");

	if (!account.appId || !account.appSecret) {
		throw new Error(`SeaTalk account "${accountId}" missing credentials for websocket mode`);
	}

	const client = resolveSeaTalkClient(account);
	if (!client) {
		throw new Error(`SeaTalk client not available for account "${accountId}"`);
	}

	let backoff = INITIAL_BACKOFF_MS;

	while (!abortSignal?.aborted) {
		try {
			await new Promise<void>((resolve, reject) => {
				if (abortSignal?.aborted) {
					resolve();
					return;
				}

				log.info("connecting", { accountId, wsUrl: WS_URL });
				const ws = new WebSocket(WS_URL, {
					maxPayload: READ_LIMIT_BYTES,
					handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
				});

				let token = "";
				let registered = false;
				// Raised after register to track the negotiated ping cadence.
				let staleMs = STALE_TIMEOUT_MS;
				let pingTimer: ReturnType<typeof setInterval> | undefined;
				let staleTimer: ReturnType<typeof setTimeout> | undefined;

				const clearTimers = () => {
					if (pingTimer) clearInterval(pingTimer);
					if (staleTimer) clearTimeout(staleTimer);
					pingTimer = undefined;
					staleTimer = undefined;
				};
				const armStaleTimer = () => {
					if (staleTimer) clearTimeout(staleTimer);
					staleTimer = setTimeout(() => {
						log.error("ws silent, terminating", { accountId, timeoutMs: staleMs });
						ws.terminate();
					}, staleMs);
				};
				const send = (env: WsEnvelope) => {
					if (ws.readyState === ws.OPEN) {
						ws.send(
							JSON.stringify({ ...env, header: { rid: newRid(), ...env.header } }),
						);
					}
				};
				const closeAndRetry = () => {
					clearTimers();
					ws.close();
					resolve();
				};

				const handleAbort = () => {
					clearTimers();
					ws.close();
					resolve();
				};
				abortSignal?.addEventListener("abort", handleAbort, { once: true });

				ws.on("upgrade", (response) => {
					response.socket.setKeepAlive(true, 60_000);
				});

				ws.on("open", () => {
					armStaleTimer();
					log.info("connected, registering", { accountId });
					send({
						cmd: "register",
						header: { app_id: account.appId, app_secret: account.appSecret },
					});
				});

				ws.on("message", (raw, isBinary) => {
					armStaleTimer();
					if (isBinary) return;
					let env: WsEnvelope;
					try {
						env = JSON.parse(String(raw));
					} catch {
						log.warn("invalid ws json", { accountId });
						return;
					}

					if (!registered) {
						// The SDK treats any non-register frame during the handshake as fatal
						// for this connection attempt.
						if (env.cmd !== "register") {
							log.warn("unexpected pre-register frame", { accountId, cmd: env.cmd });
							if (env.cmd === "kick") backoff = MAX_BACKOFF_MS;
							closeAndRetry();
							return;
						}
						if ((env.code ?? 0) !== 0 || !env.header?.token) {
							clearTimers();
							ws.close();
							reject(
								new Error(
									`${REGISTER_REJECTED}: code=${env.code ?? "?"} ${env.message ?? ""}`.trim(),
								),
							);
							return;
						}
						token = env.header.token;
						registered = true;
						backoff = INITIAL_BACKOFF_MS;
						const settings = (env.data ?? {}) as { heartbeat_interval?: number };
						const pingMs =
							settings.heartbeat_interval && settings.heartbeat_interval > 0
								? settings.heartbeat_interval * 1000
								: DEFAULT_PING_INTERVAL_MS;
						staleMs = Math.max(STALE_TIMEOUT_MS, pingMs * 2);
						log.info("registered", { accountId, sid: env.header.sid, pingMs });
						pingTimer = setInterval(
							() => send({ cmd: "ping", header: { token } }),
							pingMs,
						);
						return;
					}

					switch (env.cmd) {
						case "event": {
							const callbackId = env.header?.callback_id;
							if (env.data) {
								dispatchSeaTalkEvent({
									cfg,
									event: env.data as SeaTalkCallbackRequest,
									client,
									runtime,
									accountId,
								});
							}
							// Ack on receipt (event_id dedup guards redelivery); the reply pipeline
							// runs async and would otherwise blow the ack window.
							if (callbackId)
								send({ cmd: "ack", header: { token, callback_id: callbackId } });
							break;
						}
						case "pong":
							break;
						case "kick":
							// Kick usually means another connection registered with the same app;
							// back off fully so two instances cannot kick each other in a tight loop.
							log.warn("connection kicked", { accountId, err: env.message });
							backoff = MAX_BACKOFF_MS;
							closeAndRetry();
							return;
						default:
							log.warn("unknown ws message", { accountId, cmd: env.cmd });
					}
				});

				ws.on("close", (code, reason) => {
					clearTimers();
					abortSignal?.removeEventListener("abort", handleAbort);
					if (registered) {
						log.info("disconnected", { accountId, code, reason: String(reason) });
					}
					resolve();
				});

				ws.on("error", (err) => {
					clearTimers();
					abortSignal?.removeEventListener("abort", handleAbort);
					log.error("connection error", { accountId, err: String(err) });
					resolve();
				});
			});
		} catch (err) {
			const msg = String(err);
			if (msg.includes(REGISTER_REJECTED)) {
				throw err;
			}
			log.error("ws error", { accountId, err: msg });
		}

		if (abortSignal?.aborted) break;

		log.info("reconnecting", { accountId, backoffMs: backoff });
		await sleep(backoff, abortSignal);
		backoff = Math.min(backoff * BACKOFF_MULTIPLIER, MAX_BACKOFF_MS);
	}
}

export async function connectSeaTalkWebSocket(opts: MonitorSeaTalkOpts): Promise<void> {
	const cfg = opts.config;
	if (!cfg) {
		throw new Error("Config is required for SeaTalk websocket client");
	}

	const log = logger("ws");

	if (opts.accountId) {
		const account = resolveSeaTalkAccount({ cfg, accountId: opts.accountId });
		if (!account.enabled || !account.configured) {
			throw new Error(`SeaTalk account "${opts.accountId}" not configured or disabled`);
		}
		return connectSingleAccount({
			cfg,
			account,
			runtime: opts.runtime,
			abortSignal: opts.abortSignal,
		});
	}

	const accounts = listEnabledSeaTalkAccounts(cfg).filter((a) => a.mode === "websocket");
	if (accounts.length === 0) {
		throw new Error("No enabled SeaTalk websocket-mode accounts configured");
	}

	log.info("connecting accounts", {
		count: accounts.length,
		accountIds: accounts.map((a) => a.accountId),
	});

	await Promise.all(
		accounts.map((account) =>
			connectSingleAccount({
				cfg,
				account,
				runtime: opts.runtime,
				abortSignal: opts.abortSignal,
			}),
		),
	);
}
