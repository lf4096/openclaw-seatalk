import { type Static, Type } from "@sinclair/typebox";

const CURSOR_DESC =
	"Pagination cursor. Omit for the first request to get the latest messages. To fetch older messages, pass the next_cursor value from the previous response.";

export const SeaTalkToolSchema = Type.Union([
	Type.Object({
		action: Type.Literal("group_history", {
			description:
				"Get group chat message history (requires 'Get Chat History' app permission). Messages are returned in chronological order (oldest to newest). The first page (no cursor) contains the most recent messages. Use next_cursor from the response to fetch older pages.",
		}),
		group_id: Type.String({ description: "Group chat ID" }),
		page_size: Type.Optional(Type.Number({ description: "Page size (1-100, default 50)" })),
		cursor: Type.Optional(Type.String({ description: CURSOR_DESC })),
	}),
	Type.Object({
		action: Type.Literal("group_info", { description: "Get group chat details" }),
		group_id: Type.String({ description: "Group chat ID" }),
	}),
	Type.Object({
		action: Type.Literal("group_list", {
			description: "List groups the bot has joined",
		}),
		page_size: Type.Optional(Type.Number({ description: "Page size (1-100, default 50)" })),
		cursor: Type.Optional(
			Type.String({
				description:
					"Pagination cursor. Omit for the first request. To fetch more groups, pass the next_cursor value from the previous response.",
			}),
		),
	}),
	Type.Object({
		action: Type.Literal("thread_history", {
			description:
				"Get thread messages in chronological order (oldest to newest). The first page (no cursor) contains the most recent replies. Use next_cursor to fetch older replies.",
		}),
		thread_id: Type.String({ description: "Thread ID" }),
		group_id: Type.Optional(
			Type.String({
				description: "Group chat ID (provide for group thread, omit for DM thread)",
			}),
		),
		employee_code: Type.Optional(
			Type.String({
				description: "Employee code (required for DM thread when group_id is omitted)",
			}),
		),
		page_size: Type.Optional(Type.Number({ description: "Page size (1-100, default 50)" })),
		cursor: Type.Optional(Type.String({ description: CURSOR_DESC })),
	}),
	Type.Object({
		action: Type.Literal("get_message", {
			description:
				"Get a message by its ID. Can resolve any message_id or quoted_message_id.",
		}),
		message_id: Type.String({ description: "The message ID to retrieve" }),
	}),
]);

export type SeaTalkToolParams = Static<typeof SeaTalkToolSchema>;
