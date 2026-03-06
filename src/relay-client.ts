import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import WebSocket from "ws";
import { listEnabledSeaTalkAccounts, resolveSeaTalkAccount } from "./accounts.js";
import { dispatchSeaTalkEvent } from "./bot.js";
import { resolveSeaTalkClient } from "./client.js";
import type { MonitorSeaTalkOpts } from "./monitor.js";
import type { ResolvedSeaTalkAccount, SeaTalkCallbackRequest } from "./types.js";

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const BACKOFF_MULTIPLIER = 2;

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
	cfg: ClawdbotConfig;
	account: ResolvedSeaTalkAccount;
	relayUrl: string;
	runtime?: RuntimeEnv;
	abortSignal?: AbortSignal;
}): Promise<void> {
	const { cfg, account, relayUrl, runtime, abortSignal } = params;
	const { accountId } = account;
	const log = runtime?.log ?? console.log;
	const error = runtime?.error ?? console.error;

	if (!account.appId || !account.appSecret || !account.signingSecret) {
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

				log(`seatalk[${accountId}]: connecting to relay ${relayUrl}...`);
				const ws = new WebSocket(relayUrl);

				const handleAbort = () => {
					ws.close();
					resolve();
				};
				abortSignal?.addEventListener("abort", handleAbort, { once: true });

				ws.on("open", () => {
					log(`seatalk[${accountId}]: relay connected, authenticating...`);
					ws.send(
						JSON.stringify({
							type: "auth",
							appId: account.appId,
							appSecret: account.appSecret,
							signingSecret: account.signingSecret,
						}),
					);
				});

				let authenticated = false;

				ws.on("message", (raw) => {
					let msg: { type: string; event?: SeaTalkCallbackRequest; error?: string };
					try {
						msg = JSON.parse(String(raw));
					} catch {
						error(`seatalk[${accountId}]: relay sent invalid JSON`);
						return;
					}

					if (!authenticated) {
						if (msg.type === "auth_ok") {
							authenticated = true;
							backoff = INITIAL_BACKOFF_MS;
							log(`seatalk[${accountId}]: relay authenticated`);
						} else if (msg.type === "auth_fail") {
							error(`seatalk[${accountId}]: relay auth failed: ${msg.error}`);
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
							log(`seatalk[${accountId}]: connection replaced by another instance`);
							ws.close();
							resolve();
							return;
						default:
							log(`seatalk[${accountId}]: unknown relay message type: ${msg.type}`);
					}
				});

				ws.on("close", (code, reason) => {
					abortSignal?.removeEventListener("abort", handleAbort);
					if (authenticated) {
						log(
							`seatalk[${accountId}]: relay disconnected (code=${code}, reason=${String(reason)})`,
						);
					}
					resolve();
				});

				ws.on("error", (err) => {
					abortSignal?.removeEventListener("abort", handleAbort);
					error(`seatalk[${accountId}]: relay connection error: ${String(err)}`);
					resolve();
				});
			});
		} catch (err) {
			const msg = String(err);
			if (msg.includes("Relay auth failed")) {
				throw err;
			}
			error(`seatalk[${accountId}]: relay error: ${msg}`);
		}

		if (abortSignal?.aborted) break;

		log(`seatalk[${accountId}]: reconnecting in ${backoff}ms...`);
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

	const log = opts.runtime?.log ?? console.log;

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

	log(
		`seatalk: connecting ${accounts.length} account(s) to relay: ${accounts.map((a) => a.accountId).join(", ")}`,
	);

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
