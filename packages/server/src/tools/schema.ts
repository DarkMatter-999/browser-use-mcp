import { z } from "zod";

export const tabIdField = z.number().int().positive();

export const targetFields = {
  ref: z
    .string()
    .regex(/^e\d+$/)
    .optional()
    .describe("Element ref from browser_snapshot"),
  selector: z
    .string()
    .min(1)
    .max(2000)
    .optional()
    .describe("CSS selector; use when there is no ref"),
};
