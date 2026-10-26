"""`/api/desk/feedback` (02s): filing, the dashboard, the status rules and who may set them, the filer's own edit,
and the screenshots (their limits, their magic bytes, staging and the 24-hour sweep). Real Postgres, no network.

Who is who is in `feedback_world`: `OWNER_EMAIL` is the Desk owner (`DESK_OWNER_EMAILS`), `OTHER_EMAIL` the filer and
`THIRD_EMAIL` a signed-in user who filed nothing.
"""

import asyncio
from datetime import UTC, datetime, timedelta

import pytest
from conftest import OTHER_EMAIL, OWNER_EMAIL, auth_headers
from fastapi import HTTPException
from feedback_world import (
    BASE,
    JPEG,
    OWNER_ENV,
    PNG,
    THIRD_EMAIL,
    WEBP,
    file_report,
    patch,
    problems,
    report_body,
    stage,
)
from sqlalchemy import select, update

from ai_trading.api.feedback import MAX_BODY_BYTES, file_part, read_capped
from ai_trading.db.models import FeedbackAttachment
from ai_trading.feedback import MAX_ATTACHMENT_BYTES, STAGED_TTL, ref


@pytest.fixture(autouse=True)
def owner_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DESK_OWNER_EMAILS", OWNER_ENV)


# -- filing -------------------------------------------------------------------------------------------------


def test_filing_a_bug_answers_the_detail_with_an_open_status_and_the_first_event(client):
    report = file_report(client)
    assert report["ref"] == ref(report["id"]) and report["ref"].startswith("F-")
    assert report["status"] == "open" and report["kind"] == "bug" and report["severity"] == "P2"
    assert report["fix_ref"] is None and report["duplicate_of"] is None
    assert report["links"] == [{"label": "the chart", "url": "https://example.com/chart"}]
    assert report["context"] == {"symbol": "NVDA", "practice_day": "2026-10-23"}
    assert report["area"] == "practice" and report["reported_by"] == "spouse"  # never the address itself
    assert [(e["actor"], e["from_status"], e["to_status"]) for e in report["events"]] == [("user", None, "open")]
    assert report["attachments"] == []


def test_every_timestamp_is_iso_utc_with_z_and_reads_are_no_store(client):
    report = file_report(client)
    for stamp in (report["updated_at"], report["captured_at"], report["events"][0]["at"]):
        assert stamp.endswith("Z")
    response = client.get(f"{BASE}/{report['id']}", headers=auth_headers())
    assert response.headers["cache-control"] == "no-store"
    assert client.get(BASE, headers=auth_headers()).headers["cache-control"] == "no-store"


def test_a_feature_request_carries_no_severity_and_a_bug_must(client):
    request = file_report(client, kind="request", severity=None)
    assert request["kind"] == "request" and request["severity"] is None
    too_much = client.post(BASE, json=report_body(kind="request", severity="P1"), headers=auth_headers())
    assert too_much.status_code == 422 and ("severity", "A feature request has no severity") in problems(too_much)
    too_little = client.post(BASE, json=report_body(severity=None), headers=auth_headers())
    assert too_little.status_code == 422 and ("severity", "A bug needs a severity") in problems(too_little)


@pytest.mark.parametrize(
    ("over", "path"),
    [
        ({"title": "   "}, "title"),
        ({"title": "x" * 121}, "title"),
        ({"body": ""}, "body"),
        ({"route": "practice"}, "route"),
        ({"captured_at": "2026-10-26T14:03:00"}, "captured_at"),  # no timezone
        ({"links": [{"url": "javascript:alert(1)"}]}, "links.0.url"),
        ({"links": [{"url": "https://example.com/a b"}]}, "links.0.url"),
        ({"links": [{"url": "https://example.com"}] * 11}, "links"),
        ({"attachment_ids": list(range(1, 8))}, "attachment_ids"),
        ({"kind": "idea", "severity": None}, "kind"),
    ],
)
def test_a_field_problem_is_the_problems_list_of_the_desk(client, over, path):
    response = client.post(BASE, json=report_body(**over), headers=auth_headers())
    assert response.status_code == 422
    assert path in {p["path"] for p in response.json()["detail"]["problems"]}


