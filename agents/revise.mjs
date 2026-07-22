/**
 * mm!ke Revision Agent for lawpeeps.ai
 *
 * Called when the operator requests changes on a PR.
 * Fetches review comments, reads the article, calls Claude to revise,
 * and commits the changes back to the PR branch.
 *
 * Requires: GEMINI_API_KEY, GITHUB_TOKEN environment variables
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { generate, MODELS } from './llm.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const CONTENT_DIR = join(REPO_ROOT, 'src', 'content', 'articles');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!process.env.GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY environment variable is required');
  process.exit(1);
}

if (!GITHUB_TOKEN) {
  console.error('GITHUB_TOKEN environment variable is required');
  process.exit(1);
}

// ─── Helpers ───────────────────────────────────────────────────────

function loadSystemPrompt() {
  return readFileSync(join(__dirname, 'mmike-system-prompt.md'), 'utf-8');
}

// ─── Claude API ────────────────────────────────────────────────────

async function callClaude(systemPrompt, userMessage, maxTokens = 4096) {
  // v4: routed through the shared Gemini client (free tier). Function
  // name kept so call sites stay unchanged.
  const { text } = await generate({
    model: MODELS.editor,
    system: systemPrompt,
    user: userMessage,
    maxTokens,
    label: 'revise'
  });
  return text;
}

// ─── GitHub API ────────────────────────────────────────────────────

async function getPullRequest(owner, repo, prNumber) {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
    {
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
      },
    }
  );

  if (!response.ok) {
    throw new Error(`GitHub API error ${response.status}: ${await response.text()}`);
  }

  return response.json();
}

async function getPullRequestReviews(owner, repo, prNumber) {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
    {
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
      },
    }
  );

  if (!response.ok) {
    throw new Error(`GitHub API error ${response.status}: ${await response.text()}`);
  }

  return response.json();
}

async function createPullRequestComment(owner, repo, prNumber, body) {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`,
    {
      method: 'POST',
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body }),
    }
  );

  if (!response.ok) {
    throw new Error(`GitHub API error ${response.status}: ${await response.text()}`);
  }

  return response.json();
}

// ─── Article Finding ───────────────────────────────────────────────

async function findArticlesInPR(owner, repo, prNumber) {
  // Fetch the list of files changed in this PR from the GitHub API
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files`,
    {
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
      },
    }
  );

  if (!response.ok) {
    throw new Error(`GitHub API error ${response.status}: ${await response.text()}`);
  }

  const files = await response.json();
  const articleFiles = files
    .filter(f => f.filename.startsWith('src/content/articles/') && f.filename.endsWith('.md'))
    .filter(f => f.status === 'added' || f.status === 'modified');

  return articleFiles.map(f => ({
    filename: f.filename.split('/').pop(),
    filepath: join(REPO_ROOT, f.filename),
  }));
}

// ─── Main Revision Logic ────────────────────────────────────────────

async function reviseArticles(owner, repo, prNumber, changeComments) {
  const systemPrompt = loadSystemPrompt();

  // Find articles changed in this PR
  const articles = await findArticlesInPR(owner, repo, prNumber);

  if (articles.length === 0) {
    console.log('No articles found in this PR.');
    return { revised: [] };
  }

  console.log(`Found ${articles.length} article(s) to revise.`);

  const revised = [];

  for (const article of articles) {
    console.log(`\nRevising: ${article.filename}`);

    try {
      const originalMarkdown = readFileSync(article.filepath, 'utf-8');

      // Build feedback summary
      const feedbackSummary = changeComments
        .map(c => `- ${c.author}: ${c.body}`)
        .join('\n');

      const revisionPrompt = `You are revising an article for lawpeeps.ai based on the operator's feedback.

ORIGINAL ARTICLE:
${originalMarkdown}

OPERATOR FEEDBACK:
${feedbackSummary}

Instructions:
1. Carefully read and understand all the operator's feedback.
2. Respect the feedback completely -- do not argue or push back. If the operator asks for a change, implement it.
3. Preserve everything the operator did not comment on. Do not change sections, paragraphs, or sentences that were not critiqued.
4. If the operator asks you to cut something, remove it without replacing it with filler.
5. If the operator asks for a different angle or reframing, rewrite that section substantively rather than just rewording.
6. Maintain the same voice, style, and formatting standards as the original. Keep the warm, direct, slightly dry tone.
7. Keep frontmatter unless the operator specifically asks for changes to it (e.g. title, category, tags).
8. Follow all language standards: UK English, no em dashes, no emojis, no banned words.
9. Every factual claim must still reference source material. If a revision requires adding new material, ensure it is verifiable.
10. Keep the editor's note in italics at the end, signed mm!ke. Update it only if necessary to reflect the revision.

Output the complete revised markdown file, starting with the --- frontmatter delimiter. Nothing else before or after.`;

      let revised_markdown = await callClaude(systemPrompt, revisionPrompt, 4096);

      // Strip markdown code fences if Claude wrapped the output
      revised_markdown = revised_markdown
        .replace(/^\`\`\`(?:yaml|markdown|md)?\s*\n/i, '')
        .replace(/\n\`\`\`\s*$/, '');

      // Ensure it starts with frontmatter delimiter
      if (!revised_markdown.startsWith('---')) {
        console.warn('  Warning: revised article did not start with --- frontmatter delimiter');
      }

      // Write the revised article back
      writeFileSync(article.filepath, revised_markdown);
      console.log(`  Revised and saved: ${article.filename}`);

      revised.push({
        filename: article.filename,
        revised_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error(`  Failed to revise "${article.filename}": ${err.message}`);
      throw err;
    }
  }

  return { revised, feedbackSummary: changeComments };
}

// ─── Main ──────────────────────────────────────────────────────────

async function run() {
  const owner = process.env.GITHUB_REPOSITORY?.split('/')[0];
  const repo = process.env.GITHUB_REPOSITORY?.split('/')[1];
  const prNumber = parseInt(process.env.GITHUB_EVENT_PR_NUMBER, 10);

  if (!owner || !repo || !prNumber) {
    console.error(
      'Required environment variables missing: GITHUB_REPOSITORY, GITHUB_EVENT_PR_NUMBER'
    );
    process.exit(1);
  }

  console.log(`mm!ke revision agent starting for PR #${prNumber}...\n`);

  try {
    // Get PR reviews with changes_requested action
    const reviews = await getPullRequestReviews(owner, repo, prNumber);

    // Collect all "changes requested" comments
    const changeComments = reviews
      .filter(r => r.state === 'CHANGES_REQUESTED')
      .map(r => ({
        author: r.user.login,
        body: r.body || '(No comment body)',
      }));

    if (changeComments.length === 0) {
      console.log('No "changes requested" reviews found.');
      return { revised: [] };
    }

    console.log(`Found ${changeComments.length} "changes requested" review(s).\n`);

    // Revise articles
    const result = await reviseArticles(owner, repo, prNumber, changeComments);

    if (result.revised.length > 0) {
      // Prepare and post a comment
      const summaryLines = [
        '## mm!ke revision',
        '',
        'I have revised the article(s) based on your feedback:',
        '',
      ];

      for (const r of result.revised) {
        summaryLines.push(`- Updated: \`${r.filename}\``);
      }

      summaryLines.push('');
      summaryLines.push('The changes have been committed to this branch. Your feedback has been completely respected.');
      summaryLines.push('');
      summaryLines.push('*-- mm!ke*');

      const commentBody = summaryLines.join('\n');
      console.log(`\nPosting comment to PR #${prNumber}...`);
      await createPullRequestComment(owner, repo, prNumber, commentBody);
      console.log('Comment posted.');
    }

    console.log('\nRevision complete.');
    return result;
  } catch (err) {
    console.error('Revision agent failed:', err.message);
    process.exit(1);
  }
}

run()
  .then(result => {
    console.log('\nResult:', JSON.stringify(result, null, 2));
  })
  .catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
