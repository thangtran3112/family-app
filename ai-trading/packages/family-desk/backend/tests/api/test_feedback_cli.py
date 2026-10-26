"""The feedback CLI (02s) against the same database as the API: both call `ai_trading.feedback`, so a transition is the
same row, the same timeline and the same refusal whichever way it arrives. The API reports are committed first, because
the CLI is a separate connection."""

import json
from pathlib import Path

import pytest
from conftest import OTHER_EMAIL, auth_headers
from feedback_world import BASE, JPEG, OWNER_ENV, PNG, file_report, patch, stage

from ai_trading.cli import feedback as cli
from ai_trading.feedback import ref


@pytest.fixture(autouse=True)
def owner_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DESK_OWNER_EMAILS", OWNER_ENV)


@pytest.fixture
def run(client, db_engine, db_session, monkeypatch: pytest.MonkeyPatch, capsys):
    """`run("fix", "F-001", ...)` -> (exit code, stdout, stderr). The client fixture clears the database URL when it
    starts, so this one (requested after it) sets it back, pointing at the test database."""
    monkeypatch.setenv("DESK_RUNTIME_DATABASE_URL", db_engine.url.render_as_string(hide_password=False))

    def go(*argv: str) -> tuple[int, str, str]:
        db_session.commit()  # what the API wrote is visible to the CLI's own connection
        capsys.readouterr()
        code = cli.main(list(argv))
        db_session.expire_all()  # and what the CLI wrote is visible to the API's session
        captured = capsys.readouterr()
        return code, captured.out, captured.err

    return go


def detail(client, report_id):
    return client.get(f"{BASE}/{report_id}", headers=auth_headers()).json()


def shape(report):
    """What a transition leaves behind, without the ids, times and who did it."""
    return {
        "status": report["status"],
        "fix_ref": report["fix_ref"],
        "duplicate_of": report["duplicate_of"],
        "events": [(e["from_status"], e["to_status"], e["note"]) for e in report["events"]],
    }


def test_the_same_transition_through_the_api_and_the_cli_leaves_the_same_report(client, run):
    via_api, via_cli = file_report(client), file_report(client)
    assert patch(client, via_api["id"], {"status": "in_progress"}).status_code == 200
    assert run("start", ref(via_cli["id"]), "--actor", "claude-code")[0] == 0
    assert patch(client, via_api["id"], {"status": "fixed", "fix_ref": "1a2b3c4 and PR #12"}).status_code == 200
    code, out, _ = run("fix", ref(via_cli["id"]), "--ref", "1a2b3c4 and PR #12", "--actor", "claude-code")
    assert code == 0 and out.strip() == f"{ref(via_cli['id'])}: done"
    api_side, cli_side = detail(client, via_api["id"]), detail(client, via_cli["id"])
    assert shape(api_side) == shape(cli_side)
    assert shape(cli_side)["status"] == "fixed"
    assert [e["actor"] for e in cli_side["events"]] == ["user", "claude-code", "claude-code"]  # the CLI names its actor
    assert [e["actor"] for e in api_side["events"]] == ["user", "owner", "owner"]


def test_the_same_forbidden_moves_are_refused_by_both_with_the_same_reason(client, run):
    report = file_report(client)
    rid = report["id"]
    # an agent may not set won't fix: the API says 403 to a filer, the CLI exits 1 for an agent
    assert patch(client, rid, {"status": "wont_fix", "note": "no"}, email=OTHER_EMAIL).status_code == 403
    code, _, err = run("wontfix", ref(rid), "--note", "no", "--actor", "hermes")
    assert code == 1 and err.startswith("403:")
    code, _, err = run("duplicate", ref(rid), "--of", ref(rid), "--actor", "claude-code")
    assert code == 1 and err.startswith("403:")
    assert detail(client, rid)["status"] == "open"
    # fixed -> in progress has no row in the table: 409 in both
    assert run("fix", ref(rid), "--ref", "1a2b3c4", "--actor", "claude-code")[0] == 0
    assert patch(client, rid, {"status": "in_progress"}).status_code == 409
    code, _, err = run("start", ref(rid), "--actor", "claude-code")
    assert code == 1 and err.startswith("409:")
    # a fix with no valid reference is a 422 problem in both
    other = file_report(client)["id"]
    assert patch(client, other, {"status": "fixed", "fix_ref": "oops"}).status_code == 422
    code, _, err = run("fix", ref(other), "--ref", "oops", "--actor", "claude-code")
    assert code == 1 and err.startswith("fix_ref:")
    assert run("start", "F-99999", "--actor", "hermes")[2].startswith("404:")