def test_without_the_gateway_identity_every_feedback_route_is_401_even_with_a_body(client):
    assert client.post(BASE, json=report_body()).status_code == 401
    assert client.patch(f"{BASE}/1", json={"status": "fixed", "fix_ref": "1a2b3c4"}).status_code == 401
    shot = {"file": ("a.png", PNG, "image/png")}
    assert client.post(f"{BASE}/attachments", files=shot).status_code == 401
    assert client.post(f"{BASE}/1/attachments", files=shot).status_code == 401
    assert client.get(f"{BASE}/attachments/1").status_code == 401
    assert client.delete(f"{BASE}/attachments/1").status_code == 401
    assert client.get(f"{BASE}?status=open").status_code == 401


def test_a_body_that_is_not_json_is_a_problem_not_a_crash(client):
    response = client.post(BASE, content=b"not json", headers={**auth_headers(), "Content-Type": "application/json"})
    assert response.status_code == 422 and ("", "Send a JSON body") in problems(response)


# -- visibility and the dashboard ---------------------------------------------------------------------------


def test_every_signed_in_user_reads_every_report(client):
    mine = file_report(client, email=OTHER_EMAIL)
    for email in (OWNER_EMAIL, THIRD_EMAIL):
        assert client.get(f"{BASE}/{mine['id']}", headers=auth_headers(email)).json()["title"] == mine["title"]
        assert [i["id"] for i in client.get(BASE, headers=auth_headers(email)).json()["items"]] == [mine["id"]]


def test_a_missing_report_is_a_plain_404(client):
    response = client.get(f"{BASE}/99999", headers=auth_headers())
    assert response.status_code == 404 and response.json() == {"detail": "feedback report not found"}


def test_the_list_filters_sorts_pages_and_counts_over_the_whole_log(client):
    bug = file_report(client, title="Axis flips", route="/practice/day?id=5")
    request = file_report(client, kind="request", severity=None, title="Add a dark mode", route="/settings")
    third = file_report(client, title="Slow table", body="the 100% table is slow", route="/")
    patch(client, bug["id"], {"status": "in_progress"})

    def ids(query):
        return [i["id"] for i in client.get(f"{BASE}?{query}", headers=auth_headers()).json()["items"]]

    assert ids("") == [third["id"], request["id"], bug["id"]]  # newest first
    assert ids("sort=oldest") == [bug["id"], request["id"], third["id"]]
    assert ids("sort=updated")[0] == bug["id"]  # the status change touched it last
    assert ids("kind=request") == [request["id"]]
    assert ids("status=in_progress") == [bug["id"]]
    assert ids("status=in_progress&status=open") == [third["id"], request["id"], bug["id"]]
    assert ids("area=practice") == [bug["id"]] and ids("area=settings") == [request["id"]]
    assert ids("area=home") == [third["id"]]
    assert ids("q=dark") == [request["id"]] and ids("q=100%25") == [third["id"]]  # % is a letter, not a wildcard
    assert ids("limit=1") == [third["id"]] and ids("limit=1&offset=1") == [request["id"]]
    page = client.get(f"{BASE}?kind=request", headers=auth_headers()).json()
    assert page["counts"] == {"open": 2, "in_progress": 1, "fixed": 0, "wont_fix": 0, "duplicate": 0}
    keys = "id ref kind severity title route area reported_by updated_at status fix_ref".split()
    assert set(page["items"][0]) == set(keys)


@pytest.mark.parametrize("query", ["limit=0", "limit=101", "offset=-1", "sort=sideways", "status=done", "kind=idea"])
def test_a_bad_query_is_a_422_problem(client, query):
    response = client.get(f"{BASE}?{query}", headers=auth_headers())
    assert response.status_code == 422 and response.json()["detail"]["problems"]


# -- status: who may set what -------------------------------------------------------------------------------


def test_a_filer_cannot_change_a_status_and_the_owner_can(client):
    report = file_report(client)
    refused = patch(client, report["id"], {"status": "in_progress"}, email=OTHER_EMAIL)
    assert refused.status_code == 403
    done = patch(client, report["id"], {"status": "in_progress", "note": "on it"})
    assert done.status_code == 200 and done.json()["status"] == "in_progress"
    assert [(e["actor"], e["from_status"], e["to_status"], e["note"]) for e in done.json()["events"]][-1] == (
        "owner",
        "open",
        "in_progress",
        "on it",
    )


