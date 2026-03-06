import type { ChannelOutboundAdapter, ClawdbotConfig } from "openclaw/plugin-sdk";
import { resolveSeaTalkAccount } from "./accounts.js";
import { type SeaTalkClient, resolveSeaTalkClient } from "./client.js";
import { prepareOutboundMedia } from "./media.js";
import { getSeatalkRuntime } from "./runtime.js";
import {
	sendFileMessage,
	sendGroupTextMessage,
	sendImageMessage,
	sendTextMessage,
} from "./send.js";
import { isGroupTarget, looksLikeEmail, parseGroupTarget } from "./targets.js";

function requireClient(cfg: ClawdbotConfig, accountId?: string): SeaTalkClient {
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

		if (isGroupTarget(to)) {
			const groupId = parseGroupTarget(to);
			await sendGroupTextMessage(client, groupId, text, 1, tid);
			return { channel: "seatalk", messageId: "", chatId: to };
		}

		const employeeCode = await resolveEmployeeCode(client, to);
		await sendTextMessage(client, employeeCode, text, 1, tid);
		return { channel: "seatalk", messageId: "", chatId: employeeCode };
	},

	sendMedia: async ({ cfg, to, text, mediaUrl, accountId, threadId }) => {
		const client = requireClient(cfg, accountId ?? undefined);
		const tid = resolveThreadId(threadId);

		if (isGroupTarget(to)) {
			const groupId = parseGroupTarget(to);
			if (text?.trim()) {
				await sendGroupTextMessage(client, groupId, text, 1, tid);
			}
			if (mediaUrl) {
				try {
					const media = await prepareOutboundMedia(mediaUrl);
					if (media) {
						if (media.sendAs === "image") {
							await client.sendGroupChat(
								groupId,
								{ tag: "image", image: { content: media.base64 } },
								tid,
							);
						} else {
							await client.sendGroupChat(
								groupId,
								{
									tag: "file",
									file: {
										content: media.base64,
										filename: media.filename || "file",
									},
								},
								tid,
							);
						}
					}
				} catch (err) {
					const fallbackText = `[Media send failed: ${err instanceof Error ? err.message : String(err)}]`;
					await sendGroupTextMessage(client, groupId, fallbackText, 2, tid);
				}
			}
			return { channel: "seatalk", messageId: "", chatId: to };
		}

		const employeeCode = await resolveEmployeeCode(client, to);
		if (text?.trim()) {
			await sendTextMessage(client, employeeCode, text, 1, tid);
		}
		if (mediaUrl) {
			try {
				const media = await prepareOutboundMedia(mediaUrl);
				if (media) {
					if (media.sendAs === "image") {
						await sendImageMessage(client, employeeCode, media.base64, tid);
					} else {
						const filename = media.filename || "file";
						await sendFileMessage(client, employeeCode, media.base64, filename, tid);
					}
				}
			} catch (err) {
				const fallbackText = `[Media send failed: ${err instanceof Error ? err.message : String(err)}]`;
				await sendTextMessage(client, employeeCode, fallbackText, 2, tid);
			}
		}
		return { channel: "seatalk", messageId: "", chatId: employeeCode };
	},
};
