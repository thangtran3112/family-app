"""Secret redaction for anything that might reach a log line or an exception message.

Adapted from Vibe-Trading `agent/src/channels/manager.py`/`channels/bus/queue.py` (retry/dedupe
pattern) and deer-flow's notification-delivery redaction (02a §11): a channel's own token/webhook
URL is always passed explicitly, and a defense-in-depth pass catches the shapes a secret takes in
the wild even when a call site forgot to name it -- a Telegram bot-token URL segment, and any
`token=`/`key=`/`webhook=`/`secret=`/`password=`-looking parameter in free text or a query string.
"""

import re

_PLACEHOLDER = "[redacted]"

# Telegram's bot API URL shape: https://api.telegram.org/bot<token>/<method>. The token itself
# (`<digits>:<hash>`) is also passed explicitly by `telegram.py`, but this catches it even if a
# caller didn't.
_BOT_SEGMENT_RE = re.compile(r"/bot\d+:[\w-]+/")

# Any `key=value` pair whose key name looks secret-shaped, with or without a leading `?`/`&` --
# covers both a query string and a secret mentioned in free-form exception text.
_SECRET_PARAM_RE = re.compile(r"(?i)\b([\w.-]*(?:token|key|webhook|secret|password)[\w.-]*=)[^&\s'\"]+")


def redact(text: str, *secrets: str) -> str:
    """Replaces every non-empty secret's exact text with "[redacted]"; safe to call with an empty
    secrets tuple. Also strips a bot-token-shaped Telegram URL segment (`/bot<token>/`) and any
    `token=`/`key=`/`webhook`-looking query parameter, defense in depth for a secret this call
    site didn't know to pass explicitly (adapt deer-flow's redaction, 02a §11).
    """
    out = text
    for secret in secrets:
        if secret:
            out = out.replace(secret, _PLACEHOLDER)
    out = _BOT_SEGMENT_RE.sub(f"/bot{_PLACEHOLDER}/", out)
    out = _SECRET_PARAM_RE.sub(lambda m: f"{m.group(1)}{_PLACEHOLDER}", out)
    return out
