# Vibe Answer Integrity and Tool Reliability: Design

**Date:** 2026-10-10 · **Lane:** open-source (Trading Hub) · **Status:** draft for owner review

Related: [01n](01n-vibe-research-quality.md) (overview and evidence; read its section 3.1 first), [01p](01p-vibe-effort-picker.md) (ships in the same batch), `packages/vibe-trading/DIVERGENCE.md`. Code paths are under `packages/vibe-trading/agent/src/` at fork commit `d402c2df`.

## 1. Goal

- A completed analysis reaches the user with its figures visible. The checker flags what it could not verify instead of cutting the figure or replacing the answer.
- The checker keeps stopping what it exists to stop: an invented entry or target level, a figure attached to an instrument the session never handled, a figure that was misattributed, and an answer whose instrument identity is unresolved.
- Success, measured on the same six prompts that reach the gate (01n section 3.1), current pin, gate on, `xhigh`:
  - **Stubs: 0 of 6** (baseline 1: S08).
  - **Figures cut: 0 unless invented or misattributed** (baseline 24 cut over five runs).
  - Every figure the final check could not verify carries `(unverified※)`, there is one footnote, and the count equals `released.figures_flagged` in `grounding_evidence.json`.
  - Drafts rejected per run do not rise (baseline mean 2.67) and fall where the deterministic repairs apply.
  - `web_search` calls on the earnings, consensus and news prompts fall below their pinned baseline, and `get_stock_profile` is used.
- Non-goals: disabling the gate, changing identity locking or the recovery rounds, new data providers (sub-project 4).

## 2. Owner Decisions

- 2026-10-10: annotate unverified figures instead of deleting them; keep the gate.
- Every fork change carries its row in `packages/vibe-trading/DIVERGENCE.md` in the same commit (section 8 lists them).

## 3. Current Behaviour

The model ends its answer with a `figures` block of `value | role | note | ref` lines (`agent/context.py`, roles `observed`, `derived`, `proposed`, `cited`, `count`). `GroundingLedger.validate_final_answer` checks every measured figure in the prose against that declaration and against the session's tool evidence. A rejected draft goes back to the model with its failing figures; after `MAX_GROUNDING_REVISIONS` (2) rejected drafts, `agent/loop.py` (about lines 1113 to 1167) calls `redacted_release`, which cuts each failing figure to `(omitted※)`, re-validates the result and releases it. When any flagged figure cannot be located, any issue code is outside the redactable set, or the cut text still fails, `redacted_release` returns `None` and the loop releases `safe_fallback()`, a canned stub. Evidence for money figures is limited to price-kind fields (`evidence._is_price_kind`): open, high, low, close, price, a short list of amount fields and registered indicators. Analyst targets, revenue, EPS, strikes and bids are not price-kind, by an explicit upstream comment ("the check accepts no more").

## 4. Approaches

1. **Turn the gate off.** Rejected. Gate-off answers scored 4.15 against 2.91, but they may carry invented levels and wrong-instrument figures, and the judge saw tool names only.
2. **Repair the matchers only.** Rejected alone. The 209 issues in section 3.1 of 01n fall into thirteen families; several (numbers read from the web, operands taken from artifact files) cannot be made verifiable by a rule, and every family still destroys an answer when it fires.
3. **Flag at release, and repair the deterministic families (chosen).** One change in one place removes the destruction for every present and future family; the repairs then cut the noise and the wasted drafts. Cost: a few small hunks in upstream files, listed in section 8.

## 5. Design

### 5.1 Release: flag the unverifiable, cut the invented, stub the misidentified

When the revision budget is spent, the loop calls a new `flagged_release(content, validation)` in `agent/grounding/release.py` instead of `redacted_release`; `safe_fallback` stays the last resort. `redacted_release` stays in the file, unused, so upstream merges stay clean.

