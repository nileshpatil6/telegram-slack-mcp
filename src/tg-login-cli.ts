/** `telegram-slack-mcp login`: link Telegram from a terminal, no MCP client involved. */
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";
import { createInterface } from "node:readline/promises";
import { env, readState, writeState, dataDir } from "./common.js";
import { serveQrPage, qrAsText, loginUrl } from "./tg-login.js";

const API_ID = Number(env("TELEGRAM_API_ID") || env("TG_API_ID") || 0);
const API_HASH = env("TELEGRAM_API_HASH") || env("TG_API_HASH");

export async function loginFromTerminal(): Promise<void> {
  if (!API_ID || !API_HASH) {
    process.stderr.write(
      "Missing credentials. Get an api_id and api_hash from https://my.telegram.org, then:\n" +
        "  TELEGRAM_API_ID=... TELEGRAM_API_HASH=... telegram-slack-mcp login\n"
    );
    process.exit(1);
  }

  const client = new TelegramClient(
    new StringSession(readState("telegram.session")),
    API_ID,
    API_HASH,
    { connectionRetries: 3 }
  );
  await client.connect();

  if (await client.isUserAuthorized()) {
    const me: any = await client.getMe();
    process.stdout.write(`Already linked as ${me.firstName ?? ""} ${me.username ? "@" + me.username : ""}\n`);
    process.exit(0);
  }

  const qr = await serveQrPage();
  process.stdout.write(
    `\nScan this from Telegram: Settings -> Devices -> Link Desktop Device.\n` +
      `Prefer a browser? Open ${qr.url}\n\n`
  );

  try {
    const me: any = await client.signInUserWithQrCode(
      { apiId: API_ID, apiHash: API_HASH },
      {
        qrCode: async (token) => {
          await qr.setToken(token.token);
          process.stdout.write(await qrAsText(loginUrl(token.token)));
          process.stdout.write(`\nOn this machine? Open: ${loginUrl(token.token)}\n`);
        },
        password: async (hint) => {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          const answer = await rl.question(
            hint ? `Two-step verification password (hint: ${hint}): ` : "Two-step verification password: "
          );
          rl.close();
          return answer.trim();
        },
        onError: async (e) => {
          process.stderr.write(`${e?.message ?? e}\n`);
          return false;
        },
      }
    );
    writeState("telegram.session", String(client.session.save()));
    qr.markDone();
    process.stdout.write(
      `\nLinked as ${me.firstName ?? ""} ${me.username ? "@" + me.username : ""} (id ${me.id}).\n` +
        `Session saved in ${dataDir()}. This is permanent; no need to repeat it.\n`
    );
  } finally {
    qr.close();
    await client.disconnect();
  }
  process.exit(0);
}
