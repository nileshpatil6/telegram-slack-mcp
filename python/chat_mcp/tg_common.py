import os
from pathlib import Path

from dotenv import load_dotenv
from telethon import TelegramClient


def data_dir() -> Path:
    """Where the session file and .env live.

    Uses CLAUDE_PLUGIN_DATA when running as a Claude Code plugin, so credentials
    survive plugin updates. Falls back to this file's own directory.
    """
    d = os.getenv("CLAUDE_PLUGIN_DATA")
    p = Path(d) if d else Path(__file__).parent
    p.mkdir(parents=True, exist_ok=True)
    return p


DATA = data_dir()
# Existing environment variables win; .env is only a fallback.
load_dotenv(DATA / ".env")
load_dotenv(Path(__file__).parent / ".env")

_api_id = os.getenv("TG_API_ID", "").strip()
API_ID = int(_api_id) if _api_id.isdigit() else 0
API_HASH = os.getenv("TG_API_HASH", "").strip()
SESSION = str(DATA / os.getenv("TG_SESSION", "tg"))
ALLOW_SEND = os.getenv("TG_ALLOW_SEND", "0") == "1"

SETUP_HINT = (
    "Missing Telegram API credentials. Get an api_id and api_hash from "
    "https://my.telegram.org (API development tools), then set TG_API_ID and "
    "TG_API_HASH as environment variables, or put them in a .env file at: "
)


def check_config() -> None:
    if not API_ID or not API_HASH:
        raise RuntimeError(SETUP_HINT + str(DATA / ".env"))


def make_client() -> TelegramClient:
    check_config()
    return TelegramClient(SESSION, API_ID, API_HASH)
