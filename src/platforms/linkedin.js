/**
 * linkedin.js
 * LinkedIn Job Auto-Apply workflow module.
 *
 * Supports:
 *  - Headed & Headless execution
 *  - Easy Apply modal automation & screening question answering
 *  - External company site detection & logging
 *  - Real-time file-based tracking (JSON, CSV, Excel)
 */

const fs = require('fs');
const path = require('path');
const config = require('../../config');
const tracker = require('../tracker/file-tracker');

const BLACKLIST_TITLE_REGEX = /(?:\b(python|django|flask|fastapi|pandas|pyspark|dot\s*net|dotnet|\.net|c#|c\+\+|php|laravel|wordpress|ruby|rails|golang|go\s*developer|rust|ios|swift|objective-c|android|flutter|react\s*native|mobile\s*developer|qa\b|tester|testing|automation\s*test|sdet|devops|sre|cloud\s*engineer|aws\s*engineer|azure\s*engineer|salesforce|sap\b|mainframe|data\s*engineer|data\s*scientist|data\s*analyst|machine\s*learning|ai\s*engineer|deep\s*learning|nlp|computer\s*vision|big\s*data|etl|business\s*analyst|scrum\s*master|product\s*manager|sales|marketing|recruiter|hr\b|intern|internship|trainee|caller|telecaller|bpo|kpo|support)\b)/i;
const WHITELIST_TITLE_REGEX = /\b(java\s*(?:developer|full\s*stack|backend|engineer|software)|spring\s*boot|full\s*stack|fullstack|node(?:\.js|\s*js)?\s*(?:developer|backend|engineer|software)|react(?:\.js|\s*js)?\s*(?:developer|full\s*stack|engineer)|mern\s*(?:stack|developer)|software\s*engineer.*(?:java|node|react|full\s*stack)|software\s*developer.*(?:java|node|react|full\s*stack))\b/i;

class LinkedInApplicant {
  constructor(browserManager, options = {}) {
    this.browserManager = browserManager;
    this.options = {
      limit: options.limit || config.search.targetApplications,
      headless: options.headless !== undefined ? options.headless : config.browser.isHeadless,
      keywords: options.keywords || config.search.keywords,
      locations: options.locations || config.search.locations,
      freshness: options.freshness || config.search.freshness,
    };
    this.candidate = config.candidate;
    this.creds = config.credentials.linkedin;
    this.resumePath = config.paths.resume;
  }

  sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  isTargetJob(title) {
    if (!title) return false;
    if (BLACKLIST_TITLE_REGEX.test(title)) return false;
    return WHITELIST_TITLE_REGEX.test(title);
  }

  async ensureLoggedIn(page) {
    console.log('[LinkedIn] Checking login status...');
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
    await this.sleep(3000);

    if (page.url().includes('/feed') || page.url().includes('/mynetwork')) {
      console.log('[LinkedIn] Session is already authenticated.');
      return;
    }

    console.log('[LinkedIn] Session not active, navigating to login...');
    await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 35000 });
    await this.sleep(2000);

    const emailInput = page.locator('input[type="email"], input#username').last();
    const passInput = page.locator('input[type="password"], input#password').last();

    if (await emailInput.count() > 0) {
      await emailInput.fill(this.creds.email);
      await passInput.fill(this.creds.password);
      await this.sleep(1000);

      const signInBtn = page.locator('button:has-text("Sign in"), button[type="submit"]').last();
      await signInBtn.click();
      await this.sleep(5000);
    }

    if (page.url().includes('/checkpoint') || page.url().includes('/challenge')) {
      console.log('⚠️ [LinkedIn] Security checkpoint/CAPTCHA/OTP detected!');
      if (!this.options.headless) {
        console.log('👉 Browser is open in HEADED mode. Please complete the verification in the browser window now...');
        for (let i = 0; i < 30; i++) {
          await this.sleep(3000);
          if (page.url().includes('/feed') || page.url().includes('/mynetwork') || page.url().includes('/jobs')) {
            console.log('[LinkedIn] Checkpoint cleared successfully!');
            break;
          }
        }
      } else {
        console.warn('⚠️ Running in HEADLESS mode with a checkpoint. Switch to HEADED mode to verify your session.');
      }
    }

    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
    await this.sleep(3000);

    if (!page.url().includes('/feed') && !page.url().includes('/mynetwork') && !page.url().includes('/jobs')) {
      throw new Error('[LinkedIn] Login failed. Please verify credentials in .env or run with --mode headed to solve challenge.');
    }
    console.log('[LinkedIn] Successfully logged in.');
  }

  buildSearchUrls() {
    const urls = [];
    for (const kw of this.options.keywords) {
      for (const loc of this.options.locations) {
        const encKw = encodeURIComponent(kw);
        const encLoc = encodeURIComponent(loc);
        // Dedicated Easy Apply search URL
        urls.push(`https://www.linkedin.com/jobs/search/?keywords=${encKw}&location=${encLoc}&f_TPR=${this.options.freshness}&f_AL=true&sortBy=DD`);
      }
    }
    return urls;
  }

  async handleEasyApplyModal(page) {
    const modalSelector = '.jobs-easy-apply-modal';
    try {
      await page.waitForSelector(modalSelector, { timeout: 8000 });
    } catch {
      return { status: 'no_modal' };
    }

    const candidate = this.candidate;
    const maxSteps = 12;

    for (let step = 1; step <= maxSteps; step++) {
      await this.sleep(1500);
      const modal = page.locator(modalSelector).first();
      if (await modal.count() === 0) break;

      // 1. Phone input check
      const phoneInput = modal.locator('input[type="text"][id*="phoneNumber"], input[type="tel"]').first();
      if (await phoneInput.count() > 0) {
        const val = await phoneInput.inputValue();
        if (!val || val.trim() === '') {
          await phoneInput.fill(candidate.identity.phone);
          await this.sleep(300);
        }
      }

      // 2. Resume input check
      const fileInput = modal.locator('input[type="file"]').first();
      if (await fileInput.count() > 0 && fs.existsSync(this.resumePath)) {
        const radioSelected = (await modal.locator('input[type="radio"]:checked').count()) > 0;
        if (!radioSelected) {
          try {
            await fileInput.setInputFiles(this.resumePath);
            console.log('  [LinkedIn] Uploaded resume PDF');
            await this.sleep(1500);
          } catch {
            // ignore if not needed
          }
        }
      }

      // 3. Question Form Elements (Radios, Selects, Inputs)
      await page.evaluate((cand) => {
        function resolveAnswer(label, opts = []) {
          const t = (label || '').toLowerCase();
          if (/serving.*notice/.test(t)) return 'No';
          if (/offer.*in\s*hand/.test(t)) return 'No';
          if (/notice\s*period|\bnp\b|mention in days/i.test(t)) {
            if (opts.some((o) => /immediate|0\s*days?/i.test(o))) return 'Immediate';
            return '0';
          }
          if (/years?.*(experience|exp).*(java)/.test(t)) return cand.skillYears.java;
          if (/years?.*(experience|exp).*(spring|spring boot)/.test(t)) return cand.skillYears['spring boot'];
          if (/years?.*(experience|exp).*(react)/.test(t)) return cand.skillYears.react;
          if (/years?.*(experience|exp).*(node|nodejs|express)/.test(t)) return cand.skillYears.node;
          if (/years?.*(experience|exp).*(sql|mysql)/.test(t)) return cand.skillYears.mysql;
          if (/years?.*(experience|exp).*(aws)/.test(t)) return cand.skillYears.aws;
          if (/years?.*(experience|exp)/.test(t)) return cand.currentEmployment.totalExperienceYears;

          if (/(current|present).*(ctc|salary|package|pay)/.test(t)) return cand.compensationAndNotice.currentCtcLakhs;
          if (/(expected|expecting).*(ctc|salary|package|pay)/.test(t)) return cand.compensationAndNotice.expectedCtcLakhs;
          if (/\bctc\b/i.test(t)) return cand.compensationAndNotice.currentCtcLakhs;

          if (/authorized|legally.*authorized|work.*authorization/i.test(t)) return 'Yes';
          if (/sponsorship|visa.*sponsor/i.test(t)) return 'No';
          if (/relocate|relocation|relocating|willing.*relocate|open to relocate|ready to relocate|location preference/i.test(t)) return 'Yes';
          if (/hybrid|on-site|office|work from/i.test(t)) return 'Yes';
          if (/immediate|join.*immediately/i.test(t)) return 'Yes';
          if (/^(are you|do you|can you|will you|have you|is it|would you)/i.test(t)) return 'Yes';
          return 'Yes';
        }

        const m = document.querySelector('.jobs-easy-apply-modal');
        if (!m) return;

        const elements = Array.from(m.querySelectorAll('.jobs-easy-apply-form-section__grouping, .fb-form-element, [class*="form-element"]'));
        for (const el of elements) {
          const label = el.querySelector('label, .fb-form-element-label, legend, span[aria-hidden="true"]')?.innerText?.trim() || '';
          if (!label) continue;

          // Radio options
          const radios = Array.from(el.querySelectorAll('input[type="radio"]'));
          if (radios.length > 0) {
            const expectedAns = resolveAnswer(label);
            const target = radios.find((r) => {
              const rLbl = r.closest('label')?.innerText?.trim().toLowerCase() || r.value.toLowerCase();
              return rLbl.includes(expectedAns.toLowerCase());
            });
            if (target) {
              target.checked = true;
              target.click();
              target.dispatchEvent(new Event('input', { bubbles: true }));
              target.dispatchEvent(new Event('change', { bubbles: true }));
            }
            continue;
          }

          // Select dropdown
          const sel = el.querySelector('select');
          if (sel) {
            const opts = Array.from(sel.options).map((o) => o.text.trim());
            const expectedAns = resolveAnswer(label, opts);
            const match = Array.from(sel.options).find((o) => o.text.toLowerCase().includes(expectedAns.toLowerCase()));
            if (match && sel.value !== match.value) {
              sel.value = match.value;
              sel.dispatchEvent(new Event('change', { bubbles: true }));
            }
            continue;
          }

          // Text / Number input
          const inp = el.querySelector('input[type="text"], input[type="number"], textarea');
          if (inp && (!inp.value || inp.value.trim() === '')) {
            const expectedAns = resolveAnswer(label);
            inp.focus();
            inp.value = expectedAns;
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            inp.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
      }, candidate);

      await this.sleep(800);

      // Check for Submit button
      const submitBtn = modal.locator('button:has-text("Submit application")').first();
      if ((await submitBtn.count()) > 0 && (await submitBtn.isVisible().catch(() => false))) {
        const followCb = modal.locator('input[type="checkbox"][id*="follow"]').first();
        if ((await followCb.count()) > 0 && (await followCb.isChecked().catch(() => false))) {
          await followCb.uncheck().catch(() => {});
        }

        console.log('  [LinkedIn] Submitting application...');
        await submitBtn.click({ force: true, timeout: 8000 }).catch(() => {});
        await this.sleep(3500);

        const doneBtn = page.locator('button:has-text("Done"), button[aria-label="Dismiss"]').first();
        if ((await doneBtn.count()) > 0) {
          await doneBtn.click({ force: true }).catch(() => {});
        }
        return { status: 'applied', notes: 'LinkedIn Easy Apply submitted' };
      }

      // Check for Review button
      const reviewBtn = modal.locator('button:has-text("Review")').first();
      if ((await reviewBtn.count()) > 0 && (await reviewBtn.isVisible().catch(() => false))) {
        await reviewBtn.click({ force: true, timeout: 6000 }).catch(() => {});
        await this.sleep(1000);
        continue;
      }

      // Check for Next button
      const nextBtn = modal.locator('button:has-text("Next"), button[aria-label*="Continue to next step"]').first();
      if ((await nextBtn.count()) > 0 && (await nextBtn.isVisible().catch(() => false))) {
        const clicked = await nextBtn.click({ force: true, timeout: 6000 }).then(() => true).catch(() => false);
        if (!clicked) {
          await page.evaluate(() => {
            const btn = document.querySelector('.jobs-easy-apply-modal button[data-easy-apply-next-button], .jobs-easy-apply-modal button.artdeco-button--primary');
            if (btn) btn.click();
          }).catch(() => {});
        }
        await this.sleep(1000);
        continue;
      }

      break;
    }

    // Dismiss modal if stuck or cannot proceed
    const dismiss = page.locator('.jobs-easy-apply-modal button[aria-label="Dismiss"]').first();
    if ((await dismiss.count()) > 0) {
      await dismiss.click({ force: true }).catch(() => {});
      await this.sleep(500);
      const discardBtn = page.locator('button:has-text("Discard")').first();
      if ((await discardBtn.count()) > 0) {
        await discardBtn.click({ force: true }).catch(() => {});
      }
    }

    return { status: 'skipped', notes: 'Easy Apply modal could not complete (complex multi-step questions)' };
  }

  async run() {
    console.log(`\n======================================================`);
    console.log(`🚀 Starting LinkedIn Auto-Apply`);
    console.log(`Target: ${this.options.limit} applications`);
    console.log(`Mode:   ${this.options.headless ? 'HEADLESS' : 'HEADED'}`);
    console.log(`======================================================\n`);

    const { context, page } = await this.browserManager.launch({ headless: this.options.headless });
    let appliedCount = 0;

    try {
      await this.ensureLoggedIn(page);
      const searchUrls = this.buildSearchUrls();

      for (const searchUrl of searchUrls) {
        if (appliedCount >= this.options.limit) break;

        console.log(`\n[LinkedIn] Navigating to search: ${searchUrl}`);
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
        await this.sleep(3000);

        // Collect jobs on page
        const jobCards = await page.evaluate(() => {
          const links = Array.from(document.querySelectorAll('a.job-card-list__title, a[href*="/jobs/view/"], .job-card-container__link'));
          return links.map((a) => {
            const container = a.closest('.job-card-container, [data-job-id]') || a.parentElement?.parentElement;
            const textOf = (sel) => container?.querySelector(sel)?.innerText?.trim() || '';
            return {
              title: a.innerText.trim(),
              url: a.href,
              company: textOf('.job-card-container__primary-description, [class*="company-name"]') || 'Unknown',
              location: textOf('.job-card-container__metadata-item, [class*="metadata-item"]') || 'India',
            };
          }).filter((j) => j.title && j.url);
        });

        console.log(`[LinkedIn] Found ${jobCards.length} job cards on current search page.`);

        for (const job of jobCards) {
          if (appliedCount >= this.options.limit) break;

          // 1. Deduplication check via FileTracker
          if (tracker.has(job.url)) {
            console.log(`  ⏩ Skipping [Already in Tracker]: ${job.title} at ${job.company}`);
            continue;
          }

          // 2. Title filter
          if (!this.isTargetJob(job.title)) {
            tracker.recordSkipped({
              platform: 'LinkedIn',
              title: job.title,
              company: job.company,
              location: job.location,
              applyUrl: job.url,
              notes: 'Job title not matching whitelist target',
            });
            continue;
          }

          console.log(`\n👉 Processing: ${job.title} | ${job.company} (${job.location})`);
          try {
            await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await this.sleep(2500);

            // Check for Easy Apply button
            const applyBtn = page.locator('button.jobs-apply-button').first();
            if ((await applyBtn.count()) === 0) {
              console.log('  ⚠️ No Easy Apply button found. Checking for external apply...');
              const extBtn = page.locator('button[class*="apply-button"], a[class*="apply-button"]').first();
              if ((await extBtn.count()) > 0) {
                tracker.recordExternal({
                  platform: 'LinkedIn',
                  title: job.title,
                  company: job.company,
                  location: job.location,
                  applyUrl: job.url,
                  externalUrl: job.url,
                  notes: 'External company site apply',
                });
                tracker.save();
              } else {
                tracker.recordSkipped({
                  platform: 'LinkedIn',
                  title: job.title,
                  company: job.company,
                  location: job.location,
                  applyUrl: job.url,
                  notes: 'No apply button found',
                });
                tracker.save();
              }
              continue;
            }

            // Click Easy Apply
            await applyBtn.click({ force: true });
            await this.sleep(2000);

            const result = await this.handleEasyApplyModal(page);
            console.log(`  Result: [${result.status.toUpperCase()}] ${result.notes || ''}`);

            if (result.status === 'applied') {
              appliedCount++;
              tracker.recordApplied({
                platform: 'LinkedIn',
                title: job.title,
                company: job.company,
                location: job.location,
                applyUrl: job.url,
                notes: result.notes,
              });
            } else {
              tracker.recordSkipped({
                platform: 'LinkedIn',
                title: job.title,
                company: job.company,
                location: job.location,
                applyUrl: job.url,
                notes: result.notes,
              });
            }
          } catch (jobErr) {
            console.warn(`  ⚠️ Job processing error on ${job.title}: ${jobErr.message}`);
            tracker.recordFailed({
              platform: 'LinkedIn',
              title: job.title,
              company: job.company,
              location: job.location,
              applyUrl: job.url,
              notes: `Job error: ${jobErr.message}`,
            });
          }

          // Save tracking data to files immediately after each job
          tracker.save();
          await this.sleep(2000);
        }
      }
    } catch (err) {
      console.error('[LinkedIn] Execution error:', err.message);
    } finally {
      tracker.save();
      await this.browserManager.close();
      console.log(`\nLinkedIn run completed. New applies: ${appliedCount}`);
    }

    return appliedCount;
  }
}

module.exports = LinkedInApplicant;
