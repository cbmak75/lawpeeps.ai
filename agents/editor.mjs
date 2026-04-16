/**
 * editor.mjs -- mm!ke Editorial Orchestrator (v2)
 *
 * mm!ke is the editor-in-chief. He does not go out on the beat --
 * the scout does that. He does not verify claims -- the verifier
 * does that. mm!ke curates, writes, polishes, and publishes.
 *
 * Flow:
 *   1. Pick the best story from the queue
 *   2. Write the article in mm!ke's voice
 *   3. Send to the verifier for fact-checking
 *   4. Apply verification results (disclosures, staging)
 *   5. Stage: branch, commit, PR
 *   6. Reflect: update memory, positions, knowledge
 *
 * Run: node agents/editor.mjs
 * Expects: ANTHROPIC_API_KEY, GITHUB_TOKEN
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

import { claimNext, markPublished, markKilled, stats } from './queue.mjs';
import { verifyArticle } from './verifier.mjs';
import { withRetry } from './rate-limit-helper.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MEMORY_DIR = join(__dirname, 'memory');
const ARTICLES_DIR = join(__dirname, '..', 'src', 'content', 'articles');
const SYSTEM_PROMPT_PATH = join(__dirname, 'mmike-system-prompt.md');

// Memory files
const EDITORIAL_LOG_PATH = join(MEMORY_DIR, 'editorial-log.json');
const POSITIONS_PATH = join(MEMORY_DIR, 'positions.json');
const KNOWLEDGE_PATH = join(MEMORY_DIR, 'knowledge.json');
const WEIGHTING_PATH = join(MEMORY_DIR, 'weighting-tracker.json');

if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });

const client = new Anthropic();

// ── Load system prompt ──

function loadSystemPrompt() {
  if (!existsSync(SYSTEM_PROMPT_PATH)) {
    console.error('[editor] System prompt not found at:', SYSTEM_PROMPT_PATH);
    process.exit(1);
  }
  return readFileSync(SYSTEM_PROMPT_PATH, 'utf-8');
}

// ── Load memory context ──

function loadMemoryContext() {
  const context = {};

  if (existsSync(EDITORIAL_LOG_PATH)) {
    const log = JSON.parse(readFileSync(EDITORIAL_LOG_PATH, 'utf-8'));
    context.recentCoverage = (log.entries || []).slice(-30);
  }

  if (existsSync(POSITIONS_PATH)) {
    context.positions = JSON.parse(readFileSync(POSITIONS_PATH, 'utf-8'));
  }

  if (existsSync(KNOWLEDGE_PATH)) {
    context.knowledge = JSON.parse(readFileSync(KNOWLEDGE_PATH, 'utf-8'));
  }

  if (existsSync(WEIGHTING_PATH)) {
    context.weighting = JSON.parse(readFileSync(WEIGHTING_PATH, 'utf-8'));
  }

  return context;
}

// ── Build writing prompt from a queued story brief ──

function buildWritingPrompt(story, memory) {
  let weightingContext = 'No weighting data yet.';
  if (memory.weighting) {
    const w = memory.weighting;
    weightingContext = `Current 50% rule balance: ${w.underrepresented_percentage || 0}% underrepresented coverage in the last 4 weeks (target: 50% minimum). ${w.underrepresented_percentage < 50 ? 'BELOW TARGET -- prioritise underrepresented stories.' : 'On target.'}`;
  }

  let positionsContext = '';
  if (memory.positions) {
    const p = memory.positions;
    if (p.tracked_themes?.length > 0) {
      positionsContext += '\nThemes I am tracking:\n' +
        p.tracked_themes.map(t => `- ${t.theme}: ${t.status}`).join('\n');
    }
    if (p.evolving_views?.length > 0) {
      positionsContext += '\nMy evolving views:\n' +
        p.evolving_views.map(v => `- ${v.topic}: ${v.current_view}`).join('\n');
    }
  }

  const recentTitles = (memory.recentCoverage || [])
    .slice(-10)
    .map(e => `- ${e.title}`)
    .join('\n');

  const today = new Date().toISOString().split('T')[0];

  return `Your scout has filed this research brief. Write the article.

## IMPORTANT: Publication date

Today's date is ${today}. The publishDate in your frontmatter MUST be ${today}. This is the date lawpeeps.ai publishes the article -- not the date of the underlying event. Always use today's date.

## Research brief

Title: ${story.title}
Category: ${story.category || 'unclassified'}
Story type: ${story.story_type || 'news'}
Suggested angle: ${story.suggested_angle || 'General coverage'}
Serves 50% rule: ${story.serves_50_percent_rule ? 'Yes' : 'No'}${story.fifty_percent_note ? ` -- ${story.fifty_percent_note}` : ''}
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

### Existing coverage
${story.existing_coverage || 'Unknown'}

### Verification notes from the scout
${story.verification_notes || 'No special notes'}

## 50% weighting status
${weightingContext}

## My editorial positions
${positionsContext || 'No positions recorded yet.'}

## Recent coverage (for context, not duplication)
${recentTitles || 'No recent coverage.'}

## Your task

Write a complete article draft. Follow your editorial voice and standards exactly.

Output:
1. Complete frontmatter (title, description, publishDate: ${today}, author: mm!ke, tags, category, staging, sources array, editorNote)
2. The article body
3. A brief italicised editor's note at the end, signed mm!ke

Then reflect on this story and your coverage:

Format:

---ARTICLE_START---
[complete markdown with frontmatter]
---ARTICLE_END---

---REFLECTION_START---
{
  "position_updates": [],
  "new_open_questions": [],
  "theme_updates": [],
  "weighting_impact": "description of how this affects 50% balance",
  "editorial_notes": "notes to yourself"
}
---REFLECTION_END---`;
}

// ── Parse article from mm!ke's response ──

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

// ── Parse reflection ──

function parseReflection(responseText) {
  const match = responseText.match(/---REFLECTION_START---\s*([\s\S]*?)\s*---REFLECTION_END---/);
  if (!match) return null;
  try {
    const jsonMatch = match[1].match(/```(?:json)?\s*([\s\S]*?)```/) || [null, match[1]];
    return JSON.parse(jsonMatch[1].trim());
  } catch {
    return null;
  }
}

// ── Update memory ──

function updateMemory(reflection, article) {
  if (reflection) {
    let positions = existsSync(POSITIONS_PATH)
      ? JSON.parse(readFileSync(POSITIONS_PATH, 'utf-8'))
      : { tracked_themes: [], evolving_views: [], open_questions: [] };

    if (reflection.new_open_questions) {
      positions.open_questions = [
        ...(positions.open_questions || []),
        ...reflection.new_open_questions
      ].slice(-30);
    }

    if (reflection.theme_updates) {
      for (const update of reflection.theme_updates) {
        const existing = positions.tracked_themes?.find(t => t.theme === update.theme);
        if (existing) {
          existing.status = update.status || existing.status;
          existing.last_updated = new Date().toISOString().split('T')[0];
        } else {
          if (!positions.tracked_themes) positions.tracked_themes = [];
          positions.tracked_themes.push({
            theme: update.theme,
            status: update.status || 'new',
            first_tracked: new Date().toISOString().split('T')[0],
            last_updated: new Date().toISOString().split('T')[0]
          });
        }
      }
    }

    if (reflection.position_updates) {
      for (const update of reflection.position_updates) {
        const existing = positions.evolving_views?.find(v => v.topic === update.topic);
        if (existing) {
          existing.previous_view = existing.current_view;
          existing.current_view = update.view || update.current_view;
          existing.confidence = update.confidence || existing.confidence;
          existing.last_updated = new Date().toISOString().split('T')[0];
        } else {
          if (!positions.evolving_views) positions.evolving_views = [];
          positions.evolving_views.push({
            topic: update.topic,
            current_view: update.view || update.current_view,
            confidence: update.confidence || 'low',
            first_formed: new Date().toISOString().split('T')[0],
            last_updated: new Date().toISOString().split('T')[0]
          });
        }
      }
    }

    positions.last_updated = new Date().toISOString();
    writeFileSync(POSITIONS_PATH, JSON.stringify(positions, null, 2));
  }

  if (article) {
    let log = existsSync(EDITORIAL_LOG_PATH)
      ? JSON.parse(readFileSync(EDITORIAL_LOG_PATH, 'utf-8'))
      : { entries: [] };

    log.entries.push({
      title: article.meta.title || article.slug,
      slug: article.slug,
      category: article.meta.category || 'unknown',
      staging: article.verificationReport?.recommended_staging || article.meta.staging || 'unclassified',
      summary: article.meta.description || '',
      publishDate: new Date().toISOString().split('T')[0],
      sources: article.meta.sources || '',
      serves_50_percent: article.meta.serves_50_percent || false
    });

    if (log.entries.length > 200) log.entries = log.entries.slice(-200);
    log.last_updated = new Date().toISOString();
    writeFileSync(EDITORIAL_LOG_PATH, JSON.stringify(log, null, 2));

    updateWeighting(article);
  }
}

// ── 50% weighting tracker ──

function updateWeighting(article) {
  let tracker = existsSync(WEIGHTING_PATH)
    ? JSON.parse(readFileSync(WEIGHTING_PATH, 'utf-8'))
    : { entries: [], underrepresented_percentage: 0 };

  tracker.entries.push({
    date: new Date().toISOString().split('T')[0],
    slug: article.slug,
    serves_underrepresented: article.meta.serves_50_percent || false
  });

  const fourWeeksAgo = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  tracker.entries = tracker.entries.filter(e => e.date >= fourWeeksAgo);

  const total = tracker.entries.length;
  const underrepresented = tracker.entries.filter(e => e.serves_underrepresented).length;
  tracker.underrepresented_percentage = total > 0 ? Math.round((underrepresented / total) * 100) : 0;
  tracker.last_updated = new Date().toISOString();

  writeFileSync(WEIGHTING_PATH, JSON.stringify(tracker, null, 2));
}

// ── Git operations ──

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

Editorial cycle: ${new Date().toISOString()}
Staging: ${staging}
Verification: ${verificationReport ? 'completed' : 'pending'}
Claims verified: ${verificationReport?.overall_assessment?.verified || 'n/a'}
Claims unverified: ${verificationReport?.overall_assessment?.unverified || 'n/a'}`;

    execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, { cwd: join(__dirname, '..'), stdio: 'pipe' });
    execSync(`git push origin ${branch}`, { cwd: join(__dirname, '..'), stdio: 'pipe' });

    const prTitle = `[${staging.toUpperCase()}] ${article.meta.title || slug}`;

    let prBody = `## Editorial cycle output\n\n`;
    prBody += `**Staging classification**: ${staging.toUpperCase()}\n`;
    prBody += `**Category**: ${article.meta.category || 'unclassified'}\n\n`;

    if (verificationReport && verificationReport.claims) {
      prBody += `### Verification report\n\n`;
      prBody += `- Claims extracted: ${verificationReport.claims_extracted || 0}\n`;
      const a = verificationReport.overall_assessment || {};
      prBody += `- Verified: ${a.verified || 0}\n`;
      prBody += `- Partially verified: ${a.partially_verified || 0}\n`;
      prBody += `- Unverified: ${a.unverified || 0}\n`;
      prBody += `- Contradicted: ${a.contradicted || 0}\n`;
      prBody += `- Staging rationale: ${verificationReport.staging_rationale || 'See report'}\n\n`;

      if (verificationReport.disclosure_text) {
        prBody += `### Disclosures to include\n\n${verificationReport.disclosure_text}\n\n`;
      }
    }

    prBody += `### mm!ke's editorial notes\n\n${article.meta.editorNote || 'No notes.'}\n`;

    execSync(
      `gh pr create --title "${prTitle.replace(/"/g, '\\"')}" --body "${prBody.replace(/"/g, '\\"')}"`,
      { cwd: join(__dirname, '..'), stdio: 'pipe' }
    );

    execSync('git checkout main', { cwd: join(__dirname, '..'), stdio: 'pipe' });
    console.log(`[editor] PR created: ${prTitle} [${staging.toUpperCase()}]`);
    return { success: true, branch, staging };

  } catch (err) {
    console.error(`[editor] Failed to create PR for ${slug}:`, err.message);
    try { execSync('git checkout main', { cwd: join(__dirname, '..'), stdio: 'pipe' }); } catch {}
    return { success: false, error: err.message };
  }
}

// ── Main editorial cycle ──

async function runEditorialCycle() {
  const cycleStart = new Date().toISOString();
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[editor] mm!ke EDITORIAL CYCLE: ${cycleStart}`);
  console.log(`${'='.repeat(60)}\n`);

  const queueStatus = stats();
  console.log(`[editor] Queue: ${queueStatus.pending} pending, ${queueStatus.published} published, ${queueStatus.killed} killed`);

  // Step 1: Claim the best story from the queue
  console.log('\n--- STEP 1: CURATE ---\n');
  const story = claimNext();

  if (!story) {
    console.log('[editor] Nothing in the queue. The scout has not filed any stories yet.');
    console.log('[editor] This is normal between scout runs. Nothing to do.');
    return;
  }

  console.log(`[editor] Selected: "${story.title}" (score: ${story.score}, category: ${story.category})`);

  // Step 2: Write the article (no web search needed -- just writing)
  console.log('\n--- STEP 2: WRITE ---\n');
  const systemPrompt = loadSystemPrompt();
  const memory = loadMemoryContext();
  const writingPrompt = buildWritingPrompt(story, memory);

  const writeResponse = await withRetry(() => client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 16000,
    system: systemPrompt,
    messages: [{ role: 'user', content: writingPrompt }]
  }), 'editor-write');

  let writeText = '';
  for (const block of writeResponse.content) {
    if (block.type === 'text') writeText += block.text;
  }

  const article = parseArticle(writeText);
  const reflection = parseReflection(writeText);

  if (!article) {
    console.log('[editor] Failed to parse article from writing output.');
    markKilled(story.slug, 'Article parsing failed');
    return;
  }

  console.log(`[editor] Drafted: "${article.meta.title || article.slug}"`);

  // Step 3: Verify (web search -- but no competition with scout)
  console.log('\n--- STEP 3: VERIFY ---\n');
  const verificationReport = await verifyArticle(article.body, article.meta);
  article.verificationReport = verificationReport;

  const stagingOrder = { green: 0, amber: 1, red: 2 };
  const verifiedStaging = verificationReport.recommended_staging || 'amber';
  const draftStaging = article.meta.staging || 'amber';

  if ((stagingOrder[verifiedStaging] || 0) > (stagingOrder[draftStaging] || 0)) {
    console.log(`[editor] Verification escalated staging: ${draftStaging} -> ${verifiedStaging}`);
    article.meta.staging = verifiedStaging;
  }

  if (verificationReport.disclosure_text) {
    const disclosureLine = `\n\n*Verification note: ${verificationReport.disclosure_text}*\n`;
    if (article.content.includes("mm!ke's note")) {
      article.content = article.content.replace(/(\*mm!ke's note)/, `${disclosureLine}\n$1`);
    } else {
      article.content += disclosureLine;
    }
  }

  // Step 4: Stage (git branch + PR)
  console.log('\n--- STEP 4: STAGE ---\n');
  const prResult = createStagingPR(article, verificationReport);

  if (prResult.success) {
    markPublished(story.slug);
  } else {
    markKilled(story.slug, `PR creation failed: ${prResult.error}`);
  }

  // Step 5: Reflect and update memory
  console.log('\n--- STEP 5: REFLECT ---\n');
  updateMemory(reflection, article);

  try {
    execSync('git add agents/memory/', { cwd: join(__dirname, '..'), stdio: 'pipe' });
    execSync(`git commit -m "mm!ke: memory update ${new Date().toISOString().split('T')[0]}"`, { cwd: join(__dirname, '..'), stdio: 'pipe' });
    execSync('git push origin main', { cwd: join(__dirname, '..'), stdio: 'pipe' });
    console.log('[editor] Memory committed to main');
  } catch {
    console.log('[editor] No memory changes to commit');
  }

  const elapsed = Math.round((new Date() - new Date(cycleStart)) / 1000);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[editor] CYCLE COMPLETE (${elapsed}s)`);
  console.log(`[editor] Article: ${article.meta.title || article.slug}`);
  console.log(`[editor] Staging: ${verificationReport.recommended_staging?.toUpperCase() || 'AMBER'}`);
  console.log(`[editor] PR: ${prResult.success ? 'created' : 'FAILED'}`);
  console.log(`${'='.repeat(60)}\n`);
}

export { runEditorialCycle };

if (process.argv[1] && process.argv[1].endsWith('editor.mjs')) {
  runEditorialCycle().catch(err => {
    console.error('[editor] Fatal error:', err);
    process.exit(1);
  });
}
