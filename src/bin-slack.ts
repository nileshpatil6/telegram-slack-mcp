#!/usr/bin/env node
import { runSlack } from "./slack.js";

runSlack().catch((e) => {
  process.stderr.write(`chat-mcp slack failed to start: ${e?.message ?? e}\n`);
  process.exit(1);
});
