const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const candidateData = require('./candidate.json');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const RESUME_PATH = process.env.RESUME_FILE
  ? path.resolve(ROOT_DIR, process.env.RESUME_FILE)
  : path.join(ROOT_DIR, 'resume', 'Manoj_Ambati_Resume_v3.pdf');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

module.exports = {
  paths: {
    root: ROOT_DIR,
    data: DATA_DIR,
    resume: RESUME_PATH,
    appliedJson: path.join(DATA_DIR, 'applied-jobs.json'),
    appliedCsv: path.join(DATA_DIR, 'applied-jobs.csv'),
    appliedExcel: path.join(DATA_DIR, 'job-applications.xlsx'),
    trackerCache: path.join(DATA_DIR, 'tracker-cache.json'),
    browserProfile: path.join(ROOT_DIR, '.browser-profile'),
  },

  credentials: {
    linkedin: {
      email: process.env.LINKEDIN_EMAIL || '',
      password: process.env.LINKEDIN_PASSWORD || '',
    },
    naukri: {
      email: process.env.NAUKRI_EMAIL || '',
      password: process.env.NAUKRI_PASSWORD || '',
    },
  },

  browser: {
    // default from env if not overridden via CLI
    isHeadless: process.env.HEADLESS === 'true',
    slowMo: 100, // slight human-like delay
    timeout: 30000,
    viewport: { width: 1366, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  },

  search: {
    targetApplications: parseInt(process.env.TARGET_APPLICATIONS || '25', 10),
    jobAge: process.env.JOB_AGE || '7',
    freshness: process.env.FRESHNESS || 'r604800',
    keywords: (process.env.JOB_SEARCH_KEYWORDS || 'Java Developer, Full Stack Developer, Node JS Developer, React JS Full Stack Developer')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    locations: (process.env.JOB_SEARCH_LOCATIONS || 'Hyderabad, Bengaluru, Remote')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    blacklistedCompanies: (process.env.BLACKLISTED_COMPANIES || 'Infosys')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  },

  candidate: candidateData,
};
