import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { WebClient } from "@slack/web-api";
import { env, flag, ok, fail } from "./common.js";

const TOKENS = (env("SLACK_USER_TOKENS") || env("SLACK_USER_TOKEN"))
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const ALLOW_SEND = flag("SLACK_ALLOW_SEND");

const SETUP =
  "No Slack tokens. Create an app at https://api.slack.com/apps (use the manifest in " +
  "the telegram-slack-mcp repo), install it to each workspace, then set SLACK_USER_TOKENS to the " +
  "User OAuth tokens (xoxp-...), comma separated.";

type Workspace = { name: string; client: WebClient; user: string; userId: string; url: string };

let cache: Workspace[] | null = null;
const userNames = new Map<string, string>();

async function all(): Promise<Workspace[]> {
  if (cache) return cache;
  if (!TOKENS.length) throw new Error(SETUP);
  const out: Workspace[] = [];
  for (const token of TOKENS) {
    const client = new WebClient(token);
    const r: any = await client.auth.test();
    out.push({ name: r.team, client, user: r.user, userId: r.user_id, url: r.url });
  }
  cache = out;
  return out;
}

/** The workspaces a call applies to: all of them, or the one matching `workspace`. */
async function pick(workspace = ""): Promise<Workspace[]> {
  const ws = await all();
  if (!workspace) return ws;
  const low = workspace.toLowerCase();
  const hit = ws.filter((w) => w.name.toLowerCase().includes(low));
  if (!hit.length) {
    throw new Error(
      `No workspace matching ${JSON.stringify(workspace)}. Have: ${ws.map((w) => w.name).join(", ")}`
    );
  }
  return hit;
}

async function userName(w: Workspace, id?: string): Promise<string> {
  if (!id) return "";
  const key = `${w.name}:${id}`;
  const hit = userNames.get(key);
  if (hit) return hit;
  let name = id;
  try {
    const r: any = await w.client.users.info({ user: id });
    name = r.user?.real_name || r.user?.name || id;
  } catch {
    /* deleted or restricted user */
  }
  userNames.set(key, name);
  return name;
}

async function fmtMessage(w: Workspace, m: any) {
  const out: Record<string, unknown> = {
    ts: m.ts,
    from: (await userName(w, m.user)) || m.username || m.bot_id || "",
    text: m.text || "",
  };
  if (m.thread_ts && m.reply_count) out.thread_replies = m.reply_count;
  if (m.files?.length) out.files = m.files.map((f: any) => f.name);
  return out;
}

type Channel = { id: string; name: string; kind: string; member: boolean };

