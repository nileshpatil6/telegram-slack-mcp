import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Where credentials and sessions live. Survives package upgrades, and honours
 * CLAUDE_PLUGIN_DATA so a Claude Code plugin install keeps its login too.
 */
export function dataDir(): string {
  const dir =
    process.env.CHAT_MCP_DATA_DIR ||
    process.env.CLAUDE_PLUGIN_DATA ||
    join(homedir(), ".chat-mcp");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function readState(name: string): string {
  const f = join(dataDir(), name);
  return existsSync(f) ? readFileSync(f, "utf8").trim() : "";
}

export function writeState(name: string, value: string): void {
  writeFileSync(join(dataDir(), name), value, { mode: 0o600 });
}

export function env(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

export function flag(name: string): boolean {
  return ["1", "true", "yes", "on"].includes(env(name).toLowerCase());
}

/** MCP tool results are text blocks; everything here returns pretty JSON. */
export function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

/** An image plus a JSON metadata block, so the model both sees it and knows its source. */
export function okImage(base64: string, mimeType: string, meta: unknown) {
  return {
    content: [
      { type: "image" as const, data: base64, mimeType },
      { type: "text" as const, text: JSON.stringify(meta, null, 2) },
    ],
  };
}

export function fail(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}
