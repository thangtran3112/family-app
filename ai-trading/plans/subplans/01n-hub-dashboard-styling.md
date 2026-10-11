# Trading Hub dashboard styling (approved Paper design)

Source: [TobyTest · Trading Hub · Styling](https://app.paper.design/file/01M4K3AXAKQC8Z6JTW03YR5HEG/p-2-0).
Owner approved the desktop overview, TradingAgents detail, tablet overview and
mobile overview for implementation. This is a frontend styling phase, not a new
trading product or backend control surface.

## Design contract

- Keep the existing Inter font. Paper colors map to existing semantic tokens:
  background `#000000`, foreground `#F2F2F4`, card `#141416`, raised/muted
  `#1C1C1F`, border `#2C2C30`, secondary text `#9B9BA1`, accent `#FFB020`.
- Desktop: 224px sidebar, 72px top bar, 40px content gutters; 36px/44px heading.
- Tablet: no sidebar, 32px gutters and two-column cards.
- Mobile: no sidebar, 24px gutters and single-column cards. Do not render the
  mockup's OS status bar as web content.
- Cards use 12px corners, 40px icon slots, 20px titles and 15px/22px descriptions.
  Minimum heights follow Paper (desktop 208px, tablet 244px, mobile 232px) but
  content may grow rather than clip. Launch controls are at least 44px tall.
- TradingAgents gets the amber primary action; other launch controls use raised
  surfaces. Family Desk is a quiet, non-interactive planned section.
- Real app names, destinations and capabilities stay explicit. Search and
  category filtering remain functional, including the no-match reset state.

## Behavior and scope boundaries

- Preserve all `/apps/*` details and `/u/*` terminal paths. Terminal launchers
  open their hub page; full-screen links use their existing dedicated hostname.
- Web-app launch actions use the configured upstream URL in a new tab with
  `rel="noopener"`; app-name links retain the hub's explanatory detail pages.
- Keep actual terminal iframes and reconnect behavior. Never ship the mockup's
  illustrative terminal text or pretend connection/performance data.
- Keep Clerk verification, session refresh, logout sequencing, read-only account
  data, Escape/focus restoration and origin checks unchanged.
- No upstream, Family Desk, Terraform, gateway-auth or provider changes.

## Verification and delivery

- `pnpm test`: existing auth/static-path suite plus launcher search/link tests.
- `pnpm typecheck && pnpm lint && pnpm build && pnpm test:export`.
- Export checks inspect Next's page data because static prerender intentionally
  shows only the auth loading shell. Signed-in browser QA checks the real DOM.
- `deploy/ci/upload-hub-static.test.sh`: exact known-route RSC segment indexes
  (`__next._index.txt`) are accepted; unknown paths and secrets remain rejected.
- Browser QA: 375/390/768/1440 widths, touch-target sizes, no horizontal overflow,
  search/filter/reset, planned Desk, account menu/Escape/focus, live terminal
  WebSocket 101 and reconnect. Screenshots compare with the approved layout.
- One PR to `dev`, scoped release to `main`, deploy/update the GCS hub and verify
  the live UI. Keep MiroFish enabled and leave the expense stack untouched.