async function channels(w: Workspace, types: string, cap = 1000): Promise<Channel[]> {
  const out: Channel[] = [];
  let cursor: string | undefined;
  do {
    const r: any = await w.client.conversations.list({
      types,
      limit: 200,
      cursor,
      exclude_archived: true,
    });
    for (const ch of r.channels ?? []) {
      const name = ch.name || (ch.is_im ? `DM:${await userName(w, ch.user)}` : ch.id);
      out.push({
        id: ch.id,
        name,
        kind: ch.is_im ? "im" : ch.is_mpim ? "mpim" : ch.is_private ? "private" : "public",
        member: ch.is_member ?? true,
      });
      if (out.length >= cap) return out;
    }
    cursor = r.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return out;
}

const ALL_TYPES = "public_channel,private_channel,im,mpim";

/** Find a channel by id, #name, or partial name, across one or every workspace. */
async function resolve(channel: string, workspace = ""): Promise<[Workspace, string]> {
  const s = channel.trim().replace(/^#/, "");
  const cands = await pick(workspace);
  if (/^[CDG][A-Z0-9]{8,}$/.test(s)) {
    for (const w of cands) {
      try {
        await w.client.conversations.info({ channel: s });
        return [w, s];
      } catch {
        /* not in this workspace */
      }
    }
  }
  const exact: [Workspace, string][] = [];
  const partial: [Workspace, string][] = [];
  for (const w of cands) {
    for (const ch of await channels(w, ALL_TYPES)) {
      const n = ch.name.toLowerCase();
      if (n === s.toLowerCase()) exact.push([w, ch.id]);
      else if (n.includes(s.toLowerCase())) partial.push([w, ch.id]);
    }
  }
  const hits = exact.length ? exact : partial;
  if (!hits.length) throw new Error(`No channel matching ${JSON.stringify(channel)}`);
  if (hits.length > 1 && !workspace) {
    throw new Error(
      `${JSON.stringify(channel)} exists in several workspaces: ` +
        `${hits.map((h) => h[0].name).join(", ")}. Pass workspace to pick one.`
    );
  }
  return hits[0];
}

const WORKSPACE_ARG = z
  .string()
  .default("")
  .describe("Substring of a workspace name. Blank acts across all connected workspaces.");

export function buildSlackServer(): McpServer {
  const server = new McpServer({ name: "telegram-slack-mcp:slack", version: "0.2.0" });

  server.registerTool(
    "whoami",
    {
      title: "Slack workspaces",
      description: "List every connected Slack workspace and who you are in each.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const ws = await all();
        return ok(
          ws.map((w) => ({ workspace: w.name, user: w.user, user_id: w.userId, url: w.url }))
        );
      } catch (e: any) {
        return fail(e?.message ?? String(e));
      }
    }
  );

  server.registerTool(
    "list_channels",
    {
      title: "List Slack channels",
      description: "List channels across all connected workspaces, or just one.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).default(100),
        query: z.string().default("").describe("Case-insensitive substring filter on name"),
        workspace: WORKSPACE_ARG,
        types: z.string().default("public_channel,private_channel"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ limit, query, workspace, types }) => {
      try {
        const low = query.toLowerCase();
        const out: unknown[] = [];
        for (const w of await pick(workspace)) {
          for (const ch of await channels(w, types)) {
            if (low && !ch.name.toLowerCase().includes(low)) continue;
            out.push({ workspace: w.name, ...ch });
            if (out.length >= limit) return ok(out);
          }
        }
        return ok(out);
      } catch (e: any) {
        return fail(e?.message ?? String(e));
      }
    }
  );

  server.registerTool(
    "list_dms",
    {
      title: "List Slack DMs",
      description: "List your direct-message conversations (1:1 and group DMs).",
      inputSchema: {
        limit: z.number().int().min(1).max(500).default(50),
        workspace: WORKSPACE_ARG,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ limit, workspace }) => {
      try {
        const out: unknown[] = [];
        for (const w of await pick(workspace)) {
          for (const ch of await channels(w, "im,mpim")) {
            out.push({ workspace: w.name, ...ch });
            if (out.length >= limit) return ok(out);
          }
        }
        return ok(out);
      } catch (e: any) {
        return fail(e?.message ?? String(e));
      }
    }
  );

  server.registerTool(
    "read_channel",
    {
      title: "Read a Slack channel",
      description:
        "Read recent messages of a channel or DM. `channel` accepts an id, #name, or part of a name.",
      inputSchema: {
        channel: z.string(),
        limit: z.number().int().min(1).max(200).default(50),
        workspace: WORKSPACE_ARG,
        before_ts: z.string().default("").describe("Paginate older with the oldest ts you have"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ channel, limit, workspace, before_ts }) => {
      try {
        const [w, id] = await resolve(channel, workspace);
        const args: any = { channel: id, limit };
        if (before_ts) args.latest = before_ts;
        const r: any = await w.client.conversations.history(args);
        const msgs = [];
        for (const m of r.messages ?? []) msgs.push(await fmtMessage(w, m));
        msgs.reverse();
        return ok({ workspace: w.name, channel, id, messages: msgs });
      } catch (e: any) {
        return fail(e?.message ?? String(e));
      }
    }
  );

  server.registerTool(
    "read_thread",
    {
      title: "Read a Slack thread",
      description: "Read the replies of one thread. `thread_ts` is the parent message's ts.",
      inputSchema: {
        channel: z.string(),
        thread_ts: z.string(),
        limit: z.number().int().min(1).max(200).default(50),
        workspace: WORKSPACE_ARG,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ channel, thread_ts, limit, workspace }) => {
      try {
        const [w, id] = await resolve(channel, workspace);
        const r: any = await w.client.conversations.replies({ channel: id, ts: thread_ts, limit });
        const msgs = [];
        for (const m of r.messages ?? []) msgs.push(await fmtMessage(w, m));
        return ok({ workspace: w.name, messages: msgs });
      } catch (e: any) {
        return fail(e?.message ?? String(e));
      }
    }
  );

  server.registerTool(
    "search_messages",
    {
      title: "Search Slack",
      description:
        "Search messages across every connected workspace. Supports Slack modifiers like in:#channel and from:@user.",
      inputSchema: {
        query: z.string(),
        limit: z.number().int().min(1).max(100).default(20),
        workspace: WORKSPACE_ARG,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, limit, workspace }) => {
      try {
        const out: unknown[] = [];
        for (const w of await pick(workspace)) {
          try {
            const r: any = await w.client.search.messages({ query, count: limit });
            for (const m of r.messages?.matches ?? []) {
              out.push({
                workspace: w.name,
                ts: m.ts,
                channel: m.channel?.name,
                from: m.username || (await userName(w, m.user)),
                text: m.text || "",
                permalink: m.permalink,
              });
            }
          } catch (e: any) {
            out.push({ workspace: w.name, error: e?.data?.error ?? e?.message ?? String(e) });
          }
        }
        return ok(out);
      } catch (e: any) {
        return fail(e?.message ?? String(e));
      }
    }
  );

  server.registerTool(
    "unread_summary",
    {
      title: "Slack unread summary",
      description: "Show channels and DMs with unread messages, across all workspaces.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20),
        per_chat: z.number().int().min(1).max(50).default(10),
        workspace: WORKSPACE_ARG,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ limit, per_chat, workspace }) => {
      try {
        const out: unknown[] = [];
        for (const w of await pick(workspace)) {
          for (const ch of await channels(w, ALL_TYPES)) {
            if (!ch.member) continue;
            try {
              const info: any = await w.client.conversations.info({ channel: ch.id });
              const lastRead = info.channel?.last_read;
              if (!lastRead) continue;
              const h: any = await w.client.conversations.history({
                channel: ch.id,
                oldest: lastRead,
                limit: per_chat,
              });
              const msgs = [];
              for (const m of h.messages ?? []) {
                if (m.ts !== lastRead) msgs.push(await fmtMessage(w, m));
              }
              if (!msgs.length) continue;
              msgs.reverse();
              out.push({
                workspace: w.name,
                channel: ch.name,
                kind: ch.kind,
                unread: msgs.length,
                messages: msgs,
              });
              if (out.length >= limit) return ok(out);
            } catch {
              /* channel we cannot inspect */
            }
          }
        }
        return ok(out);
      } catch (e: any) {
        return fail(e?.message ?? String(e));
      }
    }
  );

  server.registerTool(
    "send_message",
    {
      title: "Send a Slack message",
      description:
        "Post a message as yourself. Set thread_ts to reply in a thread. Disabled unless SLACK_ALLOW_SEND=1.",
      inputSchema: {
        channel: z.string(),
        text: z.string(),
        workspace: WORKSPACE_ARG,
        thread_ts: z.string().default(""),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ channel, text, workspace, thread_ts }) => {
      try {
        if (!ALLOW_SEND) return fail("Sending is disabled. Set SLACK_ALLOW_SEND=1 to enable.");
        const [w, id] = await resolve(channel, workspace);
        const args: any = { channel: id, text };
        if (thread_ts) args.thread_ts = thread_ts;
        const r: any = await w.client.chat.postMessage(args);
        return ok({ sent: true, workspace: w.name, channel, ts: r.ts });
      } catch (e: any) {
        return fail(e?.message ?? String(e));
      }
    }
  );

  return server;
}

export async function runSlack(): Promise<void> {
  const server = buildSlackServer();
  await server.connect(new StdioServerTransport());
}
