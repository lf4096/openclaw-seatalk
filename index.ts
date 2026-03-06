import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { seatalkPlugin } from "./src/channel.js";
import { setSeatalkRuntime } from "./src/runtime.js";
import { registerSeaTalkTool } from "./src/tool.js";

export { monitorSeaTalkProvider } from "./src/monitor.js";
export {
	sendSeaTalkMessage,
	sendTextMessage,
	sendImageMessage,
	sendFileMessage,
} from "./src/send.js";
export { probeSeaTalk } from "./src/probe.js";
export { seatalkPlugin } from "./src/channel.js";

const plugin = {
	id: "seatalk",
	name: "SeaTalk",
	description: "SeaTalk channel plugin",
	configSchema: emptyPluginConfigSchema(),
	register(api: OpenClawPluginApi) {
		setSeatalkRuntime(api.runtime);
		api.registerChannel({ plugin: seatalkPlugin });
		registerSeaTalkTool(api);
	},
};

export default plugin;
