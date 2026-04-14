/**
 * Source Monitor for lawpeeps.ai
 * Fetches RSS feeds, filters for relevant items, produces a structured digest.
 * Output: JSON digest written to agents/digests/YYYY-MM-DD-HHmm.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Simple RSS/Atom parser (no dependencies required)
async function fetchFeed(url, timeout = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'lawpeeps.ai/1.0 (editorial monitor)' },
    });
    clearTimeout(timer);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

function parseItems(xml) {
  const items = [];

  // Try RSS <item> format
  const rssItems = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  for (const raw of rssItems) {
    items.push({
      title: extractTag(raw, 'title'),
      link: extractTag(raw, 'link'),
      description: stripHtml(extractTag(raw, 'description')),
      pubDate: extractTag(raw, 'pubDate') || extractTag(raw, 'dc:date'),
    });
  }

  // Try Atom <entry> format if no RSS items found
  if (items.length === 0) {
    const atomEntries = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
    for (const raw of atomEntries) {
      const linkMatch = raw.match(/<link[^>]*href=["']([^"']+)["']/i);
      items.push({
        title: extractTag(raw, 'title'),
        link: linkMatch ? linkMatch[1] : '',
        description: stripHtml(extractTag(raw, 'summary') || extractTag(raw, 'content')),
        pubDate: extractTag(raw, 'published') || extractTag(raw, 'updated'),
      });
    }
  }

  return items;
}

function extractTag(xml, tag) {
  // Handle CDATA
  const cdataPattern = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, 'i');
  const cdataMatch = xml.match(cdataPattern);
  if (cdataMatch) return cdataMatch[1].trim();

  const pattern = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const match = xml.match(pattern);
  return match ? match[1].trim() : '';
}

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function isRecent(dateStr, hoursAgo = 48) {
  if (!dateStr) return true; // Include items without dates (be permissive)
  try {
    const itemDate = new Date(dateStr);
    const cutoff = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
    return itemDate >= cutoff;
  } catch {
    return true;
  }
}

function scoreRelevance(item, keywords, watchList) {
  let score = 0;
  const text = `${item.title} ${item.description}`.toLowerCase();

  for (const keyword of keywords) {
    if (text.includes(keyword.toLowerCase())) {
      score += 2;
    }
  }

  for (const company of watchList) {
    if (text.includes(company.toLowerCase())) {
      score += 3;
    }
  }

  // Boost items with "UK", "England", "Wales", "SRA", "Law Society"
  const ukTerms = ['uk', 'united kingdom', 'england', 'wales', 'sra', 'law society', 'solicitor', 'barrister'];
  for (const term of ukTerms) {
    if (text.includes(term)) {
      score += 1;
    }
  }

  return score;
}

function isDuplicate(item, existingDigests) {
  const normTitle = item.title.toLowerCase().trim();
  for (const digest of existingDigests) {
    for (const existing of digest.items || []) {
      if (existing.title && existing.title.toLowerCase().trim() === normTitle) {
        return true;
      }
    }
  }
  return false;
}

function loadRecentDigests(digestDir, daysBack = 3) {
  const digests = [];
  if (!existsSync(digestDir)) return digests;

  const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
  const files = readdirSync(digestDir).filter(f => f.endsWith('.json')).sort().reverse();

  for (const file of files.slice(0, 20)) {
    try {
      const content = JSON.parse(readFileSync(join(digestDir, file), 'utf-8'));
      if (new Date(content.timestamp) >= cutoff) {
        digests.push(content);
      }
    } catch {
      // Skip malformed digests
    }
  }

  return digests;
}

async function monitor() {
  console.log('lawpeeps.ai source monitor starting...');

  const sources = JSON.parse(readFileSync(join(__dirname, 'sources.json'), 'utf-8'));
  const digestDir = join(__dirname, 'digests');
  mkdirSync(digestDir, { recursive: true });

  const recentDigests = loadRecentDigests(digestDir);
  const allItems = [];
  const errors = [];

  for (const feed of sources.rss_feeds) {
    try {
      console.log(`Fetching: ${feed.name}...`);
      const xml = await fetchFeed(feed.url);
      const items = parseItems(xml);
      const recent = items.filter(item => isRecent(item.pubDate, 48));

      for (const item of recent) {
        const relevance = scoreRelevance(item, sources.keywords, sources.companies_watch_list);
        if (relevance > 0 && !isDuplicate(item, recentDigests)) {
          allItems.push({
            ...item,
            source: feed.name,
            sourceCategory: feed.category,
            sourcePriority: feed.priority,
            relevanceScore: relevance,
          });
        }
      }

      console.log(`  Found ${recent.length} recent items, ${allItems.length} relevant so far`);
    } catch (err) {
      const msg = `Failed to fetch ${feed.name}: ${err.message}`;
      console.error(`  ${msg}`);
      errors.push(msg);
    }
  }

  // Sort by relevance score descending
  allItems.sort((a, b) => b.relevanceScore - a.relevanceScore);

  // Cap at top 30 items
  const topItems = allItems.slice(0, 30);

  const now = new Date();
  const timestamp = now.toISOString();
  const filename = `${now.toISOString().slice(0, 16).replace(/[T:]/g, '-')}.json`;

  const digest = {
    timestamp,
    feedsScanned: sources.rss_feeds.length,
    feedErrors: errors.length,
    itemsFound: allItems.length,
    itemsIncluded: topItems.length,
    errors: errors.length > 0 ? errors : undefined,
    items: topItems,
  };

  const digestPath = join(digestDir, filename);
  writeFileSync(digestPath, JSON.stringify(digest, null, 2));
  console.log(`\nDigest written: ${digestPath}`);
  console.log(`Items: ${topItems.length} (from ${allItems.length} relevant, across ${sources.rss_feeds.length} feeds)`);

  return digest;
}

// Run
monitor().catch(err => {
  console.error('Monitor failed:', err);
  process.exit(1);
});
