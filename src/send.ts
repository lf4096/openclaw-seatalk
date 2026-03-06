import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { resolveSeaTalkAccount } from "./accounts.js";
import { type SeaTalkClient, resolveSeaTalkClient } from "./client.js";

export async function sendTextMessage(
	client: SeaTalkClient,
	employeeCode: string,
	text: string,
	format: 1 | 2 = 1,
	threadId?: string,
): Promise<void> {
	await client.sendSingleChat(
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
): Promise<void> {
	await client.sendSingleChat(
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
): Promise<void> {
	await client.sendSingleChat(
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
): Promise<void> {
	await client.sendGroupChat(groupId, { tag: "text", text: { format, content: text } }, threadId);
}

export async function sendSeaTalkMessage(params: {
	cfg: ClawdbotConfig;
	to: string;
	text: string;
	accountId?: string;
}): Promise<{ messageId?: string; chatId?: string }> {
	const { cfg, to, text, accountId } = params;
	const account = resolveSeaTalkAccount({ cfg, accountId });
	const client = resolveSeaTalkClient(account);
	if (!client) {
		throw new Error(`SeaTalk client not available for account ${account.accountId}`);
	}

	await sendTextMessage(client, to, text, 1);
	return { chatId: to };
}
