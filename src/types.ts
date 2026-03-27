import type {
	SeaTalkAccountConfigSchema,
	SeaTalkConfigSchema,
	SeaTalkToolsConfigSchema,
	z,
} from "./config-schema.js";

export type SeaTalkConfig = z.infer<typeof SeaTalkConfigSchema>;
export type SeaTalkAccountConfig = z.infer<typeof SeaTalkAccountConfigSchema>;
export type SeaTalkToolsConfig = z.infer<typeof SeaTalkToolsConfigSchema>;

export type GatewayMode = "webhook" | "relay";

export type ResolvedSeaTalkAccount = {
	accountId: string;
	enabled: boolean;
	configured: boolean;
	appId?: string;
	appSecret?: string;
	mode: GatewayMode;
	relayUrl?: string;
	webhookPort: number;
	webhookPath: string;
	tools?: SeaTalkToolsConfig;
	config: SeaTalkConfig;
};

export type SeaTalkCallbackRequest = {
	event_id: string;
	event_type: string;
	timestamp: number;
	app_id: string;
	event: Record<string, unknown>;
};

export type SeaTalkMessageEvent = {
	seatalk_id: string;
	employee_code: string;
	email?: string;
	message: SeaTalkMessage;
};

export type SeaTalkGroupMessageEvent = {
	group_id: string;
	message: SeaTalkGroupMessage;
};

export type SeaTalkGroupMessage = SeaTalkMessage & {
	sender: {
		seatalk_id: string;
		employee_code: string;
		email?: string;
		sender_type?: number;
	};
	message_sent_time?: number;
};

export type SeaTalkMessage = {
	message_id: string;
	quoted_message_id?: string;
	thread_id?: string;
	tag: "text" | "image" | "file" | "video" | "combined_forwarded_chat_history";
	text?: { content?: string; plain_text?: string };
	image?: { content: string };
	file?: { content: string; filename: string };
	video?: { content: string };
};

export type SeaTalkMediaInfo = {
	path: string;
	contentType?: string;
	filename?: string;
	placeholder: string;
};

export type SeaTalkOutboundMedia = {
	base64: string;
	sendAs: "image" | "file";
	filename?: string;
};

export type SeaTalkProbeResult = {
	ok: boolean;
	error?: string;
	appId?: string;
	latencyMs?: number;
};

export type SeaTalkTokenInfo = {
	token: string;
	expireAt: number;
};
