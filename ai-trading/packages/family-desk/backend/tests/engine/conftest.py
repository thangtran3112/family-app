"""Lets `tests/engine/*` import `tests/bars.py` the same way every other test file in this suite
does. pytest already applies the parent `tests/conftest.py`'s fixtures (`db_session`/`db_engine`)
here automatically, since conftest collection walks every directory from `rootdir` down to the
test file regardless of `__init__.py`; that mechanism doesn't cover plain `import` statements,
though, and `tests/` has no `__init__.py` (consistent with every existing suite here), so pytest's
default "prepend" import mode would otherwise insert only `tests/engine/` into `sys.path`. This
re-adds the parent `tests/` directory so `from bars import ...` resolves. The first new
subdirectory under `tests/` in this backend -- see REPORT-L2.md."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
