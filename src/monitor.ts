import * as crypto from "node:crypto";
import * as http from "node:http";
import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import { listEnabledSeaTalkAccounts, resolveSeaTalkAccount } from "./accounts.js";
import { dispatchSeaTalkEvent } from "./bot.js";
import { resolveSeaTalkClient } from "./client.js";
import type { ResolvedSeaTalkAccount, SeaTalkCallbackRequest } from "./types.js";

export type MonitorSeaTalkOpts = {
	config?: ClawdbotConfig;
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
	cfg: ClawdbotConfig;
	account: ResolvedSeaTalkAccount;
	runtime?: RuntimeEnv;
	abortSignal?: AbortSignal;
}): Promise<void> {
	const { cfg, account, runtime, abortSignal } = params;
	const { accountId } = account;
	const log = runtime?.log ?? console.log;
	const error = runtime?.error ?? console.error;

	const port = account.webhookPort;
	const callbackPath = account.webhookPath;
	const signingSecret = account.signingSecret;

	if (!signingSecret) {
		throw new Error(`SeaTalk account "${accountId}" missing signingSecret`);
	}

	const client = resolveSeaTalkClient(account);
	if (!client) {
		throw new Error(`SeaTalk client not available for account "${accountId}"`);
	}

	log(`seatalk[${accountId}]: starting webhook server on port ${port}, path ${callbackPath}...`);

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
				log(`seatalk[${accountId}]: signature verification failed`);
				res.writeHead(403);
				res.end("Forbidden");
				return;
			}

			const body = JSON.parse(rawBody.toString("utf-8")) as SeaTalkCallbackRequest;

			if (body.event_type === "event_verification") {
				const challenge = (body.event as { seatalk_challenge?: string })?.seatalk_challenge;
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ seatalk_challenge: challenge }));
				log(`seatalk[${accountId}]: URL verification challenge responded`);
				return;
			}

			res.writeHead(200);
			res.end("OK");

			dispatchSeaTalkEvent({ cfg, event: body, client, runtime, accountId });
		} catch (err) {
			error(`seatalk[${accountId}]: request processing error: ${String(err)}`);
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
			log(`seatalk[${accountId}]: abort signal received, stopping webhook server`);
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
			log(`seatalk[${accountId}]: webhook server listening on port ${port}`);
		});

		server.on("error", (err) => {
			error(`seatalk[${accountId}]: webhook server error: ${err}`);
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

	const log = opts.runtime?.log ?? console.log;

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

	const accounts = listEnabledSeaTalkAccounts(cfg);
	if (accounts.length === 0) {
		throw new Error("No enabled SeaTalk accounts configured");
	}

	log(
		`seatalk: starting ${accounts.length} account(s): ${accounts.map((a) => a.accountId).join(", ")}`,
	);

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
