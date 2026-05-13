import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import {
	DM_GROUP_ACCESS_REASON,
	resolveDmGroupAccessWithLists,
} from "openclaw/plugin-sdk/channel-policy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
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
import { buildSeaTalkMediaPayload, resolveInboundMedia } from "./media.js";
import { createOutboundCoalescer } from "./outbound-coalescer.js";
import { getSeatalkRuntime } from "./runtime.js";
import { sendGroupTextMessage, sendTextMessage } from "./send.js";
import type {
	SeaTalkCallbackRequest,
	SeaTalkGroupMessageEvent,
	SeaTalkMediaInfo,
	SeaTalkMessage,
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

const DEBOUNCE_SLIDE_MS = 1500;
const DEBOUNCE_HARD_CAP_MS = 5000;

const SEATALK_TEXT_CHUNK_LIMIT = 4000;
const OUTBOUND_COALESCE_IDLE_MS = 1000;

type DmBufferEntry = {
	kind: "dm";
	event: SeaTalkCallbackRequest;
	parsedEvent: SeaTalkMessageEvent;
};

type GroupBufferEntry = {
	kind: "group";
	event: SeaTalkCallbackRequest;
	groupEvent: SeaTalkGroupMessageEvent;
	groupId: string;
	eventType: string;
};

type BufferEntry = DmBufferEntry | GroupBufferEntry;

type DebounceState = {
	entries: BufferEntry[];
	timer: ReturnType<typeof setTimeout>;
	firstEventAt: number;
	context: DebounceContext;
};

type DebounceContext = {
	cfg: OpenClawConfig;
	client: SeaTalkClient;
	runtime?: RuntimeEnv;
	accountId: string;
};

const debounceBuffers = new Map<string, DebounceState>();

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

function scheduleFlush(key: string, state: DebounceState): void {
	clearTimeout(state.timer);

	const elapsed = Date.now() - state.firstEventAt;
	const remaining = DEBOUNCE_HARD_CAP_MS - elapsed;

	if (remaining <= 0) {
		flushBuffer(key);
		return;
	}

	const delay = Math.min(DEBOUNCE_SLIDE_MS, remaining);
	state.timer = setTimeout(() => flushBuffer(key), delay);
}

function flushBuffer(key: string): void {
	const state = debounceBuffers.get(key);
	if (!state) return;
	debounceBuffers.delete(key);

	const entries = state.entries;
	if (entries.length === 0) return;

	const first = entries[0];
	if (first.kind === "dm") {
		const dmEntries = entries as DmBufferEntry[];
		processBufferedDmEvents(dmEntries, state.context).catch((err) => {
			logger("inbound").error("dm flush failed", {
				accountId: state.context.accountId,
				err: String(err),
			});
		});
	} else {
		const groupEntries = entries as GroupBufferEntry[];
		processBufferedGroupEvents(groupEntries, state.context).catch((err) => {
			logger("inbound").error("group flush failed", {
				accountId: state.context.accountId,
				err: String(err),
			});
		});
	}
}

function pushToBuffer(key: string, entry: BufferEntry, context: DebounceContext): void {
	let state = debounceBuffers.get(key);
	if (!state) {
		state = {
			entries: [],
			timer: setTimeout(() => flushBuffer(key), DEBOUNCE_SLIDE_MS),
			firstEventAt: Date.now(),
			context,
		};
		debounceBuffers.set(key, state);
	}

	state.entries.push(entry);
	scheduleFlush(key, state);
}

async function processBufferedDmEvents(
	entries: DmBufferEntry[],
	context: DebounceContext,
): Promise<void> {
	const { cfg, client, accountId } = context;
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
				const media = await resolveInboundMedia({
					message: msg,
					client,
					mediaAllowHosts,
				});
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

	const mediaPayload = buildSeaTalkMediaPayload(mediaList);

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

	try {
		const seatalkFrom = `seatalk:${employeeCode}`;
		const seatalkTo = employeeCode;

		const route = core.channel.routing.resolveAgentRoute({
			cfg,
			channel: "seatalk",
			accountId,
			peer: {
				kind: "direct",
				id: employeeCode,
			},
		});

		const useThreadSession = (seatalkCfg?.dmThreadSession ?? true) && Boolean(threadId);
		const threadKeys = resolveThreadSessionKeys({
			baseSessionKey: route.sessionKey,
			threadId: useThreadSession ? threadId : undefined,
			parentSessionKey:
				useThreadSession && (seatalkCfg?.threadInheritParent ?? true)
					? route.sessionKey
					: undefined,
		});

		const preview = messageText.replace(/\s+/g, " ").slice(0, 160);
		core.system.enqueueSystemEvent(`SeaTalk[${accountId}] DM from ${senderName}: ${preview}`, {
			sessionKey: threadKeys.sessionKey,
			contextKey: `seatalk:message:${employeeCode}:${messageId}`,
		});

		const eventTimestamp = entries[0].event.timestamp;
		const messageTimestamp = eventTimestamp ? new Date(eventTimestamp * 1000) : new Date();

		const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
		const bodyForAgent = `${senderName}: ${messageText}`;

		const body = core.channel.reply.formatAgentEnvelope({
			channel: "SeaTalk",
			from: employeeCode,
			timestamp: messageTimestamp,
			envelope: envelopeOptions,
			body: bodyForAgent,
		});

		const metadata: Record<string, string> = {};
		if (threadId) metadata.threadId = threadId;
		const firstQuotedId = first.message.quoted_message_id;
		if (firstQuotedId) metadata.quotedMessageId = firstQuotedId;

		const ctxPayload = core.channel.reply.finalizeInboundContext({
			Body: body,
			BodyForAgent: messageText,
			RawBody: messageText,
			CommandBody: messageText,
			From: seatalkFrom,
			To: seatalkTo,
			SessionKey: threadKeys.sessionKey,
			ParentSessionKey: threadKeys.parentSessionKey,
			AccountId: route.accountId,
			ChatType: "direct" as const,
			SenderName: senderName,
			SenderId: employeeCode,
			Provider: "seatalk" as const,
			Surface: "seatalk" as const,
			MessageSid: messageId,
			MessageThreadId: threadId || undefined,
			Timestamp: eventTimestamp ? eventTimestamp * 1000 : Date.now(),
			WasMentioned: false,
			CommandAuthorized: true,
			OriginatingChannel: "seatalk" as const,
			OriginatingTo: seatalkTo,
			...(Object.keys(metadata).length > 0 ? { Metadata: metadata } : {}),
			...mediaPayload,
		});

		const processingIndicator = account.config?.processingIndicator ?? "typing";
		if (processingIndicator === "typing") {
			client
				.setSingleChatTyping(employeeCode, threadId)
				.catch((err) =>
					log.warn("dm typing failed", { accountId, employeeCode, err: String(err) }),
				);
		}

		const coalescingEnabled = seatalkCfg?.outboundCoalescing !== false;
		const sendDmText = (text: string) =>
			sendTextMessage(client, employeeCode, text, 1, threadId);
		const chunkText = (text: string, limit: number) =>
			core.channel.text.chunkMarkdownText(text, limit);
		const coalescer = coalescingEnabled
			? createOutboundCoalescer({
					send: sendDmText,
					chunkText,
					maxLength: SEATALK_TEXT_CHUNK_LIMIT,
					joiner: "\n\n",
					idleFlushMs: OUTBOUND_COALESCE_IDLE_MS,
				})
			: null;

		const out = logger("outbound");
		const typingResult = core.channel.reply.createReplyDispatcherWithTyping({
			humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
			deliver: async (payload) => {
				const reply = resolveSendableOutboundReplyParts(payload);
				if (!reply.hasText && !reply.hasMedia) return;

				if (reply.hasText) {
					out.info("dm inline deliver", {
						accountId,
						employeeCode,
						threadId,
						kind: "text",
					});
					if (coalescer) {
						coalescer.append(reply.trimmedText);
					} else {
						const chunks = chunkText(reply.trimmedText, SEATALK_TEXT_CHUNK_LIMIT);
						for (const chunk of chunks) {
							await sendDmText(chunk);
						}
					}
				}

				if (reply.hasMedia) {
					out.info("dm inline deliver", {
						accountId,
						employeeCode,
						threadId,
						kind: "media",
						count: reply.mediaUrls.length,
					});
					if (coalescer) await coalescer.flush();
					await deliverMediaReplies({
						mediaUrls: reply.mediaUrls,
						client,
						to: employeeCode,
						threadId,
						isGroup: false,
					});
				}
			},
			onError: (err) => {
				out.error("dm reply delivery failed", {
					accountId,
					employeeCode,
					err: String(err),
				});
			},
		});

		const replyOptions = {
			agentId: route.agentId,
			...typingResult.replyOptions,
		};

		log.info("dm dispatching to agent", {
			accountId,
			employeeCode,
			sessionKey: threadKeys.sessionKey,
		});

		try {
			const { queuedFinal, counts } = await core.channel.reply.dispatchReplyFromConfig({
				ctx: ctxPayload,
				cfg,
				dispatcher: typingResult.dispatcher,
				replyOptions,
			});

			log.info("dm dispatch complete", {
				accountId,
				employeeCode,
				queuedFinal,
				counts,
			});
		} finally {
			typingResult.markDispatchIdle();
			if (coalescer) {
				await typingResult.dispatcher.waitForIdle();
				await coalescer.flush();
			}
		}
	} catch (err) {
		log.error("dm dispatch failed", { accountId, employeeCode, err: String(err) });
	}
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

	const key = dmDebounceKey(accountId, msgEvent.employee_code, msgEvent.message.thread_id);
	pushToBuffer(
		key,
		{ kind: "dm", event, parsedEvent: msgEvent },
		{ cfg, client, runtime, accountId },
	);
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

	const key = groupDebounceKey(accountId, groupId, employeeCode, threadId);
	pushToBuffer(
		key,
		{ kind: "group", event, groupEvent, groupId, eventType: event.event_type },
		{ cfg, client, runtime, accountId },
	);
}

async function processBufferedGroupEvents(
	entries: GroupBufferEntry[],
	context: DebounceContext,
): Promise<void> {
	const { cfg, client, accountId } = context;
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
				const media = await resolveInboundMedia({
					message: m,
					client,
					mediaAllowHosts,
				});
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

	const mediaPayload = buildSeaTalkMediaPayload(mediaList);

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

	try {
		const core = getSeatalkRuntime();

		const route = core.channel.routing.resolveAgentRoute({
			cfg,
			channel: "seatalk",
			accountId,
			peer: {
				kind: "group",
				id: groupId,
			},
		});

		const useThreadSession = (seatalkCfg?.groupThreadSession ?? true) && Boolean(threadId);
		const threadKeys = resolveThreadSessionKeys({
			baseSessionKey: route.sessionKey,
			threadId: useThreadSession ? threadId : undefined,
			parentSessionKey:
				useThreadSession && (seatalkCfg?.threadInheritParent ?? true)
					? route.sessionKey
					: undefined,
		});

		const preview = messageText.replace(/\s+/g, " ").slice(0, 160);
		core.system.enqueueSystemEvent(
			`SeaTalk[${accountId}] Group(${groupId}) from ${senderName}: ${preview}`,
			{
				sessionKey: threadKeys.sessionKey,
				contextKey: `seatalk:group:${groupId}:${messageId}`,
			},
		);

		const sentAt = first.groupEvent.message.message_sent_time;
		const messageTimestamp = sentAt ? new Date(sentAt * 1000) : new Date();

		const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
		const body = core.channel.reply.formatAgentEnvelope({
			channel: "SeaTalk",
			from: employeeCode,
			timestamp: messageTimestamp,
			envelope: envelopeOptions,
			body: `${senderName}: ${messageText}`,
		});

		const metadata: Record<string, string> = { groupId };
		if (threadId) metadata.threadId = threadId;
		if (quotedMessageId) metadata.quotedMessageId = quotedMessageId;

		const ctxPayload = core.channel.reply.finalizeInboundContext({
			Body: body,
			BodyForAgent: messageText,
			RawBody: messageText,
			CommandBody: messageText,
			From: `seatalk:${employeeCode}`,
			To: `group:${groupId}`,
			SessionKey: threadKeys.sessionKey,
			ParentSessionKey: threadKeys.parentSessionKey,
			AccountId: route.accountId,
			ChatType: "group" as const,
			SenderName: senderName,
			SenderId: employeeCode,
			Provider: "seatalk" as const,
			Surface: "seatalk" as const,
			MessageSid: messageId,
			MessageThreadId: threadId || undefined,
			Timestamp: sentAt ? sentAt * 1000 : Date.now(),
			WasMentioned: wasMentioned,
			CommandAuthorized: true,
			OriginatingChannel: "seatalk" as const,
			OriginatingTo: `group:${groupId}`,
			Metadata: metadata,
			...mediaPayload,
		});

		const processingIndicator = seatalkCfg?.processingIndicator ?? "typing";
		if (processingIndicator === "typing") {
			client
				.setGroupChatTyping(groupId, threadId)
				.catch((err) =>
					log.warn("group typing failed", { accountId, groupId, err: String(err) }),
				);
		}

		const replyThreadId = threadId || undefined;

		const groupCoalescingEnabled = seatalkCfg?.outboundCoalescing !== false;
		const sendGroupText = (text: string) =>
			sendGroupTextMessage(client, groupId, text, 1, replyThreadId);
		const chunkGroupText = (text: string, limit: number) =>
			core.channel.text.chunkMarkdownText(text, limit);
		const groupCoalescer = groupCoalescingEnabled
			? createOutboundCoalescer({
					send: sendGroupText,
					chunkText: chunkGroupText,
					maxLength: SEATALK_TEXT_CHUNK_LIMIT,
					joiner: "\n\n",
					idleFlushMs: OUTBOUND_COALESCE_IDLE_MS,
				})
			: null;

		const out = logger("outbound");
		const typingResult = core.channel.reply.createReplyDispatcherWithTyping({
			humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
			deliver: async (payload) => {
				const reply = resolveSendableOutboundReplyParts(payload);
				if (!reply.hasText && !reply.hasMedia) return;

				if (reply.hasText) {
					out.info("group inline deliver", {
						accountId,
						groupId,
						threadId: replyThreadId,
						kind: "text",
					});
					if (groupCoalescer) {
						groupCoalescer.append(reply.trimmedText);
					} else {
						const chunks = chunkGroupText(reply.trimmedText, SEATALK_TEXT_CHUNK_LIMIT);
						for (const chunk of chunks) {
							await sendGroupText(chunk);
						}
					}
				}

				if (reply.hasMedia) {
					out.info("group inline deliver", {
						accountId,
						groupId,
						threadId: replyThreadId,
						kind: "media",
						count: reply.mediaUrls.length,
					});
					if (groupCoalescer) await groupCoalescer.flush();
					await deliverMediaReplies({
						mediaUrls: reply.mediaUrls,
						client,
						to: groupId,
						threadId: replyThreadId,
						isGroup: true,
					});
				}
			},
			onError: (err) => {
				out.error("group reply delivery failed", { accountId, groupId, err: String(err) });
			},
		});

		const replyOptions = {
			agentId: route.agentId,
			...typingResult.replyOptions,
		};

		log.info("group dispatching to agent", {
			accountId,
			groupId,
			sessionKey: threadKeys.sessionKey,
		});

		try {
			const { queuedFinal, counts } = await core.channel.reply.dispatchReplyFromConfig({
				ctx: ctxPayload,
				cfg,
				dispatcher: typingResult.dispatcher,
				replyOptions,
			});

			log.info("group dispatch complete", {
				accountId,
				groupId,
				queuedFinal,
				counts,
			});
		} finally {
			typingResult.markDispatchIdle();
			if (groupCoalescer) {
				await typingResult.dispatcher.waitForIdle();
				await groupCoalescer.flush();
			}
		}
	} catch (err) {
		log.error("group dispatch failed", { accountId, groupId, err: String(err) });
	}
}