def test_one_forbidden_transition_is_a_409_and_changes_nothing(client):
    report = file_report(client)
    assert patch(client, report["id"], {"status": "fixed", "fix_ref": "1a2b3c4"}).status_code == 200
    back = patch(client, report["id"], {"status": "in_progress"})  # fixed cannot go to in progress, only reopen
    assert back.status_code == 409
    twice = patch(client, report["id"], {"status": "fixed", "fix_ref": "1a2b3c4"})
    assert twice.status_code == 409
    seen = client.get(f"{BASE}/{report['id']}", headers=auth_headers()).json()
    assert seen["status"] == "fixed" and len(seen["events"]) == 2


def test_every_transition_the_table_lists_works_and_the_rest_are_409(client):
    allowed = {
        ("open", "in_progress"),
        ("in_progress", "open"),
        ("open", "fixed"),
        ("in_progress", "fixed"),
        ("open", "wont_fix"),
        ("in_progress", "wont_fix"),
        ("open", "duplicate"),
        ("in_progress", "duplicate"),
        ("fixed", "open"),
        ("wont_fix", "open"),
        ("duplicate", "open"),
    }
    original = file_report(client, title="the original")
    statuses = ("open", "in_progress", "fixed", "wont_fix", "duplicate")
    extra = {
        "fixed": {"fix_ref": "1a2b3c4"},
        "wont_fix": {"note": "works as designed"},
        "duplicate": {"duplicate_of": original["id"]},
    }
    for start in statuses:
        for end in statuses:
            report = file_report(client)
            if start != "open":  # every status is one move from `open`
                assert patch(client, report["id"], {"status": start, **extra.get(start, {})}).status_code == 200
            response = patch(client, report["id"], {"status": end, **extra.get(end, {})})
            assert response.status_code == (200 if (start, end) in allowed else 409), (start, end, response.text)


def test_fixed_needs_a_valid_fix_reference(client):
    report = file_report(client)
    for bad in (None, "", "abc", "not-a-hash", "1a2b3c4 and", "x" * 41, "PR 12"):
        body = {"status": "fixed", **({} if bad is None else {"fix_ref": bad})}
        response = patch(client, report["id"], body)
        assert response.status_code == 422 and response.json()["detail"]["problems"][0]["path"] == "fix_ref", bad
    for good in (
        "1a2b3c4",
        "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
        "PR #123",
        "1a2b3c4 and PR #123",
        "1a2b3c4, PR #9",
    ):
        other = file_report(client)
        assert patch(client, other["id"], {"status": "fixed", "fix_ref": good}).json()["fix_ref"] == good


def test_wont_fix_needs_a_note_and_duplicate_needs_a_different_existing_original(client):
    report, original = file_report(client), file_report(client, title="the original")
    assert patch(client, report["id"], {"status": "wont_fix"}).status_code == 422
    assert patch(client, report["id"], {"status": "wont_fix", "note": "  "}).status_code == 422
    for bad in (None, report["id"], 99999):
        body = {"status": "duplicate", **({} if bad is None else {"duplicate_of": bad})}
        response = patch(client, report["id"], body)
        assert response.status_code == 422 and response.json()["detail"]["problems"][0]["path"] == "duplicate_of", bad
    done = patch(client, report["id"], {"status": "duplicate", "duplicate_of": original["id"]}).json()
    assert done["status"] == "duplicate" and done["duplicate_of"] == original["id"]
    assert done["events"][-1]["note"] == f"Duplicate of {ref(original['id'])}"


def test_a_fix_reference_or_an_original_on_the_wrong_status_is_422(client):
    report = file_report(client)
    assert patch(client, report["id"], {"status": "in_progress", "fix_ref": "1a2b3c4"}).status_code == 422
    assert patch(client, report["id"], {"status": "in_progress", "duplicate_of": report["id"]}).status_code == 422
    assert patch(client, report["id"], {"note": "no status"}).status_code == 422


