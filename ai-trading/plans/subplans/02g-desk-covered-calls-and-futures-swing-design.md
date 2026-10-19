# Desk: Covered Calls (Owner) and Futures Swing Trading (Both Users)

Status: approved in conversation on 2026-10-10 (the mocks and this design). This extends [02a](02a-desk-v1-strategies-design.md) and builds on two earlier pieces:
- [02](02-release-2-desk-design.md) §6.3: the covered-call math, already built in Phase 1b;
- [02f](02f-desk-indicators-and-ai-daily-design.md): the bias gauge and the Desk AI verdict.

For these features, this file wins where it conflicts with 02a. The phased plan is [02c](02c-desk-v1-implementation-plan.md).

## 1. What the Owner Asked For

- **Owner:** sell covered calls on his long portfolio.
- **Both users:** directional swing trades of 1–10 days on mini and micro futures, which they execute at Robinhood or IBKR.

Owner decisions (2026-10-10):
1. **Both users trade futures swings.** Each trades directionally, with their own lists, strategies, and paper results. 02a §2 had futures for the spouse only.
2. **The mocks are the UI reference:** the six artboards in section 2.

## 2. Screens

The mocks are in Paper: file "TobyTest", page "Family Desk · R2 mockups", bottom row. They are indexed in 02a §16.

| Artboard | Shows |
|---|---|
| D13 · Covered calls | Coverage for each holding against its cap, with the reason a holding can or cannot take a call; the selected holding's top three candidates with yield, delta, IV rank, flags, and score; the opportunity banner; a payoff sketch; the Desk AI context chip; "Paper sell" and "Alert me" |
| D14 · Short calls & income | Open short calls with their risks in words; the roll panel (cost to close, roll candidates with net credit and flags); the assignment note by account type; premium by month, assignments, and the Monday digest |
| M9 · Short-call risk alert (mobile) | The alert with tappable roll candidates and "Paper roll" |
| D15 · Futures swing | Pair chips with a mini/micro toggle and broker availability; a daily chart with weekly levels and the overnight range; 1D and 4h bias gauges; the sizer; open swing positions with roll warnings; the weekend card; the week's events |
| D16 · Futures specs & roll calendar | The specs of the 12 contracts, approximate margins with source and date, and broker availability; mini/micro equivalence; the roll and expiry timeline; session hours |
| M10 · Futures swing position (mobile) | A position with P/L in points and dollars, its R multiple, a price ladder, the weekend choice, and the roll countdown |

The 02f §2 rules apply:
- no order buttons: only paper actions and strategy or alert actions;
- a data label on every number;
- the PAPER badge on paper items;
- violet only for Desk AI.

## 3. Covered Calls

- **Rules:** the scan follows 02 §6.3 as built in Phase 1b (`core/covered_calls.py`): filters, metrics, flags, score, the top three, the opportunity rule, the short-call risk rules, and roll candidates. This file adds no rule to the score.
- **Coverage list:** for every holding, show shares, cap, open contracts, and coverable contracts. When a holding can take no call, show why, for example:
  - "120 shares: under one contract at a 50% cap";
  - "earnings Oct 20: waits";
  - "fully covered at its cap".
- **Desk AI context** (02f §5), informational only:
  - a chip when a candidate's strike sits below the AI base target;
  - when the AI rating is Sell, the note "Desk AI says Sell: consider selling shares instead".
- **Roll panel:** the cost to close (the ask), then candidates per 02 §6.3 with their net credit and flags (for example, earnings before the new expiry).
- **Assignment note,** by account type, marked "not tax advice":
  - in an IRA, assignment has no tax event;
  - in a taxable account, it can realize a gain on long-held shares.
- **Income:** premium collected by month, from paper and imported short calls; assignments; and the Monday digest (02 §6.3).
- **Brokers:**
  - Covered calls need options approval Level 2 at Robinhood or Level 1 at IBKR. Both allow them in IRAs.
  - The Desk only alerts and paper-trades. Real positions come back through the daily Flex or CSV import.
- **Data:** option chains and greeks come from IBKR.
  - The owner has two bundles: the $10 Snapshot and Futures Value Bundle and the $4.50 Equity and Options Add-On.
  - IBKR's documentation says the add-on includes OPRA Level 1, so the separate $1.50 OPRA line is not needed. Task 0.5 confirms that greeks arrive.

