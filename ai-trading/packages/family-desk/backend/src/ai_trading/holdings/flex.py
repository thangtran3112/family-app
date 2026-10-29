"""The IBKR Flex Web Service client and statement parser (02n §d `holdings/flex.py`, 02d §7).

Read-only, like `tools/ibkr-probe/flex_probe.py`: `SendRequest` with the token and the query id returns a reference
code, then `GetStatement` is polled until the statement exists (Flex allows one request a second and ten a minute, so
the poll waits between tries). The token and the query id are only ever sent to Interactive Brokers: no log line, error
message or return value carries them, and a broker account id is masked to its letter prefix wherever it is printed.

The statement is untrusted input: the XML is read only after a DOCTYPE or ENTITY declaration is refused, so no entity
can expand and no external resource can be fetched. Only `OpenPositions` LOT rows of stocks and options, and the option
rows of `Trades`, are read; every other section and asset class is counted and skipped. Values live in the returned
records and nowhere else.
"""

import re
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, datetime
from typing import Literal

BASE_URL = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService"
USER_AGENT = "family-desk-flex/1.0"
IN_PROGRESS = "1019"  # statement generation in progress; retry
MAX_ATTEMPTS = 10
FIRST_WAIT_S = 3.0
POLL_WAIT_S = 5.0
TIMEOUT_S = 60

AssetClass = Literal["STK", "OPT"]
TradeKind = Literal["sell_to_open", "buy_to_close", "buy_to_open", "sell_to_close", "assignment", "expiration"]


class FlexError(Exception):
    """A statement could not be fetched or read. The message is safe to log: a Flex error code and a fixed reason."""


@dataclass(frozen=True)
class FlexLot:
    """One LOT row of `OpenPositions`. `quantity` is shares for a stock and signed contracts for an option."""

    asset_class: AssetClass
    symbol: str  # the underlying
    quantity: float
    cost_per_share: float | None
    acquired: date  # the lot's open date
    option_right: Literal["C", "P"] | None
    strike: float | None
    expiry: date | None
    multiplier: int


@dataclass(frozen=True)
class FlexTrade:
    external_ref: str
    symbol: str  # the underlying
    option_right: Literal["C", "P"]
    strike: float
    expiry: date
    kind: TradeKind
    trade_date: date
    quantity: float  # contracts, signed like the broker's
    price: float  # premium per share
    multiplier: int
    commission: float | None


@dataclass(frozen=True)
class FlexStatement:
    account_id: str  # the broker's account number: matches an import to its account, never returned or logged raw
    statement_date: date
    lots: tuple[FlexLot, ...]
    trades: tuple[FlexTrade, ...]
    skipped: int  # rows of a kind this lane does not read (other asset classes, summary rows, non-option trades)


def mask_account(account: str) -> str:
    """Keep the letter prefix that tells paper ("DU") from live ("U"); hide the digits."""
    prefix = re.match(r"[A-Z]*", account).group(0)  # type: ignore[union-attr]  # `*` always matches
    return prefix + "*" * (len(account) - len(prefix))


