import type { AnyTool } from "../mcp/define-tool";
import { evaluateTools } from "./evaluate";
import { navigationTools } from "./navigation";
import { screenshotTools } from "./screenshot";
import { snapshotTools } from "./snapshot";
import { tabTools } from "./tabs";
import { waitTools } from "./wait";

export const allTools: readonly AnyTool[] = [
  ...tabTools,
  ...evaluateTools,
  ...navigationTools,
  ...waitTools,
  ...screenshotTools,
  ...snapshotTools,
];
