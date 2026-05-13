// Imports tslog directly from runtime-env because OpenClaw's plugin runtime
// logger wrapper (runtime.logging.getChildLogger) silently drops the `meta`
// argument despite its type declaring it. See openclaw issue #26766.
import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";

type Meta = Record<string, unknown>;

export type Logger = {
	debug: (message: string, meta?: Meta) => void;
	info: (message: string, meta?: Meta) => void;
	warn: (message: string, meta?: Meta) => void;
	error: (message: string, meta?: Meta) => void;
};

const cache = new Map<string, Logger>();

export function logger(module: string): Logger {
	const hit = cache.get(module);
	if (hit) return hit;
	const raw = getChildLogger({ channel: "seatalk", module });
	const adapted: Logger = {
		debug: (message, meta) => (meta ? raw.debug?.(message, meta) : raw.debug?.(message)),
		info: (message, meta) => (meta ? raw.info(message, meta) : raw.info(message)),
		warn: (message, meta) => (meta ? raw.warn(message, meta) : raw.warn(message)),
		error: (message, meta) => (meta ? raw.error(message, meta) : raw.error(message)),
	};
	cache.set(module, adapted);
	return adapted;
}
