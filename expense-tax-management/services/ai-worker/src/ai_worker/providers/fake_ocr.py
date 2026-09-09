"""Fake OCR provider: deterministic canned extraction, no real vision.

This is the placeholder behind the `fake` Foundry provider kind. It reads
nothing "intelligently" -- but its callers DO download real bytes and verify
real hashes before invoking it, so the surrounding pipeline (file access,
quota lifecycle, Temporal orchestration, expense creation) is exercised for
real. A real vision-LLM adapter replaces this module once provider
credentials exist; its interface (extract -> OcrExtractionResultV1-shaped
dict) is the seam.

Deliberately dependency-free (stdlib only): no Pillow, no PDF parsing. The
fake must never become load-bearing on file-format handling.
"""

from __future__ import annotations

from datetime import date

FAKE_MERCHANT = "Fake OCR Merchant"
FAKE_AMOUNT = "12.34"
FAKE_CURRENCY = "USD"
# Fixed (not today): e2e assertions must be deterministic across runs.
FAKE_INCURRED_ON = date(2026, 9, 9)
FAKE_CONFIDENCE = 1.0


def extract_receipt(data: bytes) -> dict:
    """Return an OcrExtractionResultV1-shaped dict for any input bytes.

    Format-blind by design: no content-type parameter, no sniffing. A real
    adapter would dispatch on content type here; the fake's contract is
    "bytes in, canned extraction out" (see module docstring).

    Raises ValueError on empty input (the only validation the fake owns:
    refusing to "read" nothing).
    """
    if len(data) == 0:
        raise ValueError("refusing to extract from empty input")
    return {
        "schemaVersion": 1,
        "merchant": FAKE_MERCHANT,
        "amount": FAKE_AMOUNT,
        "currency": FAKE_CURRENCY,
        "incurredOn": FAKE_INCURRED_ON.isoformat(),
        "confidence": FAKE_CONFIDENCE,
    }
