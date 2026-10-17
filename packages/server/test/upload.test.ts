import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { browserUpload, resolveUploadPaths } from "../src/tools/upload";
import { scriptedContext } from "./helpers/context";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bu-up-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const tabs = [{ tabId: 1, url: "https://a/", title: "A" }];
const quad = [0, 0, 10, 0, 10, 10, 0, 10];

function ctxFor(isFileInput = true, count = 1) {
  return scriptedContext(
    {
      "DOM.getDocument": () => ({ root: { nodeId: 1 } }),
      "DOM.querySelectorAll": () => ({ nodeIds: [4] }),
      "DOM.scrollIntoViewIfNeeded": () => ({}),
      "DOM.getBoxModel": () => ({ model: { content: quad } }),
      "DOM.describeNode": () => ({ node: {} }),
      "DOM.resolveNode": () => ({ object: { objectId: "o1" } }),
      "Runtime.callFunctionOn": (p) => ({
        result: {
          value: (p.functionDeclaration as string).includes("type === 'file'")
            ? isFileInput
            : count,
        },
      }),
      "DOM.setFileInputFiles": () => ({}),
    },
    tabs,
  );
}

describe("resolveUploadPaths", () => {
  it("resolves existing regular files to absolute paths", async () => {
    const file = join(dir, "a.txt");
    await writeFile(file, "x");
    expect(await resolveUploadPaths([file])).toEqual([file]);
  });

  it("rejects missing files, directories, empty and oversize lists", async () => {
    await expect(resolveUploadPaths([join(dir, "nope")])).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await mkdir(join(dir, "sub"));
    await expect(resolveUploadPaths([join(dir, "sub")])).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(resolveUploadPaths([])).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      resolveUploadPaths(new Array<string>(21).fill(join(dir, "a"))),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });
});

describe("browserUpload", () => {
  it("sets the files on a file input found by selector", async () => {
    const file = join(dir, "a.txt");
    await writeFile(file, "x");
    const ctx = ctxFor();
    const result = await browserUpload(ctx, { tabId: 1, selector: "#file", paths: [file] });
    expect(result).toMatchObject({ uploaded: 1, files: [basename(file)] });
    const call = ctx.calls.find((c) => c.method === "DOM.setFileInputFiles");
    expect(call?.params).toMatchObject({ files: [file], nodeId: 4 });
  });

  it("rejects a target that is not a file input before touching files", async () => {
    const file = join(dir, "a.txt");
    await writeFile(file, "x");
    const ctx = ctxFor(false);
    await expect(
      browserUpload(ctx, { tabId: 1, selector: "#text", paths: [file] }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(ctx.calls.some((c) => c.method === "DOM.setFileInputFiles")).toBe(false);
  });

  it("fails if the page did not end up with the files", async () => {
    const file = join(dir, "a.txt");
    await writeFile(file, "x");
    const ctx = ctxFor(true, 0);
    await expect(
      browserUpload(ctx, { tabId: 1, selector: "#file", paths: [file] }),
    ).rejects.toMatchObject({ code: "INTERNAL" });
  });

  it("without a target, requires a pending chooser", async () => {
    const file = join(dir, "a.txt");
    await writeFile(file, "x");
    await expect(browserUpload(ctxFor(), { tabId: 1, paths: [file] })).rejects.toMatchObject({
      code: "ELEMENT_NOT_FOUND",
    });
  });
});

describe("browserUpload via chooser", () => {
  it("uses a pending file chooser and clears it", async () => {
    const { chooserWatch } = await import("../src/files/chooser-watch");
    const file = join(dir, "a.txt");
    await writeFile(file, "x");
    const ctx = scriptedContext(
      {
        "Page.setInterceptFileChooserDialog": () => ({}),
        "DOM.setFileInputFiles": () => ({}),
        "DOM.resolveNode": () => ({ object: { objectId: "o1" } }),
        "Runtime.callFunctionOn": () => ({ result: { value: 1 } }),
      },
      tabs,
    );
    await chooserWatch.armFor(ctx, 1);
    ctx.emit(1, "Page.fileChooserOpened", { mode: "selectSingle", backendNodeId: 7 });
    const result = await browserUpload(ctx, { tabId: 1, paths: [file] });
    expect(result).toMatchObject({ uploaded: 1 });
    expect(ctx.calls.find((c) => c.method === "DOM.setFileInputFiles")?.params).toMatchObject({
      backendNodeId: 7,
    });
    expect(chooserWatch.peek(ctx, 1)).toBeUndefined();
  });
});