def test_a_reopen_clears_the_reference_and_the_old_one_stays_in_the_timeline(client):
    report = file_report(client)
    fixed = patch(client, report["id"], {"status": "fixed", "fix_ref": "1a2b3c4", "note": "shipped"}).json()
    assert fixed["fix_ref"] == "1a2b3c4" and fixed["events"][-1]["note"] == "1a2b3c4 · shipped"
    assert patch(client, report["id"], {"status": "open"}, email=OTHER_EMAIL).status_code == 403
    reopened = patch(client, report["id"], {"status": "open", "note": "it came back"}).json()
    assert reopened["status"] == "open" and reopened["fix_ref"] is None
    assert [e["to_status"] for e in reopened["events"]] == ["open", "fixed", "open"]
    assert reopened["events"][1]["note"] == "1a2b3c4 · shipped"


# -- the filer's own edit -----------------------------------------------------------------------------------


def test_the_filer_edits_her_own_report_while_it_is_open(client):
    report = file_report(client)
    done = patch(
        client,
        report["id"],
        {"title": "New title", "severity": "P1", "expected": None, "links": [{"url": "https://example.com/new"}]},
        email=OTHER_EMAIL,
    )
    assert done.status_code == 200
    seen = done.json()
    assert seen["title"] == "New title" and seen["severity"] == "P1" and seen["expected"] is None
    assert seen["links"] == [{"label": None, "url": "https://example.com/new"}]
    assert len(seen["events"]) == 1  # an edit is not a status change


def test_nobody_edits_another_persons_text_not_even_the_owner(client):
    report = file_report(client, email=OTHER_EMAIL)
    for email in (OWNER_EMAIL, THIRD_EMAIL):
        assert patch(client, report["id"], {"title": "mine now"}, email=email).status_code == 403
    assert client.get(f"{BASE}/{report['id']}", headers=auth_headers()).json()["title"] == report["title"]


def test_an_edit_is_refused_once_the_report_is_not_open_and_when_it_names_nothing_valid(client):
    report = file_report(client)
    assert patch(client, report["id"], {}, email=OTHER_EMAIL).status_code == 422
    assert patch(client, report["id"], {"title": None}, email=OTHER_EMAIL).status_code == 422
    assert patch(client, report["id"], {"status": "open", "title": "both"}).status_code == 422
    assert patch(client, report["id"], {"kind": "request"}, email=OTHER_EMAIL).status_code == 422  # not editable
    request = file_report(client, kind="request", severity=None)
    assert patch(client, request["id"], {"severity": "P1"}, email=OTHER_EMAIL).status_code == 422
    patch(client, report["id"], {"status": "in_progress"})
    assert patch(client, report["id"], {"title": "late"}, email=OTHER_EMAIL).status_code == 409


def test_patching_a_missing_report_is_404(client):
    assert patch(client, 99999, {"status": "open"}).status_code == 404
    assert patch(client, 99999, {"title": "x"}, email=OTHER_EMAIL).status_code == 404


# -- screenshots --------------------------------------------------------------------------------------------


def test_staging_stores_a_screenshot_with_no_report_and_serves_it_back_to_its_uploader_only(client):
    staged = stage(client)
    assert staged.status_code == 201
    shot = staged.json()
    assert shot["report_id"] is None and shot["content_type"] == "image/png" and shot["size_bytes"] == len(PNG)
    assert shot["filename"] == "shot.png"
    mine = client.get(f"{BASE}/attachments/{shot['id']}", headers=auth_headers(OTHER_EMAIL))
    assert mine.status_code == 200 and mine.content == PNG
    assert mine.headers["content-type"] == "image/png"
    assert mine.headers["content-disposition"] == "inline"
    assert mine.headers["x-content-type-options"] == "nosniff"
    assert mine.headers["cache-control"] == "private, no-store"
    for email in (OWNER_EMAIL, THIRD_EMAIL):  # a staged file is not the caller's: not found, never forbidden
        assert client.get(f"{BASE}/attachments/{shot['id']}", headers=auth_headers(email)).status_code == 404
    assert client.get(f"{BASE}/attachments/99999", headers=auth_headers()).status_code == 404


