/**
 * triage.mjs -- Batched triage stage (v4, Gemini)
 *
 * Takes a pre-filtered shortlist of up to 20 candidates (already scored
 * by prefilter.mjs), sends them to Gemini Flash-Lite in a single call,
 * and gets back a ranked JSON verdict. Top picks are enqueued for the
 * editor.
 *
 * v4 changes (token minimisation):
 *   - Triage-once tracking: every item sent to the model is recorded in
 *     memory/triaged-urls.json and never sent again. Previously the same
 *     RSS item could be re-triaged dozens of times as it sat in the feed
 *     across 20-minute cycles -- the single biggest token leak in v3.
 *   - Recent-coverage context trimmed from 60 to 25 entries, summaries
 *     capped at 200 chars.
 *   - Anthropic SDK and prompt caching removed. The ephemeral cache had
 *     a 5-minute TTL and never hit at a 20-minute cadence, so every call
 *     paid the cache-write surcharge for nothing.
 *
 * Run: node agents/triage.mjs
 * Expects: GEMINI_API_KEY
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { generate, MODELS } from './llm.mjs';
import { applyPrefilter, buildTriageShortlist } from './prefilter.mjs';
import { enqueue, stats } from './queue.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MEMORY_DIR = join(__dirname, 'memory');
const DIGEST_PATH = join(MEMORY_DIR, 'latest-digest.json');
const TRIAGE_PATH = join(MEMORY_DIR, 'latest-triage.json');
const TRIAGED_URLS_PATH = join(MEMORY_DIR, 'triaged-urls.json');
const EDITORIAL_LOG_PATH = join(MEMORY_DIR, 'editorial-log.json');
const POSITIONS_PATH = join(MEMORY_DIR, 'positions.json');
const SOURCES_PATH = join(__dirname, 'sources.json');

if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });

const MAX_SHORTLIST = 20;
const MAX_ENQUEUE = 5;
const MIN_TRIAGE_SCORE = 6;
const TRIAGED_RETENTION_DAYS = 14;
const TRIAGED_CAP = 2000;

// ── Triage-once tracking ──
// An item is triaged exactly once. Whatever the verdict (enqueue, watch,
// drop), re-sending it to the model on the next cycle cannot change the
// outcome enough to justify paying for it again.

function urlKey(url) {
  return (url || '').replace(/\/$/, '').replace(/^https?:\/\//, '').toLowerCase();
}

function loadTriagedUrls() {
  if (!existsSync(TRIAGED_URLS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(TRIAGED_URLS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveTriagedUrls(map, newItems) {
  const now = Date.now();
  const cutoff = now - TRIAGED_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  for (const item of newItems) {
    const key = urlKey(item.url);
    if (key) map[key] = new Date(now).toISOString();
  }

  // Prune old entries, then cap total size (oldest first)
  let entries = Object.entries(map)
    .filter(([, ts]) => new Date(ts).getTime() >= cutoff)
    .sort((a, b) => new Date(a[1]) - new Date(b[1]));
  if (entries.length > TRIAGED_CAP) entries = entries.slice(-TRIAGED_CAP);

  writeFileSync(TRIAGED_URLS_PATH, JSON.stringify(Object.fromEntries(entries), null, 2));
}

// System prompt is stable across runs -- eligible for prompt caching.
const TRIAGE_SYSTEM = `You are the news triage editor for lawpeeps.ai, a legal AI publication founded by an immigration solicitor. Your job is fast, cheap judgment: given a shortlist of candidate stories that have already passed keyword prefiltering, decide which ones are worth an editor's time.

You reply with JSON only. No prose, no preamble.

Editorial focus: legal AI, legal tech, UK regulation (SRA, BSB, Law Society, Judicial Office, ICO), immigration law and immigration AI, major company moves (Harvey, Luminance, CoCounsel, Spellbook, Robin AI, vLex, Lexis+AI, Thomson Reuters, Clio, Anthropic, OpenAI), AI funding rounds in the legal vertical, and firm adoption stories.

Scoring principles:
- Reward primary sources over commentary
- Reward stories that haven't been covered yet
- Penalise marketing puff, low-value aggregation, and stories already in recent coverage
- Prefer UK and EU angle but do not exclude US if the story is genuinely new
- A story that Artificial Lawyer, LawSites, or Legal IT Insider would cover deserves a 7+
- A press release with no independent news hook deserves a 3-4
- A funding round at a named watch-list company deserves a 7+ automatically
- A regulator statement on AI deserves an 8+ automatically

Dedupe rules (strict):
- If a shortlist item is the same underlying news event as a recent coverage entry (same regulator + same action, same company + same funding round, same court + same judgment), set verdict to "drop" and put the recent-coverage slug in duplicate_of. Different headline framing or different category does not make it a new story.
- Two shortlist items covering the same event are also duplicates of each other. Keep the one with the better primary source, drop the other with duplicate_of pointing to the one you kept.
- If unsure whether two items are the same story, set verdict to "watch" and flag it. Do not enqueue both.

Return exactly this JSON shape:

{
  "picks": [
    {
      "id": "the item id you were given",
      "score": 1-10,
      "category": "Legal AI | Regulatory | Funding | Adoption | Research | Policy | Immigration AI | Social",
      "suggested_angle": "short sentence",
      "why_now": "one sentence on newsworthiness",
      "verdict": "enqueue | watch | drop",
      "duplicate_of": "id of another shortlist item this duplicates, or null"
    }
  ],
  "summary": {
    "enqueue_count": 0,
    "watch_count": 0,
    "drop_count": 0,
    "notes": "one-line summary"
  }
}`;

function loadRecentCoverage() {
  if (!existsSync(EDITORIAL_LOG_PATH)) return [];
  const log = JSON.parse(readFileSync(EDITORIAL_LOG_PATH, 'utf-8'));
  // Last 25 entries with slug, category and the distinctive entities
  // from the fingerprint. Enough for the model to spot "this is the MoJ
  // AI transcripts story from two days ago under a different headline"
  // without needing any search. (Was 60 in v3 -- trimmed to cut input
  // tokens on every triage call.)
  return (log.entries || []).slice(-25).map(e => ({
    title: e.title,
    slug: e.slug,
    category: e.category,
    publishDate: e.publishDate,
    entities: e.fingerprint?.entities || []
  }));
}

function loadOpenThreads() {
  if (!existsSync(POSITIONS_PATH)) return [];
  const positions = JSON.parse(readFileSync(POSITIONS_PATH, 'utf-8'));
  return (positions.open_questions || []).slice(0, 10);
}

function buildUserMessage(shortlist, recentCoverage, openThreads) {
  const items = shortlist.map((item, idx) => {
    const id = item.id || `item-${idx}`;
    return `${id}: ${item.title}
  source: ${item.source_name || item.source_id || 'unknown'} (tier ${item.source_tier || '?'}, ${item.source_priority || '?'})
  published: ${item.published || 'undated'}
  prefilter_score: ${item.prefilter?.score ?? '?'}
  matched: ${[...(item.prefilter?.matched?.keywords || []), ...(item.prefilter?.matched?.companies || [])].join(', ') || 'none'}
  summary: ${(item.summary || '').slice(0, 200)}
  url: ${item.url}`;
  }).join('\n\n');

  const recent = recentCoverage.length > 0
    ? recentCoverage.map(c => {
        if (typeof c === 'string') return `- ${c}`;
        const ents = (c.entities && c.entities.length > 0)
          ? ` [entities: ${c.entities.join(', ')}]`
          : '';
        const cat = c.category ? ` (${c.category})` : '';
        const date = c.publishDate ? ` ${c.publishDate}` : '';
        return `- ${c.title}${cat}${date}${ents} [slug: ${c.slug || '-'}]`;
      }).join('\n')
    : '- none yet';

  const threads = openThreads.length > 0
    ? openThreads.map(q => `- ${q}`).join('\n')
    : '- none';

  return `## Shortlist (${shortlist.length} items)

${items}

## Recent coverage (avoid duplicating)
${recent}

## Open editorial threads
${threads}

Return the JSON verdict now.`;
}

function parseJSONFromResponse(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  return JSON.parse(raw.trim());
}

function storyFromPick(pick, item) {
  const slug = (item.title || 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);

  return {
    title: item.title,
    slug,
    score: pick.score,
    category: pick.category,
    story_type: 'news',
    research_brief: item.summary || pick.why_now || '',
    primary_source: item.url,
    primary_source_verified: false,
    additional_sources: [],
    key_facts: [],
    suggested_angle: pick.suggested_angle || '',
    why_now: pick.why_now || '',
    existing_coverage: 'Triage could not check existing coverage. Editor should scan recent coverage list.',
    verification_notes: 'Triage did not verify claims. Verifier must confirm all factual assertions before staging.',
    serves_50_percent_rule: null,
    fifty_percent_note: '',
    estimated_staging: 'amber',
    source_name: item.source_name,
    source_tier: item.source_tier,
    prefilter_score: item.prefilter?.score,
    matched_terms: [
      ...(item.prefilter?.matched?.keywords || []),
      ...(item.prefilter?.matched?.companies || [])
    ],
    fingerprint: item.prefilter?.fingerprint || null,
    triage_verdict: pick.verdict,
    triage_run: new Date().toISOString()
  };
}

export async function runTriage({ tierFilter = null } = {}) {
  const t0 = Date.now();
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[triage] TRIAGE RUN: ${new Date().toISOString()}${tierFilter ? ` (tier ${tierFilter})` : ''}`);
  console.log(`${'='.repeat(60)}\n`);

  if (!existsSync(DIGEST_PATH)) {
    console.log('[triage] No digest found. Run monitor first.');
    return { picks: [], enqueued: 0 };
  }

  const digest = JSON.parse(readFileSync(DIGEST_PATH, 'utf-8'));
  let items = digest.items || [];

  if (tierFilter) {
    items = items.filter(i => i.source_tier === tierFilter);
  }

  if (items.length === 0) {
    console.log('[triage] No items in digest to triage.');
    return { picks: [], enqueued: 0 };
  }

  const prefiltered = applyPrefilter(items);
  console.log(`[triage] Prefilter: ${prefiltered.stats.accepted} accept, ${prefiltered.stats.borderline} borderline, ${prefiltered.stats.rejected} reject (of ${prefiltered.stats.total})`);

  let shortlist = buildTriageShortlist(prefiltered, { maxItems: MAX_SHORTLIST, includeBorderline: true });

  // Triage-once gate: drop anything the model has already judged.
  const triagedUrls = loadTriagedUrls();
  const beforeGate = shortlist.length;
  shortlist = shortlist.filter(item => !triagedUrls[urlKey(item.url)]);
  if (beforeGate !== shortlist.length) {
    console.log(`[triage] Triage-once gate: ${beforeGate - shortlist.length} of ${beforeGate} items already triaged, skipping them.`);
  }

  if (shortlist.length === 0) {
    console.log('[triage] Nothing new to triage. No API call made.');
    writeFileSync(TRIAGE_PATH, JSON.stringify({
      generated: new Date().toISOString(),
      cycle_type: 'triage',
      shortlist_size: 0,
      picks: [],
      prefilter: prefiltered.stats,
      skipped_already_triaged: beforeGate
    }, null, 2));
    return { picks: [], enqueued: 0 };
  }

  const shortlistWithIds = shortlist.map((item, idx) => ({
    ...item,
    id: item.id || `${item.source_id || 'src'}-${idx}`
  }));

  const recentCoverage = loadRecentCoverage();
  const openThreads = loadOpenThreads();
  const userMessage = buildUserMessage(shortlistWithIds, recentCoverage, openThreads);

  console.log(`[triage] Sending ${shortlistWithIds.length}-item shortlist to ${MODELS.triage}...`);
  const { text, usage } = await generate({
    model: MODELS.triage,
    system: TRIAGE_SYSTEM,
    user: userMessage,
    maxTokens: 2000,
    label: 'triage'
  });

  // Record every item as triaged, whatever the verdict, so it is never
  // paid for again.
  saveTriagedUrls(triagedUrls, shortlistWithIds);

  let result;
  try {
    result = parseJSONFromResponse(text);
  } catch (err) {
    console.error('[triage] Failed to parse triage response:', err.message);
    console.error('[triage] Raw response preview:', text.slice(0, 400));
    result = { picks: [], summary: { notes: 'parse_failed' } };
  }

  const picksById = new Map();
  for (const pick of (result.picks || [])) {
    picksById.set(pick.id, pick);
  }

  const enqueueCandidates = shortlistWithIds
    .map(item => {
      const pick = picksById.get(item.id);
      if (!pick) return null;
      return { pick, item };
    })
    .filter(Boolean)
    .filter(({ pick }) => pick.verdict === 'enqueue' && pick.score >= MIN_TRIAGE_SCORE && !pick.duplicate_of)
    .sort((a, b) => b.pick.score - a.pick.score)
    .slice(0, MAX_ENQUEUE);

  let enqueuedCount = 0;
  for (const { pick, item } of enqueueCandidates) {
    const story = storyFromPick(pick, item);
    if (enqueue(story)) enqueuedCount++;
  }

  const triageLog = {
    generated: new Date().toISOString(),
    cycle_type: 'triage',
    tier_filter: tierFilter,
    shortlist_size: shortlistWithIds.length,
    prefilter: prefiltered.stats,
    model: MODELS.triage,
    picks: result.picks || [],
    summary: result.summary || {},
    enqueued: enqueuedCount,
    usage: usage || null
  };
  writeFileSync(TRIAGE_PATH, JSON.stringify(triageLog, null, 2));

  const elapsed = Math.round((Date.now() - t0) / 1000);
  const queueStats = stats();
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[triage] TRIAGE COMPLETE (${elapsed}s)`);
  console.log(`[triage] Picks: ${result.picks?.length || 0} | Enqueued: ${enqueuedCount}`);
  console.log(`[triage] Queue: ${queueStats.pending} pending, ${queueStats.published} published`);
  if (usage) {
    console.log(`[triage] Tokens: ${usage.input_tokens || '?'} in, ${usage.output_tokens || '?'} out (free tier -- rate limited, not billed)`);
  }
  console.log(`${'='.repeat(60)}\n`);

  return { picks: result.picks || [], enqueued: enqueuedCount };
}

if (process.argv[1] && process.argv[1].endsWith('triage.mjs')) {
  const tierArg = process.argv.includes('--tier')
    ? process.argv[process.argv.indexOf('--tier') + 1]
    : null;
  runTriage({ tierFilter: tierArg }).catch(err => {
    console.error('[triage] Fatal error:', err);
    process.exit(1);
  });
}