def _get(url: str, params: dict[str, str]) -> str:
    request = urllib.request.Request(f"{url}?{urllib.parse.urlencode(params)}", headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
        return response.read().decode("utf-8")


def _response(xml_text: str) -> dict[str, str | None]:
    root = _read(xml_text)
    return {
        "status": root.findtext("Status"),
        "reference": root.findtext("ReferenceCode"),
        "url": root.findtext("Url"),
        "error_code": root.findtext("ErrorCode"),
    }


def _statement_url(url: str | None) -> str:
    """The `GetStatement` URL IBKR returned when it is an https address on an interactivebrokers.com host; any other
    host never receives the token, whatever the response says."""
    host = urllib.parse.urlsplit(url or "")
    if host.scheme == "https" and (host.hostname or "").endswith(".interactivebrokers.com"):
        return url  # type: ignore[return-value]
    return f"{BASE_URL}/GetStatement"


def fetch_statement(
    token: str,
    query_id: str,
    *,
    get: Callable[[str, dict[str, str]], str] = _get,
    sleep: Callable[[float], None] = time.sleep,
) -> str:
    """The statement XML of one Flex query. Raises `FlexError` with a code and a fixed reason, never the token."""
    try:
        sent = _response(get(f"{BASE_URL}/SendRequest", {"t": token, "q": query_id, "v": "3"}))
    except FlexError:
        raise
    except Exception as error:  # the transport's message can carry the request URL, which holds the token
        raise FlexError(f"SendRequest failed: {type(error).__name__}") from None
    if sent["status"] != "Success" or not sent["reference"]:
        raise FlexError(f"SendRequest refused: code {sent['error_code'] or 'unknown'}")
    url = _statement_url(sent["url"])
    for attempt in range(MAX_ATTEMPTS):
        sleep(FIRST_WAIT_S if attempt == 0 else POLL_WAIT_S)
        try:
            body = get(url, {"t": token, "q": sent["reference"], "v": "3"})
        except Exception as error:
            raise FlexError(f"GetStatement failed: {type(error).__name__}") from None
        if "<FlexQueryResponse" in body:
            return body
        status = _response(body)
        if status["error_code"] != IN_PROGRESS:
            raise FlexError(f"GetStatement refused: code {status['error_code'] or 'unknown'}")
    raise FlexError(f"statement still generating after {MAX_ATTEMPTS} tries")


def _read(xml_text: str) -> ET.Element:
    """Parse untrusted XML. A DOCTYPE or ENTITY declaration is refused before parsing, so no entity expands (the
    billion-laughs attack) and nothing external is fetched (XXE); an ordinary Flex statement has neither."""
    if "<!DOCTYPE" in xml_text or "<!ENTITY" in xml_text:
        raise FlexError("statement refused: it declares a DTD or entity")
    try:
        return ET.fromstring(xml_text)
    except ET.ParseError:
        raise FlexError("statement is not well-formed XML") from None


def _date(value: str | None) -> date | None:
    """A Flex date or datetime: `yyyyMMdd`, `yyyyMMdd;HHmmss`, or an ISO date, whichever format the query chose."""
    if not value:
        return None
    head = re.split(r"[;, T]", value.strip(), maxsplit=1)[0]
    for pattern in ("%Y%m%d", "%Y-%m-%d", "%m/%d/%Y"):
        try:
            return datetime.strptime(head, pattern).date()
        except ValueError:
            continue
    return None


def _number(value: str | None) -> float | None:
    try:
        return float(value) if value not in (None, "") else None
    except ValueError:
        return None


def _lot(row: ET.Element) -> FlexLot | None:
    symbol = row.get("underlyingSymbol") or row.get("symbol") or ""
    quantity = _number(row.get("position"))
    category = row.get("assetCategory")
    if not symbol or not quantity or category not in ("STK", "OPT"):
        return None
    if _date(row.get("openDateTime")) is None:  # a tax lot always has its open date; one without cannot be dated
        return None
    multiplier = int(_number(row.get("multiplier")) or 1)
    common = {
        "symbol": symbol.strip().upper(),
        "quantity": quantity,
        "cost_per_share": _number(row.get("costBasisPrice")),
        "acquired": _date(row.get("openDateTime")),
        "multiplier": multiplier,
    }
    if category == "STK":
        return FlexLot("STK", **common, option_right=None, strike=None, expiry=None)
    right, strike, expiry = row.get("putCall"), _number(row.get("strike")), _date(row.get("expiry"))
    if right not in ("C", "P") or not strike or strike <= 0 or expiry is None:
        return None
    return FlexLot("OPT", **common, option_right=right, strike=strike, expiry=expiry)  # type: ignore[arg-type]


def _trade_kind(row: ET.Element) -> TradeKind | None:
    notes = set((row.get("notes") or "").split(";"))
    if "A" in notes:
        return "assignment"
    if "Ep" in notes:
        return "expiration"
    return {
        ("SELL", "O"): "sell_to_open",
        ("BUY", "C"): "buy_to_close",
        ("BUY", "O"): "buy_to_open",
        ("SELL", "C"): "sell_to_close",
    }.get((row.get("buySell") or "", row.get("openCloseIndicator") or ""))


def _trade(row: ET.Element) -> FlexTrade | None:
    if row.get("assetCategory") != "OPT" or row.get("levelOfDetail", "EXECUTION") != "EXECUTION":
        return None
    ref, kind = row.get("tradeID"), _trade_kind(row)
    right, strike = row.get("putCall"), _number(row.get("strike"))
    expiry, traded = _date(row.get("expiry")), _date(row.get("tradeDate"))
    quantity, price = _number(row.get("quantity")), _number(row.get("tradePrice"))
    symbol = (row.get("underlyingSymbol") or "").strip().upper()
    if not (ref and kind and symbol and right in ("C", "P") and strike and strike > 0 and expiry and traded):
        return None
    if not quantity or price is None:
        return None
    return FlexTrade(
        external_ref=ref,
        symbol=symbol,
        option_right=right,  # type: ignore[arg-type]
        strike=strike,
        expiry=expiry,
        kind=kind,
        trade_date=traded,
        quantity=quantity,
        price=price,
        multiplier=int(_number(row.get("multiplier")) or 100),
        commission=_number(row.get("ibCommission")),
    )


def parse_statements(xml_text: str) -> list[FlexStatement]:
    """One `FlexStatement` per account in the response. Raises `FlexError` for a refused or malformed document and for a
    statement with no account or no date, which cannot be matched to anything."""
    root = _read(xml_text)
    if root.tag != "FlexQueryResponse":
        raise FlexError("response is not a Flex statement")
    statements = []
    for node in root.iter("FlexStatement"):
        account, statement_date = node.get("accountId"), _date(node.get("toDate"))
        if not account or statement_date is None:
            raise FlexError("a statement has no account or no date")
        lots: list[FlexLot] = []
        trades: list[FlexTrade] = []
        skipped = 0
        for section in node:
            for row in section:
                if section.tag == "OpenPositions" and row.get("levelOfDetail") == "LOT":
                    lot = _lot(row)
                    if lot:
                        lots.append(lot)
                        continue
                elif section.tag == "Trades":
                    trade = _trade(row)
                    if trade:
                        trades.append(trade)
                        continue
                skipped += 1
        statements.append(FlexStatement(account, statement_date, tuple(lots), tuple(trades), skipped))
    return statements
