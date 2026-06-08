import type { AssembledInboundReply, InboundMediaFacts } from "openclaw/plugin-sdk/channel-inbound";
import { createChannelMessageReplyPipeline } from "openclaw/plugin-sdk/channel-outbound";
import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import {
	DM_GROUP_ACCESS_REASON,
	resolveDmGroupAccessWithLists,
} from "openclaw/plugin-sdk/channel-policy";

type SeaTalkDelivery = AssembledInboundReply["delivery"];
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { checkGroupAccess } from "./access.js";
import { resolveSeaTalkAccount } from "./accounts.js";
import type { SeaTalkClient } from "./client.js";
import {
	type MessageResolveContext,
	deliverMediaReplies,
	resolveForwardedMessages,
	resolveQuotedMessage,
} from "./inbound-resolve.js";
import { logger } from "./log.js";
import { resolveInboundMedia } from "./media.js";
import { getSeatalkRuntime } from "./runtime.js";
import { sendGroupTextMessage, sendTextMessage } from "./send.js";
import type {
	SeaTalkCallbackRequest,
	SeaTalkGroupMessageEvent,
	SeaTalkMediaInfo,
	SeaTalkMessageEvent,
} from "./types.js";

function isSeaTalkSenderAllowed(
	employeeCode: string,
	email: string | undefined,
	allowFrom: string[],
): boolean {
	return allowFrom.some((entry) => {
		const e = entry.trim();
		if (e === "*") return true;
		if (e === employeeCode) return true;
		if (email && e.toLowerCase() === email.toLowerCase()) return true;
		return false;
	});
}

export function dispatchSeaTalkEvent(params: {
	cfg: OpenClawConfig;
	event: SeaTalkCallbackRequest;
	client: SeaTalkClient;
	runtime?: RuntimeEnv;
	accountId: string;
}): void {
	const { cfg, event, client, runtime, accountId } = params;
	const log = logger("event");
	const handle = (fn: () => Promise<void>) =>
		fn().catch((err) =>
			log.error("event handler failed", {
				accountId,
				eventType: event.event_type,
				err: String(err),
			}),
		);

	switch (event.event_type) {
		case "message_from_bot_subscriber":
			handle(() => handleSeaTalkMessage({ cfg, event, client, runtime, accountId }));
			break;
		case "new_mentioned_message_received_from_group_chat":
		case "new_message_received_from_thread":
			handle(() => handleSeaTalkGroupMessage({ cfg, event, client, runtime, accountId }));
			break;
		case "new_bot_subscriber": {
			const employeeCode = (event.event as { employee_code?: string })?.employee_code;
			log.info("new subscriber", { accountId, employeeCode });
			break;
		}
		case "bot_added_to_group_chat": {
			const groupId = (event.event as { group_id?: string })?.group_id;
			log.info("bot added to group", { accountId, groupId });
			break;
		}
		case "bot_removed_from_group_chat": {
			const groupId = (event.event as { group_id?: string })?.group_id;
			log.info("bot removed from group", { accountId, groupId });
			break;
		}
		default:
			log.warn("unhandled event", { accountId, eventType: event.event_type });
	}
}

const DEDUP_TTL_MS = 30 * 60 * 1000;
const DEDUP_MAX_SIZE = 1_000;
const DEDUP_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const processedEventIds = new Map<string, number>();
let lastCleanupTime = Date.now();

function tryRecordEvent(eventId: string): boolean {
	const now = Date.now();

	if (now - lastCleanupTime > DEDUP_CLEANUP_INTERVAL_MS) {
		for (const [id, ts] of processedEventIds) {
			if (now - ts > DEDUP_TTL_MS) processedEventIds.delete(id);
		}
		lastCleanupTime = now;
	}

	if (processedEventIds.has(eventId)) return false;

	if (processedEventIds.size >= DEDUP_MAX_SIZE) {
		const first = processedEventIds.keys().next().value!;
		processedEventIds.delete(first);
	}

	processedEventIds.set(eventId, now);
	return true;
}

const SEATALK_TEXT_CHUNK_LIMIT = 4000;
// SeaTalk resets the typing indicator every 4s; refresh at 3s to keep it lit.
const TYPING_KEEPALIVE_MS = 3000;
// Fallback inbound debounce window when messages.inbound.debounceMs is unset.
const PLUGIN_DEBOUNCE_DEFAULT_MS = 1500;

