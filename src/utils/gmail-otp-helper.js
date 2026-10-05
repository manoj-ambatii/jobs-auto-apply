/**
 * src/utils/gmail-otp-helper.js
 * Utility module to fetch latest OTP verification code from Gmail inbox.
 */

const path = require('path');
const config = require('../../config');

function getOAuthClient() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    return null;
  }

  const { google } = require('googleapis');
  const oauth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    'http://localhost:3001/oauth2callback'
  );

  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return oauth2Client;
}

/**
 * Fetches the latest 4 to 8 digit OTP code received in Gmail in the last N seconds.
 * @param {number} maxAgeSeconds How far back to search (default: 180s / 3m)
 * @returns {Promise<string|null>} The OTP string or null if not found.
 */
async function fetchLatestOtp(maxAgeSeconds = 180) {
  const auth = getOAuthClient();
  if (!auth) {
    return null;
  }

  const gmail = google.gmail({ version: 'v1', auth });

  try {
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: 'verification OR OTP OR code OR PIN OR confirm OR security',
      maxResults: 5,
    });

    const messages = res.data.messages || [];
    if (!messages.length) return null;

    const now = Date.now();
    for (const msg of messages) {
      const detail = await gmail.users.messages.get({ userId: 'me', id: msg.id });
      const internalDate = parseInt(detail.data.internalDate, 10);
      const ageSeconds = (now - internalDate) / 1000;

      if (ageSeconds > maxAgeSeconds) continue;

      const snippet = detail.data.snippet || '';
      const body = detail.data.payload?.body?.data
        ? Buffer.from(detail.data.payload.body.data, 'base64').toString('utf8')
        : snippet;

      // Match 4 to 8 digit OTP codes
      const match = body.match(/\b\d{4,8}\b/);
      if (match) {
        return match[0];
      }
    }
  } catch (err) {
    console.error('  [GmailOTP] Error querying Gmail API:', err.message);
  }

  return null;
}

module.exports = { fetchLatestOtp };
