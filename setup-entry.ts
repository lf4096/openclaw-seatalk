import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { seatalkPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(seatalkPlugin);
