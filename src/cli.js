#!/usr/bin/env node

/**
 * cli.js
 * Unified command-line interface for jobs-auto-apply.
 *
 * Commands:
 *   apply   - Run job application bot (headed or headless)
 *   stats   - Show file-based tracking summary
 *   list    - Display recent applications
 *   export  - Regenerate CSV and Excel files from JSON tracker
 */

const path = require('path');
const { Command } = require('commander');
const config = require('../config');
const browserManager = require('./browser/browser-manager');
const tracker = require('./tracker/file-tracker');
const LinkedInApplicant = require('./platforms/linkedin');
const NaukriApplicant = require('./platforms/naukri');
const externalApplicant = require('./platforms/external-applicant');

const program = new Command();

program
  .name('jobs-auto-apply')
  .description('Automated multi-platform job application and file tracker using Playwright & Playwright MCP')
  .version('1.0.0');

program
  .command('apply')
  .description('Run automated job applications')
  .option('-p, --platform <platform>', 'Platform to apply on: linkedin, naukri, all', 'all')
  .option('-m, --mode <mode>', 'Browser mode: headed (visible) or headless (silent)', 'headed')
  .option('-l, --limit <number>', 'Maximum applications for this run', String(config.search.targetApplications))
  .action(async (opts) => {
    const isHeadless = opts.mode.toLowerCase() === 'headless';
    const limit = parseInt(opts.limit, 10);
    const platform = opts.platform.toLowerCase();

    console.log(`\n======================================================`);
    console.log(`  Jobs Auto-Apply - Execution Config`);
    console.log(`======================================================`);
    console.log(`  Platform:     ${platform.toUpperCase()}`);
    console.log(`  Browser Mode: ${isHeadless ? 'HEADLESS' : 'HEADED (Visible)'}`);
    console.log(`  Target Limit: ${limit}`);
    console.log(`  Data Storage: ${config.paths.data}`);
    console.log(`======================================================\n`);

    if (platform === 'linkedin' || platform === 'all') {
      const linkedin = new LinkedInApplicant(browserManager, {
        headless: isHeadless,
        limit,
      });
      await linkedin.run();
    }

    if (platform === 'naukri' || platform === 'all') {
      const naukri = new NaukriApplicant(browserManager, {
        headless: isHeadless,
        limit,
      });
      await naukri.run();
    }

    console.log('\nAll platform runs finished. Tracking files updated.');
    showStats();
  });

function showStats() {
  const summary = tracker.getSummary();
  console.log(`\n📊 Current File-Based Tracking Stats:`);
  console.log(`------------------------------------------------------`);
  console.log(`  Total Processed:  ${summary.total}`);
  console.log(`  ✅ Applied:        ${summary.applied}`);
  console.log(`  🔗 External Sites: ${summary.external}`);
  console.log(`  ⏩ Skipped:        ${summary.skipped}`);
  console.log(`  ❌ Failed:         ${summary.failed}`);
  console.log(`------------------------------------------------------`);
  console.log(`  Platform Breakdown:`, summary.byPlatform);
  console.log(`------------------------------------------------------`);
  console.log(`  📁 Files:`);
  console.log(`    - JSON:  ${config.paths.appliedJson}`);
  console.log(`    - CSV:   ${config.paths.appliedCsv}`);
  console.log(`    - Excel: ${config.paths.appliedExcel}`);
  console.log(`------------------------------------------------------\n`);
}

program
  .command('stats')
  .description('Display statistics from tracking files')
  .action(() => {
    showStats();
  });

program
  .command('list')
  .description('List recent application records')
  .option('-n, --count <number>', 'Number of records to show', '15')
  .action((opts) => {
    const count = parseInt(opts.count, 10);
    const recents = tracker.listRecent(count);

    if (recents.length === 0) {
      console.log('\nNo application records found yet. Run `npm run apply:all` to start applying!\n');
      return;
    }

    console.log(`\n📋 Recent ${recents.length} Applications:`);
    console.log('='.repeat(95));
    console.log(
      'Date'.padEnd(20) +
      'Platform'.padEnd(12) +
      'Status'.padEnd(12) +
      'Company'.padEnd(25) +
      'Job Title'
    );
    console.log('-'.repeat(95));

    for (const job of recents) {
      const date = (job.dateFormatted || job.timestamp || '').substring(0, 18).padEnd(20);
      const plat = (job.platform || '').padEnd(12);
      const stat = (job.status || '').padEnd(12);
      const comp = (job.company || '').substring(0, 22).padEnd(25);
      const title = (job.title || '').substring(0, 35);
      console.log(`${date}${plat}${stat}${comp}${title}`);
    }
    console.log('='.repeat(95) + '\n');
  });

program
  .command('export')
  .description('Force re-export JSON, CSV, and Excel tracking files')
  .action(() => {
    console.log('\nRegenerating all tracking files...');
    tracker.save();
    console.log('Done.\n');
  });

program
  .command('import [path]')
  .description('Import tracking history from legacy job-tracker.json')
  .action((customPath) => {
    const defaultLegacyPath = path.resolve(__dirname, '../../playwright-mcp/backend/data/job-tracker.json');
    const targetPath = customPath ? path.resolve(process.cwd(), customPath) : defaultLegacyPath;
    console.log(`\nImporting historical tracking from: ${targetPath}`);
    try {
      const count = tracker.importFromLegacyJson(targetPath);
      console.log(`\n✅ Successfully imported ${count} legacy jobs into current tracking files!`);
      showStats();
    } catch (err) {
      console.error(`❌ Import failed: ${err.message}`);
    }
  });

program.parse(process.argv);
