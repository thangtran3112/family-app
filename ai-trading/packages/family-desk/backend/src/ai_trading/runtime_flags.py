"""Environment flags that gate behaviour the owner turns on deliberately (02m §b5 item 6). Both are
off unless the variable is exactly "1", and neither is set anywhere in the repo's deploy files."""

import os


def alerts_runtime_enabled() -> bool:
    """On: strategies may move to `alert_only` and the runtime evaluates them. Off (the default): every
    attach/create/resume stays `draft` and `Turn on` answers 409. Flipping it is a Hermes release step."""
    return os.environ.get("DESK_ALERTS_RUNTIME_ENABLED") == "1"


def desk_owner_emails() -> frozenset[str]:
    """The owners of the feedback log (02s): the emails in `DESK_OWNER_EMAILS` (comma-separated, from the
    `ai-trading/desk` Firestore profile, never from the repository), lower-cased. Any other signed-in user is a filer.
    The container reads the profile at start, so a change to the list takes effect on the next deploy or restart."""
    return frozenset(
        email.strip().lower() for email in os.environ.get("DESK_OWNER_EMAILS", "").split(",") if email.strip()
    )
