import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { TelegramClient, Api } from "teleproto";
import { StringSession } from "teleproto/sessions";
import { computeCheck } from "teleproto/Password";
import { env, flag, ok, okImage, fail, readState, writeState } from "./common.js";
import { serveQrPage, qrAsText, loginUrl } from "./tg-login.js";

const SESSION_FILE = "telegram.session";
const API_ID = Number(env("TELEGRAM_API_ID") || env("TG_API_ID") || 0);
const API_HASH = env("TELEGRAM_API_HASH") || env("TG_API_HASH");
const ALLOW_SEND = flag("TELEGRAM_ALLOW_SEND") || flag("TG_ALLOW_SEND");

const SETUP =
  "Missing Telegram credentials. Get an api_id and api_hash from https://my.telegram.org " +
  "(API development tools) and set TELEGRAM_API_ID and TELEGRAM_API_HASH.";

let client: TelegramClient | null = null;
let pending: { phone: string; hash: string } | null = null;

async function connect(): Promise<TelegramClient> {
  if (client) return client;
  if (!API_ID || !API_HASH) throw new Error(SETUP);
  const c = new TelegramClient(new StringSession(readState(SESSION_FILE)), API_ID, API_HASH, {
    connectionRetries: 3,
  });
  await c.connect();
  client = c;
  return c;
}

async function authed(): Promise<TelegramClient> {
  const c = await connect();
  if (!(await c.isUserAuthorized())) {
    throw new Error(
      "Telegram not logged in yet. Call the `login` tool, which shows a QR code the user " +
        "scans from Telegram: Settings, Devices, Link Desktop Device. Only if they cannot " +
        "scan, fall back to login_start with their phone number then login_complete."
    );
  }
  return c;
}

function save(c: TelegramClient) {
  writeState(SESSION_FILE, String(c.session.save()));
}

function entityName(e: any): string {
  if (!e) return "";
  if (e.className === "User" || e.firstName !== undefined) {
    const n = [e.firstName, e.lastName].filter(Boolean).join(" ") || "(no name)";
    return e.username ? `${n} (@${e.username})` : n;
  }
  return e.title || "(unknown)";
}

function entityKind(e: any): string {
  if (!e) return "unknown";
  if (e.className === "User") return e.bot ? "bot" : "dm";
  if (e.className === "Chat") return "group";
  if (e.className === "Channel") return e.broadcast ? "channel" : "supergroup";
  return "unknown";
}

function iso(seconds?: number): string | null {
  return seconds ? new Date(seconds * 1000).toISOString() : null;
}

async function fmtMessage(m: any) {
  let from: string | null = null;
  try {
    const s = await m.getSender();
    from = s ? entityName(s) : null;
  } catch {
    /* sender may be unavailable in channels */
  }
  const out: Record<string, unknown> = {
    id: m.id,
    date: iso(m.date),
    from,
    out: Boolean(m.out),
    text: m.message || "",
  };
  if (m.media) {
    const { kind, mime } = mediaInfo(m);
    out.media = { kind, mime, hint: "call read_media with this message id to view it" };
    if (!m.message) out.text = `[${kind}]`;
  }
  if (m.replyTo?.replyToMsgId) out.reply_to = m.replyTo.replyToMsgId;
  return out;
}

/** Resolve @username, numeric id, or part of a chat name to an entity. */
async function resolve(c: TelegramClient, chat: string): Promise<any> {
  const s = String(chat).trim();
  try {
    return await c.getEntity(s);
  } catch {
    /* fall through to a name scan */
  }
  const low = s.toLowerCase();
  for (const d of await c.getDialogs({ limit: 500 })) {
    if ((d.name || "").toLowerCase().includes(low)) return d.entity;
  }
  throw new Error(`No chat matching ${JSON.stringify(chat)}`);
}

