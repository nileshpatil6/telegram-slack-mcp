# telegram-slack-mcp

MCP servers that give Claude access to your **personal** Telegram and Slack accounts.
Python distribution of [telegram-slack-mcp](https://github.com/nileshpatil6/telegram-slack-mcp).

There is also an npm build of the same servers if you prefer Node:
`npx -y telegram-slack-mcp telegram`.

## Install

```bash
uvx telegram-slack-mcp telegram   # or: pipx install telegram-slack-mcp
```

Register with Claude Code:

```bash
claude mcp add telegram -- uvx telegram-slack-mcp telegram
claude mcp add slack    -- uvx telegram-slack-mcp slack
```

## Telegram

Uses MTProto as **your account**, so it sees your real DMs, groups and channels,
not just messages sent to a bot.

1. Get an `api_id` and `api_hash` from <https://my.telegram.org> → API development tools.
2. Set `TELEGRAM_API_ID` and `TELEGRAM_API_HASH`.
3. Ask Claude to log you in: it calls `login_start` with your phone, you paste the
   code Telegram sends, it calls `login_complete`. One time only.

Tools: `login_start`, `login_complete`, `whoami`, `list_chats`, `read_chat`,
`search_messages`, `unread_summary`, `send_message`.

## Slack

Reads and posts across **all** your workspaces at once.

1. Create an app at <https://api.slack.com/apps> from the manifest in the repo.
2. Install it to each workspace, copying the User OAuth Token (`xoxp-...`) each time.
3. Set `SLACK_USER_TOKENS` to all of them, comma separated.

Tools: `whoami`, `list_channels`, `list_dms`, `read_channel`, `read_thread`,
`search_messages`, `unread_summary`, `send_message`. Every tool takes an optional
`workspace` filter.

## Environment

| variable | meaning |
|---|---|
| `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` | from my.telegram.org |
| `TELEGRAM_ALLOW_SEND` | `1` to allow sending as you (default off) |
| `SLACK_USER_TOKENS` | one `xoxp-` token per workspace, comma separated |
| `SLACK_ALLOW_SEND` | `1` to allow posting as you (default off) |
| `CHAT_MCP_DATA_DIR` | where sessions live (default `~/.chat-mcp`) |

## Privacy

**Nothing is sent to any server belonging to this project. There is no such server.**

Everything runs on your machine. The only outbound traffic is to Telegram's and Slack's
own APIs with your own credentials. No telemetry, no analytics, no phone-home.

Credentials never reach Claude — they stay in `~/.chat-mcp` and your environment. What
reaches Claude is only the chat content you ask it to read, handled under Anthropic's
privacy policy like any text you paste in yourself. The servers are passive and read
nothing in the background.

## Security

These act as **you**, not as a bot. Sending is off by default in both servers.
The Telegram session file and Slack `xoxp-` tokens are full account credentials —
keep them out of git. Automating a personal Telegram account is a userbot, which
Telegram's ToS restricts; light personal use is common, bulk automation risks a ban.
Anything Claude reads enters the model's context.

MIT licensed. Full docs: <https://github.com/nileshpatil6/telegram-slack-mcp>
