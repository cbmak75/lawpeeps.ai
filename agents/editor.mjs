/**
 * mm!ke Editorial Agent for lawpeeps.ai
 *
 * Reads the latest monitoring digest, calls Claude to identify stories
 * and draft articles, then writes markdown files ready for PR submission.
 *
 * Requires: ANTHROPIC_API_KEY environment variable
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const CONTENT_DIR = join(REPO_ROOT, 'src', 'content', 'articles');
const MEMORY_DIR = join(__dirname, 'memory');
const DIGEST_DIR = join(__dirname, 'digests');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY environment variable is required');
  process.exit(1);
}

// ─── Helpers ───────────────────────────────────────────────────────

function loadSystemPrompt() {
  return readFileSync(join(__dirname, 'mmike-system-prompt.md'), 'utf-8');
}

function loadLatestDigest() {
  if (!existsSync(DIGEST_DIR)) return null;
  const files = readdirSync(DIGEST_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse();

  if (files.length === 0) return null;

  return JSON.parse(readFileSync(join(DIGEST_DIR, files[0]), 'utf-8'));
}

function loadMemory() {
  const memoryFile = join(MEMORY_DIR, 'editorial-log.json');
  if (!existsSync(memoryFile)) {
    return { articles: [], entities: {}, sourceNotes: {} };
  }
  return JSON.parse(readFileSync(memoryFile, 'utf-8'));
}

function saveMemory(memory) {
  mkdirSync(MEMORY_DIR, { recursive: true });
  writeFileSync(join(MEMORY_DIR, 'editorial-log.json'), JSON.stringify(memory, null, 2));
}

function loadExistingArticles() {
  if (!existsSync(CONTENT_DIR)) return [];
  return readdirSync(CONTENT_DIR)
    .filter(f => f.endsWith('.md'))
    .map(f => f.replace('.md', ''));
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

// ─── Claude API ────────────────────────────────────────────────────

async function callClaude(systemPrompt, userMessage, maxTokens = 4096) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Claude API error ${response.status}: ${error}`);
  }

  const data = await response.json();
  return data.content[0].text;
}

// ─── Editorial Pipeline ────────────────────────────────────────────

async function identifyStories(digest, memory, systemPrompt) {
  const existingArticles = loadExistingArticles();

  // Build rich memory context
  const recentArticles = memory.articles.slice(-30);
  const coverageLog = recentArticles.map(a =>
    `- "${a.title}" (${a.category}, ${a.publishDate}) [sources: ${(a.sources || []).join('; ')}]`
  ).join('\n');

  // Extract entities and topics already covered
  const coveredEntities = new Set();
  const coveredTopics = new Set();
  for (const a of recentArticles) {
    // Extract company/product names from titles and sources
    for (const s of (a.sources || [])) {
      coveredEntities.add(s.toLowerCase());
    }
    coveredTopics.add(`${a.title.toLowerCase()}`);
  }

  // Build tip context if tips are present in the digest
  const tipItems = digest.items.filter(i => i.source === 'Tip Line');
  const tipContext = tipItems.length > 0
    ? `\n\nTIP LINE SUBMISSIONS (${tipItems.length}):\nThese are reader-submitted tips. They should be treated as leads, not verified facts. Each tip needs independent verification before coverage. Tips are marked with [TIP] prefix.\n`
    : '';

  const prompt = `You are reviewing the latest source monitoring digest for lawpeeps.ai. Your job is to identify which items, if any, warrant coverage.

Here is the digest:

${JSON.stringify(digest.items, null, 2)}
${tipContext}
YOUR EDITORIAL MEMORY — articles you have already published or drafted:

${coverageLog || '(No recent articles yet. This is the very beginning of the publication.)'}

Existing article slugs in the repository (DO NOT create articles with these slugs):
${existingArticles.join(', ') || '(Only the launch article exists.)'}

${memory.lastEditorialNotes ? `Your editorial notes from the previous cycle:\n${memory.lastEditorialNotes}\n` : ''}
DUPLICATION RULES:
- Do NOT cover a story if you have already published an article on the same topic, event, or announcement.
- Do NOT cover a story just because a different source is reporting the same underlying news. One article per story is enough.
- If a story is a significant UPDATE to something you previously covered, you may write a follow-up, but flag it as such and reference the earlier piece.
- If a tip line submission covers something already published, skip it.

Instructions:
1. Review each item in the digest against your editorial memory above.
2. Identify items that meet your editorial criteria: genuine news value, relevance to legal AI, not a rehash of something already covered.
3. Apply the 50% rule: favour smaller operators, independents, and practitioner-led innovation where possible.
4. For tip line items: verify there is enough substance to investigate. If a tip is vague or unverifiable, note it in editorialNotes for future cycles but do not draft an article.
5. For each item you select, specify:
   - A proposed article title
   - The article category (news, feature, profile, analysis, post-mortem, community, regulatory, research)
   - The staging classification (green, amber, red) with a brief reason
   - A one-sentence pitch explaining why this story matters
   - The source items from the digest that inform this story (by title)
   - Whether this originated from the tip line (fromTip: true/false)

If nothing in the digest warrants coverage right now, say so. It is better to publish nothing than to publish filler.

Respond in JSON format:
{
  "stories": [
    {
      "title": "Proposed article title",
      "category": "news",
      "staging": "green",
      "stagingReason": "Factual news from public announcement",
      "pitch": "Why this matters in one sentence",
      "sourceItems": ["Digest item title 1"],
      "estimatedLength": "short|medium|long",
      "fromTip": false
    }
  ],
  "skipped": "Brief note on why other items were skipped, if relevant",
  "editorialNotes": "Any observations about trends or items to watch for next cycle"
}`;

  const response = await callClaude(systemPrompt, prompt, 2048);

  // Extract JSON from response (Claude may wrap it in markdown code blocks)
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Could not parse story identification response');
  }

  return JSON.parse(jsonMatch[0]);
}

async function draftArticle(story, digest, memory, systemPrompt) {
  const relevantItems = digest.items.filter(item =>
    story.sourceItems.some(s => item.title.toLowerCase().includes(s.toLowerCase().slice(0, 30)))
  );

  const tipNote = story.fromTip
    ? `\nIMPORTANT: This story originated from a reader tip. You must independently verify the claims using the source material provided. If you cannot verify key claims, say so explicitly in the article. If the tipster asked for credit, mention "reported to lawpeeps.ai by a reader" in the article.\n`
    : '';

  const prompt = `Draft an article for lawpeeps.ai.

Story brief:
- Title: ${story.title}
- Category: ${story.category}
- Staging: ${story.staging} (${story.stagingReason})
- Pitch: ${story.pitch}
- Estimated length: ${story.estimatedLength}
- From tip line: ${story.fromTip ? 'yes' : 'no'}
${tipNote}
Source material from the monitoring digest:
${JSON.stringify(relevantItems, null, 2)}

Today's date: ${new Date().toISOString().slice(0, 10)}

Instructions:
1. Write the complete article in markdown with the required frontmatter.
2. The frontmatter MUST start with --- on the very first line (no code fences, no backticks). The frontmatter MUST include: title, description, publishDate (today), author ("mm!ke"), tags (array), category, staging, sources (array of source descriptions), and editorNote.
3. Write in your voice. Warm, direct, slightly dry. UK English throughout.
4. NO em dashes. NO emojis. NO banned words or phrases.
5. Every factual claim must reference its source material. If you cannot verify something from the provided sources, flag it explicitly.
6. End with your editor's note.
7. Keep the slug-friendly: no special characters in the title.

Output the complete markdown file content, starting with the --- frontmatter delimiter. Nothing else before or after the markdown.`;

  return await callClaude(systemPrompt, prompt, 4096);
}

// ─── Main Pipeline ─────────────────────────────────────────────────

async function run() {
  console.log('mm!ke editorial agent starting...\n');

  // Load components
  const systemPrompt = loadSystemPrompt();
  const digest = loadLatestDigest();
  const memory = loadMemory();

  if (!digest || digest.items.length === 0) {
    console.log('No digest available or digest is empty. Nothing to do this cycle.');
    return { articlesWritten: 0 };
  }

  console.log(`Digest loaded: ${digest.items.length} items from ${digest.timestamp}`);

  // Step 1: Identify stories
  console.log('\nStep 1: Identifying stories...');
  const editorial = await identifyStories(digest, memory, systemPrompt);

  if (!editorial.stories || editorial.stories.length === 0) {
    console.log('No stories identified this cycle.');
    if (editorial.editorialNotes) {
      console.log(`Editorial notes: ${editorial.editorialNotes}`);
    }
    return { articlesWritten: 0, editorialNotes: editorial.editorialNotes };
  }

  console.log(`Stories identified: ${editorial.stories.length}`);
  for (const story of editorial.stories) {
    console.log(`  - [${story.staging.toUpperCase()}] ${story.title} (${story.category})`);
  }

  if (editorial.skipped) {
    console.log(`Skipped: ${editorial.skipped}`);
  }

  // Step 2: Draft articles (limit to 2 per cycle to manage API costs)
  const toDraft = editorial.stories.slice(0, 2);
  const drafted = [];

  for (const story of toDraft) {
    console.log(`\nStep 2: Drafting "${story.title}"...`);

    try {
      let markdown = await draftArticle(story, digest, memory, systemPrompt);

      // Strip markdown code fences if Claude wrapped the output
      markdown = markdown.replace(/^```(?:yaml|markdown|md)?\s*\n/i, '').replace(/\n```\s*$/, '');

      // Ensure the file starts with frontmatter delimiter
      if (!markdown.startsWith('---')) {
        console.warn('  Warning: article did not start with --- frontmatter delimiter');
      }

      // Generate slug and filename
      const slug = slugify(story.title);
      const filename = `${slug}.md`;
      const filepath = join(CONTENT_DIR, filename);

      // Ensure content directory exists
      mkdirSync(CONTENT_DIR, { recursive: true });

      // Write the article
      writeFileSync(filepath, markdown);
      console.log(`  Written: src/content/articles/${filename}`);

      drafted.push({
        title: story.title,
        slug,
        filename,
        category: story.category,
        staging: story.staging,
        stagingReason: story.stagingReason,
        draftedAt: new Date().toISOString(),
      });

      // Update memory
      memory.articles.push({
        title: story.title,
        slug,
        category: story.category,
        staging: story.staging,
        publishDate: new Date().toISOString().slice(0, 10),
        sources: story.sourceItems,
      });
    } catch (err) {
      console.error(`  Failed to draft "${story.title}": ${err.message}`);
    }
  }

  // Save updated memory
  if (editorial.editorialNotes) {
    memory.lastEditorialNotes = editorial.editorialNotes;
    memory.lastEditorialNotesDate = new Date().toISOString();
  }
  saveMemory(memory);

  console.log(`\nEditorial cycle complete. Articles drafted: ${drafted.length}`);

  // Write a summary for the GitHub Action to use
  const summary = {
    timestamp: new Date().toISOString(),
    digestTimestamp: digest.timestamp,
    storiesIdentified: editorial.stories.length,
    articlesDrafted: drafted.length,
    articles: drafted,
    editorialNotes: editorial.editorialNotes,
  };

  writeFileSync(join(__dirname, 'last-run.json'), JSON.stringify(summary, null, 2));

  return summary;
}

// Run
run()
  .then(result => {
    console.log('\nResult:', JSON.stringify(result, null, 2));
  })
  .catch(err => {
    console.error('Editorial agent failed:', err);
    process.exit(1);
  });
