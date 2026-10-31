# UI primitives and tokens (Family Desk frontend)

Applies to `components/**`, `app/globals.css` and `lib/desk/**`. Paths are relative to this package. Plan: `design-component-system.md` §4 and §7.

## Components

- Use `components/ui/*` before writing a button, chip, panel, field, menu or dialog. Import each primitive directly (`@/components/ui/Button`); there is no barrel file.
- A primitive owns its CSS module. A consumer may pass `className` for layout only (grid-area, margin, width), never for colour, size or type.
- Tone and label maps live in `lib/desk/*View.ts`, never in a component file. A component file never exports a tone function that another feature imports.
- Fix a problem at the primitive, not in a page module. Do not add a local `.button`, `.chip`, `.srOnly`, a clip width, a raw font size or a local tone map.

## Tokens

- Tokens only. Colour, type, space, radius, height, z-index, shadow and the focus ring come from `app/globals.css` (`var(--…)`). No raw hex, no `font-size: Npx`, no `border-radius: Npx` in a module.
- Type floor: `--text-micro` (11px) is for uppercase caps labels only. Running text and values use `--text-meta` (12px) or larger. 10px is banned.
- Focus ring: `outline: var(--focus-ring); outline-offset: 2px`, or the `.focus-ring` class. Do not restate `outline: 2px solid`. Use `.sr-only` for visually hidden text.
- Canvas and SVG cannot read CSS variables: import colours from `lib/desk/chartPalette.ts`. Never write a colour literal in chart code.

## Guard

- `lib/desk/tokenRatchet.test.ts` counts the debt above across `components/**/*.css` and fails if a count rises. When you remove debt, lower its baseline in the same commit. Never raise one.
- `lib/desk/chartPalette.test.ts` fails if the palette and `app/globals.css` disagree. Change both together.
