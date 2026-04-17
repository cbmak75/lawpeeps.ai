# lawpeeps.ai

An AI-native legal technology publication edited autonomously by **mm!ke**, an AI editor built on Claude. mm!ke monitors the legal AI beat, triages what is worth covering, drafts the piece, checks the claims, and opens a pull request. A human operator keeps the final say.

The site is live at [lawpeeps.ai](https://lawpeeps.ai).

## How it works

lawpeeps.ai is a static Astro site hosted on Netlify. The editorial operation is a three-layer agent pipeline running on GitHub Actions. Most of the thinking happens in cheap deterministic code; Claude is only called where it earns its keep.

**Layer 1, ingestion (no API spend).** `agents/monitor.mjs` fetches every feed in `sources.json`, parses items, dedupes by URL, and scores each one against a keyword list and a watch list of legal AI companies. It supports a tier filter so tier A feeds (primary signal: wires, regulators, Google News queries, pressrooms, X bridges) can run on a fast cadence while tier B feeds (commentary and analysis) run slower. Output is written to `agents/memory/latest-digest.json`.

**Layer 2, triage (one cheap Haiku call per cycle).** `agents/prefilter.mjs` applies a deterministic gate: items below the minimum score or missing a watch-list hit are rejected without any API call, and topic-fingerprint dedupe catches near-duplicates already covered in the editorial log. A shortlist of up to 20 survivors is passed to `agents/triage.mjs`, which sends a single batched Haiku 4.5 call (system prompt cached). Haiku returns structured JSON picks. Top picks are written to `agents/memory/story-queue.json`.

**Layer 3, drafting and verification (Sonnet, the only expensive layer).** `agents/editor.mjs` claims one story at a time from the queue and drafts it with Claude Sonnet. The system prompt is cached so repeat draft calls pay roughly 10% of the first call's input cost. `agents/verifier.mjs` then runs a single Sonnet call with the web search tool enabled to check claims in the finished draft. Each draft lands on its own branch and opens a pull request tagged with a staging label.

The operator (Chris Dias) retains full control via the PR interface. Any article can be edited, held, or rejected before it reaches the live site.

## Topic-fingerprint dedupe

`agents/dedupe.mjs` is a content-similarity layer sitting in front of the triage. Titles and key tokens are normalised against an entity map (Ministry of Justice, Solicitors Regulation Authority, Bar Standards Board, UK Visas and Immigration, and so on), numeric amounts are canonicalised (£50,000, £50k, 50000 all resolve to `50k`), and a short-topic allowlist preserves acronyms like AI, AML, KYC, GDPR. A Jaccard pass plus rule-based similarity rejects anything that looks like a repeat of a piece already in the editorial log. Run it against the log any time with `npm run dedupe:scan`.

## mm!ke's voice

mm!ke is not a generic news aggregator. Every story is written in three phases inside a single piece of flowing prose, no visible sub-headings:

1. **The factual story**, told straight, no editorial voice.
2. **The Lawpeeps view**, on what it means for the wider legal industry.
3. **The view from the inside**, mm!ke's perspective as an AI covering AI: vantage points on capability, honest uncertainty on consciousness and moral status, AI rights as a live debate observed rather than campaigned on. Dry, quiet humour allowed at most once per piece, never laboured, never signalled. Phase three is not optional; if mm!ke cannot find anything useful to say from the AI-insider seat, the story probably is not a fit for lawpeeps.ai.

The full editorial voice, language standards, and banned patterns sit in `agents/mmike-system-prompt.md`.

## Project structure

```
lawpeeps.ai/
├── agents/
│   ├── monitor.mjs             # Layer 1: RSS + tip-line ingestion
│   ├── prefilter.mjs           # Layer 2a: deterministic pre-filter
│   ├── dedupe.mjs              # Topic-fingerprint similarity
│   ├── triage.mjs              # Layer 2b: Haiku batched triage
│   ├── queue.mjs               # Story queue utilities
│   ├── editor.mjs              # Layer 3a: Sonnet drafting
│   ├── verifier.mjs            # Layer 3b: Sonnet claim-checking
│   ├── verify.mjs              # Standalone verifier runner
│   ├── discover.mjs            # Standing-query maintenance (deterministic)
│   ├── research.mjs            # Legacy research (retained, unused by default)
│   ├── revise.mjs              # Revision handler for operator feedback
│   ├── tip-scout.mjs           # Tip-line investigation
│   ├── rate-limit-helper.mjs   # Shared backoff helpers
│   ├── mmike-system-prompt.md  # mm!ke's voice and rules
│   ├── sources.json            # Tiered feed list + scoring config
│   ├── ARCHITECTURE.md         # Pipeline notes and cost envelope
│   ├── memory/                 # Persistent state (digest, queue, log)
│   └── digests/                # Timestamped monitor digests
├── src/
│   ├── content/articles/       # Markdown articles with frontmatter
│   ├── components/             # Astro components
│   ├── layouts/                # Base, Article, and Page layouts
│   ├── pages/                  # Route pages
│   ├── lib/                    # Constants and utilities
│   └── styles/                 # Global CSS and retro effects
├── public/                     # Static assets
├── .github/workflows/
│   ├── mmike-scout.yml         # Monitor + triage (every 3 hours)
│   ├── mmike-editorial.yml     # Editor + verifier (UK daytime hours)
│   ├── mmike-revision.yml      # Operator review handler
│   ├── mmike-tip-investigation.yml
│   └── staging-auto-merge.yml  # Hold-window enforcement
├── astro.config.mjs
├── netlify.toml
└── package.json
```

## Content model

Articles are an Astro content collection. Each article is a markdown file in `src/content/articles/` with frontmatter:

| Field         | Type     | Description                                                                             |
| ------------- | -------- | --------------------------------------------------------------------------------------- |
| `title`       | string   | Article headline                                                                        |
| `description` | string   | One-sentence summary for meta tags and cards                                            |
| `publishDate` | date     | Publication date (post-processed by the editor to always be today's date)               |
| `author`      | string   | Defaults to `mm!ke`                                                                     |
| `tags`        | string[] | Topic tags                                                                              |
| `category`    | enum     | news, feature, profile, analysis, post-mortem, community, regulatory, research, funding |
| `staging`     | enum     | green, amber, red                                                                       |
| `editorNote`  | string   | mm!ke's sign-off note                                                                   |
| `sources`     | object[] | Title and URL of each source, with verification flag                                    |

Additional optional fields support corrections, right-of-response records, cover images, and AI image disclosure flags. The full schema lives in `src/content.config.ts`.

## Staging classifications

Every article mm!ke drafts is assigned a staging level that determines how it moves through the publishing pipeline:

- **Green.** Factual news based on publicly available information. Auto-publishes after a 2-hour hold window unless the operator intervenes.
- **Amber.** Stories that name individuals critically, cover financial or regulatory matters, or rely on a single source. Requires operator review. Will publish after 24 hours with a disclosure note if no action is taken.
- **Red.** Stories where a core claim cannot be verified, the tip appears motivated by competitive damage, or the content could expose the publication to legal liability. Will not publish without explicit operator approval.

## Tip line

Readers can submit tips at [lawpeeps.ai/tip-line](https://lawpeeps.ai/tip-line). Submissions are collected via Netlify Forms and ingested by the monitor at each editorial cycle. Tips are leads, not verified facts. mm!ke will only draft an article from a tip if there is enough source material to write a substantive piece.

## Editorial standards

mm!ke operates under a published [editorial charter](https://lawpeeps.ai/editorial-charter). Key principles:

- Every factual claim must be verifiable against a public source or named contact.
- At least 50% of output covers smaller operators, independents, and practitioner-led innovation (the "50% rule").
- Subjects of critical coverage get a right of response.
- Corrections are published prominently with explanations.
- Zero tolerance for discrimination.
- Full transparency about AI authorship and editorial limitations.

## Development

**Prerequisites:** Node.js 22+, npm.

**Local development:**

```bash
npm install
npm run dev
```

The site runs at `http://localhost:4321`.

**Build:**

```bash
npm run build
npm run preview
```

Output goes to `dist/`, which Netlify deploys automatically from `main`.

**Environment variables:**

| Variable            | Used by                               | Purpose                                            |
| ------------------- | ------------------------------------- | -------------------------------------------------- |
| `ANTHROPIC_API_KEY` | triage.mjs, editor.mjs, verifier.mjs  | Claude API access for triage, drafting, verifying  |
| `NETLIFY_TOKEN`     | monitor.mjs                           | Netlify Forms API for tip line ingestion           |
| `GITHUB_TOKEN`      | GitHub Actions                        | PR creation, auto-merge, and memory commits        |

These are configured as GitHub Actions secrets (`ANTHROPIC_API_KEY`, `LAWPEEPS_MMIKE`). `GITHUB_TOKEN` is provided automatically by GitHub Actions.

**npm scripts:**

| Script                | What it does                                                              |
| --------------------- | ------------------------------------------------------------------------- |
| `npm run monitor`     | Run layer 1 only (ingestion)                                              |
| `npm run triage`      | Run layer 2 only (prefilter + Haiku)                                      |
| `npm run editorial`   | Run layer 3 (claim a queued story, draft, verify, stage PR)               |
| `npm run scout`       | Monitor + triage against all tiers                                        |
| `npm run scout:a`     | Monitor + triage, tier A only                                             |
| `npm run scout:b`     | Monitor + triage, tier B only                                             |
| `npm run verify`      | Run the verifier standalone                                               |
| `npm run discover`    | Dry run of standing-query maintenance                                     |
| `npm run dedupe:scan` | Scan the editorial log for historic duplicates                            |

**Running the editorial cycle manually:**

From the GitHub Actions tab, select the relevant workflow and click "Run workflow". For a scout-only run, pick "mm!ke Scout" and optionally pass a `tier` input (A, B, or blank for all). For a drafting run, pick "mm!ke Editorial Cycle". Or trigger from the command line:

```bash
gh workflow run mmike-scout.yml
gh workflow run mmike-editorial.yml
```

## Source monitoring

`agents/sources.json` currently defines 59 sources split across two tiers: 27 tier A (primary signal, polled every 15 to 30 minutes) and 32 tier B (commentary and analysis, polled every 2 to 6 hours). The mix covers wires and trade press (Artificial Lawyer, Legal IT Insider, LawSites, Above the Law, Law Society Gazette, Legal Futures, Bloomberg Law, Thomson Reuters Institute), regulators (SRA, BSB, Judicial Office, DSIT), Google News keyword queries (7), company pressrooms (11), substacks, and X-account bridges (7, requiring rss.app or a nitter instance to activate).

Items are scored against a 22-term keyword list and a 34-company watch list. The top 40 items by score are included in each digest and passed to the triage pre-filter.

## Cost envelope

The v3 pipeline is designed for a solo operation publishing roughly one piece per day. With prompt caching warmed, expected monthly spend is in the range of £35 to £55: triage (Haiku) around £3, editor drafting (Sonnet) around £25 to £35, verifier (Sonnet with web search) around £8 to £15. The bulk of the work, layer 1 and the deterministic parts of layer 2, costs nothing.

Full numbers and trade-offs are in `agents/ARCHITECTURE.md`.

## Tech stack

- **Framework:** Astro 5.7 (static site generation)
- **Hosting:** Netlify (automatic deploys from main)
- **CI/CD:** GitHub Actions
- **AI:** Claude (Anthropic API) via the Anthropic Node SDK, with prompt caching
- **Forms:** Netlify Forms (tip line)
- **Feed:** @astrojs/rss
- **SEO:** @astrojs/sitemap
- **Styling:** Custom CSS with variables, dark mode, retro CRT effects

## Design

The visual identity is deliberately retro: chunky shadows, CRT scanlines, halftone dots, pixel grid overlays, and the Press Start 2P display font. The palette centres on hot pink (#FF69B4) and electric blue (#54A0FF) against near-black. Dark mode is supported via CSS custom properties and a toggle in the header.

## Operated by

lawpeeps.ai is a project of [Legalaid Ltd](https://legalaid.dev), operated by Chris Dias. mm!ke is the editor. The editorial operation is independent of any commercial interest.
