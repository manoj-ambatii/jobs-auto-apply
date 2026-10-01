/**
 * file-tracker.js
 * Comprehensive file-based job application tracker.
 *
 * Stores all tracking data in files directly:
 *  - JSON: data/applied-jobs.json
 *  - CSV:  data/applied-jobs.csv
 *  - XLSX: data/job-applications.xlsx (Sheets: Applied, External, Skipped, Failed)
 *  - Cache: data/tracker-cache.json (O(1) deduplication by normalized URL)
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const config = require('../../config');

class FileTracker {
  constructor() {
    this.paths = config.paths;
    this.jobs = []; // Array of all job application records
    this.cache = {}; // Normalized URL -> job metadata
    this.sheets = {
      applied: { name: 'Applied', rows: [] },
      external: { name: 'External', rows: [] },
      skipped: { name: 'Skipped', rows: [] },
      failed: { name: 'Failed', rows: [] },
    };
    this.counters = { applied: 0, external: 0, skipped: 0, failed: 0 };
    this.initialized = false;
  }

  normalizeUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    try {
      const parsed = new URL(rawUrl);
      // Strip tracking queries for clean deduplication
      return `${parsed.origin}${parsed.pathname}`.toLowerCase().replace(/\/+$/, '');
    } catch {
      return rawUrl.trim().toLowerCase().split('?')[0].replace(/\/+$/, '');
    }
  }

  now() {
    return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  }

  init() {
    if (this.initialized) return;

    if (!fs.existsSync(this.paths.data)) {
      fs.mkdirSync(this.paths.data, { recursive: true });
    }

    // 1. Load JSON history if present
    if (fs.existsSync(this.paths.appliedJson)) {
      try {
        const raw = fs.readFileSync(this.paths.appliedJson, 'utf8');
        this.jobs = JSON.parse(raw);
        if (!Array.isArray(this.jobs)) this.jobs = [];
      } catch (err) {
        console.warn(`[FileTracker] Could not parse applied-jobs.json: ${err.message}. Starting fresh.`);
        this.jobs = [];
      }
    }

    // 2. Load fast deduplication cache
    if (fs.existsSync(this.paths.trackerCache)) {
      try {
        const raw = fs.readFileSync(this.paths.trackerCache, 'utf8');
        this.cache = JSON.parse(raw);
      } catch {
        this.cache = {};
      }
    }

    // Populate cache from existing jobs if cache was missing
    if (Object.keys(this.cache).length === 0 && this.jobs.length > 0) {
      for (const job of this.jobs) {
        const key = this.normalizeUrl(job.applyUrl || job.url);
        if (key) {
          this.cache[key] = {
            status: job.status,
            platform: job.platform,
            timestamp: job.timestamp,
            title: job.title,
            company: job.company,
          };
        }
      }
    }

    // 3. Rebuild sheet rows and counters
    for (const job of this.jobs) {
      const statusKey = (job.status || 'applied').toLowerCase();
      if (this.sheets[statusKey]) {
        this.counters[statusKey]++;
        this.sheets[statusKey].rows.push([
          this.counters[statusKey],
          job.dateFormatted || job.timestamp,
          job.platform || 'Unknown',
          job.title || '',
          job.company || '',
          job.location || '',
          job.applyUrl || '',
          job.externalUrl || '',
          job.notes || '',
        ]);
      }
    }

    this.initialized = true;
  }

  has(rawUrl) {
    this.init();
    if (!rawUrl) return false;
    const key = this.normalizeUrl(rawUrl);
    return !!this.cache[key];
  }

  getStatus(rawUrl) {
    this.init();
    if (!rawUrl) return null;
    const key = this.normalizeUrl(rawUrl);
    return this.cache[key] ? this.cache[key].status : null;
  }

  record({
    platform = 'Unknown',
    title = '',
    company = '',
    location = '',
    applyUrl = '',
    externalUrl = '',
    status = 'APPLIED', // APPLIED | EXTERNAL | SKIPPED | FAILED
    notes = '',
  }) {
    this.init();

    const timestamp = new Date().toISOString();
    const dateFormatted = this.now();
    const normalizedKey = this.normalizeUrl(applyUrl || externalUrl);
    const id = `job_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    const record = {
      id,
      timestamp,
      dateFormatted,
      platform,
      title: title.trim(),
      company: company.trim(),
      location: location.trim(),
      applyUrl: applyUrl.trim(),
      externalUrl: externalUrl.trim(),
      status: status.toUpperCase(),
      notes: notes.trim(),
    };

    this.jobs.push(record);

    if (normalizedKey) {
      this.cache[normalizedKey] = {
        id,
        status: record.status,
        platform: record.platform,
        timestamp: record.timestamp,
        title: record.title,
        company: record.company,
      };
    }

    // Add to specific sheet
    const sheetKey = status.toLowerCase();
    if (this.sheets[sheetKey]) {
      this.counters[sheetKey]++;
      this.sheets[sheetKey].rows.push([
        this.counters[sheetKey],
        dateFormatted,
        platform,
        record.title,
        record.company,
        record.location,
        record.applyUrl,
        record.externalUrl,
        record.notes,
      ]);
    }

    return record;
  }

  recordApplied(job) {
    return this.record({ ...job, status: 'APPLIED' });
  }

  recordExternal(job) {
    return this.record({ ...job, status: 'EXTERNAL' });
  }

  recordSkipped(job) {
    return this.record({ ...job, status: 'SKIPPED' });
  }

  recordFailed(job) {
    return this.record({ ...job, status: 'FAILED' });
  }

  save() {
    this.init();

    // 1. Write applied-jobs.json
    fs.writeFileSync(this.paths.appliedJson, JSON.stringify(this.jobs, null, 2), 'utf8');

    // 2. Write tracker-cache.json
    fs.writeFileSync(this.paths.trackerCache, JSON.stringify(this.cache, null, 2), 'utf8');

    // 3. Write applied-jobs.csv
    this.saveCsv();

    // 4. Write Excel workbook (.xlsx)
    this.saveExcel();

    console.log(`[FileTracker] Successfully saved ${this.jobs.length} total entries to files:`);
    console.log(`  -> JSON:  ${this.paths.appliedJson}`);
    console.log(`  -> CSV:   ${this.paths.appliedCsv}`);
    console.log(`  -> Excel: ${this.paths.appliedExcel}`);
  }

  saveCsv() {
    const headers = ['ID', 'Date', 'Platform', 'Job Title', 'Company', 'Location', 'Status', 'Apply URL', 'External URL', 'Notes'];
    const escapeCsv = (str) => `"${String(str || '').replace(/"/g, '""')}"`;

    const lines = [headers.join(',')];
    for (const job of this.jobs) {
      lines.push([
        escapeCsv(job.id),
        escapeCsv(job.dateFormatted || job.timestamp),
        escapeCsv(job.platform),
        escapeCsv(job.title),
        escapeCsv(job.company),
        escapeCsv(job.location),
        escapeCsv(job.status),
        escapeCsv(job.applyUrl),
        escapeCsv(job.externalUrl),
        escapeCsv(job.notes),
      ].join(','));
    }

    fs.writeFileSync(this.paths.appliedCsv, lines.join('\n'), 'utf8');
  }

  saveExcel() {
    const headers = ['#', 'Date', 'Platform', 'Job Title', 'Company', 'Location', 'Apply URL', 'External URL', 'Notes / Status'];
    const wb = XLSX.utils.book_new();

    for (const key of Object.keys(this.sheets)) {
      const sheetData = [headers, ...this.sheets[key].rows];
      const ws = XLSX.utils.aoa_to_sheet(sheetData);

      // Set readable column widths
      ws['!cols'] = [
        { wch: 5 },   // #
        { wch: 22 },  // Date
        { wch: 12 },  // Platform
        { wch: 35 },  // Job Title
        { wch: 28 },  // Company
        { wch: 20 },  // Location
        { wch: 50 },  // Apply URL
        { wch: 50 },  // External URL
        { wch: 45 },  // Notes
      ];

      XLSX.utils.book_append_sheet(wb, ws, this.sheets[key].name);
    }

    XLSX.writeFile(wb, this.paths.appliedExcel);
  }

  getSummary() {
    this.init();
    const summary = {
      total: this.jobs.length,
      applied: 0,
      external: 0,
      skipped: 0,
      failed: 0,
      byPlatform: {},
    };

    for (const job of this.jobs) {
      const s = (job.status || '').toLowerCase();
      if (summary[s] !== undefined) summary[s]++;

      const p = job.platform || 'Unknown';
      summary.byPlatform[p] = (summary.byPlatform[p] || 0) + 1;
    }

    return summary;
  }

  importFromLegacyJson(filePath) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Legacy file not found: ${filePath}`);
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const legacy = JSON.parse(raw);
    let importedCount = 0;

    for (const category of ['applied', 'external', 'skipped', 'failed']) {
      const items = legacy[category];
      if (!items || typeof items !== 'object') continue;

      for (const [url, item] of Object.entries(items)) {
        if (this.has(url)) continue; // already tracked

        this.record({
          platform: item.source ? item.source.toUpperCase() : 'Unknown',
          title: item.title || '',
          company: item.company || '',
          location: item.location || '',
          applyUrl: url,
          externalUrl: item.externalUrl || '',
          status: category.toUpperCase(),
          notes: item.notes || item.reason || 'Imported from legacy tracker',
        });
        importedCount++;
      }
    }

    if (importedCount > 0) {
      this.save();
    }
    return importedCount;
  }

  listRecent(count = 15) {
    this.init();
    return this.jobs.slice(-count).reverse();
  }
}

// Export singleton instance for convenience, and Class for custom instances
const defaultTracker = new FileTracker();
module.exports = defaultTracker;
module.exports.FileTracker = FileTracker;