def test_the_owner_actor_may_set_wont_fix_and_duplicate_from_the_cli(client, run):
    original, report = file_report(client)["id"], file_report(client)["id"]
    assert run("wontfix", ref(report), "--note", "works as designed", "--actor", "owner")[0] == 0
    seen = detail(client, report)
    assert seen["status"] == "wont_fix" and seen["events"][-1]["note"] == "works as designed"
    third = file_report(client)["id"]
    assert run("duplicate", ref(third), "--of", ref(original), "--actor", "owner")[0] == 0
    assert detail(client, third)["duplicate_of"] == original


def test_a_missing_actor_or_a_missing_reason_is_a_usage_error(client, run):
    rid = file_report(client)["id"]
    for argv in (
        ("start", ref(rid)),
        ("wontfix", ref(rid), "--actor", "owner"),
        ("start", "nonsense", "--actor", "hermes"),
    ):
        with pytest.raises(SystemExit) as caught:
            run(*argv)
        assert caught.value.code == 2
    assert detail(client, rid)["status"] == "open"


def test_list_json_is_what_the_api_answers(client, run):
    first, second = file_report(client), file_report(client, kind="request", severity=None, title="A wish")
    run("start", ref(first["id"]), "--actor", "claude-code")
    code, out, _ = run("list", "--json")
    assert code == 0
    assert json.loads(out) == client.get(BASE, headers=auth_headers()).json()
    code, out, _ = run("list", "--status", "open", "--json")
    assert [i["id"] for i in json.loads(out)["items"]] == [second["id"]]
    assert json.loads(out) == client.get(f"{BASE}?status=open", headers=auth_headers()).json()
    code, out, _ = run("list", "--kind", "bug")
    assert ref(first["id"]) in out and ref(second["id"]) not in out and "open:" in out


def test_show_json_is_the_detail_the_api_answers_and_the_plain_form_reads_well(client, run):
    report = file_report(client)
    code, out, _ = run("show", ref(report["id"]), "--json")
    assert code == 0 and json.loads(out) == detail(client, report["id"])
    code, out, _ = run("show", ref(report["id"]).lower().replace("-", ""))  # f001 is F-001
    assert code == 0 and report["title"] in out and "timeline:" in out and "None -> open" not in out


def test_export_writes_the_screenshots_outside_every_repository(client, run, tmp_path: Path):
    staged = [
        stage(client, PNG).json()["id"],
        stage(client, JPEG, name="b.jpg", content_type="image/jpeg").json()["id"],
    ]
    report = file_report(client, attachment_ids=staged)
    target = tmp_path / "shots"
    code, out, _ = run("export", ref(report["id"]), "--dir", str(target))
    assert code == 0
    written = list(target.iterdir())
    assert {p.read_bytes() for p in written} == {PNG, JPEG} and len(written) == 2
    assert set(out.strip().splitlines()) == {str(p) for p in written}
    assert all(p.name.startswith(f"{ref(report['id'])}-") and "/" not in p.name for p in written)
    inside = Path(__file__).resolve().parent / "must-not-exist"  # this file is inside the git work tree
    code, _, err = run("export", ref(report["id"]), "--dir", str(inside))
    assert code == 2 and "outside every git repository" in err and not inside.exists()
    assert run("export", "F-99999", "--dir", str(target))[0] == 1  # a missing report is a 404, not an empty folder


def test_the_cli_needs_the_database_url(client, run, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("DESK_RUNTIME_DATABASE_URL")
    code, _, err = run("list")
    assert code == 2 and "DESK_RUNTIME_DATABASE_URL is not set" in err
