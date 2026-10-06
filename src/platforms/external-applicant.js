/**
 * src/platforms/external-applicant.js
 * Multi-ATS External Job Application Engine
 *
 * Automates applying to external company career sites (Workday, Greenhouse,
 * Lever, SmartRecruiters, Ashby, Taleo, and generic career portals).
 */

const fs = require('fs');
const path = require('path');
const config = require('../../config');
const tracker = require('../tracker/file-tracker');
const { fetchLatestOtp } = require('../utils/gmail-otp-helper');

const BLACKLIST_TITLE_REGEX = /(?:\b(python|django|flask|fastapi|pandas|pyspark|dot\s*net|dotnet|\.net|c#|c\+\+|php|laravel|wordpress|ruby|rails|golang|go\s*developer|rust|ios|swift|objective-c|android|flutter|react\s*native|mobile\s*developer|qa\b|tester|testing|automation\s*test|sdet|devops|sre|cloud\s*engineer|aws\s*engineer|azure\s*engineer|salesforce|sap\b|mainframe|data\s*engineer|data\s*scientist|data\s*analyst|machine\s*learning|ai\s*engineer|deep\s*learning|nlp|computer\s*vision|big\s*data|etl|business\s*analyst|scrum\s*master|product\s*manager|sales|marketing|recruiter|hr\b|intern|internship|trainee|caller|telecaller|bpo|kpo|support)\b)/i;
const WHITELIST_TITLE_REGEX = /\b(java\s*(?:developer|full\s*stack|backend|engineer|software)|spring\s*boot|full\s*stack|fullstack|node(?:\.js|\s*js)?\s*(?:developer|backend|engineer|software)|react(?:\.js|\s*js)?\s*(?:developer|full\s*stack|engineer)|mern\s*(?:stack|developer)|software\s*engineer.*(?:java|node|react|full\s*stack)|software\s*developer.*(?:java|node|react|full\s*stack))\b/i;
const BLACKLIST_COMPANY_REGEX = /\b(infosys|infosys\s*bpm|infosys\s*limited)\b/i;

function isBlacklistedCompany(company = '', title = '', url = '') {
  const text = `${company || ''} ${title || ''} ${url || ''}`.toLowerCase();
  if (BLACKLIST_COMPANY_REGEX.test(text)) return true;
  const list = config.search?.blacklistedCompanies || ['infosys'];
  return list.some((c) => text.includes(c));
}

class ExternalApplicant {
  constructor() {
    this.candidate = config.candidate;
    this.resumePath = this.resolveResumePath();
  }

  sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  resolveResumePath() {
    const candidates = [
      path.resolve(__dirname, '../../resume/Manoj_Ambati_Resume.pdf'),
      path.resolve(__dirname, '../../../playwright-mcp/frontend/resume/Manoj_Ambati_Java_Full_Stack_Resume.pdf'),
      path.resolve(__dirname, '../../resume/Manoj_Ambati_Java_Full_Stack_Resume.pdf'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        return p;
      }
    }
    return candidates[0];
  }

  /**
   * Apply to an external site originating from a Naukri job page
   */
  async applyFromNaukri(context, naukriPage, job) {
    if (isBlacklistedCompany(job.company, job.title, job.url)) {
      console.log(`  [ExternalApplicant] Skipping external apply at excluded company: ${job.company}`);
      return { status: 'skipped', notes: `Excluded company: ${job.company || 'Infosys'} (interview already completed)` };
    }

    console.log(`  [ExternalApplicant] Resolving external portal for: ${job.title} @ ${job.company}`);

    let externalUrl = '';

    try {
      // 1. Try reading direct href from company-site-button or link
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

      // 2. Click button to trigger navigation or popup
      const popupPromise = context.waitForEvent('page', { timeout: 8000 }).catch(() => null);

      await naukriPage.evaluate(() => {
        const btn = document.getElementById('company-site-button') ||
          Array.from(document.querySelectorAll('a, button, div, span')).find((el) =>
            /apply on company site|apply on website|company site|external site|apply now/i.test(
              el.innerText || el.getAttribute('title') || ''
            )
          );
        btn?.click();
      }).catch(() => {});

      const popup = await popupPromise;
      if (popup) {
        try {
          await popup.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
          await this.sleep(1500);
          const popupUrl = popup.url();
          if (popupUrl && popupUrl !== 'about:blank') {
            externalUrl = popupUrl;
          }
          await popup.close().catch(() => {});
        } catch {}
      }

      // 3. Check if naukriPage itself navigated away from naukri.com
      await this.sleep(1500);
      if (!naukriPage.url().includes('naukri.com')) {
        externalUrl = naukriPage.url();
      }

      if (!externalUrl || externalUrl === 'about:blank' || externalUrl.includes('naukri.com/job-listings')) {
        return {
          status: 'external',
          notes: 'Could not resolve external company application URL',
        };
      }

      console.log(`  [ExternalApplicant] Directly navigating to external site: ${externalUrl}`);

      // Directly navigate to the external site in the active browser window
      if (naukriPage.url() !== externalUrl) {
        await naukriPage.goto(externalUrl, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
        await this.sleep(3000);
      }

      // Execute application directly on that external company site
      const result = await this.executeApplication(naukriPage, job);

      console.log(`  [ExternalApplicant] Finished applying on external site. Coming back to Naukri to process next jobs...`);

      return {
        ...result,
        externalUrl,
      };
    } catch (err) {
      console.log(`  [ExternalApplicant] Error during external apply: ${err.message}`);
      return {
        status: 'failed',
        externalUrl: externalUrl || job.url,
        notes: `External application failed: ${err.message}`,
      };
    }
  }

  /**
   * Apply directly to any external job URL
   */
  async applyDirectUrl(context, job) {
    const targetUrl = job.externalUrl || job.url;
    if (isBlacklistedCompany(job.company, job.title, targetUrl)) {
      console.log(`  [ExternalApplicant] Skipping external apply at excluded company: ${job.company}`);
      return {
        status: 'skipped',
        externalUrl: targetUrl,
        notes: `Excluded company: ${job.company || 'Infosys'} (interview already completed)`,
      };
    }

    console.log(`\n[ExternalApplicant] Navigating to: ${job.title} @ ${job.company} (${targetUrl})`);

    const page = await context.newPage();
    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
      await this.sleep(3000);

      const result = await this.executeApplication(page, job);
      await page.close().catch(() => {});
      return {
        ...result,
        externalUrl: targetUrl,
      };
    } catch (err) {
      console.log(`  [ExternalApplicant] Direct apply error: ${err.message}`);
      await page.close().catch(() => {});
      return {
        status: 'failed',
        externalUrl: targetUrl,
        notes: `Error: ${err.message}`,
      };
    }
  }

  /**
   * Main form interaction logic across all ATS types.
   * ACCURACY: Only returns status:'applied' when the external site
   * explicitly confirms submission. Otherwise returns 'external_visited'.
   */
  async executeApplication(page, job) {
    // 1. Detect ATS type
    const currentUrl = page.url();
    const ats = this.detectAts(currentUrl, await page.content().catch(() => ''));
    console.log(`  [ExternalApplicant] Detected ATS Engine: ${ats.toUpperCase()}`);

    // 2. Check if blacklisted company portal
    const pageDetails = await page.evaluate(() =>
      (document.title || '') + ' ' + (document.body?.innerText?.slice(0, 1000) || '')
    ).catch(() => '');
    if (isBlacklistedCompany(job.company, pageDetails, currentUrl)) {
      console.log(`  [ExternalApplicant] Excluded company portal (${job.company || 'Infosys'}). Skipping.`);
      return { status: 'skipped', notes: `Excluded company: ${job.company || 'Infosys'} (blacklisted)` };
    }

    // 3. Check if already applied on this portal
    const alreadyApplied = await page.evaluate(() => {
      const text = (document.body ? document.body.innerText : '').toLowerCase();
      return /already applied|application submitted|thank you for applying|you have already submitted/i.test(text);
    }).catch(() => false);
    if (alreadyApplied) {
      return { status: 'already_applied', notes: 'Already applied on external portal' };
    }

    // 4. Click initial Apply button to get to the application form
    await this.clickInitialApplyButton(page);
    await this.sleep(3000);

    // 5. Handle login / registration gates (e.g. Workday / Taleo)
    await this.handleAuthOrAccountCreation(page);
    await this.sleep(2000);

    // 6. Multi-step form completion loop (up to 10 steps for complex ATS)
    let isSuccess = false;
    const SUCCESS_TEXTS = [
      /application\s*submitted/i,
      /thank\s*you\s*for\s*applying/i,
      /successfully\s*applied/i,
      /application\s*(?:has\s*been\s*)?(?:received|sent|submitted)/i,
      /we\s*(?:have\s*)?received\s*your\s*application/i,
      /congratulations/i,
      /your\s*application\s*is\s*(?:complete|submitted)/i,
    ];

    for (let step = 1; step <= 10; step++) {
      console.log(`  [ExternalApplicant] Form step ${step} — filling fields...`);

      // A. Upload resume if a file input is visible on this step
      await this.handleResumeUpload(page);

      // B. Autofill all candidate details
      await this.autofillCandidateDetails(page);

      // C. Answer radio buttons, checkboxes, selects, screening questions
      await this.handleOptionsAndScreeningQuestions(page);

      // D. Short wait after filling so JS validators can process
      await this.sleep(1500);

      // E. Handle CAPTCHA
      await this.handleCaptcha(page);

      // F. Handle OTP email verification
      await this.handleEmailOtp(page);

      // G. Check for success text (might appear before submit is clicked)
      const midStepText = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
      if (SUCCESS_TEXTS.some((p) => p.test(midStepText))) {
        isSuccess = true;
        console.log('  [ExternalApplicant] ✅ Success confirmation detected mid-step!');
        break;
      }

      // H. Try to click Submit or Next
      const submitResult = await this.attemptSubmitOrNext(page);
      console.log(`  [ExternalApplicant] Step ${step} button action: ${submitResult.type}`);

      if (submitResult.type === 'submitted') {
        // Wait for page to load the response after submission
        await this.sleep(5000);
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        await this.sleep(2000);

        const confirmText = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
        if (SUCCESS_TEXTS.some((p) => p.test(confirmText))) {
          isSuccess = true;
          console.log('  [ExternalApplicant] ✅ Application confirmed after submit click!');
        } else {
          // Check if we're on yet another step page
          const stillHasForm = await page.evaluate(() =>
            document.querySelectorAll('input:not([type="hidden"]), select, textarea').length > 0
          ).catch(() => false);
          if (stillHasForm) {
            console.log('  [ExternalApplicant] More form fields found after submit click. Continuing...');
            continue;
          }
        }
        break;

      } else if (submitResult.type === 'next') {
        // Wait for next step to load
        await this.sleep(3000);
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
        continue;

      } else {
        // No submit or next button found
        const noButtonText = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
        if (SUCCESS_TEXTS.some((p) => p.test(noButtonText))) {
          isSuccess = true;
        }
        break;
      }
    }

    // Final verification check
    const finalText = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
    const finalSuccess = SUCCESS_TEXTS.some((p) => p.test(finalText));

    if (isSuccess || finalSuccess) {
      console.log('  [ExternalApplicant] ✅ Application successfully submitted!');
      return {
        status: 'applied',
        notes: `External portal application submitted successfully (${ats.toUpperCase()})`,
      };
    }

    // Form was partially completed or portal needs manual action
    console.log('  [ExternalApplicant] ⚠️  No explicit success confirmation — recording as external_visited.');
    return {
      status: 'external_visited',
      notes: `Form auto-filled on ${ats.toUpperCase()} portal — awaiting manual review/submit if required.`,
    };
  }

  detectAts(url, html = '') {
    const u = url.toLowerCase();
    const h = html.toLowerCase();
    if (u.includes('myworkdayjobs.com') || u.includes('workday') || h.includes('workday')) return 'workday';
    if (u.includes('greenhouse.io') || h.includes('greenhouse')) return 'greenhouse';
    if (u.includes('lever.co') || h.includes('lever-jobs')) return 'lever';
    if (u.includes('smartrecruiters.com') || h.includes('smartrecruiters')) return 'smartrecruiters';
    if (u.includes('ashbyhq.com') || h.includes('ashby')) return 'ashby';
    if (u.includes('taleo') || h.includes('taleo')) return 'taleo';
    if (u.includes('successfactors') || h.includes('successfactors')) return 'successfactors';
    return 'generic';
  }

  async clickInitialApplyButton(page) {
    await page.evaluate(() => {
      // Don't click if we already have inputs on screen
      const inputs = document.querySelectorAll('input:not([type="hidden"]), select, textarea');
      if (inputs.length >= 3) return;

      const candidates = Array.from(document.querySelectorAll('button, a, div[role="button"], input[type="button"]')).filter((el) => {
        const text = (el.innerText || el.getAttribute('value') || el.getAttribute('title') || '').trim();
        return /^(apply|apply now|apply for this job|start application|apply with resume|i'm interested)$/i.test(text) ||
               /apply now|apply for this/i.test(text);
      });

      if (candidates.length > 0) {
        // Prefer buttons without company-site in id
        const best = candidates.find((c) => !c.id?.includes('company-site')) || candidates[0];
        best.click();
      }
    }).catch(() => {});
  }

  async handleAuthOrAccountCreation(page) {
    const hasAuth = await page.evaluate(() => {
      const emailField = document.querySelector('input[type="email"], input[name*="email" i], input[id*="email" i]');
      const passField = document.querySelector('input[type="password"], input[name*="pass" i], input[id*="pass" i]');
      return !!(emailField && passField);
    }).catch(() => false);

    if (!hasAuth) return;

    console.log('  [ExternalApplicant] Sign-in / Create Account form detected, filling credentials...');
    const creds = {
      email: this.candidate.identity.email,
      password: process.env.NAUKRI_PASSWORD || 'Manoj@2469',
    };

    await page.evaluate((c) => {
      const emailInputs = Array.from(document.querySelectorAll('input[type="email"], input[name*="email" i], input[id*="email" i]'));
      const passInputs = Array.from(document.querySelectorAll('input[type="password"], input[name*="pass" i], input[id*="pass" i]'));

      emailInputs.forEach((inp) => {
        if (!inp.value) {
          inp.focus();
          inp.value = c.email;
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });

      passInputs.forEach((inp) => {
        if (!inp.value) {
          inp.focus();
          inp.value = c.password;
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });

      // Agree to privacy terms checkbox
      const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
      checkboxes.forEach((cb) => {
        if (!cb.checked) {
          cb.checked = true;
          cb.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });

      // Click sign in or create account button
      const btn = Array.from(document.querySelectorAll('button, input[type="submit"]')).find((b) =>
        /sign in|create account|log in|register|continue/i.test(b.innerText || b.value || '')
      );
      if (btn) btn.click();
    }, creds).catch(() => {});

    await this.sleep(3000);
  }

  async handleResumeUpload(page) {
    if (!this.resumePath || !fs.existsSync(this.resumePath)) return;

    try {
      const fileInputs = await page.$$('input[type="file"]');
      for (const input of fileInputs) {
        const isVisible = await input.isVisible().catch(() => true);
        await input.setInputFiles(this.resumePath).catch(() => {});
        console.log(`  [ExternalApplicant] Attached resume PDF: ${path.basename(this.resumePath)}`);
        await this.sleep(2000);
      }
    } catch (e) {
      // Resume upload failed or not present on this step
    }
  }

  async autofillCandidateDetails(page) {
    const cand = this.candidate;
    const profile = {
      firstName: cand.identity.firstName,
      lastName: cand.identity.lastName,
      fullName: cand.identity.name,
      email: cand.identity.email,
      phone: cand.identity.phone,
      fullPhone: (cand.identity.countryCode || '') + cand.identity.phone,
      location: cand.identity.location,
      city: cand.identity.city,
      state: cand.identity.state,
      country: cand.identity.country,
      postalCode: cand.identity.postalCode,
      address: cand.identity.address || 'Hyderabad, Telangana',
      linkedinUrl: cand.identity.linkedinUrl,
      githubUrl: cand.identity.githubUrl,
      portfolioUrl: cand.identity.portfolioUrl || cand.identity.githubUrl,
      company: cand.currentEmployment.employer,
      title: cand.currentEmployment.title,
      totalExp: String(cand.currentEmployment.totalExperienceYears),
      currentCtc: String(cand.compensationAndNotice.currentCtcLakhs),
      expectedCtc: String(cand.compensationAndNotice.expectedCtcLakhs),
      noticePeriod: String(cand.compensationAndNotice.noticePeriodDays),
      institution: cand.education.institution,
      degree: cand.education.degree,
      discipline: cand.education.branch,
      graduationYear: String(cand.education.graduationYear),
      gpa: String(cand.education.gpa),
      summary: cand.currentEmployment.summary,
    };

    // Helper: fill a Playwright locator if it's visible and empty (or only has placeholder text)
    const fillField = async (selector, value) => {
      if (!value) return;
      try {
        const els = await page.$$(selector);
        for (const el of els) {
          const visible = await el.isVisible().catch(() => false);
          if (!visible) continue;
          const current = await el.inputValue().catch(() => '');
          const placeholder = await el.getAttribute('placeholder').catch(() => '');
          // Only fill if empty OR if value matches placeholder (i.e. not yet filled)
          if (!current || current === placeholder) {
            await el.click({ force: true }).catch(() => {});
            await el.fill(value).catch(async () => {
              // Fallback for inputs that don't support fill (e.g. contenteditable)
              await el.evaluate((node, val) => {
                node.value = val;
                node.dispatchEvent(new Event('input', { bubbles: true }));
                node.dispatchEvent(new Event('change', { bubbles: true }));
              }, value).catch(() => {});
            });
          }
        }
      } catch {
        // Ignore individual field errors
      }
    };

    // First & Last Name
    await fillField('input[name*="first" i], input[id*="first" i], input[placeholder*="first" i]', profile.firstName);
    await fillField('input[name*="last" i], input[id*="last" i], input[placeholder*="last" i]', profile.lastName);
    await fillField('input[name="name" i], input[id="name" i], input[placeholder*="full name" i], input[name*="full" i]:not([name*="fullstack" i])', profile.fullName);

    // Email
    await fillField('input[type="email"], input[name*="email" i], input[id*="email" i], input[placeholder*="email" i]', profile.email);

    // Phone
    await fillField('input[type="tel"], input[name*="phone" i], input[id*="phone" i], input[name*="mobile" i], input[placeholder*="phone" i]', profile.phone);

    // Location / Address
    await fillField('input[name*="city" i], input[id*="city" i]', profile.city);
    await fillField('input[name*="state" i], input[id*="state" i]', profile.state);
    await fillField('input[name*="zip" i], input[id*="zip" i], input[name*="postal" i], input[id*="postal" i]', profile.postalCode);
    await fillField('input[name*="address" i]:not([name*="email" i]), input[id*="address" i]:not([id*="email" i])', profile.address);

    // Social links
    await fillField('input[name*="linkedin" i], input[id*="linkedin" i], input[placeholder*="linkedin" i]', profile.linkedinUrl);
    await fillField('input[name*="github" i], input[id*="github" i], input[placeholder*="github" i]', profile.githubUrl);
    await fillField('input[name*="website" i], input[id*="website" i], input[name*="portfolio" i]', profile.portfolioUrl);

    // Employment details
    await fillField('input[name*="company" i], input[id*="company" i], input[name*="employer" i], input[id*="employer" i]', profile.company);
    await fillField('input[name*="title" i], input[id*="title" i], input[name*="designation" i]', profile.title);
    await fillField('input[name*="experience" i]:not([name*="java" i]):not([name*="spring" i]), input[name*="exp" i], input[id*="experience" i]', profile.totalExp);
    await fillField('input[name*="notice" i], input[id*="notice" i]', profile.noticePeriod);

    // Salary / CTC
    await fillField('input[name*="current"][name*="ctc" i], input[name*="current"][name*="salary" i]', profile.currentCtc);
    await fillField('input[name*="expected"][name*="ctc" i], input[name*="expected"][name*="salary" i]', profile.expectedCtc);

    // Education
    await fillField('input[name*="school" i], input[name*="college" i], input[name*="university" i], input[name*="institution" i]', profile.institution);
    await fillField('input[name*="degree" i], input[id*="degree" i]', profile.degree);
    await fillField('input[name*="discipline" i], input[name*="major" i], input[name*="branch" i]', profile.discipline);
    await fillField('input[name*="grad" i][name*="year" i], input[name*="year" i][name*="pass" i]', profile.graduationYear);
    await fillField('input[name*="gpa" i], input[name*="cgpa" i], input[name*="percentage" i]', profile.gpa);

    // Summary / Cover note in textareas
    try {
      const textareas = await page.$$('textarea');
      for (const ta of textareas) {
        const lbl = await ta.evaluate((el) => (el.name || el.id || el.placeholder || '').toLowerCase()).catch(() => '');
        if (/summary|cover|about|description/i.test(lbl)) {
          const current = await ta.inputValue().catch(() => '');
          if (!current) await ta.fill(profile.summary).catch(() => {});
        }
      }
    } catch {}
  }

  async handleOptionsAndScreeningQuestions(page) {
    await page.evaluate(() => {
      // 1. Consent and Agreement Checkboxes — always check if related to consent/terms
      const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
      checkboxes.forEach((cb) => {
        const labelText = (
          cb.closest('label')?.innerText ||
          cb.parentElement?.innerText ||
          cb.name || cb.id || ''
        ).toLowerCase();
        if (/agree|consent|terms|privacy|policy|authorized|confirm|declare|certify|acknowledge/i.test(labelText)) {
          if (!cb.checked) {
            cb.checked = true;
            cb.click();
            cb.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
      });

      // 2. Radio questions — DO NOT skip groups that already have a checked radio
      //    because it might be checked on the wrong answer (e.g. "No" when "Yes" is needed)
      const radioGroups = {};
      const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
      radios.forEach((r) => {
        const name = r.name || r.closest('fieldset')?.id || 'group_' + Math.random();
        if (!radioGroups[name]) radioGroups[name] = [];
        radioGroups[name].push(r);
      });

      Object.values(radioGroups).forEach((group) => {
        // Get the question context from the nearest ancestor container
        const questionText = (
          group[0]?.closest('fieldset, .form-group, [class*="question"], [class*="field"], div')?.innerText || ''
        ).toLowerCase();

        const selectRadio = (matchFn) => {
          const target = group.find((r) => {
            const label = (
              r.closest('label')?.innerText ||
              r.parentElement?.innerText ||
              r.value || ''
            ).toLowerCase().trim();
            return matchFn(label, r.value?.toLowerCase() || '');
          });
          if (target && !target.checked) {
            target.checked = true;
            target.click();
            target.dispatchEvent(new Event('change', { bubbles: true }));
          }
        };

        // Sponsorship → No
        if (/sponsorship|sponsor|visa/i.test(questionText)) {
          selectRadio((label, val) => /^no\b|\bno$/i.test(label) || val === 'no');
        }
        // Work authorization → Yes
        else if (/authorized|legally\s*authorized|eligible\s*to\s*work|work\s*authorization/i.test(questionText)) {
          selectRadio((label, val) => /^yes\b|\byes$/i.test(label) || val === 'yes');
        }
        // Relocation → Yes
        else if (/relocat|relocation/i.test(questionText)) {
          selectRadio((label, val) => /^yes\b|\byes$/i.test(label) || val === 'yes');
        }
        // Notice period / immediate joiner → Yes / Immediate
        else if (/notice\s*period|immediate\s*joiner|available\s*to\s*join/i.test(questionText)) {
          selectRadio((label, val) =>
            /^yes\b|\byes$|immediate|0\s*days/i.test(label) || val === 'yes'
          );
        }
        // Currently employed → Yes
        else if (/currently\s*employed|present\s*employer/i.test(questionText)) {
          selectRadio((label, val) => /^yes\b|\byes$/i.test(label) || val === 'yes');
        }
        // Gender → Male or Prefer not to say
        else if (/gender/i.test(questionText)) {
          selectRadio((label) => /^male$|prefer\s*not\s*to\s*say|decline/i.test(label));
        }
        // Generic yes/no question → Yes
        else if (/are\s*you|do\s*you|can\s*you|will\s*you|have\s*you/i.test(questionText)) {
          selectRadio((label, val) => /^yes\b|\byes$/i.test(label) || val === 'yes');
        }
      });

      // 3. Dropdowns (select elements) — handle all with smarter label detection
      const selects = Array.from(document.querySelectorAll('select'));
      selects.forEach((sel) => {
        const options = Array.from(sel.options);
        // Get label from multiple sources
        const labelEl = sel.id
          ? document.querySelector(`label[for="${sel.id}"]`)
          : null;
        const label = (
          labelEl?.innerText ||
          sel.name || sel.id ||
          sel.closest('label, .form-group, [class*="field"], [class*="question"]')?.innerText || ''
        ).toLowerCase();

        // Country → India
        if (/country/i.test(label)) {
          const opt = options.find((o) => /^india$/i.test(o.text.trim()));
          if (opt && sel.value !== opt.value) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return;
          }
        }

        // Notice period → Immediate / 0 days / 15 days
        if (/notice/i.test(label)) {
          const opt = options.find((o) => /immediate|^0\s*days?$|^15\s*days?$/i.test(o.text.trim()));
          if (opt && sel.value !== opt.value) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return;
          }
        }

        // Experience → 2 or 2-3 years
        if (/experience|exp\b/i.test(label)) {
          // Skip if already meaningfully selected
          if (sel.value && sel.selectedIndex > 0) return;
          const opt = options.find((o) => /2\s*[-–to]\s*[34]|2\.5|2\+|^2\s*years?$/i.test(o.text.trim()));
          if (opt) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return;
          }
        }

        // Relocation → Yes
        if (/relocat/i.test(label)) {
          const opt = options.find((o) => /^yes$/i.test(o.text.trim()));
          if (opt && sel.value !== opt.value) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return;
          }
        }

        // Highest qualification / degree
        if (/qualification|degree|education/i.test(label)) {
          if (sel.value && sel.selectedIndex > 0) return;
          const opt = options.find((o) => /b\.?\s*tech|bachelor|b\.?\s*e\b/i.test(o.text));
          if (opt) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
      });
    }).catch(() => {});
  }

  async handleCaptcha(page) {
    const hasCaptcha = await page.evaluate(() => {
      return !!(
        document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"]') ||
        document.querySelector('.g-recaptcha, .h-captcha, [class*="captcha" i], #captcha')
      );
    }).catch(() => false);

    if (hasCaptcha) {
      console.log('  [ExternalApplicant] ⚠️ CAPTCHA detected on page! Waiting up to 20s for completion in visible browser...');
      for (let sec = 0; sec < 20; sec += 3) {
        await this.sleep(3000);
        const stillCaptcha = await page.evaluate(() => {
          return !!(
            document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"]') ||
            document.querySelector('.g-recaptcha, .h-captcha, [class*="captcha" i]')
          );
        }).catch(() => false);
        if (!stillCaptcha) {
          console.log('  [ExternalApplicant] ✅ CAPTCHA cleared!');
          break;
        }
      }
    }
  }

  async handleEmailOtp(page) {
    const needsOtp = await page.evaluate(() => {
      const text = (document.body ? document.body.innerText : '').toLowerCase();
      return /enter otp|verification code|verification pin|enter code|one-time password/i.test(text);
    }).catch(() => false);

    if (needsOtp) {
      console.log('  [ExternalApplicant] 📩 OTP verification prompt detected, querying Gmail API...');
      await this.sleep(6000);
      const otp = await fetchLatestOtp(240);
      if (otp) {
        console.log(`  [ExternalApplicant] ✅ Extracted OTP from Gmail: ${otp}`);
        await page.evaluate((code) => {
          const inp = document.querySelector(
            'input[name*="otp" i], input[name*="code" i], input[id*="otp" i], input[id*="code" i], input[placeholder*="code" i], input[type="number"]'
          );
          if (inp) {
            inp.value = code;
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            inp.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, otp);
        await this.sleep(1500);
      } else {
        console.log('  [ExternalApplicant] No OTP detected in Gmail yet');
      }
    }
  }

  async attemptSubmitOrNext(page) {
    return await page.evaluate(() => {
      // 1. Check for Submit Application button
      const submitBtn = Array.from(document.querySelectorAll('button, input[type="submit"], a')).find((b) => {
        const text = (b.innerText || b.getAttribute('value') || '').trim();
        return /^(submit application|submit|apply now|complete application|send application)$/i.test(text) ||
               /submit application|complete application/i.test(text);
      });

      if (submitBtn) {
        submitBtn.click();
        return { type: 'submitted' };
      }

      // 2. Check for Next / Continue button in multi-step form
      const nextBtn = Array.from(document.querySelectorAll('button, input[type="button"], a')).find((b) => {
        const text = (b.innerText || b.getAttribute('value') || '').trim();
        return /^(save and continue|continue|next|next step|review application)$/i.test(text) ||
               /continue|next/i.test(text);
      });

      if (nextBtn) {
        nextBtn.click();
        return { type: 'next' };
      }

      return { type: 'none' };
    }).catch(() => ({ type: 'none' }));
  }

  /**
   * Batch runner for applying to pending external jobs from tracking files
   */
  async runBatch(browserManager, options = {}) {
    const limit = options.limit || config.search.targetApplications;
    const isHeadless = options.headless !== undefined ? options.headless : config.browser.isHeadless;

    console.log(`\n======================================================`);
    console.log(`🚀 Starting External Company Sites Auto-Apply Batch Runner`);
    console.log(`Target: ${limit} applications`);
    console.log(`Mode:   ${isHeadless ? 'HEADLESS' : 'HEADED (Visible Window)'}`);
    console.log(`Resume: ${path.basename(this.resumePath)}`);
    console.log(`======================================================\n`);

    tracker.init();

    // 1. Collect candidate external jobs from applied-jobs.json and legacy naukri-external-jobs.json
    let externalPool = [];
    if (fs.existsSync(config.paths.appliedJson)) {
      try {
        const primary = JSON.parse(fs.readFileSync(config.paths.appliedJson, 'utf8'));
        externalPool.push(...primary);
      } catch {}
    }

    const legacyExtPath = path.resolve(__dirname, '../../../playwright-mcp/backend/data/naukri-external-jobs.json');
    if (fs.existsSync(legacyExtPath)) {
      try {
        const legacy = JSON.parse(fs.readFileSync(legacyExtPath, 'utf8'));
        externalPool.push(...legacy);
      } catch {}
    }

    // 2. Strict Filter: Whitelist, Blacklist, and Unapplied status
    const seenUrls = new Set();
    const eligibleJobs = [];

    for (const j of externalPool) {
      const externalCandidateUrl = (j.externalUrl && !j.externalUrl.includes('naukri.com')) ? j.externalUrl : null;
      const targetUrl = externalCandidateUrl || j.externalUrl || j.applyUrl || j.url;
      if (!targetUrl || seenUrls.has(targetUrl)) continue;
      seenUrls.add(targetUrl);

      const title = j.title || '';
      if (BLACKLIST_TITLE_REGEX.test(title)) continue;
      if (!WHITELIST_TITLE_REGEX.test(title)) continue;
      if (isBlacklistedCompany(j.company, title, targetUrl)) continue;

      const currentStatus = tracker.getStatus(targetUrl);
      if (currentStatus === 'APPLIED') continue;

      eligibleJobs.push({
        title: j.title,
        company: j.company || 'External Employer',
        location: j.location || 'India',
        url: j.applyUrl || j.url || targetUrl,
        externalUrl: targetUrl,
        isNaukriListing: targetUrl.includes('naukri.com'),
      });
    }

    console.log(`Found ${eligibleJobs.length} eligible external developer job postings to apply.`);

    if (eligibleJobs.length === 0) {
      console.log('No eligible unapplied external jobs found.');
      return 0;
    }

    let appliedCount = 0;
    const context = await browserManager.getPersistentContext({ headless: isHeadless });

    try {
      for (const job of eligibleJobs) {
        if (appliedCount >= limit) break;

        console.log(`\n👉 Processing External [${appliedCount + 1}/${limit}]: ${job.title} | ${job.company}`);
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
          console.log(`  Result: [${result.status.toUpperCase()}] ${result.notes || ''}`);

          if (result.status === 'applied') {
            appliedCount++;
            tracker.recordApplied({
              platform: 'EXTERNAL',
              title: job.title,
              company: job.company,
              location: job.location,
              applyUrl: job.url,
              externalUrl: job.externalUrl,
              notes: result.notes,
            });
          } else if (result.status === 'already_applied') {
            tracker.recordSkipped({
              platform: 'EXTERNAL',
              title: job.title,
              company: job.company,
              location: job.location,
              applyUrl: job.url,
              externalUrl: job.externalUrl,
              notes: result.notes || 'Already applied previously',
            });
          } else if (result.status === 'external_visited') {
            tracker.recordExternal({
              platform: 'EXTERNAL',
              title: job.title,
              company: job.company,
              location: job.location,
              applyUrl: job.url,
              externalUrl: job.externalUrl,
              notes: result.notes,
            });
          } else {
            tracker.recordFailed({
              platform: 'EXTERNAL',
              title: job.title,
              company: job.company,
              location: job.location,
              applyUrl: job.url,
              externalUrl: job.externalUrl,
              notes: result.notes || 'Failed external application',
            });
          }
        } catch (jobErr) {
          console.warn(`  ⚠️ External apply error on ${job.title}: ${jobErr.message}`);
          tracker.recordFailed({
            platform: 'EXTERNAL',
            title: job.title,
            company: job.company,
            location: job.location,
            applyUrl: job.url,
            externalUrl: job.externalUrl,
            notes: `Error: ${jobErr.message}`,
          });
        }

        tracker.save();
        await this.sleep(2000);
      }
    } finally {
      await browserManager.closeContext();
    }

    console.log(`\nExternal Sites Batch completed. New applies: ${appliedCount}`);
    return appliedCount;
  }
}

const externalApplicantInstance = new ExternalApplicant();
module.exports = externalApplicantInstance;
module.exports.ExternalApplicant = ExternalApplicant;

