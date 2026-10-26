"""Helpers the feedback tests share (02s): a valid report body, filing and staging through the API as a named user,
and the owner/filer split. `OWNER_EMAIL` (from `conftest`) is the Desk owner (`DESK_OWNER_EMAILS`, written in upper
case with spaces to prove the match is case-insensitive); `OTHER_EMAIL` is the filer; `THIRD_EMAIL` is signed in and
filed nothing.
"""

from conftest import OTHER_EMAIL, OWNER_EMAIL, auth_headers

BASE = "/api/desk/feedback"
THIRD_EMAIL = "third@example.com"
OWNER_ENV = f"  {OWNER_EMAIL.upper()} , nobody@example.com"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 32
WEBP = b"RIFF\x24\x00\x00\x00WEBPVP8 " + b"\x00" * 24


def report_body(**over):
    body = {
        "kind": "bug",
        "severity": "P2",
        "title": "Chart axis flips after a symbol change",
        "body": "I changed symbol and the price axis flipped.",
        "expected": "The axis stays put.",
        "screen": "Practice day",
        "route": "/practice/day?id=5",
        "app_version": "dev",
        "context": {"symbol": "NVDA", "practice_day": "2026-10-23"},
        "captured_at": "2026-10-26T14:03:00Z",
        "links": [{"label": "the chart", "url": "https://example.com/chart"}],
        "attachment_ids": [],
    }
    body.update(over)
    return body


def file_report(client, email=OTHER_EMAIL, **over):
    response = client.post(BASE, json=report_body(**over), headers=auth_headers(email))
    assert response.status_code == 201, response.text
    return response.json()


def stage(client, data=PNG, email=OTHER_EMAIL, name="shot.png", content_type="image/png"):
    return client.post(f"{BASE}/attachments", files={"file": (name, data, content_type)}, headers=auth_headers(email))


def patch(client, report_id, body, email=OWNER_EMAIL):
    return client.patch(f"{BASE}/{report_id}", json=body, headers=auth_headers(email))


def problems(response):
    return {(p["path"], p["message"]) for p in response.json()["detail"]["problems"]}
