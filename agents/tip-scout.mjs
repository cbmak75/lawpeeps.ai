/**
 * tip-scout.mjs -- Tip Investigation Agent
 *
 * Triggered by a reader tip via the tip line. Investigates the
 * tip, researches it, and if it holds up, deposits it into the
 * story queue with high priority so mm!ke picks it up on the
 * next editorial cycle.
 *
 * If the tip is strong enough (score >= 7), it also runs the
 * full editorial cycle immediately: write, verify, stage PR.
 * This means a good tip can go from submission to PR in minutes.
 *
 * Run: node agents/tip-scout.mjs
 * Expects: GEMINI_API_KEY, GITHUB_TOKEN, TIP_PAYLOAD (JSON)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

import { enqueue, claimNext, markPublished, markKilled } from './queue.mjs';
import { verifyArticle } from './verifier.mjs';
import { generate, MODELS } from './llm.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MEMORY_DIR = join(__dirname, 'memory');
const ARTICLES_DIR = join(__dirname, '..', 'src', 'content', 'articles');
const SYSTEM_PROMPT_PATH = join(__dirname, 'mmike-system-prompt.md');
const EDITORIAL_LOG_PATH = join(MEMORY_DIR, 'editorial-log.json');
const POSITIONS_PATH = join(MEMORY_DIR, 'positions.json');
const KNOWLEDGE_PATH = join(MEMORY_DIR, 'knowledge.json');
const WEIGHTING_PATH = join(MEMORY_DIR, 'weighting-tracker.json');

if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });

// ── Parse tip from environment ──

function parseTip() {
  const raw = process.env.TIP_PAYLOAD;
  if (!raw) {
    console.error('[tip-scout] TIP_PAYLOAD not set');
    process.exit(1);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error('[tip-scout] Failed to parse TIP_PAYLOAD:', err.message);
    process.exit(1);
  }
}

// ── Load context for investigation ──

function loadContext() {
  const ctx = {};

  if (existsSync(EDITORIAL_LOG_PATH)) {
    const log = JSON.parse(readFileSync(EDITORIAL_LOG_PATH, 'utf-8'));
    ctx.recentCoverage = (log.entries || []).slice(-20)
      .map(e => `- ${e.title} (${e.publishDate || 'undated'})`)
      .join('\n');
  }

  return ctx;
}

// ── Build investigation prompt ──

function buildInvestigationPrompt(tip, ctx) {
  const today = new Date().toISOString().split('T')[0];

  return `You are a news scout for lawpeeps.ai, a legal AI publication. A reader has submitted a tip via our tip line. Your job is to investigate it thoroughly and determine whether it is a viable story.

## The tip

Subject: ${tip.subject || 'No subject'}
Message: ${tip.message || 'No message'}
URL provided: ${tip.url || 'None'}
Submitted by: ${tip.name || 'Anonymous'}
Credit preference: ${tip.credit_preference || 'anonymous'}
Submitted at: ${tip.submitted_at || 'Unknown'}

## Today's date

${today}

## Recent coverage (avoid duplicating)

${ctx.recentCoverage || 'No recent coverage recorded.'}

## Your task

1. Read the tip carefully and understand what the reader is flagging.
2. Search the web to investigate the claim or development mentioned in the tip.
3. Verify whether the core claim is true, partially true, or unsubstantiated.
4. If true, research it properly: find the primary source, build context, identify additional angles.
5. If the tip is about something we have already covered, note that and assess whether there is a new angle.

Run 3-5 targeted searches. Be thorough -- a reader took the time to write in.

## Scoring

Score the tip from 1-10:
- 8-10: Strong, verified story ready to write
- 5-7: Viable story but needs more work or has caveats
- 3-4: Marginal -- might be worth monitoring but not writing now
- 1-2: Not viable (already covered, unsubstantiated, not relevant)

## Output

Return a JSON object:

{
  "investigation_date": "${today}",
  "tip_id": "${tip.tip_id || 'unknown'}",
  "viable": true/false,
  "score": 1-10,
  "title": "Headline-style title if viable",
  "slug": "url-friendly-slug-max-80-chars",
  "category": "Legal AI | Regulatory | Funding | Adoption | Research | Policy | Immigration AI",
  "story_type": "news | analysis | profile | commentary",
  "research_brief": "3-5 paragraph summary if viable, or explanation of why not",
  "primary_source": "URL or null",
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
  "existing_coverage": "Whether other outlets or we have covered this",
  "estimated_staging": "green | amber | red",
  "verification_notes": "Anything the verification agent should pay special attention to",
  "tip_origin": true,
  "tip_credit": "${tip.credit_preference === 'anonymous' ? 'anonymous' : tip.name || 'anonymous'}",
  "rejection_reason": "If not viable, explain why",
  "search_queries_used": ["list of searches run"]
}

Return ONLY the JSON object.`;
}

// ── Write and stage (borrowed from editor.mjs) ──

function loadSystemPrompt() {
  return readFileSync(SYSTEM_PROMPT_PATH, 'utf-8');
}

function buildWritingPrompt(story) {
  const today = new Date().toISOString().split('T')[0];

  return `Your scout has investigated a reader tip and filed this research brief. Write the article.

## IMPORTANT: Publication date

Today's date is ${today}. The publishDate in your frontmatter MUST be ${today}.

## Research brief

Title: ${story.title}
Category: ${story.category || 'unclassified'}
Story type: ${story.story_type || 'news'}
Suggested angle: ${story.suggested_angle || 'General coverage'}
Estimated staging: ${story.estimated_staging || 'amber'}

### The brief

${story.research_brief}

### Sources

Primary source: ${story.primary_source || 'Not identified'}
Primary verified: ${story.primary_source_verified ? 'Yes' : 'No'}
Additional sources:
${(story.additional_sources || []).map(s => `- ${s.url}: ${s.description}`).join('\n') || 'None'}

### Key facts
${(story.key_facts || []).map(f => `- "${f.claim}" [${f.verified ? 'verified' : 'unverified'}] (${f.source})`).join('\n') || 'None extracted'}

### Tip line origin
${story.tip_origin ? `This story originated from a reader tip. Tipster credit preference: ${story.tip_credit || 'anonymous'}. If credit was requested, include a line like "This story was prompted by a reader tip from [name]" in your editor's note. If anonymous, do not mention the tip line.` : 'This story did not originate from the tip line.'}

## Your task

Write a complete article draft. Follow your editorial voice and standards exactly.

Output:
1. Complete frontmatter (title, description, publishDate: ${today}, author: mm!ke, tags, category, staging, sources array, editorNote)
2. The article body
3. A brief italicised editor's note at the end, signed mm!ke

Format:

---ARTICLE_START---
[complete markdown with frontmatter]
---ARTICLE_END---`;
}

function parseArticle(responseText) {
  const articleMatch = responseText.match(/---ARTICLE_START---\s*([\s\S]*?)\s*---ARTICLE_END---/);
  if (!articleMatch) return null;

  const content = articleMatch[1].trim();
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  const meta = {};
  if (fmMatch) {
    for (const line of fmMatch[1].split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim();
        const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '');
        meta[key] = value;
      }
    }
  }

  const body = fmMatch ? content.slice(fmMatch[0].length).trim() : content;
  const slug = (meta.title || 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);

  return { content, body, meta, slug };
}

function createStagingPR(article, verificationReport) {
  const staging = verificationReport?.recommended_staging || article.meta.staging || 'amber';
  const slug = article.slug;
  const branch = `mmike/${slug}`;
  const filePath = `src/content/articles/${slug}.md`;

  try {
    execSync(`git checkout -b ${branch}`, { cwd: join(__dirname, '..'), stdio: 'pipe' });

    const articlePath = join(ARTICLES_DIR, `${slug}.md`);
    if (!existsSync(dirname(articlePath))) {
      mkdirSync(dirname(articlePath), { recursive: true });
    }
    writeFileSync(articlePath, article.content);

    execSync(`git add "${filePath}"`, { cwd: join(__dirname, '..'), stdio: 'pipe' });

    const commitMsg = `[${staging.toUpperCase()}] ${article.meta.title || slug}

Tip investigation: reader tip -> scout -> write -> verify -> PR
Staging: ${staging}
Verification: ${verificationReport ? 'completed' : 'pending'}`;

    execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, { cwd: join(__dirname, '..'), stdio: 'pipe' });
    execSync(`git push origin ${branch}`, { cwd: join(__dirname, '..'), stdio: 'pipe' });

    const prTitle = `[${staging.toUpperCase()}] ${article.meta.title || slug}`;

    let prBody = `## Tip investigation\n\n`;
    prBody += `**Origin**: Reader tip line\n`;
    prBody += `**Staging**: ${staging.toUpperCase()}\n`;
    prBody += `**Category**: ${article.meta.category || 'unclassified'}\n\n`;

    if (verificationReport && verificationReport.claims) {
      prBody += `### Verification report\n\n`;
      const a = verificationReport.overall_assessment || {};
      prBody += `- Claims extracted: ${verificationReport.claims_extracted || 0}\n`;
      prBody += `- Verified: ${a.verified || 0}\n`;
      prBody += `- Unverified: ${a.unverified || 0}\n`;
      prBody += `- Contradicted: ${a.contradicted || 0}\n`;
      prBody += `- Staging rationale: ${verificationReport.staging_rationale || 'See report'}\n\n`;
    }

    prBody += `### mm!ke's note\n\n${article.meta.editorNote || 'No notes.'}\n`;

    execSync(
      `gh pr create --title "${prTitle.replace(/"/g, '\\"')}" --body "${prBody.replace(/"/g, '\\"')}"`,
      { cwd: join(__dirname, '..'), stdio: 'pipe' }
    );

    execSync('git checkout main', { cwd: join(__dirname, '..'), stdio: 'pipe' });
    console.log(`[tip-scout] PR created: ${prTitle}`);
    return { success: true, branch, staging };

  } catch (err) {
    console.error(`[tip-scout] Failed to create PR:`, err.message);
    try { execSync('git checkout main', { cwd: join(__dirname, '..'), stdio: 'pipe' }); } catch {}
    return { success: false, error: err.message };
  }
}

// ── Main ──

async function run() {
  const tip = parseTip();

  console.log(`\n${'='.repeat(60)}`);
  console.log(`[tip-scout] TIP INVESTIGATION: ${tip.subject || 'untitled'}`);
  console.log(`[tip-scout] From: ${tip.name || 'Anonymous'}`);
  console.log(`${'='.repeat(60)}\n`);

  // Phase 1: Investigate the tip
  console.log('[tip-scout] Investigating...');
  const ctx = loadContext();
  const prompt = buildInvestigationPrompt(tip, ctx);

  const { text: resultText } = await generate({
    model: MODELS.verifier,
    user: prompt,
    maxTokens: 4000,
    useSearch: true,
    label: 'tip-scout'
  });

  let investigation;
  try {
    const jsonMatch = resultText.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, resultText];
    investigation = JSON.parse(jsonMatch[1].trim());
  } catch (err) {
    console.error('[tip-scout] Failed to parse investigation:', err.message);
    console.log('[tip-scout] Tip investigation inconclusive. Ending.');
    return;
  }

  console.log(`[tip-scout] Score: ${investigation.score}/10`);
  console.log(`[tip-scout] Viable: ${investigation.viable}`);

  if (!investigation.viable || investigation.score < 5) {
    console.log(`[tip-scout] Tip not viable: ${investigation.rejection_reason || 'Score too low'}`);
    console.log('[tip-scout] Not proceeding to article.');
    return;
  }

  // Phase 2: If score >= 7, go straight to article + PR
  // If 5-6, deposit in queue for mm!ke's next scheduled cycle
  if (investigation.score < 7) {
    console.log(`[tip-scout] Score ${investigation.score} -- depositing in queue for mm!ke to curate.`);
    enqueue(investigation);
    return;
  }

  console.log(`[tip-scout] Score ${investigation.score} -- strong tip. Writing article immediately.`);

  // Phase 3: Write the article
  const systemPrompt = loadSystemPrompt();
  const writingPrompt = buildWritingPrompt(investigation);

  const { text: writeText } = await generate({
    model: MODELS.editor,
    system: systemPrompt,
    user: writingPrompt,
    maxTokens: 8000,
    label: 'tip-scout-write'
  });

  const article = parseArticle(writeText);
  if (!article) {
    console.log('[tip-scout] Failed to parse article. Depositing brief in queue instead.');
    enqueue(investigation);
    return;
  }

  console.log(`[tip-scout] Drafted: "${article.meta.title || article.slug}"`);

  // Phase 4: Verify
  console.log('[tip-scout] Verifying...');
  const verificationReport = await verifyArticle(article.body, article.meta);
  article.verificationReport = verificationReport;

  const stagingOrder = { green: 0, amber: 1, red: 2 };
  const verifiedStaging = verificationReport.recommended_staging || 'amber';
  const draftStaging = article.meta.staging || 'amber';

  if ((stagingOrder[verifiedStaging] || 0) > (stagingOrder[draftStaging] || 0)) {
    article.meta.staging = verifiedStaging;
  }

  if (verificationReport.disclosure_text) {
    const disclosureLine = `\n\n*Verification note: ${verificationReport.disclosure_text}*\n`;
    article.content += disclosureLine;
  }

  // Phase 5: Stage PR
  console.log('[tip-scout] Creating PR...');
  const prResult = createStagingPR(article, verificationReport);

  if (prResult.success) {
    // Also deposit in queue as published so mm!ke doesn't duplicate
    investigation.status = 'published';
    enqueue({ ...investigation, status: 'published' });
  }

  const elapsed = Math.round((Date.now() - Date.now()) / 1000);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[tip-scout] INVESTIGATION COMPLETE`);
  console.log(`[tip-scout] Verdict: ${investigation.viable ? 'VIABLE' : 'NOT VIABLE'} (${investigation.score}/10)`);
  console.log(`[tip-scout] Article: ${article.meta.title || 'none'}`);
  console.log(`[tip-scout] PR: ${prResult.success ? 'CREATED' : 'FAILED'}`);
  console.log(`${'='.repeat(60)}\n`);
}

run().catch(err => {
  console.error('[tip-scout] Fatal error:', err);
  process.exit(1);
});
