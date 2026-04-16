/**
 * editor.mjs -- Editorial Orchestrator
 *
 * The brain of mm!ke. Runs the full editorial cycle:
 *   1. Monitor (RSS feeds + tip line)
 *   2. Discover (web search for what feeds missed)
 *   3. Research (deep dive on candidates)
 *   4. Write (draft articles with mm!ke's voice)
 *   5. Verify (structured claim validation)
 *   6. Stage (create PRs with green/amber/red classification)
 *   7. Reflect (update memory, positions, knowledge)
 *
 * Run: node agents/editor.mjs
 * Expects: ANTHROPIC_API_KEY, GITHUB_TOKEN
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

import { runMonitor } from './monitor.mjs';
import { runDiscovery } from './discover.mjs';
import { runResearch } from './research.mjs';
import { verifyArticle } from './verify.mjs';
import { withRetry } from './rate-limit-helper.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = __dirname;
const MEMORY_DIR = join(__dirname, 'memory');
const ARTICLES_DIR = join(__dirname, '..', 'src', 'content', 'articles');
const SYSTEM_PROMPT_PATH = join(__dirname, 'mmike-system-prompt.md');
const SOURCES_PATH = join(__dirname, 'sources.json');

// Memory files
const EDITORIAL_LOG_PATH = join(MEMORY_DIR, 'editorial-log.json');
const POSITIONS_PATH = join(MEMORY_DIR, 'positions.json');
const KNOWLEDGE_PATH = join(MEMORY_DIR, 'knowledge.json');
const WEIGHTING_PATH = join(MEMORY_DIR, 'weighting-tracker.json');
const RESEARCH_PATH = join(MEMORY_DIR, 'latest-research.json');

const client = new Anthropic();

// ── Rate-limit strategy ──
// No fixed cooldowns between phases. Instead, every API call is wrapped
// in withRetry() which catches 429s, reads the retry-after header, and
// waits only when actually rate-limited. This avoids burning minutes on
// preventative waits while still recovering gracefully from token limits.

// ── Ensure memory directory exists ──

if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });

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

// ── Build writing prompt ──

function buildWritingPrompt(research, memory) {
  const candidates = (research.researched_candidates || [])
    .filter(r => r.editorial_recommendation === 'cover');

  if (candidates.length === 0) return null;

  const candidateDetails = candidates.map((c, i) => `
### Story ${i + 1}: ${c.original_title}

Research summary:
${c.research_summary}

Primary source: ${c.primary_source || c.original_url}
Primary source verified: ${c.primary_source_verified ? 'Yes' : 'No'}
Additional sources: ${(c.additional_sources || []).map(s => s.url).join(', ') || 'None'}
Key facts: ${(c.key_facts || []).map(f => `"${f.claim}" [${f.verified ? 'verified' : 'unverified'}]`).join('; ')}
Suggested angle: ${c.suggested_angle}
Suggested story type: ${c.suggested_story_type}
Estimated staging: ${c.estimated_staging}
Serves 50% rule: ${c.serves_50_percent_rule ? 'Yes' : 'No'}
`).join('\n');

  // Build 50% weighting context
  let weightingContext = 'No weighting data available yet.';
  if (memory.weighting) {
    const w = memory.weighting;
    weightingContext = `Current 50% rule balance: ${w.underrepresented_percentage || 0}% underrepresented coverage in the last 4 weeks (target: 50% minimum). ${w.underrepresented_percentage < 50 ? 'BELOW TARGET -- prioritise underrepresented stories.' : 'On target.'}`;
  }

  // Cross-cutting themes
  const themes = research.cross_cutting_themes?.length > 0
    ? research.cross_cutting_themes.map(t => `- ${t}`).join('\n')
    : 'None identified this cycle.';

  // Positions context
  let positionsContext = '';
  if (memory.positions) {
    const p = memory.positions;
    if (p.tracked_themes?.length > 0) {
      positionsContext += '\n\nThemes I am tracking:\n' +
        p.tracked_themes.map(t => `- ${t.theme}: ${t.status} (last updated: ${t.last_updated || 'unknown'})`).join('\n');
    }
    if (p.evolving_views?.length > 0) {
      positionsContext += '\n\nMy evolving views:\n' +
        p.evolving_views.map(v => `- ${v.topic}: ${v.current_view} (confidence: ${v.confidence || 'medium'})`).join('\n');
    }
  }

  return `You have ${candidates.length} stories to write based on completed research. Here are the stories the research agent recommends for coverage:

${candidateDetails}

## Cross-cutting themes this cycle
${themes}

## 50% weighting status
${weightingContext}

## My editorial positions and tracked themes
${positionsContext || 'No positions recorded yet. This is an early cycle.'}

## Your task

For each story recommended for coverage, write a complete article draft in markdown. Follow your editorial voice and standards exactly.

For each article, output:
1. Complete frontmatter (title, description, publishDate, author: mm!ke, tags, category, staging, sources array, editorNote)
2. The article body
3. A brief editor's note at the end, signed mm!ke

After all articles, also output:
- Any updates to your editorial positions or tracked themes
- Any new open questions you want to track
- Whether this cycle's output shifts your 50% weighting balance

Format your response as:

---ARTICLE_START---
[complete markdown with frontmatter]
---ARTICLE_END---

---ARTICLE_START---
[next article if multiple]
---ARTICLE_END---

---REFLECTION_START---
{
  "position_updates": [...],
  "new_open_questions": [...],
  "theme_updates": [...],
  "weighting_impact": "description of how this cycle affects 50% balance",
  "editorial_notes": "any notes to yourself about coverage direction, sources, or things to revisit"
}
---REFLECTION_END---`;
}

// ── Parse articles from mm!ke's response ──

function parseArticles(responseText) {
  const articles = [];
  const articleRegex = /---ARTICLE_START---\s*([\s\S]*?)\s*---ARTICLE_END---/g;
  let match;

  while ((match = articleRegex.exec(responseText)) !== null) {
    const content = match[1].trim();

    // Extract frontmatter
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

    // Generate slug from title
    const slug = (meta.title || 'untitled')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80);

    articles.push({ content, body, meta, slug });
  }

  return articles;
}

// ── Parse reflection from mm!ke's response ──

function parseReflection(responseText) {
  const reflectionMatch = responseText.match(/---REFLECTION_START---\s*([\s\S]*?)\s*---REFLECTION_END---/);
  if (!reflectionMatch) return null;

  try {
    const jsonMatch = reflectionMatch[1].match(/```(?:json)?\s*([\s\S]*?)```/) || [null, reflectionMatch[1]];
    return JSON.parse(jsonMatch[1].trim());
  } catch {
    console.error('[editor] Could not parse reflection JSON');
    return null;
  }
}

// ── Update memory with reflection ──

function updateMemory(reflection, articles) {
  // Update positions
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

  // Update editorial log
  let log = existsSync(EDITORIAL_LOG_PATH)
    ? JSON.parse(readFileSync(EDITORIAL_LOG_PATH, 'utf-8'))
    : { entries: [] };

  for (const article of articles) {
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
  }

  // Cap log at 200 entries
  if (log.entries.length > 200) {
    log.entries = log.entries.slice(-200);
  }

  log.last_updated = new Date().toISOString();
  writeFileSync(EDITORIAL_LOG_PATH, JSON.stringify(log, null, 2));

  // Update weighting tracker
  updateWeighting(articles);
}

// ── Update 50% weighting tracker ──

function updateWeighting(articles) {
  let tracker = existsSync(WEIGHTING_PATH)
    ? JSON.parse(readFileSync(WEIGHTING_PATH, 'utf-8'))
    : { entries: [], underrepresented_percentage: 0 };

  for (const article of articles) {
    tracker.entries.push({
      date: new Date().toISOString().split('T')[0],
      slug: article.slug,
      serves_underrepresented: article.meta.serves_50_percent || false
    });
  }

  // Keep only last 4 weeks
  const fourWeeksAgo = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  tracker.entries = tracker.entries.filter(e => e.date >= fourWeeksAgo);

  // Calculate percentage
  const total = tracker.entries.length;
  const underrepresented = tracker.entries.filter(e => e.serves_underrepresented).length;
  tracker.underrepresented_percentage = total > 0 ? Math.round((underrepresented / total) * 100) : 0;
  tracker.last_updated = new Date().toISOString();

  writeFileSync(WEIGHTING_PATH, JSON.stringify(tracker, null, 2));
}

// ── Git operations for staging ──

function createStagingPR(article, verificationReport) {
  const staging = verificationReport?.recommended_staging || article.meta.staging || 'amber';
  const slug = article.slug;
  const branch = `mmike/${slug}`;
  const filePath = `src/content/articles/${slug}.md`;

  try {
    // Create branch
    execSync(`git checkout -b ${branch}`, { cwd: join(__dirname, '..'), stdio: 'pipe' });

    // Write article file
    const articlePath = join(ARTICLES_DIR, `${slug}.md`);
    writeFileSync(articlePath, article.content);

    // Stage and commit
    execSync(`git add "${filePath}"`, { cwd: join(__dirname, '..'), stdio: 'pipe' });

    const commitMsg = `[${staging.toUpperCase()}] ${article.meta.title || slug}

Editorial cycle: ${new Date().toISOString()}
Staging: ${staging}
Verification: ${verificationReport ? 'completed' : 'pending'}
Claims verified: ${verificationReport?.overall_assessment?.verified || 'n/a'}
Claims unverified: ${verificationReport?.overall_assessment?.unverified || 'n/a'}`;

    execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, { cwd: join(__dirname, '..'), stdio: 'pipe' });

    // Push branch
    execSync(`git push origin ${branch}`, { cwd: join(__dirname, '..'), stdio: 'pipe' });

    // Create PR
    const labels = `staging-${staging}`;
    const prTitle = `[${staging.toUpperCase()}] ${article.meta.title || slug}`;

    let prBody = `## Editorial cycle output\n\n`;
    prBody += `**Staging classification**: ${staging.toUpperCase()}\n`;
    prBody += `**Category**: ${article.meta.category || 'unclassified'}\n\n`;

    if (verificationReport) {
      prBody += `### Verification report\n\n`;
      prBody += `- Claims extracted: ${verificationReport.claims_extracted || 0}\n`;
      const assessment = verificationReport.overall_assessment || {};
      prBody += `- Verified: ${assessment.verified || 0}\n`;
      prBody += `- Partially verified: ${assessment.partially_verified || 0}\n`;
      prBody += `- Unverified: ${assessment.unverified || 0}\n`;
      prBody += `- Contradicted: ${assessment.contradicted || 0}\n`;
      prBody += `- Staging rationale: ${verificationReport.staging_rationale || 'See report'}\n\n`;

      if (verificationReport.disclosure_text) {
        prBody += `### Disclosures to include\n\n${verificationReport.disclosure_text}\n\n`;
      }
    }

    prBody += `### mm!ke's editorial notes\n\n${article.meta.editorNote || 'No notes.'}\n`;

    execSync(
      `gh pr create --title "${prTitle.replace(/"/g, '\\"')}" --body "${prBody.replace(/"/g, '\\"')}" --label "${labels}"`,
      { cwd: join(__dirname, '..'), stdio: 'pipe' }
    );

    // Return to main branch
    execSync('git checkout main', { cwd: join(__dirname, '..'), stdio: 'pipe' });

    console.log(`[editor] PR created: ${prTitle} [${staging.toUpperCase()}]`);
    return { success: true, branch, staging };

  } catch (err) {
    console.error(`[editor] Failed to create PR for ${slug}:`, err.message);
    // Try to return to main
    try { execSync('git checkout main', { cwd: join(__dirname, '..'), stdio: 'pipe' }); } catch {}
    return { success: false, error: err.message };
  }
}

// ── Main editorial cycle ──

async function runEditorialCycle() {
  const cycleStart = new Date().toISOString();
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[editor] EDITORIAL CYCLE STARTING: ${cycleStart}`);
  console.log(`${'='.repeat(60)}\n`);

  // Phase 1: Monitor (no API calls -- RSS only)
  console.log('\n--- PHASE 1: MONITORING ---\n');
  const digest = await runMonitor();

  // Phase 2: Discover (web search -- heavy token usage)
  console.log('\n--- PHASE 2: DISCOVERY ---\n');
  const discovery = await runDiscovery();

  // No cooldown -- withRetry() handles any 429s automatically.

  // Phase 3: Research (web search -- heavy token usage)
  console.log('\n--- PHASE 3: RESEARCH ---\n');
  const research = await runResearch();

  // Check if we have anything to write about
  const coverCandidates = (research.researched_candidates || [])
    .filter(r => r.editorial_recommendation === 'cover');

  if (coverCandidates.length === 0) {
    console.log('\n[editor] No stories recommended for coverage this cycle.');
    console.log('[editor] This is normal. Not every cycle produces publishable content.');

    // Still run reflection to update memory
    await runReflectionOnly(digest, discovery, research);
    return;
  }

  // No cooldown -- withRetry() handles any 429s automatically.

  // Phase 4: Write
  console.log(`\n--- PHASE 4: WRITING (${coverCandidates.length} stories) ---\n`);
  const systemPrompt = loadSystemPrompt();
  const memory = loadMemoryContext();
  const writingPrompt = buildWritingPrompt(research, memory);

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

  const articles = parseArticles(writeText);
  const reflection = parseReflection(writeText);

  if (articles.length === 0) {
    console.log('[editor] No articles parsed from writing output. Check response format.');
    return;
  }

  console.log(`[editor] Drafted ${articles.length} article(s)`);

  // No cooldown -- withRetry() handles any 429s automatically.

  // Phase 5: Verify each article
  console.log('\n--- PHASE 5: VERIFICATION ---\n');
  for (const article of articles) {
    const report = await verifyArticle(article.body, article.meta);
    article.verificationReport = report;

    // Override staging with verification recommendation if more conservative
    const stagingOrder = { green: 0, amber: 1, red: 2 };
    const verifiedStaging = report.recommended_staging || 'amber';
    const draftStaging = article.meta.staging || 'amber';

    if ((stagingOrder[verifiedStaging] || 0) > (stagingOrder[draftStaging] || 0)) {
      console.log(`[editor] Verification escalated staging: ${draftStaging} -> ${verifiedStaging}`);
      article.meta.staging = verifiedStaging;
    }

    // Inject disclosure text into article if needed
    if (report.disclosure_text) {
      const disclosureLine = `\n\n*Verification note: ${report.disclosure_text}*\n`;
      // Insert before editor's note if present, otherwise append
      if (article.content.includes("mm!ke's note:") || article.content.includes("*mm!ke's note")) {
        article.content = article.content.replace(
          /(\*mm!ke's note)/,
          `${disclosureLine}\n$1`
        );
      } else {
        article.content += disclosureLine;
      }
    }
  }

  // Phase 6: Stage (create PRs)
  console.log('\n--- PHASE 6: STAGING ---\n');
  for (const article of articles) {
    const result = createStagingPR(article, article.verificationReport);
    if (result.success) {
      console.log(`[editor] Staged: ${article.slug} [${result.staging.toUpperCase()}]`);
    }
  }

  // Phase 7: Reflect and update memory
  console.log('\n--- PHASE 7: REFLECTION ---\n');
  updateMemory(reflection, articles);

  // Commit memory updates
  try {
    execSync('git add agents/memory/', { cwd: join(__dirname, '..'), stdio: 'pipe' });
    execSync('git add agents/sources.json', { cwd: join(__dirname, '..'), stdio: 'pipe' });
    execSync(`git commit -m "mm!ke: memory update ${new Date().toISOString().split('T')[0]}"`, { cwd: join(__dirname, '..'), stdio: 'pipe' });
    execSync('git push origin main', { cwd: join(__dirname, '..'), stdio: 'pipe' });
  } catch {
    console.log('[editor] No memory changes to commit, or push failed');
  }

  const cycleEnd = new Date().toISOString();
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[editor] EDITORIAL CYCLE COMPLETE: ${cycleEnd}`);
  console.log(`[editor] Articles drafted: ${articles.length}`);
  console.log(`[editor] PRs created: ${articles.filter(a => a.verificationReport).length}`);
  console.log(`${'='.repeat(60)}\n`);
}

// ── Reflection-only cycle (when no stories to write) ──

async function runReflectionOnly(digest, discovery, research) {
  console.log('\n--- REFLECTION (no-output cycle) ---\n');

  const memory = loadMemoryContext();
  const systemPrompt = loadSystemPrompt();

  const reflectionPrompt = `This editorial cycle produced no stories worth covering. That is fine. But I still want to reflect on what I observed.

## Monitoring digest
${digest.item_count} items scanned from ${digest.sources_checked} sources.
Top items: ${(digest.items || []).slice(0, 5).map(i => i.title).join('; ')}

## Discovery results
${(discovery.discoveries || []).length} items found via web search.
${(discovery.coverage_gaps_identified || []).length > 0 ? 'Coverage gaps identified: ' + discovery.coverage_gaps_identified.join('; ') : 'No specific coverage gaps flagged.'}

## Research recommendations
${(research.researched_candidates || []).length} candidates researched.
${(research.researched_candidates || []).map(r => `- ${r.original_title}: ${r.editorial_recommendation} (${r.recommendation_rationale})`).join('\n')}

## Your task

Reflect on this cycle. Update your positions, tracked themes, and open questions. Even when there is nothing to publish, you should be learning and evolving your understanding of the legal AI space.

Output:
---REFLECTION_START---
{
  "position_updates": [],
  "new_open_questions": [],
  "theme_updates": [],
  "weighting_impact": "no articles this cycle",
  "editorial_notes": "your notes about what you observed and what to watch for next cycle"
}
---REFLECTION_END---`;

  const response = await withRetry(() => client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    system: systemPrompt,
    messages: [{ role: 'user', content: reflectionPrompt }]
  }), 'editor-reflect');

  let responseText = '';
  for (const block of response.content) {
    if (block.type === 'text') responseText += block.text;
  }

  const reflection = parseReflection(responseText);
  if (reflection) {
    updateMemory(reflection, []);
    console.log('[editor] Memory updated from reflection');
  }
}

export { runEditorialCycle };

if (process.argv[1] && process.argv[1].endsWith('editor.mjs')) {
  runEditorialCycle().catch(err => {
    console.error('[editor] Fatal error:', err);
    process.exit(1);
  });
}
