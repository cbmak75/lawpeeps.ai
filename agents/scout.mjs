/**
 * scout.mjs -- Scout Agent
 *
 * The journalist on the beat. Runs independently of mm!ke on its
 * own schedule. Scans RSS feeds, searches the web for stories the
 * feeds missed, researches the best candidates, and deposits
 * fully-briefed stories into the queue for mm!ke to curate.
 *
 * The scout does NOT write articles. It produces structured research
 * briefs -- the raw material mm!ke needs to do his job.
 *
 * Run: node agents/scout.mjs
 * Expects: ANTHROPIC_API_KEY
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { runMonitor } from './monitor.mjs';
import { enqueue, stats, prune } from './queue.mjs';
import { withRetry } from './rate-limit-helper.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MEMORY_DIR = join(__dirname, 'memory');
const SOURCES_PATH = join(__dirname, 'sources.json');
const EDITORIAL_LOG_PATH = join(MEMORY_DIR, 'editorial-log.json');
const POSITIONS_PATH = join(MEMORY_DIR, 'positions.json');
const KNOWLEDGE_PATH = join(MEMORY_DIR, 'knowledge.json');
const DISCOVERY_PATH = join(MEMORY_DIR, 'latest-discovery.json');

if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });

const client = new Anthropic();

// ── Load memory context for the scout ──

function loadScoutContext() {
  const ctx = {};

  if (existsSync(EDITORIAL_LOG_PATH)) {
    const log = JSON.parse(readFileSync(EDITORIAL_LOG_PATH, 'utf-8'));
    ctx.recentCoverage = (log.entries || []).slice(-30)
      .map(e => `- ${e.title} (${e.publishDate || 'undated'})`)
      .join('\n');
  }

  if (existsSync(POSITIONS_PATH)) {
    const p = JSON.parse(readFileSync(POSITIONS_PATH, 'utf-8'));
    ctx.openQuestions = (p.open_questions || []).map(q => `- ${q}`).join('\n');
    ctx.trackedThemes = (p.tracked_themes || [])
      .map(t => `- ${t.theme}: ${t.status}`).join('\n');
  }

  if (existsSync(KNOWLEDGE_PATH)) {
    const k = JSON.parse(readFileSync(KNOWLEDGE_PATH, 'utf-8'));
    ctx.knownEntities = Object.entries(k.entities || {})
      .slice(0, 30)
      .map(([name, data]) => `- ${name}: ${data.description || 'known entity'}`)
      .join('\n');
  }

  const sources = JSON.parse(readFileSync(SOURCES_PATH, 'utf-8'));
  ctx.keywords = sources.scoring.keywords.join(', ');
  ctx.watchList = sources.scoring.watch_list_companies.join(', ');

  return ctx;
}

// ── Build the scout prompt ──
// This is ONE prompt that covers discovery + research in a single agent call.
// The agent searches, finds stories, researches them, and returns structured briefs.

function buildScoutPrompt(digest, ctx) {
  const digestSummary = (digest.items || [])
    .slice(0, 15)
    .map(i => `- [${i.source_id}] ${i.title} (score: ${i.relevance_score})`)
    .join('\n');

  return `You are a news scout for lawpeeps.ai, a legal AI publication. Your job is to find and research stories, then return structured briefs for the editor.

## What the RSS feeds found

The monitoring agent scanned ${digest.sources_checked || 0} feeds and found ${digest.item_count || 0} candidates. Top items:

${digestSummary || 'No items from feeds this cycle.'}

## Recent coverage (avoid duplicating)

${ctx.recentCoverage || 'No recent coverage recorded.'}

## Open questions the editor is tracking

${ctx.openQuestions || 'None yet.'}

## Themes being watched

${ctx.trackedThemes || 'None yet.'}

## Editorial focus

Keywords: ${ctx.keywords}
Watch list companies: ${ctx.watchList}

## Your task

Do two things:

### 1. Discover stories the feeds missed

Search the web for recent legal AI developments. Focus on:
- Product launches, funding rounds, acquisitions in legal AI
- Regulatory developments (SRA, Law Society, EU AI Act, international)
- Court decisions involving AI
- Notable firm adoptions or public statements about AI
- Academic research with practical legal AI implications

Run 3-4 targeted searches maximum. Quality over quantity.

### 2. Research the best candidates

From the RSS digest AND your web discoveries, identify the 2-3 most newsworthy stories. For each one, research it:
- Verify the core claim (find the primary source)
- Build context (background, who is involved, broader trends)
- Find additional angles or competing perspectives
- Check whether other publications have already covered it

### 3. Return structured briefs

Return a JSON object with this structure:

{
  "scout_run": "${new Date().toISOString()}",
  "stories": [
    {
      "title": "Headline-style title",
      "slug": "url-friendly-slug-max-80-chars",
      "score": 1-10,
      "category": "Legal AI | Regulatory | Funding | Adoption | Research | Policy | Immigration AI",
      "story_type": "news | analysis | profile | commentary",
      "research_brief": "3-5 paragraph summary covering what happened, why it matters, the context, and any competing perspectives",
      "primary_source": "URL",
      "primary_source_verified": true/false,
      "additional_sources": [
        { "url": "...", "description": "What this adds" }
      ],
      "key_facts": [
        { "claim": "Specific factual claim", "source": "URL", "verified": true/false }
      ],
      "suggested_angle": "The most interesting angle for lawpeeps.ai",
      "serves_50_percent_rule": true/false,
      "fifty_percent_note": "Why or why not",
      "existing_coverage": "Whether other outlets have covered this and how",
      "estimated_staging": "green | amber | red",
      "verification_notes": "Anything the verification agent should pay special attention to"
    }
  ],
  "knowledge_updates": [
    { "entity": "Name", "update": "What we now know" }
  ],
  "search_queries_used": ["list of searches run"]
}

Return ONLY the JSON object.`;
}

// ── Update knowledge base ──

function updateKnowledge(updates) {
  let knowledge = { entities: {}, last_updated: null };
  if (existsSync(KNOWLEDGE_PATH)) {
    knowledge = JSON.parse(readFileSync(KNOWLEDGE_PATH, 'utf-8'));
  }

  for (const update of updates) {
    const key = update.entity.toLowerCase();
    if (!knowledge.entities[key]) {
      knowledge.entities[key] = {
        name: update.entity,
        first_seen: new Date().toISOString().split('T')[0],
        updates: []
      };
    }
    knowledge.entities[key].last_updated = new Date().toISOString().split('T')[0];
    knowledge.entities[key].updates.push({
      date: new Date().toISOString().split('T')[0],
      content: update.update
    });
    if (knowledge.entities[key].updates.length > 20) {
      knowledge.entities[key].updates = knowledge.entities[key].updates.slice(-20);
    }
  }

  knowledge.last_updated = new Date().toISOString();
  writeFileSync(KNOWLEDGE_PATH, JSON.stringify(knowledge, null, 2));
}

// ── Run the scout ──

async function runScout() {
  const startTime = Date.now();
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[scout] SCOUT RUN STARTING: ${new Date().toISOString()}`);
  console.log(`${'='.repeat(60)}\n`);

  // Prune old queue entries
  prune();

  // Phase 1: Monitor RSS (no API call)
  console.log('[scout] Scanning RSS feeds...');
  const digest = await runMonitor();
  console.log(`[scout] RSS scan complete: ${digest.item_count} items from ${digest.sources_checked} sources`);

  // Phase 2: Discovery + Research (single API call with web search)
  console.log('[scout] Searching and researching...');
  const ctx = loadScoutContext();
  const prompt = buildScoutPrompt(digest, ctx);

  const response = await withRetry(() => client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 10000,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages: [{ role: 'user', content: prompt }]
  }), 'scout');

  // Extract text response
  let resultText = '';
  for (const block of response.content) {
    if (block.type === 'text') resultText += block.text;
  }

  // Parse JSON
  let scoutResult;
  try {
    const jsonMatch = resultText.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, resultText];
    scoutResult = JSON.parse(jsonMatch[1].trim());
  } catch (err) {
    console.error('[scout] Failed to parse scout response:', err.message);
    scoutResult = { stories: [], knowledge_updates: [], search_queries_used: [] };
  }

  // Deposit stories into the queue
  let enqueued = 0;
  for (const story of (scoutResult.stories || [])) {
    if (story.score >= 5) {
      const added = enqueue(story);
      if (added) enqueued++;
    } else {
      console.log(`[scout] Skipped low-score story: ${story.title} (${story.score})`);
    }
  }

  // Update knowledge base
  if (scoutResult.knowledge_updates?.length > 0) {
    updateKnowledge(scoutResult.knowledge_updates);
    console.log(`[scout] Updated knowledge base: ${scoutResult.knowledge_updates.length} entities`);
  }

  // Save discovery log for reference
  writeFileSync(DISCOVERY_PATH, JSON.stringify({
    ...scoutResult,
    generated: new Date().toISOString(),
    cycle_type: 'scout'
  }, null, 2));

  const queueStats = stats();
  const elapsed = Math.round((Date.now() - startTime) / 1000);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`[scout] SCOUT RUN COMPLETE (${elapsed}s)`);
  console.log(`[scout] Stories found: ${scoutResult.stories?.length || 0}`);
  console.log(`[scout] Stories enqueued: ${enqueued}`);
  console.log(`[scout] Queue: ${queueStats.pending} pending, ${queueStats.published} published`);
  console.log(`${'='.repeat(60)}\n`);

  return scoutResult;
}

export { runScout };

if (process.argv[1] && process.argv[1].endsWith('scout.mjs')) {
  runScout().catch(err => {
    console.error('[scout] Fatal error:', err);
    process.exit(1);
  });
}