## 4. Futures Swing Trading

Contracts, all CME:

| Contracts | Robinhood | IBKR |
|---|---|---|
| ES/MES, NQ/MNQ, RTY/M2K, YM/MYM | ✓ | ✓ |
| CL/MCL, GC/MGC | unverified until checked in the app | ✓ |

A micro is one tenth of its mini.

**Contract specs** are config: dollars per point, tick size and dollars per tick, contract months, and session hours. The values come from CME, checked 2026-10-10; D16 holds the table.

**Roll and expiry dates** are computed from the exchange rules:
- equity index: quarterly (Mar, Jun, Sep, Dec); roll on the Monday before the third Friday (CME's rule); expiry on the third Friday at 09:30 ET;
- CL: monthly, with the last trade 3 business days before the 25th of the prior month (4 if the 25th is not a business day). MCL's last trade is one business day before CL's;
- GC and MGC: active months; roll before first notice day.

The roll map (Phase 2) uses these dates. A position whose contract expires within its swing horizon shows a roll warning.

**Margin**
- It is read from IBKR at sizing time (what-if) and shown with its time, never from a fixed table.
- Robinhood has no intraday margin rate: its displayed margin applies at all times.

**Sizer**
- From a dollar risk and the stop distance: contracts = floor(risk ÷ (points × dollars per point)).
- It prefers micros and shows the mini equivalent, for example "one ES would risk $2,500".
- It is built on Phase 1b's `core/sizing.py` with the futures multiplier.

**Swing levels:** the prior week's high, low, and close; weekly Classic pivots (02f §3); the overnight range; daily EMA20 and SMA50; and the 1D and 4h Desk Technical Bias.

**Weekend**
- CME closes Fri 17:00 ET and reopens Sun 18:00 ET. A gap can skip a stop.
- The weekend card shows the open positions, the weekend-gap statistic from Desk history, and "Hold" or "Flatten before 16:55 (paper)".
- A new optional paper limit, "flatten before the weekend", joins the existing flat-by limit (02a §4.4).

**Events:** the week's macro events (FRED release dates, Phase 2) beside the positions.

**Accounts:** futures at Robinhood need an individual, non-IRA account.

## 5. Alerts (Strategy-First)

- **Covered calls:** the covered-call income and short-call risk templates (02a §4.5) carry the alerts shown: an opportunity, near the strike, earnings or ex-dividend before expiry, delta above 0.50.
- **Futures:** a new "Futures position risk" template:
  - a contract's roll date within N trading days (default 3);
  - Friday at 16:30 ET with an open swing position;
  - margin use above N% of the book (default 50%).

  Swing entries use the existing templates (pullback to average, N-day breakout, futures overnight-range break), plus the bias (02f §6).

## 6. Phase Changes (02c)

| Phase | Change |
|---|---|
| 1c | Also the pure futures math: roll and expiry dates from the rules, weekly pivots, and the micro/mini sizer |
| 2 | The roll map uses 1c's dates; futures specs become config |
| 4 | The D15, D16, and M10 screens; D13, D14, and M9 on fixtures until Phase 5 |
| 5 | The coverage list, roll panel, income view, assignment note, and Desk AI context |
| 6 | Futures paper brackets with margin from IBKR, the "Futures position risk" template, and the flatten-before-weekend limit |

## 7. Testing

- **Roll and expiry dates:** every rule against CME's published calendar for 2026–2027, including holidays and a 25th that falls on a weekend.
- **Sizer:** the micro preference, rounding down, zero contracts with a reason, and the mini equivalent.
- **Coverage reasons:** each reason string at its boundary.
- **Weekend card and templates:** golden tests on fixed timestamps (Friday 16:30 and 16:55 ET, and holidays).

## 8. Not in v1

- Nano contracts
- Options on futures
- Calendar spreads
- Covered calls on ETFs with non-standard deliverables
- Real-broker orders (paper only)

## 9. Research (local only)

The research is in the gitignored `ai-trading/temp/`, and only on the machine that made it:
- `desk-research/futures-and-covered-call-facts.md`, with sources and dates;
- the round-2 Mobbin folders in `mobbin-refs/`.
