import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { ModoroZaloConfigSchema } from "./config-schema-core.js";

export const ModoroZaloChannelConfigSchema = buildChannelConfigSchema(ModoroZaloConfigSchema);