type TurnContext = {
	cfg: OpenClawConfig;
	client: SeaTalkClient;
	runtime?: RuntimeEnv;
	accountId: string;
};

type DmBufferEntry = {
	kind: "dm";
	event: SeaTalkCallbackRequest;
	parsedEvent: SeaTalkMessageEvent;
	ctx: TurnContext;
};

type GroupBufferEntry = {
	kind: "group";
	event: SeaTalkCallbackRequest;
	groupEvent: SeaTalkGroupMessageEvent;
	groupId: string;
	eventType: string;
	ctx: TurnContext;
};

type BufferEntry = DmBufferEntry | GroupBufferEntry;

function dmDebounceKey(accountId: string, employeeCode: string, threadId?: string): string {
	return threadId
		? `${accountId}:dm:${employeeCode}:t:${threadId}`
		: `${accountId}:dm:${employeeCode}`;
}

function groupDebounceKey(
	accountId: string,
	groupId: string,
	employeeCode: string,
	threadId?: string,
): string {
	return threadId
		? `${accountId}:grp:${groupId}:${employeeCode}:t:${threadId}`
		: `${accountId}:grp:${groupId}:${employeeCode}`;
}

type InboundDebouncer = { enqueue: (item: BufferEntry) => Promise<void> };

let inboundDebouncer: InboundDebouncer | undefined;

function getInboundDebouncer(): InboundDebouncer {
	if (inboundDebouncer) return inboundDebouncer;
	const core = getSeatalkRuntime();
	inboundDebouncer = core.channel.debounce.createInboundDebouncer<BufferEntry>({
		debounceMs: PLUGIN_DEBOUNCE_DEFAULT_MS,
		resolveDebounceMs: (entry) => {
			const ms = core.channel.debounce.resolveInboundDebounceMs({
				cfg: entry.ctx.cfg,
				channel: "seatalk",
			});
			return ms > 0 ? ms : PLUGIN_DEBOUNCE_DEFAULT_MS;
		},
		buildKey: (entry) =>
			entry.kind === "dm"
				? dmDebounceKey(
						entry.ctx.accountId,
						entry.parsedEvent.employee_code,
						entry.parsedEvent.message.thread_id,
					)
				: groupDebounceKey(
						entry.ctx.accountId,
						entry.groupId,
						entry.groupEvent.message.sender.employee_code,
						entry.groupEvent.message.thread_id,
					),
		onFlush: async (entries) => {
			const first = entries[0];
			if (!first) return;
			if (first.kind === "dm") {
				await processBufferedDmEvents(entries as DmBufferEntry[]);
			} else {
				await processBufferedGroupEvents(entries as GroupBufferEntry[]);
			}
		},
		onError: (err) => {
			logger("inbound").error("debounce flush failed", { err: String(err) });
		},
	});
	return inboundDebouncer;
}

export async function handleSeaTalkMessage(params: {
	cfg: OpenClawConfig;
	event: SeaTalkCallbackRequest;
	client: SeaTalkClient;
	runtime?: RuntimeEnv;
	accountId: string;
}): Promise<void> {
	const { cfg, event, client, runtime, accountId } = params;
	const log = logger("inbound");

	if (!tryRecordEvent(`${accountId}:${event.event_id}`)) {
		log.info("duplicate event skipped", { accountId, eventId: event.event_id });
		return;
	}

	const msgEvent = event.event as unknown as SeaTalkMessageEvent;
	if (!msgEvent?.employee_code || !msgEvent?.message) {
		log.warn("malformed dm event", { accountId });
		return;
	}

	log.info("dm received", {
		accountId,
		employeeCode: msgEvent.employee_code,
		tag: msgEvent.message.tag,
		threadId: msgEvent.message.thread_id,
	});

	await getInboundDebouncer().enqueue({
		kind: "dm",
		event,
		parsedEvent: msgEvent,
		ctx: { cfg, client, runtime, accountId },
	});
}

