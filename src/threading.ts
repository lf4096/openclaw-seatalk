import type {
	ChannelThreadingContext,
	ChannelThreadingToolContext,
} from "openclaw/plugin-sdk/channel-contract";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { isGroupTarget, parseGroupTarget } from "./targets.js";

export function buildSeaTalkThreadingToolContext(params: {
	context: ChannelThreadingContext;
	hasRepliedRef?: { value: boolean };
}): ChannelThreadingToolContext {
	const to = params.context.To;
	const currentChannelId = to?.startsWith("group:")
		? to.slice("group:".length)
		: normalizeOptionalString(to);
	const threadId =
		typeof params.context.MessageThreadId === "number"
			? String(params.context.MessageThreadId)
			: normalizeOptionalString(params.context.MessageThreadId);
	return {
		currentChannelId,
		currentThreadTs: threadId,
		replyToMode: "all",
		hasRepliedRef: params.hasRepliedRef,
	};
}

export function resolveSeaTalkAutoThreadId(params: {
	to: string;
	toolContext?: ChannelThreadingToolContext;
}): string | undefined {
	const context = params.toolContext;
	if (!context?.currentThreadTs || !context.currentChannelId) {
		return undefined;
	}
	const targetId = isGroupTarget(params.to) ? parseGroupTarget(params.to) : params.to;
	if (targetId !== context.currentChannelId) {
		return undefined;
	}
	return context.currentThreadTs;
}
