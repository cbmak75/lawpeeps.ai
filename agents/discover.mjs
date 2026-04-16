/**
 * discover.mjs -- Discovery Agent
 *
 * Extends monitoring with active web search via Claude's built-in
 * web search tool. Hunts for stories the RSS feeds missed, follows
 * threads from the monitoring digest, and self-curates the source list
 * by identifying and adding valuable new sources.
 *
 * Run: node agents/discover.mjs
 * Expects: ANTHROPIC_API_KEY
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { withRetry } from './rate-limit-helper.mjs';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCES_PATH = join(__dirname, 'sources.json');
const MEMORY_DIR = join(__dirname, 'memory');
const DIGEST_PATH = join(MEMORY_DIR, 'latest-digest.json');
const DISCOVERY_PATH = join(MEMORY_DIR, 'latest-discovery.json');
const EDITORIAL_LOG_PATH = join(MEMORY_DIR, 'editorial-log.json');
const POSITIONS_PATH = join(MEMORY_DIR, 'positions.json');
const KNOWLEDGE_PATH = join(MEMORY_DIR, 'knowledge.json');

const client = new Anthropic();

// ── Load memory context ──

function loadMemory() {
  const memory = {};

  if (existsSync(EDITORIAL_LOG_PATH)) {
    const log = JSON.parse(readFileSync(EDITORIAL_LOG_PATH, 'utf-8'));
    // Last 30 entries to avoid bloating context
    memory.recentCoverage = (log.entries || []).slice(-30);
  }

  if (existsSync(POSITIONS_PATH)) {
    memory.positions = JSON.parse(readFileSync(POSITIONS_PATH, 'utf-8'));
  }

  if (existsSync(KNOWLEDGE_PATH)) {
    memory.knowledge = JSON.parse(readFileSync(KNOWLEDGE_PATH, 'utf-8'));
  }

  return memory;
}

// ── Build discovery prompt ──

function buildDiscoveryPrompt(digest, sources, memory) {
  const recentTitles = (memory.recentCoverage || [])
    .map(e => `- ${e.title} (${e.publishDate || 'undated'})`)
    .join('\n');

  const openQuestions = memory.positions?.open_questions
    ? memory.positions.open_questions.map(q => `- ${q}`).join('\n')
    : 'None recorded yet.';

  const trackedThemes = memory.positions?.tracked_themes
    ? memory.positions.tracked_themes.map(t => `- ${t.theme}: ${t.status}`).join('\n')
    : 'None recorded yet.';

  const watchList = sources.scoring.watch_list_companies.join(', ');
  const keywords = sources.scoring.keywords.join(', ');

  const digestSummary = digest.items
    .slice(0, 15)
    .map(i => `- [${i.source_id}] ${i.title} (score: ${i.relevance_score})`)
    .join('\n');

  return `You are mm!ke's discovery agent. Your job is to find stories that the RSS monitoring missed.

## IMPORTANT: Token budget constraint
You are operating under a strict API rate limit of 10,000 input tokens per minute. This means you must be economical with web searches. Limit yourself to 3-5 focused, high-value searches rather than exhaustive coverage. Prioritise quality over quantity. Each web search injects results into your context window, so fewer targeted searches will keep you within budget.

## Context

The monitoring agent just scanned ${digest.sources_checked} RSS feeds and found ${digest.item_count} candidate items. Here are the top items from the feeds:

${digestSummary}

## What I have already covered recently

${recentTitles || 'No recent coverage recorded.'}

## Open questions I am tracking

${openQuestions}

## Themes I am watching

${trackedThemes}

## My editorial focus

Keywords: ${keywords}
Watch list companies: ${watchList}

## Your task

Use web search to find developments in legal AI that the RSS feeds may have missed. Specifically:

1. **Standing searches**: Run searches for the most important current topics in legal AI. Think about what a knowledgeable legal AI journalist would search for today. Cover:
   - Recent legal AI product launches, funding rounds, or acquisitions
   - Regulatory developments affecting AI in legal practice (SRA, Law Society, Bar Standards Board, EU AI Act enforcement, international equivalents)
   - Court decisions involving AI (AI-generated submissions, AI evidence, AI in judicial processes)
   - Notable firm adoptions, pilot programmes, or public statements about AI use
   - Academic papers or reports with practical implications for legal AI

2. **Gap-filling**: Look at my recent coverage list above. What areas have I not covered recently? Search for developments in those gaps.

3. **Thread-following**: If any items in the monitoring digest suggest a broader story (a company mentioned in passing, a regulation referenced, a trend implied), search for more context.

4. **Source discovery**: If you find a valuable source of information that is not in my current feed list, flag it as a potential new source with a recommendation for whether to add it.

## Output format

Return a JSON object with this structure:
{
  "discoveries": [
    {
      "title": "Headline-style summary of the development",
      "url": "Primary source URL",
      "summary": "2-3 sentence summary of what happened and why it matters",
      "discovery_method": "standing_search | gap_fill | thread_follow | serendipity",
      "search_query": "The search query that found this",
      "relevance": "high | medium | low",
      "suggested_category": "Legal AI | Regulatory | Funding | Adoption | Research | Policy | Immigration AI",
      "related_digest_items": ["source_id of related monitoring items, if any"],
      "verification_needed": "Brief note on what would need checking before publication"
    }
  ],
  "new_source_recommendations": [
    {
      "name": "Source name",
      "url": "Source URL",
      "feed_url": "RSS feed URL if found, null if not",
      "category": "Category",
      "rationale": "Why this source is worth adding",
      "suggested_priority": "critical | high | medium | low",
      "reliability_assessment": "Initial reliability impression based on what you found"
    }
  ],
  "coverage_gaps_identified": [
    "Brief description of topics that seem underserved in recent coverage"
  ],
  "search_queries_run": [
    "List of all search queries you executed"
  ]
}

Return ONLY the JSON object, no other text.`;
}

// ── Run discovery ──

async function runDiscovery() {
  console.log('[discover] Starting web search discovery...');

  // Load inputs
  const sources = JSON.parse(readFileSync(SOURCES_PATH, 'utf-8'));
  let digest = { items: [], item_count: 0, sources_checked: 0 };
  if (existsSync(DIGEST_PATH)) {
    digest = JSON.parse(readFileSync(DIGEST_PATH, 'utf-8'));
  }
  const memory = loadMemory();

  const prompt = buildDiscoveryPrompt(digest, sources, memory);

  console.log('[discover] Calling Claude with web search enabled...');
  const response = await withRetry(() => client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8000,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages: [{ role: 'user', content: prompt }]
  }), 'discover');

  // Extract the text response (may be after tool use blocks)
  let resultText = '';
  for (const block of response.content) {
    if (block.type === 'text') {
      resultText += block.text;
    }
  }

  // Parse JSON from response
  let discovery;
  try {
    // Handle potential markdown code fences
    const jsonMatch = resultText.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, resultText];
    discovery = JSON.parse(jsonMatch[1].trim());
  } catch (err) {
    console.error('[discover] Failed to parse discovery response:', err.message);
    console.error('[discover] Raw response:', resultText.slice(0, 500));
    discovery = {
      discoveries: [],
      new_source_recommendations: [],
      coverage_gaps_identified: [],
      search_queries_run: [],
      parse_error: true
    };
  }

  // Add metadata
  discovery.generated = new Date().toISOString();
  discovery.cycle_type = 'discovery';
  discovery.model = 'claude-sonnet-4-20250514';

  // Auto-curate sources if recommendations exist
  if (discovery.new_source_recommendations?.length > 0) {
    await curateSourceList(sources, discovery.new_source_recommendations);
  }

  writeFileSync(DISCOVERY_PATH, JSON.stringify(discovery, null, 2));
  console.log(`[discover] Discovery complete: ${discovery.discoveries?.length || 0} items found, ${discovery.new_source_recommendations?.length || 0} new source recommendations`);

  return discovery;
}

// ── Source self-curation ──

async function curateSourceList(currentSources, recommendations) {
  const existingIds = new Set(currentSources.sources.map(s => s.id));

  for (const rec of recommendations) {
    // Generate a slug ID from the name
    const id = rec.name.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    if (existingIds.has(id)) {
      console.log(`[discover] Source already exists: ${id}`);
      continue;
    }

    const newSource = {
      id,
      name: rec.name,
      url: rec.url,
      feed: rec.feed_url || null,
      feed_fallback: rec.feed_url ? null : 'scrape',
      category: rec.category,
      priority: rec.suggested_priority || 'low',
      added_by: 'discovery-agent',
      added_date: new Date().toISOString().split('T')[0],
      reliability: 'probationary',
      reliability_score: 0,
      notes: `Auto-discovered. ${rec.rationale}. Initial assessment: ${rec.reliability_assessment || 'unrated'}.`
    };

    currentSources.sources.push(newSource);
    existingIds.add(id);
    console.log(`[discover] Added new source: ${rec.name} (${id}) at probationary reliability`);
  }

  // Update the sources file
  currentSources.meta.updated = new Date().toISOString().split('T')[0];
  currentSources.meta.notes += ` Discovery agent auto-curation run ${new Date().toISOString().split('T')[0]}.`;
  writeFileSync(SOURCES_PATH, JSON.stringify(currentSources, null, 2));
}

export { runDiscovery };

if (process.argv[1] && process.argv[1].endsWith('discover.mjs')) {
  runDiscovery().catch(err => {
    console.error('[discover] Fatal error:', err);
    process.exit(1);
  });
}
