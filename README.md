# AI Job Outreach Agent

[![Next.js](https://img.shields.io/badge/Next.js-16.3-black?style=for-the-badge&logo=next.js)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue?style=for-the-badge&logo=typescript)](https://www.typescriptlang.org/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-v4-38B2AC?style=for-the-badge&logo=tailwind-css)](https://tailwindcss.com/)
[![SQLite](https://img.shields.io/badge/SQLite-WAL_Mode-003B57?style=for-the-badge&logo=sqlite)](https://www.sqlite.org/)
[![Google Gemini](https://img.shields.io/badge/Google_Gemini-2.5_Flash-8E75B2?style=for-the-badge&logo=google)](https://ai.google.dev/)
[![Gmail API](https://img.shields.io/badge/Gmail_API-OAuth_2.0-EA4335?style=for-the-badge&logo=gmail)](https://developers.google.com/gmail/api)

> A production-grade, local-first autonomous job outreach assistant designed to intelligently parse recruiter lists, filter relevant tech companies, analyze candidate resumes, synthesize personalized outreach emails, and manage rate-limited, safety-gated delivery via the Gmail API.

---

## 📌 Overview

**AI Job Outreach Agent** automates cold email outreach for software engineers and IT professionals while strictly upholding sending hygiene and safety rules:
- **Intelligent Filtering:** Discards irrelevant non-tech companies and duplicate recruiter emails across multiple uploads.
- **Resume Intelligence:** Extracts candidate experience, technical stacks, and standout projects to personalize messages without hallucinations.
- **Controlled Email Engine:** Enforces a strict **30-email daily quota**, a **10:00 AM daily dispatch window** (Asia/Kolkata), and a **minimum 3-minute gap** between consecutive emails to preserve recruiter trust and Gmail sender reputation.
- **Persistent Worker & Safety Gates:** Built entirely around SQLite (WAL mode) with atomic worker lease locking, crash recovery, and dry-run simulation modes.

---

## 🚀 Key Features

### 1. Ingestion & Preprocessing (CSV & PDF)
- **Multi-Format Parsing:** Ingests raw CSV and PDF files containing recruiter contacts.
- **Fuzzy Header Mapping:** Automatically detects variations like `Company`, `Org`, `Recruiter Name`, `HR Contact`, `Email Address`, `Mail ID`, and `Website`.
- **OCR Fallback:** Uses `tesseract.js` OCR to extract text from scanned PDFs or images.
- **Email Normalization & Validation:** Validates RFC 5322 syntax and normalizes emails (`email.trim().toLowerCase()`).

### 2. AI Company Relevance Classifier
- Evaluates company industry via Google Gemini AI (`gemini-2.5-flash`).
- Distinguishes software, technology, and substantial in-house IT operations from non-tech businesses (e.g., plumbing, local retail, catering).
- Caches classifications in SQLite (`company_relevance_cache`) to avoid redundant API calls and save tokens.

### 3. Resume Intelligence & Profiling
- Ingests candidate resumes (`.pdf`) and parses structured JSON profiles:
  - Primary title, years of experience, technical skills, domain specializations, and key achievements.
- Generates a unique SHA-256 version hash (`resume_version`).
- **Version Guard:** If a resume is replaced, all older generated emails are locked until regenerated, preventing mismatched PDF attachments.

### 4. Personalized AI Email Synthesizer
- Generates concise, professional outreach emails (100–180 words) using 4 distinct strategies:
  1. **Direct Value Proposition:** Highlights candidate skills matching company focus.
  2. **Project / Impact Focused:** Highlights relevant project achievements and metrics.
  3. **Role & Team Alignment:** Expresses interest in specific engineering initiatives.
  4. **Referral / Informational Inquiry:** Respectfully requests engineering mentorship or referral advice.
- **Hallucination Defense:** Never invents job openings, degrees, or experiences not found in the resume profile.
- **Similarity Protection:** Ensures structural variation across batches; flags excessive Jaccard overlap (>65%).

### 5. Secure Gmail OAuth 2.0 Engine
- Direct integration using the official `googleapis` client with minimal `gmail.send` scope.
- **AES-256-GCM Encryption:** Encrypts refresh tokens, access tokens, and credentials at rest in SQLite using an authenticated Galois/Counter Mode cipher.
- **MIME Multipart Builder:** Constructs standard RFC 2822 messages with boundary separators, headers (`From`, `To`, `Subject`, `Message-ID`, `Date`), HTML/text bodies, and inline PDF resume attachments.
- **Pre-Send Test Harness:** Supports sending safe test messages directly to the authenticated user's own inbox.

### 6. Persistent Queue & Daily Scheduler
- **Standalone Background Worker:** Decoupled from Next.js HTTP request loops; run as a persistent daemon via `npm run worker`.
- **Atomic Worker Lease Lock:** Uses SQLite atomic updates to grant a 90-second heartbeat lease, preventing multiple worker instances from running concurrently.
- **Timezone Scheduling:** Standardized on `Asia/Kolkata` (configurable via `USER_TIMEZONE`). Sending begins at 10:00 AM local time.
- **Exact 3-Minute Spacing:** Checks persistent SQLite timestamps (`last_send_attempt_at`). Spacing survives machine restarts and page refreshes.
- **Daily Quota Management:** Hard ceiling of 30 successful sends/day. Resets automatically at midnight local time. Failed attempts never increment the quota.
- **Crash Recovery & Uncertain State Isolation:**
  - Recovers stale jobs (>60s lease) back to `pending`.
  - Ambiguous network timeouts or socket drops after dispatch are permanently marked **`uncertain`** and **NEVER auto-retried**, preventing duplicate recruiter emails.

### 7. Interactive Dashboard & Controls
- Real-time statistics: Total Companies, Tech Relevant, Total Contacts, Queue Size, Emails Generated, and Skipped/Filtered.
- Live Scheduler Status: Running, Paused, Stopped, Waiting, Quota Reached.
- Persistent **Pause**, **Resume**, and **Stop Campaign** controls with instant state synchronization.
- **Batch Completion Alerts:** Emits visual notices when all eligible contacts in a file are processed.
- **Real-Sending Safety Gate:** Clear visual indicators for **Dry-Run Mode** vs **Live Sending Enabled**.

---

## 🏗️ Architecture

```
┌────────────────────────────────────────────────────────────┐
│                    Next.js App Router                      │
│     (Upload UI, Dashboard, Review, Settings, REST APIs)    │
└────────────────────────────┬───────────────────────────────┘
                             │ Reads / Writes
                             ▼
┌────────────────────────────────────────────────────────────┐
│                  SQLite (WAL Mode Engine)                  │
│   outreach.db (batches, contacts, queue, scheduler_state,  │
│          global_email_history, settings, resume)           │
└────────────────────────────▲───────────────────────────────┘
                             │ Reads / Atomic Leases
┌────────────────────────────┴───────────────────────────────┐
│              Standalone Outreach Worker Process            │
│                  (npm run worker / tsx)                    │
│   - Lease Heartbeat (90s)      - Stale Crash Recovery      │
│   - Timezone Window (10 AM)    - 3-Minute Interval Spacing │
│   - 30/Day Quota Enforcement   - Pre-Send Atomic Dup Guard │
│   - Gmail OAuth 2.0 Engine     - Uncertain State Isolation │
└────────────────────────────────────────────────────────────┘
```

### Directory Structure

```
ai-job-outreach-agent/
├── data/                       # Local SQLite database (outreach.db) [gitignored]
├── docs/
│   └── gmail-setup.md          # Step-by-step Google Cloud OAuth configuration guide
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── batches/        # Batch retrieval and detail routes
│   │   │   ├── contacts/       # Contact query, review, and email regeneration routes
│   │   │   ├── dashboard/      # Real-time dashboard statistics endpoint
│   │   │   ├── generate/       # AI email synthesis orchestration
│   │   │   ├── gmail/          # OAuth auth, callback, disconnect, test-send routes
│   │   │   ├── resume/         # Resume upload, parse, and profile retrieval
│   │   │   ├── scheduler/      # Persistent pause, resume, stop, and status controls
│   │   │   ├── settings/       # App settings and scheduler configuration
│   │   │   └── upload/         # File upload, parsing, and classification pipeline
│   │   ├── batches/            # Batches list and batch detail view
│   │   ├── contacts/           # Contact directory and email preview modal
│   │   ├── settings/           # Resume management, Gmail OAuth, and outreach controls
│   │   ├── upload/             # File upload dropzone and processing logs
│   │   ├── globals.css         # Tailwind CSS v4 design system
│   │   ├── layout.tsx          # Main layout with responsive sidebar navigation
│   │   └── page.tsx            # Dashboard with real-time scheduler & safety gate
│   ├── components/
│   │   ├── layout/             # Sidebar and Header components
│   │   └── ui/                 # Accessible UI components (Card, Button, Badge, Modal, etc.)
│   ├── db/
│   │   ├── schema/             # Drizzle ORM schema definitions (SQLite)
│   │   ├── index.ts            # SQLite WAL connection singleton
│   │   ├── migrate.ts          # Automatic idempotent table creation & migrations
│   │   └── seed.ts             # Default singleton settings and scheduler seeding
│   ├── lib/
│   │   ├── ai/                 # Gemini API client, relevance classifier, email synthesizer
│   │   ├── config/             # Strict environment validation (env.ts)
│   │   ├── crypto/             # AES-256-GCM token encryption and key derivation
│   │   ├── gmail/              # Google OAuth client, MIME message builder, send engine
│   │   ├── parser/             # CSV parser, PDF extractor, Tesseract OCR fallback
│   │   ├── scheduler/          # Time utilities, worker lease locking, queue manager
│   │   ├── db-helpers.ts       # Database helper queries and transaction wrappers
│   │   └── utils.ts            # Formatting, styling, and normalization utilities
│   ├── types/                  # TypeScript interfaces and domain models
│   └── worker/
│       └── outreach-worker.ts  # Persistent background worker daemon
├── tests/
│   ├── verify-phase5.js        # Scheduler, worker lease, crash recovery, and quota tests
│   └── verify-phase6.js        # End-to-end multi-batch, race condition, and safety audit tests
├── drizzle.config.ts           # Drizzle Kit configuration
├── package.json
└── tsconfig.json
```

---

## 🛠️ Tech Stack

- **Framework:** [Next.js 16 (App Router)](https://nextjs.org/)
- **Language:** [TypeScript](https://www.typescriptlang.org/) (Strict Mode)
- **Styling:** [Tailwind CSS v4](https://tailwindcss.com/)
- **Icons:** [Lucide React](https://lucide.dev/)
- **Database:** [SQLite](https://www.sqlite.org/) with Write-Ahead Logging (`better-sqlite3`)
- **ORM:** [Drizzle ORM](https://orm.drizzle.team/)
- **AI / LLM:** Google Gemini (`gemini-2.5-flash` via `@google/genai`)
- **Email Delivery:** Official [Google Gmail API](https://developers.google.com/gmail/api) (`googleapis`)
- **Security:** AES-256-GCM authenticated encryption (`crypto`)
- **File Processing:** `csv-parse`, `pdf-parse`, `tesseract.js`
- **Worker Runtime:** `tsx` (TypeScript Execute daemon)

---

## ⚙️ Prerequisites & Setup

### 1. Clone the Repository
```bash
git clone https://github.com/Aditya-rjs/ai-job-outreach-agent.git
cd ai-job-outreach-agent
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Configure Environment Variables
Copy `.env.example` to `.env.local`:
```bash
cp .env.example .env.local
```

Fill in your configuration:
```env
# ── Persistent Storage (Railway Volume Compatible) ─
# Defaults to 'data' in project root. On Railway, set to '/data' with a Volume mounted at /data.
DATA_DIR=data

# ── AI ──────────────────────────────────────────────
GEMINI_API_KEY=your_gemini_api_key_here

# ── Gmail OAuth 2.0 ────────────────────────────────
GOOGLE_CLIENT_ID=your_google_oauth_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your_google_oauth_client_secret
GMAIL_REDIRECT_URI=http://localhost:3000/api/gmail/callback

# ── Security ────────────────────────────────────────
# 32-byte hex string (64 characters). Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
ENCRYPTION_KEY=your_64_character_hex_encryption_key
NEXTAUTH_SECRET=your_nextauth_secret

# ── Application ─────────────────────────────────────
NEXT_PUBLIC_APP_URL=http://localhost:3000
USER_TIMEZONE=Asia/Kolkata

# ── Sending Schedule ────────────────────────────────
MAX_DAILY_EMAILS=30
SEND_INTERVAL_MINUTES=3
SEND_START_HOUR=10
SEND_START_MINUTE=0
```

> 📖 **Need help setting up Google OAuth?**  
> Check the detailed walkthrough in [`docs/gmail-setup.md`](docs/gmail-setup.md).

---

## 🚦 Running the Application

### 1. Start the Web Dashboard
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

### 2. Run the Background Outreach Worker

Open a separate terminal window to run the worker daemon:

#### Safe Dry-Run Mode (Recommended for testing):
Simulates intervals, quota counting, and delivery without sending real emails:
```bash
# Windows PowerShell
$env:OUTREACH_DRY_RUN="true"
npm run worker

# macOS / Linux
OUTREACH_DRY_RUN=true npm run worker
```

#### Production Live Sending Mode:
Connect your Gmail account in **Settings** first, then launch:
```bash
npm run worker
```

---

## 🚂 Deploying to Railway (Persistent Storage)

To run the application in production on [Railway](https://railway.app/) with persistent SQLite storage and resume uploads:

### 1. Create a Persistent Volume in Railway
1. In your Railway project, click **+ New** → **Volume**.
2. Mount the volume to your service with the mount path:
   ```
   /data
   ```

### 2. Configure Service Environment Variables
In the Railway service **Variables** tab, set:
```env
DATA_DIR=/data
NODE_ENV=production
NEXT_PUBLIC_APP_URL=https://your-railway-domain.up.railway.app
GMAIL_REDIRECT_URI=https://your-railway-domain.up.railway.app/api/gmail/callback
```
*(Plus your `GEMINI_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ENCRYPTION_KEY`, and `NEXTAUTH_SECRET`).*

### 3. Deploy Web Dashboard & Background Worker
- **Web Dashboard:** Railway will automatically build using `npm run build` and run `npm start`.
- **Outreach Worker:** You can deploy a second Railway service connected to the same repository and mounted to the same persistent `/data` volume, with the Start Command:
  ```bash
  npm run worker
  ```

---

## 🧪 Verification & Testing

The repository includes a comprehensive 80-point automated test suite testing persistent volume resolution, multi-batch queuing, concurrency, crash recovery, and safety rules without sending real emails.

Run all tests:
```bash
# Run full automated test suite (DATA_DIR, Phase 5, Phase 6)
npm test
```

Or run individual verification suites:
```bash
# Run Railway Persistent Storage (DATA_DIR) tests
node tests/verify-data-dir.js

# Run Phase 5 tests (Scheduler, Lease Locking, Quotas)
node tests/verify-phase5.js

# Run Phase 6 tests (E2E Pipeline, Race Guards, Injection Resistance)
node tests/verify-phase6.js
```

Run TypeScript and ESLint checks:
```bash
npx tsc --noEmit
npm run lint
```

Test production build:
```bash
npm run build
```

---

## 🛡️ Safety & Sending Hygiene

- **Zero Real Recruiter Emails in Tests:** Test scripts run in dry-run mode or isolated transactions.
- **Strict Anti-Duplicate Protection:** Re-uploading a file or uploading different files with the same recruiter email will never cause a duplicate send.
- **Atomic Concurrency Locks:** If two workers run simultaneously, the second worker is locked out until the first releases its lease.
- **Permanent "Uncertain" Isolation:** Network drops during dispatch are never automatically resent to eliminate duplicate outreach risks.

---

## 👤 Author

**Aditya Raj Singh**  
- GitHub: [@Aditya-rjs](https://github.com/Aditya-rjs)

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
