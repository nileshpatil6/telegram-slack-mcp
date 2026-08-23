"""Shared Telegram configuration: credentials, data directory, client factory."""
import os
from pathlib import Path

from dotenv import load_dotenv
from telethon import TelegramClient


def data_dir() -> Path:
    """Where the session file lives.

    CHAT_MCP_DATA_DIR wins, then CLAUDE_PLUGIN_DATA (so a Claude Code plugin
    install keeps its login across updates), then ~/.chat-mcp.
    """
    d = os.getenv("CHAT_MCP_DATA_DIR") or os.getenv("CLAUDE_PLUGIN_DATA")
    p = Path(d) if d else Path.home() / ".chat-mcp"
    p.mkdir(parents=True, exist_ok=True)
    return p


DATA = data_dir()
# Existing environment variables win; .env is only a fallback.
load_dotenv(DATA / ".env")
load_dotenv(Path.cwd() / ".env")


def _env(*names: str, default: str = "") -> str:
    for n in names:
        v = os.getenv(n, "").strip()
        if v:
            return v
    return default


_api_id = _env("TELEGRAM_API_ID", "TG_API_ID")
API_ID = int(_api_id) if _api_id.isdigit() else 0
API_HASH = _env("TELEGRAM_API_HASH", "TG_API_HASH")
SESSION = str(DATA / _env("TELEGRAM_SESSION", "TG_SESSION", default="telegram"))
ALLOW_SEND = _env("TELEGRAM_ALLOW_SEND", "TG_ALLOW_SEND").lower() in ("1", "true", "yes", "on")

SETUP_HINT = (
    "Missing Telegram credentials. Get an api_id and api_hash from "
    "https://my.telegram.org (API development tools), then set TELEGRAM_API_ID "
    "and TELEGRAM_API_HASH."
)


def check_config() -> None:
    if not API_ID or not API_HASH:
        raise RuntimeError(SETUP_HINT)


def make_client() -> TelegramClient:
    check_config()
    return TelegramClient(SESSION, API_ID, API_HASH)
