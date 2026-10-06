/**
 * src/utils/gmail-otp-helper.js
 * Gmail helper: fetch OTP codes AND verification/magic links from inbox.
 *
 * Fixes:
 *  - google reference bug (was used outside destructuring scope)
 *  - Added fetchVerificationLink() for magic-link email flows
 *  - Improved OTP extraction (also checks multipart email body parts)
 */

const path = require('path');

function getGmailClient() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    console.warn('  [Gmail] Missing OAuth credentials in .env — Gmail features disabled.');
    return null;
  }

  const { google } = require('googleapis');
  const oauth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    'http://localhost:3001/oauth2callback'
  );
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  return gmail;
}

/**
 * Decode a Gmail message part body (base64url → utf8 string)
 */
function decodeBody(data) {
  if (!data) return '';
  try {
    return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return '';
  }
}

/**
 * Recursively extract all text content from a Gmail message payload.
 */
function extractText(payload) {
  if (!payload) return '';
  let text = '';

  if (payload.body?.data) {
    text += decodeBody(payload.body.data);
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' || part.mimeType === 'text/html') {
        text += decodeBody(part.body?.data || '');
      }
      if (part.parts) {
        text += extractText(part);
      }
    }
  }

  return text;
}

/**
 * Fetches the latest 4–8 digit OTP code from Gmail received in the last N seconds.
 * @param {number} maxAgeSeconds  How far back to search (default: 240s / 4 min)
 * @returns {Promise<string|null>}
 */
async function fetchLatestOtp(maxAgeSeconds = 240) {
  const gmail = getGmailClient();
  if (!gmail) return null;

  try {
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: 'subject:(verification OR OTP OR code OR confirm OR "one-time") newer_than:5m',
      maxResults: 10,
    });

    const messages = res.data.messages || [];
    if (!messages.length) return null;

    const now = Date.now();
    for (const msg of messages) {
      const detail = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
      const internalDate = parseInt(detail.data.internalDate, 10);
      const ageSeconds = (now - internalDate) / 1000;
      if (ageSeconds > maxAgeSeconds) continue;

      const text = extractText(detail.data.payload) || detail.data.snippet || '';

      // Match 4–8 digit OTP (avoid matching years like 2024)
      const match = text.match(/\b(\d{4,8})\b/g);
      if (match) {
        // Filter out obvious non-OTPs (years, zip codes context)
        const otp = match.find((m) => {
          const n = parseInt(m, 10);
          return n >= 1000 && n <= 99999999 && !/^20\d{2}$/.test(m);
        });
        if (otp) {
          console.log(`  [Gmail] ✅ Found OTP: ${otp} (email age: ${Math.round(ageSeconds)}s)`);
          return otp;
        }
      }
    }
  } catch (err) {
    console.error('  [Gmail] Error querying Gmail API for OTP:', err.message);
  }

  return null;
}

/**
 * Fetches the latest verification/magic link from Gmail received in the last N seconds.
 * Used when a company sends "Click here to verify your email" instead of an OTP code.
 *
 * @param {number} maxAgeSeconds  How far back to search (default: 300s / 5 min)
 * @returns {Promise<string|null>}  The verification URL or null
 */
async function fetchVerificationLink(maxAgeSeconds = 300) {
  const gmail = getGmailClient();
  if (!gmail) return null;

  try {
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: 'subject:(verify OR verification OR confirm OR activate OR "email confirmation") newer_than:5m',
      maxResults: 10,
    });

    const messages = res.data.messages || [];
    if (!messages.length) return null;

    const now = Date.now();
    for (const msg of messages) {
      const detail = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
      const internalDate = parseInt(detail.data.internalDate, 10);
      const ageSeconds = (now - internalDate) / 1000;
      if (ageSeconds > maxAgeSeconds) continue;

      const text = extractText(detail.data.payload) || detail.data.snippet || '';

      // Look for typical verification link patterns
      const urlPatterns = [
        /https?:\/\/[^\s"'<>]+(?:verify|confirm|activate|token|magic|validate)[^\s"'<>]*/gi,
        /https?:\/\/[^\s"'<>]+[?&](?:token|code|key|hash)=[^\s"'<>&]+/gi,
      ];

      for (const pattern of urlPatterns) {
        const matches = text.match(pattern);
        if (matches && matches.length > 0) {
          // Filter out unsubscribe/tracking links
          const link = matches.find((m) =>
            !/unsubscribe|track|pixel|open\.php|click\.php/i.test(m)
          );
          if (link) {
            console.log(`  [Gmail] ✅ Found verification link (age: ${Math.round(ageSeconds)}s)`);
            return link.replace(/&amp;/g, '&'); // decode HTML entities
          }
        }
      }
    }
  } catch (err) {
    console.error('  [Gmail] Error querying Gmail API for verification link:', err.message);
  }

  return null;
}

module.exports = { fetchLatestOtp, fetchVerificationLink };
