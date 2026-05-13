import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import WebSocket from "ws";
import {
	listEnabledSeaTalkAccounts,
	resolveSeaTalkAccount,
	resolveSeaTalkCredentials,
} from "./accounts.js";
import { dispatchSeaTalkEvent } from "./bot.js";
import { resolveSeaTalkClient } from "./client.js";
import { logger } from "./log.js";
import type { MonitorSeaTalkOpts } from "./monitor.js";
import type { ResolvedSeaTalkAccount, SeaTalkCallbackRequest } from "./types.js";

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const BACKOFF_MULTIPLIER = 2;
const STALE_TIMEOUT_MS = 75_000;

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
	relayUrl: string;
	runtime?: RuntimeEnv;
	abortSignal?: AbortSignal;
}): Promise<void> {
	const { cfg, account, relayUrl, runtime, abortSignal } = params;
	const { accountId } = account;
	const log = logger("relay");

	const signingSecret = resolveSeaTalkCredentials(account.config)?.signingSecret;
	if (!account.appId || !account.appSecret || !signingSecret) {
		throw new Error(`SeaTalk account "${accountId}" missing credentials for relay mode`);
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

				log.info("connecting", { accountId, relayUrl });
				const ws = new WebSocket(relayUrl);

				let staleTimer: ReturnType<typeof setTimeout> | undefined;
				const clearStaleTimer = () => {
					if (staleTimer) {
						clearTimeout(staleTimer);
						staleTimer = undefined;
					}
				};
				const armStaleTimer = () => {
					clearStaleTimer();
					staleTimer = setTimeout(() => {
						log.error("relay silent, terminating", {
							accountId,
							timeoutMs: STALE_TIMEOUT_MS,
						});
						ws.terminate();
					}, STALE_TIMEOUT_MS);
				};

				const handleAbort = () => {
					clearStaleTimer();
					ws.close();
					resolve();
				};
				abortSignal?.addEventListener("abort", handleAbort, { once: true });

				ws.on("upgrade", (response) => {
					response.socket.setKeepAlive(true, 60_000);
				});

				ws.on("open", () => {
					armStaleTimer();
					log.info("connected, authenticating", { accountId });
					ws.send(
						JSON.stringify({
							type: "auth",
							appId: account.appId,
							appSecret: account.appSecret,
							signingSecret,
						}),
					);
				});

				let authenticated = false;

				ws.on("message", (raw) => {
					armStaleTimer();
					let msg: { type: string; event?: SeaTalkCallbackRequest; error?: string };
					try {
						msg = JSON.parse(String(raw));
					} catch {
						log.warn("invalid relay json", { accountId });
						return;
					}

					if (!authenticated) {
						if (msg.type === "auth_ok") {
							authenticated = true;
							backoff = INITIAL_BACKOFF_MS;
							log.info("authenticated", { accountId });
						} else if (msg.type === "auth_fail") {
							log.error("auth failed", { accountId, err: msg.error });
							ws.close();
							reject(new Error(`Relay auth failed: ${msg.error}`));
						}
						return;
					}

					switch (msg.type) {
						case "event":
							if (msg.event && client) {
								dispatchSeaTalkEvent({
									cfg,
									event: msg.event,
									client,
									runtime,
									accountId,
								});
							}
							break;
						case "ping":
							ws.send(JSON.stringify({ type: "pong" }));
							break;
						case "replaced":
							log.warn("connection replaced", { accountId });
							ws.close();
							resolve();
							return;
						default:
							log.warn("unknown relay message", { accountId, type: msg.type });
					}
				});

				ws.on("close", (code, reason) => {
					clearStaleTimer();
					abortSignal?.removeEventListener("abort", handleAbort);
					if (authenticated) {
						log.info("disconnected", {
							accountId,
							code,
							reason: String(reason),
						});
					}
					resolve();
				});

				ws.on("error", (err) => {
					clearStaleTimer();
					abortSignal?.removeEventListener("abort", handleAbort);
					log.error("connection error", { accountId, err: String(err) });
					resolve();
				});
			});
		} catch (err) {
			const msg = String(err);
			if (msg.includes("Relay auth failed")) {
				throw err;
			}
			log.error("relay error", { accountId, err: msg });
		}

		if (abortSignal?.aborted) break;

		log.info("reconnecting", { accountId, backoffMs: backoff });
		await sleep(backoff, abortSignal);
		backoff = Math.min(backoff * BACKOFF_MULTIPLIER, MAX_BACKOFF_MS);
	}
}

export async function connectSeaTalkRelay(
	opts: MonitorSeaTalkOpts & { relayUrl: string },
): Promise<void> {
	const cfg = opts.config;
	if (!cfg) {
		throw new Error("Config is required for SeaTalk relay client");
	}

	const log = logger("relay");

	if (opts.accountId) {
		const account = resolveSeaTalkAccount({ cfg, accountId: opts.accountId });
		if (!account.enabled || !account.configured) {
			throw new Error(`SeaTalk account "${opts.accountId}" not configured or disabled`);
		}
		return connectSingleAccount({
			cfg,
			account,
			relayUrl: opts.relayUrl,
			runtime: opts.runtime,
			abortSignal: opts.abortSignal,
		});
	}

	const accounts = listEnabledSeaTalkAccounts(cfg);
	if (accounts.length === 0) {
		throw new Error("No enabled SeaTalk accounts configured");
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
				relayUrl: opts.relayUrl,
				runtime: opts.runtime,
				abortSignal: opts.abortSignal,
			}),
		),
	);
}
