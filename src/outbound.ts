import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { resolveSeaTalkAccount } from "./accounts.js";
import { type SeaTalkClient, resolveSeaTalkClient } from "./client.js";
import { getSeatalkRuntime } from "./runtime.js";
import { sendGroupTextMessage, sendMediaToTarget, sendTextMessage } from "./send.js";
import { looksLikeEmail, resolveSeaTalkTargetKind } from "./targets.js";

function requireClient(cfg: OpenClawConfig, accountId?: string): SeaTalkClient {
	const account = resolveSeaTalkAccount({ cfg, accountId });
	const client = resolveSeaTalkClient(account);
	if (!client) {
		throw new Error(`SeaTalk client not available for account ${account.accountId}`);
	}
	return client;
}

async function resolveEmployeeCode(client: SeaTalkClient, to: string): Promise<string> {
	if (!looksLikeEmail(to)) return to;
	const results = await client.getEmployeeCodeByEmail([to]);
	const active = results.find((r) => r.employeeCode && r.status === 2);
	if (active?.employeeCode) return active.employeeCode;
	throw new Error(`No active SeaTalk employee found for email: ${to}`);
}

function resolveThreadId(threadId?: string | number | null): string | undefined {
	if (threadId === null || threadId === undefined) return undefined;
	return String(threadId);
}

export const seatalkOutbound: ChannelOutboundAdapter = {
	deliveryMode: "direct",
	chunker: (text, limit) => getSeatalkRuntime().channel.text.chunkMarkdownText(text, limit),
	chunkerMode: "markdown",
	textChunkLimit: 4000,

	sendText: async ({ cfg, to, text, accountId, threadId }) => {
		const client = requireClient(cfg, accountId ?? undefined);
		const tid = resolveThreadId(threadId);
		const { kind, id } = resolveSeaTalkTargetKind(to);

		if (kind === "group") {
			const messageId = await sendGroupTextMessage(client, id, text, 1, tid);
			return { channel: "seatalk", messageId, chatId: id };
		}

		const employeeCode = await resolveEmployeeCode(client, id);
		const messageId = await sendTextMessage(client, employeeCode, text, 1, tid);
		return { channel: "seatalk", messageId, chatId: employeeCode };
	},

	sendMedia: async ({ cfg, to, text, mediaUrl, accountId, threadId }) => {
		const client = requireClient(cfg, accountId ?? undefined);
		const tid = resolveThreadId(threadId);
		const { kind, id } = resolveSeaTalkTargetKind(to);
		const isGroup = kind === "group";
		const target = isGroup ? id : await resolveEmployeeCode(client, id);

		// The host reconciles a send by the id of its last part, so each step
		// overwrites the previous one. An empty id is a part that never went out,
		// which must not erase the id of one that did.
		let messageId = "";
		const record = (id: string) => {
			if (id) messageId = id;
		};

		if (text?.trim()) {
			record(
				isGroup
					? await sendGroupTextMessage(client, target, text, 1, tid)
					: await sendTextMessage(client, target, text, 1, tid),
			);
		}

		if (mediaUrl) {
			try {
				record(
					await sendMediaToTarget({
						client,
						to: target,
						mediaUrl,
						threadId: tid,
						isGroup,
					}),
				);
			} catch (err) {
				const fallbackText = `[Media send failed: ${err instanceof Error ? err.message : String(err)}]`;
				record(
					isGroup
						? await sendGroupTextMessage(client, target, fallbackText, 2, tid)
						: await sendTextMessage(client, target, fallbackText, 2, tid),
				);
			}
		}

		return { channel: "seatalk", messageId, chatId: target };
	},
};
