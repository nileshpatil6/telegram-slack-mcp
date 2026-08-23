# chat-mcp

Two MCP servers that give Claude access to your own chat accounts, packaged as a
Claude Code plugin marketplace.

| plugin | what it does |
|---|---|
| **telegram-reader** | Read and reply to your personal Telegram chats. Uses MTProto as *your account*, so it sees your real DMs, groups, and channels, not just messages sent to a bot. |
| **slack-reader** | Read and post across **all** your Slack workspaces at once, one user token per workspace. |

## Install

```
/plugin marketplace add nileshpatil6/chat-mcp
/plugin install telegram-reader@chat-mcp
/plugin install slack-reader@chat-mcp
```

Both servers are Python. Install their dependencies once:

```
pip install -r ~/.claude/plugins/cache/chat-mcp/telegram-reader/requirements.txt
pip install -r ~/.claude/plugins/cache/chat-mcp/slack-reader/requirements.txt
```

They launch with plain `python`, so that has to be a Python 3.10+ on your PATH.

## telegram-reader

1. Get an `api_id` and `api_hash` from <https://my.telegram.org> → API development tools.
2. Set them as environment variables `TG_API_ID` / `TG_API_HASH`, or drop them in a
   `.env` next to the server (see `.env.example`).
3. Ask Claude to log you in: it calls `login_start` with your phone, you paste the code
   Telegram sends, it calls `login_complete`. One time only — the session persists.

| tool | |
|---|---|
| `login_start(phone)` / `login_complete(code, password)` | one-time login |
| `whoami()` | which account is logged in |
| `list_chats(limit, query, unread_only)` | recent chats |
| `read_chat(chat, limit, before_id)` | messages of one chat (`chat` = @username / id / name substring) |
| `search_messages(query, chat, limit)` | full-text search |
| `unread_summary(limit, per_chat)` | catch-up view |
| `send_message(chat, text)` | needs `TG_ALLOW_SEND=1` |

## slack-reader

1. Create a Slack app from `plugins/slack-reader/manifest.yaml` at
   <https://api.slack.com/apps> → Create New App → **From a manifest**.
2. Install it to each workspace you want, copying the **User OAuth Token** (`xoxp-...`)
   each time.
3. Set `SLACK_USER_TOKENS` to all of them, comma separated.

| tool | |
|---|---|
| `whoami()` | every connected workspace and who you are in each |
| `list_channels(limit, query, workspace, types)` | channels across workspaces |
| `list_dms(limit, workspace)` | DMs and group DMs |
| `read_channel(channel, limit, workspace, before_ts)` | one channel or DM |
| `read_thread(channel, thread_ts, limit, workspace)` | thread replies |
| `search_messages(query, limit, workspace)` | supports `in:#chan` `from:@user` |
| `unread_summary(limit, per_chat, workspace)` | what's unread everywhere |
| `send_message(channel, text, workspace, thread_ts)` | needs `SLACK_ALLOW_SEND=1` |

Every Slack tool takes an optional `workspace` (substring of the name). Blank acts
across all of them; it's only required when a channel name exists in more than one.

## Security

Read this before installing.

- **These act as you, not as a bot.** Anything sent shows as sent by your account.
- Sending is **off by default** in both servers. You opt in with `TG_ALLOW_SEND=1` /
  `SLACK_ALLOW_SEND=1`.
- The Telegram `tg.session` file and your Slack `xoxp-` tokens are **full account
  credentials**. Anyone who copies them has your account. They stay on your machine;
  keep them out of git (this repo's `.gitignore` covers `.env` and `*.session`).
- Credentials live in `${CLAUDE_PLUGIN_DATA}` when installed as a plugin, so a plugin
  update doesn't wipe your login.
- Automating a personal Telegram account is a *userbot*. Telegram's ToS restricts this;
  light personal read/reply use is common, bulk automation risks a ban. Your call.
- Anything Claude reads from your chats enters the model's context. Don't point this at
  accounts holding data you aren't willing to send to the model.

## License

MIT
