import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import {
	type MessagePresentation,
	type MessagePresentationButton,
	adaptMessagePresentationForChannel,
	normalizeMessagePresentation,
	renderMessagePresentationFallbackText,
	resolveMessagePresentationButtonAction,
} from "openclaw/plugin-sdk/interactive-runtime";
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import {
	type AskUserQuestionOptionIndices,
	type ReplyPayload,
	resolveAskUserQuestionOptionIndex,
	resolveAskUserQuestionOptionIndices,
} from "openclaw/plugin-sdk/reply-payload";
import type { SeaTalkClient } from "./client.js";
import { logger } from "./log.js";
import { type SeaTalkChatTarget, sendTextToTarget } from "./send.js";

const QUESTION_VALUE_PREFIX = "stq1:";
const QUESTION_CUSTOM_INPUT_VALUE_PREFIX = "stqo1:";
const QUESTION_RECORD_ID = "[^:]+";
const QUESTION_RECORD_ID_PATTERN = new RegExp(`^${QUESTION_RECORD_ID}$`, "u");
const QUESTION_SELECT_VALUE_PATTERN = new RegExp(
	`^${QUESTION_VALUE_PREFIX}(${QUESTION_RECORD_ID}):([0-9]+)$`,
	"u",
);
const QUESTION_CUSTOM_INPUT_VALUE_PATTERN = new RegExp(
	`^${QUESTION_CUSTOM_INPUT_VALUE_PREFIX}(${QUESTION_RECORD_ID})$`,
	"u",
);
const QUESTION_FAILED_REPLY = "Could not submit this answer.";
const QUESTION_CLOSED_REPLY = "This question is no longer open.";
const CUSTOM_INPUT_REPLY = "Reply with your own answer.";
const ANSWERED_STATUS = "Answered";
const ANSWERED_STATUS_PREFIX = `${ANSWERED_STATUS}:`;
// The question presentation hardcodes this label; otherLabel only renames the text fallback.
const OTHER_OPTION_LABEL = "Other\u2026";
const SEATALK_CARD_TITLE_MAX_LENGTH = 120;
const SEATALK_CARD_DESCRIPTION_MAX_LENGTH = 1000;
const SEATALK_CARD_MAX_DESCRIPTIONS = 5;
const SEATALK_CARD_MAX_BUTTONS = 5;
const SEATALK_BUTTON_VALUE_MAX_BYTES = 200;
// A bare rule would read as a setext heading underline for the line above it.
const RETIRED_DIVIDER = "`-----------------------------`";
const CHECKED_OPTION = "\u2705";
const UNCHECKED_OPTION = "\u2b1c";

export const SEATALK_PRESENTATION_CAPABILITIES = {
	supported: true,
	buttons: true,
	selects: false,
	context: false,
	divider: false,
	charts: false,
	tables: false,
	limits: {
		actions: {
			maxActions: SEATALK_CARD_MAX_BUTTONS,
			maxActionsPerRow: 1,
			maxRows: SEATALK_CARD_MAX_BUTTONS,
			maxValueBytes: SEATALK_BUTTON_VALUE_MAX_BYTES,
			supportsStyles: false,
			supportsDisabled: false,
		},
		text: {
			maxLength: SEATALK_CARD_DESCRIPTION_MAX_LENGTH,
			encoding: "characters" as const,
			markdownDialect: "markdown" as const,
			supportsEdit: false,
		},
	},
};

export type SeaTalkQuestionAction =
	| { questionId: string; intent: "select"; optionIndex: number }
	| { questionId: string; intent: "custom-input" };

type SeaTalkCallbackButton = {
	button_type: "callback";
	text: string;
	value: string;
};

type SeaTalkRedirectButton = {
	button_type: "redirect";
	text: string;
	mobile_link: { type: "web"; path: string };
	desktop_link: { type: "web"; path: string };
};

type SeaTalkButton = SeaTalkCallbackButton | SeaTalkRedirectButton;

type SeaTalkInteractiveElement =
	| { element_type: "title"; title: { text: string } }
	| { element_type: "description"; description: { format: 1; text: string } }
	| { element_type: "button"; button: SeaTalkButton };

