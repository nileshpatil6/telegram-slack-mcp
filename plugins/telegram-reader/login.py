"""One-time interactive login. Run:  .venv\Scripts\python.exe login.py"""
from tg_common import make_client

with make_client() as client:
    me = client.get_me()
    print(f"Logged in as: {me.first_name} (@{me.username}) id={me.id}")
    print("Session saved. You can close this.")