- **Guards, unchanged from `redacted_release`:** return `None` for a market answer that observed no price (unless an analysis completed) and for any issue code outside `_REDACTABLE_CODES | _REPAIRABLE_PROVENANCE_CODES | {figures_block_malformed}`. `None` leads to the stub.
- **Classification by role and reason.** A figure is **flagged** when its issue role is not `proposed` and its reason is in an explicit allow-list `_FLAGGABLE_REASONS`: `no_evidence`, `value_mismatch`, `undeclared`, `not_in_referenced_call`, `field_ref_needs_call_id`, `unknown_call_id`, `ambiguous_field_ref`, `tail_risk_needs_field_ref`, `formula_not_evaluable`, `formula_not_anchored`, `additive_operand_not_observed`, `derivation_result_mismatch`, `no_formula`, `citation_without_source`, `citation_not_visible`, `cited_as_observed`. These mean the checker could not verify the figure. Section 3.1 of 01n shows that `value_mismatch` is overwhelmingly a category error, so it belongs here.
- **Everything else is cut**, exactly as today: every `proposed` level, `outside_observed_range`, `symbol_mismatch`, `no_symbol`, `unsourced_symbol_figures`, and any reason a future upstream sync adds. An unknown reason fails closed. A cut that cannot be located returns `None`.
- **One pass.** Cuts (replace the figure and its glued marks with `(omitted※)`) and flags (keep the figure, append ` (unverified※)`; Chinese lines `（未核验※）`) are applied in a single pass over the located figures, so offsets stay valid. Then the figures block is removed. Model-written `(unverified※)` and `※` lines are stripped first, as `_strip_release_markers` already does for `(omitted※)`, so the model cannot forge or echo a mark.
- **Block-level issues** (`figures_block_malformed`) have no span; they are counted in the footnote only. When the only provenance defect is a missing source or currency word, the existing data note is appended (as `repair_provenance` does).
- **Footnote.** `※ N figure(s) could not be matched to this session's tool data and are marked (unverified※). Read them as the model's own statements, not as tool results.` When any flagged figure's reason is `value_mismatch`, the footnote also states the observed OHLC range (`_observed_range_summary`, which the omitted-figures note already uses), so a reader can tell a category error (a target set beside a price) from a real conflict. The existing omitted-figures note is added when something was cut. Chinese equivalents.
- **Record.** `_released` gains `mode: "flagged"`, `figures_flagged`, `figures_removed` and `revalidated: false`, persisted in `grounding_evidence.json`. The loop emits `grounding_status` with stage `released_flagged` (the UI treats any stage but `revising` as "done", so no frontend change), writes the trace event `answer_released_flagged`, and sets `_released_fallback` with a reason naming the count, so the run stays `degraded: true` as the redacted path does today.
- **Post-condition.** Every located flagged figure is followed by its mark and nothing else in the draft changed except marks, cuts, the removed block and the notes; otherwise return `None`. The flagged text is not re-validated, because its flagged figures would fail by definition.

The Recommendation target in sub-project 4 will be recorded by a tool and so be `observed` evidence, never a `proposed` level; this rule does not weaken that design.

### 5.2 Deterministic repairs of the checker

Each repair is small, has a failing fixture first, and is counted against the 209 issues of 01n section 3.1.

| # | Where | Problem (issues) | Rule | Why it is safe |
|---|---|---|---|---|
| R2 | `figures.py::_parse_value` | `−$2,582.00`, `+$35.90`: a sign before the currency mark makes the declaration unparseable and the whole block unreadable (9) | A leading `+`, `-`, `−` or `–` before the currency mark is the value's sign | Affects declaration parsing only |
| R3 | `policies.py::_check_derived` | The note already multiplies by 100 and `_result_matches` multiplies again: "evaluates to 3104.29%" (16) | For a percent figure whose formula has a literal `100` operand, also compare the result in percentage points; with no `100` operand, unchanged | Widens acceptance only where the author wrote the ×100 |
| R4 | `policies.py::_check_observed` | `tool::field` where the tool was called once is rejected as "a tool name is not a call id" (18) | When `_tool_field_ref_candidates` returns exactly one `call_id::field`, resolve to it; two or more keep today's issue | The ref still names one real field of one real call |
| R5 | `policies.py::_referenced`, `_derivation` | A ref that names an exact field is filtered to price-kind records, so `targetMeanPrice`, `totalRevenue`, `strike`, `bid` never match (21, and part of the 27 unanchored operands) | A ref naming an exact field (`call_id::path`, or a path that resolves to evidence) is compared with that field's value whatever its kind; the money/ratio filter applies only to pooled refs (tool or call level) and to undeclared figures | The value must still equal the field's value to the written precision; a wrong field still fails |

