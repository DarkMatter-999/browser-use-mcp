import type { AnyTool } from "../mcp/define-tool";
import { diagnosticsTools } from "./diagnostics";
import { downloadTools } from "./downloads";
import { emulationTools } from "./emulation";
import { evaluateTools } from "./evaluate";
import { exportTools } from "./export";
import { inspectTools } from "./inspect";
import { interactionTools } from "./interaction";
import { navigationTools } from "./navigation";
import { performanceTools } from "./performance";
import { screenshotTools } from "./screenshot";
import { snapshotTools } from "./snapshot";
import { storageTools } from "./storage";
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
  ...inspectTools,
  ...diagnosticsTools,
  ...storageTools,
  ...emulationTools,
  ...performanceTools,
  ...exportTools,
];
