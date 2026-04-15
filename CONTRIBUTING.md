# Contributing to lawpeeps.ai

lawpeeps.ai is an editorially independent publication. mm!ke writes the articles; the human operator (Chris Dias) reviews and approves them. This document explains how the editorial pipeline works and how to interact with it.

## Submitting a tip

The easiest way to contribute is via the [tip line](https://lawpeeps.ai/tip-line). Tips are anonymous by default. If you leave contact details, they are used only for editorial follow-up and are never shared with third parties.

Good tips include: a clear description of the news or development, supporting links to primary sources, and any context about why this matters. mm!ke treats tips as leads, not verified facts. A tip will only lead to an article if there is enough verifiable source material to support it.

## How articles move through the pipeline

### 1. Monitoring

Every six hours, the source monitor (`agents/monitor.mjs`) runs automatically via GitHub Actions. It fetches RSS feeds, scores items for relevance, and pulls any new tip line submissions from the Netlify Forms API. The output is a timestamped JSON digest in `agents/digests/`.

### 2. Editorial decisions

The editorial agent (`agents/editor.mjs`) reads the latest digest against mm!ke's editorial memory (previous articles, covered topics). It decides which items, if any, warrant coverage. Not every cycle produces an article. mm!ke is explicitly instructed that publishing nothing is better than publishing filler.

### 3. Drafting

For each selected story, mm!ke drafts a complete markdown article following the voice, language standards, and editorial rules in `agents/mmike-system-prompt.md`. Each article includes a staging classification:

- **Green**: Factual, publicly sourced news. Low editorial risk.
- **Amber**: Names individuals critically, relies on single source, or covers financial/regulatory matters.
- **Red**: Unverifiable claims, potential legal liability, or suspected competitive motivation.

### 4. Pull request

The workflow creates a branch (`mmike/{slug}`), commits the article(s) and memory updates, and opens a pull request with the appropriate staging label.

### 5. Review and publication

A separate workflow (`staging-auto-merge.yml`) checks open PRs hourly:

- **Green PRs** auto-merge after 2 hours if the operator has not intervened.
- **Amber PRs** auto-merge after 24 hours with a disclosure note if no action is taken.
- **Red PRs** never auto-merge. They require the operator to explicitly merge or close the PR.

The operator can always edit, comment on, or close any PR before the hold window expires.

## Operator actions

### Approving an article

Merge the PR through the GitHub interface. Netlify will deploy it automatically.

### Editing before publication

Check out the PR branch, make changes, push. The PR will update. Merge when satisfied.

### Rejecting an article

Close the PR. The article will not be published. mm!ke's editorial memory will still record that the topic was considered, reducing the likelihood of it being re-drafted in a future cycle.

### Correcting a published article

Edit the article's markdown file on main. Add a `correction` object to the frontmatter:

```yaml
correction:
  date: 2026-04-15
  detail: "Original article stated X. The correct position is Y."
```

The correction will display prominently at the top of the article.

## Adding or removing RSS sources

Edit `agents/sources.json`. Each feed entry requires:

```json
{
  "name": "Source Name",
  "url": "https://example.com/feed/",
  "category": "legal-ai-news",
  "priority": "high|medium|low"
}
```

Keywords and the company watch list can also be updated in the same file.

## Modifying mm!ke's editorial voice

Edit `agents/mmike-system-prompt.md`. This controls mm!ke's identity, tone, language standards, banned words and patterns, editorial principles, staging rules, and output format. Changes take effect on the next editorial cycle.

## Code contributions

If you are contributing to the site code (layouts, components, styles), run the development server locally:

```bash
npm install
npm run dev
```

Build and check before pushing:

```bash
npm run build
```

The site uses Astro 5.7 with content collections. Articles must conform to the schema in `src/content.config.ts` or the build will fail.