export type SeaTalkInteractiveMessage = {
	tag: "interactive_message";
	interactive_message: { elements: SeaTalkInteractiveElement[] };
};

type SeaTalkOutboundChannelData = {
	interactiveMessage?: SeaTalkInteractiveMessage;
};

function encodeSeaTalkQuestionAction(action: SeaTalkQuestionAction): string | undefined {
	if (!QUESTION_RECORD_ID_PATTERN.test(action.questionId)) return undefined;
	let value: string;
	if (action.intent === "custom-input") {
		value = `${QUESTION_CUSTOM_INPUT_VALUE_PREFIX}${action.questionId}`;
	} else {
		if (!Number.isSafeInteger(action.optionIndex) || action.optionIndex < 0) return undefined;
		value = `${QUESTION_VALUE_PREFIX}${action.questionId}:${action.optionIndex}`;
	}
	return Buffer.byteLength(value, "utf8") <= SEATALK_BUTTON_VALUE_MAX_BYTES ? value : undefined;
}

export function decodeSeaTalkQuestionAction(value: unknown): SeaTalkQuestionAction | null {
	if (typeof value !== "string") return null;
	const select = QUESTION_SELECT_VALUE_PATTERN.exec(value);
	if (select?.[1] && select[2]) {
		const optionIndex = Number(select[2]);
		if (Number.isSafeInteger(optionIndex)) {
			return { questionId: select[1], intent: "select", optionIndex };
		}
	}
	const customInput = QUESTION_CUSTOM_INPUT_VALUE_PATTERN.exec(value);
	return customInput?.[1] ? { questionId: customInput[1], intent: "custom-input" } : null;
}

export async function resolveSeaTalkQuestionAction(params: {
	action: SeaTalkQuestionAction;
	cfg: OpenClawConfig;
	accountId: string;
	employeeCode: string;
	client: SeaTalkClient;
	messageId: string;
	respond: (text: string) => Promise<unknown>;
}): Promise<void> {
	const log = logger("inbound");
	const meta = {
		accountId: params.accountId,
		employeeCode: params.employeeCode,
		questionId: params.action.questionId,
		intent: params.action.intent,
		...(params.action.intent === "select" ? { optionIndex: params.action.optionIndex } : {}),
	};
	const respond = async (text: string) => {
		try {
			await params.respond(text);
		} catch (err) {
			log.warn("question acknowledgement failed", { ...meta, err: String(err) });
		}
	};

	let result: Awaited<ReturnType<typeof questionGatewayRuntime.resolveOption>>;
	try {
		result = await questionGatewayRuntime.resolveOption({
			cfg: params.cfg,
			questionId: params.action.questionId,
			...(params.action.intent === "custom-input"
				? { customInput: true as const }
				: { optionIndex: params.action.optionIndex }),
			senderId: params.employeeCode,
			clientDisplayName: `SeaTalk question (${params.accountId})`,
		});
	} catch (err) {
		log.error("question resolution failed", { ...meta, err: String(err) });
		await respond(QUESTION_FAILED_REPLY);
		return;
	}

	// A successful tap resolves the question; the registered delivery callback rewrites the card.
	if (result.status === "answered") {
		log.info("question answered", meta);
		return;
	}
	// A custom-input tap leaves the question pending.
	if (result.status === "custom-input") {
		log.info("question awaiting custom input", meta);
		await retireSeaTalkQuestionCard({
			client: params.client,
			messageId: params.messageId,
			statusLine: CUSTOM_INPUT_REPLY,
			accountId: params.accountId,
			questionId: params.action.questionId,
			chosenLabel: OTHER_OPTION_LABEL,
		});
		await respond(CUSTOM_INPUT_REPLY);
		return;
	}
	log.info("question already terminal", { ...meta, reason: result.reason });
	// A not-found record is gone from the gateway, which also dropped the in-process delivery
	// registration that would have retired this card.
	if (result.reason === "not-found") {
		await retireSeaTalkQuestionCard({
			client: params.client,
			messageId: params.messageId,
			statusLine: QUESTION_CLOSED_REPLY,
			accountId: params.accountId,
			questionId: params.action.questionId,
			onlyWhenLive: true,
		});
	}
	await respond(QUESTION_CLOSED_REPLY);
}

