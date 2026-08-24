import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { TelegramClient, Api } from "teleproto";
import { StringSession } from "teleproto/sessions";
import { computeCheck } from "teleproto/Password";
import { env, flag, ok, fail, readState, writeState } from "./common.js";
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
      "Telegram not logged in yet. Call login_start with the user's phone number, " +
        "then login_complete with the code Telegram sends."
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
    const kind = m.media.className || "Media";
    if (!m.message) out.text = `[${kind}]`;
    else out.media = kind;
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

export function buildTelegramServer(): McpServer {
  const server = new McpServer({ name: "telegram-slack-mcp:telegram", version: "0.3.0" });


  server.registerTool(
    "login",
    {
      title: "Link Telegram",
      description:
        "Log in by scanning a QR code, the way Telegram's own desktop linking works. No phone " +
        "number and no code to type. Use this first; fall back to login_start/login_complete " +
        "only if the user cannot scan.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async () => {
      let qr: Awaited<ReturnType<typeof serveQrPage>> | null = null;
      try {
        const c = await connect();
        if (await c.isUserAuthorized()) return ok({ already_logged_in: true });

        qr = await serveQrPage();
        const elicitationId = `tg-login-${Date.now()}`;
        let asciiQr = "";
        let firstToken: Buffer | null = null;

        const signIn = c.signInUserWithQrCode(
          { apiId: API_ID, apiHash: API_HASH },
          {
            qrCode: async (token) => {
              // Called again whenever Telegram rotates the token; the page polls.
              firstToken = token.token;
              await qr!.setToken(token.token);
              if (!asciiQr) asciiQr = await qrAsText(loginUrl(token.token));
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
            onError: async (e) => {
              // Returning false keeps the flow alive across token rotations.
              return String(e?.message ?? e).includes("AbortError");
            },
          }
        );

        // Give the QR a moment to exist before pointing anyone at the page.
        await new Promise((r) => setTimeout(r, 1200));

        // Open the page for the user. Not awaited: the scan, not the dialog, is
        // what completes the login, and older clients reject elicitation outright.
        let elicitSupported = true;
        const opened = server.server
          .elicitInput({
            mode: "url",
            message:
              "Scan this QR from Telegram on your phone: Settings, Devices, Link Desktop Device.",
            elicitationId,
            url: qr.url,
          })
          .catch(() => {
            elicitSupported = false;
            return null;
          });

        const me: any = await Promise.race([
          signIn,
          new Promise((_res, rej) =>
            setTimeout(() => rej(new Error("QR login timed out after 3 minutes.")), 180_000)
          ),
        ]);

        save(c);
        qr.markDone();
        void server.server.createElicitationCompletionNotifier(elicitationId)().catch(() => {});
        void opened;

        return ok({
          logged_in: true,
          as: entityName(me),
          id: String(me.id),
          method: "qr",
          note: "Session saved. This login is permanent, no need to repeat.",
        });
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        return fail(
          msg +
            " If scanning is not possible, use login_start with the user's phone number instead."
        );
      } finally {
        qr?.close();
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
