import { getSeaTalkClient } from "./client.js";
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
		const client = getSeaTalkClient(params.appId, params.appSecret);
		const start = Date.now();
		await client.getAccessToken();
		const latencyMs = Date.now() - start;

		return {
			ok: true,
			appId: params.appId,
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