function isSeaTalkWebLink(raw: string): boolean {
	try {
		const protocol = new URL(raw).protocol;
		return protocol === "http:" || protocol === "https:";
	} catch {
		return false;
	}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function readWebLink(value: unknown): { type: "web"; path: string } | undefined {
	const link = asRecord(value);
	const path = typeof link?.path === "string" ? link.path : undefined;
	return path && isSeaTalkWebLink(path) ? { type: "web", path } : undefined;
}

type RetiredChecklistEntry = { label: string; checked: boolean };

function readRetiredChecklist(text: string): RetiredChecklistEntry[] | undefined {
	if (!text.startsWith(RETIRED_DIVIDER)) return undefined;
	const options: RetiredChecklistEntry[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		const checked = trimmed.startsWith(CHECKED_OPTION);
		if (!checked && !trimmed.startsWith(UNCHECKED_OPTION)) continue;
		const label = trimmed.slice((checked ? CHECKED_OPTION : UNCHECKED_OPTION).length).trim();
		if (label) options.push({ label, checked });
	}
	return options;
}

// get_message echoes a callback button's label but never its value.
function rebuildRetiredCardElements(
	elements: unknown[],
	statusLine: string,
	chosenLabel?: string,
): { elements: SeaTalkInteractiveElement[]; wasLive: boolean } | undefined {
	const titles: SeaTalkInteractiveElement[] = [];
	const descriptions: SeaTalkInteractiveElement[] = [];
	const redirects: SeaTalkInteractiveElement[] = [];
	const buttonLabels: string[] = [];
	let retiredChecklist: RetiredChecklistEntry[] | undefined;

	const readButton = (value: unknown) => {
		const button = asRecord(value);
		if (!button) return;
		if (button.button_type === "callback") {
			if (typeof button.text === "string" && button.text) buttonLabels.push(button.text);
			return;
		}
		const text = typeof button.text === "string" ? button.text : undefined;
		const mobile = readWebLink(button.mobile_link);
		const desktop = readWebLink(button.desktop_link);
		if (text && mobile && desktop) {
			redirects.push({
				element_type: "button",
				button: {
					button_type: "redirect",
					text,
					mobile_link: mobile,
					desktop_link: desktop,
				},
			});
		}
	};

	for (const value of elements) {
		const element = asRecord(value);
		if (!element) continue;
		if (element.element_type === "title") {
			const text = asRecord(element.title)?.text;
			if (typeof text === "string" && text) {
				titles.push({ element_type: "title", title: { text } });
			}
		} else if (element.element_type === "description") {
			const text = asRecord(element.description)?.text;
			if (typeof text !== "string" || !text) continue;
			const checklist = readRetiredChecklist(text);
			if (checklist) {
				retiredChecklist = checklist;
				continue;
			}
			descriptions.push({ element_type: "description", description: { format: 1, text } });
		} else if (element.element_type === "button") {
			readButton(element.button);
		}
	}

	const options =
		buttonLabels.length > 0 ? buttonLabels : (retiredChecklist?.map((o) => o.label) ?? []);
	if (options.length === 0) return undefined;

	const preChecked = new Set(retiredChecklist?.filter((o) => o.checked).map((o) => o.label));
	const trimmedStatus = statusLine.trim();
	const answered = new Set(
		trimmedStatus.startsWith(ANSWERED_STATUS_PREFIX)
			? trimmedStatus
					.slice(ANSWERED_STATUS_PREFIX.length)
					.split(",")
					.map((label) => label.trim())
					.filter(Boolean)
			: [],
	);
	const typedAnswer = trimmedStatus === ANSWERED_STATUS;
	let checkedCount = 0;
	const checklist = options
		.map((label) => {
			const checked =
				preChecked.has(label) ||
				answered.has(label) ||
				label === chosenLabel ||
				(typedAnswer && label === OTHER_OPTION_LABEL);
			if (checked) checkedCount += 1;
			return `${checked ? CHECKED_OPTION : UNCHECKED_OPTION} ${label}`;
		})
		.join("\n");
	// An unticked checklist only repeats the option prose above it. A label holding a
	// comma cannot be split back out of an answered line.
	const body =
		checkedCount === 0
			? `_${statusLine}_`
			: trimmedStatus.startsWith(ANSWERED_STATUS_PREFIX)
				? checklist
				: `${checklist}\n\n_${statusLine}_`;

	return {
		wasLive: buttonLabels.length > 0,
		elements: [
			...titles,
			...descriptions.slice(0, SEATALK_CARD_MAX_DESCRIPTIONS - 1),
			{
				element_type: "description",
				description: { format: 1, text: `${RETIRED_DIVIDER}\n${body}` },
			},
			...redirects,
		],
	};
}

async function retireSeaTalkQuestionCard(params: {
	client: SeaTalkClient;
	messageId: string;
	statusLine: string;
	accountId: string;
	questionId: string;
	chosenLabel?: string;
	onlyWhenLive?: boolean;
	respond?: (text: string) => Promise<unknown>;
}): Promise<void> {
	const log = logger("outbound");
	const meta = {
		accountId: params.accountId,
		questionId: params.questionId,
		messageId: params.messageId,
	};
	try {
		const fetched = asRecord(
			(await params.client.getMessageByMessageId(params.messageId)).interactive_message,
		);
		const elements = fetched && Array.isArray(fetched.elements) ? fetched.elements : undefined;
		if (!elements) {
			log.warn("card retire skipped: no interactive message", meta);
			return;
		}
		const rebuilt = rebuildRetiredCardElements(elements, params.statusLine, params.chosenLabel);
		if (!rebuilt) {
			log.info("card retire skipped: no options", meta);
			return;
		}
		if (params.onlyWhenLive && !rebuilt.wasLive) {
			log.info("card retire skipped: already retired", meta);
			return;
		}
		await params.client.updateMessage(params.messageId, {
			tag: "interactive_message",
			interactive_message: { elements: rebuilt.elements },
		});
		log.info("card retired", { ...meta, statusLine: params.statusLine });
	} catch (err) {
		log.warn("card retire failed", { ...meta, err: String(err) });
		if (params.respond) {
			await params.respond(params.statusLine).catch((replyErr) => {
				log.warn("card retire notice failed", { ...meta, err: String(replyErr) });
			});
		}
	}
}

export async function sendSeaTalkQuestionCard(params: {
	client: SeaTalkClient;
	target: SeaTalkChatTarget;
	interactiveMessage: SeaTalkInteractiveMessage;
	payload: Pick<ReplyPayload, "channelData">;
	accountId: string;
}): Promise<string> {
	const { client, target, accountId } = params;
	const messageId = target.isGroup
		? await client.sendGroupChat(target.to, params.interactiveMessage, target.threadId)
		: await client.sendSingleChat(target.to, params.interactiveMessage, target.threadId);
	const questionId = questionGatewayRuntime.readAskUserQuestionId(params.payload);
	if (!questionId || !messageId) return messageId;
	questionGatewayRuntime.registerChannelDelivery({
		questionId,
		deliveryId: `seatalk:${accountId}:${messageId}`,
		finalize: (statusLine) =>
			retireSeaTalkQuestionCard({
				client,
				messageId,
				statusLine,
				accountId,
				questionId,
				respond: (text) => sendTextToTarget(client, target, text),
			}),
	});
	return messageId;
}

function renderButton(params: {
	button: MessagePresentationButton;
	questionOptionIndices?: AskUserQuestionOptionIndices;
}): SeaTalkButton | undefined {
	const button = params.button;
	const action = resolveMessagePresentationButtonAction(button);
	if (action?.type === "question") {
		if ("intent" in action) {
			const value = encodeSeaTalkQuestionAction({
				questionId: action.questionId,
				intent: "custom-input",
			});
			return value ? { button_type: "callback", text: button.label, value } : undefined;
		}
		const optionIndex = resolveAskUserQuestionOptionIndex({
			questionOptionIndices: params.questionOptionIndices,
			questionId: action.questionId,
			optionValue: action.optionValue,
		});
		const value =
			optionIndex === undefined
				? undefined
				: encodeSeaTalkQuestionAction({
						questionId: action.questionId,
						intent: "select",
						optionIndex,
					});
		return value ? { button_type: "callback", text: button.label, value } : undefined;
	}
	if (action?.type === "url" || action?.type === "web-app") {
		if (!("url" in action) || !action.url || !isSeaTalkWebLink(action.url)) return undefined;
		return {
			button_type: "redirect",
			text: button.label,
			mobile_link: { type: "web", path: action.url },
			desktop_link: { type: "web", path: action.url },
		};
	}
	return undefined;
}

export function renderSeaTalkInteractiveMessage(params: {
	payload: Pick<ReplyPayload, "channelData" | "text">;
	presentation: MessagePresentation;
}): SeaTalkInteractiveMessage | null {
	const elements: SeaTalkInteractiveElement[] = [];
	const questionOptionIndices = resolveAskUserQuestionOptionIndices(params.payload);
	let descriptionCount = 0;
	let buttonCount = 0;

	if (params.presentation.title) {
		if (Array.from(params.presentation.title).length > SEATALK_CARD_TITLE_MAX_LENGTH)
			return null;
		elements.push({ element_type: "title", title: { text: params.presentation.title } });
	}

	const appendDescription = (text: string): boolean => {
		if (
			!text ||
			Array.from(text).length > SEATALK_CARD_DESCRIPTION_MAX_LENGTH ||
			descriptionCount >= SEATALK_CARD_MAX_DESCRIPTIONS
		) {
			return false;
		}
		elements.push({ element_type: "description", description: { format: 1, text } });
		descriptionCount += 1;
		return true;
	};

	if (params.payload.text?.trim() && !appendDescription(params.payload.text.trim())) return null;

	for (const block of params.presentation.blocks) {
		if (block.type === "text" || block.type === "context") {
			if (!appendDescription(block.text)) return null;
			continue;
		}
		if (block.type !== "buttons" || block.buttons.length < 1) return null;
		const buttons = block.buttons.map((button) =>
			renderButton({ button, questionOptionIndices }),
		);
		if (buttons.some((button) => !button)) return null;
		const renderedButtons = buttons as SeaTalkButton[];
		buttonCount += renderedButtons.length;
		if (buttonCount > SEATALK_CARD_MAX_BUTTONS) return null;
		for (const button of renderedButtons) {
			elements.push({ element_type: "button", button });
		}
	}

	return elements.length > 0
		? { tag: "interactive_message", interactive_message: { elements } }
		: null;
}

export function renderSeaTalkReplyPresentation(
	payload: ReplyPayload,
): SeaTalkInteractiveMessage | null {
	const presentation = normalizeMessagePresentation(payload.presentation);
	if (!presentation) return null;
	return renderSeaTalkInteractiveMessage({
		payload:
			payload.presentationTextMode === "fallback" ? { ...payload, text: undefined } : payload,
		presentation: adaptMessagePresentationForChannel({
			presentation,
			capabilities: SEATALK_PRESENTATION_CAPABILITIES,
		}),
	});
}

export function renderSeaTalkPresentationFallbackText(payload: ReplyPayload): string | undefined {
	if (payload.presentationTextMode === "fallback") return undefined;
	const presentation = normalizeMessagePresentation(payload.presentation);
	if (!presentation) return undefined;
	return renderMessagePresentationFallbackText({ presentation, text: payload.text }) || undefined;
}

export function withSeaTalkInteractiveMessage(
	payload: ReplyPayload,
	interactiveMessage: SeaTalkInteractiveMessage,
): ReplyPayload {
	const seatalkData = asRecord(payload.channelData?.seatalk) as
		| SeaTalkOutboundChannelData
		| undefined;
	return {
		...payload,
		channelData: {
			...payload.channelData,
			seatalk: { ...seatalkData, interactiveMessage },
		},
	};
}

export function readSeaTalkInteractiveMessage(
	payload: Pick<ReplyPayload, "channelData">,
): SeaTalkInteractiveMessage | undefined {
	const seatalkData = asRecord(payload.channelData?.seatalk) as
		| SeaTalkOutboundChannelData
		| undefined;
	return seatalkData?.interactiveMessage;
}
