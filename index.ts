import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { seatalkPlugin } from "./src/channel.js";
import { setSeatalkRuntime } from "./src/runtime.js";
import { registerSeaTalkTool } from "./src/tool.js";

export {
	sendTextMessage,
	sendImageMessage,
	sendFileMessage,
} from "./src/send.js";
export { probeSeaTalk } from "./src/probe.js";
export { monitorSeaTalkProvider } from "./src/monitor.js";
export { seatalkPlugin } from "./src/channel.js";

export default defineChannelPluginEntry({
	id: "openclaw-seatalk",
	name: "SeaTalk",
	description: "SeaTalk channel plugin",
	plugin: seatalkPlugin,
	setRuntime: setSeatalkRuntime,
	registerFull: (api) => registerSeaTalkTool(api),
});
