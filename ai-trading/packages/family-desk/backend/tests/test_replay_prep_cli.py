"""The replay prep CLI wiring: arguments, the database guard, and the cache status line. No network."""

import pytest
from sqlalchemy.engine import Engine

from ai_trading.cli import replay_prep
from ai_trading.replay.cache import BlobKey, DbBlobStore


def test_bars_needs_symbols_and_a_database(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.delenv(replay_prep.DATABASE_URL_VAR, raising=False)
    assert replay_prep.main(["bars", "--symbols", "NVDA"]) == 2
    assert "DESK_RUNTIME_DATABASE_URL is not set" in capsys.readouterr().err


def test_the_symbol_universe_comes_from_flags_or_a_file(tmp_path) -> None:
    args = replay_prep.build_parser().parse_args(["bars", "--symbols", "nvda, amd,NVDA"])
    assert replay_prep._symbols(args, None) == ["NVDA", "AMD"]
    universe = tmp_path / "u.txt"
    universe.write_text("TSLA  # day mover\n\n# a comment line\nPLTR\n")
    args = replay_prep.build_parser().parse_args(["bars", "--file", str(universe)])
    assert replay_prep._symbols(args, None) == ["TSLA", "PLTR"]


def test_tape_is_opt_in_per_day() -> None:
    with pytest.raises(SystemExit):  # no --days: argparse refuses
        replay_prep.build_parser().parse_args(["tape", "--symbols", "NVDA"])


def test_status_reports_what_the_cache_holds(
    db_engine: Engine, db_session, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from datetime import date

    DbBlobStore(db_session).put(BlobKey("bars1m", "NVDA", date(2026, 9, 25), "", "sip"), b"x" * 10, 960, 5760)
    db_session.commit()
    monkeypatch.setenv(replay_prep.DATABASE_URL_VAR, db_engine.url.render_as_string(hide_password=False))
    assert replay_prep.main(["status"]) == 0
    assert "bars1m" in capsys.readouterr().out
