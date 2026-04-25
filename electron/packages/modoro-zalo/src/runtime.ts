import type { PluginRuntime } from "../api.js";

let runtime: PluginRuntime | null = null;

export function setModoroZaloRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getModoroZaloRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Modoro Zalo runtime not initialized");
  }
  return runtime;
}
