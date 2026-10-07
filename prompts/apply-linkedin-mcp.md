# Playwright MCP Prompt — Apply on LinkedIn

Follow these instructions when driving the browser through Playwright MCP to search, apply, and track LinkedIn jobs.

## Mode Selection
- **Headed Mode**: Use `playwright` server from `.mcp.json`. Required for first-time login, CAPTCHA, or visual verification.
- **Headless Mode**: Use `playwright-headless` server from `.mcp.json` for silent background execution once logged in.

## Step 1: Authentication Check
1. Navigate to `https://www.linkedin.com/feed/`.
2. Check if logged in. If on login page:
   - Fill email and password from `.env` (`LINKEDIN_EMAIL`, `LINKEDIN_PASSWORD`).
   - Click Sign in.
   - If a security checkpoint appears:
     - In headed mode: Alert the user to complete verification in the open window.
     - In headless mode: Report the checkpoint and ask user to switch to headed mode.

## Step 2: Search for Jobs
1. Navigate to:
   `https://www.linkedin.com/jobs/search/?keywords=Full%20Stack%20Developer&location=India&f_TPR=r604800&f_AL=true&sortBy=DD`
2. Extract all job cards on the page.
3. For each job card:
   - Check if the job URL already exists in `data/applied-jobs.json` or `data/tracker-cache.json`.
   - If it exists, SKIP the job.

## Step 3: Easy Apply Form Completion
1. Click on the job card and find the "Easy Apply" button.
2. If it is an external apply link:
   - Record the job in `data/applied-jobs.json` with status `"EXTERNAL"`.
   - Update `data/applied-jobs.csv` and `data/job-applications.xlsx`.
   - Continue to next job.
3. Click "Easy Apply".
4. Step through each modal screen:
   - Check and fill phone number if empty.
   - Attach resume from `resume/Manoj_Ambati_Resume_v3.pdf` if requested.
   - Answer screening questions using `prompts/candidate-facts.md` (2 years experience for Java, Spring Boot, React, Node, etc.; 4.2 current CTC, 10 expected CTC, immediate joiner).
   - Click "Next" or "Review".
   - Uncheck "Follow company" on final step.
   - Click "Submit application".
5. Confirm "Application submitted" dialog and dismiss it.

## Step 4: Record in Tracking Files
Append the result to:
- `data/applied-jobs.json`
- `data/applied-jobs.csv`
- `data/job-applications.xlsx` (Sheet: Applied)
- `data/tracker-cache.json`
