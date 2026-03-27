import type { SeaTalkTokenInfo } from "./types.js";

const BASE_URL = "https://openapi.seatalk.io";

/** Hostnames allowed for inbound media downloads when `mediaDownloadHosts` is unset in config. */
export const SEATALK_DEFAULT_MEDIA_DOWNLOAD_HOSTS = [new URL(BASE_URL).hostname] as const;

const HTTP_TIMEOUT_MS = 10_000;
const TOKEN_REFRESH_MARGIN_S = 600;

export class SeaTalkClient {
	private appId: string;
	private appSecret: string;
	private tokenInfo: SeaTalkTokenInfo | null = null;
	private tokenPromise: Promise<SeaTalkTokenInfo> | null = null;

	constructor(appId: string, appSecret: string) {
		this.appId = appId;
		this.appSecret = appSecret;
	}

	async getAccessToken(): Promise<string> {
		if (this.tokenInfo) {
			const now = Math.floor(Date.now() / 1000);
			if (this.tokenInfo.expireAt - now > TOKEN_REFRESH_MARGIN_S) {
				return this.tokenInfo.token;
			}
		}
		return (await this.refreshToken()).token;
	}

	async refreshToken(): Promise<SeaTalkTokenInfo> {
		if (this.tokenPromise) {
			return this.tokenPromise;
		}

		this.tokenPromise = this._fetchToken();
		try {
			const info = await this.tokenPromise;
			this.tokenInfo = info;
			return info;
		} finally {
			this.tokenPromise = null;
		}
	}

	private async _fetchToken(): Promise<SeaTalkTokenInfo> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

