import { sendMediaWithLeadingCaption } from "openclaw/plugin-sdk/reply-payload";
import type { SeaTalkClient } from "./client.js";
import { logger } from "./log.js";
import { resolveInboundMedia } from "./media.js";
import { sendMediaToTarget } from "./send.js";
import type { SeaTalkMediaInfo, SeaTalkMessage } from "./types.js";

export type MessageResolveContext = {
	client: SeaTalkClient;
	mediaAllowHosts?: string[] | null;
};

function formatSenderPrefix(data: Record<string, unknown>): string {
	const sender = data.sender as { email?: string; employee_code?: string } | undefined;
	const sentTime = data.message_sent_time as number | undefined;
	const parts: string[] = [];
	if (sender?.email) parts.push(sender.email);
	else if (sender?.employee_code) parts.push(sender.employee_code);
	if (sentTime) parts.push(new Date(sentTime * 1000).toISOString());
	return parts.length > 0 ? `[${parts.join(" ")}] ` : "";
}

function toSeaTalkMessage(data: Record<string, unknown>): SeaTalkMessage {
	const tag = data.tag as SeaTalkMessage["tag"];
	return {
		message_id: (data.message_id as string) ?? "",
		tag,
		text: data.text as SeaTalkMessage["text"],
		image: data.image as SeaTalkMessage["image"],
		file: data.file as SeaTalkMessage["file"],
		video: data.video as SeaTalkMessage["video"],
		combined_forwarded_chat_history:
			data.combined_forwarded_chat_history as SeaTalkMessage["combined_forwarded_chat_history"],
	};
}

export async function resolveMessageContent(
	data: Record<string, unknown>,
	ctx: MessageResolveContext,
): Promise<{ text: string; media: SeaTalkMediaInfo[] }> {
	const tag = data.tag as string | undefined;
	const media: SeaTalkMediaInfo[] = [];

	if (tag === "text") {
		const textObj = data.text as { plain_text?: string; content?: string } | undefined;
		return { text: textObj?.plain_text ?? textObj?.content ?? "", media };
	}

	if (tag === "image" || tag === "file" || tag === "video") {
		const resolved = await resolveInboundMedia({
			message: toSeaTalkMessage(data),
			client: ctx.client,
			mediaAllowHosts: ctx.mediaAllowHosts,
		});
		if (resolved) {
			media.push(resolved);
			return { text: resolved.placeholder, media };
		}
		return { text: `<media:${tag}>`, media };
	}

	if (tag === "combined_forwarded_chat_history") {
		const fwd = (data.combined_forwarded_chat_history as { content?: unknown[] } | undefined)
			?.content;
		if (fwd) {
			const result = await resolveForwardedMessages(fwd, ctx);
			media.push(...result.media);
			return {
				text:
					result.lines.length > 0
						? `[Forwarded messages]\n${result.lines.join("\n")}`
						: "[Forwarded messages]",
				media,
			};
		}
		return { text: "[Forwarded messages]", media };
	}

	return { text: `<unsupported:${tag ?? "unknown"}>`, media };
}

export async function resolveForwardedMessages(
	content: unknown[],
	ctx: MessageResolveContext,
): Promise<{ lines: string[]; media: SeaTalkMediaInfo[] }> {
	const lines: string[] = [];
	const media: SeaTalkMediaInfo[] = [];
	for (const item of content) {
		if (Array.isArray(item)) {
			const nested = await resolveForwardedMessages(item, ctx);
			lines.push(...nested.lines);
			media.push(...nested.media);
			continue;
		}
		if (!item || typeof item !== "object") continue;

		const rec = item as Record<string, unknown>;
		const prefix = formatSenderPrefix(rec);
		const result = await resolveMessageContent(rec, ctx);
		media.push(...result.media);
		if (result.text) lines.push(`${prefix}${result.text}`);
	}
	return { lines, media };
}

export async function resolveQuotedMessage(params: {
	client: SeaTalkClient;
	quotedMessageId: string;
	mediaAllowHosts?: string[] | null;
}): Promise<{ text: string; media: SeaTalkMediaInfo[] } | null> {
	const { client, quotedMessageId, mediaAllowHosts } = params;
	try {
		const data = await client.getMessageByMessageId(quotedMessageId);
		const senderObj = data.sender as { employee_code?: string; email?: string } | undefined;
		const senderCode = senderObj?.employee_code ?? "unknown";
		const sender = senderObj?.email ? `${senderCode} (${senderObj.email})` : senderCode;

		const result = await resolveMessageContent(data, { client, mediaAllowHosts });
		return { text: `[Quoted from ${sender}: ${result.text}]`, media: result.media };
	} catch (err) {
		logger("inbound").warn("resolve quoted message failed", {
			quotedMessageId,
			err: String(err),
		});
		return null;
	}
}

export async function deliverMediaReplies(params: {
	mediaUrls: string[];
	client: SeaTalkClient;
	to: string;
	threadId?: string;
	isGroup: boolean;
}): Promise<void> {
	const { mediaUrls, client, to, threadId, isGroup } = params;
	await sendMediaWithLeadingCaption({
		mediaUrls,
		caption: "",
		send: async ({ mediaUrl }) => {
			await sendMediaToTarget({ client, to, mediaUrl, threadId, isGroup });
		},
		onError: async ({ error, mediaUrl }) => {
			logger("outbound").error("media delivery failed", {
				to,
				threadId,
				isGroup,
				mediaUrl,
				err: String(error),
			});
		},
	});
}
