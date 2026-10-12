"""The Desk's import boundary with `ai_trading_common` (02j §7): Desk code imports only
`ai_trading_common.types`, `sources`, `registry`, `bars`, `errors`, `quality`, and -- in tests
only -- `testing`. It never imports `ai_trading_common.providers`: that module is an
implementation detail of the registry, and importing it from the Desk would let a caller bypass
`DataSources`'s fallback chains and bind to one vendor directly, defeating the whole point of
the registry (02j §1: swapping a vendor needs no edits to the code that uses the data).
"""

import ast
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src" / "ai_trading"
ALLOWED = {f"ai_trading_common.{name}" for name in ("types", "sources", "registry", "bars", "errors", "quality")}


def _violations(source: str) -> list[str]:
    """Every `ai_trading_common` import outside `ALLOWED`, in any form: `import ai_trading_common`
    (attribute access reaches `providers`), `import ai_trading_common.providers.x`,
    `from ai_trading_common.providers... import ...`, and `from ai_trading_common import providers`."""
    found: list[str] = []
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            modules = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom) and node.module:
            if node.module == "ai_trading_common":
                modules = [f"ai_trading_common.{alias.name}" for alias in node.names]
            else:
                modules = [node.module]
        else:
            continue
        found += [m for m in modules if m.split(".")[0] == "ai_trading_common" and m not in ALLOWED]
    return found


def test_desk_code_imports_only_the_public_ai_trading_common_modules():
    for forbidden in (
        "import ai_trading_common",
        "import ai_trading_common.providers.alpaca",
        "from ai_trading_common import providers",
        "from ai_trading_common.providers import alpaca",
        "from ai_trading_common.providers.alpaca import AlpacaBars",
        "from ai_trading_common import testing",
    ):
        assert _violations(forbidden), forbidden
    assert _violations("from ai_trading_common.registry import DataSources\nfrom ai_trading_common import types") == []

    offenders = {str(path): found for path in sorted(SRC.rglob("*.py")) if (found := _violations(path.read_text()))}
    assert offenders == {}
