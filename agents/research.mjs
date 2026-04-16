/**
 * research.mjs -- Research Agent
 *
 * Takes candidate stories from monitoring and discovery, performs
 * deep targeted research on each one. Builds comprehensive context
 * for the editorial agent to work with.
 *
 * Run: node agents/research.mjs
 * Expects: ANTHROPIC_API_KEY
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MEMORY_DIR = join(__dirname, 'memory');
const DIGEST_PATH = join(MEMORY_DIR, 'latest-digest.json');
const DISCOVERY_PATH = join(MEMORY_DIR, 'latest-discovery.json');
const RESEARCH_PATH = join(MEMORY_DIR, 'latest-research.json');
const EDITORIAL_LOG_PATH = join(MEMORY_DIR, 'editorial-log.json');
const KNOWLEDGE_PATH = join(MEMORY_DIR, 'knowledge.json');

const client = new Anthropic();

// ── Merge candidates from monitoring and discovery ──

function mergeCandidates() {
  const candidates = [];

  // From monitoring digest
  if (existsSync(DIGEST_PATH)) {
    const digest = JSON.parse(readFileSync(DIGEST_PATH, 'utf-8'));
    for (const item of (digest.items || []).slice(0, 15)) {
      if (item.relevance_score >= 3) {
        candidates.push({
          origin: 'monitoring',
          title: item.title,
          url: item.url,
          summary: item.summary,
          source: item.source_name,
          score: item.relevance_score,
          is_tip: item.is_tip || false
        });
      }
    }
  }

  // From discovery
  if (existsSync(DISCOVERY_PATH)) {
    const discovery = JSON.parse(readFileSync(DISCOVERY_PATH, 'utf-8'));
    for (const item of (discovery.discoveries || [])) {
      if (item.relevance === 'high' || item.relevance === 'medium') {
        candidates.push({
          origin: 'discovery',
          title: item.title,
          url: item.url,
          summary: item.summary,
          source: 'web search',
          discovery_method: item.discovery_method,
          score: item.relevance === 'high' ? 8 : 5,
          verification_needed: item.verification_needed
        });
      }
    }
  }

  // Sort by score, take top 10 for deep research
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, 10);
}

// ── Build research prompt for a batch of candidates ──

function buildResearchPrompt(candidates) {
  // Load knowledge context
  let knowledgeContext = '';
  if (existsSync(KNOWLEDGE_PATH)) {
    const knowledge = JSON.parse(readFileSync(KNOWLEDGE_PATH, 'utf-8'));
    if (knowledge.entities) {
      const entitySummaries = Object.entries(knowledge.entities)
        .slice(0, 30)
        .map(([name, data]) => `- ${name}: ${data.description || 'No description'}. Last covered: ${data.last_covered || 'never'}`)
        .join('\n');
      knowledgeContext = `\n## Entities I already know about\n\n${entitySummaries}\n`;
    }
  }

  // Load recent coverage to avoid duplication
  let recentCoverage = '';
  if (existsSync(EDITORIAL_LOG_PATH)) {
    const log = JSON.parse(readFileSync(EDITORIAL_LOG_PATH, 'utf-8'));
    const recent = (log.entries || []).slice(-20);
    if (recent.length > 0) {
      recentCoverage = '\n## Stories I have published recently\n\n' +
        recent.map(e => `- ${e.title} (${e.publishDate || 'undated'}): ${e.summary || ''}`).join('\n') + '\n';
    }
  }

  const candidateList = candidates
    .map((c, i) => `### Candidate ${i + 1}: ${c.title}
- Origin: ${c.origin} (${c.source})
- URL: ${c.url}
- Summary: ${c.summary}
- Score: ${c.score}
${c.verification_needed ? `- Verification note: ${c.verification_needed}` : ''}
${c.is_tip ? '- This came from the reader tip line' : ''}`)
    .join('\n\n');

  return `You are mm!ke's research agent. You have been given ${candidates.length} candidate stories identified by the monitoring and discovery agents. Your job is to perform deep, targeted research on each one to build the context needed for editorial decision-making and article drafting.
${knowledgeContext}
${recentCoverage}
## Candidate stories for research

${candidateList}

## Your task

For each candidate, use web search to:

1. **Verify the core claim**: Is the development real? Can you find the primary source (company announcement, court filing, regulatory publication, press release)?

2. **Build context**: What is the background? Who is involved? What has happened before in this area? How does this connect to broader trends in legal AI?

3. **Find additional angles**: Are there related developments? Has anyone commented on this? Are there competing products, contradictory claims, or dissenting views?

4. **Assess newsworthiness**: Given what you find, is this actually worth covering? Would it tell the lawpeeps.ai audience something they did not already know and should?

5. **Check for existing coverage**: Has this already been well covered by other legal AI publications? If so, is there a fresh angle?

6. **Identify the 50% rule angle**: Does this story serve the underrepresented part of the audience (small firms, solo practitioners, early-stage founders, regional developments, academic researchers)?

## Output format

Return a JSON object:
{
  "researched_candidates": [
    {
      "original_title": "The candidate title",
      "original_url": "The candidate URL",
      "research_summary": "3-5 paragraph summary of what you found through research",
      "primary_source": "URL of the primary/original source",
      "primary_source_verified": true/false,
      "additional_sources": [
        { "url": "...", "description": "What this source adds", "reliability": "high|medium|low" }
      ],
      "key_facts": [
        { "claim": "Specific factual claim", "source": "Where you found it", "verified": true/false }
      ],
      "context": "Background and broader context for this story",
      "existing_coverage": [
        { "publication": "Name", "url": "URL", "angle": "How they covered it" }
      ],
      "editorial_recommendation": "cover | skip | hold_for_more_info | merge_with_other",
      "recommendation_rationale": "Why this recommendation",
      "suggested_angle": "The most interesting or underserved angle for lawpeeps.ai",
      "suggested_story_type": "news | analysis | profile | commentary | investigation",
      "serves_50_percent_rule": true/false,
      "fifty_percent_explanation": "Why or why not",
      "estimated_staging": "green | amber | red",
      "staging_rationale": "Why this staging classification",
      "search_queries_used": ["List of searches performed"]
    }
  ],
  "cross_cutting_themes": [
    "Themes that span multiple candidates -- potential for a roundup or analysis piece"
  ],
  "knowledge_updates": [
    {
      "entity": "Company or person name",
      "update": "What we now know that we did not before"
    }
  ]
}

Return ONLY the JSON object, no other text.`;
}

// ── Run research ──

async function runResearch() {
  console.log('[research] Merging candidates from monitoring and discovery...');
  const candidates = mergeCandidates();

  if (candidates.length === 0) {
    console.log('[research] No candidates to research. Exiting.');
    const empty = {
      generated: new Date().toISOString(),
      cycle_type: 'research',
      researched_candidates: [],
      cross_cutting_themes: [],
      knowledge_updates: [],
      note: 'No candidates met the threshold for deep research'
    };
    writeFileSync(RESEARCH_PATH, JSON.stringify(empty, null, 2));
    return empty;
  }

  console.log(`[research] Researching ${candidates.length} candidates...`);
  const prompt = buildResearchPrompt(candidates);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 12000,
    tools: [{ type: 'web_search_20250305' }],
    messages: [{ role: 'user', content: prompt }]
  });

  // Extract text response
  let resultText = '';
  for (const block of response.content) {
    if (block.type === 'text') {
      resultText += block.text;
    }
  }

  // Parse JSON
  let research;
  try {
    const jsonMatch = resultText.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, resultText];
    research = JSON.parse(jsonMatch[1].trim());
  } catch (err) {
    console.error('[research] Failed to parse research response:', err.message);
    research = {
      researched_candidates: [],
      cross_cutting_themes: [],
      knowledge_updates: [],
      parse_error: true
    };
  }

  // Add metadata
  research.generated = new Date().toISOString();
  research.cycle_type = 'research';
  research.model = 'claude-sonnet-4-20250514';
  research.candidates_input = candidates.length;

  // Update knowledge base with any new entity information
  if (research.knowledge_updates?.length > 0) {
    updateKnowledge(research.knowledge_updates);
  }

  writeFileSync(RESEARCH_PATH, JSON.stringify(research, null, 2));
  const coverCount = (research.researched_candidates || [])
    .filter(r => r.editorial_recommendation === 'cover').length;
  console.log(`[research] Research complete: ${research.researched_candidates?.length || 0} candidates researched, ${coverCount} recommended for coverage`);

  return research;
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
    // Cap update history at 20 per entity
    if (knowledge.entities[key].updates.length > 20) {
      knowledge.entities[key].updates = knowledge.entities[key].updates.slice(-20);
    }
  }

  knowledge.last_updated = new Date().toISOString();
  writeFileSync(KNOWLEDGE_PATH, JSON.stringify(knowledge, null, 2));
  console.log(`[research] Updated knowledge base: ${updates.length} entity updates`);
}

export { runResearch };

if (process.argv[1] && process.argv[1].endsWith('research.mjs')) {
  runResearch().catch(err => {
    console.error('[research] Fatal error:', err);
    process.exit(1);
  });
}
