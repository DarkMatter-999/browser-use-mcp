#!/usr/bin/env node
import { run } from "./main";

process.exitCode = run(process.argv.slice(2), {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
});
