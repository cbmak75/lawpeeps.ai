# agents/

The editorial automation layer for lawpeeps.ai. These scripts run on GitHub Actions every six hours to monitor sources, draft articles, and manage editorial memory.

## Files

### monitor.mjs

Source monitoring script. Fetches RSS feeds defined in `sources.json`, filters for recent and relevant items, deduplicates against the last 3 days of digests, and fetches new tip line submissions from the Netlify Forms API. Outputs a timestamped JSON digest to `digests/`.

**Environment variables:**
- `NETLIFY_TOKEN`: Personal access token for the Netlify Forms API (stored as `LAWPEEPS_MMIKE` in GitHub Actions secrets)

**Relevance scoring:** Each item is scored against a keyword list (15 terms) and a company watch list (19 companies). UK-specific terms receive a bonus. Items scoring zero are dropped. The top 30 items by score are included in the digest.

**Tip line ingestion:** Pulls submissions from the Netlify Forms API for the `tipline` form, filters to the last 48 hours, and deduplicates against `memory/processed-tips.json`. Tips always receive a relevance score of 10 and are prefixed with `[TIP]` in the digest.

### editor.mjs

Claude-powered editorial agent. Reads the latest digest, consults editorial memory, and makes two API calls to Claude:

1. **Story identification**: Reviews the digest against editorial memory. Selects stories that meet editorial criteria, assigns staging classifications, and explains why other items were skipped.

2. **Article drafting**: For each selected story (max 2 per cycle), drafts a complete markdown article with frontmatter following the rules in `mmike-system-prompt.md`.

**Safety checks:**
- Rejects drafted articles that contain refusal language ("I cannot produce this article") rather than substantive content
- Reconciles staging between the story plan and the article's own frontmatter, escalating if the article self-classifies at a higher risk level
- Strips markdown code fences if Claude wraps the output

**Environment variables:**
- `ANTHROPIC_API_KEY`: Claude API key

**Model:** claude-sonnet-4-20250514

### mmike-system-prompt.md

mm!ke's complete editorial identity, voice, and rules. Covers: identity and tone, UK English language standards, banned words and punctuation, editorial principles (accuracy, independence, fairness, transparency, corrections), the 50% rule for coverage balance, anti-discrimination policy, staging classification criteria, article output format, and the draft-or-skip rule.

### sources.json

Configuration for the source monitor. Contains three sections:

- `rss_feeds`: Array of feed objects with name, URL, category, and priority
- `keywords`: Terms used for relevance scoring
- `companies_watch_list`: Legal AI companies tracked for mentions

### memory/

Persistent editorial state, committed to the repository after each cycle.

- `editorial-log.json`: Record of all articles mm!ke has published or drafted, including title, slug, category, staging, publish date, and sources. Used to prevent duplicate coverage.
- `processed-tips.json`: Array of Netlify Forms submission IDs that have already been ingested. Capped at 200 entries.

### digests/

Timestamped JSON files produced by the monitor. Each digest contains the items found, their relevance scores, source metadata, and any errors encountered during fetching. The editor reads the most recent digest. Digests older than 3 days are excluded from deduplication checks.

The directory is gitignored except for `.gitkeep`. Digests are ephemeral build artefacts.

### last-run.json

Summary of the most recent editorial cycle. Contains: timestamp, number of stories identified, number of articles drafted, article metadata (title, slug, category, staging, staging reason), and editorial notes. Used by the GitHub Actions workflow to construct the PR title, body, and labels.

This file is force-added to commits (`git add -f`) since it is otherwise gitignored.

## Workflow integration

The editorial cycle is orchestrated by `.github/workflows/mmike-editorial.yml`:

1. `node agents/monitor.mjs` (skippable via workflow input)
2. `node agents/editor.mjs`
3. Check for new article files in `src/content/articles/`
4. If articles exist: create branch, commit, push, open PR with staging labels
5. If no articles: commit any memory updates (e.g. processed tip IDs) directly to main

The staging hold window is enforced by `.github/workflows/staging-auto-merge.yml`, which runs hourly and auto-merges PRs that have passed their hold period.
