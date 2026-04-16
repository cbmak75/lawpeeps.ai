/**
 * verifier.mjs -- Verification Agent (v2)
 *
 * Independent fact-checker. Takes a drafted article, extracts
 * every factual claim, verifies them via web search, and returns
 * a structured report. No personality, no editorial voice -- just
 * methodical verification.
 *
 * Called by mm!ke after drafting. Runs as a single API call with
 * web search to stay within rate limits.
 *
 * Run standalone: node agents/verifier.mjs [article-path]
 * Expects: ANTHROPIC_API_KEY
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { withRetry } from './rate-limit-helper.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const client = new Anthropic();

// ── Single combined prompt: extract claims AND verify in one pass ──
// This avoids making two separate API calls (extraction + verification)
// which was a major contributor to rate-limit issues in v1.

function buildVerificationPrompt(articleContent, articleMeta) {
  return `You are a fact-checker. Read this draft article and verify its factual claims.

## Article metadata
Title: ${articleMeta.title || 'Untitled'}
Category: ${articleMeta.category || 'unknown'}

## Article content

${articleContent}

## Your task

1. Read the article and identify every checkable factual claim (not opinions or analysis).
2. Classify each claim as: core (story falls apart without it), supporting (adds context), or peripheral (nice to have).
3. For CORE claims: search the web to verify them. Find the primary source if possible.
4. For SUPPORTING claims: verify if you can do so efficiently. One search per claim maximum.
5. For PERIPHERAL claims: note them but do not search unless trivially verifiable.

Be surgical with searches. Prioritise core claims. 5-8 targeted searches total, not more.

## Verification standards

- VERIFIED: Found primary source or two independent credible secondary sources
- PARTIALLY_VERIFIED: Found secondary coverage but not primary source
- UNVERIFIED: Could not find corroboration (does not mean false)
- CONTRADICTED: Found credible evidence contradicting the claim
- OUTDATED: Claim was once true but circumstances changed

## Output format

Return a JSON object:

{
  "verification_run": "${new Date().toISOString()}",
  "article_title": "${(articleMeta.title || '').replace(/"/g, '\\"')}",
  "claims": [
    {
      "id": 1,
      "claim": "The exact factual assertion",
      "type": "financial | regulatory | product | personnel | legal | statistical | timeline",
      "criticality": "core | supporting | peripheral",
      "status": "verified | partially_verified | unverified | contradicted | outdated",
      "evidence": "What you found, with URLs",
      "primary_source_url": "URL or null",
      "confidence": "high | medium | low"
    }
  ],
  "overall_assessment": {
    "total_claims": 0,
    "verified": 0,
    "partially_verified": 0,
    "unverified": 0,
    "contradicted": 0,
    "outdated": 0,
    "core_claims_status": "X of Y core claims verified",
    "recommended_staging": "green | amber | red",
    "staging_rationale": "Explanation",
    "disclosures_needed": ["Any disclosures that should appear in the article"],
    "claims_to_remove": ["Any claims that should be removed"],
    "claims_to_flag": ["Claims that should remain but with verification status noted"]
  },
  "search_queries_used": ["All queries run"]
}

Return ONLY the JSON.`;
}

// ── Run verification ──

async function verifyArticle(articleContent, articleMeta) {
  console.log(`[verifier] Verifying: ${articleMeta.title || 'untitled'}`);

  const prompt = buildVerificationPrompt(articleContent, articleMeta);

  const response = await withRetry(() => client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8000,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages: [{ role: 'user', content: prompt }]
  }), 'verifier');

  let resultText = '';
  for (const block of response.content) {
    if (block.type === 'text') resultText += block.text;
  }

  let report;
  try {
    const jsonMatch = resultText.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, resultText];
    report = JSON.parse(jsonMatch[1].trim());
  } catch (err) {
    console.error('[verifier] Failed to parse verification response:', err.message);
    return {
      error: 'verification_parse_failed',
      recommended_staging: 'amber',
      staging_rationale: 'Verification parsing failed -- defaulting to amber',
      overall_assessment: { recommended_staging: 'amber' },
      claims: []
    };
  }

  const assessment = report.overall_assessment || {};
  console.log(`[verifier] Complete: ${assessment.recommended_staging?.toUpperCase() || 'AMBER'} staging`);
  console.log(`[verifier] ${assessment.verified || 0} verified, ${assessment.unverified || 0} unverified, ${assessment.contradicted || 0} contradicted`);

  // Normalise the report structure for mm!ke
  report.recommended_staging = assessment.recommended_staging || 'amber';
  report.staging_rationale = assessment.staging_rationale || 'See report';
  report.claims_extracted = report.claims?.length || 0;

  // Build disclosure text
  const disclosures = [
    ...(assessment.disclosures_needed || []),
    ...(assessment.claims_to_flag || [])
  ];
  report.disclosure_text = disclosures.length > 0 ? disclosures.join(' ') : null;

  return report;
}

export { verifyArticle };

// Standalone mode
if (process.argv[1] && process.argv[1].endsWith('verifier.mjs') && process.argv[2]) {
  const filePath = process.argv[2];
  if (!existsSync(filePath)) {
    console.error(`[verifier] File not found: ${filePath}`);
    process.exit(1);
  }

  const content = readFileSync(filePath, 'utf-8');
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  const meta = {};
  if (fmMatch) {
    for (const line of fmMatch[1].split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim();
        meta[key] = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '');
      }
    }
  }

  const articleContent = fmMatch ? content.slice(fmMatch[0].length).trim() : content;

  verifyArticle(articleContent, meta)
    .then(report => {
      const outputPath = filePath.replace(/\.md$/, '.verification.json');
      writeFileSync(outputPath, JSON.stringify(report, null, 2));
      console.log(`[verifier] Report written to: ${outputPath}`);
    })
    .catch(err => {
      console.error('[verifier] Fatal error:', err);
      process.exit(1);
    });
}
