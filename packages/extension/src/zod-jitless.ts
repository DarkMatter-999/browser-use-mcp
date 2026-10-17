// MV3 extension CSP forbids eval. zod probes `new Function("")` (and JITs object parsers)
// unless jitless is set, which logs a CSP violation. zod reads this config while schemas are
// constructed, so this module must be evaluated BEFORE `@browser-use/protocol`. Every extension
// entry point that touches `@browser-use/protocol` must import this module first.
import { z } from "zod";

z.config({ jitless: true });
