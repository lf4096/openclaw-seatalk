import { SeaTalkClient } from "./client.js";
import type { SeaTalkProbeResult } from "./types.js";

export async function probeSeaTalk(params?: {
	appId?: string;
	appSecret?: string;
}): Promise<SeaTalkProbeResult> {
	if (!params?.appId || !params?.appSecret) {
		return {
			ok: false,
			error: "missing credentials (appId, appSecret)",
		};
	}

	try {
		const client = new SeaTalkClient(params.appId, params.appSecret);
		const start = Date.now();
		const tokenInfo = await client.refreshToken();
		const latencyMs = Date.now() - start;

		return {
			ok: true,
			appId: params.appId,
			tokenExpire: tokenInfo.expireAt,
			latencyMs,
		};
	} catch (err) {
		return {
			ok: false,
			appId: params.appId,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}
