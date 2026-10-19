"""Print the FastAPI schema as deterministic JSON for the Desk frontend."""

import json

from ai_trading.api.app import app


def main() -> None:
    print(json.dumps(app.openapi(), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
