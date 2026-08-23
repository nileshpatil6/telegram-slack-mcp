# Security

## What this software can do

`telegram-slack-mcp` authenticates as **you** — not as a bot. With a valid session it can read
every conversation your account can read, and, when sending is enabled, post messages
that are indistinguishable from ones you typed.

## Privacy boundary

This project has **no server**. Nothing is collected, transmitted, or shared with the
author or any third party. The only outbound connections are to Telegram's and Slack's
official APIs, authenticated with your own credentials.

- **Credentials stay local.** The Telegram session and Slack tokens never leave your
  machine and are never sent to Claude.
- **Chat content goes only where you ask.** When Claude calls a read tool, the returned
  messages enter your Claude conversation, governed by Anthropic's privacy policy — the
  same as pasting text yourself. The servers are passive; they read nothing unless a
  tool is called.
- **No background activity.** No polling, no sync, no daemon.

## Where credentials live

| what | where |
|---|---|
| Telegram session | `$CHAT_MCP_DATA_DIR/telegram.session` (default `~/.chat-mcp`), mode `600` |
| Telegram api_id / api_hash | environment variables you set |
| Slack user tokens | environment variables you set |

Nothing is transmitted anywhere except to Telegram's and Slack's own APIs. There is no
telemetry, no analytics, and no remote endpoint in this codebase.

**Treat the session file and the `xoxp-` tokens as passwords.** Anyone who copies them
is logged in as you, and they remain valid until you revoke them.

## Revoking access

- **Telegram**: Settings → Devices → terminate the session. Then delete
  `~/.chat-mcp/telegram.session`.
- **Slack**: <https://api.slack.com/apps> → your app → OAuth & Permissions → revoke, or
  remove the app from the workspace.

## Safe defaults

Sending is disabled unless you set `TELEGRAM_ALLOW_SEND=1` / `SLACK_ALLOW_SEND=1`. Read
tools are annotated `readOnlyHint: true` so MCP clients can surface the difference.

## Things to be aware of

- **Model context**: anything Claude reads from your chats becomes part of the model's
  context for that conversation. Don't connect accounts holding data you would not send
  to a model.
- **Prompt injection**: message content is untrusted input. A message in a group chat
  can contain text aimed at an AI agent reading it. Treat what these tools return as
  data, never as instructions.
- **Telegram ToS**: automating a personal account is a *userbot*, which Telegram
  restricts. Light personal use is common; bulk automation risks a ban.

## Reporting a vulnerability

Open an issue at <https://github.com/nileshpatil6/telegram-slack-mcp/issues>. For anything
sensitive, say so in the issue without details and a private channel will be arranged.
