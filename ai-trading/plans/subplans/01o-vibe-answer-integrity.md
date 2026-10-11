# Vibe Answer Integrity and Tool Reliability: Design

**Date:** 2026-10-10 · **Lane:** open-source (Trading Hub) · **Status:** approved by the owner; implementation plan written ([01o-vibe-answer-integrity-plan.md](01o-vibe-answer-integrity-plan.md)). This text was revised while planning: the plan validated each change on the pinned code, and section 5 records what that changed against the first approved draft (R4 dropped, R5 narrowed, three rules added).

Related: [01n](01n-vibe-research-quality.md) (overview and evidence; read its section 3.1 first), [01p](01p-vibe-effort-picker.md) (ships in the same batch), [results](01o-vibe-answer-integrity-results.md), `packages/vibe-trading/DIVERGENCE.md`. Code paths are under `packages/vibe-trading/agent/src/` at fork commit `d402c2df`.

## 1. Goal

- A completed analysis reaches the user with its figures visible. The checker flags what it could not verify instead of cutting the figure or replacing the answer.
- The checker keeps stopping what it exists to stop: an invented entry or target level, a figure attached to an instrument the session never handled, a misattributed figure, a draft that declared nothing, and an answer whose instrument identity is unresolved.
- Success, measured on the prompts that reach the gate (01n section 3.1), pinned code, gate on, `xhigh`, compared with the recorded baseline of ten runs (none clean: 8 lost 1 to 9 figures, both covered-call runs became a stub):
  - **Stubs: 0.**
  - **Figures cut: 0, unless the reason is one of the cut class** (section 5.1).
  - Every figure the final check could not verify carries `(unverified※)`, there is one footnote, and the count equals `released.figures_flagged` in `grounding_evidence.json`.
  - Drafts rejected per run do not rise (baseline mean 2.8) and fall where the repairs apply.
  - `get_stock_profile` is called on the consensus, earnings and news prompts (the baseline never called it on the earnings prompt). `web_search` counts are reported, not targeted: the structured-first sentence did not change them consistently.
- Non-goals: disabling the gate, changing identity locking or the recovery rounds, new data providers (sub-project 4).

## 2. Owner Decisions

- 2026-10-10: annotate unverified figures instead of deleting them; keep the gate.
- Every fork change carries its row in `packages/vibe-trading/DIVERGENCE.md` in the same commit (section 8 lists them).

## 3. Current Behaviour

The model ends its answer with a `figures` block of `value | role | note | ref` lines (`agent/context.py`, roles `observed`, `derived`, `proposed`, `cited`, `count`). `GroundingLedger.validate_final_answer` checks every measured figure in the prose against that declaration and against the session's tool evidence. A rejected draft goes back to the model with its failing figures; after `MAX_GROUNDING_REVISIONS` (2) rejected drafts, `agent/loop.py` (about lines 1113 to 1167) calls `redacted_release`, which cuts each failing figure to `(omitted※)`, re-validates the result and releases it. When any flagged figure cannot be located, any issue code is outside the redactable set, or the cut text still fails, `redacted_release` returns `None` and the loop releases `safe_fallback()`, a canned stub. Evidence for money figures is limited to price-kind fields (`evidence._is_price_kind`): open, high, low, close, price, a short list of amount fields and registered indicators. Analyst targets, revenue, EPS, strikes and bids are not price-kind, by an explicit upstream comment ("the check accepts no more"). Upstream also pins, in tests, that a tool name is not a call id and that a ratio field never grounds a `$` figure.

## 4. Approaches

1. **Turn the gate off.** Rejected. Gate-off answers scored 4.15 against 2.91, but they may carry invented levels and wrong-instrument figures, and the judge saw tool names only.
2. **Repair the matchers only.** Rejected alone. The 209 issues in section 3.1 of 01n fall into thirteen families; several (numbers read from the web, operands taken from artifact files) cannot be made verifiable by a rule, and every family still destroys an answer when it fires.
3. **Flag at release, and repair the deterministic families (chosen).** One change in one place removes the destruction for every present and future family; the repairs then cut the noise and the wasted drafts. Cost: a few small hunks in upstream files, listed in section 8.

