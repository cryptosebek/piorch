#!/usr/bin/env bun

const runtime = process.env.PIORCH_REAL_PI_RUNTIME ?? "node";
const entry = process.env.PIORCH_REAL_PI_ENTRY;
if (!entry) {
  console.error("PIORCH_REAL_PI_ENTRY is required when using bun-pi-wrapper.mjs");
  process.exit(2);
}

const child = Bun.spawn([runtime, entry, ...process.argv.slice(2)], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  env: process.env,
});
process.exit(await child.exited);