What these repairs deliberately do not do: they do not accept a pooled `get_stock_profile` ref for a target price (a coincidence risk the upstream filter exists for), and they do not turn artifact files into evidence. Both are measured by the golden set before anyone reconsiders them.

### 5.3 Guidance in the system prompt (R6)

Two additions to the figures instructions and the working rules in `agent/context.py`:

- A number read in a `web_search` or `read_url` result is `cited` (source named in the same sentence as the figure), never `observed`. All 33 `no_evidence` issues are `observed` figures with a `web_search` ref.
- For US equities, call `get_stock_profile`, `get_financial_statements`, `get_sec_filings` and `get_stock_news` before `web_search`, and use `web_search` only for what they lack.

Prompt changes alter model behaviour, so the live before/after (section 7) is the acceptance test, not the wording.

### 5.4 Tool data and reliability (R7, R8)

- **R7 `tools/stock_profile_tool.py`.** `_earnings_trend` keeps `revenue_low`, `revenue_high`, `revenue_analysts`, `revenue_growth` (Yahoo's `revenueEstimate` carries `avg`, `low`, `high`, `numberOfAnalysts`, `growth`, `yearAgoRevenue`; the tool kept only `avg`) and the other revision counts Yahoo's `epsRevisions` carries: `eps_revisions_up_7d`, `eps_revisions_down_7d` and `eps_revisions_down_90d`. Yahoo has no upward 90-day count (the payload holds `upLast7days`, `upLast30days`, `downLast7Days`, `downLast30days`, `downLast90days`), so the tool returns what exists and the answer must not infer the rest. A new section `earnings_history` reads Yahoo's `earningsHistory` module (verified for NVDA: four quarters of `quarter`, `epsActual`, `epsEstimate`, `epsDifference`, `surprisePercent`) as `quarter`, `eps_actual`, `eps_estimate`, `eps_difference`, `surprise_percent`. It joins `_SECTION_MODULES` and the default sections.
- **R8 `tools/web_reader_tool.py`.** When `JINA_API_KEY` is set, send it as a bearer token to the reader; never log or echo it. A 401 or 403 from the reader returns an error that says it refused anonymous access and, when no key is set, that `JINA_API_KEY` lifts it, so the model stops retrying the same page. Without the key behaviour is unchanged. The owner's free key goes in `ai-trading/vibe-trading`; the code is inert until then.

## 6. What Does Not Change

- Identity locking, `recovery_action` (symbol resolution and price-evidence rounds), the two-draft revision budget and the correction prompts.
- A market answer that observed no price still gets the stub; an unresolved identity still gets the stub.
- A `proposed` level, a figure for a symbol the session never handled, and a misattributed figure are still cut.
- `redacted_release`, `safe_fallback` and the validators' reason codes are untouched except for R2 to R5.

## 7. Testing and Verification

- **Unit tests** (fork `agent/tests/`). New `test_grounding_flagged_release.py`: unverifiable-only draft is flagged and complete; mixed flag and cut in one pass; a `proposed` level and an unknown reason are cut; identity code returns `None`; no observed price returns `None`; an unlocatable cut returns `None`; Chinese marker; a model-written mark is stripped and not echoed; a table cell keeps its pipes; running twice does not double-mark; the post-condition holds. Added cases for R2 (`test_grounding_figures_contract.py`), R3 to R5 (new `test_grounding_repairs.py`), R7 and R8 (the two tool test modules), and the prompt additions.
- **Recorded-run fixtures** from the six current-pin runs (evidence records, figures blocks and drafts; they hold no secrets) under `agent/tests/fixtures/grounding/`: S02 (target prices with field refs), S06 (`× 100` notes), S08 (signed currency, option-chain refs).
- **Existing suites pass unchanged:** `test_grounding_release.py`, `test_grounding_shape_hardening.py`, `test_grounding_backtest_outputs.py`, `test_grounding_figures_contract.py`, then the whole backend suite (`python -m pytest agent/tests -q -n 8`) and the frontend checks.
- **Figure-fidelity guard.** For each released answer, strip the marks and footnote and re-run the validator: it reports no issue outside the flagged spans.
- **Live before and after** on the six prompts plus the earnings, consensus and news prompts, current pin, gate on, `xhigh`, recorded as a table in the pull request: stubs, cuts, flags, drafts rejected, wall time, `web_search` and `get_stock_profile` calls. The baseline is re-recorded from the pinned code in Task 0 of the plan, because the sync changed tool behaviour.
- **Real browser:** a flagged answer renders its marks and one footnote, and no stale "revising" status stays.

## 8. DIVERGENCE.md Entries

Rows to add to the changes tables of `packages/vibe-trading/DIVERGENCE.md`, each in the same commit as its change, plus the preserved behaviours below:

| Path | Change | Why |
|---|---|---|
| `agent/src/agent/grounding/release.py` | New `flagged_release()` with `_FLAGGABLE_REASONS`, the `(unverified※)` marks, one-pass cut-and-flag, and the flagged footnote. `_strip_release_markers` strips the new marks. `redacted_release` untouched and unused. | Owner request: a completed analysis is never cut or replaced for figures the checker could not verify. |
| `agent/src/agent/loop.py` | The out-of-revisions branch calls `flagged_release`; adds the `answer_released_flagged` trace event and the `released_flagged` grounding status. | Same. |
| `agent/src/agent/grounding/ledger.py` | `figures_flagged` property beside `figures_removed`. | Reporting. |
| `agent/src/agent/grounding/figures.py` | `_parse_value` accepts a sign before the currency mark. | `−$2,582.00` made the whole figures block unreadable. |
| `agent/src/agent/grounding/policies.py` | Percent figures with a literal `100` operand compare in points too; `tool::field` with one candidate call resolves to it; an exact field ref ignores the money/ratio kind filter (observed and derived anchors). | False rejections measured on real runs. |
| `agent/src/agent/context.py` | Web-read numbers are `cited`; structured US-equity tools before `web_search`. | 33 of 33 `no_evidence` issues; 73 of 368 tool calls were searches. |
| `agent/src/tools/stock_profile_tool.py` | Revenue low/high/analysts/growth, 7-day up/down and 90-day down revision counts, `earnings_history` section. | The consensus answer had to say "not retrieved". |
| `agent/src/tools/web_reader_tool.py` | Optional `JINA_API_KEY` bearer token; clearer 401 and 403 error. | Anonymous reader blocks. |
| `agent/tests/` | New `test_grounding_flagged_release.py` and `test_grounding_repairs.py`; extended `test_grounding_figures_contract.py`, `test_stock_profile_tool.py`, `test_web_reader_security.py`; new `fixtures/grounding/`. | |

Behaviours to preserve through a sync (new items 4 and 5):

4. A completed analysis is never replaced by the canned stub for figure-level issues: figures the checker could not verify are released with `(unverified※)` and one footnote; invented levels and misattributed figures are cut; identity failures still get the stub.
5. A figure whose declaration names an exact evidence field is checked against that field's value, whatever its kind.

"Reapplying after a sync" gains `release.py`, `policies.py`, `loop.py`, `figures.py` and `context.py` to the expected-conflict list.

## 9. Rollout and Owner Actions

- Ships in Batch 1 with 01p. The deploy also applies `LANGCHAIN_USE_RESPONSES_API=true` (already in Firestore). It restarts the containers and kills in-flight runs, so check for active runs first.
- Optional owner action: register a free Jina reader key and store it as `JINA_API_KEY` in `ai-trading/vibe-trading` (the assistant cannot register accounts).
- Rollback: revert the fork commit and move the gitlink back; no data migration, and `grounding_evidence.json` readers ignore the new fields.

## 10. Risks

- **A flagged figure is wrong.** It is visibly marked and footnoted; the stub and cut paths remain for invention; the figure-fidelity guard and, later, the golden set measure it. Upstream chose to fail closed; the owner chose to inform.
- **Upstream conflicts.** The hunks are small and mostly additive methods; the sync skill reads the new DIVERGENCE rows. The sync already fixed some old-pin defects, so every sync re-runs the live before and after.
- **Allow-list drift.** A new upstream reason defaults to cut, which is the safe direction.

## 11. Out of Scope

- Making artifact files and calculator outputs evidence (the S06 operand families), and a kind-agnostic match for pooled refs: only if the golden set shows false flags that matter.
- A direct-fetch reader fallback (needs an SSRF guard), changing the revision budget, and styling the marks in the UI.
