import type { SeaTalkClient } from "./client.js";
import { prepareOutboundMedia } from "./media.js";

export async function sendTextMessage(
	client: SeaTalkClient,
	employeeCode: string,
	text: string,
	format: 1 | 2 = 1,
	threadId?: string,
): Promise<string> {
	return await client.sendSingleChat(
		employeeCode,
		{ tag: "text", text: { format, content: text } },
		threadId,
	);
}

export async function sendImageMessage(
	client: SeaTalkClient,
	employeeCode: string,
	base64Data: string,
	threadId?: string,
): Promise<string> {
	return await client.sendSingleChat(
		employeeCode,
		{ tag: "image", image: { content: base64Data } },
		threadId,
	);
}

export async function sendFileMessage(
	client: SeaTalkClient,
	employeeCode: string,
	base64Data: string,
	filename: string,
	threadId?: string,
): Promise<string> {
	return await client.sendSingleChat(
		employeeCode,
		{ tag: "file", file: { content: base64Data, filename } },
		threadId,
	);
}

export async function sendGroupTextMessage(
	client: SeaTalkClient,
	groupId: string,
	text: string,
	format: 1 | 2 = 1,
	threadId?: string,
): Promise<string> {
	return await client.sendGroupChat(
		groupId,
		{ tag: "text", text: { format, content: text } },
		threadId,
	);
}

export async function sendMediaToTarget(params: {
	client: SeaTalkClient;
	to: string;
	mediaUrl: string;
	threadId?: string;
	isGroup: boolean;
}): Promise<string> {
	const { client, to, mediaUrl, threadId, isGroup } = params;
	const media = await prepareOutboundMedia(mediaUrl);
	if (!media) return "";

	if (isGroup) {
		if (media.sendAs === "image") {
			return await client.sendGroupChat(
				to,
				{ tag: "image", image: { content: media.base64 } },
				threadId,
			);
		}
		return await client.sendGroupChat(
			to,
			{
				tag: "file",
				file: { content: media.base64, filename: media.filename || "file" },
			},
			threadId,
		);
	}
	if (media.sendAs === "image") {
		return await sendImageMessage(client, to, media.base64, threadId);
	}
	return await sendFileMessage(client, to, media.base64, media.filename || "file", threadId);
}
