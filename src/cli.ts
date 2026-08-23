#!/usr/bin/env node

const USAGE = `chat-mcp - MCP servers for your personal Telegram and Slack accounts

Usage:
  chat-mcp telegram     Run the Telegram MCP server on stdio
  chat-mcp slack        Run the Slack MCP server on stdio

Register with Claude Code:
  claude mcp add telegram -- npx -y chat-mcp telegram
  claude mcp add slack    -- npx -y chat-mcp slack

Environment:
  TELEGRAM_API_ID       api_id from https://my.telegram.org
  TELEGRAM_API_HASH     api_hash from https://my.telegram.org
  TELEGRAM_ALLOW_SEND   1 to allow sending messages as you (default off)
  SLACK_USER_TOKENS     one xoxp- user token per workspace, comma separated
  SLACK_ALLOW_SEND      1 to allow posting messages as you (default off)
  CHAT_MCP_DATA_DIR     where sessions are stored (default ~/.chat-mcp)

Docs: https://github.com/nileshpatil6/chat-mcp
`;

async function main() {
  const cmd = (process.argv[2] || "").toLowerCase();
  switch (cmd) {
    case "telegram":
    case "tg": {
      // Loaded lazily so `chat-mcp slack` never pays for the MTProto library.
      const { runTelegram } = await import("./telegram.js");
      await runTelegram();
      break;
    }
    case "slack": {
      const { runSlack } = await import("./slack.js");
      await runSlack();
      break;
    }
    case "-h":
    case "--help":
    case "help":
    case "":
      process.stdout.write(USAGE);
      break;
    case "-v":
    case "--version":
      process.stdout.write(`${require("../package.json").version}\n`);
      break;
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${USAGE}`);
      process.exit(1);
  }
}

main().catch((e) => {
  process.stderr.write(`chat-mcp failed to start: ${e?.message ?? e}\n`);
  process.exit(1);
});
