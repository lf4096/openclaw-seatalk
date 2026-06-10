import {
	type ChannelOutboundSessionRouteParams,
	buildChannelOutboundSessionRoute,
	buildThreadAwareOutboundSessionRoute,
	stripChannelTargetPrefix,
} from "openclaw/plugin-sdk/core";
import { resolveSeaTalkTargetKind } from "./targets.js";

export function resolveSeaTalkOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
	const trimmed = stripChannelTargetPrefix(params.target, "seatalk");
	if (!trimmed) {
		return null;
	}

	const { kind, id } = resolveSeaTalkTargetKind(trimmed);
	if (!id) {
		return null;
	}

	const baseRoute = buildChannelOutboundSessionRoute({
		cfg: params.cfg,
		agentId: params.agentId,
		channel: "seatalk",
		accountId: params.accountId,
		peer: { kind, id },
		chatType: kind,
		from: `seatalk:${id}`,
		to: id,
	});

	return buildThreadAwareOutboundSessionRoute({
		route: baseRoute,
		threadId: params.threadId,
		currentSessionKey: params.currentSessionKey,
		precedence: ["threadId", "currentSession"],
		canRecoverCurrentThread: ({ route }) =>
			route.chatType !== "direct" || (params.cfg.session?.dmScope ?? "main") !== "main",
	});
}
