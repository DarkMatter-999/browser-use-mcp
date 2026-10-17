import type { AnyTool } from "../mcp/define-tool";
import { downloadTools } from "./downloads";
import { evaluateTools } from "./evaluate";
import { interactionTools } from "./interaction";
import { navigationTools } from "./navigation";
import { screenshotTools } from "./screenshot";
import { snapshotTools } from "./snapshot";
import { tabTools } from "./tabs";
import { uploadTools } from "./upload";
import { waitTools } from "./wait";

export const allTools: readonly AnyTool[] = [
  ...tabTools,
  ...evaluateTools,
  ...navigationTools,
  ...waitTools,
  ...screenshotTools,
  ...snapshotTools,
  ...interactionTools,
  ...uploadTools,
  ...downloadTools,
];
