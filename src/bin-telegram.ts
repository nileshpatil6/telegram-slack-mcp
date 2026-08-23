#!/usr/bin/env node
import { runTelegram } from "./telegram.js";

runTelegram().catch((e) => {
  process.stderr.write(`chat-mcp telegram failed to start: ${e?.message ?? e}\n`);
  process.exit(1);
});
