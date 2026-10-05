/**
 * naukri.js
 * Naukri Job Auto-Apply workflow module.
 *
 * Supports:
 *  - Headed & Headless execution
 *  - In-platform 1-click apply & Chatbot screening questions
 *  - External company site detection & URL capturing
 *  - Real-time file-based tracking (JSON, CSV, Excel)
 */

const fs = require('fs');
const path = require('path');
const config = require('../../config');
const tracker = require('../tracker/file-tracker');
const externalApplicant = require('./external-applicant');

const BLACKLIST_TITLE_REGEX = /(?:\b(python|django|flask|fastapi|pandas|pyspark|dot\s*net|dotnet|\.net|c#|c\+\+|php|laravel|wordpress|ruby|rails|golang|go\s*developer|rust|ios|swift|objective-c|android|flutter|react\s*native|mobile\s*developer|qa\b|tester|testing|automation\s*test|sdet|devops|sre|cloud\s*engineer|aws\s*engineer|azure\s*engineer|salesforce|sap\b|mainframe|data\s*engineer|data\s*scientist|data\s*analyst|machine\s*learning|ai\s*engineer|deep\s*learning|nlp|computer\s*vision|big\s*data|etl|business\s*analyst|scrum\s*master|product\s*manager|sales|marketing|recruiter|hr\b|intern|internship|trainee|caller|telecaller|bpo|kpo|support)\b)/i;
const WHITELIST_TITLE_REGEX = /\b(java\s*(?:developer|full\s*stack|backend|engineer|software)|spring\s*boot|microservices?|backend\s*(?:developer|engineer|software)|full\s*stack|fullstack|node(?:\.js|\s*js)?\s*(?:developer|backend|engineer|software)|react(?:\.js|\s*js)?\s*(?:developer|full\s*stack|engineer)|software\s*(?:engineer|developer).*(?:java|backend|spring|full\s*stack))\b/i;
const BLACKLIST_COMPANY_REGEX = /\b(infosys|infosys\s*bpm|infosys\s*limited)\b/i;

class NaukriApplicant {
  constructor(browserManager, options = {}) {
    this.browserManager = browserManager;
    const limit = options.noCap ? Infinity : (options.limit !== undefined ? options.limit : config.search.targetApplications);
    this.options = {
      limit: limit || Infinity,
      noCap: Boolean(options.noCap) || limit === Infinity,
      headless: options.headless !== undefined ? options.headless : config.browser.isHeadless,
      keywords: options.keywords || config.search.keywords,
      locations: options.locations || config.search.locations,
      jobAge: options.jobAge || config.search.jobAge,
      maxPages: options.maxPages || 25,
      javaOnly: options.javaOnly !== undefined ? options.javaOnly : (options.keywords ? options.keywords.every((k) => /java|spring/i.test(k)) : false),
    };
    this.candidate = config.candidate;
    this.creds = config.credentials.naukri;
    this.externalApplicant = externalApplicant;
    this.naukriQuotaExceeded = false;
  }

  sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  isTargetJob(title) {
    if (!title) return false;
    if (BLACKLIST_TITLE_REGEX.test(title)) return false;

    // If searching specifically for Java roles, strictly require Java / Spring / J2EE
    const isJavaTargeted = this.options.javaOnly ||
      (this.options.keywords && this.options.keywords.every((k) => /java|spring/i.test(k)));
    if (isJavaTargeted) {
      return /\b(java|spring\s*boot|spring|j2ee)\b/i.test(title);
    }

    return WHITELIST_TITLE_REGEX.test(title);
  }

  isBlacklistedCompany(company = '', title = '', url = '') {
    const text = `${company || ''} ${title || ''} ${url || ''}`.toLowerCase();
    if (BLACKLIST_COMPANY_REGEX.test(text)) return true;
    const list = config.search?.blacklistedCompanies || ['infosys'];
    return list.some((c) => text.includes(c));
  }

  async ensureLoggedIn(page) {
    console.log('[Naukri] Verifying login status...');
    await page.goto('https://www.naukri.com/mnjuser/homepage', { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
    await this.sleep(3000);

    const currentUrl = page.url();
    if (!currentUrl.includes('login') && (currentUrl.includes('/mnjuser') || currentUrl.includes('/mynaukri'))) {
      console.log('[Naukri] Session is already authenticated.');
      return;
    }

    console.log('[Naukri] Navigating to login...');
    await page.goto('https://www.naukri.com/nlogin/login', { waitUntil: 'domcontentloaded', timeout: 35000 });
    await this.sleep(2500);

    // Target the specific login form elements (avoiding the header search input)
    const emailInput = page.locator('#usernameField, input[placeholder*="Email ID"], input[placeholder*="Username"]').first();
    const passwordInput = page.locator('#passwordField, input[type="password"]').first();
    const loginBtn = page.locator('button[type="submit"]:has-text("Login"), button.blue-btn').first();

    try {
      await emailInput.waitFor({ state: 'visible', timeout: 15000 });
      console.log('[Naukri] Entering credentials...');
      await emailInput.fill(this.creds.email);
      await passwordInput.fill(this.creds.password);
      await this.sleep(500);
      console.log('[Naukri] Clicking login...');
      await loginBtn.click();
      await this.sleep(5000);
    } catch (e) {
      console.log(`[Naukri] Login form submission note: ${e.message}`);
    }

    if (page.url().includes('login')) {
      console.log('⚠️ [Naukri] Security verification or CAPTCHA detected!');
      if (!this.options.headless) {
        console.log('👉 Browser is open in HEADED mode. Please complete the verification in the browser window now...');
        for (let i = 0; i < 20; i++) {
          await this.sleep(3000);
          if (!page.url().includes('login')) {
            console.log('[Naukri] Login verification cleared!');
            break;
          }
        }
      } else {
        console.warn('⚠️ Running in HEADLESS mode with a login challenge. Run with --mode headed to solve once.');
      }
    }

    if (page.url().includes('login')) {
      throw new Error('[Naukri] Login failed. Please verify credentials in .env or run with --mode headed.');
    }
    console.log('[Naukri] Successfully logged in.');
  }

  buildSearchUrls() {
    const urls = [];
    const jobAge = this.options.jobAge;

    for (const kw of this.options.keywords) {
      const slugKw = kw.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const paramKw = encodeURIComponent(kw.toLowerCase());

      for (const loc of this.options.locations) {
        const slugLoc = loc.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const paramLoc = encodeURIComponent(loc.toLowerCase());

        urls.push(`https://www.naukri.com/${slugKw}-jobs-in-${slugLoc}?k=${paramKw}&l=${paramLoc}&experience=2&jobAge=${jobAge}`);
      }
      urls.push(`https://www.naukri.com/${slugKw}-jobs?k=${paramKw}&experience=2&jobAge=${jobAge}`);
    }

    return urls;
  }

  answerForQuestion(q) {
    const t = (q || '').toLowerCase();
    const cand = this.candidate;

    // Relocation checks (always Yes)
    if (/relocate|relocation|relocating|willing to relocate|willing.*relocate|open to relocate|ready to relocate|location preference|preferred location/i.test(t)) {
      return 'Yes';
    }
    if (/work from office|hybrid|on-site|onsite|flexible.*location|night shift|rotational/i.test(t)) {
      return 'Yes';
    }

    if (/serving.*notice/.test(t)) return 'No';
    if (/offer.*in\s*hand/.test(t)) return 'No';
    if (/years?.*(experience|exp).*(java)/.test(t)) return cand.skillYears.java;
    if (/years?.*(experience|exp).*(spring|spring boot)/.test(t)) return cand.skillYears['spring boot'];
    if (/years?.*(experience|exp).*(microservices|micro\s*services)/.test(t)) return cand.skillYears.microservices;
    if (/years?.*(experience|exp).*(react)/.test(t)) return cand.skillYears.react;
    if (/years?.*(experience|exp).*(node|nodejs|express)/.test(t)) return cand.skillYears.node;
    if (/years?.*(experience|exp).*(full\s*stack|fullstack)/.test(t)) return cand.currentEmployment.totalExperienceYears;
    if (/years?.*(experience|exp)/.test(t)) return cand.currentEmployment.totalExperienceYears;
    if (/(current|present).*(ctc|salary|package)/.test(t)) return cand.compensationAndNotice.currentCtcLakhs;
    if (/(expected|expecting).*(ctc|salary|package)/.test(t)) return cand.compensationAndNotice.expectedCtcLakhs;
    if (/notice/.test(t)) return cand.compensationAndNotice.noticePeriodDays;
    if (/location|city|based/.test(t)) return cand.identity.location;
    if (/email/.test(t)) return cand.identity.email;
    if (/phone|mobile|contact/.test(t)) return cand.identity.phone;
    if (/name/.test(t)) return cand.identity.name;
    if (/qualification|degree|education|highest/.test(t)) return cand.education.highestQualification;
    if (/immediate/.test(t)) return 'Yes';
    if (/^(are you|do you|can you|will you|have you|is it|would you)/.test(t)) return 'Yes';
    if (/how many|number of|years|months/.test(t)) return cand.currentEmployment.totalExperienceYears;
    return 'Yes';
  }

  async handleChatbot(page) {
    console.log('  [Naukri] Handling screening chatbot drawer...');
    for (let loop = 0; loop < 12; loop++) {
      await this.sleep(1500);

      const status = await page.evaluate(() => {
        const text = document.body ? document.body.innerText : '';
        const applied = /applied successfully|application has been received|applied to/i.test(text);
        const open = !!document.querySelector('.chatbot_DrawerContentWrapper, [class*="chatbot"]');
        return { applied, open };
      }).catch(async (e) => {
        if (e.message.includes('Execution context was destroyed') || e.message.includes('navigation')) {
          await page.waitForLoadState('domcontentloaded', { timeout: 4000 }).catch(() => {});
          const text = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
          const applied = /applied successfully|application has been received|applied to/i.test(text);
          return { applied, open: false };
        }
        return { applied: false, open: false };
      });

      if (status.applied) return 'success';
      if (!status.open) return 'closed';

      const question = await page.evaluate(() => {
        const cb = document.querySelector('.chatbot_DrawerContentWrapper, [class*="chatbot"]');
        if (!cb) return '';
        const botMsgs = cb.querySelectorAll('[class*="bot-msg"], [class*="botMessage"], [class*="msg-text"], [class*="question"], .msg, p, h3, h4');
        let q = '';
        if (botMsgs.length > 0) {
          q = botMsgs[botMsgs.length - 1].innerText?.trim() || '';
        }
        // If drawer text mentions relocate, ensure it is flagged
        if (/relocate|relocation|willing.*relocate/i.test(cb.innerText || '')) {
          q += ' relocate';
        }
        return q;
      }).catch(() => '');

      const ans = this.answerForQuestion(question);

      const clicked = await page.evaluate((answer) => {
        const cb = document.querySelector('.chatbot_DrawerContentWrapper, [class*="chatbot"]');
        if (!cb) return false;

        // 1. Direct Radio Buttons (input[type="radio"], [role="radio"])
        const radios = Array.from(cb.querySelectorAll('input[type="radio"], [role="radio"]'));
        if (radios.length > 0) {
          for (const r of radios) {
            const parentLabel = r.closest('label') || r.parentElement;
            const forLabel = r.id ? cb.querySelector(`label[for="${r.id}"]`) : null;
            const labelText = [
              r.value,
              r.getAttribute('aria-label') || '',
              parentLabel?.innerText || '',
              forLabel?.innerText || '',
              r.nextElementSibling?.innerText || '',
            ].join(' ').trim().toLowerCase();

            const isYes = answer.toLowerCase() === 'yes' && (/^yes\b|\byes\b/i.test(labelText) || r.value.toLowerCase() === 'yes');
            const isNo = answer.toLowerCase() === 'no' && (/^no\b|\bno\b/i.test(labelText) || r.value.toLowerCase() === 'no');
            const isMatch = labelText.includes(answer.toLowerCase());

            if (isYes || isNo || isMatch) {
              r.checked = true;
              r.click();
              r.dispatchEvent(new Event('input', { bubbles: true }));
              r.dispatchEvent(new Event('change', { bubbles: true }));
              if (parentLabel) parentLabel.click();
              if (forLabel) forLabel.click();
              return true;
            }
          }
        }

        // 2. Radio wrappers and styling elements (e.g. .ssrc__radio, .ssrc__label, .radio-wrap)
        const radioWrappers = Array.from(cb.querySelectorAll('[class*="ssrc__radio"], [class*="radio"], label, [class*="chip"], [class*="option"], button, li, span'));
        for (const rw of radioWrappers) {
          const txt = rw.innerText?.trim().toLowerCase() || '';
          if (!txt || txt.length > 50) continue;

          if (answer.toLowerCase() === 'yes' && (/^yes\b|\byes$/i.test(txt) || txt === 'yes')) {
            rw.click();
            const innerRadio = rw.querySelector('input[type="radio"]');
            if (innerRadio) {
              innerRadio.checked = true;
              innerRadio.click();
              innerRadio.dispatchEvent(new Event('change', { bubbles: true }));
            }
            return true;
          }
          if (answer.toLowerCase() === 'no' && (/^no\b|\bno$/i.test(txt) || txt === 'no')) {
            rw.click();
            const innerRadio = rw.querySelector('input[type="radio"]');
            if (innerRadio) {
              innerRadio.checked = true;
              innerRadio.click();
              innerRadio.dispatchEvent(new Event('change', { bubbles: true }));
            }
            return true;
          }
        }

        // 3. Exact chip / option text match
        const opts = Array.from(cb.querySelectorAll('button, [class*="chip"], [class*="option"], label, li, span')).filter((el) => {
          const t = el.innerText?.trim();
          return t && t.length < 50;
        });

        let m = opts.find((o) => o.innerText?.trim().toLowerCase() === answer.toLowerCase());
        if (m) { m.click(); return true; }

        // 4. Numeric & Range match for experience (e.g. 2.5 matches "1-3 yrs", "2-4 yrs", "2-5 yrs", "2+ yrs", "2 to 3 years")
        const num = parseFloat(answer);
        if (!isNaN(num)) {
          m = opts.find((o) => {
            const txt = o.innerText?.trim().toLowerCase() || '';
            const rangeMatch = txt.match(/(\d+(?:\.\d+)?)\s*(?:-|to)\s*(\d+(?:\.\d+)?)/i);
            if (rangeMatch) {
              const min = parseFloat(rangeMatch[1]);
              const max = parseFloat(rangeMatch[2]);
              if (num >= min && num <= max) return true;
            }
            if (txt.includes('2.5') || txt.includes('2+') || txt.includes('2 +') || txt.includes('2-3') || txt.includes('2 - 3') || txt.includes('1 - 3') || txt.includes('1-3')) {
              return true;
            }
            return false;
          });
          if (m) { m.click(); return true; }
        }

        // 5. Substring contains match
        m = opts.find((o) => o.innerText?.trim().toLowerCase().includes(answer.toLowerCase()));
        if (m) { m.click(); return true; }

        return false;
      }, ans).catch(() => false);

      if (clicked) {
        await this.sleep(800);
        await page.evaluate(() => {
          const cb = document.querySelector('.chatbot_DrawerContentWrapper, [class*="chatbot"]');
          if (!cb) return;
          const sendBtn = cb.querySelector('[class*="sendMsg"], button[type="submit"], [class*="send-btn"], button:has-text("Save"), button:has-text("Submit"), button:has-text("Send"), button:has-text("Next"), button.blue-btn');
          if (sendBtn) sendBtn.click();
        }).catch(() => {});
        continue;
      }

      const typed = await page.evaluate((answer) => {
        const cb = document.querySelector('.chatbot_DrawerContentWrapper, [class*="chatbot"]');
        if (!cb) return false;
        const ed = cb.querySelector('[contenteditable="true"]');
        if (ed) {
          ed.focus();
          ed.innerText = answer;
          ed.dispatchEvent(new InputEvent('input', { bubbles: true, data: answer }));
          return true;
        }
        const ta = cb.querySelector('textarea, input[type="text"]');
        if (ta) {
          ta.focus(); ta.value = answer;
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        }
        return false;
      }, ans).catch(() => false);

      if (!typed) return 'unknown';
      await this.sleep(400);
      await page.keyboard.press('Enter').catch(() => {});
      await this.sleep(300);
      await page.evaluate(() => {
        const cb = document.querySelector('.chatbot_DrawerContentWrapper, [class*="chatbot"]');
        cb?.querySelector('[class*="sendMsg"], button[type="submit"], [class*="send-btn"]')?.click();
      }).catch(() => {});
    }

    return 'timeout';
  }

  async processJob(context, page, job) {
    // 1. Immediate pre-navigation company check
    if (this.isBlacklistedCompany(job.company, job.title, job.url)) {
      return { status: 'skipped', notes: `Excluded company: ${job.company || 'Infosys'} (interview already completed)` };
    }

    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await this.sleep(2200);

    // 2. On-page verified company check
    const onPageCompany = await page.evaluate(() => {
      const el = document.querySelector('a.subTitle, a.comp-name, .companyInfo a, .comp-dtls a, .styles_job-header-comp-name__MQU09');
      return el ? el.innerText.trim() : '';
    }).catch(() => '');

    if (onPageCompany && this.isBlacklistedCompany(onPageCompany, job.title, job.url)) {
      return { status: 'skipped', notes: `Excluded company: ${onPageCompany} (interview already completed)` };
    }

    const info = await page.evaluate(() => {
      const apply = document.getElementById('apply-button') ||
        Array.from(document.querySelectorAll('button, a')).find((el) => {
          const t = (el.innerText || el.getAttribute('title') || '').trim().toLowerCase();
          return t === 'apply' || t === 'apply now' || el.classList.contains('apply-button');
        });

      const company = document.getElementById('company-site-button') ||
        Array.from(document.querySelectorAll('button, a, div')).find((el) =>
          /apply on company site|apply on website|company site|external site/i.test(el.innerText || el.getAttribute('title') || '')
        );

      const alreadyApplied = !!document.querySelector('[class*="already-applied"]') ||
        Array.from(document.querySelectorAll('button, a, div, span')).some((el) =>
          /^applied$/i.test(el.innerText?.trim()) || /already applied/i.test(el.innerText || '')
        );

      return { hasApply: !!apply, hasCompany: !!company, alreadyApplied };
    }).catch(() => ({ hasApply: false, hasCompany: false, alreadyApplied: false }));

    if (info.alreadyApplied) return { status: 'already_applied', notes: 'Already applied previously' };

    // External company portal auto-apply
    if (!info.hasApply && info.hasCompany) {
      console.log(`  [Naukri] External company site detected. Attempting automated application on external ATS...`);
      const extResult = await this.externalApplicant.applyFromNaukri(context, page, job);
      return extResult;
    }

    // If Naukri daily in-platform quota was already exceeded, skip in-platform job
    if (this.naukriQuotaExceeded && info.hasApply) {
      return { status: 'skipped', notes: 'Skipped - In-platform daily quota reached for today' };
    }

    if (!info.hasApply) return { status: 'skipped', notes: 'No apply button found' };

    // Setup listener in case apply button triggers an external popup / career site redirect
    const popupPromise = context.waitForEvent('page', { timeout: 4000 }).catch(() => null);

    // Click Apply
    const clickedApply = await page.evaluate(() => {
      const btn = document.getElementById('apply-button') ||
        Array.from(document.querySelectorAll('button, a')).find((el) => {
          const t = (el.innerText || el.getAttribute('title') || '').trim().toLowerCase();
          return t === 'apply' || t === 'apply now' || el.classList.contains('apply-button');
        });
      if (btn) { btn.click(); return true; }
      return false;
    }).catch(() => false);

    if (!clickedApply) return { status: 'skipped', notes: 'Apply button click failed' };

    const externalPopup = await popupPromise;
    if (externalPopup) {
      console.log('  [Naukri] Apply button opened external application window!');
      const extResult = await this.externalApplicant.executeApplication(externalPopup, job);
      await externalPopup.close().catch(() => {});
      return extResult;
    }

    await this.sleep(2500);

    // Handle interstitials & questionnaire dialogs (e.g. Relocation, Notice, Experience)
    await page.evaluate(() => {
      const dialogs = Array.from(document.querySelectorAll('.modal, .drawer, [class*="modal"], [class*="dialog"], [class*="popup"], [class*="question"], form, div[id*="apply"]'));
      for (const d of dialogs) {
        if (!d.offsetParent && d.offsetWidth === 0) continue;
        const text = (d.innerText || '').toLowerCase();

        // Relocation question on modal -> select Yes
        if (text.includes('relocate') || text.includes('relocation') || text.includes('location')) {
          const radios = Array.from(d.querySelectorAll('input[type="radio"], [role="radio"]'));
          for (const r of radios) {
            const pLabel = r.closest('label') || r.parentElement;
            const forLabel = r.id ? document.querySelector(`label[for="${r.id}"]`) : null;
            const lbl = [r.value, pLabel?.innerText || '', forLabel?.innerText || '', r.nextElementSibling?.innerText || ''].join(' ').toLowerCase();
            if (/^yes\b|\byes\b/i.test(lbl) || r.value.toLowerCase() === 'yes') {
              r.checked = true;
              r.click();
              r.dispatchEvent(new Event('input', { bubbles: true }));
              r.dispatchEvent(new Event('change', { bubbles: true }));
              if (pLabel) pLabel.click();
              if (forLabel) forLabel.click();
              break;
            }
          }
          const customRadios = Array.from(d.querySelectorAll('[class*="ssrc__radio"], [class*="radio"], [class*="chip"], label'));
          for (const cr of customRadios) {
            const t = cr.innerText?.trim().toLowerCase() || '';
            if (/^yes\b|\byes$/i.test(t)) {
              cr.click();
              break;
            }
          }
        }
      }

      // Click proceed / save & apply
      const proceedBtn = Array.from(document.querySelectorAll('button, a, div')).find((el) =>
        /apply without updating|skip and apply|proceed to apply|save & apply|submit application/i.test(el.innerText || '')
      );
      if (proceedBtn && !proceedBtn.id?.includes('company-site')) proceedBtn.click();
    }).catch(() => {});

    const post = await page.evaluate(() => {
      const text = document.body ? document.body.innerText : '';
      const quotaHit = /daily quota of jobs exceeded|error while processing your request/i.test(text);
      const successAnchor = /applied successfully|successfully applied|application has been received|application sent|application submitted/i.test(text) ||
        Array.from(document.querySelectorAll('button, div, span, a')).some((el) => /^applied$/i.test(el.innerText?.trim()));
      const chatbotOpen = !!document.querySelector('.chatbot_DrawerContentWrapper, [class*="chatbot"]');
      return { successAnchor, chatbotOpen, quotaHit };
    }).catch(() => ({ successAnchor: false, chatbotOpen: false, quotaHit: false }));

    if (post.quotaHit) return { status: 'quota_exceeded', notes: 'Naukri daily apply quota reached' };
    if (post.successAnchor && !post.chatbotOpen) return { status: 'applied', notes: 'Naukri 1-Click quick apply' };

    if (post.chatbotOpen) {
      const r = await this.handleChatbot(page);
      return {
        status: r === 'success' ? 'applied' : 'skipped',
        notes: `Naukri chatbot result: ${r}`,
      };
    }

    return { status: 'applied', notes: 'Naukri application submitted' };
  }

  async run() {
    console.log(`\n======================================================`);
    console.log(`🚀 Starting Naukri Auto-Apply`);
    console.log(`Target: ${this.options.limit === Infinity ? 'ALL AVAILABLE JOBS (No Cap)' : this.options.limit + ' applications'}`);
    console.log(`Mode:   ${this.options.headless ? 'HEADLESS' : 'HEADED'}`);
    console.log(`Search: ${this.options.keywords.join(', ')}`);
    console.log(`======================================================\n`);

    const { context, page } = await this.browserManager.launch({ headless: this.options.headless });
    let appliedCount = 0;

    try {
      await this.ensureLoggedIn(page);
      const searchUrls = this.buildSearchUrls();
      const maxPages = this.options.maxPages || 25;

      for (const baseUrl of searchUrls) {
        if (appliedCount >= this.options.limit) break;

        for (let p = 1; p <= maxPages && appliedCount < this.options.limit; p++) {
          const pageUrl = baseUrl + `&pageNo=${p}`;
          console.log(`\n[Naukri] Scanning: ${pageUrl}`);
          await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
          await this.sleep(2500);

          const jobCards = await page.evaluate(() => {
            const titleAnchors = Array.from(document.querySelectorAll('a.title, a.job-title, [class*="title"] a'));
            return titleAnchors.map((a) => {
              const card = a.closest('div.srp-jobtuple-wrapper, div.jobTuple, article, [class*="jobTuple"]') || a.parentElement?.parentElement;
              const text = (sel) => card?.querySelector(sel)?.innerText?.trim() || '';
              return {
                title: a.innerText.trim(),
                url: a.href,
                company: text('a.subTitle, a.comp-name, .companyInfo a, .comp-dtls a') || text('span.subTitle') || 'Unknown',
                location: text('span.locWdth, .loc, .locations span') || text('.styles_locations__yRPSz') || 'India',
              };
            }).filter((j) => j.title && j.url);
          }).catch(() => []);

          if (jobCards.length === 0) {
            console.log(`[Naukri] No jobs found on page ${p}. Moving to next search query.`);
            break;
          }

          console.log(`[Naukri] Found ${jobCards.length} jobs on page ${p}`);

          for (const job of jobCards) {
            if (appliedCount >= this.options.limit) break;

            // Deduplication check
            if (tracker.has(job.url)) {
              console.log(`  ⏩ Skipping [Already in Tracker]: ${job.title} at ${job.company}`);
              continue;
            }

            // Company blacklist check (e.g. Infosys)
            if (this.isBlacklistedCompany(job.company, job.title, job.url)) {
              console.log(`  ⏩ Skipping [Excluded Company: ${job.company}]: ${job.title}`);
              tracker.recordSkipped({
                platform: 'Naukri',
                title: job.title,
                company: job.company,
                location: job.location,
                applyUrl: job.url,
                notes: `Excluded company: ${job.company} (interview already completed)`,
              });
              continue;
            }

            // Title whitelist/blacklist filter
            if (!this.isTargetJob(job.title)) {
              tracker.recordSkipped({
                platform: 'Naukri',
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
              const result = await this.processJob(context, page, job);
              console.log(`  Result: [${result.status.toUpperCase()}] ${result.notes || ''}`);

              if (result.status === 'applied') {
                appliedCount++;
                tracker.recordApplied({
                  platform: 'Naukri',
                  title: job.title,
                  company: job.company,
                  location: job.location,
                  applyUrl: job.url,
                  externalUrl: result.externalUrl || '',
                  notes: result.notes,
                });
              } else if (result.status === 'already_applied') {
                tracker.recordSkipped({
                  platform: 'Naukri',
                  title: job.title,
                  company: job.company,
                  location: job.location,
                  applyUrl: job.url,
                  notes: result.notes || 'Already applied previously',
                });
              } else if (result.status === 'external' || result.status === 'external_visited') {
                tracker.recordExternal({
                  platform: 'Naukri',
                  title: job.title,
                  company: job.company,
                  location: job.location,
                  applyUrl: job.url,
                  externalUrl: result.externalUrl || job.url,
                  notes: result.notes,
                });
              } else if (result.status === 'quota_exceeded') {
                this.naukriQuotaExceeded = true;
                console.log('  ⚠️ [Naukri] Daily 1-click apply quota reached. Continuing scan to apply to external company portal jobs...');
                tracker.recordSkipped({
                  platform: 'Naukri',
                  title: job.title,
                  company: job.company,
                  location: job.location,
                  applyUrl: job.url,
                  notes: 'Naukri daily 1-click apply quota reached',
                });
              } else {
                tracker.recordSkipped({
                  platform: 'Naukri',
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
                platform: 'Naukri',
                title: job.title,
                company: job.company,
                location: job.location,
                applyUrl: job.url,
                notes: `Job error: ${jobErr.message}`,
              });
            }

            // Save file tracker after every job
            tracker.save();
            await this.sleep(1500);
          }
        }
      }
    } catch (err) {
      console.error('[Naukri] Execution error:', err.message);
    } finally {
      tracker.save();
      await this.browserManager.close();
      console.log(`\nNaukri run completed. New applies: ${appliedCount}`);
    }

    return appliedCount;
  }
}

module.exports = NaukriApplicant;
