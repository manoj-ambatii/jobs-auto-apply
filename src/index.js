const config = require('../config');
const browserManager = require('./browser/browser-manager');
const tracker = require('./tracker/file-tracker');
const LinkedInApplicant = require('./platforms/linkedin');
const NaukriApplicant = require('./platforms/naukri');

module.exports = {
  config,
  browserManager,
  tracker,
  LinkedInApplicant,
  NaukriApplicant,
};
