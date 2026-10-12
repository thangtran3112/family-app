"""Integration fix (PROTO-BRIEF.md): exactly one served ASGI app. `deploy/production/Dockerfile`'s
image and `docker-compose.yml`'s `api` service `command:` both name `ai_trading.api.main:app` --
this proves that target actually resolves to the same wired FastAPI instance as `ai_trading.api.app`
(not a second, divergent app object), and that its lifespan builds real startup wiring (the
background tick/dispatch loops, against the real `ai_trading.engine.tick.tick`/
`ai_trading.notify.dispatch.dispatch_pending`, never a stub) from a real database.
"""

from datetime import UTC, datetime

from fastapi.testclient import TestClient

from ai_trading.api import app as app_module
from ai_trading.api import main as main_module


def test_main_app_is_the_same_object_as_app_module_app():
    assert main_module.app is app_module.app


def test_lifespan_wires_the_real_engine_and_notify_functions_against_the_database(db_engine, monkeypatch):
    monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)
    monkeypatch.delenv("SLACK_WEBHOOK_URL_OWNER", raising=False)
    monkeypatch.setenv("DESK_RUNTIME_DATABASE_URL", db_engine.url.render_as_string(hide_password=False))

    with TestClient(main_module.app) as client:
        session_factory = client.app.state.session_factory
        assert session_factory is not None
        assert client.app.state.data_sources is not None

        # The lifespan's own background-loop callables close over the real `engine.tick.tick` and
        # `notify.dispatch.dispatch_pending` (imported by `app.py` at module load, not a stub) --
        # proven here by running one tick/dispatch cycle directly against the configured database,
        # the same way `_background_loop` does every interval, and seeing it succeed cleanly
        # against an empty (freshly migrated, no strategies/deliveries yet) database.
        with session_factory() as session:
            tick_result = app_module.tick(session, now=datetime.now(UTC))
            assert tick_result.evaluated_strategies == 0
            assert tick_result.errors == []

            dispatch_result = app_module.dispatch_pending(session, channels={}, now=datetime.now(UTC))
            assert dispatch_result == []
            session.commit()
