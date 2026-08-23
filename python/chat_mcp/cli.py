"""Dispatcher so one command runs either server, mirroring the npm build."""
import sys

USAGE = """telegram-slack-mcp - MCP servers for your personal Telegram and Slack accounts

Usage:
  telegram-slack-mcp telegram   Run the Telegram MCP server on stdio
  telegram-slack-mcp slack      Run the Slack MCP server on stdio

Register with Claude Code:
  claude mcp add telegram -- uvx telegram-slack-mcp telegram
  claude mcp add slack    -- uvx telegram-slack-mcp slack

Environment:
  TELEGRAM_API_ID       api_id from https://my.telegram.org
  TELEGRAM_API_HASH     api_hash from https://my.telegram.org
  TELEGRAM_ALLOW_SEND   1 to allow sending messages as you (default off)
  SLACK_USER_TOKENS     one xoxp- user token per workspace, comma separated
  SLACK_ALLOW_SEND      1 to allow posting messages as you (default off)
  CHAT_MCP_DATA_DIR     where sessions are stored (default ~/.chat-mcp)

Docs: https://github.com/nileshpatil6/telegram-slack-mcp
"""


def main() -> None:
    cmd = (sys.argv[1] if len(sys.argv) > 1 else "").lower()
    if cmd in ("telegram", "tg"):
        # Imported lazily so the Slack path never loads the MTProto library.
        from .telegram_server import main as run
        run()
    elif cmd == "slack":
        from .slack_server import main as run
        run()
    elif cmd in ("", "-h", "--help", "help"):
        sys.stdout.write(USAGE)
    elif cmd in ("-v", "--version"):
        from . import __version__
        sys.stdout.write(__version__ + "\n")
    else:
        sys.stderr.write("Unknown command: " + cmd + "\n\n" + USAGE)
        sys.exit(1)


if __name__ == "__main__":
    main()