export async function handleSeaTalkGroupMessage(params: {
	cfg: OpenClawConfig;
	event: SeaTalkCallbackRequest;
	client: SeaTalkClient;
	runtime?: RuntimeEnv;
	accountId: string;
}): Promise<void> {
	const { cfg, event, client, runtime, accountId } = params;
	const log = logger("inbound");

	if (!tryRecordEvent(`${accountId}:${event.event_id}`)) {
		log.info("duplicate group event skipped", { accountId, eventId: event.event_id });
		return;
	}

	const groupEvent = event.event as unknown as SeaTalkGroupMessageEvent;
	const groupId = groupEvent?.group_id;
	const msg = groupEvent?.message;
	const sender = msg?.sender;

	if (!groupId || !msg || !sender?.employee_code) {
		log.warn("malformed group event", { accountId });
		return;
	}

	if (sender.sender_type === 2) {
		log.info("ignoring bot self message", { accountId, groupId });
		return;
	}

	const employeeCode = sender.employee_code;
	const senderEmail = sender.email;
	const threadId = msg.thread_id;

	log.info("group received", {
		accountId,
		groupId,
		employeeCode,
		tag: msg.tag,
		eventType: event.event_type,
		threadId,
	});

	const account = resolveSeaTalkAccount({ cfg, accountId });
	const seatalkCfg = account.config;

	const access = checkGroupAccess({
		groupPolicy: seatalkCfg?.groupPolicy ?? "disabled",
		groupAllowFrom: seatalkCfg?.groupAllowFrom,
		groupSenderAllowFrom: seatalkCfg?.groupSenderAllowFrom,
		groupId,
		senderEmployeeCode: employeeCode,
		senderEmail,
	});

	if (!access.allowed) {
		log.warn("group access denied", {
			accountId,
			groupId,
			employeeCode,
			reason: access.reason,
		});
		return;
	}

	await getInboundDebouncer().enqueue({
		kind: "group",
		event,
		groupEvent,
		groupId,
		eventType: event.event_type,
		ctx: { cfg, client, runtime, accountId },
	});
}

function mediaKind(media: SeaTalkMediaInfo): InboundMediaFacts["kind"] {
	if (media.placeholder.includes("image")) return "image";
	if (media.placeholder.includes("video")) return "video";
	return "document";
}

function toInboundMediaFacts(mediaList: SeaTalkMediaInfo[]): InboundMediaFacts[] {
	return mediaList.map((media) => ({
		path: media.path,
		contentType: media.contentType,
		kind: mediaKind(media),
	}));
}

function buildSeaTalkDelivery(params: {
	client: SeaTalkClient;
	to: string;
	threadId?: string;
	isGroup: boolean;
	chunkText: (text: string, limit: number) => string[];
	log: ReturnType<typeof logger>;
	accountId: string;
}): SeaTalkDelivery {
	const { client, to, threadId, isGroup, chunkText, log, accountId } = params;
	const sendText = (text: string) =>
		isGroup
			? sendGroupTextMessage(client, to, text, 1, threadId)
			: sendTextMessage(client, to, text, 1, threadId);
	return {
		deliver: async (payload) => {
			const reply = resolveSendableOutboundReplyParts(payload);
			if (!reply.hasText && !reply.hasMedia) return;

			if (reply.hasText) {
				log.info("inline deliver", { accountId, to, threadId, kind: "text" });
				for (const chunk of chunkText(reply.trimmedText, SEATALK_TEXT_CHUNK_LIMIT)) {
					await sendText(chunk);
				}
			}

			if (reply.hasMedia) {
				log.info("inline deliver", {
					accountId,
					to,
					threadId,
					kind: "media",
					count: reply.mediaUrls.length,
				});
				await deliverMediaReplies({
					mediaUrls: reply.mediaUrls,
					client,
					to,
					threadId,
					isGroup,
				});
			}
		},
	};
}

