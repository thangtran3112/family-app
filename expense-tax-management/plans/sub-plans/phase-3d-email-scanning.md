# Phase 3D — Automated Email Receipt Scanning (Gmail)

> **Milestone**: 2 (Ingestion Pipeline & Auto-Tagging)
> **Dependencies**: Phase 3A (Temporal Setup), Phase 3B (Deduplication)
> **Estimated Effort**: 4-5 days

---

## Objective

Automatically scan the user's Gmail inbox on a daily schedule to discover, extract, and ingest expense receipts from order confirmations, invoices, and digital receipts — while deduplicating against manually scanned receipts.

---

## Why Email Scanning?

Many expenses arrive as email receipts and never exist as physical paper:
- **Online orders**: Amazon, IKEA, Costco online, Best Buy, Walmart, etc.
- **Subscriptions**: Netflix, Spotify, AWS, GitHub, Adobe, etc.
- **Travel**: Airlines, hotels, Uber, Lyft (email confirmations)
- **Services**: Utilities, insurance, professional services
- **Digital purchases**: App Store, Google Play, Steam

Users shouldn't have to manually forward or scan these — the system should find them automatically.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    EMAIL INGESTION PIPELINE                       │
│                                                                   │
│  ┌────────────────────┐                                          │
│  │  Temporal Cron      │  Runs daily at configurable time        │
│  │  Schedule           │  (e.g., 2:00 AM user's timezone)        │
│  └────────┬───────────┘                                          │
│           │                                                       │
│           ▼                                                       │
│  ┌────────────────────┐                                          │
│  │  Gmail API Client   │  OAuth2 authenticated                   │
│  │  (google-api-python-client)       │  Scoped: gmail.readonly                 │
│  └────────┬───────────┘                                          │
│           │                                                       │
│           ▼                                                       │
│  ┌────────────────────┐                                          │
│  │  Email Filter       │  Query: receipt OR invoice OR order     │
│  │  & Discovery        │  Filter: after last_scan_timestamp      │
│  │  ├─ Subject match   │  Skip: already processed message IDs   │
│  │  ├─ Sender match    │                                         │
│  │  └─ Keyword match   │                                         │
│  └────────┬───────────┘                                          │
│           │                                                       │
│           ▼                                                       │
│  ┌────────────────────┐                                          │
│  │  Receipt Extractor  │  Per matching email:                    │
│  │  ├─ HTML → text     │  - Extract body text                    │
│  │  ├─ Attachments     │  - Download PDF/image attachments       │
│  │  └─ LLM classify   │  - Classify: is this a receipt? (Y/N)   │
│  └────────┬───────────┘                                          │
│           │                                                       │
│           ▼                                                       │
│  ┌────────────────────┐                                          │
│  │  Cross-Channel      │  Check if this expense was already      │
│  │  Deduplication      │  scanned manually (content hash,        │
│  │  (Phase 3B)         │  amount+date+merchant match)            │
│  └────────┬───────────┘                                          │
│           │                                                       │
│           ▼                                                       │
│  ┌────────────────────┐                                          │
│  │  Standard Ingestion │  Same pipeline as manual upload:        │
│  │  Pipeline           │  OCR → Categorize → Tag → Store → Graph │
│  └────────────────────┘                                          │
└─────────────────────────────────────────────────────────────────┘
```

---

## Tasks

### 1. Gmail OAuth2 Integration

- [x] GCP Project & OAuth Client: Already configured in user's existing Google Cloud project
- [ ] Enable **Gmail API** in existing GCP project
- [ ] Configure OAuth consent screen for verification (`gmail.readonly` scope)
- [ ] Store refresh tokens securely (AES-256 encrypted in DB)
- [ ] Handle token refresh and expiry automatically
- [ ] Add env vars: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`
- [ ] Create UI flow: Settings → "Connect Gmail" → OAuth consent → Success

### 2. Email Settings & Configuration (DB Model)

- [ ] Add `EmailConfig` and `ProcessedEmail` models to SQLAlchemy:
  ```python
  from datetime import datetime
  from decimal import Decimal
  from typing import List, Optional
  import uuid
  from sqlalchemy import String, Boolean, DateTime, Numeric, ForeignKey, Integer, func, UniqueConstraint
  from sqlalchemy.dialects.postgresql import UUID, ARRAY
  from sqlalchemy.orm import Mapped, mapped_column, relationship
  from app.models.base import Base

  class EmailConfig(Base):
      __tablename__ = "email_configs"

      id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
      tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
      user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), unique=True, nullable=False)

      # Gmail OAuth
      provider: Mapped[str] = mapped_column(String(50), default="gmail", nullable=False)
      email: Mapped[str] = mapped_column(String(255), nullable=False)
      access_token: Mapped[str] = mapped_column(String, nullable=False)   # Encrypted
      refresh_token: Mapped[str] = mapped_column(String, nullable=False)  # Encrypted
      token_expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

      # Scan settings
      is_enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
      scan_frequency: Mapped[str] = mapped_column(String(20), default="daily", nullable=False)  # "daily", "hourly", "manual"
      scan_time: Mapped[Optional[str]] = mapped_column(String(5), default="02:00", nullable=True)  # Preferred scan time (HH:mm)
      timezone: Mapped[str] = mapped_column(String(50), default="America/Chicago", nullable=False)
      last_scan_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
      last_scan_message_id: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
      initial_scan_days: Mapped[int] = mapped_column(Integer, default=30, nullable=False)

      # Filtering
      sender_whitelist: Mapped[List[str]] = mapped_column(ARRAY(String), default=list, nullable=False)
      sender_blacklist: Mapped[List[str]] = mapped_column(ARRAY(String), default=list, nullable=False)
      label_filter: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
      min_amount: Mapped[Optional[Decimal]] = mapped_column(Numeric(12, 2), nullable=True)

      created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
      updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

  class ProcessedEmail(Base):
      __tablename__ = "processed_emails"

      id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
      user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
      email_config_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("email_configs.id", ondelete="CASCADE"), nullable=False)

      gmail_message_id: Mapped[str] = mapped_column(String(255), nullable=False)
      thread_id: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
      subject: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
      sender: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
      received_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

      # Processing result
      is_receipt: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
      expense_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("expenses.id", ondelete="SET NULL"), nullable=True)
      processing_status: Mapped[str] = mapped_column(String(50), default="pending", nullable=False)  # pending, processed, skipped, error
      skip_reason: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)

      created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

      __table_args__ = (
          UniqueConstraint("user_id", "gmail_message_id", name="uq_user_gmail_message"),
      )
  ```

### 3. Email Discovery & Filtering

- [ ] Implement Gmail API query builder in Python:
  ```python
  from datetime import datetime, timedelta

  def build_gmail_query(config: EmailConfig) -> str:
      parts = []
      
      # Time filter: only emails since last scan, or initial scan window (default 30d, max 90d)
      if config.last_scan_at:
          parts.append(f"after:{int(config.last_scan_at.timestamp())}")
      else:
          scan_days = min(config.initial_scan_days or 30, 90)
          initial_date = datetime.utcnow() - timedelta(days=scan_days)
          parts.append(f"after:{int(initial_date.timestamp())}")
      
      # Receipt keywords
      keywords = [
          "receipt", "invoice", "order confirmation", "payment confirmation",
          "purchase", "transaction", "billing statement", "subscription",
          "your order", "order shipped", "payment received"
      ]
      parts.append(f"({' OR '.join(f'\"{k}\"' for k in keywords)})")
      
      # Sender whitelist
      if config.sender_whitelist:
          parts.append(f"({' OR '.join(f'from:{s}' for s in config.sender_whitelist)})")
      
      # Exclude blacklisted senders
      for s in config.sender_blacklist:
          parts.append(f"-from:{s}")
          
      return " ".join(parts)
  ```

- [ ] Known receipt sender patterns (pre-configured):
  | Sender Pattern | Type |
  |---------------|------|
  | `*@amazon.com` | Order confirmation |
  | `*@ikea.com` | Order/receipt |
  | `*@costco.com` | Online order |
  | `*@uber.com`, `*@lyft.com` | Ride receipt |
  | `*@airbnb.com` | Booking confirmation |
  | `noreply@*` with receipt keywords | Generic receipts |
  | `*@paypal.com` | Payment confirmation |
  | `*@square.com`, `*@stripe.com` | Payment receipts |
  
- [ ] Skip already-processed Gmail message IDs (stored in `ProcessedEmail`)
- [ ] Batch fetch: process up to 100 emails per scan run

### 4. Receipt Classification (LLM)

- [ ] For each candidate email, use LLM to classify:
  ```
  Prompt: "Is this email a receipt, invoice, or order confirmation 
  for a purchase? Respond with JSON: { isReceipt: boolean, 
  confidence: number, reason: string }"
  ```
- [ ] Extract from email:
  - **HTML body** → parse to plain text (use `beautifulsoup4` or `html2text`)
  - **Attachments** → download PDF/image attachments
  - **Inline images** → extract embedded receipt images
- [ ] Confidence threshold: only process if confidence > 0.7
- [ ] Log classification results in `ProcessedEmail` for audit

### 5. Email Receipt Extraction

- [ ] For confirmed receipts, extract structured data:
  - If email has PDF attachment → process PDF through existing OCR pipeline
  - If email is HTML receipt → extract data directly from HTML structure
  - If email has embedded image → process image through OCR
  - If email is text-only → extract data from email body via LLM
- [ ] Map extracted data to same `ExtractedExpenseData` schema (Phase 0C)
- [ ] Set `source: 'EMAIL'` on the created expense for tracking
- [ ] Store original email metadata (sender, subject, date, messageId)

### 6. Cross-Channel Deduplication

- [ ] Before creating expense from email, check for existing duplicates:
  - **Content hash match**: Same amount + date + merchant from manual scan
  - **Temporal proximity**: Receipt within ±2 days, same merchant, similar amount (±5%)
  - **Attachment match**: PDF attachment hash matches uploaded file hash
- [ ] If duplicate found:
  - Link email to existing expense (add email as additional source)
  - Enrich existing expense with email data if it has more details
  - Don't create duplicate expense
- [ ] If no duplicate:
  - Create new expense with `source: 'EMAIL'`
  - Tag with `auto:email-scan`, `auto:{sender-domain}`

### 7. Temporal Scheduled Workflow (Python)

- [ ] Create `EmailScanWorkflow` as a Temporal scheduled workflow:
  ```python
  from datetime import timedelta
  from temporalio import workflow
  from temporalio.common import RetryPolicy

  with workflow.unsafe.imports_passed_through():
      from backend.workers.activities.email import (
          load_email_config, refresh_token_if_needed, discover_receipt_emails,
          classify_email, extract_email_receipt, cross_channel_deduplicate,
          create_expense_from_email, mark_email_processed, update_last_scan_timestamp
      )

  @workflow.defn
  class EmailScanWorkflow:
      @workflow.run
      async def run(self, user_id: str) -> dict:
          config = await workflow.execute_activity(
              load_email_config, user_id,
              start_to_close_timeout=timedelta(seconds=10)
          )
          if not config.get("is_enabled"):
              return {"status": "disabled"}

          await workflow.execute_activity(
              refresh_token_if_needed, config,
              start_to_close_timeout=timedelta(seconds=30)
          )

          emails = await workflow.execute_activity(
              discover_receipt_emails, config,
              start_to_close_timeout=timedelta(minutes=2)
          )

          results = []
          for email in emails:
              classification = await workflow.execute_activity(
                  classify_email, email,
                  start_to_close_timeout=timedelta(seconds=30)
              )
              if not classification.get("is_receipt"):
                  await workflow.execute_activity(
                      mark_email_processed, (email["id"], "skipped", "not_a_receipt"),
                      start_to_close_timeout=timedelta(seconds=10)
                  )
                  continue

              extracted = await workflow.execute_activity(
                  extract_email_receipt, email,
                  start_to_close_timeout=timedelta(minutes=1)
              )

              duplicate = await workflow.execute_activity(
                  cross_channel_deduplicate, (extracted, user_id),
                  start_to_close_timeout=timedelta(seconds=15)
              )
              if duplicate:
                  await workflow.execute_activity(
                      mark_email_processed, (email["id"], "duplicate", duplicate["expense_id"]),
                      start_to_close_timeout=timedelta(seconds=10)
                  )
                  continue

              expense = await workflow.execute_activity(
                  create_expense_from_email, (extracted, email),
                  start_to_close_timeout=timedelta(seconds=30)
              )
              await workflow.execute_activity(
                  mark_email_processed, (email["id"], "processed", expense["id"]),
                  start_to_close_timeout=timedelta(seconds=10)
              )
              results.append(expense)

          await workflow.execute_activity(
              update_last_scan_timestamp, config["id"],
              start_to_close_timeout=timedelta(seconds=10)
          )
          return {"processed_count": len(results), "total_scanned": len(emails)}
  ```

- [ ] Register Temporal schedule in Python:
  ```python
  from temporalio.client import (
      Client, Schedule, ScheduleActionStartWorkflow,
      ScheduleIntervalSpec, ScheduleSpec, ScheduleCalendarSpec
  )

  async def register_daily_email_scan(client: Client, user_id: str, hour: int = 2, minute: int = 0):
      await client.create_schedule(
          id=f"email-scan-{user_id}",
          schedule=Schedule(
              action=ScheduleActionStartWorkflow(
                  EmailScanWorkflow.run,
                  user_id,
                  id=f"email-scan-run-{user_id}",
                  task_queue="email-processing",
              ),
              spec=ScheduleSpec(
                  calendars=[ScheduleCalendarSpec(hour={hour}, minute={minute})]
              ),
          ),
      )
  ```

### 8. Settings UI

- [ ] Add to Settings page (`/settings`):
  - **Connect Gmail**: OAuth flow button
  - **Email scan status**: Connected email, last scan time, results summary
  - **Scan frequency**: Daily (default), hourly, manual only
  - **Scan time**: Time picker for daily scan
  - **Sender whitelist/blacklist**: Manage sender filters
  - **Minimum amount**: Skip receipts below this threshold
  - **Manual scan**: "Scan now" button for on-demand scanning
  - **Scan history**: Table of recent scans with counts (found, processed, skipped, duplicated)

### 9. Notifications

- [ ] After each email scan, create in-app notification:
  - "Email scan complete: 5 new receipts found, 2 duplicates skipped"
- [ ] Highlight new email-sourced expenses in the expense list (badge/icon)
- [ ] Future: Push notification on mobile when new receipts are found

---

## Gmail API Setup

### Google Cloud Console Setup

1. Create or select a GCP project
2. Enable **Gmail API**
3. Configure **OAuth consent screen** (External or Internal)
4. Create **OAuth 2.0 Client ID** (Web application)
5. Set authorized redirect URI: `{BASE_URL}/api/v1/auth/gmail/callback`
6. Download client credentials

### Required Scopes

| Scope | Purpose |
|-------|---------|
| `https://www.googleapis.com/auth/gmail.readonly` | Read emails and attachments |
| `https://www.googleapis.com/auth/gmail.labels` | (Optional) Read/create labels |
| `https://www.googleapis.com/auth/gmail.modify` | (Optional) Mark processed emails |

### Environment Variables

```env
# Gmail API
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_REDIRECT_URI=http://localhost:8000/api/v1/auth/gmail/callback
```

---

## Security Considerations

- [ ] Encrypt OAuth tokens at rest (AES-256 or use a secrets manager)
- [ ] Request minimum necessary scopes (`gmail.readonly`)
- [ ] Implement token revocation when user disconnects Gmail
- [ ] Rate limit Gmail API calls (quota: 250 units/user/second)
- [ ] Never store raw email content long-term — only extracted expense data
- [ ] Audit log: record all email access for compliance

---

## Definition of Done

- [ ] User can connect their Gmail account via OAuth in Settings
- [ ] Daily scheduled scan discovers new receipt emails
- [ ] Receipts are extracted from email body and/or attachments
- [ ] LLM correctly classifies receipt vs. non-receipt emails (>90% accuracy)
- [ ] Cross-channel dedup prevents duplicate expenses from email + manual scan
- [ ] New email-sourced expenses appear in the expense list with an email source badge
- [ ] User can disconnect Gmail and revoke access
- [ ] Scan history is visible in Settings

---

## Future Enhancements

- **Microsoft Outlook / Office 365** support (Microsoft Graph API)
- **IMAP support** for generic email providers
- **Real-time Gmail push notifications** (Gmail Pub/Sub) instead of polling
- **Auto-labeling** processed emails in Gmail (e.g., apply "Processed by ExpenseApp" label)
- **Forwarding address**: Allow users to forward receipts to a dedicated email (e.g., `receipts+{userId}@expenseapp.com`)

---

## Notes

- TaxHacker has a basic email sync script (`app/(app)/apps/email/scripts/fetch-emails.ts`) — reference for patterns
- Gmail API rate limits: 250 quota units/user/second, 1 billion quota units/day
- Consider batching: fetch message list first, then batch-get message details
- For large inboxes, use `historyId` for incremental sync instead of date-based queries
