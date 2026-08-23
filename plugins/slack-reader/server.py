"""MCP server exposing ALL your Slack workspaces (one user token each) to Claude."""
import os
from pathlib import Path

from dotenv import load_dotenv
from mcp.server import MCPServer
from slack_sdk import WebClient
from slack_sdk.errors import SlackApiError

ROOT = Path(__file__).parent
# CLAUDE_PLUGIN_DATA keeps credentials across plugin updates when installed as a plugin.
_d = os.getenv("CLAUDE_PLUGIN_DATA")
DATA = Path(_d) if _d else ROOT
DATA.mkdir(parents=True, exist_ok=True)
# Existing environment variables win; .env files are only a fallback.
load_dotenv(DATA / ".env")
load_dotenv(ROOT / ".env")

TOKENS = [t.strip() for t in
          (os.getenv("SLACK_USER_TOKENS") or os.getenv("SLACK_USER_TOKEN") or "").split(",")
          if t.strip()]
ALLOW_SEND = os.getenv("SLACK_ALLOW_SEND", "0") == "1"

mcp = MCPServer("slack-reader")

_ws: dict[str, dict] = {}   # workspace name -> {client, user, user_id, team_id, url}
_users: dict[str, str] = {}


def workspaces() -> dict[str, dict]:
    """Authenticate every token once; map workspace name -> client info."""
    if _ws:
        return _ws
    if not TOKENS:
        raise RuntimeError(
            "No Slack tokens. Put one user token (xoxp-...) per workspace, comma "
            "separated, in SLACK_USER_TOKENS in slack-reader/.env, then restart Claude Code."
        )
    for tok in TOKENS:
        c = WebClient(token=tok)
        try:
            r = c.auth_test()
        except SlackApiError as e:
            _ws["(bad token " + tok[:12] + "...)"] = {"error": str(e.response["error"])}
            continue
        _ws[r["team"]] = {"client": c, "user": r["user"], "user_id": r["user_id"],
                          "team_id": r["team_id"], "url": r["url"]}
    return _ws


def pick(workspace: str = "") -> list:
    """Workspaces to act on: all of them, or the one matching `workspace`."""
    ws = workspaces()
    live = [(n, v) for n, v in ws.items() if "client" in v]
    if not workspace:
        return live
    low = workspace.lower()
    hit = [(n, v) for n, v in live if low in n.lower()]
    if not hit:
        raise ValueError("No workspace matching " + repr(workspace) +
                         ". Have: " + str([n for n, _ in live]))
    return hit


def user_name(c: WebClient, uid: str) -> str:
    if not uid:
        return ""
    key = str(id(c)) + ":" + uid
    if key not in _users:
        try:
            info = c.users_info(user=uid)["user"]
            _users[key] = info.get("real_name") or info.get("name") or uid
        except SlackApiError:
            _users[key] = uid
    return _users[key]


def fmt_msg(c: WebClient, m: dict) -> dict:
    out = {"ts": m.get("ts"),
           "from": user_name(c, m.get("user", "")) or m.get("username") or m.get("bot_id", ""),
           "text": m.get("text", "")}
    if m.get("thread_ts") and m.get("reply_count"):
        out["thread_replies"] = m["reply_count"]
    if m.get("files"):
        out["files"] = [f.get("name") for f in m["files"]]
    return out


def _channels(c: WebClient, types: str, cap: int = 1000) -> list:
    out, cursor = [], None
    while True:
        r = c.conversations_list(types=types, limit=200, cursor=cursor, exclude_archived=True)
        for ch in r["channels"]:
            if ch.get("name"):
                name = ch["name"]
            elif ch.get("is_im"):
                name = "DM:" + user_name(c, ch.get("user", ""))
            else:
                name = ch["id"]
            out.append({"id": ch["id"], "name": name,
                        "kind": "im" if ch.get("is_im") else
                                "mpim" if ch.get("is_mpim") else
                                "private" if ch.get("is_private") else "public",
                        "member": ch.get("is_member", True)})
            if len(out) >= cap:
                return out
        cursor = (r.get("response_metadata") or {}).get("next_cursor")
        if not cursor:
            return out


def resolve(channel: str, workspace: str = ""):
    """-> (workspace name, client, channel id). Searches every workspace unless one is named."""
    s = channel.strip().lstrip("#")
    cands = pick(workspace)
    if s[:1] in ("C", "D", "G") and s.isupper() and len(s) > 8:
        for name, v in cands:
            try:
                v["client"].conversations_info(channel=s)
                return name, v["client"], s
            except SlackApiError:
                continue
    exact, partial = [], []
    for name, v in cands:
        for ch in _channels(v["client"], "public_channel,private_channel,im,mpim"):
            if ch["name"].lower() == s.lower():
                exact.append((name, v["client"], ch["id"]))
            elif s.lower() in ch["name"].lower():
                partial.append((name, v["client"], ch["id"]))
    hits = exact or partial
    if not hits:
        raise ValueError("No channel matching " + repr(channel))
    if len(hits) > 1 and not workspace:
        raise ValueError(repr(channel) + " exists in several workspaces: " +
                         str([h[0] for h in hits]) + ". Pass workspace= to pick one.")
    return hits[0]


