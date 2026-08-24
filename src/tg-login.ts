/**
 * QR login for Telegram.
 *
 * Telegram has no OAuth, but it does have QR device linking: the app shows a
 * token, you scan it from Settings -> Devices -> Link Desktop Device, and the
 * session is authorised without typing a phone number or a code. This module
 * serves that QR on a loopback page and points the MCP client at it through
 * URL-mode elicitation, which is the closest equivalent to "just authorise".
 *
 * Everything degrades: if the client does not support elicitation, the caller
 * falls back to returning the QR as text.
 */
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { toDataURL, toString as qrToString } from "qrcode";

/** Telegram's device-link URL for a QR token. */
export function loginUrl(token: Buffer): string {
  const b64 = token
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `tg://login?token=${b64}`;
}

export async function qrAsText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    qrToString(url, { type: "utf8" }, (err, out) =>
      err ? reject(err) : resolve(out)
    );
  });
}

const PAGE_STYLE = `
:root { color-scheme: light dark; }
body { margin:0; min-height:100vh; display:grid; place-items:center;
  font:16px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;
  background:#0b0d10; color:#e7e9ee; }
.card { width:min(92vw,420px); padding:32px; border-radius:16px; text-align:center;
  background:#14171c; border:1px solid #232830; }
h1 { margin:0 0 4px; font-size:20px; }
p { margin:0 0 20px; color:#9aa3b2; font-size:14px; }
img { width:260px; height:260px; border-radius:12px; background:#fff; padding:12px; }
ol { text-align:left; margin:20px 0 0; padding-left:20px; color:#9aa3b2; font-size:13px; }
a { color:#6ea8fe; }
.done { color:#4ade80; font-weight:600; }
`;

function page(dataUrl: string, tgUrl: string, done: boolean): string {
  if (done) {
    return `<!doctype html><meta charset=utf-8><title>Telegram linked</title>
<style>${PAGE_STYLE}</style><div class=card><h1 class=done>Linked</h1>
<p>You can close this tab and return to your terminal.</p></div>`;
  }
  return `<!doctype html><meta charset=utf-8><title>Link Telegram</title>
<meta http-equiv=refresh content=2>
<style>${PAGE_STYLE}</style>
<div class=card>
  <h1>Scan to link Telegram</h1>
  <p>This authorises your account. No code to type.</p>
  <img src="${dataUrl}" alt="Telegram login QR code">
  <ol>
    <li>Open Telegram on your phone</li>
    <li>Settings, then Devices</li>
    <li>Link Desktop Device</li>
    <li>Scan this code</li>
  </ol>
  <p style="margin:16px 0 0">On this machine instead?
    <a href="${tgUrl}">open in Telegram Desktop</a></p>
</div>`;
}

export type QrPage = {
  url: string;
  setToken: (token: Buffer) => Promise<void>;
  markDone: () => void;
  close: () => void;
};

/**
 * Serve the QR on 127.0.0.1. The page refreshes itself, so a rotated token
 * appears without the viewer doing anything.
 */
export async function serveQrPage(): Promise<QrPage> {
  let dataUrl = "";
  let tgUrl = "";
  let done = false;

  const server: Server = createServer((_req, res) => {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(dataUrl ? page(dataUrl, tgUrl, done) : "<!doctype html>Preparing...");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/`,
    async setToken(token: Buffer) {
      tgUrl = loginUrl(token);
      dataUrl = await toDataURL(tgUrl, { width: 512, margin: 1 });
    },
    markDone() {
      done = true;
    },
    close() {
      server.close();
    },
  };
}
