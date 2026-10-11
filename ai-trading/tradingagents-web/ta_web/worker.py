"""Isolated research execution: one run per subprocess.

Invoked by :class:`ta_web.runner.Runner` as
``python -m ta_web.worker --root ROOT --run-id ID``; never runs in the HTTP
process (protocol.md "no HTTP in-process research"). Also importable
directly as :func:`run_research` for tests, with a fake ``graph_factory``.
"""

from __future__ import annotations

import argparse
import copy
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .domain import clean_state, safe_settings
from .reports import ReportError, publish, run_directory
from .store import Store

# Fixed, exception-text-free codes (protocol.md: never raw exception/provider
# strings in a persisted record).
RESEARCH_FAILED = "RESEARCH_FAILED"
EXPORT_FAILED = "EXPORT_FAILED"


def research_stage(state: dict) -> str:
    """Which phase ``state`` reflects, from its populated report fields."""
    if state.get("final_trade_decision"):
        return "finished"
    if state.get("risk_debate_state"):
        return "risk"
    if state.get("trader_investment_plan"):
        return "trading"
    if state.get("investment_plan") or state.get("investment_debate_state"):
        return "research"
    return "analyst"


def _default_graph_factory(*, selected_analysts, config):
    # Lazy import: the HTTP process never needs the upstream graph (LLM
    # clients, graph compile), and tests supply a fake graph instead.
    from tradingagents.graph.trading_graph import TradingAgentsGraph

    return TradingAgentsGraph(selected_analysts, config=config)


def _run_config(store: Store, owner: str, run_id: str, research_depth: int | None) -> dict:
    """Deep-copied ``DEFAULT_CONFIG`` with this run's isolated paths.

    Results/cache live under :func:`ta_web.reports.run_directory` (per run
    id — never shared across runs, which is what keeps upstream's
    ticker+date-keyed checkpoint from being reused across distinct run ids,
    since each run id gets its own ``data_cache_dir``). Memory is per owner,
    under ``Store.research_dir`` directly, as upstream's single append-only
    log is designed for. Both anchor on the Store's own ``research_dir``
    rather than rebuilding ``root/research`` independently. Depth, when
    given, overrides both round counts explicitly; omitted keeps whatever
    the environment already set on ``DEFAULT_CONFIG``.
    """
    from tradingagents.default_config import DEFAULT_CONFIG

    config = copy.deepcopy(DEFAULT_CONFIG)
    run_dir = run_directory(store, owner, run_id)
    config["results_dir"] = str(run_dir / "results")
    config["data_cache_dir"] = str(run_dir / "cache")
    config["memory_log_path"] = str(store.research_dir / "users" / owner / "memory" / "trading_memory.md")
    if research_depth is not None:
        config["max_debate_rounds"] = research_depth
        config["max_risk_discuss_rounds"] = research_depth
    return config


def run_research(root: Path, id: str, graph_factory: Callable[..., Any] | None = None) -> None:
    """Run one record's research to completion. Never raises.

    Every failure is recorded on the run as a fixed error code and whatever
    partial snapshot exists — never exception text, raw tool messages, or
    config/credential paths. When real report text survived a failure, a
    partial export is still published so a partial download is possible;
    :func:`ta_web.reports.publish` itself refuses a header-only non-export.
    """
    store = Store(root)
    run = store.worker_run(id)
    inputs = run["inputs"]
    owner = run["owner_id"]
    ticker, trade_date, asset_type = inputs["ticker"], inputs["analysis_date"], inputs["asset_type"]
    factory = graph_factory or _default_graph_factory
    config = _run_config(store, owner, id, inputs.get("research_depth"))

    state: dict = {}
    try:
        graph = factory(selected_analysts=inputs["analysts"], config=config)
        store.update(id, settings=safe_settings(graph.run_settings()))
        initial = graph.create_run_state(ticker, trade_date, asset_type)
        thread_id = graph.begin_checkpoint(ticker, trade_date, asset_type)
        args = graph.propagator.get_graph_args()
        if thread_id is not None:
            args.setdefault("config", {}).setdefault("configurable", {})["thread_id"] = thread_id
        state = dict(initial)
        try:
            for _messages, chunk in graph.stream_run(graph.checkpoint_input(initial), **args):
                if chunk:
                    state.update(chunk)
                    store.update(id, state=clean_state(state), stage=research_stage(state))
            graph.record_decision(ticker, trade_date, state)
            graph.clear_checkpoint_on_success(ticker, trade_date, asset_type)
        finally:
            graph.end_checkpoint()
    except Exception:  # noqa: BLE001 -- upstream graph/provider SDK call: any
        # exception type must become the fixed RESEARCH_FAILED code instead of
        # letting a raw provider/secret-bearing exception propagate, or
        # leaving the record stuck "running" (protocol.md: never exception
        # text; "never leaves Busy permanently occupied").
        cleaned = clean_state(state)
        store.update(id, status="failed", state=cleaned, partial=bool(cleaned), error_code=RESEARCH_FAILED)
        if cleaned:
            try:
                publish(store, id)
            except ReportError:
                # Expected: reports.publish refuses a header-only non-export,
                # or reports its own wrapped write/fsync/rename failure, as
                # ReportError. The failed/RESEARCH_FAILED record above already
                # stands either way -- this is only a best-effort bonus export
                # of whatever partial text survived, so there is nothing left
                # to protect by catching more broadly here.
                pass
        return

    try:
        publish(store, id)
    except Exception:  # noqa: BLE001 -- publish() is not exclusively ReportError
        # (e.g. a filesystem/store failure outside its own wrapped
        # write/fsync/rename step); the record is still "running" at this
        # point, so any failure here must still become the fixed
        # EXPORT_FAILED code rather than leave it stuck running.
        store.update(id, status="failed", partial=True, error_code=EXPORT_FAILED)
        return

    store.update(id, status="completed")


def _main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()
    run_research(Path(args.root), args.run_id)


if __name__ == "__main__":
    _main()
