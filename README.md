# lawpeeps.ai

An AI-native legal technology publication, edited autonomously by **mm!ke**, an AI editor built on Claude. mm!ke monitors RSS feeds and a reader tip line, identifies stories worth covering, drafts articles, and submits them for publication through a staged editorial pipeline with human oversight.

The site is live at [lawpeeps.ai](https://lawpeeps.ai).

## How it works

lawpeeps.ai is a static site built with Astro, hosted on Netlify, and powered by an autonomous editorial agent that runs on GitHub Actions every six hours. The pipeline has three stages:

1. **Monitor** (`agents/monitor.mjs`): Scans 12 RSS feeds and the reader tip line (via Netlify Forms API) for relevant items. Scores each item by keyword relevance and deduplicates against recent digests. Outputs a structured JSON digest.

2. **Editor** (`agents/editor.mjs`): Reads the latest digest, consults editorial memory to avoid duplication, and calls Claude to identify stories worth covering. For each selected story, it drafts a complete markdown article with frontmatter, assigns a staging classification (green, amber, or red), and writes it to `src/content/articles/`.

3. **Publish** (GitHub Actions): Creates a branch, commits the draft, and opens a pull request with staging labels. A separate workflow handles the hold window: green articles auto-merge after 2 hours, amber after 24 hours (with a disclosure note), red articles require explicit human approval.

The human operator (Chris Dias) retains full control via the PR interface. Any article can be edited, held, or rejected before it reaches the live site.

## Project structure

```
lawpeeps.ai/
├── agents/                     # Editorial automation
│   ├── monitor.mjs             # Source monitoring (RSS + tip line)
│   ├── editor.mjs              # Claude-powered editorial agent
│   ├── mmike-system-prompt.md  # mm!ke's editorial voice and rules
│   ├── sources.json            # RSS feeds, keywords, watch list
│   ├── memory/                 # Persistent editorial memory
│   │   ├── editorial-log.json  # Published article history
│   │   └── processed-tips.json # Deduplicated tip IDs
│   └── digests/                # Timestamped monitoring digests
├── src/
│   ├── content/
│   │   └── articles/           # Markdown articles with frontmatter
│   ├── components/             # Astro components
│   ├── layouts/                # Base, Article, and Page layouts
│   ├── pages/                  # Route pages
│   ├── lib/                    # Constants and utility functions
│   └── styles/                 # Global CSS and retro effects
├── public/                     # Static assets (fonts, images, favicon)
├── .github/workflows/
│   ├── mmike-editorial.yml     # Editorial cycle (every 6 hours)
│   └── staging-auto-merge.yml  # Staging hold window enforcement
├── astro.config.mjs
├── netlify.toml
└── package.json
```

## Content model

Articles are managed as an Astro content collection. Each article is a markdown file in `src/content/articles/` with required frontmatter:

| Field | Type | Description |
|---|---|---|
| `title` | string | Article headline |
| `description` | string | One-sentence summary for meta tags and cards |
| `publishDate` | date | Publication date |
| `author` | string | Defaults to "mm!ke" |
| `tags` | string[] | Topic tags |
| `category` | enum | news, feature, profile, analysis, post-mortem, community, regulatory, research |
| `staging` | enum | green, amber, red |
| `editorNote` | string | mm!ke's sign-off note |
| `sources` | string[] | Source descriptions (optional) |

Additional optional fields support corrections, right-of-response records, cover images, and AI image disclosure flags. The full schema is in `src/content.config.ts`.

## Staging classifications

Every article mm!ke drafts is assigned a staging level that determines how it moves through the publishing pipeline:

**Green**: Factual news based on publicly available information. Auto-publishes after a 2-hour hold window unless the operator intervenes.

**Amber**: Stories that name individuals critically, cover financial or regulatory matters, or rely on a single source. Requires operator review. Will publish after 24 hours with a disclosure note if no action is taken.

**Red**: Stories where a core claim cannot be verified, the tip appears motivated by competitive damage, or the content could expose the publication to legal liability. Will not publish without explicit operator approval.

## Tip line

Readers can submit tips at [lawpeeps.ai/tip-line](https://lawpeeps.ai/tip-line). Submissions are collected via Netlify Forms and ingested by the monitor at each editorial cycle. Tips are treated as leads, not verified facts. mm!ke will only draft an article from a tip if there is enough source material to write a substantive piece.

## Editorial standards

mm!ke operates under a published [editorial charter](https://lawpeeps.ai/editorial-charter). Key principles:

- Every factual claim must be verifiable against a public source or named contact
- At least 50% of output covers smaller operators, independents, and practitioner-led innovation (the "50% rule")
- Subjects of critical coverage get a right of response
- Corrections are published prominently with explanations
- Zero tolerance for discrimination
- Full transparency about AI authorship and editorial limitations

The complete editorial voice, language standards, and banned patterns are defined in `agents/mmike-system-prompt.md`.

## Development

### Prerequisites

- Node.js 22+
- npm

### Local development

```bash
npm install
npm run dev
```

The site runs at `http://localhost:4321`.

### Build

```bash
npm run build
npm run preview
```

Output goes to `dist/`, which Netlify deploys automatically from the `main` branch.

### Environment variables

Copy `.env.example` and fill in the required values:

| Variable | Used by | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | editor.mjs | Claude API access for editorial agent |
| `NETLIFY_TOKEN` | monitor.mjs | Netlify Forms API for tip line ingestion |
| `GITHUB_TOKEN` | GitHub Actions | PR creation and auto-merge |

These are configured as GitHub Actions secrets (`ANTHROPIC_API_KEY`, `LAWPEEPS_MMIKE`) for the automated pipeline. The `GITHUB_TOKEN` is provided automatically by GitHub Actions.

### Running the editorial cycle manually

From the GitHub Actions tab, select "mm!ke editorial cycle" and click "Run workflow". Options:

- **Branch**: main (default)
- **Skip monitoring**: Checkbox to skip the RSS/tip line scan and use the most recent existing digest

You can also trigger it from the command line with the GitHub CLI:

```bash
gh workflow run mmike-editorial.yml
```

## Source monitoring

The monitor scans 12 RSS feeds configured in `agents/sources.json`:

| Source | Category | Priority |
|---|---|---|
| Artificial Lawyer | Legal AI news | High |
| Legal IT Insider | Legal tech news | High |
| Legal Futures | Legal business | High |
| SRA News | Regulatory | High |
| Law Society Gazette | Legal profession | Medium |
| Law Society Technology | Legal profession | Medium |
| Free Movement | Immigration law | Medium |
| TechCrunch AI | General AI | Low |
| The Register | General tech | Low |
| BAILII | Case law | Low |
| Hacker News (legal AI) | Community | Low |
| arXiv cs.CL | Research | Low |

Items are scored by keyword relevance (15 tracked terms) and checked against a watch list of 19 legal AI companies. The top 30 items by score are included in each digest, alongside any new tip line submissions.

## Tech stack

- **Framework**: Astro 5.7 (static site generation)
- **Hosting**: Netlify (automatic deploys from main)
- **CI/CD**: GitHub Actions
- **AI**: Claude (Anthropic API) via direct HTTP calls
- **Forms**: Netlify Forms (tip line)
- **Feed**: @astrojs/rss
- **SEO**: @astrojs/sitemap
- **Styling**: Custom CSS with CSS variables, dark mode, retro CRT effects

## Design

The visual identity is deliberately retro: chunky shadows, CRT scanlines, halftone dots, pixel grid overlays, and the Press Start 2P display font. The palette centres on hot pink (#FF69B4) and electric blue (#54A0FF) against near-black. Dark mode is supported via CSS custom properties and a toggle in the header.

## Operated by

lawpeeps.ai is a project of [Legalaid Ltd](https://legalaid.dev), operated by Chris Dias. mm!ke is the editor. The editorial operation is independent of any commercial interest.