def test_removing_a_staged_screenshot_frees_its_slot_and_its_bytes(client):
    shots = [stage(client).json() for _ in range(6)]
    assert stage(client).status_code == 409  # six staged: the seventh waits
    gone = client.delete(f"{BASE}/attachments/{shots[0]['id']}", headers=auth_headers(OTHER_EMAIL))
    assert gone.status_code == 204 and gone.content == b""
    assert gone.headers["cache-control"] == "no-store"
    assert client.get(f"{BASE}/attachments/{shots[0]['id']}", headers=auth_headers(OTHER_EMAIL)).status_code == 404
    assert stage(client).status_code == 201  # the slot is free again, no 24-hour wait
    assert client.delete(f"{BASE}/attachments/{shots[0]['id']}", headers=auth_headers(OTHER_EMAIL)).status_code == 404


def test_a_staged_screenshot_is_removed_by_its_uploader_alone(client):
    shot = stage(client).json()
    for email in (OWNER_EMAIL, THIRD_EMAIL):  # not the caller's: not found, and the file is untouched
        assert client.delete(f"{BASE}/attachments/{shot['id']}", headers=auth_headers(email)).status_code == 404
    assert client.get(f"{BASE}/attachments/{shot['id']}", headers=auth_headers(OTHER_EMAIL)).status_code == 200
    assert client.delete(f"{BASE}/attachments/99999", headers=auth_headers()).status_code == 404


def test_a_screenshot_already_on_a_report_cannot_be_removed(client):
    shot = stage(client).json()
    report = file_report(client, attachment_ids=[shot["id"]])
    refused = client.delete(f"{BASE}/attachments/{shot['id']}", headers=auth_headers(OTHER_EMAIL))
    assert refused.status_code == 409 and "already on a report" in refused.json()["detail"]
    assert [a["id"] for a in client.get(f"{BASE}/{report['id']}", headers=auth_headers()).json()["attachments"]] == [
        shot["id"]
    ]
    # someone else's attached file is a 404 for the caller, never a hint that it exists
    assert client.delete(f"{BASE}/attachments/{shot['id']}", headers=auth_headers(OWNER_EMAIL)).status_code == 404


def test_the_type_is_decided_by_magic_bytes_not_by_the_header_or_the_name(client):
    assert stage(client, JPEG, name="a.jpg", content_type="image/jpeg").json()["content_type"] == "image/jpeg"
    assert stage(client, WEBP, name="a.webp", content_type="image/webp").json()["content_type"] == "image/webp"
    lying = stage(client, JPEG, name="really.png", content_type="image/png")  # a JPEG called a PNG is stored as JPEG
    assert lying.status_code == 201 and lying.json()["content_type"] == "image/jpeg"
    for data in (b"GIF89a" + b"\x00" * 20, b"<svg></svg>", b"plain text", b"", b"RIFF\x00\x00\x00\x00WAVEfmt "):
        refused = stage(
            client, data, name="shot.png", content_type="image/png"
        )  # the header says PNG; the bytes do not
        assert refused.status_code == 415, data


def test_a_screenshot_over_five_megabytes_is_413_and_exactly_five_is_stored(client):
    exactly = PNG + b"\x00" * (MAX_ATTACHMENT_BYTES - len(PNG))
    assert len(exactly) == MAX_ATTACHMENT_BYTES
    assert stage(client, exactly).status_code == 201
    over = stage(client, exactly + b"\x00")  # one byte past the limit
    assert over.status_code == 413 and "limit is 5 MB" in over.json()["detail"]
    way_over = stage(client, PNG + b"\x00" * (MAX_BODY_BYTES + 1))  # past the body cap: refused before it is parsed
    assert way_over.status_code == 413


