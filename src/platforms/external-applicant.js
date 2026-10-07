/**
 * src/platforms/external-applicant.js
 * Multi-ATS External Job Application Engine
 *
 * FULL SMART FLOW:
 *  1. Navigate to external company career site
 *  2. Click initial Apply / Apply Now button
 *  3. Detect: login form | signup form | application form | already applied
 *  4. If signup needed → create account with candidate email + password
 *  5. Handle email verification:
 *       a. OTP code → fetch from Gmail API → fill + submit
 *       b. Magic link → fetch URL from Gmail API → navigate to it
 *  6. After auth, fill multi-step application form:
 *       - Upload resume (PDF)
 *       - Autofill name, email, phone, address, education, experience
 *       - Answer radio/checkbox/select screening questions
 *       - Handle CAPTCHA (wait 20s in headed mode)
 *  7. Submit and verify confirmation text
 *  8. Return accurate status: 'applied' | 'external_visited' | 'skipped' | 'failed'
 *
 * Supports: Workday, Greenhouse, Lever, SmartRecruiters, Taleo, SuccessFactors, Generic
 */

const fs = require('fs');
const path = require('path');
const config = require('../../config');
const tracker = require('../tracker/file-tracker');
const { fetchLatestOtp, fetchVerificationLink } = require('../utils/gmail-otp-helper');
const { askAiForNextAction, executeAiAction } = require('../utils/ai-vision-agent');

