import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setSeatalkRuntime(next: PluginRuntime) {
	runtime = next;
}

export function getSeatalkRuntime(): PluginRuntime {
	if (!runtime) {
		throw new Error("SeaTalk runtime not initialized");
	}
	return runtime;
}
