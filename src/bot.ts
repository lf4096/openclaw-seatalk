import { type ClawdbotConfig, type RuntimeEnv, normalizeAccountId } from "openclaw/plugin-sdk";
import { resolveSeaTalkAccount } from "./accounts.js";
import type { SeaTalkClient } from "./client.js";
import { buildSeaTalkMediaPayload, resolveInboundMedia } from "./media.js";
import { getSeatalkRuntime } from "./runtime.js";
import { sendGroupTextMessage, sendTextMessage } from "./send.js";
import type {
	SeaTalkCallbackRequest,
	SeaTalkGroupMessageEvent,
	SeaTalkMediaInfo,
	SeaTalkMessage,
	SeaTalkMessageEvent,
} from "./types.js";

function isSeaTalkDmSenderAllowed(
	employeeCode: string,
	email: string | undefined,
	allowFrom: string[],
): boolean {
	if (allowFrom.length === 0) return false;
	return allowFrom.some((entry) => {
		const e = entry.trim();
		if (e === "*") return true;
		if (e === employeeCode) return true;
		if (email && e.toLowerCase() === email.toLowerCase()) return true;
		return false;
	});
}

/** Mirrors OpenClaw mergeDmAllowFromSources (pairing store is ignored when dmPolicy=allowlist). */
function mergeDmAllowFromForSeatalk(params: {
	allowFrom?: string[];
	storeAllowFrom?: string[];
	dmPolicy: string;
}): string[] {
	const storeEntries = params.dmPolicy === "allowlist" ? [] : (params.storeAllowFrom ?? []);
	return [...(params.allowFrom ?? []), ...storeEntries]
		.map((value) => String(value).trim())
		.filter(Boolean);
}

function resolveSeaTalkDmAccess(params: {
	dmPolicy: string;
	configAllowFrom: string[];
	storeAllowFrom: string[];
	employeeCode: string;
	email: string | undefined;
}): { decision: "allow" | "block" | "pairing"; reason?: string } {
	const effectiveAllowFrom = mergeDmAllowFromForSeatalk({
		allowFrom: params.configAllowFrom,
		storeAllowFrom: params.storeAllowFrom,
		dmPolicy: params.dmPolicy,
	});
	const match = (list: string[]) =>
		isSeaTalkDmSenderAllowed(params.employeeCode, params.email, list);

	if (params.dmPolicy === "disabled") {
		return { decision: "block", reason: "dmPolicy=disabled" };
	}
	if (params.dmPolicy === "open") {
		return { decision: "allow" };
	}
	if (match(effectiveAllowFrom)) {
		return { decision: "allow" };
	}
	if (params.dmPolicy === "pairing") {
		return { decision: "pairing" };
	}
	return { decision: "block", reason: "not allowlisted" };
}

async function issueSeaTalkPairingChallenge(params: {
	core: ReturnType<typeof getSeatalkRuntime>;
	accountId: string;
	employeeCode: string;
	email: string | undefined;
	client: SeaTalkClient;
	threadId: string | undefined;
	log: (msg: string) => void;
}): Promise<void> {
	const { code, created } = await params.core.channel.pairing.upsertPairingRequest({
		channel: "seatalk",
		accountId: normalizeAccountId(params.accountId),
		id: params.employeeCode,
		meta: params.email ? { email: params.email } : undefined,
	});
	if (!created) {
		params.log(
			`seatalk[${params.accountId}]: pairing already pending for ${params.employeeCode} (no duplicate code message; use openclaw pairing pending seatalk)`,
		);
		return;
	}
	const replyText = [
		"OpenClaw: access not configured.",
		"",
		`Your SeaTalk employee code: ${params.employeeCode}`,
		"",
		`Pairing code: ${code}`,
		"",
		"Ask the bot owner to approve with:",
		`openclaw pairing approve seatalk ${code}`,
	].join("\n");
	params.log(
		`seatalk[${params.accountId}]: pairing request sender=${params.employeeCode} code=${code}`,
	);
	try {
		await sendTextMessage(params.client, params.employeeCode, replyText, 1, params.threadId);
	} catch (err) {
		params.log(
			`seatalk[${params.accountId}]: pairing reply failed for ${params.employeeCode}: ${String(err)}`,
		);
	}
}