/** What kind of media a message carries, and the mime type to report for it. */
function mediaInfo(m: any): { kind: string; mime: string } {
  const media = m?.media;
  if (!media) return { kind: "none", mime: "" };
  if (media.className === "MessageMediaPhoto") return { kind: "photo", mime: "image/jpeg" };
  if (media.className === "MessageMediaDocument") {
    const doc = media.document;
    const mime = doc?.mimeType || "application/octet-stream";
    const isSticker = (doc?.attributes ?? []).some(
      (a: any) => a.className === "DocumentAttributeSticker"
    );
    return { kind: isSticker ? "sticker" : mime.startsWith("image/") ? "image" : "document", mime };
  }
  return { kind: media.className || "media", mime: "" };
}

/**
 * Telegram stores several sizes per photo. Pick the largest that fits the budget
 * rather than downloading the original and shrinking it, which would need an
 * image library and a much larger transfer.
 */
function pickSize(m: any, maxBytes: number): any | undefined {
  const sizes: any[] =
    m?.media?.photo?.sizes ?? m?.media?.document?.thumbs ?? [];
  const usable = sizes.filter(
    (x) => x.className === "PhotoSize" && typeof x.size === "number"
  );
  if (!usable.length) return undefined;
  const fits = usable.filter((x) => x.size <= maxBytes).sort((a, b) => b.size - a.size);
  return fits[0] ?? usable.slice().sort((a, b) => a.size - b.size)[0];
}

/**
 * A QR login in progress. The scan, not any dialog, is what completes it, so the
 * flow runs in the background and `login_status` reports on it. Nothing here
 * depends on the client supporting elicitation: `login` hands back a URL and an
 * ASCII code directly, which works in every MCP client.
 */
type QrFlow = {
  qr: Awaited<ReturnType<typeof serveQrPage>>;
  ascii: string;
  settled: boolean;
  user?: any;
  error?: string;
};

let flow: QrFlow | null = null;

function flowInstructions() {
  return {
    open_this: flow?.qr.url,
    qr_code: flow?.ascii,
    instructions:
      "Show the user the URL above (or the QR text). They scan it in Telegram: " +
      "Settings, then Devices, then Link Desktop Device. Then call login_status.",
    expires: "The code rotates automatically; the page always shows a current one.",
  };
}