## 5. Design

### 5.1 Release: flag the unverifiable, cut the invented, stub the misidentified

When the revision budget is spent, the loop calls a new `flagged_release(content, validation)` in `agent/grounding/release.py` instead of `redacted_release`; `safe_fallback` stays the last resort. `redacted_release` stays in the file, unused, so upstream merges stay clean.

- **Guards, unchanged from `redacted_release`:** return `None` for a market answer that observed no price (unless an analysis completed) and for any issue code outside `_REDACTABLE_CODES | _REPAIRABLE_PROVENANCE_CODES | {figures_block_malformed}`. `None` leads to the stub.
- **Flagged** when the draft has a `figures` block, the issue's role is not `proposed`, and its reason is in an explicit allow-list `_FLAGGABLE_REASONS`: `no_evidence`, `no_symbol`, `value_mismatch`, `undeclared`, `not_in_referenced_call`, `field_ref_needs_call_id`, `unknown_call_id`, `ambiguous_field_ref`, `tail_risk_needs_field_ref`, `formula_not_evaluable`, `formula_not_anchored`, `additive_operand_not_observed`, `derivation_result_mismatch`, `no_formula`, `citation_without_source`, `citation_not_visible`, `cited_as_observed`. These mean the checker could not verify a figure the model declared, which is then the model's own statement. Section 3.1 of 01n shows that `value_mismatch` is overwhelmingly a category error (a target set beside a price), and `no_symbol` is a portfolio-wide figure the session cannot attribute to one instrument, so both belong here.
- **Cut** (the cut class), exactly as today: every `proposed` level; every failing figure of a draft with **no figures block**, where the gate validates figures as `observed` and nothing separates an invented price from a category error; `outside_observed_range`; `symbol_mismatch`; `unsourced_symbol_figures`; and any reason a future upstream sync adds. An unknown reason fails closed. A cut that cannot be located returns `None`. A bare four-digit year is never marked or cut: it is a date part.
- **One pass.** Cuts (replace the figure and its glued marks with `(omitted※)`) and flags (keep the figure, append ` (unverified※)`; Chinese lines `（未核验※）`) are applied in a single pass over the located figures, so offsets stay valid. Then the figures block is removed. Model-written `(unverified※)` and `※` lines are stripped first, as `_strip_release_markers` already does for `(omitted※)`, so the model cannot forge or echo a mark.
- **Block-level issues** (`figures_block_malformed`) have no span and carry no figure; the block is removed with the rest. When the only provenance defect is a missing source or currency word, the existing data note is appended (as `repair_provenance` does).
- **Footnote.** `※ N figure(s) could not be matched to this session's tool data and are marked (unverified※). The checker could not confirm them, so treat them as unchecked.` The wording is deliberate: some flagged figures are results of calculator tools the checker does not read, so "not tool results" would mislead. When any flagged reason is `value_mismatch`, the footnote also states the observed OHLC range (`_observed_range_summary`, which the omitted-figures note already uses), so a reader can tell a category error from a real conflict. The existing omitted-figures note is added when something was cut. Chinese equivalents.
- **Record.** `_released` gains `mode: "flagged"`, `figures_flagged`, `figures_removed` and `revalidated: false`, persisted in `grounding_evidence.json`. The loop emits `grounding_status` with stage `released_flagged` (the UI treats any stage but `revising` as "done", so no frontend change), writes the trace event `answer_released_flagged`, and sets `_released_fallback` with a reason naming the count, so the run stays `degraded: true`. When nothing was flagged the legacy event and stage names and reason text are kept, so upstream's loop tests stay valid.
- **Post-condition.** Nothing in the draft changes except marks, cuts, the removed block and the notes (a test removes the marks and the note and gets the draft back). The flagged text is not re-validated, because its flagged figures would fail by definition.

