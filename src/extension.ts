import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerFormation } from "./formation.ts";
import { registerHydration } from "./hydration.ts";

export { CONFIRM_TITLE, DISCLOSURE } from "./formation.ts";

export default function (pi: ExtensionAPI): void {
  registerFormation(pi, { agentDir: () => getAgentDir() });
  registerHydration(pi);
}
