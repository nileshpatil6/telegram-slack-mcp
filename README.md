<div align="center">

# telegram-slack-mcp

**Give Claude your actual chats.**

Two MCP servers that connect Claude to your *personal* Telegram and Slack accounts —
your real DMs, groups, and channels, not a bot inbox.

[![npm](https://img.shields.io/npm/v/telegram-slack-mcp?color=cb3837&logo=npm)](https://www.npmjs.com/package/telegram-slack-mcp)
[![PyPI](https://img.shields.io/pypi/v/telegram-slack-mcp?color=3775a9&logo=pypi&logoColor=white)](https://pypi.org/project/telegram-slack-mcp/)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

</div>

```bash
claude mcp add telegram -- npx -y telegram-slack-mcp telegram
claude mcp add slack    -- npx -y telegram-slack-mcp slack
```

Then just talk:

> *"what's unread on telegram from actual people?"*
> *"read my last 30 messages with Priya and draft a reply"*
> *"search all my slack workspaces for the deploy postmortem"*
> *"what's in the screenshot Priya sent me?"*

---

## Why this exists

Most Telegram integrations use the **Bot API**, which only sees messages sent *to a bot
you created*. It cannot read your existing conversations. `telegram-slack-mcp` uses **MTProto**,
the same protocol the official app uses, authenticating as you — so Claude sees the
chats you actually have.

For Slack, the usual connector is scoped to one workspace. `telegram-slack-mcp` takes one user
token per workspace and treats them as a single surface, so "search everywhere" means
everywhere.

## Install

Pick whichever runtime you already have. Both ship the same tools.

### Node

```bash
claude mcp add telegram -- npx -y telegram-slack-mcp telegram
claude mcp add slack    -- npx -y telegram-slack-mcp slack
```

### Python

```bash
claude mcp add telegram -- uvx telegram-slack-mcp telegram
claude mcp add slack    -- uvx telegram-slack-mcp slack
```

### Claude Code plugin

```
/plugin marketplace add nileshpatil6/telegram-slack-mcp
/plugin install telegram@telegram-slack-mcp
/plugin install slack@telegram-slack-mcp
```

<details>
<summary>Other MCP clients (Claude Desktop, Cursor, …)</summary>

```json
{
  "mcpServers": {
    "telegram": {
      "command": "npx",
      "args": ["-y", "telegram-slack-mcp", "telegram"],
      "env": { "TELEGRAM_API_ID": "1234567", "TELEGRAM_API_HASH": "your_hash" }
    },
    "slack": {
      "command": "npx",
      "args": ["-y", "telegram-slack-mcp", "slack"],
      "env": { "SLACK_USER_TOKENS": "xoxp-one,xoxp-two" }
    }
  }
}
```

</details>

## Setup

### Telegram — 2 minutes

1. Go to <https://my.telegram.org> → **API development tools** → create an app.
2. Copy the `api_id` and `api_hash`, and set them:

   ```bash
   claude mcp add telegram      -e TELEGRAM_API_ID=1234567      -e TELEGRAM_API_HASH=your_hash      -- npx -y telegram-slack-mcp telegram
   ```

3. Ask Claude: **"log into telegram"**

   It calls `login`, which opens a page with a QR code. Scan it from Telegram on your
   phone — **Settings → Devices → Link Desktop Device** — and you're in. No phone number,
   no SMS code, no 2FA password typed anywhere. On the same machine you can click
   "open in Telegram Desktop" instead of scanning.

   The session is saved to `~/.chat-mcp` and persists; you do this once.

<details>
<summary>Can't scan? Use the phone-number flow</summary>

`login_start(phone)` sends you a code, `login_complete(code, password?)` finishes.
Note that with this path your phone number and login code pass through the conversation
as tool arguments, so they land in the model's context. The QR flow keeps them out of it.

</details>

### Slack — 5 minutes

1. Go to <https://api.slack.com/apps> → **Create New App** → **From a manifest**.
2. Paste [`slack-app-manifest.yaml`](slack-app-manifest.yaml) — it prefills every scope.
3. **Install to Workspace**, then copy the **User OAuth Token** (`xoxp-…`, not `xoxb-`).
4. Repeat step 3 for each workspace you want. Same app, one token each.
5. Ask Claude: **"connect my slack"** — the `login` tool prompts for the tokens, verifies
   each one against Slack, and saves them to `~/.chat-mcp`. Nothing to put in your config.

   Prefer environment variables? That still works:

   ```bash
   claude mcp add slack -e SLACK_USER_TOKENS=xoxp-aaa,xoxp-bbb -- npx -y telegram-slack-mcp slack
   ```

Slack has no local OAuth flow, which is why you create the app yourself: Slack's OAuth
requires a client secret and an HTTPS redirect URL, so a package distributed over npm
cannot complete it without either shipping a secret publicly or running a callback
server. This project has no server, so it asks for the token instead.

## Tools

### Telegram

| tool | what it does |
|---|---|
| `login()` | **scan a QR to link your account** — no phone number or code |
| `login_start(phone)` | fallback: send yourself a login code |
| `login_complete(code, password?)` | finish login, save the session |
| `whoami()` | which account is connected |
| `list_chats(limit, query, unread_only, kind)` | recent chats; `kind` filters to `dm`, `group`, `channel`, `bot`… |
| `read_chat(chat, limit, before_id)` | messages of one chat — `chat` takes @username, id, or part of a name |
| `search_messages(query, chat?, limit)` | full-text search, one chat or all |
| `unread_summary(limit, per_chat, kind)` | catch-up view; `kind: "dm"` skips the channel noise |
| `read_media(chat, message_id, max_kb)` | **view a photo or file** — returns the actual image, not just its type |
| `send_message(chat, text, reply_to?)` | reply as you — **off unless `TELEGRAM_ALLOW_SEND=1`** |

### Slack

| tool | what it does |
|---|---|
| `login()` | prompts for your `xoxp-` tokens, verifies them, saves them |
| `whoami()` | every connected workspace and who you are in each |
| `list_channels(limit, query, workspace, types)` | channels across workspaces |
| `list_dms(limit, workspace)` | 1:1 and group DMs |
| `read_channel(channel, limit, workspace, before_ts)` | one channel or DM |
| `read_thread(channel, thread_ts, limit, workspace)` | replies inside a thread |
| `search_messages(query, limit, workspace)` | supports `in:#chan`, `from:@user` |
| `unread_summary(limit, per_chat, workspace)` | what's unread everywhere |
| `read_file(file_id, workspace, max_kb)` | **view a file shared in Slack** — returns the actual image |
| `send_message(channel, text, workspace, thread_ts?)` | post as you — **off unless `SLACK_ALLOW_SEND=1`** |

Every Slack tool takes an optional **`workspace`** (any substring of the name). Leave it
blank to act across all of them; it's only required when a channel name exists in more
than one, and the error tells you which.

## Configuration

| variable | default | meaning |
|---|---|---|
| `TELEGRAM_API_ID` | — | from my.telegram.org |
| `TELEGRAM_API_HASH` | — | from my.telegram.org |
| `TELEGRAM_ALLOW_SEND` | `0` | `1` lets Claude send Telegram messages as you |
| `SLACK_USER_TOKENS` | — | one `xoxp-` token per workspace, comma separated |
| `SLACK_ALLOW_SEND` | `0` | `1` lets Claude post to Slack as you |
| `CHAT_MCP_DATA_DIR` | `~/.chat-mcp` | where the Telegram session is stored |

Sending is **off by default** in both servers. Reading is the safe default; you opt into
writing deliberately.

## Privacy

**Nothing is sent to any server belonging to this project. There is no such server.**

`telegram-slack-mcp` runs entirely on your machine. The only network traffic it makes is directly
to Telegram's and Slack's own APIs, using your own credentials. There is no telemetry,
no analytics, no crash reporting, no license check, no "phone home" — grep the source,
there is no endpoint to find.

The data path is exactly this:

```
your machine  <-->  Telegram / Slack APIs      (your credentials, your account)
your machine  <-->  Claude                     (only what you ask Claude to read)
```

Your credentials never reach Claude. Your session file and `xoxp-` tokens stay in
`~/.chat-mcp` and in your environment; the servers use them locally to make API calls
and pass back only the messages themselves.

What *does* reach Claude is the chat content you ask about — because that is the point
of the tool. If you ask Claude to read a conversation, that conversation goes into your
Claude conversation and is handled under Anthropic's privacy policy, exactly like text
you paste in yourself. Nothing else is read, and nothing is read in the background: the
servers only act when Claude calls a tool.

The author of this project cannot see any of it.

## Security

Read this part.

- **These act as you, not as a bot.** Anything sent shows as sent by your account, and
  people in those chats cannot tell the difference.
- **The stored session is a full credential.** `~/.chat-mcp/telegram.session` and your
  `xoxp-` tokens are equivalent to being logged in as you. Anyone who copies them has
  your account. They never leave your machine, and nothing here phones home.
- **Everything Claude reads enters the model's context.** Don't point this at accounts
  holding data you would not send to a model.
- **Telegram calls this a userbot.** Automating a personal account is restricted by
  Telegram's ToS. Light personal read-and-reply use is common and low risk; bulk
  automation gets accounts banned. Your call, your account.
- Revoke any time: Telegram → Settings → Devices, or delete the token in Slack's app
  settings. Deleting `~/.chat-mcp` drops the local session.

## Troubleshooting

**"Telegram not logged in yet"** — run the login flow: ask Claude to log in with your
phone number. It persists after that; if it keeps reappearing, check that
`CHAT_MCP_DATA_DIR` is writable.

**"Missing Telegram credentials"** — `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` aren't
reaching the server. With `claude mcp add`, pass them with `-e`.

**Slack returns nothing at all** — you're almost certainly authorized against an empty
or wrong workspace. Run `whoami` to see which workspaces are actually connected.

**`"#general" exists in several workspaces`** — pass `workspace` to disambiguate; the
error lists your options.

**Slack search returns `not_allowed_token_type`** — the token is a bot token (`xoxb-`).
You need the **User** OAuth token (`xoxp-`).

## Development

```bash
git clone https://github.com/nileshpatil6/telegram-slack-mcp
cd telegram-slack-mcp
npm install && npm run build
node dist/cli.js telegram        # run the server on stdio

cd python && python -m build     # build the Python distribution
```

## License

MIT
