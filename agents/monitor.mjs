/**
 * monitor.mjs -- Source Monitoring Agent
 *
 * Scans RSS feeds from sources.json, polls pages without RSS,
 * and ingests tip line submissions. Outputs a structured digest
 * of candidate items scored by editorial relevance.
 *
 * Run: node agents/monitor.mjs
 * Expects: NETLIFY_FORMS_TOKEN (optional, for tip line)
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCES_PATH = join(__dirname, 'sources.json');
const MEMORY_DIR = join(__dirname, 'memory');
const DIGEST_PATH = join(MEMORY_DIR, 'latest-digest.json');
const PROCESSED_TIPS_PATH = join(MEMORY_DIR, 'processed-tips.json');

// ── RSS parsing (lightweight, no external dependency) ──

async function fetchRSS(url, timeout = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'lawpeeps.ai/monitor (editorial bot)' }
    });
    clearTimeout(timer);
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRSSItems(xml);
  } catch {
    clearTimeout(timer);
    return [];
  }
}

function parseRSSItems(xml) {
  const items = [];
  const itemRegex = /<(?:item|entry)[\s>]([\s\S]*?)<\/(?:item|entry)>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = extractTag(block, 'title');
    const link = extractLink(block);
    const description = extractTag(block, 'description') || extractTag(block, 'summary') || '';
    const pubDate = extractTag(block, 'pubDate') || extractTag(block, 'published') || extractTag(block, 'updated') || '';
    if (title && link) {
      items.push({
        title: stripCDATA(title).trim(),
        url: stripCDATA(link).trim(),
        summary: stripHTML(stripCDATA(description)).slice(0, 500),
        published: pubDate ? new Date(pubDate).toISOString() : null
      });
    }
  }
  return items;
}

function extractTag(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1] : null;
}

function extractLink(xml) {
  const atomLink = xml.match(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["']alternate["']/i)
    || xml.match(/<link[^>]+href=["']([^"']+)["']/i);
  if (atomLink) return atomLink[1];
  return extractTag(xml, 'link');
}

function stripCDATA(str) {
  if (!str) return '';
  return str.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

function stripHTML(str) {
  if (!str) return '';
  return str.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function scoreItem(item, config) {
  let score = 0;
  const text = `${item.title} ${item.summary}`.toLowerCase();
  for (const kw of config.scoring.keywords) {
    if (text.includes(kw.toLowerCase())) score += 2;
  }
  for (const company of config.scoring.watch_list_companies) {
    if (text.includes(company.toLowerCase())) score += 3;
  }
  if (item.published) {
    const age = Date.now() - new Date(item.published).getTime();
    const hours = age / (1000 * 60 * 60);
    if (hours < 6) score += 4;
    else if (hours < 12) score += 2;
    else if (hours < 24) score += 1;
  }
  return score;
}

function deduplicateItems(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = item.url.replace(/\/$/, '').toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchTips() {
  const token = process.env.NETLIFY_FORMS_TOKEN;
  if (!token) return [];
  try {
    const siteId = process.env.NETLIFY_SITE_ID;
    if (!siteId) return [];
    const res = await fetch(
      `https://api.netlify.com/api/v1/sites/${siteId}/submissions?state=verified`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return [];
    const submissions = await res.json();
    let processed = [];
    if (existsSync(PROCESSED_TIPS_PATH)) {
      processed = JSON.parse(readFileSync(PROCESSED_TIPS_PATH, 'utf-8'));
    }
    const processedSet = new Set(processed);
    const newTips = submissions
      .filter(s => !processedSet.has(s.id))
      .map(s => ({
        id: s.id,
        title: `[TIP] ${s.data?.subject || s.data?.name || 'Anonymous tip'}`,
        url: s.data?.url || '',
        summary: s.data?.message || s.data?.details || '',
        published: s.created_at,
        source_id: 'tip-line',
        source_name: 'Reader Tip',
        is_tip: true,
        tip_contact: s.data?.email || null,
        tip_credit: s.data?.credit_preference || 'anonymous'
      }));
    const allProcessed = [...processed, ...newTips.map(t => t.id)].slice(-200);
    writeFileSync(PROCESSED_TIPS_PATH, JSON.stringify(allProcessed, null, 2));
    return newTips;
  } catch {
    return [];
  }
}

async function runMonitor() {
  console.log('[monitor] Starting source scan...');
  const config = JSON.parse(readFileSync(SOURCES_PATH, 'utf-8'));
  const allItems = [];
  for (const source of config.sources) {
    const feedUrl = source.feed || source.feed_community;
    if (!feedUrl) {
      console.log(`[monitor] Skipping ${source.id} (no RSS, needs scrape fallback)`);
      continue;
    }
    console.log(`[monitor] Fetching ${source.id}...`);
    const items = await fetchRSS(feedUrl);
    console.log(`[monitor]   -> ${items.length} items from ${source.id}`);
    for (const item of items) {
      item.source_id = source.id;
      item.source_name = source.name;
      item.source_priority = source.priority;
      item.source_category = source.category;
      item.relevance_score = scoreItem(item, config);
    }
    allItems.push(...items);
  }
  const tips = await fetchTips();
  for (const tip of tips) {
    tip.relevance_score = 5;
  }
  allItems.push(...tips);
  if (tips.length > 0) {
    console.log(`[monitor] Ingested ${tips.length} new tip(s)`);
  }
  const unique = deduplicateItems(allItems);
  unique.sort((a, b) => b.relevance_score - a.relevance_score);
  const topItems = unique.slice(0, config.scoring.top_n || 30);
  const digest = {
    generated: new Date().toISOString(),
    cycle_type: 'monitoring',
    item_count: topItems.length,
    total_scanned: unique.length,
    sources_checked: config.sources.filter(s => s.feed || s.feed_community).length,
    sources_skipped: config.sources.filter(s => !s.feed && !s.feed_community).length,
    items: topItems
  };
  writeFileSync(DIGEST_PATH, JSON.stringify(digest, null, 2));
  console.log(`[monitor] Digest written: ${topItems.length} items (${unique.length} total scanned)`);
  return digest;
}

export { runMonitor };

if (process.argv[1] && process.argv[1].endsWith('monitor.mjs')) {
  runMonitor().catch(err => {
    console.error('[monitor] Fatal error:', err);
    process.exit(1);
  });
}
