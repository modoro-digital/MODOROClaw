import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { modoroZaloPlugin } from "./src/channel.js";
import { setModoroZaloRuntime } from "./src/runtime.js";
import { registerModoroZaloSubagentHooks } from "./src/subagent-hooks.js";

export default defineChannelPluginEntry({
  id: "modoro-zalo",
  name: "Modoro Zalo",
  description: "Modoro Zalo channel plugin (personal account via openzca CLI)",
  plugin: modoroZaloPlugin,
  setRuntime: setModoroZaloRuntime,
  registerFull(api) {
    registerModoroZaloSubagentHooks(api);
  },
});
