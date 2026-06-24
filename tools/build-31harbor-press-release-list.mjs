#!/usr/bin/env node
/**
 * build-31harbor-press-release-list.mjs
 * Builds the press release distribution list from the 31harbor contact pool.
 * Filters out consumer emails, sentry/error-tracking addresses, and image-file noise.
 *
 * Usage: node relay/tools/build-31harbor-press-release-list.mjs
 *
 * Writes to relay-data/31harbor-press-release-list.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'relay-data');
const POOL_FILE = path.join(DATA_DIR, '31harbor-contacts.json');
const OUTPUT_FILE = path.join(DATA_DIR, '31harbor-press-release-list.json');

// Consumer / personal email domains — press releases go to industry contacts, not individuals
const CONSUMER_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.ca', 'hotmail.com',
  'hotmail.co.uk', 'outlook.com', 'aol.com', 'icloud.com', 'protonmail.com',
  'proton.me', 'pm.me', 'zoho.com', 'yandex.com', 'mail.com', 'inbox.com',
  'fastmail.com', 'tutanota.com', 'gmx.com', 'gmx.net', 'gmx.us',
  'live.com', 'live.ca', 'live.co.uk', 'msn.com', 'comcast.net',
  'bellsouth.net', 'optonline.net', 'sbcglobal.net', 'att.net',
  'verizon.net', 'cox.net', 'earthlink.net', 'charter.net',
  'centurylink.net', 'q.com', 'windstream.net', 'suddenlink.net',
  'frontiernet.net', 'roadrunner.com', 'twc.com', 'rr.com',
  'shaw.ca', 'telus.net', 'rogers.com', 'bell.net', 'sympatico.ca',
  'videotron.ca', 'cogeco.ca', 'eastlink.ca',
]);

// Domains that are clearly not real people
const BLOCKED_DOMAINS = new Set([
  'sentry.wixpress.com', 'sentry-next.wixpress.com', 'sentry.io',
  'leads.leadrouter.com', 'mailchimp.com', 'sendgrid.net',
  'hubspot.com', 'constantcontact.com', 'mailgun.org',
  'sendinblue.com', 'brevo.com', 'example.com', 'example.org',
  'example.net', 'user@domain.com',
]);

const IMAGE_TLDS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp',
  'tiff', 'tif', 'avif', 'heic', 'heif', 'raw', 'psd', 'ai', 'eps',
]);

function isPressReleaseCandidate(email) {
  const e = email.toLowerCase().trim();
  if (!e.includes('@')) return false;
  const [local, domain] = e.split('@');
  if (!domain || !domain.includes('.') || domain.length < 5) return false;

  // Block image filenames matched as emails
  const tld = domain.split('.').pop();
  if (IMAGE_TLDS.has(tld)) return false;

  // Block consumer/personal domains
  if (CONSUMER_DOMAINS.has(domain)) return false;

  // Block known non-person domains
  if (BLOCKED_DOMAINS.has(domain)) return false;

  // Block sentry/error-tracking patterns
  if (domain.includes('sentry')) return false;
  if (domain.includes('leadrouter')) return false;

  // Block auto-generated local-parts
  if (/^(noreply|donotreply|no-?reply|mailer-?daemon|unsubscribe|newsletter|admin|support|info|contact|webmaster|postmaster|abuse|spam)/i.test(local)) return false;

  // Block single-character local parts
  if (local.length <= 1) return false;

  // Block placeholder local parts
  if (/^(name|email|user|test|example|your|full|first|last)$/i.test(local)) return false;

  // Block suspicious multi-segment domains (likely spam traps)
  if ((domain.match(/\./g) || []).length >= 5) return false;

  return true;
}

// Load pool
let pool = [];
try { pool = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8')); } catch {
  console.error('No contact pool found at', POOL_FILE);
  process.exit(1);
}

console.log(`Pool: ${pool.length} contacts`);

// Filter
const candidates = pool.filter(c => isPressReleaseCandidate(c.email));
console.log(`Press release candidates: ${candidates.length}`);

// Deduplicate by email
const seen = new Set();
const unique = [];
for (const c of candidates) {
  const key = c.email.toLowerCase().trim();
  if (!seen.has(key)) {
    seen.add(key);
    unique.push(c);
  }
}

console.log(`Unique: ${unique.length}`);

// Sort by domain for readability
unique.sort((a, b) => {
  const da = a.email.split('@')[1] || '';
  const db = b.email.split('@')[1] || '';
  if (da !== db) return da.localeCompare(db);
  return a.email.localeCompare(b.email);
});

// Write
fs.writeFileSync(OUTPUT_FILE, JSON.stringify(unique, null, 2));
console.log(`\nWrote ${unique.length} entries to ${OUTPUT_FILE}`);

// Summary
const domains = {};
unique.forEach(c => {
  const d = c.email.split('@')[1];
  if (d) domains[d] = (domains[d] || 0) + 1;
});
const sorted = Object.entries(domains).sort((a, b) => b[1] - a[1]);
console.log('\nTop 15 domains:');
sorted.slice(0, 15).forEach(([d, c]) => console.log(`  ${d}: ${c}`));