		try {
			const res = await fetch(`${BASE_URL}/auth/app_access_token`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					app_id: this.appId,
					app_secret: this.appSecret,
				}),
				signal: controller.signal,
			});

			if (!res.ok) {
				const xRid = res.headers.get("x-rid") ?? undefined;
				throw new Error(
					`SeaTalk token request failed: HTTP ${res.status} (x-rid: ${xRid})`,
				);
			}

			const data = (await res.json()) as {
				code: number;
				app_access_token?: string;
				expire?: number;
				message?: string;
			};

			if (data.code !== 0) {
				throw new Error(
					`SeaTalk token error: code=${data.code} message=${data.message ?? "unknown"}`,
				);
			}

			if (!data.app_access_token || !data.expire) {
				throw new Error("SeaTalk token response missing token or expire");
			}

			return {
				token: data.app_access_token,
				expireAt: data.expire,
			};
		} finally {
			clearTimeout(timeout);
		}
	}

	async apiCall<T = Record<string, unknown>>(
		method: string,
		path: string,
		body?: unknown,
		retry = true,
	): Promise<T> {
		const token = await this.getAccessToken();
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

		try {
			const res = await fetch(`${BASE_URL}${path}`, {
				method,
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: body ? JSON.stringify(body) : undefined,
				signal: controller.signal,
			});

			const xRid = res.headers.get("x-rid") ?? undefined;

			if (!res.ok) {
				throw Object.assign(
					new Error(`SeaTalk API error: HTTP ${res.status} (x-rid: ${xRid})`),
					{ httpStatus: res.status, xRid },
				);
			}

			const data = (await res.json()) as { code: number; message?: string } & T;

			if (data.code === 100 && retry) {
				await this.refreshToken();
				return this.apiCall<T>(method, path, body, false);
			}

			if (data.code === 101) {
				throw Object.assign(new Error("SeaTalk rate limit exceeded"), {
					code: 101,
					xRid,
				});
			}

			if (data.code !== 0) {
				throw Object.assign(
					new Error(
						`SeaTalk API error: code=${data.code} message=${data.message ?? "unknown"} (x-rid: ${xRid})`,
					),
					{ code: data.code, xRid },
				);
			}

			return data;
		} finally {
			clearTimeout(timeout);
		}
	}

	async sendSingleChat(
		employeeCode: string,
		message: Record<string, unknown>,
		threadId?: string,
	): Promise<void> {
		const msg = threadId ? { ...message, thread_id: threadId } : message;
		await this.apiCall("POST", "/messaging/v2/single_chat", {
			employee_code: employeeCode,
			message: msg,
		});
	}

	async sendGroupChat(
		groupId: string,
		message: Record<string, unknown>,
		threadId?: string,
	): Promise<void> {
		const msg = threadId ? { ...message, thread_id: threadId } : message;
		await this.apiCall("POST", "/messaging/v2/group_chat", {
			group_id: groupId,
			message: msg,
		});
	}

	async setSingleChatTyping(employeeCode: string, threadId?: string): Promise<void> {
		const body: Record<string, string> = { employee_code: employeeCode };
		if (threadId) body.thread_id = threadId;
		await this.apiCall("POST", "/messaging/v2/single_chat_typing", body);
	}

	async setGroupChatTyping(groupId: string, threadId?: string): Promise<void> {
		const body: Record<string, string> = { group_id: groupId };
		if (threadId) body.thread_id = threadId;
		await this.apiCall("POST", "/messaging/v2/group_chat_typing", body);
	}

	async downloadMedia(url: string): Promise<{ buffer: Buffer; contentType: string }> {
		const token = await this.getAccessToken();

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 60_000);

		try {
			const res = await fetch(url, {
				headers: { Authorization: `Bearer ${token}` },
				signal: controller.signal,
			});

			if (!res.ok) {
				throw new Error(`SeaTalk media download failed: HTTP ${res.status}`);
			}

			const contentType = res.headers.get("content-type") ?? "application/octet-stream";
			const arrayBuffer = await res.arrayBuffer();
			return {
				buffer: Buffer.from(arrayBuffer),
				contentType,
			};
		} finally {
			clearTimeout(timeout);
		}
	}

	async getEmployeeCodeByEmail(
		emails: string[],
	): Promise<Array<{ email: string; employeeCode: string | null; status: number }>> {
		const BATCH_LIMIT = 500;
		const results: Array<{ email: string; employeeCode: string | null; status: number }> = [];

		for (let i = 0; i < emails.length; i += BATCH_LIMIT) {
			const batch = emails.slice(i, i + BATCH_LIMIT);
			const data = await this.apiCall<{
				employees: Array<{
					code: number;
					email: string;
					employee_code: string | null;
					employee_status: number;
				}>;
			}>("POST", "/contacts/v2/get_employee_code_with_email", { emails: batch });

			for (const e of data.employees ?? []) {
				results.push({
					email: e.email,
					employeeCode: e.employee_code,
					status: e.employee_status,
				});
			}
		}

		return results;
	}

	async getGroupChatHistory(
		groupId: string,
		opts?: { pageSize?: number; cursor?: string },
	): Promise<Record<string, unknown>> {
		const params = new URLSearchParams({
			group_id: groupId,
			page_size: String(opts?.pageSize ?? 50),
		});
		if (opts?.cursor) params.set("cursor", opts.cursor);
		return this.apiCall("GET", `/messaging/v2/group_chat/history?${params}`);
	}

	async getJoinedGroupChats(opts?: { pageSize?: number; cursor?: string }): Promise<
		Record<string, unknown>
	> {
		const params = new URLSearchParams();
		if (opts?.pageSize) params.set("page_size", String(opts.pageSize));
		if (opts?.cursor) params.set("cursor", opts.cursor);
		const qs = params.toString();
		return this.apiCall("GET", `/messaging/v2/group_chat/joined${qs ? `?${qs}` : ""}`);
	}

	async getGroupChatInfo(groupId: string): Promise<Record<string, unknown>> {
		return this.apiCall(
			"GET",
			`/messaging/v2/group_chat/info?group_id=${encodeURIComponent(groupId)}`,
		);
	}

	async getDmThread(
		employeeCode: string,
		threadId: string,
		opts?: { pageSize?: number; cursor?: string },
	): Promise<Record<string, unknown>> {
		const params = new URLSearchParams({
			employee_code: employeeCode,
			thread_id: threadId,
		});
		if (opts?.pageSize) params.set("page_size", String(opts.pageSize));
		if (opts?.cursor) params.set("cursor", opts.cursor);
		return this.apiCall("GET", `/messaging/v2/single_chat/get_thread_by_thread_id?${params}`);
	}

	async getGroupThread(
		groupId: string,
		threadId: string,
		opts?: { pageSize?: number; cursor?: string },
	): Promise<Record<string, unknown>> {
		const params = new URLSearchParams({
			group_id: groupId,
			thread_id: threadId,
		});
		if (opts?.pageSize) params.set("page_size", String(opts.pageSize));
		if (opts?.cursor) params.set("cursor", opts.cursor);
		return this.apiCall("GET", `/messaging/v2/group_chat/get_thread_by_thread_id?${params}`);
	}

	async getMessageByMessageId(messageId: string): Promise<Record<string, unknown>> {
		return this.apiCall(
			"GET",
			`/messaging/v2/get_message_by_message_id?message_id=${encodeURIComponent(messageId)}`,
		);
	}

	getAppId(): string {
		return this.appId;
	}
}

const clientCache = new Map<string, SeaTalkClient>();

export function getSeaTalkClient(appId: string, appSecret: string): SeaTalkClient {
	const key = `${appId}:${appSecret}`;
	let client = clientCache.get(key);
	if (!client) {
		client = new SeaTalkClient(appId, appSecret);
		clientCache.set(key, client);
	}
	return client;
}

export function resolveSeaTalkClient(params: {
	appId?: string;
	appSecret?: string;
}): SeaTalkClient | null {
	if (!params.appId || !params.appSecret) return null;
	return getSeaTalkClient(params.appId, params.appSecret);
}