def test_a_chunked_body_with_no_length_is_cut_off_at_the_cap(client):
    def chunks():
        yield b"--b\r\nContent-Disposition: form-data; name=file; filename=a.png\r\n\r\n"
        for _ in range(MAX_BODY_BYTES // 65536 + 2):
            yield b"\x00" * 65536

    response = client.post(
        f"{BASE}/attachments",
        content=chunks(),
        headers={**auth_headers(OTHER_EMAIL), "Content-Type": "multipart/form-data; boundary=b"},
    )
    assert response.status_code == 413


def test_read_capped_stops_pulling_the_stream_the_moment_it_passes_the_limit():
    pulled = []

    async def stream():
        for n in range(1000):
            pulled.append(n)
            yield b"x" * 1024

    with pytest.raises(HTTPException) as caught:
        asyncio.run(read_capped(stream(), 10 * 1024))
    assert caught.value.status_code == 413
    assert len(pulled) == 11  # eleven chunks cross ten KiB; the other 989 are never read


def test_a_request_that_is_not_multipart_or_has_no_file_field_is_422(client):
    plain = client.post(f"{BASE}/attachments", content=PNG, headers={**auth_headers(), "Content-Type": "image/png"})
    assert plain.status_code == 422 and (
        "file",
        "Send the screenshot as multipart form data, in a field named file",
    ) in problems(plain)
    wrong = client.post(f"{BASE}/attachments", files={"photo": ("a.png", PNG, "image/png")}, headers=auth_headers())
    assert wrong.status_code == 422 and wrong.json()["detail"]["problems"][0]["path"] == "file"


def test_a_user_holds_six_staged_screenshots_and_the_seventh_is_409(client):
    for _ in range(6):
        assert stage(client).status_code == 201
    seventh = stage(client)
    assert seventh.status_code == 409
    assert stage(client, email=THIRD_EMAIL).status_code == 201  # the cap is per user


def test_staged_files_older_than_a_day_are_swept_by_the_next_staging_call(client, db_session):
    for _ in range(6):
        stage(client)
    old = datetime.now(UTC) - STAGED_TTL - timedelta(minutes=1)
    db_session.execute(update(FeedbackAttachment).values(created_at=old))
    fresh = stage(client)  # the sweep clears the six stale ones first, so this is no seventh
    assert fresh.status_code == 201
    left = db_session.scalars(select(FeedbackAttachment.id)).all()
    assert left == [fresh.json()["id"]]


def test_the_sweep_leaves_staged_files_under_a_day_and_attached_files_of_any_age(client, db_session):
    report = file_report(client)
    attached = client.post(
        f"{BASE}/{report['id']}/attachments",
        files={"file": ("a.png", PNG, "image/png")},
        headers=auth_headers(OTHER_EMAIL),
    ).json()
    young = stage(client).json()
    db_session.execute(
        update(FeedbackAttachment)
        .where(FeedbackAttachment.id == attached["id"])
        .values(created_at=datetime.now(UTC) - timedelta(days=30))
    )
    db_session.execute(
        update(FeedbackAttachment)
        .where(FeedbackAttachment.id == young["id"])
        .values(created_at=datetime.now(UTC) - STAGED_TTL + timedelta(minutes=5))
    )
    assert stage(client).status_code == 201
    assert {a.id for a in db_session.scalars(select(FeedbackAttachment)).all()} >= {attached["id"], young["id"]}


def test_a_report_takes_the_callers_own_staged_screenshots_and_only_those(client):
    mine, spare = stage(client).json(), stage(client).json()
    theirs = stage(client, email=THIRD_EMAIL).json()
    stolen = client.post(BASE, json=report_body(attachment_ids=[theirs["id"]]), headers=auth_headers(OTHER_EMAIL))
    assert stolen.status_code == 422 and stolen.json()["detail"]["problems"][0]["path"] == "attachment_ids"
    missing = client.post(BASE, json=report_body(attachment_ids=[99999]), headers=auth_headers(OTHER_EMAIL))
    assert missing.status_code == 422
    twice = client.post(BASE, json=report_body(attachment_ids=[mine["id"]] * 2), headers=auth_headers(OTHER_EMAIL))
    assert twice.status_code == 422
    report = file_report(client, attachment_ids=[mine["id"]])
    assert report["attachments"] == [
        {"id": mine["id"], "filename": "shot.png", "size_bytes": len(PNG), "content_type": "image/png"}
    ]
    for email in (OWNER_EMAIL, THIRD_EMAIL):  # attached: every signed-in user reads it, like the report
        assert client.get(f"{BASE}/attachments/{mine['id']}", headers=auth_headers(email)).content == PNG
    reuse = client.post(BASE, json=report_body(attachment_ids=[mine["id"]]), headers=auth_headers(OTHER_EMAIL))
    assert reuse.status_code == 422  # already attached: no longer staged
    assert client.get(f"{BASE}/attachments/{spare['id']}", headers=auth_headers(OWNER_EMAIL)).status_code == 404


def test_a_report_holds_six_screenshots_and_the_seventh_is_409(client):
    report = file_report(client)
    url = f"{BASE}/{report['id']}/attachments"
    for _ in range(6):
        assert (
            client.post(url, files={"file": ("a.png", PNG, "image/png")}, headers=auth_headers(OTHER_EMAIL)).status_code
            == 201
        )
    seventh = client.post(url, files={"file": ("a.png", PNG, "image/png")}, headers=auth_headers(OTHER_EMAIL))
    assert seventh.status_code == 409
    assert len(client.get(f"{BASE}/{report['id']}", headers=auth_headers()).json()["attachments"]) == 6


def test_adding_a_screenshot_is_for_the_filer_and_the_owner_and_obeys_the_same_limits(client):
    report = file_report(client, email=OTHER_EMAIL)
    url = f"{BASE}/{report['id']}/attachments"
    shot = {"file": ("a.png", PNG, "image/png")}
    assert client.post(url, files=shot, headers=auth_headers(THIRD_EMAIL)).status_code == 403
    added = client.post(url, files=shot, headers=auth_headers(OWNER_EMAIL))
    assert added.status_code == 201 and added.json()["report_id"] == report["id"]
    assert (
        client.post(url, files={"file": ("a.png", b"nope", "image/png")}, headers=auth_headers(OTHER_EMAIL)).status_code
        == 415
    )
    big = PNG + b"\x00" * MAX_ATTACHMENT_BYTES
    assert (
        client.post(url, files={"file": ("a.png", big, "image/png")}, headers=auth_headers(OTHER_EMAIL)).status_code
        == 413
    )
    assert client.post(f"{BASE}/99999/attachments", files=shot, headers=auth_headers()).status_code == 404


def test_the_filename_is_cleaned_and_never_a_path(client):
    shot = stage(client, name="../../etc/passwd\x00.png").json()
    assert "/" not in shot["filename"] and "\x00" not in shot["filename"] and not shot["filename"].startswith(".")
    unnamed = stage(client, name="").json()
    assert unnamed["filename"] == "screenshot.png"


# -- the multipart cut --------------------------------------------------------------------------------------


def multipart(parts, boundary="XyZ"):
    out = b""
    for headers, data in parts:
        out += f"--{boundary}\r\n{headers}\r\n\r\n".encode() + data + b"\r\n"
    return out + f"--{boundary}--\r\n".encode()


CONTENT_TYPE = "multipart/form-data; boundary=XyZ"


def test_the_file_part_is_cut_out_byte_for_byte_whatever_the_file_holds():
    # CRLFs, a lone CR, header-looking text and a `--XyZ` that no CRLF precedes: none of it ends the part
    tricky = PNG + b"\r\n\r\nContent-Disposition: form-data; name=file\r\n\r\r\n\n--XyZ tail\x00\xff"
    body = multipart(
        [
            ('Content-Disposition: form-data; name="note"', b"hello"),
            ('Content-Disposition: form-data; name="file"; filename="a b.png"\r\nContent-Type: image/png', tricky),
        ]
    )
    assert file_part(CONTENT_TYPE, body) == ("a b.png", tricky)


def test_the_file_part_is_none_when_there_is_no_file_field_or_no_boundary_and_empty_is_kept():
    no_file = multipart([('Content-Disposition: form-data; name="x"', b"1")])
    assert file_part(CONTENT_TYPE, no_file) is None
    named = multipart([('Content-Disposition: form-data; name="file"; filename="a.png"', PNG)])
    assert file_part("multipart/form-data", named) is None
    empty = multipart([('Content-Disposition: form-data; name="file"; filename="e.png"', b"")])
    assert file_part(CONTENT_TYPE, empty) == ("e.png", b"")
