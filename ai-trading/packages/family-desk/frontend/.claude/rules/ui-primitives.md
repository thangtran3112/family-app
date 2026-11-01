# UI primitives and tokens (Family Desk frontend)

Applies to `components/**`, `app/globals.css` and `lib/desk/**`. Paths are relative to this package. Plan: `design-component-system.md` §4 and §7.

## Components

- Use `components/ui/*` before writing a button, chip, panel, field, menu or dialog. Import each primitive directly (`@/components/ui/Button`); there is no barrel file.
- A primitive owns its CSS module. A consumer may pass `className` for layout only (grid-area, margin, width), never for colour, size or type.
- Tone and label maps live in `lib/desk/*View.ts`, never in a component file. A component file never exports a tone function that another feature imports.
- Fix a problem at the primitive, not in a page module. Do not add a local `.button`, `.chip`, `.srOnly`, a clip width, a raw font size or a local tone map.

## Forms

- A labelled control is a `Field` (`components/ui/Field.tsx`) around `Input`, `NumberInput`, `Select`, `Textarea`, `Checkbox`/`Radio` in a `ChoiceGroup`, or `Switch`. Never hand-write `aria-describedby`, `aria-invalid` or an error id: the field wires one id to the label and one message line. Error words come from `lib/desk/problems.ts` (`fieldError`, `formProblems`) and `ui/ErrorSummary`; never print a schema path.
- A form's save bar is `FormActionBar`, with `ui/Button`s. Pass `dirty`: it reports to the shell guard and the browser's leave prompt, so a form carries no `setDirty` or `beforeunload` code of its own.
- Run-on ids and labels (`RUN_ONS`, `runOnLabel`) and comparison operators (`COMPARE_OPERATORS`, `operatorLabel`) live in `lib/spec/labels.ts` only. `lib/desk/singleSource.test.ts` fails if a component spells a run-on id.
- `components/conditions/` is the shared condition kit (`ConditionRows`, `OperandPicker`, `JsonPanel`); the builder's recursive editor is not part of it.

## Tokens

- Tokens only. Colour, type, space, radius, height, z-index, shadow and the focus ring come from `app/globals.css` (`var(--…)`). No raw hex, no `font-size: Npx`, no `border-radius: Npx` in a module.
- Type floor: `--text-micro` (11px) is for uppercase caps labels only. Running text and values use `--text-meta` (12px) or larger. 10px is banned.
- Focus ring: `outline: var(--focus-ring); outline-offset: 2px`, or the `.focus-ring` class. Do not restate `outline: 2px solid`. Use `.sr-only` for visually hidden text.
- Canvas and SVG cannot read CSS variables: import colours from `lib/desk/chartPalette.ts`. Never write a colour literal in chart code.

## Guard

- `lib/desk/tokenRatchet.test.ts` counts the debt above across `components/**/*.css` and fails if a count rises. When you remove debt, lower its baseline in the same commit. Never raise one.
- `lib/desk/chartPalette.test.ts` fails if the palette and `app/globals.css` disagree. Change both together.
