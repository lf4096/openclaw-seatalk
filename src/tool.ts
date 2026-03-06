import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { listEnabledSeaTalkAccounts } from "./accounts.js";
import type { SeaTalkClient } from "./client.js";
import { resolveSeaTalkClient } from "./client.js";
import { type SeaTalkToolParams, SeaTalkToolSchema } from "./tool-schema.js";
import type { SeaTalkToolsConfig } from "./types.js";

function json(data: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
		details: data,
	};
}

type ResolvedToolsConfig = Required<SeaTalkToolsConfig>;

function resolveToolsConfig(cfg?: SeaTalkToolsConfig): ResolvedToolsConfig {
	return {
		groupInfo: cfg?.groupInfo ?? true,
		groupHistory: cfg?.groupHistory ?? true,
		groupList: cfg?.groupList ?? true,
		threadHistory: cfg?.threadHistory ?? true,
		getMessage: cfg?.getMessage ?? true,
	};
}

async function resolveQuotedMessages(
	client: SeaTalkClient,
	messages: Record<string, unknown>[],
	log?: (msg: string) => void,
): Promise<void> {
	for (const msg of messages) {
		if (!msg || typeof msg !== "object") continue;
		const qid = msg.quoted_message_id;
		if (!qid || typeof qid !== "string") continue;
		try {
			const quoted = await client.getMessageByMessageId(qid);
			msg.quoted_message = quoted;
		} catch (err) {
			log?.(`seatalk tool: failed to resolve quoted message ${qid}: ${String(err)}`);
			msg.quoted_message = null;
		}
	}
}

function reverseMessageArray(
	data: Record<string, unknown>,
	key: string,
): Record<string, unknown>[] {
	const arr = data[key];
	if (Array.isArray(arr)) {
		const reversed = (arr as Record<string, unknown>[]).toReversed();
		data[key] = reversed;
		return reversed;
	}
	return [];
}

export function registerSeaTalkTool(api: OpenClawPluginApi) {
	if (!api.config) {
		api.logger.debug?.("seatalk tool: No config available, skipping");
		return;
	}

	const accounts = listEnabledSeaTalkAccounts(api.config);
	if (accounts.length === 0) {
		api.logger.debug?.("seatalk tool: No enabled SeaTalk accounts, skipping");
		return;
	}

	const firstAccount = accounts[0];
	const toolsCfg = resolveToolsConfig(firstAccount.tools);

	const anyEnabled =
		toolsCfg.groupInfo ||
		toolsCfg.groupHistory ||
		toolsCfg.groupList ||
		toolsCfg.threadHistory ||
		toolsCfg.getMessage;
	if (!anyEnabled) {
		api.logger.debug?.("seatalk tool: All actions disabled, skipping");
		return;
	}

	const getClient = () => resolveSeaTalkClient(firstAccount);
	const log = (msg: string) => api.logger.warn?.(msg);

	api.registerTool(
		{
			name: "seatalk",
			label: "SeaTalk",
			description:
				"SeaTalk operations. Actions: group_history (group chat messages, chronological order), group_info (group details), group_list (joined groups), thread_history (thread messages, chronological order), get_message (retrieve a single message by ID). History and thread results include resolved quoted_message for messages that quote another message.",
			parameters: SeaTalkToolSchema,
			async execute(_toolCallId, params) {
				const p = params as SeaTalkToolParams;
				try {
					const client = getClient();
					if (!client) {
						return json({ error: "SeaTalk client not available" });
					}

					switch (p.action) {
						case "group_history": {
							if (!toolsCfg.groupHistory) {
								return json({ error: "groupHistory is disabled in config" });
							}
							const data = await client.getGroupChatHistory(p.group_id, {
								pageSize: p.page_size,
								cursor: p.cursor,
							});
							const msgs = reverseMessageArray(data, "group_chat_messages");
							await resolveQuotedMessages(client, msgs, log);
							return json(data);
						}
						case "group_info": {
							if (!toolsCfg.groupInfo) {
								return json({ error: "groupInfo is disabled in config" });
							}
							return json(await client.getGroupChatInfo(p.group_id));
						}
						case "group_list": {
							if (!toolsCfg.groupList) {
								return json({ error: "groupList is disabled in config" });
							}
							return json(
								await client.getJoinedGroupChats({
									pageSize: p.page_size,
									cursor: p.cursor,
								}),
							);
						}
						case "thread_history": {
							if (!toolsCfg.threadHistory) {
								return json({ error: "threadHistory is disabled in config" });
							}
							let data: Record<string, unknown>;
							if (p.group_id) {
								data = await client.getGroupThread(p.group_id, p.thread_id, {
									pageSize: p.page_size,
									cursor: p.cursor,
								});
							} else {
								if (!p.employee_code) {
									return json({
										error: "employee_code is required for DM thread (when group_id is absent)",
									});
								}
								data = await client.getDmThread(p.employee_code, p.thread_id, {
									pageSize: p.page_size,
									cursor: p.cursor,
								});
							}
							const msgs = reverseMessageArray(data, "thread_messages");
							await resolveQuotedMessages(client, msgs, log);
							return json(data);
						}
						case "get_message": {
							if (!toolsCfg.getMessage) {
								return json({ error: "getMessage is disabled in config" });
							}
							return json(await client.getMessageByMessageId(p.message_id));
						}
						default:
							return json({
								error: `Unknown action: ${String((p as Record<string, unknown>).action)}`,
							});
					}
				} catch (err) {
					return json({
						error: err instanceof Error ? err.message : String(err),
					});
				}
			},
		},
		{ name: "seatalk" },
	);

	api.logger.info?.("seatalk tool: Registered");
}
