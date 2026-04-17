/**
 * dedupe.mjs -- Topic fingerprint dedupe
 *
 * Detects near-duplicate stories across runs. Deterministic, no API
 * spend. The fingerprint is a bag of entity names, numeric tokens,
 * keyword hits, and distinctive title tokens. Two items are treated
 * as duplicates if their fingerprints overlap above a threshold.
 *
 * Used in three places:
 *   1. prefilter.mjs -- reject items that fingerprint-match a queued
 *      or recently-published story before Haiku ever sees them.
 *   2. queue.mjs    -- last-chance gate at enqueue time.
 *   3. triage.mjs   -- feed richer recent-coverage context to Haiku.
 *
 * Why not just a slug match? Slugs come from the headline, and two
 * different outlets (or two cycles of our own editor) produce
 * different headlines for the same underlying news. Fingerprints
 * catch "MoJ announces family court AI transcripts" and
 * "Family court to get AI transcription" as the same story, even
 * though the slugs share almost no tokens.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MEMORY_DIR = join(__dirname, 'memory');
const EDITORIAL_LOG_PATH = join(MEMORY_DIR, 'editorial-log.json');
const QUEUE_PATH = join(MEMORY_DIR, 'story-queue.json');
const SOURCES_PATH = join(__dirname, 'sources.json');

const DEFAULT_THRESHOLD = 0.5;

// Common news-prose noise so title tokens stay distinctive.
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'from', 'with', 'into', 'onto', 'over', 'after',
  'before', 'while', 'that', 'this', 'these', 'those', 'their', 'there',
  'here', 'have', 'been', 'being', 'what', 'when', 'where', 'which',
  'whose', 'about', 'against', 'would', 'could', 'should', 'shall',
  'might', 'must', 'need', 'some', 'most', 'such', 'says', 'said',
  'more', 'less', 'many', 'much', 'also', 'still', 'just', 'only',
  'every', 'both', 'very', 'like', 'than', 'then', 'new', 'news',
  'today', 'yesterday', 'week', 'month', 'year', 'years', 'report',
  'reports', 'reveals', 'reveal', 'announced', 'announces', 'confirms',
  'confirmed', 'launches', 'launched', 'unveils', 'unveiled', 'update',
  'updates', 'statement', 'story', 'article', 'coverage'
]);

// Regulators and widely-cited orgs that deserve to be treated as
// entities even if they are not on the watch list.
const EXTRA_ENTITIES = [
  'sra', 'ico', 'moj', 'ministry of justice', 'bar council',
  'law society', 'ofcom', 'fca', 'bsb', 'ukvi', 'home office',
  'cma', 'nhs', 'european commission', 'court of appeal',
  'supreme court', 'high court', 'dsit', 'judicial office',
  'solicitors regulation authority', 'bar standards board',
  'uk visas and immigration'
];

// Collapse acronym + full-name pairs to a single canonical entity so
// a story mentioning "MoJ" and "Ministry of Justice" does not count
// as matching two entities.
const ENTITY_CANON = new Map([
  ['moj', 'ministry of justice'],
  ['sra', 'solicitors regulation authority'],
  ['bsb', 'bar standards board'],
  ['ukvi', 'uk visas and immigration']
]);

// Short topic terms that are always kept as title tokens, even though
// they fall below the usual 4-character minimum. These are the domain
// acronyms and terms that actually carry story-defining weight.
const SHORT_TOPICS = new Set([
  'ai', 'aml', 'kyc', 'gdpr', 'dpa', 'dsa', 'mlr', 'sar', 'pep',
  'cos', 'rtw', 'eea', 'ilr', 'eu', 'uk', 'fca', 'pra', 'bsa'
]);

let cachedConfig = null;
function loadConfig() {
  if (cachedConfig) return cachedConfig;
  if (!existsSync(SOURCES_PATH)) {
    return { scoring: { keywords: [], watch_list_companies: [] } };
  }
  cachedConfig = JSON.parse(readFileSync(SOURCES_PATH, 'utf-8'));
  return cachedConfig;
}

// ── Token extraction ──────────────────────────────────────────────

/**
 * Normalise a numeric/currency token to a canonical form.
 *   "$300 million" -> "300m"
 *   "£5bn"         -> "5bn"
 *   "25%"          -> "25pct"
 *   "2026"         -> "2026y"
 *   "300,000"      -> "300k"
 * Returns null if the token is not distinctive enough to keep.
 */
