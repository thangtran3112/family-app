# ADR-0026: A field's sentence shows once, at the field; the footer carries only what no field owns

Status: accepted 2026-11-03, orchestrator ruling on D-204 (wave 23). Applies to the Practice surface; keeps [ADR-0010](ADR-0010-data-honesty.md) (honest states: a message says what is wrong, where it is wrong).

**Why.** The New thread modal printed one problem twice. A bad start time put the sentence under its field, and the footer repeated it about 200 px lower, as the explanation for the disabled Start button. Two identical sentences a finger's width apart are noise. The field is where she is looking, and the disabled button is already explained by the error above it. The practice-landing e2e had pinned the echo ("shown under its field and echoed by the button") as the design; that pin is changed on purpose.

**The decision.**

- **A sentence that a field owns shows once on screen, at the field.** The submit footer never repeats it.
- **The footer carries only a problem no single field owns,** then what is still missing. In the New thread modal the footer owns two keys: `mode` ("every thread slot is in use", a 409 with no control of its own) and `shares` (only an existing thread sets it, so the modal has no box for it). Every other problem key has a box and prints there. `form` (the catch-all) keeps its alert under the last field.
- **With a field error on screen the footer says what Start does** ("Starts with a pretend $X. You can change the plan later."), not why it is off. The button stays `aria-disabled` and Enter does nothing, as before.
- **Where it lives.** One rule at the one footer that printed an echo: `FOOTER_KEYS` and the status line in `components/practice/hub/NewPlanModal.tsx`. A key added to the form later is field-owned by default; a key with no box must be added to `FOOTER_KEYS`.
- **Checked, no other double print:** every `ui/Dialog` on the Desk. `ConfirmDialog` prints its `error` once (its callers do not print it again), the Peek drawer holds no form, and `ThreadPlanPanel` (Edit plan) is a form on a page whose field errors sit at the fields and whose save error is one alert. The summary-plus-inline pattern of the screener editor and the alert setup is a page-level list that names each field, not a modal, and is unchanged.

**Pinned by.** `e2e/desk/practice-landing.spec.ts`: "a field's sentence shows once on screen, at its field" counts the text nodes holding the sentence across the page (one) for a bad balance, start time, start date, Screen size and max loss, at 1440 and 1180; the older "Start waits for a filter…" test now asserts the footer does not echo the balance sentence.

**Related (D-205).** The error summary names a field as the box is labelled. The condition kit's `ParamDef.label` is the one source for the box and its summary line; `operandParamLabels` (`lib/desk/conditionLabels.ts`) words the line for every place that renders an `OperandPicker`: the condition rows (`when.*`), and the screener's Rank by (`rank.by.*`), which it had missed ("Lookback (days)" under a box that says "Days"). Pinned by `e2e/desk/condition-labels.spec.ts` for every kit metric on every side.