The Recommendation target in sub-project 4 will be recorded by a tool and so be `observed` evidence, never a `proposed` level; this rule does not weaken that design.

### 5.2 Deterministic repairs of the checker

Each repair is small, has a failing test first, and is counted against the 209 issues of 01n section 3.1.

| # | Where | Problem (issues) | Rule | Why it is safe |
|---|---|---|---|---|
| R2 | `figures.py::_parse_value` | `−$2,582.00`, `+$35.90`: a sign before the currency mark makes the declaration unparseable and the whole block unreadable (9) | A leading `+`, `-`, `−` or `–` before the currency mark is the value's sign | Affects declaration parsing only |
| R3 | `policies.py::_check_derived` | The note already multiplies by 100 and `_result_matches` multiplies again: "evaluates to 3104.29%" (16) | For a percent figure whose formula has a literal `100` operand, also compare the result in percentage points; with no `100` operand, unchanged | Widens acceptance only where the author wrote the ×100 |
| R5 | `evidence.py`, `policies.py::_referenced`, `_derivation` | A ref that names an exact field is filtered to price-kind records, so `targetMeanPrice`, `totalRevenue`, `strike`, `bid` never match (21, and part of the 27 unanchored operands) | A currency-marked figure whose ref names one exact field (`call_id::path`, or a path that resolves to evidence) may quote a leaf of the explicit allow-list `_EXACT_REF_MONEY_LEAVES` (analyst targets, revenue, cash, debt, EPS, strikes, bids). The operands of a money-derived figure may also be any observed leaf of that list for its symbol. The percent filter is unchanged | The value must still equal the field's to the written precision; a wrong field or value still fails; a pooled tool or call ref, a ratio, a return and a count never ground a money figure (upstream's own tests pin the last two) |

**Dropped: R4** (resolve `tool::field` to the call when the tool ran once). Upstream pins the opposite in `tests/test_grounding_unknown_call_id_refs.py` ("a known tool keeps its existing correction reason") and in `_tool_field_ref_candidates` ("the hint never selects a call"). The cost is one extra draft; it does not justify forking a deliberate contract.

**Narrowed: R5.** The first draft relaxed the money filter for any exact field "whatever its kind". Upstream's tests require that `$12.5` never grounds on a `total_return` ratio even with an exact ref, so the relaxation is an allow-list. Its derived-operand half came from a real run: a covered-call answer subtracted an observed option bid, which the checker did not count as observed.

What these repairs deliberately do not do: they do not accept a pooled `get_stock_profile` ref for a target price (a coincidence risk the upstream filter exists for), and they do not turn artifact files or calculator outputs into evidence. Both are measured by the golden set before anyone reconsiders them.

### 5.3 Guidance in the system prompt (R6)

Three additions to `agent/context.py`:

- A number read in a `web_search` or `read_url` result is `cited` (source named in the same sentence as the figure), never `observed`. All 33 `no_evidence` issues were `observed` figures with a `web_search` ref.
- A value passed into `options_payoff`, `options_pricing` or `financial_rigor` is that tool's input, not an observation: declare it from the tool that returned it (`get_market_data`, `get_options_chain`, ...), and declare what the calculator computes as `derived` with its formula. A covered-call answer had cited a payoff tool's input echo as the source of the market price.
- For US equities, call `get_stock_profile`, `get_financial_statements`, `get_sec_filings` and `get_stock_news` before `web_search`, and use `web_search` only for what they lack.

Prompt changes alter model behaviour, so the live before/after (section 7) is the acceptance test, not the wording.

### 5.4 Tool data and reliability (R7, R8)

