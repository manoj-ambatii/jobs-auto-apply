/**
 * naukri.js
 * Naukri Job Auto-Apply workflow module.
 *
 * Supports:
 *  - Headed & Headless execution
 *  - In-platform 1-click apply & Chatbot screening questions
 *  - External company site detection & URL capturing
 *  - Real-time file-based tracking (JSON, CSV, Excel)
 *
 * ACCURACY GUARANTEE:
 *  - A job is only recorded as APPLIED when Naukri's server explicitly
 *    confirms via page text ("Applied Successfully", "Application Sent",
 *    "Applied" button state) or the apply button changes to "Applied".
 *  - No fallback "assume applied" logic. If confirmation is not found,
 *    the job is recorded as SKIPPED with a clear reason.
 */

const fs = require('fs');
const path = require('path');
const config = require('../../config');
const tracker = require('../tracker/file-tracker');
const externalApplicant = require('./external-applicant');

// ─── Filters ─────────────────────────────────────────────────────────────────
const BLACKLIST_TITLE_REGEX = /(?:\b(python|django|flask|fastapi|pandas|pyspark|dot\s*net|dotnet|\.net|c#|c\+\+|php|laravel|wordpress|ruby|rails|golang|go\s*developer|rust|ios|swift|objective-c|android|flutter|react\s*native|mobile\s*developer|qa\b|tester|testing|automation\s*test|sdet|devops|sre|cloud\s*engineer|aws\s*engineer|azure\s*engineer|salesforce|sap\b|mainframe|data\s*engineer|data\s*scientist|data\s*analyst|machine\s*learning|ai\s*engineer|deep\s*learning|nlp|computer\s*vision|big\s*data|etl|business\s*analyst|scrum\s*master|product\s*manager|sales|marketing|recruiter|hr\b|intern|internship|trainee|caller|telecaller|bpo|kpo|support)\b)/i;
const WHITELIST_TITLE_REGEX = /\b(java\s*(?:developer|full\s*stack|backend|engineer|software)|spring\s*boot|microservices?|backend\s*(?:developer|engineer|software)|full\s*stack|fullstack|node(?:\.js|\s*js)?\s*(?:developer|backend|engineer|software)|react(?:\.js|\s*js)?\s*(?:developer|full\s*stack|engineer)|software\s*(?:engineer|developer).*(?:java|backend|spring|full\s*stack))\b/i;
const BLACKLIST_COMPANY_REGEX = /\b(infosys|infosys\s*bpm|infosys\s*limited)\b/i;

// ─── Naukri success/failure text patterns ────────────────────────────────────
const SUCCESS_PATTERNS = [
  /applied\s*successfully/i,
  /successfully\s*applied/i,
  /application\s*has\s*been\s*(?:received|sent|submitted)/i,
  /application\s*sent/i,
  /application\s*submitted/i,
  /your\s*application\s*(?:is|has\s*been)\s*(?:submitted|sent|received)/i,
  /we\s*(?:have\s*)?received\s*your\s*application/i,
  /thank\s*you\s*for\s*applying/i,
];

const QUOTA_PATTERNS = [
  /daily\s*(?:quota|limit)\s*of\s*(?:jobs|applications)\s*exceeded/i,
  /you\s*have\s*reached\s*(?:your\s*)?daily\s*limit/i,
  /error\s*while\s*processing\s*your\s*request/i,
  /too\s*many\s*applications/i,
];

function matchesAny(text, patterns) {
  return patterns.some((p) => p.test(text));
}

// ─── Class ────────────────────────────────────────────────────────────────────
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
      javaOnly: options.javaOnly !== undefined
        ? options.javaOnly
        : (options.keywords ? options.keywords.every((k) => /java|spring/i.test(k)) : false),
    };
    this.candidate = config.candidate;
    this.creds = config.credentials.naukri;
    this.externalApplicant = externalApplicant;
    this.naukriQuotaExceeded = false;
  }

  // ── Utility ──────────────────────────────────────────────────────────────
  sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  isTargetJob(title) {
    if (!title) return false;
    if (BLACKLIST_TITLE_REGEX.test(title)) return false;
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
    return list.some((c) => text.includes(c.toLowerCase()));
  }

  // ── Login ─────────────────────────────────────────────────────────────────
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
      console.log(`[Naukri] Login form note: ${e.message}`);
    }

    if (page.url().includes('login')) {
      console.log('⚠️ [Naukri] CAPTCHA or security check detected!');
      if (!this.options.headless) {
        console.log('👉 Browser is visible – please complete verification in the window...');
        for (let i = 0; i < 20; i++) {
          await this.sleep(3000);
          if (!page.url().includes('login')) { console.log('[Naukri] Login cleared!'); break; }
        }
      }
    }

    if (page.url().includes('login')) {
      throw new Error('[Naukri] Login failed. Check credentials in .env or run with --mode headed.');
    }
    console.log('[Naukri] Successfully logged in.');
  }

  // ── Search URL Builder ────────────────────────────────────────────────────
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

  // ── Answer logic for screening questions ─────────────────────────────────
  answerForQuestion(q) {
    const t = (q || '').toLowerCase();
    const cand = this.candidate;

    if (/relocate|relocation|relocating|willing.*relocate|open to relocate|ready to relocate|location preference|preferred location/i.test(t)) return 'Yes';
    if (/work from office|hybrid|on-site|onsite|flexible.*location|night shift|rotational/i.test(t)) return 'Yes';
    if (/serving.*notice/.test(t)) return 'No';
    if (/offer.*in\s*hand/.test(t)) return 'No';
    if (/years?.*(experience|exp).*(java)/.test(t)) return String(cand.skillYears?.java || '2');
    if (/years?.*(experience|exp).*(spring|spring boot)/.test(t)) return String(cand.skillYears?.['spring boot'] || '2');
    if (/years?.*(experience|exp).*(microservices|micro\s*services)/.test(t)) return String(cand.skillYears?.microservices || '2');
    if (/years?.*(experience|exp).*(react)/.test(t)) return String(cand.skillYears?.react || '1');
    if (/years?.*(experience|exp).*(node|nodejs|express)/.test(t)) return String(cand.skillYears?.node || '1');
    if (/years?.*(experience|exp).*(full\s*stack|fullstack)/.test(t)) return String(cand.currentEmployment?.totalExperienceYears || '2.5');
    if (/years?.*(experience|exp)/.test(t)) return String(cand.currentEmployment?.totalExperienceYears || '2.5');
    if (/(current|present).*(ctc|salary|package)/.test(t)) return String(cand.compensationAndNotice?.currentCtcLakhs || '4.2');
    if (/(expected|expecting).*(ctc|salary|package)/.test(t)) return String(cand.compensationAndNotice?.expectedCtcLakhs || '10');
    if (/notice/.test(t)) return String(cand.compensationAndNotice?.noticePeriodDays || '0');
    if (/location|city|based/.test(t)) return cand.identity?.location || 'Hyderabad';
    if (/email/.test(t)) return cand.identity?.email || '';
    if (/phone|mobile|contact/.test(t)) return cand.identity?.phone || '';
    if (/name/.test(t)) return cand.identity?.name || 'Manoj Ambati';
    if (/qualification|degree|education|highest/.test(t)) return cand.education?.highestQualification || 'B.Tech';
    if (/immediate/.test(t)) return 'Yes';
    if (/^(are you|do you|can you|will you|have you|is it|would you)/.test(t)) return 'Yes';
    if (/how many|number of/.test(t)) return String(cand.currentEmployment?.totalExperienceYears || '2.5');
    return 'Yes';
  }

  // ── Check page for Naukri success confirmation ────────────────────────────
  async isPageShowingSuccess(page) {
    try {
      const text = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
      if (matchesAny(text, SUCCESS_PATTERNS)) return true;
      // Also check if the apply button itself changed to "Applied"
      const btnApplied = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, a, div, span'));
        return btns.some((el) => /^applied$/i.test((el.innerText || '').trim()));
      }).catch(() => false);
      return btnApplied;
    } catch {
      return false;
    }
  }

  // ── Handle Naukri chatbot screening drawer ────────────────────────────────
  async handleChatbot(page) {
    console.log('  [Naukri] Handling screening chatbot drawer...');

    for (let loop = 0; loop < 20; loop++) {
      await this.sleep(2000); // give chatbot time to render each new question

      // Check page-level success first (chatbot may auto-close after last answer)
      const bodyText = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
      if (matchesAny(bodyText, SUCCESS_PATTERNS)) {
        console.log('  [Naukri] ✅ Chatbot: Application confirmed via page text.');
        return 'success';
      }

      const state = await page.evaluate(() => {
        const cb = document.querySelector('.chatbot_DrawerContentWrapper, [class*="chatbot_Drawer"], [class*="chatbot"]');
        if (!cb) return { open: false, question: '', hasInput: false, hasOptions: false };

        // Collect latest bot message
        const botMsgs = cb.querySelectorAll(
          '[class*="bot-msg"], [class*="botMessage"], [class*="msg-text"], [class*="question"], .msg, p, h3, h4, span'
        );
        let question = '';
        botMsgs.forEach((el) => {
          const t = el.innerText?.trim() || '';
          if (t.length > 5) question = t; // take last non-trivial text
        });

        // Add context clues
        const cbText = (cb.innerText || '').toLowerCase();
        if (/relocate|relocation/i.test(cbText)) question += ' relocate';
        if (/notice/i.test(cbText) && !/relocate/i.test(cbText)) question += ' notice period';

        const hasInput = !!(
          cb.querySelector('input[type="text"], input[type="number"], textarea, [contenteditable="true"]')
        );
        const hasOptions = !!(
          cb.querySelector('input[type="radio"], [role="radio"], [class*="ssrc__radio"], [class*="chip"], [class*="option"], label, button:not([class*="send"])')
        );

        return { open: true, question: question.trim(), hasInput, hasOptions };
      }).catch(() => ({ open: false, question: '', hasInput: false, hasOptions: false }));

      if (!state.open) {
        // Chatbot closed – check if that means success
        await this.sleep(1500);
        if (await this.isPageShowingSuccess(page)) {
          console.log('  [Naukri] ✅ Chatbot closed with success confirmation.');
          return 'success';
        }
        console.log('  [Naukri] Chatbot drawer closed without success confirmation.');
        return 'closed_no_confirm';
      }

      const question = state.question;
      const ans = this.answerForQuestion(question);
      console.log(`  [Chatbot Q${loop + 1}]: "${question.slice(0, 80)}" → Answer: "${ans}"`);

      // ── Try selecting a radio/chip/option ──────────────────────────────
      const selected = await page.evaluate((answer) => {
        const cb = document.querySelector('.chatbot_DrawerContentWrapper, [class*="chatbot_Drawer"], [class*="chatbot"]');
        if (!cb) return false;

        const ansLower = answer.toLowerCase();
        const isYes = ansLower === 'yes';
        const isNo = ansLower === 'no';

        // 1. Native radio inputs
        const radios = Array.from(cb.querySelectorAll('input[type="radio"], [role="radio"]'));
        for (const r of radios) {
          const parentLabel = r.closest('label') || r.parentElement;
          const forLabel = r.id ? cb.querySelector(`label[for="${r.id}"]`) : null;
          const labelText = [
            r.value || '',
            r.getAttribute('aria-label') || '',
            parentLabel?.innerText || '',
            forLabel?.innerText || '',
            r.nextElementSibling?.innerText || '',
          ].join(' ').toLowerCase().trim();

          const yesMatch = isYes && (/^yes\b|\byes\b/i.test(labelText) || r.value?.toLowerCase() === 'yes');
          const noMatch = isNo && (/^no\b|\bno\b/i.test(labelText) || r.value?.toLowerCase() === 'no');
          const valMatch = !isYes && !isNo && labelText.includes(ansLower);

          if (yesMatch || noMatch || valMatch) {
            r.checked = true;
            r.click();
            r.dispatchEvent(new Event('input', { bubbles: true }));
            r.dispatchEvent(new Event('change', { bubbles: true }));
            if (parentLabel) parentLabel.click();
            if (forLabel) forLabel.click();
            return true;
          }
        }

        // 2. Custom styled radio / chip wrappers
        const wrappers = Array.from(cb.querySelectorAll(
          '[class*="ssrc__radio"], [class*="radio"], [class*="chip"], [class*="option"], label, li'
        ));
        for (const w of wrappers) {
          const txt = (w.innerText || '').trim().toLowerCase();
          if (!txt || txt.length > 60) continue;
          if (isYes && /^yes$|^yes\s/i.test(txt)) {
            w.click();
            w.querySelector('input[type="radio"]')?.click();
            return true;
          }
          if (isNo && /^no$|^no\s/i.test(txt)) {
            w.click();
            w.querySelector('input[type="radio"]')?.click();
            return true;
          }
        }

        // 3. Button / span options – exact match first
        const clickables = Array.from(cb.querySelectorAll('button, span, div[class*="option"]')).filter((el) => {
          const t = (el.innerText || '').trim();
          return t && t.length < 60;
        });
        let m = clickables.find((o) => (o.innerText || '').trim().toLowerCase() === ansLower);
        if (m) { m.click(); return true; }

        // 4. Numeric range match (e.g. answer "2.5" vs option "2-3 yrs")
        const num = parseFloat(answer);
        if (!isNaN(num)) {
          m = clickables.find((o) => {
            const t = (o.innerText || '').trim().toLowerCase();
            const range = t.match(/(\d+(?:\.\d+)?)\s*(?:-|to)\s*(\d+(?:\.\d+)?)/i);
            if (range && num >= parseFloat(range[1]) && num <= parseFloat(range[2])) return true;
            if (/2\.5|2\+|2-3|1-3|2 - 3|1 - 3/i.test(t)) return true;
            return false;
          });
          if (m) { m.click(); return true; }
        }

        // 5. Contains-match fallback
        m = clickables.find((o) => (o.innerText || '').trim().toLowerCase().includes(ansLower));
        if (m) { m.click(); return true; }

        return false;
      }, ans).catch(() => false);

      if (selected) {
        await this.sleep(600);
        // Click Send / Next / Submit / Save button inside chatbot using Playwright Locators
        try {
          const cb = page.locator('.chatbot_DrawerContentWrapper, [class*="chatbot_Drawer"], [class*="chatbot"]').first();
          const btn = cb.locator('button:has-text("Save"), button:has-text("Submit"), button:has-text("Send"), button:has-text("Next"), [class*="sendMsg"], button[type="submit"], [class*="send-btn"], button.blue-btn, [class*="btn-primary"]').first();
          
          if (await btn.isVisible({ timeout: 1000 })) {
            await btn.scrollIntoViewIfNeeded();
            await btn.click({ timeout: 2000 });
          } else {
            // Fallback: search the whole page if it's rendered outside the drawer box
            const globalBtn = page.locator('button:has-text("Save"), button:has-text("Submit")').first();
            if (await globalBtn.isVisible({ timeout: 1000 })) {
              await globalBtn.scrollIntoViewIfNeeded();
              await globalBtn.click({ timeout: 2000 });
            }
          }
        } catch (e) {}
        await this.sleep(1000);
        continue;
      }

      // ── Fallback: type the answer into a text / number input ───────────
      const typed = await page.evaluate((answer) => {
        const cb = document.querySelector('.chatbot_DrawerContentWrapper, [class*="chatbot_Drawer"], [class*="chatbot"]');
        if (!cb) return false;
        // contenteditable
        const ce = cb.querySelector('[contenteditable="true"]');
        if (ce) {
          ce.focus();
          ce.innerText = answer;
          ce.dispatchEvent(new InputEvent('input', { bubbles: true, data: answer }));
          return true;
        }
        // textarea / text input
        const inp = cb.querySelector('textarea, input[type="text"], input[type="number"]');
        if (inp) {
          inp.focus();
          inp.value = answer;
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
        return false;
      }, ans).catch(() => false);

      if (typed) {
        await this.sleep(500);
        await page.keyboard.press('Enter').catch(() => {});
        await this.sleep(500);
        // Also try clicking send/save button using Playwright Locators
        try {
          const cb = page.locator('.chatbot_DrawerContentWrapper, [class*="chatbot_Drawer"], [class*="chatbot"]').first();
          const btn = cb.locator('button:has-text("Save"), button:has-text("Submit"), button:has-text("Send"), button:has-text("Next"), [class*="sendMsg"], button[type="submit"], [class*="send-btn"], button.blue-btn, [class*="btn-primary"]').first();
          
          if (await btn.isVisible({ timeout: 1000 })) {
            await btn.scrollIntoViewIfNeeded();
            await btn.click({ timeout: 2000 });
          } else {
            // Fallback: search the whole page if it's rendered outside the drawer box
            const globalBtn = page.locator('button:has-text("Save"), button:has-text("Submit")').first();
            if (await globalBtn.isVisible({ timeout: 1000 })) {
              await globalBtn.scrollIntoViewIfNeeded();
              await globalBtn.click({ timeout: 2000 });
            }
          }
        } catch (e) {}
        await this.sleep(800);
      } else {
        // Nothing matched — wait one more cycle, chatbot may still be loading
        console.log(`  [Chatbot] No answer element found on loop ${loop + 1}. Waiting for chatbot to update...`);
        await this.sleep(2000);
      }
    }

    // After all loops, check final state
    if (await this.isPageShowingSuccess(page)) return 'success';
    return 'timeout';
  }

  // ── Handle all Naukri interstitial modals after clicking Apply ────────────
  /**
   * After clicking the Naukri "Apply" button, several modals can appear:
   *  1. Experience mismatch: "Recruiter is looking for X+ yrs. Apply anyway?"
   *  2. Profile update nudge: "Apply without updating" / "Skip and Apply"
   *  3. Relocation / Notice period confirmation form
   *  4. Screening chatbot drawer
   *
   * This method handles all of them in a loop until the page reaches a
   * confirmed success state or we exhaust retries.
   */
  async handlePostApplyModals(page) {
    const MAX_MODAL_LOOPS = 8;

    for (let loop = 0; loop < MAX_MODAL_LOOPS; loop++) {
      await this.sleep(2500); // wait for modal/page to settle

      // --- Check for quota error first ---
      const bodyText = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
      if (matchesAny(bodyText, QUOTA_PATTERNS)) return { done: true, result: 'quota_exceeded' };

      // --- Check for confirmed success ---
      if (matchesAny(bodyText, SUCCESS_PATTERNS)) return { done: true, result: 'success' };
      const btnApplied = await page.evaluate(() =>
        Array.from(document.querySelectorAll('button, a, div, span'))
          .some((el) => /^applied$/i.test((el.innerText || '').trim()))
      ).catch(() => false);
      if (btnApplied) return { done: true, result: 'success' };

      // --- Check if chatbot opened ---
      const chatbotOpen = await page.evaluate(() =>
        !!document.querySelector('.chatbot_DrawerContentWrapper, [class*="chatbot_Drawer"], [class*="chatbot"]')
      ).catch(() => false);
      if (chatbotOpen) {
        const cbResult = await this.handleChatbot(page);
        if (cbResult === 'success') return { done: true, result: 'success' };
        // Chatbot closed but no confirm - continue outer loop to check for other modals
        continue;
      }

      // --- Look for and handle modals/dialogs ---
      const modalAction = await page.evaluate(() => {
        // Priority button texts to click (in order of preference)
        const PROCEED_TEXTS = [
          /apply\s*anyway/i,
          /apply\s*without\s*updating/i,
          /skip\s*and\s*apply/i,
          /proceed\s*to\s*apply/i,
          /save\s*&?\s*apply/i,
          /submit\s*application/i,
          /confirm\s*and\s*apply/i,
          /yes,?\s*apply/i,
        ];

        const allBtns = Array.from(document.querySelectorAll('button, a[role="button"], div[role="button"]'));

        for (const pattern of PROCEED_TEXTS) {
          const btn = allBtns.find((b) => {
            const t = (b.innerText || b.textContent || '').trim();
            return pattern.test(t) && !b.id?.includes('company-site');
          });
          if (btn) {
            btn.click();
            return { clicked: true, text: (btn.innerText || '').trim() };
          }
        }

        // Handle "Yes" radio/checkbox for relocation questions in visible modals
        const modals = Array.from(document.querySelectorAll(
          '.modal, .drawer, [class*="modal"], [class*="dialog"], [class*="popup"], [class*="overlay"], form[class*="apply"]'
        )).filter((el) => el.offsetParent !== null || el.offsetWidth > 0);

        for (const modal of modals) {
          const mText = (modal.innerText || '').toLowerCase();
          if (/relocate|relocation|location/i.test(mText)) {
            // Select Yes for relocation
            const radios = Array.from(modal.querySelectorAll('input[type="radio"], [role="radio"]'));
            for (const r of radios) {
              const lbl = (r.closest('label')?.innerText || r.parentElement?.innerText || r.value || '').toLowerCase();
              if (/^yes\b|\byes\b/i.test(lbl) || r.value?.toLowerCase() === 'yes') {
                r.checked = true;
                r.click();
                r.dispatchEvent(new Event('change', { bubbles: true }));
                break;
              }
            }
            const chips = Array.from(modal.querySelectorAll('[class*="ssrc__radio"], [class*="chip"], label'));
            for (const c of chips) {
              if (/^yes$/i.test((c.innerText || '').trim())) { c.click(); break; }
            }
          }
          if (/notice.*period|notice/i.test(mText)) {
            // Select Immediate/0 days for notice period
            const radios = Array.from(modal.querySelectorAll('input[type="radio"], [role="radio"]'));
            for (const r of radios) {
              const lbl = (r.closest('label')?.innerText || r.value || '').toLowerCase();
              if (/immediate|0|zero/i.test(lbl)) {
                r.checked = true;
                r.click();
                r.dispatchEvent(new Event('change', { bubbles: true }));
                break;
              }
            }
          }
        }

        return { clicked: false };
      }).catch(() => ({ clicked: false }));

      if (modalAction.clicked) {
        console.log(`  [Naukri] ✅ Clicked modal button: "${modalAction.text}"`);
        await this.sleep(2000); // wait for page to process the click
        continue; // re-check success in next loop iteration
      }

      // --- No recognizable modal, no success, no chatbot --- give it one more wait
      await this.sleep(1500);
    }

    // Final check after all loops
    if (await this.isPageShowingSuccess(page)) return { done: true, result: 'success' };
    return { done: true, result: 'unconfirmed' };
  }

  // ── Process a single job listing ─────────────────────────────────────────
  async processJob(context, page, job) {
    // Pre-navigation company check
    if (this.isBlacklistedCompany(job.company, job.title, job.url)) {
      return { status: 'skipped', notes: `Excluded company: ${job.company} (blacklisted)` };
    }

    // Navigate to job page
    try {
      await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    } catch (navErr) {
      console.log(`  [Naukri] Navigation error: ${navErr.message}`);
      return { status: 'failed', notes: `Navigation failed: ${navErr.message}` };
    }
    await this.sleep(3000); // allow lazy-loaded buttons to render

    // On-page company check (may differ from search card)
    const onPageCompany = await page.evaluate(() => {
      const el = document.querySelector(
        'a.subTitle, a.comp-name, .companyInfo a, .comp-dtls a, ' +
        '.styles_job-header-comp-name__MQU09, [class*="comp-name"]'
      );
      return el ? el.innerText.trim() : '';
    }).catch(() => '');
    if (onPageCompany && this.isBlacklistedCompany(onPageCompany, job.title, job.url)) {
      return { status: 'skipped', notes: `Excluded company: ${onPageCompany} (blacklisted)` };
    }

    // Detect page buttons
    const info = await page.evaluate(() => {
      const allBtns = Array.from(document.querySelectorAll('button, a, div'));

      const applyBtn = document.getElementById('apply-button') ||
        allBtns.find((el) => {
          const t = (el.innerText || el.getAttribute('title') || '').trim().toLowerCase();
          return t === 'apply' || t === 'apply now' || el.classList.contains('apply-button');
        });

      const companySiteBtn = document.getElementById('company-site-button') ||
        allBtns.find((el) =>
          /apply on company site|apply on website|company site|external site/i.test(
            el.innerText || el.getAttribute('title') || ''
          )
        );

      const alreadyApplied =
        !!document.querySelector('[class*="already-applied"]') ||
        allBtns.some((el) =>
          /^applied$/i.test((el.innerText || '').trim()) ||
          /already applied/i.test(el.innerText || '')
        );

      return {
        hasApply: !!applyBtn,
        hasCompany: !!companySiteBtn,
        alreadyApplied,
      };
    }).catch(() => ({ hasApply: false, hasCompany: false, alreadyApplied: false }));

    if (info.alreadyApplied) {
      return { status: 'already_applied', notes: 'Already applied to this job previously' };
    }

    // ── External company portal ──────────────────────────────────────────
    if (!info.hasApply && info.hasCompany) {
      console.log('  [Naukri] External company site detected. Handing off to ExternalApplicant...');
      const extResult = await this.externalApplicant.applyFromNaukri(context, page, job);
      return extResult;
    }

    // ── Both buttons missing ─────────────────────────────────────────────
    if (!info.hasApply && !info.hasCompany) {
      // Retry once – some pages lazy-load buttons
      await this.sleep(3000);
      const retryInfo = await page.evaluate(() => {
        const allBtns = Array.from(document.querySelectorAll('button, a'));
        const applyBtn = document.getElementById('apply-button') ||
          allBtns.find((el) => {
            const t = (el.innerText || el.getAttribute('title') || '').trim().toLowerCase();
            return t === 'apply' || t === 'apply now' || el.classList.contains('apply-button');
          });
        const companySiteBtn = document.getElementById('company-site-button') ||
          allBtns.find((el) =>
            /apply on company site|apply on website|company site/i.test(el.innerText || el.getAttribute('title') || '')
          );
        return { hasApply: !!applyBtn, hasCompany: !!companySiteBtn };
      }).catch(() => ({ hasApply: false, hasCompany: false }));

      if (retryInfo.hasCompany) {
        console.log('  [Naukri] External site found on retry. Handing off...');
        const extResult = await this.externalApplicant.applyFromNaukri(context, page, job);
        return extResult;
      }
      if (!retryInfo.hasApply) {
        return { status: 'skipped', notes: 'No apply button found (page may require login or job expired)' };
      }
    }

    // ── Skip in-platform if daily quota already hit ───────────────────────
    if (this.naukriQuotaExceeded) {
      return { status: 'skipped', notes: 'In-platform daily quota reached; only external sites processed' };
    }

    // ── Setup popup listener BEFORE clicking Apply ────────────────────────
    const popupPromise = context.waitForEvent('page', { timeout: 6000 }).catch(() => null);

    // Click the Apply button
    const clickedApply = await page.evaluate(() => {
      const btn = document.getElementById('apply-button') ||
        Array.from(document.querySelectorAll('button, a')).find((el) => {
          const t = (el.innerText || el.getAttribute('title') || '').trim().toLowerCase();
          return t === 'apply' || t === 'apply now' || el.classList.contains('apply-button');
        });
      if (btn) { btn.click(); return true; }
      return false;
    }).catch(() => false);

    if (!clickedApply) {
      return { status: 'skipped', notes: 'Apply button click failed' };
    }

    // ── Check if a popup (new tab) was opened ─────────────────────────────
    const externalPopup = await popupPromise;
    if (externalPopup) {
      console.log('  [Naukri] Apply button opened an external popup window!');
      try {
        await externalPopup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        await this.sleep(2000);
        const extResult = await this.externalApplicant.executeApplication(externalPopup, job);
        await externalPopup.close().catch(() => {});
        return extResult;
      } catch (popErr) {
        await externalPopup.close().catch(() => {});
        return { status: 'failed', notes: `Popup apply error: ${popErr.message}` };
      }
    }

    // ── Handle all post-click modals and wait for server confirmation ─────
    console.log('  [Naukri] Apply clicked. Waiting for confirmation / modals...');
    const modalResult = await this.handlePostApplyModals(page);

    if (modalResult.result === 'quota_exceeded') {
      this.naukriQuotaExceeded = true;
      return { status: 'quota_exceeded', notes: 'Naukri daily apply quota reached' };
    }

    if (modalResult.result === 'success') {
      return { status: 'applied', notes: 'Naukri application confirmed by server' };
    }

    // result === 'unconfirmed' → we never got a success banner
    return {
      status: 'skipped',
      notes: 'Apply clicked but no server confirmation received (modal may have needed manual action)',
    };
  }

  // ── Main run loop ─────────────────────────────────────────────────────────
  async run() {
    console.log('\n======================================================');
    console.log('🚀 Starting Naukri Auto-Apply');
    console.log(`Target: ${this.options.limit === Infinity ? 'ALL AVAILABLE JOBS (No Cap)' : this.options.limit + ' applications'}`);
    console.log(`Mode:   ${this.options.headless ? 'HEADLESS' : 'HEADED (Visible Window)'}`);
    console.log(`Search: ${this.options.keywords.join(', ')}`);
    console.log(`Locations: ${this.options.locations.join(', ')}`);
    console.log('======================================================\n');

    const { context, page } = await this.browserManager.launch({ headless: this.options.headless });
    let appliedCount = 0;
    let sessionProcessed = 0;

    try {
      await this.ensureLoggedIn(page);
      const searchUrls = this.buildSearchUrls();
      const maxPages = this.options.maxPages || 25;

      for (const baseUrl of searchUrls) {
        if (appliedCount >= this.options.limit) break;

        for (let p = 1; p <= maxPages && appliedCount < this.options.limit; p++) {
          const pageUrl = `${baseUrl}&pageNo=${p}`;
          console.log(`\n[Naukri] Scanning page ${p}: ${pageUrl}`);

          try {
            await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
          } catch {
            console.log(`[Naukri] Failed to load search page ${p}, skipping.`);
            break;
          }
          await this.sleep(3000);

          // Collect all job cards on this search page
          const jobCards = await page.evaluate(() => {
            const titleAnchors = Array.from(document.querySelectorAll(
              'a.title, a.job-title, [class*="title"] a, [class*="jobTitle"] a'
            ));
            return titleAnchors.map((a) => {
              const card = a.closest(
                'div.srp-jobtuple-wrapper, div.jobTuple, article, [class*="jobTuple"], [class*="job-tuple"]'
              ) || a.parentElement?.parentElement;
              const text = (sel) => card?.querySelector(sel)?.innerText?.trim() || '';
              return {
                title: a.innerText.trim(),
                url: a.href,
                company: text('a.subTitle, a.comp-name, .companyInfo a, .comp-dtls a, [class*="comp-name"]') ||
                         text('span.subTitle') || 'Unknown',
                location: text('span.locWdth, .loc, .locations span, [class*="location"]') ||
                          text('.styles_locations__yRPSz') || 'India',
              };
            }).filter((j) => j.title && j.url && j.url.startsWith('http'));
          }).catch(() => []);

          if (jobCards.length === 0) {
            console.log(`[Naukri] No jobs found on page ${p}. Moving to next search query.`);
            break;
          }

          console.log(`[Naukri] Found ${jobCards.length} jobs on page ${p}`);

          // Process each job card
          for (const job of jobCards) {
            if (appliedCount >= this.options.limit) break;

            // ── Pre-checks ───────────────────────────────────────────────
            if (tracker.has(job.url)) {
              console.log(`  ⏩ [Duplicate] Already tracked: ${job.title} @ ${job.company}`);
              continue;
            }
            if (this.isBlacklistedCompany(job.company, job.title, job.url)) {
              console.log(`  ⏩ [Blacklisted] Skipping ${job.company}: ${job.title}`);
              tracker.recordSkipped({
                platform: 'Naukri',
                title: job.title,
                company: job.company,
                location: job.location,
                applyUrl: job.url,
                notes: `Blacklisted company: ${job.company}`,
              });
              continue;
            }
            if (!this.isTargetJob(job.title)) {
              console.log(`  ⏩ [Filter] Not a target role: ${job.title}`);
              tracker.recordSkipped({
                platform: 'Naukri',
                title: job.title,
                company: job.company,
                location: job.location,
                applyUrl: job.url,
                notes: 'Job title does not match Java/Spring target filter',
              });
              continue;
            }

            // ── Process ──────────────────────────────────────────────────
            console.log(`\n👉 [${sessionProcessed + 1}] Processing: ${job.title} | ${job.company} | ${job.location}`);
            sessionProcessed++;

            try {
              const result = await this.processJob(context, page, job);
              console.log(`  → [${result.status.toUpperCase()}] ${result.notes || ''}`);

              switch (result.status) {
                case 'applied':
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
                  console.log(`  ✅ Applied (Session total: ${appliedCount})`);
                  break;

                case 'already_applied':
                  tracker.recordSkipped({
                    platform: 'Naukri',
                    title: job.title,
                    company: job.company,
                    location: job.location,
                    applyUrl: job.url,
                    notes: result.notes || 'Already applied',
                  });
                  break;

                case 'external':
                case 'external_visited':
                  tracker.recordExternal({
                    platform: 'Naukri',
                    title: job.title,
                    company: job.company,
                    location: job.location,
                    applyUrl: job.url,
                    externalUrl: result.externalUrl || job.url,
                    notes: result.notes,
                  });
                  break;

                case 'quota_exceeded':
                  console.log('  ⚠️  Naukri daily 1-click quota reached. Will continue for external site jobs.');
                  tracker.recordSkipped({
                    platform: 'Naukri',
                    title: job.title,
                    company: job.company,
                    location: job.location,
                    applyUrl: job.url,
                    notes: 'Naukri daily 1-click apply quota reached',
                  });
                  break;

                case 'skipped':
                default:
                  tracker.recordSkipped({
                    platform: 'Naukri',
                    title: job.title,
                    company: job.company,
                    location: job.location,
                    applyUrl: job.url,
                    notes: result.notes || 'Skipped',
                  });
                  break;
              }
            } catch (jobErr) {
              console.warn(`  ⚠️  Error processing ${job.title}: ${jobErr.message}`);
              tracker.recordFailed({
                platform: 'Naukri',
                title: job.title,
                company: job.company,
                location: job.location,
                applyUrl: job.url,
                notes: `Processing error: ${jobErr.message}`,
              });
            }

            // Persist after every job
            tracker.save();
            // Polite delay between jobs
            await this.sleep(2000);
          }
        }
      }
    } catch (err) {
      console.error('[Naukri] Fatal run error:', err.message);
    } finally {
      tracker.save();
      await this.browserManager.close();
      console.log(`\n======================================================`);
      console.log(`✅ Naukri session complete.`);
      console.log(`   Confirmed applied this session: ${appliedCount}`);
      console.log(`   Total jobs processed: ${sessionProcessed}`);
      console.log(`======================================================\n`);
    }

    return appliedCount;
  }
}

module.exports = NaukriApplicant;
