import {
	type ChannelOutboundSessionRouteParams,
	buildChannelOutboundSessionRoute,
	buildThreadAwareOutboundSessionRoute,
	stripChannelTargetPrefix,
} from "openclaw/plugin-sdk/core";
import { isGroupTarget, parseGroupTarget } from "./targets.js";

export function resolveSeaTalkOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
	const trimmed = stripChannelTargetPrefix(params.target, "seatalk");
	if (!trimmed) {
		return null;
	}

	const isGroup = isGroupTarget(trimmed);
	const id = isGroup ? parseGroupTarget(trimmed) : trimmed;
	if (!id) {
		return null;
	}

	const baseRoute = buildChannelOutboundSessionRoute({
		cfg: params.cfg,
		agentId: params.agentId,
		channel: "seatalk",
		accountId: params.accountId,
		peer: { kind: isGroup ? "group" : "direct", id },
		chatType: isGroup ? "group" : "direct",
		from: isGroup ? `seatalk:group:${id}` : `seatalk:${id}`,
		to: isGroup ? `group:${id}` : id,
	});

	return buildThreadAwareOutboundSessionRoute({
		route: baseRoute,
		replyToId: params.replyToId,
		threadId: params.threadId,
		currentSessionKey: params.currentSessionKey,
		canRecoverCurrentThread: ({ route }) =>
			route.chatType !== "direct" || (params.cfg.session?.dmScope ?? "main") !== "main",
	});
}
