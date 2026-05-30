import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { modoroZaloPlugin } from "./src/channel.js";
export { ModoroZaloChannelConfigSchema } from "./src/config-schema.js";

export { modoroZaloPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(modoroZaloPlugin);
