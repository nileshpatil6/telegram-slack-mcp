"""MCP server exposing personal Telegram chats (MTProto / Telethon) to Claude."""
import asyncio
from datetime import datetime, timezone
from typing import Any, Optional

from mcp.server import MCPServer
from telethon.errors import SessionPasswordNeededError
from telethon.tl.types import User, Chat, Channel

from tg_common import make_client, ALLOW_SEND

mcp = MCPServer("telegram-reader")

_client = None
_lock = asyncio.Lock()


async def get_client():
    global _client
    async with _lock:
        if _client is None:
            c = make_client()
            await c.connect()
            if not await c.is_user_authorized():
                await c.disconnect()
                raise RuntimeError(
                    "Telegram not logged in yet. Call login_start with the user's "
                    "phone number, then login_complete with the code Telegram sends."
                )
            _client = c
    return _client


def _kind(e) -> str:
    if isinstance(e, User):
        return "bot" if getattr(e, "bot", False) else "dm"
    if isinstance(e, Chat):
        return "group"
    if isinstance(e, Channel):
        return "channel" if e.broadcast else "supergroup"
    return "unknown"


def _name(e) -> str:
    if isinstance(e, User):
        n = " ".join(filter(None, [e.first_name, e.last_name])) or "(no name)"
        return f"{n}" + (f" (@{e.username})" if e.username else "")
    return getattr(e, "title", "(unknown)")


def _ts(d: Optional[datetime]) -> Optional[str]:
    return d.astimezone(timezone.utc).isoformat() if d else None


async def resolve(client, chat: str):
    """Resolve @username / numeric id / name substring to an entity."""
    s = str(chat).strip()
    try:
        return await client.get_entity(int(s))
    except (ValueError, TypeError):
        pass
    except Exception:
        pass
    try:
        return await client.get_entity(s)
    except Exception:
        pass
    low = s.lower()
    async for d in client.iter_dialogs():
        if low in (d.name or "").lower():
            return d.entity
    raise ValueError(f"No chat matching {chat!r}")


async def _fmt_msg(client, m) -> dict[str, Any]:
    sender = None
    try:
        s = await m.get_sender()
        sender = _name(s) if s else None
    except Exception:
        pass
    out = {
        "id": m.id,
        "date": _ts(m.date),
        "from": sender,
        "out": bool(m.out),
        "text": m.message or "",
    }
    if m.media and not (m.message or ""):
        out["text"] = f"[{type(m.media).__name__}]"
    elif m.media:
        out["media"] = type(m.media).__name__
    if m.reply_to_msg_id:
        out["reply_to"] = m.reply_to_msg_id
    return out


@mcp.tool()
async def whoami() -> dict:
    """Show which Telegram account this server is logged in as."""
    c = await get_client()
    me = await c.get_me()
    return {"id": me.id, "name": _name(me), "phone": me.phone}


@mcp.tool()
async def list_chats(limit: int = 40, query: str = "", unread_only: bool = False) -> list[dict]:
    """List recent Telegram chats (DMs, groups, channels), newest activity first.

    query: optional case-insensitive substring filter on chat name.
    unread_only: only chats with unread messages.
    """
    c = await get_client()
    res = []
    low = query.lower()
    async for d in c.iter_dialogs():
        if low and low not in (d.name or "").lower():
            continue
        if unread_only and not d.unread_count:
            continue
        res.append({
            "id": d.id,
            "name": d.name,
            "kind": _kind(d.entity),
            "unread": d.unread_count,
            "last_date": _ts(d.date),
            "last_message": (d.message.message or "")[:160] if d.message else "",
        })
        if len(res) >= limit:
            break
    return res


@mcp.tool()
async def read_chat(chat: str, limit: int = 30, before_id: int = 0) -> dict:
    """Read the most recent messages of one chat.

    chat: @username, numeric id, or part of the chat name.
    before_id: paginate older by passing the smallest id you already have.
    """
    c = await get_client()
    e = await resolve(c, chat)
    kw = {"limit": min(limit, 200)}
    if before_id:
        kw["max_id"] = before_id
    msgs = [await _fmt_msg(c, m) async for m in c.iter_messages(e, **kw)]
    msgs.reverse()
    return {"chat": _name(e), "id": getattr(e, "id", None), "kind": _kind(e), "messages": msgs}


@mcp.tool()
async def search_messages(query: str, chat: str = "", limit: int = 30) -> list[dict]:
    """Full-text search messages. Searches one chat if `chat` is given, else all chats."""
    c = await get_client()
    e = await resolve(c, chat) if chat else None
    out = []
    async for m in c.iter_messages(e, search=query, limit=min(limit, 100)):
        d = await _fmt_msg(c, m)
        try:
            ch = await m.get_chat()
            d["chat"] = _name(ch)
        except Exception:
            pass
        out.append(d)
    return out


@mcp.tool()
async def unread_summary(limit: int = 20, per_chat: int = 10) -> list[dict]:
    """Show unread messages across all chats, so you can catch up at a glance."""
    c = await get_client()
    out = []
    async for d in c.iter_dialogs():
        if not d.unread_count:
            continue
        msgs = [await _fmt_msg(c, m) async for m in
                c.iter_messages(d.entity, limit=min(d.unread_count, per_chat))]
        msgs.reverse()
        out.append({"chat": d.name, "kind": _kind(d.entity),
                    "unread": d.unread_count, "messages": msgs})
        if len(out) >= limit:
            break
    return out


@mcp.tool()
async def send_message(chat: str, text: str) -> dict:
    """Send a message as yourself. Disabled unless TG_ALLOW_SEND=1 in .env."""
    if not ALLOW_SEND:
        return {"error": "Sending is disabled. Set TG_ALLOW_SEND=1 in .env to enable."}
    c = await get_client()
    e = await resolve(c, chat)
    m = await c.send_message(e, text)
    return {"sent": True, "chat": _name(e), "id": m.id}


_login = {}


@mcp.tool()
async def login_start(phone: str) -> dict:
    """Step 1 of login: send a Telegram code to `phone` (international format, e.g. +9198...)."""
    global _client
    if _client is not None:
        return {"already_logged_in": True}
    c = make_client()
    await c.connect()
    if await c.is_user_authorized():
        _client = c
        return {"already_logged_in": True}
    sent = await c.send_code_request(phone)
    _login["client"] = c
    _login["phone"] = phone
    _login["hash"] = sent.phone_code_hash
    return {"sent": True, "phone": phone,
            "next": "Ask the user for the code Telegram just sent, then call login_complete."}


@mcp.tool()
async def login_complete(code: str, password: str = "") -> dict:
    """Step 2 of login: submit the code (and 2FA password if the account has one)."""
    global _client
    c = _login.get("client")
    if c is None:
        return {"error": "Call login_start first."}
    try:
        await c.sign_in(_login["phone"], code.strip(), phone_code_hash=_login["hash"])
    except SessionPasswordNeededError:
        if not password:
            return {"error": "2FA enabled. Ask the user for their Telegram password, then call "
                             "login_complete again with the same code and the password."}
        await c.sign_in(password=password)
    _client = c
    _login.clear()
    me = await c.get_me()
    return {"logged_in": True, "as": _name(me), "id": me.id,
            "note": "Session saved to tg.session. This login is permanent, no need to repeat."}


if __name__ == "__main__":
    mcp.run()
