# Phase 0P: Secure Forwarded Receipt Intake

Source: Phase 0I design §12, §17, §22. Depends on 0J1 + 0C (complete).

## Delivered scope

- One physical receiver address (`INBOUND_EMAIL_BASE_ADDRESS`) with one
  active per-scope virtual address. Routing token is 128-bit lowercase
  hex derived from HMAC(secret, random UUID); DB stores SHA-256 only.
  Current address is re-derived, so UI can display it without persisting
  raw token material.
- Verified-sender challenge lifecycle. DB stores challenge hash only.
  Local notifier writes one 0600 token file; real email-delivery adapter
  needs provider credentials and is pre-release/deployment work.
- Provider-neutral raw-byte webhook using custom content type
  `application/vnd.expense-tax.inbound+json`; `x-inbound-signature`
  HMAC covers exact bytes. Invalid signatures persist nothing.
- Trust engine before 0D/0C: direct DMARC+(SPF or DKIM) OR valid ARC,
  token+sender scope match, forwarding entitlement, max 5 attachments,
  25MB per attachment/30MB total, MIME allowlist + file magic, EICAR
  pattern scanner, 30/token/hour, provider Message-ID idempotency,
  tenant content-hash dedupe, HTML-to-plain sanitization.
- Every validly-signed rejected message is quarantined with closed reason.
  No pre-trust failure creates a file/job/expense or consumes OCR credit.
  Tenant owner/editor can dismiss; unknown-token quarantine remains
  system-only (no tenant oracle).
- Trusted attachments use existing 0D session/write/confirm and 0C OCR
  creation. Jobs use `ForwardedReceiptWorkflow`, which enters the exact
  standard OCR pipeline; only opaque JobReferenceV1 enters Temporal.

## Explicit deferred items

- Full antivirus adapter (current EICAR pattern proves the seam).
- Real verification-email notifier and real inbound provider adapter
  (credentials/provider decision required).
- Raw MIME storage/parser. Normalized webhook body is sanitized and then
  discarded; durable metadata + receipt attachment only, satisfying short
  raw-content retention by retaining none.
- Quarantine release. Dismiss-only is deliberate: release after a failed
  trust check would require revalidation policy; unsafe to guess.
- Automatic retention/rate cleanup scheduler (lazy query window for now).

## Schema/API

Migration 012: `verified_email_senders`, `inbound_routing_tokens`,
`inbound_emails`, `inbound_email_attachments`,
`inbound_email_quarantine_events` with composite scope FKs and DB checks.

Tenant routes under Personal/business `/forwarding`: sender create/list/
verify/revoke, token get/rotate, intake history, quarantine list/dismiss.
Webhook: `POST /internal/v1/inbound-email/provider-webhook`.

## Verification

Contracts + trust primitive unit tests + route tests + real Postgres/local
storage integration. Matrix covers unknown/revoked/mismatched sender,
mail-auth failure, MIME magic, unsupported type, EICAR, duplicate, rate
limit, dismiss, and trusted attachment creating READY file +
ForwardedReceiptWorkflow job. Python time-skipping test proves forwarded
workflow reaches the standard OCR result path.
