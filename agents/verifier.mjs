/**
 * verifier.mjs -- Verification Agent (v4, Gemini)
 *
 * Independent fact-checker. Takes a drafted article, extracts
 * every factual claim, verifies them, and returns a structured
 * report. No personality, no editorial voice -- just methodical
 * verification.
 *
 * v4 changes (token minimisation):
 *   - The primary source URL is fetched deterministically in Node
 *     (free) and its text is passed to the model, so most core claims
 *     verify against the source document without any search.
 *   - Search grounding (Google Search via the Gemini API) is attached
 *     only for amber/red stories, and the search budget is cut to a
 *     maximum of 3 targeted searches.
 *   - Anthropic SDK and web_search tool removed. Anthropic web search
 *     was billed per search plus all result tokens as Sonnet input --
 *     the most expensive single call in the v3 pipeline.
 *
 * Run standalone: node agents/verifier.mjs [article-path]
 * Expects: GEMINI_API_KEY
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { generate, MODELS } from './llm.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Single combined prompt: extract claims AND verify in one pass ──

const VERIFIER_SYSTEM = `You are a fact-checker for lawpeeps.ai, a legal AI publication. Read the draft article in the user message and verify its factual claims.

## Your task

1. Identify every checkable factual claim (not opinions or analysis).
2. Classify each claim as core (story falls apart without it), supporting (adds context), or peripheral (nice to have).
3. Verify claims against the primary source text if it is included in the user message. Most core claims should be checkable there without searching.
4. If search is available to you, use it only for core claims the primary source cannot settle. Maximum 3 targeted searches total.
5. For PERIPHERAL claims: note them but do not search.

## Verification standards

- VERIFIED: Found primary source or two independent credible secondary sources
- PARTIALLY_VERIFIED: Found secondary coverage but not primary source
- UNVERIFIED: Could not find corroboration (does not mean false)
- CONTRADICTED: Found credible evidence contradicting the claim
- OUTDATED: Claim was once true but circumstances changed

## Output format

Return a JSON object only. No preamble.

{
  "verification_run": "ISO timestamp",
  "article_title": "the title",
  "claims": [
    {
      "id": 1,
      "claim": "exact assertion",
      "type": "financial | regulatory | product | personnel | legal | statistical | timeline",
      "criticality": "core | supporting | peripheral",
      "status": "verified | partially_verified | unverified | contradicted | outdated",
      "evidence": "what you found with URLs",
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
    "staging_rationale": "explanation",
    "disclosures_needed": [],
    "claims_to_remove": [],
    "claims_to_flag": []
  },
  "search_queries_used": []
}`;

// ── Primary source fetch (free, deterministic) ──
// Pulling the source document into the prompt lets the model verify
// most core claims without a single search.

const SOURCE_TEXT_CAP = 8000; // chars, roughly 2k tokens

async function fetchSourceText(url, timeout = 15000) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'lawpeeps.ai/verifier (editorial bot)' }
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z#0-9]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return text ? text.slice(0, SOURCE_TEXT_CAP) : null;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

function buildVerificationUserMessage(articleContent, articleMeta, sourceText, sourceUrl) {
  const sourceSection = sourceText
    ? `## Primary source text (fetched from ${sourceUrl})

${sourceText}

`
    : '';

  return `## Article metadata
Title: ${articleMeta.title || 'Untitled'}
Category: ${articleMeta.category || 'unknown'}
Verification run: ${new Date().toISOString()}

${sourceSection}## Article content

${articleContent}

Verify now. Return only the JSON.`;
}

// ── Run verification ──

async function verifyArticle(articleContent, articleMeta, options = {}) {
  const { skipWebSearch = false, primarySourceUrl = null } = options;
  console.log(`[verifier] Verifying: ${articleMeta.title || 'untitled'}${skipWebSearch ? ' (no search grounding)' : ''}`);

  const sourceText = await fetchSourceText(primarySourceUrl);
  if (primarySourceUrl) {
    console.log(`[verifier] Primary source ${sourceText ? `fetched (${sourceText.length} chars)` : 'could not be fetched'}: ${primarySourceUrl}`);
  }

  const userMessage = buildVerificationUserMessage(articleContent, articleMeta, sourceText, primarySourceUrl);

  const { text: resultText, usage } = await generate({
    model: MODELS.verifier,
    system: VERIFIER_SYSTEM,
    user: userMessage,
    maxTokens: 4000,
    useSearch: !skipWebSearch,
    label: 'verifier'
  });
  if (usage) {
    console.log(`[verifier] Tokens: ${usage.input_tokens || '?'} in, ${usage.output_tokens || '?'} out`);
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
