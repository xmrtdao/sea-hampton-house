#!/usr/bin/env node
/**
 * 31harbor-national-scraper.mjs
 * Collects real estate agent/broker emails across US and Canada.
 * Phase 2: Direct scraping of server-rendered brokerage agent directories.
 * Phase 3: Targeted URL scraping from known directory pages.
 *
 * Writes to relay-data/31harbor-contacts.json (separate pool).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchUrl } from './search-provider.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'relay-data');
const CONTACTS_FILE = path.join(DATA_DIR, '31harbor-contacts.json');
const LOG_FILE = path.join(DATA_DIR, '31harbor-campaign.log');

fs.mkdirSync(DATA_DIR, { recursive: true });

const TARGET = parseInt(process.argv.find(a => a.startsWith('--target='))?.split('=')[1]) || 9000;
const CONCURRENCY = 10;
const RESUME_FILE = path.join(DATA_DIR, '31harbor-scraper-resume.json');

let totalFound = 0, totalErrors = 0, lastSaveCount = 0;

const BLOCKED_DOMAINS = new Set([
  // Consumer email providers
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com',
  'icloud.com', 'protonmail.com', 'proton.me', 'zoho.com', 'yandex.com',
  'mail.com', 'inbox.com', 'fastmail.com', 'tutanota.com',
  // Social / share platforms
  'facebook.com', 'twitter.com', 'x.com', 'instagram.com', 'tiktok.com',
  'linkedin.com', 'youtube.com', 'snapchat.com', 'pinterest.com',
  'reddit.com', 'tumblr.com', 'whatsapp.com', 'telegram.org',
  'discord.com', 'discord.gg', 'twitch.tv', 'medium.com',
  // Non-real-person domains
  'example.com', 'example.org', 'example.net',
  'noreply', 'donotreply', 'no-reply', 'mailer-daemon',
  'unsubscribe', 'newsletter', 'mailchimp', 'sendgrid',
  'hubspot', 'constantcontact', 'mailgun', 'sendinblue', 'brevo',
  // Government / military (not our target)
  '.gov', '.mil',
]);

const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'tiff', 'tif',
  'avif', 'heic', 'heif', 'raw', 'psd', 'ai', 'eps',
]);

function isEmailAllowed(email) {
  const e = email.toLowerCase().trim();
  if (!e.includes('@')) return false;
  const [local, domain] = e.split('@');
  if (!domain || !domain.includes('.') || domain.length < 5) return false;

  // Block image filenames matched as emails (e.g. "logo@2x.png" where @2x is local part and png is TLD)
  const tld = domain.split('.').pop();
  if (IMAGE_EXTENSIONS.has(tld)) return false;

  // Exact match
  if (BLOCKED_DOMAINS.has(domain)) return false;
  // Suffix match for .gov / .mil
  for (const blocked of BLOCKED_DOMAINS) {
    if (blocked.startsWith('.') && domain.endsWith(blocked)) return false;
  }
  // Substring match for known auto-email domains
  for (const blocked of BLOCKED_DOMAINS) {
    if (domain.includes(blocked)) return false;
  }
  // Block auto-generated local-parts
  if (/^(noreply|donotreply|no-?reply|mailer-?daemon|unsubscribe|newsletter|admin|support|info|contact|webmaster|postmaster|abuse|spam)/i.test(local)) return false;
  // Block single-character local parts (likely form field labels like "e@domain.com", "n@domain.com")
  if (local.length <= 1) return false;
  // Block placeholder local parts
  if (/^(name|email|user|test|example|your|full|first|last)$/i.test(local)) return false;
  // Block suspicious multi-segment domains (likely spam traps)
  if ((domain.match(/\./g) || []).length >= 5) return false;
  return true;
}

function log(msg) {
  const entry = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(entry);
  try { fs.appendFileSync(LOG_FILE, entry); } catch {}
}

function extractEmails(text) {
  const regex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const matches = text.match(regex) || [];
  return [...new Set(matches.filter(isEmailAllowed))];
}

// fetchUrl imported from search-provider.mjs

function loadExisting() {
  try { return JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8')); } catch { return []; }
}

function saveContacts(contacts) {
  const unique = [];
  const seen = new Set();
  for (const c of contacts) {
    const key = c.email.toLowerCase().trim();
    if (!seen.has(key)) { seen.add(key); unique.push(c); }
  }
  fs.writeFileSync(CONTACTS_FILE, JSON.stringify(unique, null, 2));
  return unique;
}

function progressiveSave(newContacts) {
  const existing = loadExisting();
  const merged = [...existing, ...newContacts];
  const saved = saveContacts(merged);
  if (saved.length > lastSaveCount) {
    log(`  💾 Saved ${saved.length - lastSaveCount} new (pool: ${saved.length})`);
    lastSaveCount = saved.length;
  }
  return saved;
}

// ── Direct directory scraping ────────────────────────────
async function scrapeDirectory(url, region, label) {
  try {
    const html = await fetchUrl(url);
    if (!html || html.length < 500) return [];
    const emails = extractEmails(html);
    return emails.map(email => ({
      email: email.toLowerCase().trim(),
      source: label || url,
      added: new Date().toISOString(),
      region,
      topics: 'real-estate-directory',
      status: 'pending',
      sentCount: 0,
    }));
  } catch {
    totalErrors++;
    return [];
  }
}

// ── Scrape a directory page and follow pagination ─────────
async function scrapeDirectoryWithPagination(baseUrl, region, label, pageParam = 'page') {
  const allContacts = [];
  for (let page = 1; page <= 5; page++) {
    const url = page === 1 ? baseUrl : `${baseUrl}?${pageParam}=${page}`;
    const contacts = await scrapeDirectory(url, region, label);
    allContacts.push(...contacts);
    if (contacts.length < 5) break; // No more pages
  }
  return allContacts;
}

// ── Phase 1: Brokerage agent directories (server-rendered, confirmed working) ──
const DIRECTORIES = [
  // Goldmines (5+ emails each)
  { url: 'https://www.c21nh.com/agents', region: 'US National', label: 'c21nh.com' },
  { url: 'https://www.crossviewrealty.com/team', region: 'US National', label: 'crossviewrealty.com' },
  { url: 'https://www.hagenanderson.com/team', region: 'US National', label: 'hagenanderson.com' },
  { url: 'https://www.jacklingo.com/agents', region: 'US National', label: 'jacklingo.com' },
  { url: 'https://www.laerrealty.com/agents', region: 'US National', label: 'laerrealty.com' },
  { url: 'https://www.people1st.ca/agents', region: 'Canada', label: 'people1st.ca' },
  { url: 'https://www.rswtpa.com/our-team', region: 'US National', label: 'rswtpa.com' },

  // Silver (1-4 emails each)
  { url: 'https://www.brittneypino.com/our-team', region: 'US National', label: 'brittneypino.com' },
  { url: 'https://www.brokersre.com/our-agents', region: 'US National', label: 'brokersre.com' },
  { url: 'https://www.buysdhomes.com/our-agents', region: 'US National', label: 'buysdhomes.com' },
  { url: 'https://www.meetmeinmoncton.com/team', region: 'Canada', label: 'meetmeinmoncton.com' },
  { url: 'https://www.nebraskarealty.com/agents', region: 'US National', label: 'nebraskarealty.com' },
  { url: 'https://www.sudburyrealestateboard.com/team', region: 'Canada', label: 'sudburyrealestateboard.com' },
];

// ── Main ────────────────────────────────────────────────
async function main() {
  log(`╔══════════════════════════════════════════╗`);
  log(`║  🏠 31harbor National Scraper             ║`);
  log(`║  Target: ${TARGET} contacts (US + Canada)   ║`);
  log(`╚══════════════════════════════════════════╝`);

  const start = Date.now();
  const existing = loadExisting();
  log(`Pool starts at: ${existing.length} contacts\n`);

  // Load resume state — skip already-processed searches
  let resumeIdx = 0;
  try {
    const resume = JSON.parse(fs.readFileSync(RESUME_FILE, 'utf8'));
    resumeIdx = resume.idx || 0;
    log(`📋 Resuming from search #${resumeIdx}\n`);
  } catch { log(`📋 Starting fresh\n`); }

  let allNew = [];

;

  // Phase 2: Direct scraping of brokerage agent directories
  // (Phase 1 — Startpage.com searches — removed because all search engines now block automated requests)
  for (let i = resumeIdx; i < DIRECTORIES.length; i++) {
    const d = DIRECTORIES[i];
    const contacts = await scrapeDirectory(d.url, d.region, d.label);
    allNew.push(...contacts);
    totalFound = allNew.length;
    if (contacts.length > 0) {
      log(`  ✓ "${d.url.slice(0, 55)}" → ${contacts.length} emails`);
    } else {
      log(`  · "${d.url.slice(0, 55)}" → 0`);
    }

    // Save resume state every directory
    fs.writeFileSync(RESUME_FILE, JSON.stringify({ idx: i + 1, ts: Date.now() }));

    if (allNew.length - lastSaveCount > 100) {
      progressiveSave(allNew);
    }
  }

  // Final save
  log(`\n📦 Final merge...`);
  const merged = [...existing, ...allNew];
  const saved = saveContacts(merged);
  const elapsed = Math.round((Date.now() - start) / 1000);

  // Clear resume file on success
  try { fs.unlinkSync(RESUME_FILE); } catch {}

  log(`\n╔══════════════════════════════════════════╗`);
  log(`║  ✅ DONE in ${elapsed}s                    ║`);
  log(`║  Found: ${allNew.length} new contacts      ║`);
  log(`║  Pool: ${saved.length} total               ║`);
  log(`║  Errors: ${totalErrors}                    ║`);
  log(`╚══════════════════════════════════════════╝\n`);
}

main().catch(e => {
  log(`\n❌ Fatal: ${e.message}`);
  process.exit(1);
});