// ─── Filters ─────────────────────────────────────────────────────────────────
const BLACKLIST_TITLE_REGEX = /(?:\b(python|django|flask|fastapi|pandas|pyspark|dot\s*net|dotnet|\.net|c#|c\+\+|php|laravel|wordpress|ruby|rails|golang|go\s*developer|rust|ios|swift|objective-c|android|flutter|react\s*native|mobile\s*developer|qa\b|tester|testing|automation\s*test|sdet|devops|sre|cloud\s*engineer|aws\s*engineer|azure\s*engineer|salesforce|sap\b|mainframe|data\s*engineer|data\s*scientist|data\s*analyst|machine\s*learning|ai\s*engineer|deep\s*learning|nlp|computer\s*vision|big\s*data|etl|business\s*analyst|scrum\s*master|product\s*manager|sales|marketing|recruiter|hr\b|intern|internship|trainee|caller|telecaller|bpo|kpo|support)\b)/i;
const WHITELIST_TITLE_REGEX = /\b(java\s*(?:developer|full\s*stack|backend|engineer|software)|spring\s*boot|full\s*stack|fullstack|node(?:\.js|\s*js)?\s*(?:developer|backend|engineer|software)|react(?:\.js|\s*js)?\s*(?:developer|full\s*stack|engineer)|mern\s*(?:stack|developer)|software\s*engineer.*(?:java|node|react|full\s*stack)|software\s*developer.*(?:java|node|react|full\s*stack))\b/i;
const BLACKLIST_COMPANY_REGEX = /\b(infosys|infosys\s*bpm|infosys\s*limited)\b/i;

// ─── Success confirmation text patterns ───────────────────────────────────────
const SUCCESS_TEXTS = [
  /application\s*submitted/i,
  /thank\s*you\s*for\s*applying/i,
  /successfully\s*applied/i,
  /application\s*(?:has\s*been\s*)?(?:received|sent|submitted)/i,
  /we\s*(?:have\s*)?received\s*your\s*application/i,
  /congratulations/i,
  /your\s*application\s*is\s*(?:complete|submitted)/i,
  /you\s*have\s*applied/i,
  /application\s*complete/i,
];

function isSuccessPage(text) {
  return SUCCESS_TEXTS.some((p) => p.test(text));
}

function isBlacklistedCompany(company = '', title = '', url = '') {
  const text = `${company || ''} ${title || ''} ${url || ''}`.toLowerCase();
  if (BLACKLIST_COMPANY_REGEX.test(text)) return true;
  const list = config.search?.blacklistedCompanies || ['infosys'];
  return list.some((c) => text.includes(c.toLowerCase()));
}

// ─── Class ────────────────────────────────────────────────────────────────────
class ExternalApplicant {
  constructor() {
    this.candidate = config.candidate;
    this.resumePath = this.resolveResumePath();
    // Password to use for external site accounts
    this.accountPassword = process.env.NAUKRI_PASSWORD || 'Manoj@2469';
  }

  sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  resolveResumePath() {
    const envPath = process.env.RESUME_FILE ? path.resolve(__dirname, '../../', process.env.RESUME_FILE) : null;
    
    const candidates = [
      envPath,
      path.resolve(__dirname, '../../resume/Manoj_Ambati_Resume_v3.pdf'),
      path.resolve(__dirname, '../../resume/Manoj_Ambati_Resume_v2.pdf'),
      path.resolve(__dirname, '../../resume/Manoj_Ambati_Resume.pdf'),
    ].filter(Boolean); // removes null if envPath wasn't set

    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return candidates[1] || candidates[0]; // fallback
  }

  // ── ATS Detection ───────────────────────────────────────────────────────────
  detectAts(url, html = '') {
    const u = (url || '').toLowerCase();
    const h = (html || '').toLowerCase();
    if (u.includes('myworkdayjobs.com') || u.includes('workday') || h.includes('workday')) return 'workday';
    if (u.includes('greenhouse.io') || h.includes('gh-btn') || h.includes('greenhouse')) return 'greenhouse';
    if (u.includes('lever.co') || h.includes('lever-jobs')) return 'lever';
    if (u.includes('smartrecruiters.com') || h.includes('smartrecruiters')) return 'smartrecruiters';
    if (u.includes('ashbyhq.com') || h.includes('ashby')) return 'ashby';
    if (u.includes('taleo') || h.includes('taleo')) return 'taleo';
    if (u.includes('successfactors') || h.includes('successfactors')) return 'successfactors';
    if (u.includes('icims.com') || h.includes('icims')) return 'icims';
    if (u.includes('brassring') || h.includes('brassring')) return 'brassring';
    if (u.includes('jobvite') || h.includes('jobvite')) return 'jobvite';
    if (u.includes('bamboohr') || h.includes('bamboohr')) return 'bamboohr';
    return 'generic';
  }

  // ── Screen State Analysis ───────────────────────────────────────────────────
  /**
   * Analyse the current page to understand what screen we're on.
   * Returns one of: 'success' | 'already_applied' | 'login' | 'signup' |
   *                 'otp' | 'email_verification' | 'form' | 'apply_button' | 'unknown'
   */
  async analyseScreen(page) {
    try {
      return await page.evaluate(() => {
        const text = (document.body?.innerText || '').toLowerCase();
        const html = document.body?.innerHTML || '';

        // ── Success ──────────────────────────────────────────────────────
        if (
          /application\s*submitted|thank\s*you\s*for\s*applying|successfully\s*applied|application\s*received|application\s*complete|you\s*have\s*applied|congratulations/i.test(text)
        ) return 'success';

        // ── Already applied ───────────────────────────────────────────────
        if (/already applied|you have already submitted|you already applied/i.test(text)) return 'already_applied';

        // ── Error States (Account Exists / Invalid Login) ─────────────────
        if (/(invalid|incorrect|wrong)\s*(password|credentials|email)/i.test(text)) return 'invalid_credentials';
        if (/(email|account)\s*(already exists|is already registered|already in use|taken)/i.test(text)) return 'login';

        // ── Google SSO / Social Login ─────────────────────────────────────
        if (/continue\s*with\s*google|sign\s*in\s*with\s*google|login\s*with\s*google/i.test(text)) {
          return 'google_sso';
        }

        // ── OTP / Verification code screen ────────────────────────────────
        if (
          /enter.{0,20}(otp|code|pin|verification)|one.time.password|verification code|verify your (email|account|identity)/i.test(text)
        ) {
          const hasCodeInput = !!(
            document.querySelector('input[name*="otp" i], input[name*="code" i], input[id*="otp" i], input[id*="code" i]') ||
            document.querySelector('input[type="number"][maxlength="6"], input[type="number"][maxlength="4"]')
          );
          if (hasCodeInput) return 'otp';
          return 'email_verification'; // magic link flow
        }

        // ── Email verification / confirm email ────────────────────────────
        if (
          /verify your email|check your (email|inbox)|we sent (a|an) (email|link|verification)|confirmation email|click the link/i.test(text)
        ) return 'email_verification';

        // ── Signup / Registration form ────────────────────────────────────
        if (
          (/create\s*(an\s*)?account|sign\s*up|register|join\s*us|new\s*user/i.test(text)) &&
          document.querySelector('input[type="password"], input[type="email"]')
        ) return 'signup';

        // ── Login form ────────────────────────────────────────────────────
        if (
          (/sign\s*in|log\s*in|login|enter\s*your\s*(email|password)/i.test(text)) &&
          document.querySelector('input[type="password"]')
        ) return 'login';

        // ── Application form ──────────────────────────────────────────────
        const formInputCount = document.querySelectorAll(
          'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea'
        ).length;
        if (formInputCount >= 2) return 'form';

        // ── Apply button visible ──────────────────────────────────────────
        const applyBtn = Array.from(document.querySelectorAll('button, a, div[role="button"]')).find((el) => {
          const t = (el.innerText || el.getAttribute('title') || '').trim();
          return /^apply(\s*now|\s*for\s*this\s*job|\s*with\s*resume)?$/i.test(t);
        });
        if (applyBtn) return 'apply_button';

        return 'unknown';
      });
    } catch {
      return 'unknown';
    }
  }

  // ── Apply from Naukri page ──────────────────────────────────────────────────
  async applyFromNaukri(context, naukriPage, job) {
    if (isBlacklistedCompany(job.company, job.title, job.url)) {
      return { status: 'skipped', notes: `Excluded company: ${job.company} (blacklisted)` };
    }

    console.log(`  [External] Resolving external portal for: ${job.title} @ ${job.company}`);
    let externalUrl = '';

    try {
      // 1. Try to read direct href from the "Apply on company site" button
      externalUrl = await naukriPage.evaluate(() => {
        const btn = document.getElementById('company-site-button') ||
          Array.from(document.querySelectorAll('a, button, div, span')).find((el) =>
            /apply on company site|apply on website|company site|external site/i.test(
              el.innerText || el.getAttribute('title') || ''
            )
          );
        if (btn) {
          const href = btn.href || btn.getAttribute('href') || btn.getAttribute('data-href') || '';
          if (href && href.startsWith('http') && !href.includes('javascript:') && !href.includes('naukri.com/job-listings')) {
            return href;
          }
        }
        return '';
      }).catch(() => '');

      // 2. Click the button to capture popup or navigation
      const popupPromise = context.waitForEvent('page', { timeout: 8000 }).catch(() => null);
      await naukriPage.evaluate(() => {
        const btn = document.getElementById('company-site-button') ||
          Array.from(document.querySelectorAll('a, button, div, span')).find((el) =>
            /apply on company site|apply on website|company site|external site/i.test(
              el.innerText || el.getAttribute('title') || ''
            )
          );
        btn?.click();
      }).catch(() => {});

      const popup = await popupPromise;
      if (popup) {
        try {
          await popup.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
          await this.sleep(1500);
          const popupUrl = popup.url();
          if (popupUrl && popupUrl !== 'about:blank') externalUrl = popupUrl;
          await popup.close().catch(() => {});
        } catch {}
      }

      // 3. Check if the Naukri page itself navigated away
      await this.sleep(1500);
      if (!naukriPage.url().includes('naukri.com')) {
        externalUrl = naukriPage.url();
      }

      if (!externalUrl || externalUrl === 'about:blank' || externalUrl.includes('naukri.com/job-listings')) {
        return { status: 'external', externalUrl: job.url, notes: 'Could not resolve external application URL' };
      }

      console.log(`  [External] Navigating to: ${externalUrl}`);
      if (naukriPage.url() !== externalUrl) {
        await naukriPage.goto(externalUrl, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
        await this.sleep(3000);
      }

      const result = await this.executeApplication(naukriPage, job);
      console.log(`  [External] Done. Coming back to Naukri for next job...`);
      return { ...result, externalUrl };

    } catch (err) {
      console.log(`  [External] Error during external apply: ${err.message}`);
      return { status: 'failed', externalUrl: externalUrl || job.url, notes: `External apply error: ${err.message}` };
    }
  }

  // ── Direct URL apply ────────────────────────────────────────────────────────
  async applyDirectUrl(context, job) {
    const targetUrl = job.externalUrl || job.url;
    if (isBlacklistedCompany(job.company, job.title, targetUrl)) {
      return { status: 'skipped', externalUrl: targetUrl, notes: `Excluded company: ${job.company} (blacklisted)` };
    }

    console.log(`\n[External] Navigating to: ${job.title} @ ${job.company} (${targetUrl})`);
    const page = await context.newPage();
    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
      await this.sleep(3000);
      const result = await this.executeApplication(page, job);
      await page.close().catch(() => {});
      return { ...result, externalUrl: targetUrl };
    } catch (err) {
      console.log(`  [External] Direct apply error: ${err.message}`);
      await page.close().catch(() => {});
      return { status: 'failed', externalUrl: targetUrl, notes: `Error: ${err.message}` };
    }
  }

  // ── Main Application Engine ─────────────────────────────────────────────────
  /**
   * Smart application engine that:
   *  - Takes screenshots to understand current screen
   *  - Handles login / signup / OTP / email verification / form filling
   *  - Accurately returns confirmed status
   */
  async executeApplication(page, job) {
    const currentUrl = page.url();
    console.log('  [External] Saving external job for manual apply: ' + currentUrl);
    
    try {
        const extFile = 'data/external-jobs-to-apply.csv';
        if (!fs.existsSync('data')) fs.mkdirSync('data');
        if (!fs.existsSync(extFile)) {
            fs.writeFileSync(extFile, 'Job Title,Company,URL\n');
        }
        
        const safeTitle = (job.title || '').replace(/"/g, '""');
        const safeComp = (job.company || '').replace(/"/g, '""');
        fs.appendFileSync(extFile, '"' + safeTitle + '","' + safeComp + '","' + currentUrl + '"\n');
    } catch(e) {
        console.error('  [External] Failed to save external URL: ', e.message);
    }
    
    return { status: 'skipped', notes: 'Saved external URL for manual application' };
  }

  // ── Click Apply / Apply Now button ─────────────────────────────────────────
  async clickApplyButton(page) {
    return await page.evaluate(() => {
      const inputs = document.querySelectorAll('input:not([type="hidden"]), select, textarea');
      if (inputs.length >= 3) return false; // Already on form

      const btn = Array.from(document.querySelectorAll('button, a, div[role="button"], input[type="button"], input[type="submit"]'))
        .find((el) => {
          const t = (el.innerText || el.getAttribute('value') || el.getAttribute('title') || '').trim();
          return /^(apply|apply now|apply for this job|start application|apply with resume|i'm interested|begin application)$/i.test(t) ||
                 /apply now|apply for this|begin apply/i.test(t);
        });

      if (btn) {
        btn.click();
        return true;
      }
      return false;
    }).catch(() => false);
  }

  // ── Login ───────────────────────────────────────────────────────────────────
  async handleLogin(page) {
    const email = this.candidate.identity.email;
    const password = this.accountPassword;

    try {
      // Use Playwright fill for React/Angular forms
      const emailEl = page.locator('input[type="email"], input[name*="email" i], input[id*="email" i], input[placeholder*="email" i]').first();
      if (await emailEl.isVisible().catch(() => false)) {
        await emailEl.click();
        await emailEl.fill(email);
      }

      const passEl = page.locator('input[type="password"]').first();
      if (await passEl.isVisible().catch(() => false)) {
        await passEl.click();
        await passEl.fill(password);
      }

      // Check consent checkboxes
      await page.evaluate(() => {
        document.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
          if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
        });
      }).catch(() => {});

      // Click login button
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button, input[type="submit"]'))
          .find((b) => /sign\s*in|log\s*in|login|continue|next/i.test(b.innerText || b.value || ''));
        if (btn) btn.click();
      }).catch(() => {});

      await this.sleep(3000);
      console.log('  [External] Login credentials submitted.');
    } catch (err) {
      console.log(`  [External] Login error: ${err.message}`);
    }
  }

  // ── Signup / Account Creation ───────────────────────────────────────────────
  async handleSignup(page) {
    const cand = this.candidate;
    const email = cand.identity.email;
    const password = this.accountPassword;

    console.log(`  [External] Creating account with: ${email}`);

    try {
      // Fill first name
      const firstEl = page.locator('input[name*="first" i], input[id*="first" i], input[placeholder*="first" i]').first();
      if (await firstEl.isVisible().catch(() => false)) {
        await firstEl.click(); await firstEl.fill(cand.identity.firstName || 'Manoj');
      }

      // Fill last name
      const lastEl = page.locator('input[name*="last" i], input[id*="last" i], input[placeholder*="last" i]').first();
      if (await lastEl.isVisible().catch(() => false)) {
        await lastEl.click(); await lastEl.fill(cand.identity.lastName || 'Ambati');
      }

      // Fill email (all email fields)
      const emailEls = await page.$$('input[type="email"], input[name*="email" i], input[id*="email" i]');
      for (const el of emailEls) {
        if (await el.isVisible().catch(() => false)) {
          const current = await el.inputValue().catch(() => '');
          if (!current) { await el.click(); await el.fill(email); }
        }
      }

      // Fill password (both password fields for confirm-password)
      const passEls = await page.$$('input[type="password"]');
      for (const el of passEls) {
        if (await el.isVisible().catch(() => false)) {
          const current = await el.inputValue().catch(() => '');
          if (!current) { await el.click(); await el.fill(password); }
        }
      }

      // Fill phone if present
      const phoneEl = page.locator('input[type="tel"], input[name*="phone" i], input[id*="phone" i]').first();
      if (await phoneEl.isVisible().catch(() => false)) {
        const current = await phoneEl.inputValue().catch(() => '');
        if (!current) { await phoneEl.click(); await phoneEl.fill(cand.identity.phone || ''); }
      }

      // Check all consent/terms checkboxes
      await page.evaluate(() => {
        document.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
          const lbl = (cb.closest('label')?.innerText || cb.parentElement?.innerText || '').toLowerCase();
          if (/agree|terms|privacy|consent|condition/i.test(lbl)) {
            if (!cb.checked) { cb.checked = true; cb.click(); cb.dispatchEvent(new Event('change', { bubbles: true })); }
          }
        });
      }).catch(() => {});

      // Click signup / create account / register button
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button, input[type="submit"]'))
          .find((b) => /sign\s*up|create\s*account|register|submit|continue|join/i.test(b.innerText || b.value || ''));
        if (btn) btn.click();
      }).catch(() => {});

      await this.sleep(4000);
      console.log('  [External] Signup form submitted. Waiting for email verification...');
    } catch (err) {
      console.log(`  [External] Signup error: ${err.message}`);
    }
  }

  // ── OTP Verification ────────────────────────────────────────────────────────
  async handleOtpVerification(page) {
    console.log('  [External] Waiting 8s for OTP email to arrive...');
    await this.sleep(8000);

    const otp = await fetchLatestOtp(300); // search last 5 minutes
    if (!otp) {
      console.log('  [External] No OTP found in Gmail yet. Will retry on next iteration.');
      return;
    }

    console.log(`  [External] ✅ Got OTP: ${otp}. Entering into page...`);

    // Try to fill OTP using Playwright (handles React/Angular)
    try {
      const otpInputs = await page.$$('input[name*="otp" i], input[name*="code" i], input[id*="otp" i], input[id*="code" i], input[placeholder*="code" i], input[type="number"]');
      for (const inp of otpInputs) {
        if (await inp.isVisible().catch(() => false)) {
          await inp.click();
          await inp.fill(otp);
          break;
        }
      }
    } catch {}

    await this.sleep(1000);

    // Click verify / submit / confirm button
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button, input[type="submit"]'))
        .find((b) => /verify|confirm|submit|continue|validate/i.test(b.innerText || b.value || ''));
      if (btn) btn.click();
    }).catch(() => {});

    await this.sleep(3000);
  }

  // ── Email Magic Link Verification ───────────────────────────────────────────
  /**
   * Handles both:
   *  a. OTP code embedded in the email
   *  b. Magic "click to verify" link in the email
   *
   * @returns {boolean} true if verification was attempted
   */
  async handleEmailVerification(page) {
    console.log('  [External] Looking for verification link or OTP in Gmail...');

    // 1. Try magic/verification link first
    const link = await fetchVerificationLink(300);
    if (link) {
      console.log(`  [External] 🔗 Clicking verification link from Gmail...`);
      try {
        await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await this.sleep(3000);
        console.log('  [External] ✅ Navigated to verification link.');
        return true;
      } catch (err) {
        console.log(`  [External] Error navigating verification link: ${err.message}`);
      }
    }

    // 2. Try OTP code
    const otp = await fetchLatestOtp(300);
    if (otp) {
      console.log(`  [External] ✅ Found OTP ${otp} — trying to fill it...`);
      try {
        const otpInputs = await page.$$('input[type="text"], input[type="number"], input[name*="code" i], input[id*="code" i]');
        for (const inp of otpInputs) {
          if (await inp.isVisible().catch(() => false)) {
            await inp.click();
            await inp.fill(otp);
            break;
          }
        }
        await page.evaluate(() => {
          const btn = Array.from(document.querySelectorAll('button, input[type="submit"]'))
            .find((b) => /verify|confirm|submit|continue/i.test(b.innerText || b.value || ''));
          if (btn) btn.click();
        }).catch(() => {});
        await this.sleep(3000);
        return true;
      } catch (err) {
        console.log(`  [External] Error filling OTP: ${err.message}`);
      }
    }

    return false;
  }

  // ── Handle OTP if it appears mid-form ──────────────────────────────────────
  async handleOtpIfPresent(page) {
    const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    if (!/enter.{0,20}(otp|code|pin)|one.time.password|verification code/i.test(text)) return;
    console.log('  [External] OTP prompt detected mid-form. Fetching from Gmail...');
    await this.handleOtpVerification(page);
  }

  // ── Resume Upload ────────────────────────────────────────────────────────────
  async handleResumeUpload(page) {
    if (!this.resumePath || !fs.existsSync(this.resumePath)) {
      console.log('  [External] ⚠️ Resume file not found:', this.resumePath);
      return;
    }

    try {
      const fileInputs = await page.$$('input[type="file"]');
      let uploaded = false;
      for (const input of fileInputs) {
        // Try to set files even if hidden (many ATS hide the raw file input)
        try {
          await input.setInputFiles(this.resumePath);
          console.log(`  [External] 📎 Uploaded resume: ${path.basename(this.resumePath)}`);
          uploaded = true;
          await this.sleep(2500); // wait for upload processing
        } catch {}
      }
      if (!uploaded && fileInputs.length > 0) {
        console.log('  [External] File input found but upload failed (may need manual drag-drop).');
      }
    } catch (e) {
      console.log(`  [External] Resume upload error: ${e.message}`);
    }
  }

  // ── Autofill All Candidate Details (Playwright fill API) ────────────────────
  async autofillCandidateDetails(page) {
    const cand = this.candidate;
    const profile = {
      firstName: cand.identity?.firstName || 'Manoj',
      lastName: cand.identity?.lastName || 'Ambati',
      fullName: cand.identity?.name || 'Manoj Ambati',
      email: cand.identity?.email || '',
      phone: cand.identity?.phone || '',
      city: cand.identity?.city || 'Hyderabad',
      state: cand.identity?.state || 'Telangana',
      country: cand.identity?.country || 'India',
      postalCode: cand.identity?.postalCode || '500032',
      address: cand.identity?.address || 'Hyderabad, Telangana, India',
      linkedinUrl: cand.identity?.linkedinUrl || '',
      githubUrl: cand.identity?.githubUrl || '',
      portfolioUrl: cand.identity?.portfolioUrl || cand.identity?.githubUrl || '',
      company: cand.currentEmployment?.employer || 'Voltuswave Technologies',
      title: cand.currentEmployment?.title || 'Software Engineer',
      totalExp: String(cand.currentEmployment?.totalExperienceYears || '2.5'),
      currentCtc: String(cand.compensationAndNotice?.currentCtcLakhs || '4.2'),
      expectedCtc: String(cand.compensationAndNotice?.expectedCtcLakhs || '10'),
      noticePeriod: String(cand.compensationAndNotice?.noticePeriodDays || '0'),
      institution: cand.education?.institution || 'JNTU Hyderabad',
      degree: cand.education?.degree || 'B.Tech',
      discipline: cand.education?.branch || 'Computer Science',
      graduationYear: String(cand.education?.graduationYear || '2022'),
      gpa: String(cand.education?.gpa || '7.5'),
      summary: cand.currentEmployment?.summary || 'Java Full Stack Developer with 2.5 years experience in Spring Boot, Microservices, React.',
    };

    // Helper: fill a field using Playwright fill (works with React/Angular)
    const fill = async (selector, value) => {
      if (!value) return;
      try {
        const els = await page.$$(selector);
        for (const el of els) {
          if (!await el.isVisible().catch(() => false)) continue;
          const current = await el.inputValue().catch(() => '');
          const placeholder = await el.getAttribute('placeholder').catch(() => '');
          if (!current || current === placeholder) {
            await el.click({ force: true }).catch(() => {});
            await el.fill(String(value)).catch(async () => {
              // DOM fallback for edge cases
              await el.evaluate((node, val) => {
                node.value = val;
                node.dispatchEvent(new Event('input', { bubbles: true }));
                node.dispatchEvent(new Event('change', { bubbles: true }));
              }, String(value)).catch(() => {});
            });
          }
        }
      } catch {}
    };

    await fill('input[name*="first" i]:not([name*="fullstack" i]), input[id*="firstname" i], input[placeholder*="first name" i]', profile.firstName);
    await fill('input[name*="last" i]:not([name*="class" i]), input[id*="lastname" i], input[placeholder*="last name" i]', profile.lastName);
    await fill('input[name="name" i], input[id="name" i], input[placeholder*="full name" i]', profile.fullName);
    await fill('input[type="email"], input[name*="email" i], input[id*="email" i]', profile.email);
    await fill('input[type="tel"], input[name*="phone" i], input[id*="phone" i], input[name*="mobile" i]', profile.phone);
    await fill('input[name*="city" i]:not([name*="university" i]), input[id*="city" i]', profile.city);
    await fill('input[name*="state" i], input[id*="state" i]', profile.state);
    await fill('input[name*="zip" i], input[id*="zip" i], input[name*="postal" i], input[id*="postal" i]', profile.postalCode);
    await fill('input[name*="address" i]:not([name*="email" i]), input[id*="address" i]:not([id*="email" i])', profile.address);
    await fill('input[name*="linkedin" i], input[id*="linkedin" i], input[placeholder*="linkedin" i]', profile.linkedinUrl);
    await fill('input[name*="github" i], input[id*="github" i]', profile.githubUrl);
    await fill('input[name*="website" i], input[id*="website" i], input[name*="portfolio" i]', profile.portfolioUrl);
    await fill('input[name*="company" i], input[id*="company" i], input[name*="employer" i]', profile.company);
    await fill('input[name*="title" i]:not([name*="page" i]), input[id*="jobtitle" i], input[name*="designation" i]', profile.title);
    await fill('input[name*="experience" i]:not([name*="java" i]):not([name*="spring" i]), input[name*="exp" i]', profile.totalExp);
    await fill('input[name*="notice" i], input[id*="notice" i]', profile.noticePeriod);
    await fill('input[name*="current"][name*="ctc" i], input[name*="current"][name*="salary" i]', profile.currentCtc);
    await fill('input[name*="expected"][name*="ctc" i], input[name*="expected"][name*="salary" i]', profile.expectedCtc);
    await fill('input[name*="school" i], input[name*="college" i], input[name*="university" i], input[name*="institution" i]', profile.institution);
    await fill('input[name*="degree" i], input[id*="degree" i]', profile.degree);
    await fill('input[name*="discipline" i], input[name*="major" i], input[name*="branch" i]', profile.discipline);
    await fill('input[name*="graduation" i], input[name*="passout" i], input[name*="passyear" i]', profile.graduationYear);
    await fill('input[name*="gpa" i], input[name*="cgpa" i], input[name*="percentage" i]', profile.gpa);

    // Textareas (summary/cover letter)
    try {
      const tas = await page.$$('textarea');
      for (const ta of tas) {
        if (!await ta.isVisible().catch(() => false)) continue;
        const lbl = await ta.evaluate((el) => (el.name || el.id || el.placeholder || el.closest('label')?.innerText || '').toLowerCase()).catch(() => '');
        if (/summary|cover|about|description|message/i.test(lbl)) {
          const current = await ta.inputValue().catch(() => '');
          if (!current) await ta.fill(profile.summary).catch(() => {});
        }
      }
    } catch {}
  }

  // ── Screening Questions (Radios, Checkboxes, Selects) ────────────────────────
  async handleOptionsAndScreeningQuestions(page) {
    await page.evaluate(() => {
      // 1. Consent checkboxes
      Array.from(document.querySelectorAll('input[type="checkbox"]')).forEach((cb) => {
        const lbl = (cb.closest('label')?.innerText || cb.parentElement?.innerText || cb.name || cb.id || '').toLowerCase();
        if (/agree|consent|terms|privacy|policy|confirm|declare|certify|acknowledge|authorize/i.test(lbl)) {
          if (!cb.checked) { cb.checked = true; cb.click(); cb.dispatchEvent(new Event('change', { bubbles: true })); }
        }
      });

      // 2. Radio groups — answer based on question context (don't skip any group)
      const radioGroups = {};
      Array.from(document.querySelectorAll('input[type="radio"]')).forEach((r) => {
        const name = r.name || r.closest('fieldset')?.id || ('g' + Math.random());
        if (!radioGroups[name]) radioGroups[name] = [];
        radioGroups[name].push(r);
      });

      Object.values(radioGroups).forEach((group) => {
        const container = group[0]?.closest('fieldset, .form-group, [class*="question"], [class*="field"], [class*="row"], div') || document.body;
        const qText = (container?.innerText || '').toLowerCase();

        const pick = (matchFn) => {
          const target = group.find((r) => {
            const lbl = (r.closest('label')?.innerText || r.parentElement?.innerText || r.value || '').toLowerCase().trim();
            return matchFn(lbl, r.value?.toLowerCase() || '');
          });
          if (target && !target.checked) {
            target.checked = true;
            target.click();
            target.dispatchEvent(new Event('change', { bubbles: true }));
          }
        };

        if (/sponsorship|visa\s*sponsor/i.test(qText)) pick((l, v) => /^no\b/i.test(l) || v === 'no');
        else if (/authorized|legally\s*authorized|eligible\s*to\s*work|work\s*permit/i.test(qText)) pick((l, v) => /^yes\b/i.test(l) || v === 'yes');
        else if (/relocat/i.test(qText)) pick((l, v) => /^yes\b/i.test(l) || v === 'yes');
        else if (/notice\s*period|immediate|available\s*to\s*join/i.test(qText)) pick((l, v) => /^yes\b|immediate|^0/i.test(l) || v === 'yes');
        else if (/currently\s*employed|presently\s*employed/i.test(qText)) pick((l, v) => /^yes\b/i.test(l) || v === 'yes');
        else if (/gender/i.test(qText)) pick((l) => /^male$|prefer\s*not|decline/i.test(l));
        else if (/disability|disabled/i.test(qText)) pick((l, v) => /^no\b/i.test(l) || v === 'no');
        else if (/veteran/i.test(qText)) pick((l, v) => /^no\b|not a veteran/i.test(l) || v === 'no');
        else if (/are\s*you|do\s*you|can\s*you|will\s*you|have\s*you|would\s*you/i.test(qText)) pick((l, v) => /^yes\b/i.test(l) || v === 'yes');
      });

      // 3. Dropdowns
      Array.from(document.querySelectorAll('select')).forEach((sel) => {
        const opts = Array.from(sel.options);
        const labelEl = sel.id ? document.querySelector(`label[for="${sel.id}"]`) : null;
        const lbl = (labelEl?.innerText || sel.name || sel.id || sel.closest('label, .form-group, [class*="field"]')?.innerText || '').toLowerCase();

        const setOpt = (matchFn) => {
          const opt = opts.find(matchFn);
          if (opt && sel.value !== opt.value) {
            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set;
            if (nativeSetter) {
              nativeSetter.call(sel, opt.value);
            } else {
              sel.value = opt.value;
            }
            sel.dispatchEvent(new Event('change', { bubbles: true }));
          }
        };

        if (/country/i.test(lbl)) setOpt((o) => /^india$/i.test(o.text.trim()));
        else if (/notice/i.test(lbl)) setOpt((o) => /immediate|^0\s*days?$|^15\s*days?$/i.test(o.text.trim()));
        else if (/experience|exp\b/i.test(lbl)) {
          if (!sel.value || sel.selectedIndex <= 0) setOpt((o) => /2[\s-–to]+[34]|2\.5|2\+|^2\s*y/i.test(o.text.trim()));
        }
        else if (/relocat/i.test(lbl)) setOpt((o) => /^yes$/i.test(o.text.trim()));
        else if (/qualification|degree|education/i.test(lbl)) {
          if (!sel.value || sel.selectedIndex <= 0) setOpt((o) => /b\.?\s*tech|bachelor|b\.?\s*e\b/i.test(o.text));
        }
        else if (/gender/i.test(lbl)) setOpt((o) => /^male$/i.test(o.text.trim()));
        else if (/currency/i.test(lbl)) setOpt((o) => /inr|₹|indian/i.test(o.text));
      });
    }).catch(() => {});
  }

  // ── CAPTCHA Handler ──────────────────────────────────────────────────────────
  async handleCaptcha(page) {
    const hasCaptcha = await page.evaluate(() => !!(
      document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"]') ||
      document.querySelector('.g-recaptcha, .h-captcha, [class*="captcha" i], #captcha')
    )).catch(() => false);

    if (hasCaptcha) {
      console.log('  [External] ⚠️  CAPTCHA detected! Waiting up to 30s for user to solve in browser...');
      for (let i = 0; i < 10; i++) {
        await this.sleep(3000);
        const still = await page.evaluate(() => !!(
          document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"]') ||
          document.querySelector('.g-recaptcha, .h-captcha, [class*="captcha" i]')
        )).catch(() => false);
        if (!still) { console.log('  [External] ✅ CAPTCHA cleared!'); break; }
      }
    }
  }

  // ── Click Next or Submit ─────────────────────────────────────────────────────
  async clickNextOrSubmit(page) {
    return await page.evaluate(() => {
      const allBtns = Array.from(document.querySelectorAll('button, input[type="submit"], a[role="button"]'));

      // Priority 1: Submit / Apply button
      const submitBtn = allBtns.find((b) => {
        const t = (b.innerText || b.getAttribute('value') || '').trim();
        return /^(submit application|submit|apply now|complete application|send application|finish|done)$/i.test(t) ||
               /submit application|complete application|finish application/i.test(t);
      });
      if (submitBtn && !submitBtn.disabled) { submitBtn.click(); return 'submitted'; }

      // Priority 2: Next / Continue / Save and Continue
      const nextBtn = allBtns.find((b) => {
        const t = (b.innerText || b.getAttribute('value') || '').trim();
        return /^(save and continue|save & continue|continue|next|next step|proceed|go to next)$/i.test(t) ||
               /save.*continue|continue.*next/i.test(t);
      });
      if (nextBtn && !nextBtn.disabled) { nextBtn.click(); return 'next'; }

      // Priority 3: Any remaining forward button
      const forwardBtn = allBtns.find((b) => {
        const t = (b.innerText || '').trim();
        return /next|continue|proceed|forward|save/i.test(t) && !/back|cancel|skip|close/i.test(t);
      });
      if (forwardBtn && !forwardBtn.disabled) { forwardBtn.click(); return 'next'; }

      return 'none';
    }).catch(() => 'none');
  }

  // ── Batch Runner (for external jobs queue) ───────────────────────────────────
  async runBatch(browserManager, options = {}) {
    const limit = options.limit || config.search.targetApplications;
    const isHeadless = options.headless !== undefined ? options.headless : config.browser.isHeadless;

    console.log('\n======================================================');
    console.log('🚀 External Company Sites Auto-Apply Batch Runner');
    console.log(`Target: ${limit} applications`);
    console.log(`Mode:   ${isHeadless ? 'HEADLESS' : 'HEADED'}`);
    console.log(`Resume: ${path.basename(this.resumePath)}`);
    console.log('======================================================\n');

    tracker.init();

    // Collect external jobs from tracker
    let externalPool = [];
    if (fs.existsSync(config.paths.appliedJson)) {
      try { externalPool.push(...JSON.parse(fs.readFileSync(config.paths.appliedJson, 'utf8'))); } catch {}
    }

    const legacyExtPath = path.resolve(__dirname, '../../../playwright-mcp/backend/data/naukri-external-jobs.json');
    if (fs.existsSync(legacyExtPath)) {
      try { externalPool.push(...JSON.parse(fs.readFileSync(legacyExtPath, 'utf8'))); } catch {}
    }

    const seenUrls = new Set();
    const eligibleJobs = [];
    for (const j of externalPool) {
      const extUrl = (j.externalUrl && !j.externalUrl.includes('naukri.com')) ? j.externalUrl : null;
      const targetUrl = extUrl || j.externalUrl || j.applyUrl || j.url;
      if (!targetUrl || seenUrls.has(targetUrl)) continue;
      seenUrls.add(targetUrl);
      if (BLACKLIST_TITLE_REGEX.test(j.title || '')) continue;
      if (!WHITELIST_TITLE_REGEX.test(j.title || '')) continue;
      if (isBlacklistedCompany(j.company, j.title, targetUrl)) continue;
      if (tracker.getStatus(targetUrl) === 'APPLIED') continue;
      eligibleJobs.push({
        title: j.title,
        company: j.company || 'External Employer',
        location: j.location || 'India',
        url: j.applyUrl || j.url || targetUrl,
        externalUrl: targetUrl,
        isNaukriListing: targetUrl.includes('naukri.com'),
      });
    }

    console.log(`Found ${eligibleJobs.length} eligible external jobs.`);
    if (!eligibleJobs.length) return 0;

    let appliedCount = 0;
    const context = await browserManager.getPersistentContext({ headless: isHeadless });

    try {
      for (const job of eligibleJobs) {
        if (appliedCount >= limit) break;
        console.log(`\n👉 External [${appliedCount + 1}]: ${job.title} | ${job.company}`);

        try {
          let result;
          if (job.isNaukriListing) {
            const tempPage = await context.newPage();
            await tempPage.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            result = await this.applyFromNaukri(context, tempPage, job);
            await tempPage.close().catch(() => {});
          } else {
            result = await this.applyDirectUrl(context, job);
          }

          console.log(`  → [${result.status.toUpperCase()}] ${result.notes || ''}`);

          if (result.status === 'applied') {
            appliedCount++;
            tracker.recordApplied({ platform: 'EXTERNAL', title: job.title, company: job.company, location: job.location, applyUrl: job.url, externalUrl: job.externalUrl, notes: result.notes });
          } else if (result.status === 'already_applied') {
            tracker.recordSkipped({ platform: 'EXTERNAL', title: job.title, company: job.company, location: job.location, applyUrl: job.url, notes: result.notes || 'Already applied' });
          } else if (result.status === 'external_visited') {
            tracker.recordExternal({ platform: 'EXTERNAL', title: job.title, company: job.company, location: job.location, applyUrl: job.url, externalUrl: job.externalUrl, notes: result.notes });
          } else {
            tracker.recordFailed({ platform: 'EXTERNAL', title: job.title, company: job.company, location: job.location, applyUrl: job.url, notes: result.notes || 'Failed' });
          }
        } catch (jobErr) {
          console.warn(`  ⚠️  Error: ${jobErr.message}`);
          tracker.recordFailed({ platform: 'EXTERNAL', title: job.title, company: job.company, location: job.location, applyUrl: job.url, notes: `Error: ${jobErr.message}` });
        }

        tracker.save();
        await this.sleep(2000);
      }
    } finally {
      await browserManager.closeContext().catch(() => {});
    }

    console.log(`\nExternal batch complete. Applied: ${appliedCount}`);
    return appliedCount;
  }
}

const externalApplicantInstance = new ExternalApplicant();
module.exports = externalApplicantInstance;
module.exports.ExternalApplicant = ExternalApplicant;