function normaliseNumeric(raw) {
  // Strip commas, whitespace, and leading currency markers so "£50,000"
  // becomes "50000" and can flow through every branch below.
  const s = raw
    .toLowerCase()
    .replace(/,/g, '')
    .replace(/[£$€]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  let m = s.match(/^(\d+(?:\.\d+)?)\s*(?:%|per\s*cent|percent)$/);
  if (m) return `${m[1]}pct`;

  m = s.match(/^(\d+(?:\.\d+)?)\s*(bn|b|billion|mn|m|million|k|thousand)$/);
  if (m) {
    const n = m[1];
    const unit = m[2];
    if (unit.startsWith('b')) return `${n}bn`;
    if (unit.startsWith('m')) return `${n}m`;
    if (unit.startsWith('k') || unit.startsWith('t')) return `${n}k`;
  }

  m = s.match(/^(19|20)\d{2}$/);
  if (m) return `${s}y`;

  m = s.match(/^(\d+)$/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}m`;
    if (n >= 1000) return `${Math.round(n / 1000)}k`;
    // Bare 3-digit integers are too common (page counts, section numbers)
    // to fingerprint; ignore them.
  }

  return null;
}

function extractNumerics(text) {
  const out = new Set();
  const re = /[£$€]?\s*\d+(?:[.,]\d+)?\s*(?:bn|b|billion|mn|m|million|k|thousand|%|per\s*cent|percent)?/gi;
  const matches = text.match(re) || [];
  for (const raw of matches) {
    const n = normaliseNumeric(raw);
    if (n) out.add(n);
  }
  const years = text.match(/\b(19|20)\d{2}\b/g) || [];
  for (const y of years) out.add(`${y}y`);
  return out;
}

function extractEntities(text, config) {
  const haystack = text.toLowerCase();
  const out = new Set();
  for (const company of (config.scoring?.watch_list_companies || [])) {
    if (haystack.includes(company.toLowerCase())) {
      out.add(company.toLowerCase());
    }
  }
  for (const e of EXTRA_ENTITIES) {
    // Require word boundaries for short acronyms so "sra" does not
    // match "bursary" or similar.
    if (e.length <= 4) {
      const re = new RegExp(`\\b${e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      if (re.test(haystack)) out.add(e);
    } else if (haystack.includes(e)) {
      out.add(e);
    }
  }
  // Collapse acronym + long-form pairs. If we detected both "moj"
  // and "ministry of justice", keep only the canonical long form.
  for (const [abbrev, canonical] of ENTITY_CANON) {
    if (out.has(abbrev) && out.has(canonical)) {
      out.delete(abbrev);
    } else if (out.has(abbrev) && !out.has(canonical)) {
      out.delete(abbrev);
      out.add(canonical);
    }
  }
  return out;
}

function extractKeywords(text, config) {
  const haystack = text.toLowerCase();
  const out = new Set();
  for (const kw of (config.scoring?.keywords || [])) {
    if (haystack.includes(kw.toLowerCase())) {
      out.add(kw.toLowerCase());
    }
  }
  return out;
}

function extractTitleTokens(title) {
  const out = new Set();
  const raw = title.toLowerCase().split(/[^a-z0-9]+/);
  for (const t of raw) {
    if (!t) continue;
    if (/^\d+$/.test(t)) continue;
    if (STOP_WORDS.has(t)) continue;
    if (t.length >= 4 || SHORT_TOPICS.has(t)) {
      out.add(t);
    }
  }
  return out;
}

// ── Fingerprint ──────────────────────────────────────────────────

/**
 * Compute a fingerprint for an item. Returns a plain object so it
 * can be JSON-serialised for storage on queue entries and editorial
 * log entries.
 */
