# Playwright MCP Prompt — Apply on Naukri

Follow these instructions when driving the browser through Playwright MCP to search, apply, and track Naukri jobs.

## Mode Selection
- **Headed Mode**: Use `playwright` server from `.mcp.json`. Required for first-time login, CAPTCHA, or visual verification.
- **Headless Mode**: Use `playwright-headless` server from `.mcp.json` for background execution once logged in.

## Step 1: Authentication Check
1. Navigate to `https://www.naukri.com/mnjuser/homepage`.
2. Check if logged in. If on login page (`https://www.naukri.com/nlogin/login`):
   - Fill credentials from `.env` (`NAUKRI_EMAIL`, `NAUKRI_PASSWORD`).
   - Click "Login".
   - If CAPTCHA or OTP appears, complete it or notify user.

## Step 2: Search for Jobs
1. Navigate to:
   `https://www.naukri.com/full-stack-developer-jobs-in-hyderabad?k=full+stack+developer&l=hyderabad&experience=2&jobAge=7`
2. Extract all job cards on the page.
3. For each job card:
   - Check if the job URL exists in `data/applied-jobs.json` or `data/tracker-cache.json`.
   - If present, skip.

## Step 3: Apply Process
1. Navigate to the job details page.
2. Check for "Apply" vs "Apply on company site":
   - If "Apply on company site": Capture the external destination link, log to `data/applied-jobs.json` as status `"EXTERNAL"`, and proceed.
   - If "Apply": Click the button.
3. If screening chatbot opens:
   - Match questions with `prompts/candidate-facts.md` (e.g. 2 years experience, 0 days notice period, 4.2 current CTC, 10 expected CTC, immediate joiner).
   - Select option buttons or type into input.
   - Submit message until application is confirmed.
4. If daily quota is hit: Halt run and record quota limit.

## Step 4: Record in Tracking Files
Save the job details to:
- `data/applied-jobs.json`
- `data/applied-jobs.csv`
- `data/job-applications.xlsx`
- `data/tracker-cache.json`