async function startQrFlow(server: McpServer): Promise<void> {
  const c = await connect();
  const qr = await serveQrPage();
  const state: QrFlow = { qr, ascii: "", settled: false };
  flow = state;

  const signIn = c.signInUserWithQrCode(
    { apiId: API_ID, apiHash: API_HASH },
    {
      qrCode: async (token) => {
        // Telegram rotates the token; the page refreshes itself to match.
        await qr.setToken(token.token);
        if (!state.ascii) state.ascii = await qrAsText(loginUrl(token.token));
      },
      password: async (hint) => {
        const asked = await server.server.elicitInput({
          message: hint
            ? `This Telegram account has two-step verification. Hint: ${hint}`
            : "This Telegram account has two-step verification. Enter your cloud password.",
          requestedSchema: {
            type: "object",
            properties: {
              password: {
                type: "string",
                title: "Telegram cloud password",
                description: "Your two-step verification password",
              },
            },
            required: ["password"],
          },
        });
        if (asked.action !== "accept") throw new Error("Password entry cancelled.");
        return String((asked.content as any)?.password ?? "");
      },
      onError: async (e) => String(e?.message ?? e).includes("AbortError"),
    }
  );

  signIn
    .then((me: any) => {
      save(c);
      state.user = me;
      state.settled = true;
      qr.markDone();
      setTimeout(() => qr.close(), 30_000);
    })
    .catch((e: any) => {
      state.error = e?.message ?? String(e);
      qr.close();
    });

  // Offer the page through the client too, when it supports that. Best effort:
  // the URL is already in the tool result, so a client that ignores this loses
  // nothing.
  server.server
    .elicitInput({
      mode: "url",
      message: "Scan this QR from Telegram: Settings, Devices, Link Desktop Device.",
      elicitationId: `tg-login-${Date.now()}`,
      url: qr.url,
    })
    .catch(() => undefined);

  // Let the first token arrive so the URL and ASCII code are populated.
  for (let i = 0; i < 40 && !state.ascii && !state.error; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

export function buildTelegramServer(): McpServer {
  const server = new McpServer({ name: "telegram-slack-mcp:telegram", version: "0.5.0" });


  server.registerTool(
    "login",
    {
      title: "Link Telegram",
      description:
        "Start QR login, the way Telegram's own desktop linking works. Returns a URL to open " +
        "plus the code as text; the user scans it from Telegram (Settings, Devices, Link " +
        "Desktop Device), then you call login_status. No phone number and no code to type.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async () => {
      try {
        const c = await connect();
        if (await c.isUserAuthorized()) return ok({ already_logged_in: true });

        // An unfinished attempt is reusable: the page reflects the rotating token.
        if (flow && !flow.settled) {
          return ok({ ...flowInstructions(), note: "A login is already waiting for a scan." });
        }

        await startQrFlow(server);
        return ok(flowInstructions());
      } catch (e: any) {
        return fail(e?.message ?? String(e));
      }
    }
  );

  server.registerTool(
    "login_status",
    {
      title: "Check Telegram login",
      description:
        "Check whether the QR from `login` has been scanned yet. Call this after telling the " +
        "user to scan; if it reports waiting, give them a moment and check again.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        if (!flow) return fail("No login in progress. Call `login` first.");
        if (flow.error) {
          const msg = flow.error;
          flow = null;
          return fail(msg + " Call `login` to start over.");
        }
        if (!flow.settled) {
          return ok({ ...flowInstructions(), status: "waiting for the scan" });
        }
        const me: any = flow.user;
        flow = null;
        return ok({
          logged_in: true,
          as: entityName(me),
          id: String(me.id),
          method: "qr",
          note: "Session saved. This login is permanent, no need to repeat.",
        });
      } catch (e: any) {
        return fail(e?.message ?? String(e));
      }
    }
  );

  server.registerTool(
    "login_start",
    {
      title: "Start Telegram login",
      description:
        "Step 1 of login: send a Telegram login code to a phone number in international format (e.g. +9198...).",
      inputSchema: { phone: z.string().describe("Phone number in international format") },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ phone }) => {
      try {
        const c = await connect();
        if (await c.isUserAuthorized()) return ok({ already_logged_in: true });
        const sent = await c.sendCode({ apiId: API_ID, apiHash: API_HASH }, phone);
        pending = { phone, hash: sent.phoneCodeHash };
        return ok({
          sent: true,
          phone,
          next: "Ask the user for the code Telegram just sent, then call login_complete.",
        });
      } catch (e: any) {
        return fail(e?.message ?? String(e));
      }
    }
  );

  server.registerTool(
    "login_complete",
    {
      title: "Finish Telegram login",
      description:
        "Step 2 of login: submit the code Telegram sent, plus the cloud password if the account has 2FA.",
      inputSchema: {
        code: z.string().describe("The login code Telegram sent"),
        password: z.string().optional().describe("2FA cloud password, only if enabled"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ code, password }) => {
      try {
        if (!pending) return fail("Call login_start first.");
        const c = await connect();
        try {
          await c.invoke(
            new Api.auth.SignIn({
              phoneNumber: pending.phone,
              phoneCodeHash: pending.hash,
              phoneCode: code.trim(),
            })
          );
        } catch (e: any) {
          if (!String(e?.errorMessage).includes("SESSION_PASSWORD_NEEDED")) throw e;
          if (!password) {
            return fail(
              "This account has 2FA. Ask the user for their Telegram cloud password, " +
                "then call login_complete again with the same code and the password."
            );
          }
          const pwd = await c.invoke(new Api.account.GetPassword());
          await c.invoke(
            new Api.auth.CheckPassword({ password: await computeCheck(pwd, password) })
          );
        }
        save(c);
        pending = null;
        const me: any = await c.getMe();
        return ok({
          logged_in: true,
          as: entityName(me),
          id: String(me.id),
          note: "Session saved. This login is permanent, no need to repeat.",
        });
      } catch (e: any) {
        return fail(e?.message ?? String(e));
      }
    }
  );

  server.registerTool(
    "whoami",
    {
      title: "Telegram account",
      description: "Show which Telegram account this server is logged in as.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const me: any = await (await authed()).getMe();
        return ok({ id: String(me.id), name: entityName(me), phone: me.phone });
      } catch (e: any) {
        return fail(e?.message ?? String(e));
      }
    }
  );

  server.registerTool(
    "list_chats",
    {
      title: "List Telegram chats",
      description:
        "List recent chats (DMs, groups, channels), newest activity first, with unread counts.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).default(40),
        query: z.string().default("").describe("Case-insensitive substring filter on chat name"),
        unread_only: z.boolean().default(false),
        kind: z
          .enum(["all", "dm", "bot", "group", "supergroup", "channel"])
          .default("all")
          .describe("Filter by chat type"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ limit, query, unread_only, kind }) => {
      try {
        const c = await authed();
        const low = query.toLowerCase();
        const out: unknown[] = [];
        for (const d of await c.getDialogs({ limit: 500 })) {
          if (low && !(d.name || "").toLowerCase().includes(low)) continue;
          if (unread_only && !d.unreadCount) continue;
          const k = entityKind(d.entity);
          if (kind !== "all" && k !== kind) continue;
          out.push({
            id: String(d.id),
            name: d.name,
            kind: k,
            unread: d.unreadCount,
            last_date: iso(d.date),
            last_message: (d.message?.message || "").slice(0, 160),
          });
          if (out.length >= limit) break;
        }
        return ok(out);
      } catch (e: any) {
        return fail(e?.message ?? String(e));
      }
    }
  );

  server.registerTool(
    "read_chat",
    {
      title: "Read a Telegram chat",
      description:
        "Read the most recent messages of one chat. `chat` accepts @username, numeric id, or part of the chat name.",
      inputSchema: {
        chat: z.string(),
        limit: z.number().int().min(1).max(200).default(30),
        before_id: z
          .number()
          .int()
          .default(0)
          .describe("Paginate older by passing the smallest id you already have"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ chat, limit, before_id }) => {
      try {
        const c = await authed();
        const e = await resolve(c, chat);
        const params: any = { limit };
        if (before_id) params.maxId = before_id;
        const msgs = await c.getMessages(e, params);
        const items = [];
        for (const m of msgs) items.push(await fmtMessage(m));
        items.reverse();
        return ok({ chat: entityName(e), kind: entityKind(e), messages: items });
      } catch (err: any) {
        return fail(err?.message ?? String(err));
      }
    }
  );

  server.registerTool(
    "search_messages",
    {
      title: "Search Telegram messages",
      description:
        "Full-text search across messages. Searches one chat when `chat` is given, otherwise everywhere.",
      inputSchema: {
        query: z.string(),
        chat: z.string().default(""),
        limit: z.number().int().min(1).max(100).default(30),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, chat, limit }) => {
      try {
        const c = await authed();
        const target = chat ? await resolve(c, chat) : undefined;
        const msgs = await c.getMessages(target as any, { search: query, limit });
        const out = [];
        for (const m of msgs) {
          const d: any = await fmtMessage(m);
          try {
            d.chat = entityName(await m.getChat());
          } catch {
            /* chat may be unavailable */
          }
          out.push(d);
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
      title: "Telegram unread summary",
      description: "Show unread messages across chats so you can catch up at a glance.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20),
        per_chat: z.number().int().min(1).max(50).default(10),
        kind: z
          .enum(["all", "dm", "bot", "group", "supergroup", "channel"])
          .default("all")
          .describe("Filter by chat type, e.g. 'dm' for real people only"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ limit, per_chat, kind }) => {
      try {
        const c = await authed();
        const out: unknown[] = [];
        for (const d of await c.getDialogs({ limit: 500 })) {
          if (!d.unreadCount) continue;
          const k = entityKind(d.entity);
          if (kind !== "all" && k !== kind) continue;
          const msgs = await c.getMessages(d.entity, {
            limit: Math.min(d.unreadCount, per_chat),
          });
          const items = [];
          for (const m of msgs) items.push(await fmtMessage(m));
          items.reverse();
          out.push({ chat: d.name, kind: k, unread: d.unreadCount, messages: items });
          if (out.length >= limit) break;
        }
        return ok(out);
      } catch (e: any) {
        return fail(e?.message ?? String(e));
      }
    }
  );


  server.registerTool(
    "read_media",
    {
      title: "View a photo or file from a chat",
      description:
        "Download the media attached to one message and return it, so images can actually be " +
        "seen rather than just named. Use the message id from read_chat or search_messages. " +
        "Photos are fetched at the largest size that fits within max_kb.",
      inputSchema: {
        chat: z.string().describe("@username, numeric id, or part of the chat name"),
        message_id: z.number().int().describe("Message id, as returned by read_chat"),
        max_kb: z
          .number()
          .int()
          .min(16)
          .max(4096)
          .default(800)
          .describe("Size budget. Bigger images cost proportionally more context."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ chat, message_id, max_kb }) => {
      try {
        const c = await authed();
        const e = await resolve(c, chat);
        const found: any[] = await c.getMessages(e, { ids: [message_id] });
        const m: any = found?.[0];
        if (!m) return fail(`No message with id ${message_id} in that chat.`);
        if (!m.media) return fail(`Message ${message_id} has no media attached.`);

        const maxBytes = max_kb * 1024;
        const { kind, mime } = mediaInfo(m);
        const thumb = pickSize(m, maxBytes);

        const buf = await c.downloadMedia(m, thumb ? { thumb } : {});
        if (!buf || typeof buf === "string" || !buf.length) {
          return fail("Telegram returned no bytes for that media.");
        }
        if (buf.length > maxBytes) {
          return fail(
            `That media is ${Math.round(buf.length / 1024)}KB, over the ${max_kb}KB budget. ` +
              "Raise max_kb if you want it anyway."
          );
        }

        const meta = {
          chat: entityName(e),
          message_id,
          kind,
          mime,
          bytes: buf.length,
          caption: m.message || "",
          date: iso(m.date),
        };

        if (mime.startsWith("image/")) {
          return okImage(buf.toString("base64"), mime, meta);
        }
        if (mime.startsWith("text/") || mime === "application/json") {
          return ok({ ...meta, text: buf.toString("utf8").slice(0, 20000) });
        }
        return fail(
          `That is a ${mime} file (${Math.round(buf.length / 1024)}KB), which cannot be shown ` +
            "inline. Only images and text files can be read directly."
        );
      } catch (e: any) {
        return fail(e?.message ?? String(e));
      }
    }
  );

  server.registerTool(
    "send_message",
    {
      title: "Send a Telegram message",
      description:
        "Send a message as yourself. Disabled unless TELEGRAM_ALLOW_SEND=1 is set.",
      inputSchema: {
        chat: z.string(),
        text: z.string(),
        reply_to: z.number().int().optional().describe("Message id to reply to"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ chat, text, reply_to }) => {
      try {
        if (!ALLOW_SEND) {
          return fail("Sending is disabled. Set TELEGRAM_ALLOW_SEND=1 to enable.");
        }
        const c = await authed();
        const e = await resolve(c, chat);
        const m: any = await c.sendMessage(e, { message: text, replyTo: reply_to });
        return ok({ sent: true, chat: entityName(e), id: m.id });
      } catch (err: any) {
        return fail(err?.message ?? String(err));
      }
    }
  );

  return server;
}

export async function runTelegram(): Promise<void> {
  const server = buildTelegramServer();
  await server.connect(new StdioServerTransport());
}
