import { BrowserUseError } from "@browser-use/protocol";
import { z } from "zod";
import type { ToolContext } from "./context";
import { errorOutput, type ToolOutput } from "./format";

export interface AnyTool {
  name: string;
  title: string;
  description: string;
  inputShape: z.ZodRawShape;
  run(ctx: ToolContext, rawArgs: unknown): Promise<ToolOutput>;
}

export function defineTool<Shape extends z.ZodRawShape>(def: {
  name: string;
  title: string;
  description: string;
  inputShape: Shape;
  handler(ctx: ToolContext, args: z.infer<z.ZodObject<Shape>>): Promise<ToolOutput>;
}): AnyTool {
  const schema = z.object(def.inputShape);
  return {
    name: def.name,
    title: def.title,
    description: def.description,
    inputShape: def.inputShape,
    async run(ctx, rawArgs) {
      try {
        return await def.handler(ctx, schema.parse(rawArgs));
      } catch (error) {
        if (error instanceof z.ZodError) {
          const issues = error.issues
            .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("; ");
          return errorOutput(
            new BrowserUseError("INVALID_ARGUMENT", `Invalid arguments: ${issues}`),
          );
        }
        return errorOutput(error);
      }
    },
  };
}