@mcp.tool()
def whoami() -> list:
    """List every connected Slack workspace and who you are in each."""
    out = []
    for name, v in workspaces().items():
        if "client" not in v:
            out.append({"workspace": name, "error": v.get("error")})
        else:
            out.append({"workspace": name, "user": v["user"],
                        "user_id": v["user_id"], "url": v["url"]})
    return out


@mcp.tool()
def list_channels(limit: int = 100, query: str = "", workspace: str = "",
                  types: str = "public_channel,private_channel") -> list:
    """List channels across all workspaces (or one, via `workspace`).

    types: public_channel, private_channel, im, mpim (comma separated).
    """
    low = query.lower()
    out = []
    for name, v in pick(workspace):
        for ch in _channels(v["client"], types):
            if low and low not in ch["name"].lower():
                continue
            entry = {"workspace": name}
            entry.update(ch)
            out.append(entry)
            if len(out) >= limit:
                return out
    return out


@mcp.tool()
def list_dms(limit: int = 50, workspace: str = "") -> list:
    """List your direct-message conversations (1:1 and group DMs) across workspaces."""
    return list_channels(limit=limit, workspace=workspace, types="im,mpim")


@mcp.tool()
def read_channel(channel: str, limit: int = 50, workspace: str = "", before_ts: str = "") -> dict:
    """Read recent messages of a channel or DM.

    channel: id (C/D/G...), #name, or part of a name.
    workspace: needed only if the name exists in more than one workspace.
    before_ts: paginate older by passing the oldest ts you already have.
    """
    ws, c, cid = resolve(channel, workspace)
    kw = {"channel": cid, "limit": min(limit, 200)}
    if before_ts:
        kw["latest"] = before_ts
    msgs = [fmt_msg(c, m) for m in c.conversations_history(**kw)["messages"]]
    msgs.reverse()
    return {"workspace": ws, "channel": channel, "id": cid, "messages": msgs}


@mcp.tool()
def read_thread(channel: str, thread_ts: str, limit: int = 50, workspace: str = "") -> dict:
    """Read the replies of one thread. thread_ts is the parent message's ts."""
    ws, c, cid = resolve(channel, workspace)
    r = c.conversations_replies(channel=cid, ts=thread_ts, limit=min(limit, 200))
    return {"workspace": ws, "messages": [fmt_msg(c, m) for m in r["messages"]]}


@mcp.tool()
def search_messages(query: str, limit: int = 20, workspace: str = "") -> list:
    """Search messages across every workspace. Supports Slack modifiers (in:#chan, from:@user)."""
    out = []
    for name, v in pick(workspace):
        try:
            r = v["client"].search_messages(query=query, count=min(limit, 100))
        except SlackApiError as e:
            out.append({"workspace": name, "error": str(e.response["error"])})
            continue
        for m in r["messages"]["matches"]:
            out.append({"workspace": name, "ts": m.get("ts"),
                        "channel": (m.get("channel") or {}).get("name"),
                        "from": m.get("username") or user_name(v["client"], m.get("user", "")),
                        "text": m.get("text", ""), "permalink": m.get("permalink")})
    return out


@mcp.tool()
def unread_summary(limit: int = 20, per_chat: int = 10, workspace: str = "") -> list:
    """Show channels and DMs with unread messages, across all workspaces."""
    out = []
    for name, v in pick(workspace):
        c = v["client"]
        for ch in _channels(c, "public_channel,private_channel,im,mpim"):
            if not ch["member"]:
                continue
            try:
                info = c.conversations_info(channel=ch["id"])["channel"]
                last_read = info.get("last_read")
                if not last_read:
                    continue
                h = c.conversations_history(channel=ch["id"], oldest=last_read, limit=per_chat)
            except SlackApiError:
                continue
            msgs = [fmt_msg(c, m) for m in h["messages"] if m.get("ts") != last_read]
            if not msgs:
                continue
            msgs.reverse()
            out.append({"workspace": name, "channel": ch["name"], "kind": ch["kind"],
                        "unread": len(msgs), "messages": msgs})
            if len(out) >= limit:
                return out
    return out


@mcp.tool()
def send_message(channel: str, text: str, workspace: str = "", thread_ts: str = "") -> dict:
    """Post a message as yourself. Set thread_ts to reply inside a thread.

    Disabled unless SLACK_ALLOW_SEND=1 in .env.
    """
    if not ALLOW_SEND:
        return {"error": "Sending is disabled. Set SLACK_ALLOW_SEND=1 in .env to enable."}
    ws, c, cid = resolve(channel, workspace)
    kw = {"channel": cid, "text": text}
    if thread_ts:
        kw["thread_ts"] = thread_ts
    r = c.chat_postMessage(**kw)
    return {"sent": True, "workspace": ws, "channel": channel, "ts": r["ts"]}


if __name__ == "__main__":
    mcp.run()