export function dispatchSeaTalkEvent(params: {
	cfg: ClawdbotConfig;
	event: SeaTalkCallbackRequest;
	client: SeaTalkClient;
	runtime?: RuntimeEnv;
	accountId: string;
}): void {
	const { cfg, event, client, runtime, accountId } = params;
	const log = runtime?.log ?? console.log;
	const error = runtime?.error ?? console.error;
	const handle = (fn: () => Promise<void>) =>
		fn().catch((err) => error(`seatalk[${accountId}]: event error: ${String(err)}`));

	switch (event.event_type) {
		case "message_from_bot_subscriber":
			handle(() => handleSeaTalkMessage({ cfg, event, client, runtime, accountId }));
			break;
		case "new_mentioned_message_received_from_group_chat":
		case "new_message_received_from_thread":
			handle(() => handleSeaTalkGroupMessage({ cfg, event, client, runtime, accountId }));
			break;
		case "new_bot_subscriber": {
			const ec = (event.event as { employee_code?: string })?.employee_code;
			log(`seatalk[${accountId}]: new subscriber: ${ec}`);
			break;
		}
		case "bot_added_to_group_chat": {
			const gid = (event.event as { group_id?: string })?.group_id;
			log(`seatalk[${accountId}]: bot added to group: ${gid}`);
			break;
		}
		case "bot_removed_from_group_chat": {
			const gid = (event.event as { group_id?: string })?.group_id;
			log(`seatalk[${accountId}]: bot removed from group: ${gid}`);
			break;
		}
		default:
			log(`seatalk[${accountId}]: unhandled event type: ${event.event_type}`);
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

type BufferEntry = {
	event: SeaTalkCallbackRequest;
	parsedEvent: SeaTalkMessageEvent;
};

type DebounceState = {
	entries: BufferEntry[];
	timer: ReturnType<typeof setTimeout>;
	firstEventAt: number;
	context: DebounceContext;
};

type DebounceContext = {
	cfg: ClawdbotConfig;
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

	processBufferedEvents(entries, state.context).catch((err) => {
		const error = state.context.runtime?.error ?? console.error;
		error(`seatalk[${state.context.accountId}]: flush error: ${String(err)}`);
	});
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

async function resolveQuotedMessage(params: {
	client: SeaTalkClient;
	quotedMessageId: string;
	log: (msg: string) => void;
}): Promise<{ text: string; media: SeaTalkMediaInfo[] } | null> {
	const { client, quotedMessageId, log } = params;
	try {
		const data = await client.getMessageByMessageId(quotedMessageId);
		const sender =
			(data.sender as { employee_code?: string } | undefined)?.employee_code ?? "unknown";
		const tag = data.tag as string | undefined;

		const media: SeaTalkMediaInfo[] = [];
		let content = "";

		if (tag === "text") {
			const textObj = data.text as { plain_text?: string; content?: string } | undefined;
			content = textObj?.plain_text ?? textObj?.content ?? "";
		} else if (tag === "image" || tag === "file" || tag === "video") {
			const fakeMsg: SeaTalkMessage = {
				message_id: quotedMessageId,
				tag,
				image:
					tag === "image" ? (data.image as { content: string } | undefined) : undefined,
				file:
					tag === "file"
						? (data.file as { content: string; filename: string } | undefined)
						: undefined,
				video:
					tag === "video" ? (data.video as { content: string } | undefined) : undefined,
			};
			const resolved = await resolveInboundMedia({ message: fakeMsg, client, log });
			if (resolved) {
				media.push(resolved);
				content = resolved.placeholder;
			} else {
				content = `<media:${tag}>`;
			}
		} else {
			content = `<unsupported:${tag ?? "unknown"}>`;
		}

		return { text: `[Quoted from ${sender}: ${content}]`, media };
	} catch (err) {
		log(`seatalk: failed to resolve quoted message ${quotedMessageId}: ${String(err)}`);
		return null;
	}
}

async function processBufferedEvents(
	entries: BufferEntry[],
	context: DebounceContext,
): Promise<void> {
	const { cfg, client, runtime, accountId } = context;
	const log = runtime?.log ?? console.log;
	const error = runtime?.error ?? console.error;

	const first = entries[0].parsedEvent;
	const employeeCode = first.employee_code;
	const email = first.email;

	const textParts: string[] = [];
	const mediaMessages: SeaTalkMessage[] = [];

	for (const { parsedEvent } of entries) {
		const msg = parsedEvent.message;
		switch (msg.tag) {
			case "text":
				if (msg.text?.plain_text || msg.text?.content)
					textParts.push(msg.text.plain_text ?? msg.text.content ?? "");
				break;
			case "image":
			case "file":
			case "video":
				mediaMessages.push(msg);
				break;
			case "combined_forwarded_chat_history":
				log(`seatalk[${accountId}]: skipping combined_forwarded_chat_history`);
				break;
		}
	}

	const account = resolveSeaTalkAccount({ cfg, accountId });
	const seatalkCfg = account.config;

	const dmPolicy = seatalkCfg?.dmPolicy ?? "allowlist";
	const configAllowFrom = (seatalkCfg?.allowFrom ?? []).map((v) => String(v));

	const core = getSeatalkRuntime();
	const storeAllowFrom =
		dmPolicy === "pairing"
			? await core.channel.pairing
					.readAllowFromStore({
						channel: "seatalk",
						accountId: normalizeAccountId(accountId),
					})
					.catch(() => [])
			: [];

	const accessDecision = resolveSeaTalkDmAccess({
		dmPolicy,
		configAllowFrom,
		storeAllowFrom,
		employeeCode,
		email,
	});

	if (accessDecision.decision === "pairing") {
		await issueSeaTalkPairingChallenge({
			core,
			accountId,
			employeeCode,
			email,
			client,
			threadId: first.message.thread_id,
			log,
		});
		return;
	}

	if (accessDecision.decision !== "allow") {
		if (accessDecision.reason === "not allowlisted") {
			log(`seatalk[${accountId}]: sender ${employeeCode} not in allowlist, dropping`);
		} else {
			log(
				`seatalk[${accountId}]: blocked DM from ${employeeCode} (${accessDecision.reason ?? "denied"})`,
			);
		}
		return;
	}

	const mediaList: SeaTalkMediaInfo[] = [];
	for (const msg of mediaMessages) {
		const media = await resolveInboundMedia({ message: msg, client, log });
		if (media) mediaList.push(media);
	}

	const quotedMessageId = first.message.quoted_message_id;
	let quotedText: string | null = null;
	if (quotedMessageId) {
		const quoted = await resolveQuotedMessage({ client, quotedMessageId, log });
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
		log(`seatalk[${accountId}]: skipping empty message from ${employeeCode}`);
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

		const preview = messageText.replace(/\s+/g, " ").slice(0, 160);
		core.system.enqueueSystemEvent(`SeaTalk[${accountId}] DM from ${senderName}: ${preview}`, {
			sessionKey: route.sessionKey,
			contextKey: `seatalk:message:${employeeCode}:${messageId}`,
		});

		const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
		const bodyForAgent = `${senderName}: ${messageText}`;

		const body = core.channel.reply.formatAgentEnvelope({
			channel: "SeaTalk",
			from: employeeCode,
			timestamp: new Date(),
			envelope: envelopeOptions,
			body: bodyForAgent,
		});

		const metadata: Record<string, string> = {};
		if (threadId) metadata.threadId = threadId;
		if (quotedMessageId) metadata.quotedMessageId = quotedMessageId;

		const ctxPayload = core.channel.reply.finalizeInboundContext({
			Body: body,
			BodyForAgent: messageText,
			RawBody: messageText,
			CommandBody: messageText,
			From: seatalkFrom,
			To: seatalkTo,
			SessionKey: route.sessionKey,
			AccountId: route.accountId,
			ChatType: "direct" as const,
			SenderName: senderName,
			SenderId: employeeCode,
			Provider: "seatalk" as const,
			Surface: "seatalk" as const,
			MessageSid: messageId,
			MessageThreadId: threadId || undefined,
			Timestamp: Date.now(),
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
				.catch((err) => log(`seatalk[${accountId}]: typing failed: ${String(err)}`));
		}

		const typingResult = core.channel.reply.createReplyDispatcherWithTyping({
			humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
			deliver: async (payload) => {
				const text = payload.text?.trim();
				if (text) {
					log(
						`seatalk[${accountId}]: inline deliver DM to ${employeeCode} threadId=${threadId || "none"}`,
					);
					await sendTextMessage(client, employeeCode, text, 1, threadId);
				}
			},
			onError: (err) => {
				error(`seatalk[${accountId}]: reply delivery failed: ${String(err)}`);
			},
		});

		const replyOptions = {
			agentId: route.agentId,
			...typingResult.replyOptions,
		};

		log(`seatalk[${accountId}]: dispatching to agent (session=${route.sessionKey})`);

		try {
			const { queuedFinal, counts } = await core.channel.reply.dispatchReplyFromConfig({
				ctx: ctxPayload,
				cfg,
				dispatcher: typingResult.dispatcher,
				replyOptions,
			});

			log(
				`seatalk[${accountId}]: dispatch complete (queuedFinal=${queuedFinal}, counts=${JSON.stringify(counts)})`,
			);
		} finally {
			typingResult.markDispatchIdle();
		}
	} catch (err) {
		error(`seatalk[${accountId}]: failed to dispatch message: ${String(err)}`);
	}
}

export async function handleSeaTalkMessage(params: {
	cfg: ClawdbotConfig;
	event: SeaTalkCallbackRequest;
	client: SeaTalkClient;
	runtime?: RuntimeEnv;
	accountId: string;
}): Promise<void> {
	const { cfg, event, client, runtime, accountId } = params;
	const log = runtime?.log ?? console.log;

	if (!tryRecordEvent(event.event_id)) {
		log(`seatalk[${accountId}]: skipping duplicate event ${event.event_id}`);
		return;
	}

	const msgEvent = event.event as unknown as SeaTalkMessageEvent;
	if (!msgEvent?.employee_code || !msgEvent?.message) {
		log(`seatalk[${accountId}]: malformed message event, skipping`);
		return;
	}

	log(
		`seatalk[${accountId}]: received ${msgEvent.message.tag} from ${msgEvent.employee_code} (threadId=${msgEvent.message.thread_id || "none"})`,
	);

	const key = dmDebounceKey(accountId, msgEvent.employee_code, msgEvent.message.thread_id);
	pushToBuffer(key, { event, parsedEvent: msgEvent }, { cfg, client, runtime, accountId });
}

function extractGroupText(msg: SeaTalkMessage): string {
	if (msg.tag === "text") {
		return msg.text?.plain_text ?? msg.text?.content ?? "";
	}
	return "";
}

function checkGroupAccess(params: {
	groupPolicy: string;
	groupAllowFrom?: string[];
	groupSenderAllowFrom?: string[];
	groupId: string;
	senderEmployeeCode: string;
	senderEmail?: string;
}): { allowed: boolean; reason?: string } {
	const {
		groupPolicy,
		groupAllowFrom,
		groupSenderAllowFrom,
		groupId,
		senderEmployeeCode,
		senderEmail,
	} = params;

	if (groupPolicy === "disabled") {
		return { allowed: false, reason: "groupPolicy is disabled" };
	}

	if (groupPolicy === "allowlist") {
		const list = groupAllowFrom ?? [];
		if (!list.includes(groupId)) {
			return { allowed: false, reason: `group ${groupId} not in groupAllowFrom` };
		}
	}

	if (groupSenderAllowFrom && groupSenderAllowFrom.length > 0) {
		const match = groupSenderAllowFrom.some((entry) => {
			const e = entry.trim();
			if (e === "*") return true;
			if (e === senderEmployeeCode) return true;
			if (senderEmail && e.toLowerCase() === senderEmail.toLowerCase()) return true;
			return false;
		});
		if (!match) {
			return {
				allowed: false,
				reason: `sender ${senderEmployeeCode} not in groupSenderAllowFrom`,
			};
		}
	}

	return { allowed: true };
}

export async function handleSeaTalkGroupMessage(params: {
	cfg: ClawdbotConfig;
	event: SeaTalkCallbackRequest;
	client: SeaTalkClient;
	runtime?: RuntimeEnv;
	accountId: string;
}): Promise<void> {
	const { cfg, event, client, runtime, accountId } = params;
	const log = runtime?.log ?? console.log;
	const error = runtime?.error ?? console.error;

	if (!tryRecordEvent(event.event_id)) {
		log(`seatalk[${accountId}]: skipping duplicate group event ${event.event_id}`);
		return;
	}

	const groupEvent = event.event as unknown as SeaTalkGroupMessageEvent;
	const groupId = groupEvent?.group_id;
	const msg = groupEvent?.message;
	const sender = msg?.sender;

	if (!groupId || !msg || !sender?.employee_code) {
		log(`seatalk[${accountId}]: malformed group message event, skipping`);
		return;
	}

	if (sender.sender_type === 2) {
		log(`seatalk[${accountId}]: ignoring bot message in group ${groupId}`);
		return;
	}

	const employeeCode = sender.employee_code;
	const senderEmail = sender.email;
	const threadId = msg.thread_id;

	log(
		`seatalk[${accountId}]: group ${groupId} ${msg.tag} from ${employeeCode} (event=${event.event_type})`,
	);

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
		log(`seatalk[${accountId}]: group access denied: ${access.reason}`);
		return;
	}

	const mediaMessages: SeaTalkMessage[] = [];
	let messageText = "";

	if (msg.tag === "text") {
		messageText = extractGroupText(msg);
	} else if (msg.tag === "image" || msg.tag === "file" || msg.tag === "video") {
		mediaMessages.push(msg);
	} else if (msg.tag === "combined_forwarded_chat_history") {
		log(`seatalk[${accountId}]: skipping combined_forwarded_chat_history in group ${groupId}`);
		return;
	}

	const mediaList: SeaTalkMediaInfo[] = [];
	for (const m of mediaMessages) {
		const media = await resolveInboundMedia({ message: m, client, log });
		if (media) mediaList.push(media);
	}

	const quotedMessageId = msg.quoted_message_id;
	let quotedText: string | null = null;
	if (quotedMessageId) {
		const quoted = await resolveQuotedMessage({ client, quotedMessageId, log });
		if (quoted) {
			quotedText = quoted.text;
			mediaList.push(...quoted.media);
		}
	}

	const mediaPayload = buildSeaTalkMediaPayload(mediaList);

	if (quotedText) {
		messageText = messageText ? `${quotedText}\n${messageText}` : quotedText;
	}
	if (!messageText && mediaList.length > 0) {
		messageText = mediaList.map((m) => m.placeholder).join(" ");
	}
	if (!messageText && mediaList.length === 0) {
		log(
			`seatalk[${accountId}]: skipping empty group message from ${employeeCode} in ${groupId}`,
		);
		return;
	}

	const senderName = employeeCode + (senderEmail ? ` (${senderEmail})` : "");
	const messageId = msg.message_id;

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

		const preview = messageText.replace(/\s+/g, " ").slice(0, 160);
		core.system.enqueueSystemEvent(
			`SeaTalk[${accountId}] Group(${groupId}) from ${senderName}: ${preview}`,
			{ sessionKey: route.sessionKey, contextKey: `seatalk:group:${groupId}:${messageId}` },
		);

		const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
		const body = core.channel.reply.formatAgentEnvelope({
			channel: "SeaTalk",
			from: employeeCode,
			timestamp: new Date(),
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
			SessionKey: route.sessionKey,
			AccountId: route.accountId,
			ChatType: "group" as const,
			SenderName: senderName,
			SenderId: employeeCode,
			Provider: "seatalk" as const,
			Surface: "seatalk" as const,
			MessageSid: messageId,
			MessageThreadId: threadId || undefined,
			Timestamp: Date.now(),
			WasMentioned: event.event_type === "new_mentioned_message_received_from_group_chat",
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
				.catch((err) => log(`seatalk[${accountId}]: group typing failed: ${String(err)}`));
		}

		const replyThreadId = threadId || undefined;

		const typingResult = core.channel.reply.createReplyDispatcherWithTyping({
			humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
			deliver: async (payload) => {
				const text = payload.text?.trim();
				if (text) {
					await sendGroupTextMessage(client, groupId, text, 1, replyThreadId);
				}
			},
			onError: (err) => {
				error(`seatalk[${accountId}]: group reply delivery failed: ${String(err)}`);
			},
		});

		const replyOptions = {
			agentId: route.agentId,
			...typingResult.replyOptions,
		};

		log(`seatalk[${accountId}]: dispatching group message (session=${route.sessionKey})`);

		try {
			const { queuedFinal, counts } = await core.channel.reply.dispatchReplyFromConfig({
				ctx: ctxPayload,
				cfg,
				dispatcher: typingResult.dispatcher,
				replyOptions,
			});

			log(
				`seatalk[${accountId}]: group dispatch complete (queuedFinal=${queuedFinal}, counts=${JSON.stringify(counts)})`,
			);
		} finally {
			typingResult.markDispatchIdle();
		}
	} catch (err) {
		error(`seatalk[${accountId}]: failed to dispatch group message: ${String(err)}`);
	}
}