async function dispatchSeaTalkTurn(params: {
	ctx: TurnContext;
	chatType: "direct" | "group";
	peerId: string;
	from: string;
	to: string;
	senderId: string;
	senderName: string;
	messageId: string;
	threadId?: string;
	wasMentioned: boolean;
	timestampMs: number;
	messageText: string;
	mediaList: SeaTalkMediaInfo[];
	useThreadSession: boolean;
	metadata: Record<string, string>;
}): Promise<void> {
	const { cfg, client, accountId } = params.ctx;
	const log = logger("inbound");
	const core = getSeatalkRuntime();
	const isGroup = params.chatType === "group";

	const account = resolveSeaTalkAccount({ cfg, accountId });
	const seatalkCfg = account.config;

	const route = core.channel.routing.resolveAgentRoute({
		cfg,
		channel: "seatalk",
		accountId,
		peer: { kind: params.chatType, id: params.peerId },
	});

	const threadKeys = resolveThreadSessionKeys({
		baseSessionKey: route.sessionKey,
		threadId: params.useThreadSession ? params.threadId : undefined,
		parentSessionKey:
			params.useThreadSession && (seatalkCfg?.threadInheritParent ?? true)
				? route.sessionKey
				: undefined,
	});

	const preview = params.messageText.replace(/\s+/g, " ").slice(0, 160);
	core.system.enqueueSystemEvent(
		isGroup
			? `SeaTalk[${accountId}] Group(${params.peerId}) from ${params.senderName}: ${preview}`
			: `SeaTalk[${accountId}] DM from ${params.senderName}: ${preview}`,
		{
			sessionKey: threadKeys.sessionKey,
			contextKey: isGroup
				? `seatalk:group:${params.peerId}:${params.messageId}`
				: `seatalk:message:${params.peerId}:${params.messageId}`,
		},
	);

	const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
	const envelopeBody = core.channel.reply.formatAgentEnvelope({
		channel: "SeaTalk",
		from: params.senderId,
		timestamp: new Date(params.timestampMs),
		envelope: envelopeOptions,
		body: `${params.senderName}: ${params.messageText}`,
	});

	const ctxPayload = core.channel.inbound.buildContext({
		channel: "seatalk",
		accountId,
		messageId: params.messageId,
		timestamp: params.timestampMs,
		from: params.from,
		sender: { id: params.senderId, name: params.senderName },
		conversation: {
			kind: params.chatType,
			id: params.peerId,
			threadId: params.threadId,
			routePeer: { kind: params.chatType, id: params.peerId },
		},
		route: {
			agentId: route.agentId,
			accountId: route.accountId,
			routeSessionKey: threadKeys.sessionKey,
			parentSessionKey: threadKeys.parentSessionKey,
		},
		reply: {
			to: params.to,
			originatingTo: params.to,
			messageThreadId: params.threadId,
		},
		message: {
			body: envelopeBody,
			bodyForAgent: params.messageText,
			rawBody: params.messageText,
			commandBody: params.messageText,
		},
		access: {
			commands: { authorized: true },
			mentions: { canDetectMention: isGroup, wasMentioned: params.wasMentioned },
		},
		media: params.mediaList.length > 0 ? toInboundMediaFacts(params.mediaList) : undefined,
		extra: Object.keys(params.metadata).length > 0 ? { Metadata: params.metadata } : undefined,
	});

	const processingIndicator = seatalkCfg?.processingIndicator ?? "typing";
	const chunkText = (text: string, limit: number) =>
		core.channel.text.chunkMarkdownText(text, limit);

	const { onModelSelected, ...replyPipeline } = createChannelMessageReplyPipeline({
		cfg,
		agentId: route.agentId,
		channel: "seatalk",
		accountId,
		typing:
			processingIndicator === "typing"
				? {
						start: () =>
							isGroup
								? client.setGroupChatTyping(params.peerId, params.threadId)
								: client.setSingleChatTyping(params.peerId, params.threadId),
						onStartError: (err) =>
							log.warn("typing failed", {
								accountId,
								to: params.to,
								err: String(err),
							}),
						keepaliveIntervalMs: TYPING_KEEPALIVE_MS,
						maxDurationMs: 0,
					}
				: undefined,
	});

	const turn: AssembledInboundReply = {
		cfg,
		channel: "seatalk",
		accountId,
		agentId: route.agentId,
		routeSessionKey: threadKeys.sessionKey,
		storePath: resolveStorePath(undefined, { agentId: route.agentId }),
		ctxPayload,
		recordInboundSession: core.channel.session.recordInboundSession,
		dispatchReplyWithBufferedBlockDispatcher:
			core.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
		delivery: buildSeaTalkDelivery({
			client,
			to: params.peerId,
			threadId: params.threadId,
			isGroup,
			chunkText,
			log: logger("outbound"),
			accountId,
		}),
		replyPipeline,
		replyOptions: { onModelSelected, disableBlockStreaming: true },
		record: {
			onRecordError: (err) =>
				log.warn("record session failed", { accountId, err: String(err) }),
		},
		messageId: params.messageId,
	};

	log.info("dispatching to agent", {
		accountId,
		to: params.to,
		sessionKey: threadKeys.sessionKey,
	});

	const result = await core.channel.inbound.dispatchReply(turn);

	log.info("dispatch complete", {
		accountId,
		to: params.to,
		dispatched: result.dispatched,
	});
}