export function fingerprint(item, config = loadConfig()) {
  const title = item.title || '';
  const summary = item.summary || '';
  const text = `${title} ${summary}`;

  return {
    entities: [...extractEntities(text, config)],
    numerics: [...extractNumerics(text)],
    keywords: [...extractKeywords(text, config)],
    title_tokens: [...extractTitleTokens(title)]
  };
}

function jaccard(aArr, bArr) {
  if ((aArr?.length || 0) === 0 && (bArr?.length || 0) === 0) return 0;
  const a = new Set(aArr);
  const b = new Set(bArr);
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function overlapCount(aArr, bArr) {
  const a = new Set(aArr || []);
  let c = 0;
  for (const x of (bArr || [])) if (a.has(x)) c++;
  return c;
}

/**
 * Prefix-overlap between two token sets. Two tokens are treated as
 * the same concept if they share a 6-character prefix. This catches
 * transcripts/transcription, launches/launched, raise/raises, etc.
 * without any explicit stemmer. Tokens shorter than 6 chars must
 * match exactly.
 */
function conceptOverlap(aArr, bArr, prefixLen = 6) {
  const aExact = new Set();
  const aPrefix = new Set();
  for (const t of (aArr || [])) {
    if (!t) continue;
    if (t.length >= prefixLen) aPrefix.add(t.slice(0, prefixLen));
    else aExact.add(t);
  }
  let c = 0;
  for (const t of (bArr || [])) {
    if (!t) continue;
    if (t.length >= prefixLen) {
      if (aPrefix.has(t.slice(0, prefixLen))) c++;
    } else if (aExact.has(t)) {
      c++;
    }
  }
  return c;
}

/**
 * Similarity score 0..1.
 *
 * Rules, in order of precedence:
 *   1. Shared entity AND shared numeric                -> >= 0.9
 *   2. Two or more shared entities                     -> >= 0.7
 *   3. One shared entity AND 2+ shared title concepts  -> >= 0.7
 *   4. Three or more shared title concepts             -> >= 0.6
 *   5. Otherwise                                       -> Jaccard
 *
 * "Shared title concepts" uses 6-char prefix matching so morphological
 * variants (transcripts / transcription, launches / launched) are
 * treated as the same concept. This is what catches the real-world
 * duplicate pattern of "MoJ rolling out AI transcription" vs "AI to
 * get a court transcription try-out, Ministry of Justice confirms".
 */
export function similarity(a, b) {
  if (!a || !b) return 0;

  const entOverlap = overlapCount(a.entities, b.entities);
  const numOverlap = overlapCount(a.numerics, b.numerics);
  const titleOverlap = conceptOverlap(a.title_tokens, b.title_tokens);

  const allA = [...(a.entities || []), ...(a.numerics || []), ...(a.keywords || []), ...(a.title_tokens || [])];
  const allB = [...(b.entities || []), ...(b.numerics || []), ...(b.keywords || []), ...(b.title_tokens || [])];
  const j = jaccard(allA, allB);

  if (entOverlap >= 1 && numOverlap >= 1) return Math.max(0.9, j);
  if (entOverlap >= 2) return Math.max(0.7, j);
  if (entOverlap >= 1 && titleOverlap >= 2) return Math.max(0.7, j);
  if (titleOverlap >= 3) return Math.max(0.6, j);
  return j;
}

/**
 * Check a fingerprint against a list of priors. Returns the best
 * match {id, title, slug, category, source, similarity} or null.
 */
export function findDuplicate(fp, priors, threshold = DEFAULT_THRESHOLD) {
  let best = null;
  for (const p of (priors || [])) {
    if (!p?.fingerprint) continue;
    const sim = similarity(fp, p.fingerprint);
    if (sim >= threshold && (!best || sim > best.similarity)) {
      best = { ...p, similarity: sim };
    }
  }
  return best;
}

// ── Loading priors ───────────────────────────────────────────────

/**
 * Load prior fingerprints from editorial log and story queue. This
 * is the set a new candidate is compared against.
 */
export function loadPriorFingerprints({ logLimit = 100, includeQueue = true } = {}) {
  const priors = [];

  if (existsSync(EDITORIAL_LOG_PATH)) {
    const log = JSON.parse(readFileSync(EDITORIAL_LOG_PATH, 'utf-8'));
    const entries = (log.entries || []).slice(-logLimit);
    for (const e of entries) {
      const fp = e.fingerprint || fingerprint({ title: e.title || '', summary: e.summary || '' });
      priors.push({
        id: e.slug || e.url || e.title,
        title: e.title,
        slug: e.slug,
        category: e.category,
        publishDate: e.publishDate,
        source: 'editorial_log',
        fingerprint: fp
      });
    }
  }

  if (includeQueue && existsSync(QUEUE_PATH)) {
    const q = JSON.parse(readFileSync(QUEUE_PATH, 'utf-8'));
    for (const s of (q.stories || [])) {
      if (s.status === 'killed') continue;
      const fp = s.fingerprint || fingerprint({ title: s.title || '', summary: s.research_brief || '' });
      priors.push({
        id: s.slug,
        title: s.title,
        slug: s.slug,
        category: s.category,
        status: s.status,
        source: 'queue',
        fingerprint: fp
      });
    }
  }

  return priors;
}

// ── Retrospective scan ───────────────────────────────────────────

/**
 * Scan the editorial log for likely duplicate pairs. Useful for
 * auditing historical coverage so existing duplicates can be
 * consolidated by hand.
 */
export function scanEditorialLog({ threshold = DEFAULT_THRESHOLD } = {}) {
  if (!existsSync(EDITORIAL_LOG_PATH)) return [];

  const log = JSON.parse(readFileSync(EDITORIAL_LOG_PATH, 'utf-8'));
  const entries = (log.entries || []).slice();

  for (const e of entries) {
    if (!e.fingerprint) {
      e.fingerprint = fingerprint({ title: e.title || '', summary: e.summary || '' });
    }
  }

  const pairs = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const sim = similarity(entries[i].fingerprint, entries[j].fingerprint);
      if (sim >= threshold) {
        pairs.push({
          a: {
            title: entries[i].title,
            slug: entries[i].slug,
            category: entries[i].category,
            publishDate: entries[i].publishDate
          },
          b: {
            title: entries[j].title,
            slug: entries[j].slug,
            category: entries[j].category,
            publishDate: entries[j].publishDate
          },
          similarity: sim
        });
      }
    }
  }

  pairs.sort((x, y) => y.similarity - x.similarity);
  return pairs;
}

