import type {
	ChannelThreadingContext,
	ChannelThreadingToolContext,
} from "openclaw/plugin-sdk/channel-contract";
import { resolveSeaTalkTargetKind } from "./targets.js";

function normalizeOptionalString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

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
	const targetId = resolveSeaTalkTargetKind(params.to).id;
	const channelId = resolveSeaTalkTargetKind(context.currentChannelId).id;
	if (targetId !== channelId) {
		return undefined;
	}
	return context.currentThreadTs;
}