async function processBufferedDmEvents(entries: DmBufferEntry[]): Promise<void> {
	const ctx = entries[0].ctx;
	const { cfg, client, accountId } = ctx;
	const log = logger("inbound");

	const first = entries[0].parsedEvent;
	const employeeCode = first.employee_code;
	const email = first.email;

	const account = resolveSeaTalkAccount({ cfg, accountId });
	const seatalkCfg = account.config;

	const core = getSeatalkRuntime();
	const dmPolicy = seatalkCfg?.dmPolicy ?? "allowlist";
	const configAllowFrom = (seatalkCfg?.allowFrom ?? []).map((v) => String(v));

	const pairing = createChannelPairingController({ core, channel: "seatalk", accountId });
	const storeAllowFrom =
		dmPolicy === "pairing" ? await pairing.readAllowFromStore().catch(() => []) : [];

	const accessDecision = resolveDmGroupAccessWithLists({
		isGroup: false,
		dmPolicy,
		groupPolicy: "disabled",
		allowFrom: configAllowFrom,
		groupAllowFrom: [],
		storeAllowFrom,
		isSenderAllowed: (list) => isSeaTalkSenderAllowed(employeeCode, email, list),
	});

	if (accessDecision.decision === "pairing") {
		const result = await pairing.issueChallenge({
			senderId: employeeCode,
			senderIdLine: `Your SeaTalk employee code: ${employeeCode}`,
			meta: email ? { email } : undefined,
			onCreated: ({ code }) => {
				log.info("pairing challenge issued", { accountId, employeeCode, code });
			},
			sendPairingReply: async (text) => {
				await sendTextMessage(client, employeeCode, text, 1, first.message.thread_id);
			},
			onReplyError: (err) => {
				log.warn("pairing reply failed", { accountId, employeeCode, err: String(err) });
			},
		});
		if (!result.created) {
			log.info("pairing pending", { accountId, employeeCode });
		}
		return;
	}

	if (accessDecision.decision !== "allow") {
		const reason =
			accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.DM_POLICY_DISABLED
				? "dm policy disabled"
				: "sender not in allowlist";
		log.warn("dm access denied", { accountId, employeeCode, reason });
		return;
	}

	const mediaAllowHosts = seatalkCfg?.mediaAllowHosts;
	const resolveCtx: MessageResolveContext = { client, mediaAllowHosts };

	const textParts: string[] = [];
	const mediaList: SeaTalkMediaInfo[] = [];

	for (const { parsedEvent } of entries) {
		const msg = parsedEvent.message;
		switch (msg.tag) {
			case "text":
				if (msg.text?.plain_text || msg.text?.content)
					textParts.push(msg.text.plain_text ?? msg.text.content ?? "");
				break;
			case "image":
			case "file":
			case "video": {
				const media = await resolveInboundMedia({ message: msg, client, mediaAllowHosts });
				if (media) mediaList.push(media);
				break;
			}
			case "combined_forwarded_chat_history": {
				const fwd = msg.combined_forwarded_chat_history?.content;
				if (fwd) {
					const result = await resolveForwardedMessages(fwd, resolveCtx);
					mediaList.push(...result.media);
					textParts.push(
						result.lines.length > 0
							? `[Forwarded messages]\n${result.lines.join("\n")}`
							: "[Forwarded messages]",
					);
				}
				break;
			}
		}
	}

	const seenQuotedIds = new Set<string>();
	const quotedTexts: string[] = [];
	for (const { parsedEvent } of entries) {
		const qid = parsedEvent.message.quoted_message_id;
		if (!qid || seenQuotedIds.has(qid)) continue;
		seenQuotedIds.add(qid);
		const quoted = await resolveQuotedMessage({
			client,
			quotedMessageId: qid,
			mediaAllowHosts,
		});
		if (quoted) {
			quotedTexts.push(quoted.text);
			mediaList.push(...quoted.media);
		}
	}

	let messageText = textParts.join("\n");
	if (quotedTexts.length > 0) {
		const quotedBlock = quotedTexts.join("\n");
		messageText = messageText ? `${quotedBlock}\n${messageText}` : quotedBlock;
	}
	if (!messageText && mediaList.length > 0) {
		messageText = mediaList.map((m) => m.placeholder).join(" ");
	}
	if (!messageText && mediaList.length === 0) {
		log.info("dm empty, skipping", { accountId, employeeCode });
		return;
	}

	const senderName = employeeCode + (email ? ` (${email})` : "");
	const messageId = first.message.message_id;
	const threadId = first.message.thread_id;
	const eventTimestamp = entries[0].event.timestamp;

	const metadata: Record<string, string> = {};
	if (threadId) metadata.threadId = threadId;
	const firstQuotedId = first.message.quoted_message_id;
	if (firstQuotedId) metadata.quotedMessageId = firstQuotedId;

	try {
		await dispatchSeaTalkTurn({
			ctx,
			chatType: "direct",
			peerId: employeeCode,
			from: `seatalk:${employeeCode}`,
			to: employeeCode,
			senderId: employeeCode,
			senderName,
			messageId,
			threadId,
			wasMentioned: false,
			timestampMs: eventTimestamp ? eventTimestamp * 1000 : Date.now(),
			messageText,
			mediaList,
			useThreadSession: (seatalkCfg?.dmThreadSession ?? true) && Boolean(threadId),
			metadata,
		});
	} catch (err) {
		log.error("dm dispatch failed", { accountId, employeeCode, err: String(err) });
	}
}

