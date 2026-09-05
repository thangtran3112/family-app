# Phase 2D — Automated Email Receipt Scanning (Gmail)

> **Milestone**: 2 (Ingestion Pipeline & Auto-Tagging)
> **Dependencies**: Phase 2A (Temporal Setup), Phase 2B (Deduplication)
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
│  │  (Phase 2B)         │  amount+date+merchant match)            │
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

- [ ] Add `EmailConfig` model to Prisma schema:
  ```prisma
  # SQLAlchemy 2.0 / SQLModel EmailConfig model
# class EmailConfig(SQLModel, table=True):
    id                String    @id @default(uuid()) @db.Uuid
    tenantId          String    @db.Uuid
    tenant            Tenant    @relation(fields: [tenantId], references: [id])
    userId            String    @unique @db.Uuid
    user              User      @relation(fields: [userId], references: [id])
    
    // Gmail OAuth
    provider          String    @default("gmail")  // Future: outlook, etc.
    email             String                        // user@gmail.com
    accessToken       String                        // Encrypted
    refreshToken      String                        // Encrypted
    tokenExpiresAt    DateTime?
    
    // Scan settings
    isEnabled         Boolean   @default(true)
    scanFrequency     String    @default("daily")   // "daily", "hourly", "manual"
    scanTime          String?   @default("02:00")   // Preferred scan time (HH:mm)
    timezone          String    @default("America/Chicago")
    lastScanAt        DateTime?
    lastScanMessageId String?                       // Gmail message ID watermark
    initialScanDays   Int       @default(30)        // Initial scan depth (default 30, max 90)
    
    // Filtering
    senderWhitelist   String[]  @default([])        // Only scan from these senders
    senderBlacklist   String[]  @default([])        // Skip these senders
    labelFilter       String?                       // Gmail label to scan (e.g., "Receipts")
    minAmount         Decimal?  @db.Decimal(12, 2)  // Skip receipts below this amount
    
    createdAt         DateTime  @default(now())
    updatedAt         DateTime  @updatedAt

    @@index([tenantId])
    @@map("email_configs")
  }

  model ProcessedEmail {
    id                String    @id @default(uuid()) @db.Uuid
    userId            String    @db.Uuid
    emailConfigId     String    @db.Uuid
    
    gmailMessageId    String    // Gmail's unique message ID
    threadId          String?   // Gmail thread ID
    subject           String?
    sender            String?
    receivedAt        DateTime?
    
    // Processing result
    isReceipt         Boolean   @default(false)     // Was this classified as a receipt?
    expenseId         String?   @db.Uuid            // Linked expense if created
    processingStatus  String    @default("pending")  // pending, processed, skipped, error
    skipReason        String?                        // Why it was skipped (not a receipt, duplicate, etc.)
    
    createdAt         DateTime  @default(now())

    @@unique([userId, gmailMessageId])
    @@index([userId, processingStatus])
    @@map("processed_emails")
  }
  ```

### 3. Email Discovery & Filtering

- [ ] Implement Gmail API query builder:
  ```typescript
  // Build Gmail search query
  function buildGmailQuery(config: EmailConfig): string {
    const parts: string[] = [];
    
    // Time filter: only emails since last scan, or initial scan window (default 30d, max 90d)
    if (config.lastScanAt) {
      parts.push(`after:${formatGmailDate(config.lastScanAt)}`);
    } else {
      const scanDays = Math.min(config.initialScanDays || 30, 90);
      const initialDate = new Date(Date.now() - scanDays * 24 * 60 * 60 * 1000);
      parts.push(`after:${formatGmailDate(initialDate)}`);
    }
    
    // Receipt keywords (subject/body)
    const keywords = [
      'receipt', 'invoice', 'order confirmation', 'payment confirmation',
      'purchase', 'transaction', 'billing statement', 'subscription',
      'your order', 'order shipped', 'payment received'
    ];
    parts.push(`(${keywords.map(k => `"${k}"`).join(' OR ')})`);
    
    // Sender whitelist (if configured)
    if (config.senderWhitelist.length > 0) {
      parts.push(`(${config.senderWhitelist.map(s => `from:${s}`).join(' OR ')})`);
    }
    
    // Exclude blacklisted senders
    config.senderBlacklist.forEach(s => parts.push(`-from:${s}`));
    
    return parts.join(' ');
  }
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
  - **HTML body** → parse to plain text (use `cheerio` or `html-to-text`)
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
- [ ] Map extracted data to same `ExtractedExpenseData` interface (Phase 1C)
- [ ] Set `source: 'email'` on the created expense for tracking
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
  - Create new expense with `source: 'email'`
  - Tag with `auto:email-scan`, `auto:{sender-domain}`

### 7. Temporal Scheduled Workflow

- [ ] Create `emailScanWorkflow` as a Temporal scheduled workflow:
  ```typescript
  // Temporal Schedule (cron-style)
  async function emailScanWorkflow(input: { userId: string }) {
    // Step 1: Load email config
    const config = await loadEmailConfig(input.userId);
    if (!config.isEnabled) return { status: 'disabled' };
    
    // Step 2: Refresh OAuth token if needed
    await refreshTokenIfNeeded(config);
    
    // Step 3: Query Gmail for new receipt emails
    const emails = await discoverReceiptEmails(config);
    
    // Step 4: Process each email
    const results = [];
    for (const email of emails) {
      // Step 4a: Classify
      const classification = await classifyEmail(email);
      if (!classification.isReceipt) {
        await markEmailProcessed(email.id, 'skipped', 'not_a_receipt');
        continue;
      }
      
      // Step 4b: Extract receipt data
      const extracted = await extractEmailReceipt(email);
      
      // Step 4c: Cross-channel dedup
      const duplicate = await crossChannelDeduplicate(extracted, input.userId);
      if (duplicate) {
        await linkEmailToExpense(email.id, duplicate.expenseId);
        await markEmailProcessed(email.id, 'duplicate', duplicate.expenseId);
        continue;
      }
      
      // Step 4d: Create expense via standard pipeline
      const expense = await createExpenseFromEmail(extracted, email);
      await markEmailProcessed(email.id, 'processed', expense.id);
      results.push(expense);
    }
    
    // Step 5: Update last scan timestamp
    await updateLastScanTimestamp(config.id);
    
    return { processedCount: results.length, totalScanned: emails.length };
  }
  ```

- [ ] Register Temporal schedule:
  ```typescript
  // Schedule: run daily at user's preferred time
  await temporalClient.schedule.create({
    scheduleId: `email-scan-${userId}`,
    spec: {
      calendars: [{
        hour: scanHour,
        minute: scanMinute,
      }],
    },
    action: {
      type: 'startWorkflow',
      workflowType: 'emailScanWorkflow',
      args: [{ userId }],
      taskQueue: 'email-processing',
    },
  });
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
5. Set authorized redirect URI: `{BASE_URL}/api/auth/gmail/callback`
6. Download client credentials

### Required Scopes

| Scope | Purpose |
|-------|---------|
| `https://www.google-api-python-client.com/auth/gmail.readonly` | Read emails and attachments |
| `https://www.google-api-python-client.com/auth/gmail.labels` | (Optional) Read/create labels |
| `https://www.google-api-python-client.com/auth/gmail.modify` | (Optional) Mark processed emails |

### Environment Variables

```env
# Gmail API
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_REDIRECT_URI=http://localhost:7331/api/auth/gmail/callback
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
