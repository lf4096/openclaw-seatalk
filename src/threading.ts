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
	const currentChannelId = normalizeOptionalString(params.context.To);
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
	const channelId = isGroupTarget(context.currentChannelId)
		? parseGroupTarget(context.currentChannelId)
		: context.currentChannelId;
	if (targetId !== channelId) {
		return undefined;
	}
	return context.currentThreadTs;
}
