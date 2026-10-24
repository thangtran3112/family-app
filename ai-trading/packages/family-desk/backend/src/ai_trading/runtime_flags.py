"""Environment flags that gate behaviour the owner turns on deliberately (02m §b5 item 6). Both are
off unless the variable is exactly "1", and neither is set anywhere in the repo's deploy files."""

import os


def alerts_runtime_enabled() -> bool:
    """On: strategies may move to `alert_only` and the runtime evaluates them. Off (the default): every
    attach/create/resume stays `draft` and `Turn on` answers 409. Flipping it is a Hermes release step."""
    return os.environ.get("DESK_ALERTS_RUNTIME_ENABLED") == "1"
