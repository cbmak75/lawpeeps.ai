/**
 * verify.mjs -- Verification Agent
 *
 * Structured claim extraction and validation pipeline. Takes
 * drafted articles and systematically verifies every factual
 * claim, producing a verification report that drives staging
 * classification.
 *
 * This is NOT the same as the research phase. Research builds
 * context for writing. Verification audits the finished draft.
 *
 * Run: node agents/verify.mjs [article-path]
 * Expects: ANTHROPIC_API_KEY
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { withRetry } from './rate-limit-helper.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MEMORY_DIR = join(__dirname, 'memory');

const client = new Anthropic();

// ── Claim extraction prompt ──

function buildExtractionPrompt(articleContent, articleMeta) {
  return `You are a fact-checking editor. Read this draft article and extract every factual claim that can be independently verified. Do NOT extract opinions, analysis, or editorial commentary -- only checkable assertions of fact.

## Article metadata
Title: ${articleMeta.title}
Category: ${articleMeta.category || 'unknown'}
Suggested staging: ${articleMeta.staging || 'unclassified'}

## Article content

${articleContent}

## Your task

Extract each discrete factual claim. For each, identify:
- The exact claim as stated
- What type of claim it is (financial, regulatory, product, personnel, legal, statistical, date/timeline)
- How critical it is to the article (core -- the story falls apart without it; supporting -- adds context; peripheral -- nice to have)
- What source would definitively verify or refute it

Return a JSON array:
{
  "claims": [
    {
      "id": 1,
      "claim": "The exact factual assertion",
      "type": "financial | regulatory | product | personnel | legal | statistical | timeline | other",
      "criticality": "core | supporting | peripheral",
      "verification_source": "Where to check this (e.g., Companies House filing, company website, court records, SRA register)",
      "verification_query": "A specific web search query that would help verify this"
    }
  ],
  "article_risk_factors": [
    "Any risk factors identified in the article (names individuals critically, single source, financial claims, etc.)"
  ]
}

Return ONLY the JSON, no other text.`;
}

// ── Verification prompt (run after extraction, with web search) ──

function buildVerificationPrompt(claims) {
  const claimList = claims
    .map(c => `### Claim ${c.id} [${c.criticality.toUpperCase()}]
- Assertion: "${c.claim}"
- Type: ${c.type}
- Suggested check: ${c.verification_source}
- Search query: ${c.verification_query}`)
    .join('\n\n');

  return `You are a verification agent. You have ${claims.length} factual claims extracted from a draft article. Your job is to attempt to verify each one using web search.

## IMPORTANT: Token budget constraint
You are operating under a strict API rate limit of 10,000 input tokens per minute. Be surgical with your searches:
- Prioritise CORE claims first. If you run out of budget, peripheral claims can remain unverified.
- Use 1-2 targeted searches per claim rather than multiple broad queries.
- If a claim is trivially verifiable from a single search, move on quickly.

## Claims to verify

${claimList}

## Instructions

For each claim:
1. Search for corroborating evidence using the suggested query and any other queries you think would help
2. Look for the PRIMARY source (the original announcement, filing, ruling, etc.) not just secondary coverage
3. Check for CONTRADICTORY information -- if another credible source says something different, flag it
4. If you cannot find corroboration, say so plainly. Do not fabricate verification.

## Verification standards

- VERIFIED: Found primary source or two independent credible secondary sources confirming the claim
- PARTIALLY VERIFIED: Found secondary coverage but not the primary source, or found partial confirmation
- UNVERIFIED: Could not find corroboration. This does not mean the claim is false -- it means it could not be checked
- CONTRADICTED: Found credible evidence that contradicts the claim
- OUTDATED: The claim was once true but circumstances have changed

## Output format

{
  "verifications": [
    {
      "claim_id": 1,
      "status": "verified | partially_verified | unverified | contradicted | outdated",
      "evidence": "What you found, with specific URLs",
      "primary_source_found": true/false,
      "primary_source_url": "URL or null",
      "corroborating_sources": [
        { "url": "...", "what_it_confirms": "..." }
      ],
      "contradictions": [
        { "url": "...", "what_it_contradicts": "..." }
      ],
      "confidence": "high | medium | low",
      "note": "Any caveats or context about this verification"
    }
  ],
  "overall_assessment": {
    "total_claims": ${claims.length},
    "verified": 0,
    "partially_verified": 0,
    "unverified": 0,
    "contradicted": 0,
    "outdated": 0,
    "core_claims_verified": "X of Y core claims verified",
    "recommended_staging": "green | amber | red",
    "staging_rationale": "Explanation of why this staging level",
    "disclosure_needed": [
      "List of specific disclosures that should appear in the article"
    ],
    "claims_to_remove": [
      "Any claims that should be removed from the article (contradicted or dangerously unverifiable)"
    ],
    "claims_to_flag": [
      "Claims that should remain but with explicit disclosure of verification status"
    ]
  },
  "search_queries_used": ["All queries run during verification"]
}

Return ONLY the JSON, no other text.`;
}

// ── Run verification on a single article ──

async function verifyArticle(articleContent, articleMeta) {
  console.log(`[verify] Starting verification for: ${articleMeta.title}`);

  // Phase 1: Extract claims
  console.log('[verify] Phase 1: Extracting factual claims...');
  const extractionResponse = await withRetry(() => client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    messages: [{ role: 'user', content: buildExtractionPrompt(articleContent, articleMeta) }]
  }), 'verify-extract');

  let extractionText = '';
  for (const block of extractionResponse.content) {
    if (block.type === 'text') extractionText += block.text;
  }

  let extraction;
  try {
    const jsonMatch = extractionText.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, extractionText];
    extraction = JSON.parse(jsonMatch[1].trim());
  } catch (err) {
    console.error('[verify] Failed to parse claim extraction:', err.message);
    return {
      error: 'claim_extraction_failed',
      recommended_staging: 'red',
      staging_rationale: 'Verification could not be completed: claim extraction failed'
    };
  }

  const claims = extraction.claims || [];
  console.log(`[verify] Extracted ${claims.length} factual claims (${claims.filter(c => c.criticality === 'core').length} core)`);

  if (claims.length === 0) {
    return {
      generated: new Date().toISOString(),
      article_title: articleMeta.title,
      claims_extracted: 0,
      note: 'No verifiable factual claims found in article. This may be pure commentary/opinion.',
      recommended_staging: 'green',
      staging_rationale: 'No factual claims to verify -- pure editorial/opinion piece',
      verifications: [],
      overall_assessment: { recommended_staging: 'green' }
    };
  }

  // Phase 2: Verify claims with web search
  console.log('[verify] Phase 2: Verifying claims via web search...');
  const verificationResponse = await withRetry(() => client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 10000,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages: [{ role: 'user', content: buildVerificationPrompt(claims) }]
  }), 'verify-check');

  let verificationText = '';
  for (const block of verificationResponse.content) {
    if (block.type === 'text') verificationText += block.text;
  }

  let verification;
  try {
    const jsonMatch = verificationText.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, verificationText];
    verification = JSON.parse(jsonMatch[1].trim());
  } catch (err) {
    console.error('[verify] Failed to parse verification response:', err.message);
    return {
      error: 'verification_failed',
      claims_extracted: claims.length,
      extraction,
      recommended_staging: 'red',
      staging_rationale: 'Verification could not be completed: verification parsing failed'
    };
  }

  // Build the full verification report
  const report = {
    generated: new Date().toISOString(),
    article_title: articleMeta.title,
    article_category: articleMeta.category,
    claims_extracted: claims.length,
    extraction,
    verification: verification.verifications || [],
    overall_assessment: verification.overall_assessment || {},
    risk_factors: extraction.article_risk_factors || [],
    recommended_staging: verification.overall_assessment?.recommended_staging || 'amber',
    staging_rationale: verification.overall_assessment?.staging_rationale || 'Assessment incomplete',
    disclosure_text: buildDisclosureText(verification),
    search_queries_used: verification.search_queries_used || []
  };

  console.log(`[verify] Verification complete: ${report.recommended_staging.toUpperCase()} staging recommended`);

  const stats = verification.overall_assessment || {};
  console.log(`[verify] Results: ${stats.verified || 0} verified, ${stats.partially_verified || 0} partial, ${stats.unverified || 0} unverified, ${stats.contradicted || 0} contradicted`);

  return report;
}

// ── Build disclosure text from verification results ──

function buildDisclosureText(verification) {
  const disclosures = verification.overall_assessment?.disclosure_needed || [];
  const flagged = verification.overall_assessment?.claims_to_flag || [];

  if (disclosures.length === 0 && flagged.length === 0) {
    return null;
  }

  let text = '';
  if (disclosures.length > 0) {
    text += disclosures.join(' ');
  }
  if (flagged.length > 0) {
    if (text) text += ' ';
    text += flagged.join(' ');
  }

  return text;
}

// ── Batch verification (called by editor after drafting) ──

async function verifyBatch(articles) {
  const reports = [];
  for (const article of articles) {
    const report = await verifyArticle(article.content, article.meta);
    reports.push(report);
  }
  return reports;
}

export { verifyArticle, verifyBatch };

// Standalone mode: verify a single markdown file
if (process.argv[1] && process.argv[1].endsWith('verify.mjs') && process.argv[2]) {
  const filePath = process.argv[2];
  if (!existsSync(filePath)) {
    console.error(`[verify] File not found: ${filePath}`);
    process.exit(1);
  }

  const content = readFileSync(filePath, 'utf-8');

  // Extract frontmatter
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  const meta = {};
  if (fmMatch) {
    for (const line of fmMatch[1].split('\n')) {
      const [key, ...rest] = line.split(':');
      if (key && rest.length > 0) {
        meta[key.trim()] = rest.join(':').trim().replace(/^["']|["']$/g, '');
      }
    }
  }

  const articleContent = fmMatch ? content.slice(fmMatch[0].length).trim() : content;

  verifyArticle(articleContent, meta)
    .then(report => {
      const outputPath = filePath.replace(/\.md$/, '.verification.json');
      writeFileSync(outputPath, JSON.stringify(report, null, 2));
      console.log(`[verify] Report written to: ${outputPath}`);
    })
    .catch(err => {
      console.error('[verify] Fatal error:', err);
      process.exit(1);
    });
}
