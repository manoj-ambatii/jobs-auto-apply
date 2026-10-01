# Jobs Auto-Apply (Playwright & Playwright MCP)

An automated job application and file-based tracking system for **LinkedIn** and **Naukri**, supporting both **Headed** and **Headless** browser modes and seamless integration with **Playwright MCP**.

---

## 🌟 Key Features

1. **Dual Browser Execution**:
   - **Headed Mode (`--mode headed`)**: Visible browser window for real-time visual oversight, handling CAPTCHAs, 2FA/OTPs, or initial session login.
   - **Headless Mode (`--mode headless`)**: High-speed, silent background automation once login sessions are established.
   - **Persistent Session Storage**: Stores cookies & browser profiles in `.browser-profile/` so you don't need to re-login on every run.

2. **Full File-Based Job Tracking (No External Database Required)**:
   - `data/applied-jobs.json`: Complete structured JSON log with timestamps, platform, job title, company, URLs, notes, and application status.
   - `data/applied-jobs.csv`: Comma-separated spreadsheet for easy viewing or importing into Google Sheets / Excel.
   - `data/job-applications.xlsx`: Multi-sheet Excel workbook categorized into `Applied`, `External`, `Skipped`, and `Failed` with formatted column widths.
   - `data/tracker-cache.json`: Fast $O(1)$ URL deduplication map to prevent re-applying to the same job twice.

3. **Multi-Platform Automation**:
   - **LinkedIn**: Searches target roles, filters by Easy Apply, auto-fills screening questions from candidate facts, attaches resume, and submits. Detects external career portal redirects and logs them.
   - **Naukri**: In-platform 1-click apply, interactive chatbot dialog answering, external company link capturing, and daily quota monitoring.

4. **Playwright MCP Ready**:
   - Configured with Microsoft's official `@playwright/mcp`.
   - `.mcp.json` contains ready-to-use definitions for both headed (`playwright`) and headless (`playwright-headless`) MCP servers.
   - Includes prompt playbooks in `prompts/` for AI-agent-driven applications.

---

## 📁 Project Architecture

```
jobs-auto-apply/
├── .env                              # Active credentials and preferences
├── .env.example                      # Template configuration
├── .mcp.json                         # Playwright MCP server configurations (headed & headless)
├── package.json                      # Project metadata & npm scripts
├── README.md                         # Documentation & commands
├── resume/
│   └── Manoj_Ambati_Resume.pdf       # Candidate resume PDF for attachments
├── config/
│   ├── candidate.json                # Single source of truth candidate facts & answers
│   └── index.js                      # Centralized configuration loader
├── data/                             # File-based tracking store
│   ├── applied-jobs.json             # Master JSON application history
│   ├── applied-jobs.csv              # CSV spreadsheet export
│   ├── job-applications.xlsx         # Multi-sheet Excel tracker (Applied, External, etc.)
│   └── tracker-cache.json            # Fast O(1) deduplication URL cache
├── prompts/                          # Playwright MCP agent prompts
│   ├── apply-linkedin-mcp.md         # LinkedIn playbook for MCP
│   ├── apply-naukri-mcp.md           # Naukri playbook for MCP
│   └── candidate-facts.md            # Screening answers reference
└── src/
    ├── browser/
    │   └── browser-manager.js        # Persistent browser context & anti-detection
    ├── tracker/
    │   └── file-tracker.js           # File persistence (JSON, CSV, XLSX) & deduplication
    ├── platforms/
    │   ├── linkedin.js               # LinkedIn automated workflow
    │   └── naukri.js                 # Naukri automated workflow
    ├── cli.js                        # Unified CLI runner
    └── index.js                      # Programmatic exports
```

---

## 🚀 Quickstart

### 1. Install Dependencies & Playwright Browsers

```bash
npm install
npx playwright install chromium
```

### 2. Configure Environment

Verify `.env` has your credentials and configuration:

```env
LINKEDIN_EMAIL=your-email@example.com
LINKEDIN_PASSWORD=your-password
NAUKRI_EMAIL=your-email@example.com
NAUKRI_PASSWORD=your-password

# Default browser mode: 'false' for headed (visible), 'true' for headless
HEADLESS=false

TARGET_APPLICATIONS=25
JOB_SEARCH_KEYWORDS=Full Stack Developer, Java Developer, React Developer, MERN Developer
JOB_SEARCH_LOCATIONS=Hyderabad, Bengaluru, Remote
```

---

## 💻 Running the Application

### Option A: Automated CLI

You can run automated job applications directly using npm scripts or the CLI:

#### Headed Mode (Visible Browser - Recommended for First Run / Checking Session)
```bash
# Apply on both LinkedIn, Naukri, and External sites (Headed)
npm run apply:all -- --mode headed

# Apply on LinkedIn only (Headed)
npm run apply:linkedin:headed

# Apply on Naukri only (Headed - in-platform + external career portals)
npm run apply:naukri:headed

# Apply on External Company Career Sites directly (Headed)
npm run apply:external:headed
```

#### Headless Mode (Silent Background Execution)
```bash
# Apply on LinkedIn only (Headless)
npm run apply:linkedin:headless

# Apply on Naukri only (Headless)
npm run apply:naukri:headless

# Apply on External Career Sites only (Headless)
npm run apply:external:headless

# Apply on all (Headless)
npm run apply:all -- --mode headless
```

#### Custom Limits & Platforms via CLI
```bash
# Apply to up to 10 jobs on LinkedIn in headed mode
node src/cli.js apply --platform linkedin --mode headed --limit 10

# Apply to up to 30 jobs on Naukri in headed mode
node src/cli.js apply --platform naukri --mode headed --limit 30

# Apply to up to 20 external company career portals in headed mode
node src/cli.js apply --platform external --mode headed --limit 20
```

---

## 📊 File-Based Tracking & Stats

All application progress is tracked directly to files in `data/`.

### View Tracking Statistics
```bash
npm run tracker:stats
```
*Outputs total processed, successful applications, external career links captured, skipped jobs, and platform breakdown.*

### List Recent Applications
```bash
npm run tracker:list
```

### Re-export Files
```bash
npm run tracker:export
```
*Regenerates `data/applied-jobs.csv` and `data/job-applications.xlsx` from `data/applied-jobs.json`.*

---

## 🤖 Using with Playwright MCP

The project includes `.mcp.json` configured for Microsoft Playwright MCP:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"]
    },
    "playwright-headless": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest", "--headless"]
    }
  }
}
```

### Driving via AI Agents:
- For **Headed mode**: Select or instruct the agent to use the `playwright` MCP server.
- For **Headless mode**: Select or instruct the agent to use the `playwright-headless` MCP server.
- Refer to `prompts/apply-linkedin-mcp.md` and `prompts/apply-naukri-mcp.md` for prompt templates.

---

## ⚙️ Candidate Profile Customization

Update `config/candidate.json` to customize:
- Years of experience per skill / technology
- Current & expected CTC
- Notice period (Immediate, 15 days, etc.)
- Education & Degree
- Answers to behavioral questions
