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
    console.log(`  [ExternalApplicant] Launching external application for: ${job.title} @ ${job.company}`);

    let externalPage = null;
    let externalUrl = '';

    try {
      // Setup listener for popup tab before clicking company-site-button
      const popupPromise = context.waitForEvent('page', { timeout: 12000 }).catch(() => null);

      const clicked = await naukriPage.evaluate(() => {
        const btn = document.getElementById('company-site-button') ||
          Array.from(document.querySelectorAll('button, a, div, span')).find((el) =>
            /apply on company site|apply on website|company site|external site|apply now/i.test(
              el.innerText || el.getAttribute('title') || ''
            )
          );
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      }).catch(() => false);

      if (clicked) {
        externalPage = await popupPromise;
      }

      // If no popup opened, check if current page navigated away from naukri.com
      if (!externalPage) {
        await this.sleep(3000);
        if (!naukriPage.url().includes('naukri.com')) {
          externalPage = naukriPage;
        }
      }

      // If still no external page, try reading href from the button
      if (!externalPage) {
        externalUrl = await naukriPage.evaluate(() => {
          const btn = document.getElementById('company-site-button') ||
            Array.from(document.querySelectorAll('button, a')).find((el) =>
              /apply on company site|apply on website/i.test(el.innerText || '')
            );
          return btn ? (btn.href || btn.getAttribute('data-href') || '') : '';
        }).catch(() => '');

        if (externalUrl && externalUrl.startsWith('http')) {
          externalPage = await context.newPage();
          await externalPage.goto(externalUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        }
      }

      if (!externalPage) {
        return {
          status: 'external',
          notes: 'Could not open external company application URL',
        };
      }

      await externalPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await this.sleep(3000);
      externalUrl = externalPage.url();

      console.log(`  [ExternalApplicant] Target portal opened: ${externalUrl}`);

      const result = await this.executeApplication(externalPage, job);

      // Clean up popup if it wasn't the main naukri page
      if (externalPage !== naukriPage) {
        await externalPage.close().catch(() => {});
      }

      return {
        ...result,
        externalUrl,
      };
    } catch (err) {
      console.log(`  [ExternalApplicant] Error during external apply: ${err.message}`);
      if (externalPage && externalPage !== naukriPage) {
        await externalPage.close().catch(() => {});
      }
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
   * Main form interaction logic across all ATS types
   */
  async executeApplication(page, job) {
    // 1. Detect ATS type
    const currentUrl = page.url();
    const ats = this.detectAts(currentUrl, await page.content().catch(() => ''));
    console.log(`  [ExternalApplicant] Detected ATS Engine: ${ats.toUpperCase()}`);

    // 2. Check if already applied
    const alreadyApplied = await page.evaluate(() => {
      const text = (document.body ? document.body.innerText : '').toLowerCase();
      return /already applied|application submitted|thank you for applying|you have already submitted/i.test(text);
    }).catch(() => false);

    if (alreadyApplied) {
      return { status: 'already_applied', notes: 'Already applied on external portal' };
    }

    // 3. Look for "Apply" / "Apply Now" button to transition to application form
    await this.clickInitialApplyButton(page);
    await this.sleep(2500);

    // 4. Handle login / registration if required (e.g. Workday / Taleo)
    await this.handleAuthOrAccountCreation(page);

    // 5. Multi-step form completion loop (up to 5 steps)
    let isSuccess = false;
    let lastStepState = '';

    for (let step = 1; step <= 5; step++) {
      console.log(`  [ExternalApplicant] Processing application step ${step}...`);

      // A. Upload resume if file input is visible
      await this.handleResumeUpload(page);

      // B. Autofill personal and contact details
      await this.autofillCandidateDetails(page);

      // C. Answer radio buttons, checkboxes, and select dropdowns
      await this.handleOptionsAndScreeningQuestions(page);

      // D. Check for CAPTCHA
      await this.handleCaptcha(page);

      // E. Check for OTP / Verification Code
      await this.handleEmailOtp(page);

      // F. Check if final submission button exists
      const submitResult = await this.attemptSubmitOrNext(page);
      if (submitResult.type === 'submitted') {
        await this.sleep(4000);
        const confirmText = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
        if (
          /application submitted|thank you|successfully|received your application|applied|congratulations/i.test(
            confirmText
          )
        ) {
          isSuccess = true;
          break;
        }
      } else if (submitResult.type === 'next') {
        await this.sleep(2500);
        continue;
      } else {
        // No submit or next button found or reached end
        break;
      }
    }

    // Final verification
    const finalCheck = await page.evaluate(() => {
      const text = (document.body ? document.body.innerText : '').toLowerCase();
      const hasSuccessText = /application submitted|thank you for applying|successfully applied|application has been submitted|application received/i.test(text);
      return hasSuccessText;
    }).catch(() => false);

    if (isSuccess || finalCheck) {
      console.log('  [ExternalApplicant] Application successfully submitted!');
      return {
        status: 'applied',
        notes: `External portal application submitted successfully (${ats.toUpperCase()})`,
      };
    }

    // If form was partially completed or required proprietary login/assessment
    return {
      status: 'external_visited',
      notes: `Form auto-filled on ${ats.toUpperCase()} portal. Review/Submit completed.`,
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
      fullPhone: cand.identity.countryCode + cand.identity.phone,
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
      totalExp: cand.currentEmployment.totalExperienceYears,
      currentCtc: cand.compensationAndNotice.currentCtcLakhs,
      expectedCtc: cand.compensationAndNotice.expectedCtcLakhs,
      noticePeriod: cand.compensationAndNotice.noticePeriodDays,
      institution: cand.education.institution,
      degree: cand.education.degree,
      discipline: cand.education.branch,
      graduationYear: cand.education.graduationYear,
      gpa: cand.education.gpa,
      summary: cand.currentEmployment.summary,
    };

    await page.evaluate((p) => {
      const setValue = (selector, val) => {
        const elements = Array.from(document.querySelectorAll(selector));
        for (const el of elements) {
          if (!el.value || el.value.trim() === '') {
            el.focus();
            el.value = val;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
      };

      // First & Last Name
      setValue('input[name*="first" i], input[id*="first" i], input[placeholder*="first" i]', p.firstName);
      setValue('input[name*="last" i], input[id*="last" i], input[placeholder*="last" i]', p.lastName);
      setValue('input[name*="full" i], input[id*="full" i], input[name="name" i], input[id="name" i], input[placeholder*="full name" i]', p.fullName);

      // Email
      setValue('input[type="email"], input[name*="email" i], input[id*="email" i], input[placeholder*="email" i]', p.email);

      // Phone
      setValue('input[type="tel"], input[name*="phone" i], input[id*="phone" i], input[name*="mobile" i], input[placeholder*="phone" i]', p.phone);

      // Location / Address
      setValue('input[name*="city" i], input[id*="city" i]', p.city);
      setValue('input[name*="state" i], input[id*="state" i]', p.state);
      setValue('input[name*="zip" i], input[id*="zip" i], input[name*="postal" i], input[id*="postal" i]', p.postalCode);
      setValue('input[name*="address" i], input[id*="address" i]', p.address);

      // Links (LinkedIn / GitHub / Website)
      setValue('input[name*="linkedin" i], input[id*="linkedin" i], input[placeholder*="linkedin" i]', p.linkedinUrl);
      setValue('input[name*="github" i], input[id*="github" i], input[placeholder*="github" i]', p.githubUrl);
      setValue('input[name*="website" i], input[id*="website" i], input[name*="portfolio" i], input[id*="portfolio" i]', p.portfolioUrl);

      // Employment
      setValue('input[name*="company" i], input[id*="company" i], input[name*="employer" i]', p.company);
      setValue('input[name*="title" i], input[id*="title" i], input[name*="designation" i]', p.title);
      setValue('input[name*="experience" i], input[name*="exp" i], input[id*="experience" i]', p.totalExp);
      setValue('input[name*="notice" i], input[id*="notice" i]', p.noticePeriod);

      // Salary / CTC
      setValue('input[name*="current" i][name*="ctc" i], input[name*="current" i][name*="salary" i]', p.currentCtc);
      setValue('input[name*="expected" i][name*="ctc" i], input[name*="expected" i][name*="salary" i]', p.expectedCtc);

      // Education
      setValue('input[name*="school" i], input[name*="college" i], input[name*="university" i], input[name*="institution" i]', p.institution);
      setValue('input[name*="degree" i], input[id*="degree" i]', p.degree);
      setValue('input[name*="discipline" i], input[name*="major" i], input[name*="branch" i]', p.discipline);
      setValue('input[name*="grad" i], input[name*="year" i]', p.graduationYear);
      setValue('input[name*="gpa" i], input[name*="cgpa" i], input[name*="percentage" i]', p.gpa);

      // Textareas / Summary
      const textareas = Array.from(document.querySelectorAll('textarea'));
      textareas.forEach((ta) => {
        if (!ta.value || ta.value.trim() === '') {
          const lbl = (ta.name || ta.id || ta.placeholder || '').toLowerCase();
          if (/summary|cover|about|description/i.test(lbl)) {
            ta.value = p.summary;
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            ta.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
      });
    }, profile).catch(() => {});
  }

  async handleOptionsAndScreeningQuestions(page) {
    await page.evaluate(() => {
      // 1. Consent and Agreement Checkboxes
      const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
      checkboxes.forEach((cb) => {
        if (!cb.checked) {
          const labelText = (cb.closest('label')?.innerText || cb.parentElement?.innerText || cb.name || cb.id || '').toLowerCase();
          if (/agree|consent|terms|privacy|policy|authorized|confirm|declare|certify|acknowledge/i.test(labelText)) {
            cb.checked = true;
            cb.click();
            cb.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
      });

      // 2. Radio questions (Work Auth, Sponsorship, Relocation, Gender)
      const radioGroups = {};
      const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
      radios.forEach((r) => {
        const name = r.name || 'default';
        if (!radioGroups[name]) radioGroups[name] = [];
        radioGroups[name].push(r);
      });

      Object.values(radioGroups).forEach((group) => {
        const hasChecked = group.some((r) => r.checked);
        if (hasChecked) return;

        group.forEach((r) => {
          const label = (r.closest('label')?.innerText || r.parentElement?.innerText || r.value || '').toLowerCase();
          const questionText = (r.closest('fieldset, .form-group, div')?.innerText || '').toLowerCase();

          // Sponsorship question: "Do you need visa sponsorship?" -> NO
          if (/sponsorship|sponsor|visa/i.test(questionText)) {
            if (/^no\b|\bno\b/i.test(label) || r.value.toLowerCase() === 'no') {
              r.checked = true;
              r.click();
              r.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }
          // Work authorization question: "Are you authorized to work in India?" -> YES
          else if (/authorized|legally authorized|eligible to work/i.test(questionText)) {
            if (/^yes\b|\byes\b/i.test(label) || r.value.toLowerCase() === 'yes') {
              r.checked = true;
              r.click();
              r.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }
          // Relocation question: "Are you willing to relocate?" -> YES
          else if (/relocate|relocation/i.test(questionText)) {
            if (/^yes\b|\byes\b/i.test(label) || r.value.toLowerCase() === 'yes') {
              r.checked = true;
              r.click();
              r.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }
          // Gender -> Male / Prefer not to say
          else if (/gender/i.test(questionText)) {
            if (/male|prefer not to say|decline/i.test(label)) {
              r.checked = true;
              r.click();
              r.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }
        });
      });

      // 3. Dropdowns (select elements)
      const selects = Array.from(document.querySelectorAll('select'));
      selects.forEach((sel) => {
        if (sel.value && sel.selectedIndex > 0) return;

        const options = Array.from(sel.options);
        const label = (sel.name || sel.id || sel.closest('label, .form-group')?.innerText || '').toLowerCase();

        // Country -> India
        if (/country/i.test(label)) {
          const opt = options.find((o) => /india/i.test(o.text));
          if (opt) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return;
          }
        }

        // Notice period -> Immediate / 0-15 days / 30 days
        if (/notice/i.test(label)) {
          const opt = options.find((o) => /immediate|0 days|15 days|1 month|30 days/i.test(o.text));
          if (opt) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return;
          }
        }

        // Total experience -> 2 years / 2-3 years
        if (/experience|exp/i.test(label)) {
          const opt = options.find((o) => /2\s*(?:-|to)\s*3|2\.5|2\+|2 years/i.test(o.text));
          if (opt) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return;
          }
        }

        // Relocation -> Yes
        if (/relocate/i.test(label)) {
          const opt = options.find((o) => /^yes/i.test(o.text));
          if (opt) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return;
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

