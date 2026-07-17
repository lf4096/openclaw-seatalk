import * as crypto from "node:crypto";
import * as http from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import {
	listEnabledSeaTalkAccounts,
	resolveSeaTalkAccount,
	resolveSeaTalkCredentials,
} from "./accounts.js";
import { dispatchSeaTalkEvent } from "./bot.js";
import { resolveSeaTalkClient } from "./client.js";
import { logger } from "./log.js";
import type { ResolvedSeaTalkAccount, SeaTalkCallbackRequest } from "./types.js";

export type MonitorSeaTalkOpts = {
	config?: OpenClawConfig;
	runtime?: RuntimeEnv;
	abortSignal?: AbortSignal;
	accountId?: string;
};

function verifySignature(rawBody: Buffer, signingSecret: string, signature: string): boolean {
	const secretBytes = Buffer.from(signingSecret, "latin1");
	const calculated = crypto
		.createHash("sha256")
		.update(Buffer.concat([rawBody, secretBytes]))
		.digest("hex");

	try {
		return crypto.timingSafeEqual(
			Buffer.from(calculated, "hex"),
			Buffer.from(signature, "hex"),
		);
	} catch {
		return false;
	}
}

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB

class PayloadTooLargeError extends Error {
	constructor() {
		super("Request body too large");
		this.name = "PayloadTooLargeError";
	}
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		let received = 0;
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => {
			received += chunk.length;
			if (received > MAX_BODY_BYTES) {
				req.destroy(new PayloadTooLargeError());
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

async function monitorSingleAccount(params: {
	cfg: OpenClawConfig;
	account: ResolvedSeaTalkAccount;
	runtime?: RuntimeEnv;
	abortSignal?: AbortSignal;
}): Promise<void> {
	const { cfg, account, runtime, abortSignal } = params;
	const { accountId } = account;
	const log = logger("webhook");

	const port = account.webhookPort;
	const callbackPath = account.webhookPath;
	const signingSecret = resolveSeaTalkCredentials(account.config)?.signingSecret;

	if (!signingSecret) {
		throw new Error(`SeaTalk account "${accountId}" missing signingSecret`);
	}

	const client = resolveSeaTalkClient(account);
	if (!client) {
		throw new Error(`SeaTalk client not available for account "${accountId}"`);
	}

	log.info("starting webhook", { accountId, port, path: callbackPath });

	const server = http.createServer();

	server.on("request", async (req, res) => {
		const pathname = new URL(req.url ?? "/", `http://localhost:${port}`).pathname;
		if (req.method !== "POST" || pathname !== callbackPath) {
			res.writeHead(404);
			res.end("Not Found");
			return;
		}

		try {
			const rawBody = await readBody(req);
			const signature = req.headers.signature as string | undefined;

			if (!signature || !verifySignature(rawBody, signingSecret, signature)) {
				log.warn("signature verification failed", { accountId });
				res.writeHead(403);
				res.end("Forbidden");
				return;
			}

			const body = JSON.parse(rawBody.toString("utf-8")) as SeaTalkCallbackRequest;

			if (body.event_type === "event_verification") {
				const challenge = (body.event as { seatalk_challenge?: string })?.seatalk_challenge;
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ seatalk_challenge: challenge }));
				log.info("url verification responded", { accountId });
				return;
			}

			res.writeHead(200);
			res.end("OK");

			dispatchSeaTalkEvent({ cfg, event: body, client, runtime, accountId });
		} catch (err) {
			log.error("request processing error", { accountId, err: String(err) });
			if (!res.headersSent) {
				if (err instanceof PayloadTooLargeError) {
					res.writeHead(413);
					res.end("Payload Too Large");
				} else {
					res.writeHead(500);
					res.end("Internal Server Error");
				}
			}
		}
	});

	return new Promise((resolve, reject) => {
		const cleanup = () => {
			server.close();
		};

		const handleAbort = () => {
			log.info("abort received, stopping webhook", { accountId });
			cleanup();
			resolve();
		};

		if (abortSignal?.aborted) {
			cleanup();
			resolve();
			return;
		}

		abortSignal?.addEventListener("abort", handleAbort, { once: true });

		server.listen(port, () => {
			log.info("webhook listening", { accountId, port });
		});

		server.on("error", (err) => {
			log.error("webhook server error", { accountId, err: String(err) });
			abortSignal?.removeEventListener("abort", handleAbort);
			reject(err);
		});
	});
}

export async function monitorSeaTalkProvider(opts: MonitorSeaTalkOpts = {}): Promise<void> {
	const cfg = opts.config;
	if (!cfg) {
		throw new Error("Config is required for SeaTalk monitor");
	}

	const log = logger("webhook");

	if (opts.accountId) {
		const account = resolveSeaTalkAccount({ cfg, accountId: opts.accountId });
		if (!account.enabled || !account.configured) {
			throw new Error(`SeaTalk account "${opts.accountId}" not configured or disabled`);
		}
		return monitorSingleAccount({
			cfg,
			account,
			runtime: opts.runtime,
			abortSignal: opts.abortSignal,
		});
	}

	const accounts = listEnabledSeaTalkAccounts(cfg).filter((a) => a.mode === "webhook");
	if (accounts.length === 0) {
		throw new Error("No enabled SeaTalk webhook-mode accounts configured");
	}

	log.info("starting accounts", {
		count: accounts.length,
		accountIds: accounts.map((a) => a.accountId),
	});

	await Promise.all(
		accounts.map((account) =>
			monitorSingleAccount({
				cfg,
				account,
				runtime: opts.runtime,
				abortSignal: opts.abortSignal,
			}),
		),
	);
}
