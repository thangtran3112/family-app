"""Data-quality labels shown on every number the Desk displays (02 Global Constraints)."""

from __future__ import annotations

from typing import Literal

Quality = Literal["realtime", "delayed-15m", "eod", "fallback", "unavailable"]
