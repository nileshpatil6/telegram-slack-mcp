# Contributing

Thanks for taking a look.

## Layout

```
src/            TypeScript servers (npm package `telegram-slack-mcp`)
  cli.ts        binary entrypoint, dispatches to a server
  telegram.ts   MTProto server via gramjs
  slack.ts      multi-workspace Slack server
  common.ts     data dir, env helpers, MCP result shapes
python/         Python servers (PyPI package `telegram-slack-mcp`)
plugins/        Claude Code plugin wrappers, both shell out to npx
```

The two implementations expose the **same tool names and arguments**. If you change a
tool signature in one, change it in the other, and update the tables in `README.md`.

## Build and test

```bash
npm install
npm run build
node dist/cli.js telegram      # speaks MCP on stdio
```

To check a server registers its tools, send it an `initialize` then `tools/list` over
stdio. The Telegram server takes a few seconds to start because the MTProto library is
large; give it ~10s before deciding it is broken.

## Conventions

- Tools return pretty-printed JSON through the `ok()` / `fail()` helpers.
- Every tool carries `annotations` with an honest `readOnlyHint`. Anything that writes
  must be gated behind an explicit env flag, as `send_message` is.
- No credential ever gets logged, echoed in an error, or written outside
  `CHAT_MCP_DATA_DIR`.

## Releasing

1. Bump `version` in `package.json`, `python/pyproject.toml`, both `plugin.json` files,
   and the `version` passed to `new McpServer(...)`.
2. `npm publish` and `python -m build && twine upload python/dist/*`.
3. Tag the release.