export default {
  fingerprint,
  similarity,
  findDuplicate,
  loadPriorFingerprints,
  scanEditorialLog
};

// ── CLI ──────────────────────────────────────────────────────────

if (process.argv[1] && process.argv[1].endsWith('dedupe.mjs')) {
  const args = process.argv.slice(2);
  if (args.includes('--scan')) {
    const thresholdArg = args.indexOf('--threshold');
    const threshold = thresholdArg >= 0 ? parseFloat(args[thresholdArg + 1]) : DEFAULT_THRESHOLD;
    const pairs = scanEditorialLog({ threshold });
    if (pairs.length === 0) {
      console.log(`[dedupe] No likely duplicate pairs at threshold ${threshold}.`);
    } else {
      console.log(`[dedupe] ${pairs.length} likely duplicate pair(s) at threshold ${threshold}:\n`);
      for (const p of pairs) {
        console.log(`  [${p.similarity.toFixed(2)}]`);
        console.log(`    A: ${p.a.title}`);
        console.log(`       ${p.a.slug || ''}  (${p.a.category || '-'}, ${p.a.publishDate || '-'})`);
        console.log(`    B: ${p.b.title}`);
        console.log(`       ${p.b.slug || ''}  (${p.b.category || '-'}, ${p.b.publishDate || '-'})\n`);
      }
    }
    process.exit(0);
  }
  console.log('Usage: node agents/dedupe.mjs --scan [--threshold 0.5]');
  process.exit(0);
}
