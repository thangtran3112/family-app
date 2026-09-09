# Phase 0F0 Rebaseline — Approved Three-Product Contract

Approved by Toby Tran on 2026-09-09.

| Product | Shell | Supported viewport | Source |
|---|---|---|---|
| Capture PWA | Capture / Queue / Inbox / Settings | 375, 768 | `capture/index.html` |
| Office Web | Dashboard / Expenses / Businesses / Projects / Tax / Exports / Forwarding / Settings | 1024, 1440 | `office/index.html` |
| Foundry Web | Providers / Models / Modes / Quotas / Reconciliation / Audit | 1024, 1440 | `foundry/index.html` |

Decisions: signup creates tenant + Personal profile; invites join existing scopes. Customer auth routes split login/signup/forgot-password. Foundry has separate platform login. Review PNGs cover populated matrix; alternate loading/empty/error/unauthorized/recovery states become Storybook/state fixtures during implementation.

Shared acceptance: visible focus, 44px touch targets, semantic status text, reduced-motion support, no emoji structural icons, no cross-product controls, profile scope always explicit.
