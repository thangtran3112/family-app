"""Recreate the tested family Vibe tree without editing the upstream submodule."""

import argparse
import io
import subprocess
import tarfile
import tempfile
from pathlib import Path

UPSTREAM = "d71b28c743f783c5116efa56c87d17dfd8397c1f"
TESTED_TREE = "ed02333b26b0a13144b6e3165449cc0f43440108"
HERE = Path(__file__).resolve().parent
SOURCE = HERE.parents[2] / "packages" / "vibe-trading"
PATCHES = (HERE / "family-baseline.patch", HERE / "family-sp5.patch")


def git(*args: str, cwd: Path = SOURCE, capture: bool = False) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        capture_output=capture,
        text=True,
    )
    return result.stdout.strip() if capture else ""


def materialize(output: Path) -> None:
    if output.exists():
        raise SystemExit(f"refusing to overwrite {output}")
    if git("rev-parse", "HEAD", capture=True) != UPSTREAM:
        raise SystemExit("Vibe submodule is not at the verified upstream pin")
    archive = subprocess.run(
        ["git", "archive", "HEAD"],
        cwd=SOURCE,
        check=True,
        capture_output=True,
    ).stdout
    output.mkdir()
    with tarfile.open(fileobj=io.BytesIO(archive)) as contents:
        contents.extractall(output, filter="data")
    for patch in PATCHES:
        git("apply", "--check", "--binary", str(patch), cwd=output)
        git("apply", "--binary", str(patch), cwd=output)
    git("init", "-q", cwd=output)
    git("add", "--force", "--all", cwd=output)
    actual = git("write-tree", cwd=output, capture=True)
    if actual != TESTED_TREE:
        raise SystemExit(f"Vibe overlay tree mismatch: {actual} != {TESTED_TREE}")
    print(f"Vibe overlay verified: {actual}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--verify", action="store_true")
    group.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.verify:
        with tempfile.TemporaryDirectory(prefix="vibe-overlay-") as directory:
            materialize(Path(directory) / "source")
    else:
        materialize(args.output.resolve())
