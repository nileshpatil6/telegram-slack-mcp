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

**Known gap:** the Node build has a `login` tool on both servers (QR device linking for
Telegram, a prompted token handover for Slack) built on MCP elicitation. The Python
build does not have these yet, so it is on 0.2.2 while npm is on 0.3.0. Porting them is
the next parity task; until then the Python servers use the phone-code flow and
`SLACK_USER_TOKENS`.

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

npm publishes through OIDC trusted publishing (`.github/workflows/publish.yml`), so no
token is stored in the repo or in CI secrets.

1. Bump `version` in `package.json`, `server.json`, `python/pyproject.toml`, both
   `plugin.json` files, and the `version` passed to `new McpServer(...)`.
2. Commit, then push a tag: `git tag v0.3.0 && git push origin v0.3.0`. The workflow
   builds, checks that both servers still register their tools, and publishes to npm.
3. Python is still manual: `cd python && python -m build && twine upload dist/*`.
4. Update the registry entry: `mcp-publisher login github && mcp-publisher publish`.
   Do this only after npm has the version `server.json` claims, or the registry will
   advertise a package that does not exist.
