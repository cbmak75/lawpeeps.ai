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

  // Sort by score, take top 5 for deep research.
  // Capped at 5 (not 10) to stay within the 10k input tokens/min API rate limit.
  // Each candidate requires 2-3 web searches, and search results are token-heavy.
  Candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, 5);
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
  Let�T XcentCoverage = '';
  if (existsSync(EDITORIAL_LOG_PATH) {
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

## IMPORTANT: Token budget constraint
You are operating under a strict API rate limit of 10,000 input tokens per minute. Each web search injects results into your context, so you must be disciplined:
- Limit yourself to 2-3 targeted searches per candidate (not exhaustive trawling).
- Prioritise verifying the primary source and finding one strong additional angle.
- If a candidate looks low-value after the first search, skip deeper research and recommend 'skip' early.
- Aim for focused efficiency: the best research is a few well-chosen queries, not dozens of broad ones.
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

... rest of prompt truncated for space`.
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

  ...remaining code truncated for space 