async function processBufferedGroupEvents(entries: GroupBufferEntry[]): Promise<void> {
	const ctx = entries[0].ctx;
	const { cfg, client, accountId } = ctx;
	const log = logger("inbound");

	const first = entries[0];
	const groupId = first.groupId;
	const msg = first.groupEvent.message;
	const sender = msg.sender;
	const employeeCode = sender.employee_code;
	const senderEmail = sender.email;
	const threadId = msg.thread_id;

	const account = resolveSeaTalkAccount({ cfg, accountId });
	const seatalkCfg = account.config;
	const mediaAllowHosts = seatalkCfg?.mediaAllowHosts;
	const resolveCtx: MessageResolveContext = { client, mediaAllowHosts };

	const textParts: string[] = [];
	const mediaList: SeaTalkMediaInfo[] = [];

	for (const { groupEvent } of entries) {
		const m = groupEvent.message;
		switch (m.tag) {
			case "text":
				if (m.text?.plain_text || m.text?.content)
					textParts.push(m.text.plain_text ?? m.text.content ?? "");
				break;
			case "image":
			case "file":
			case "video": {
				const media = await resolveInboundMedia({ message: m, client, mediaAllowHosts });
				if (media) mediaList.push(media);
				break;
			}
			case "combined_forwarded_chat_history": {
				const fwd = m.combined_forwarded_chat_history?.content;
				if (fwd) {
					const result = await resolveForwardedMessages(fwd, resolveCtx);
					mediaList.push(...result.media);
					textParts.push(
						result.lines.length > 0
							? `[Forwarded messages]\n${result.lines.join("\n")}`
							: "[Forwarded messages]",
					);
				}
				break;
			}
		}
	}

	const quotedMessageId = first.groupEvent.message.quoted_message_id;
	let quotedText: string | null = null;
	if (quotedMessageId) {
		const quoted = await resolveQuotedMessage({
			client,
			quotedMessageId,
			mediaAllowHosts,
		});
		if (quoted) {
			quotedText = quoted.text;
			mediaList.push(...quoted.media);
		}
	}

	let messageText = textParts.join("\n");
	if (quotedText) {
		messageText = messageText ? `${quotedText}\n${messageText}` : quotedText;
	}
	if (!messageText && mediaList.length > 0) {
		messageText = mediaList.map((m) => m.placeholder).join(" ");
	}
	if (!messageText && mediaList.length === 0) {
		log.info("group empty, skipping", { accountId, groupId, employeeCode });
		return;
	}

	const senderName = employeeCode + (senderEmail ? ` (${senderEmail})` : "");
	const messageId = msg.message_id;
	const wasMentioned = entries.some(
		(e) => e.eventType === "new_mentioned_message_received_from_group_chat",
	);
	const sentAt = first.groupEvent.message.message_sent_time;

	const metadata: Record<string, string> = { groupId };
	if (threadId) metadata.threadId = threadId;
	if (quotedMessageId) metadata.quotedMessageId = quotedMessageId;

	try {
		await dispatchSeaTalkTurn({
			ctx,
			chatType: "group",
			peerId: groupId,
			from: `seatalk:${employeeCode}`,
			to: groupId,
			senderId: employeeCode,
			senderName,
			messageId,
			threadId,
			wasMentioned,
			timestampMs: sentAt ? sentAt * 1000 : Date.now(),
			messageText,
			mediaList,
			useThreadSession: (seatalkCfg?.groupThreadSession ?? true) && Boolean(threadId),
			metadata,
		});
	} catch (err) {
		log.error("group dispatch failed", { accountId, groupId, err: String(err) });
	}
}