- **R7 `tools/stock_profile_tool.py`.** `_earnings_trend` keeps `revenue_low`, `revenue_high`, `revenue_analysts`, `revenue_growth` (Yahoo's `revenueEstimate` carries `avg`, `low`, `high`, `numberOfAnalysts`, `growth`, `yearAgoRevenue`; the tool kept only `avg`) and the other revision counts Yahoo's `epsRevisions` carries: `eps_revisions_up_7d`, `eps_revisions_down_7d` and `eps_revisions_down_90d`. Yahoo has no upward 90-day count (the payload holds `upLast7days`, `upLast30days`, `downLast7Days`, `downLast30days`, `downLast90days`), so the tool returns what exists and the answer must not infer the rest. A new section `earnings_history` reads Yahoo's `earningsHistory` module (verified for NVDA: four quarters of `quarter`, `epsActual`, `epsEstimate`, `epsDifference`, `surprisePercent`) as `quarter`, `eps_actual`, `eps_estimate`, `eps_difference`, `surprise_percent`. It joins `_SECTION_MODULES` and the default sections.
- **R8 `tools/web_reader_tool.py`.** When `JINA_API_KEY` is set, send it as a bearer token to the reader; redact it even if a successful page, error body or exception echoes it, before logging or returning content. A 401 or 403 from the reader returns an error that tells the model to stop retrying that page and, without a key, that the reader refuses anonymous access. Without the key behaviour is otherwise unchanged. The reader's own documentation puts anonymous callers at 20 requests per minute per IP and a free key at 500 per minute per key, and says a key does not unblock sites that refuse the reader. The owner's free key goes in `ai-trading/vibe-trading`; the code is inert until then.

## 6. What Does Not Change

- Identity locking, `recovery_action` (symbol resolution and price-evidence rounds), the two-draft revision budget and the correction prompts.
- A market answer that observed no price still gets the stub; an unresolved identity still gets the stub.
- A `proposed` level, a draft with no figures block, a figure for a symbol the session never handled, and a misattributed figure are still cut.
- `redacted_release`, `safe_fallback` and the validators' reason codes are untouched except for R2, R3 and R5.

## 7. Testing and Verification

- **Unit tests** (fork `agent/tests/`), written first and watched failing for the stated reason: `test_grounding_flagged_release.py` (20 tests: keep and mark; cut for a proposed level, an unknown reason and a draft with no block; the fail-closed cases; forged marks; Chinese; a table cell; a repeated figure; a currency suffix; `no_symbol`; a bare year; the recorded artifact), `test_grounding_percent_notes.py`, `test_grounding_exact_field_refs.py` (the repairs and every still-rejected control), additions to `test_grounding_figures_contract.py`, `test_grounding_release.py` (one loop-level test), `test_agent_output_discipline.py`, `test_stock_profile_tool.py` and `test_web_reader_security.py`. Fixtures are synthetic, modelled on the recorded failures; the profile tool is run with Yahoo mocked so the evidence envelope is the real one.
- **Existing suites pass unchanged**, including upstream's loop-level redaction tests and `test_grounding_unknown_call_id_refs.py`, then the whole backend suite (`python -m pytest agent/tests -q -n 8`).
- **Live before and after** on the prompts that reach the gate, gate on, `xhigh`, recorded in [the results](01o-vibe-answer-integrity-results.md): outcome, drafts rejected, issues, marks, `web_search` and `get_stock_profile` calls. The baseline is ten runs on the pinned code; the check after the changes is run with `tools/vibe-eval/` (new, committed with the plan).
- **Spot-check** of flagged figures against the tool results in the stored runs, recorded as `n of m correct`: the gate cannot match a value the model passed through a calculator, but the value is usually right and the mark is the honest label.
- **Real browser:** a flagged answer renders its marks and one footnote, and no stale "revising" status stays (done in the batch's browser walkthrough with sub-project 2).

## 8. DIVERGENCE.md Entries

One Backend row per change, each in the same commit as its change (their exact text is in the plan's task files), plus the preserved behaviours below:

| Path | Change |
|---|---|
| `agent/src/agent/grounding/figures.py` | `_parse_value` reads a sign before the currency mark |
| `agent/src/agent/grounding/policies.py` (two rows) | Percent figures with a literal `100` operand compare in points too; `_ref_names_exact_field()` and the exact-ref money leaves for observed figures and derived operands |
| `agent/src/agent/grounding/evidence.py` | `_EXACT_REF_MONEY_LEAVES`, `_is_exact_ref_money_leaf()` |
| `agent/src/agent/grounding/release.py`, `ledger.py` | `flagged_release()` and its helpers, the marks, `figures_flagged` |
| `agent/src/agent/loop.py` | Calls `flagged_release`; the `released_flagged` status and `answer_released_flagged` event |
| `agent/src/agent/context.py` | The three prompt sentences |
| `agent/src/tools/stock_profile_tool.py` | Revenue range, extra revision counts, `earnings_history` |
| `agent/src/tools/web_reader_tool.py` | Optional `JINA_API_KEY`; refusal text |

Behaviours to preserve through a sync (new items 4 and 5):

4. A completed analysis is never replaced by the canned stub for figure-level issues. When the model declared its figures, those the checker could not verify are released with `(unverified※)` and one footnote. A `proposed` level, every failing figure of a draft with no figures block, a misattributed figure and any reason the fork does not list are cut. An identity finding, and a market answer that observed no price, still get the stub.
5. A currency-marked figure whose ref names one exact field is checked against that field when the field is a listed money leaf (`_EXACT_REF_MONEY_LEAVES`). A pooled tool or call ref, a ratio, a return and a count never ground a money figure.

"Reapplying after a sync" gains `release.py`, `policies.py`, `evidence.py`, `figures.py`, `loop.py` and `context.py` to the expected-conflict list, and tells the next sync to re-run the live check, because an upstream sync already fixed some earlier false rejections (prose-wrapped formula notes now parse).

## 9. Rollout and Owner Actions

- Ships in Batch 1 with 01p. The deploy also applies `LANGCHAIN_USE_RESPONSES_API=true` (already in Firestore). It restarts the containers and kills in-flight runs, so check for active runs first.
- Optional owner action: register a free Jina reader key and store it as `JINA_API_KEY` in `ai-trading/vibe-trading` (the assistant cannot register accounts). Keep it out of the chat and the repository: `printf '%s' "$KEY" | common/config/family_config.py set ai-trading/vibe-trading JINA_API_KEY`.
- Rollback: revert the fork commits and move the gitlink back; no data migration, and `grounding_evidence.json` readers ignore the new fields.

## 10. Risks

- **A flagged figure is wrong.** It is visibly marked and footnoted; the stub and cut paths remain for invention and for a draft that declared nothing; the unit post-condition and the live spot-check measure it. Upstream chose to fail closed; the owner chose to inform.
- **Flags on correct figures.** Model-passed calculator inputs, computed payoffs and refs the checker does not resolve stay flagged (a covered-call answer still carried about ten marks). They are honest labels, not errors, and sub-project 3 measures how often a correct figure is flagged.
- **Upstream conflicts.** The hunks are small and mostly additive methods; the sync skill reads the new DIVERGENCE rows, and every sync re-runs the live check.
- **Allow-list drift.** A new upstream reason defaults to cut, which is the safe direction.

## 11. Out of Scope

- Grounding SEC statement values: the statements tool returns XBRL concept names with a separate `_units` map, so a name allow-list cannot cover them, and figures written as "$109.4 billion" need scale words as well. Both are measured by the golden set first.
- Making artifact files and calculator outputs evidence (the S06 operand families), and a kind-agnostic match for pooled refs: only if the golden set shows false flags that matter.
- A direct-fetch reader fallback (needs an SSRF guard), changing the revision budget, and styling the marks in the UI.
