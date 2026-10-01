/**
 * browser-manager.js
 * Manages Playwright browser contexts with support for:
 *  - Both Headed and Headless execution modes
 *  - Persistent session storage (keeps LinkedIn and Naukri logins alive)
 *  - Anti-bot detection evasions
 *  - Helper navigation & interaction primitives
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const config = require('../../config');

class BrowserManager {
  constructor() {
    this.context = null;
    this.activePage = null;
    this.isHeadless = config.browser.isHeadless;
  }

  /**
   * Launch or reuse a persistent browser context.
   * @param {Object} options
   * @param {boolean} [options.headless] - Force headless or headed mode
   * @param {string} [options.profileName] - Custom profile subdirectory name
   */
  async launch(options = {}) {
    const headless = options.headless !== undefined ? options.headless : this.isHeadless;
    const profileName = options.profileName || 'default-session';
    const profileDir = path.join(config.paths.browserProfile, profileName);

    if (!fs.existsSync(profileDir)) {
      fs.mkdirSync(profileDir, { recursive: true });
    }

    console.log(`[BrowserManager] Launching browser:`);
    console.log(`  -> Mode:    ${headless ? 'HEADLESS (Background)' : 'HEADED (Visible Window)'}`);
    console.log(`  -> Profile: ${profileDir}`);

    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--window-size=1366,900',
    ];

    try {
      this.context = await chromium.launchPersistentContext(profileDir, {
        headless,
        channel: 'chrome', // Use installed Chrome if available for max stealth
        args: launchArgs,
        viewport: config.browser.viewport,
        userAgent: config.browser.userAgent,
        ignoreHTTPSErrors: true,
      });
    } catch {
      // Fallback to bundled chromium if Google Chrome channel isn't installed
      console.log(`[BrowserManager] Chrome channel not found, falling back to bundled Chromium.`);
      this.context = await chromium.launchPersistentContext(profileDir, {
        headless,
        args: launchArgs,
        viewport: config.browser.viewport,
        userAgent: config.browser.userAgent,
        ignoreHTTPSErrors: true,
      });
    }

    // Anti-detection initialization
    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = { runtime: {} };
    });

    const pages = this.context.pages();
    this.activePage = pages.length > 0 ? pages[0] : await this.context.newPage();
    this.activePage.setDefaultTimeout(config.browser.timeout);

    return { context: this.context, page: this.activePage };
  }

  async getPage() {
    if (!this.activePage || this.activePage.isClosed()) {
      if (!this.context) {
        throw new Error('Browser context not launched. Call launch() first.');
      }
      this.activePage = await this.context.newPage();
    }
    return this.activePage;
  }

  async sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async close() {
    if (this.context) {
      console.log('[BrowserManager] Closing browser context.');
      await this.context.close().catch(() => {});
      this.context = null;
      this.activePage = null;
    }
  }
}

module.exports = new BrowserManager();
