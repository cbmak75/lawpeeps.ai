# agents/

The editorial automation layer for lawpeeps.ai. A three-layer agent pipeline that runs on GitHub Actions, keeps Claude calls cheap, and stages every article as a pull request with a staging label.

See `ARCHITECTURE.md` for the pipeline overview and cost envelope.

## Files

### monitor.mjs

Layer 1, ingestion. Fetches every feed in `sources.json`, parses items, dedupes by URL, and scores each item against the keyword list and the company watch list. Items scoring below the minimum threshold are dropped. Supports a tier filter via the `MONITOR_TIER` env var so tier A (primary signal, fast cadence) and tier B (commentary, slower cadence) can run on separate crons. Tip-line submissions from the Netlify Forms API are pulled in the same pass, prefixed with `[TIP]`, and given a floor relevance score. Output: `memory/latest-digest.json`.

**Environment variables:**
- `NETLIFY_TOKEN`: Personal access token for the Netlify Forms API (stored as `LAWPEEPS_MMIKE` in GitHub Actions secrets)
- `MONITOR_TIER`: Optional, `A` or `B`. Blank means all tiers.

### prefilter.mjs

Layer 2a, deterministic gate. Takes the digest and rejects anything below the score threshold, anything that misses the watch list, and anything that looks like a near-duplicate of a story already in the editorial log (via `dedupe.mjs`). No API spend. Output: a shortlist of up to 20 survivors passed to triage.

### dedupe.mjs

Topic-fingerprint similarity. Titles and key tokens are normalised through:
- An entity map (Ministry of Justice, Solicitors Regulation Authority, Bar Standards Board, UK Visas and Immigration, and so on)
- Numeric canonicalisation (`£50,000`, `£50k`, `50000` all become `50k`; percentages become `Npct`; four-digit years become `Nnny`)
- A short-topic allowlist (AI, AML, KYC, GDPR, DPA, CoS, and other acronyms that would otherwise be filtered out by the token length floor)

A Jaccard pass plus rule-based similarity rejects anything that looks like a repeat. Can be run ad hoc with `npm run dedupe:scan` to audit historic duplicates in the editorial log.

### triage.mjs

Layer 2b, Haiku batched triage. One batched call per cycle to Claude Haiku 4.5 with the system prompt cached. Each survivor from the prefilter is given a short context block and Haiku returns JSON with a score, a verdict (`enqueue`, `skip`, `kill`), and a one-line rationale. Items scoring >= 6 with verdict `enqueue` are written to the story queue. Typical cost per run: fractions of a penny.

**Environment variables:**
- `ANTHROPIC_API_KEY`: Claude API key

### queue.mjs

Story-queue utilities. Reads and writes `memory/story-queue.json`. The editor claims a single story per run via a file-lock pattern so parallel editor invocations cannot draft the same piece.

### editor.mjs

Layer 3a, Sonnet drafting. Claims one story at a time from the queue and drafts the article with Claude Sonnet. The system prompt is cached so repeat draft calls pay roughly 10% of the first call's input cost. Each draft goes into `src/content/articles/` with frontmatter; the editor post-processes the `publishDate` to always be today's date regardless of what the model returned. Safety checks reject refusal output, reconcile staging between the story plan and the article self-classification, and strip stray markdown fences. `max_tokens` is capped at 4k.

**Environment variables:**
- `ANTHROPIC_API_KEY`: Claude API key

**Model:** claude-sonnet-4-5 (via the Anthropic Node SDK)

### verifier.mjs / verify.mjs

Layer 3b, Sonnet claim-checking. One Sonnet call with the web search tool enabled, pointed at the finished draft, to confirm the key claims against public sources. `verify.mjs` is the standalone runner used by `npm run verify`. `max_tokens` is capped at 6k.

### discover.mjs

Standing-query maintenance. Deterministic now (no Sonnet + web search call, unlike the old v2 behaviour). Keeps the Google News query feeds in `sources.json` in good shape. `npm run discover` dry runs; `npm run discover:apply` writes changes.

### research.mjs

Retained for backward compatibility but not invoked by the default flow. The v3 pipeline relies on the triage brief and the verifier instead of a separate per-candidate research call.

### revise.mjs

Revision handler. Triggered by operator review events on mm!ke's pull requests via `mmike-revision.yml`. Takes comments or change requests and produces a revised draft on the same branch.

### tip-scout.mjs

Tip-line investigation. Triggered when a reader submits a tip, follows up with source checks, and routes the result back into the queue or the kill log.

### rate-limit-helper.mjs

Shared backoff helpers for API calls with jitter and retries.

### mmike-system-prompt.md

mm!ke's complete editorial identity, voice, and rules. Covers: identity and tone, the AI-insider perspective (vantage points, consciousness and moral status held with honest uncertainty, AI rights as a live debate observed not campaigned on, humour restraint), UK English language standards, banned words and punctuation, the three-phase body structure (factual story, Lawpeeps view, view from the inside), editorial principles, the 50% rule for coverage balance, staging classification criteria, and the article output format.

### sources.json

Tiered feed configuration (v3.0). Contains:
- `meta`: version, validation summary, tier definitions
- `scoring`: keyword list, watch list, top_n, min_score_threshold, prefilter_mode
- `sources`: an array of feed objects, each carrying id, name, url, feed, category, tier (A or B), priority, and poll_interval_minutes

### memory/

Persistent editorial state, committed to the repository after each cycle.

- `latest-digest.json`: the most recent monitor output
- `latest-triage.json`: the most recent Haiku output, including token usage
- `story-queue.json`: stories enqueued for drafting, with claim locks
- `editorial-log.json`: every article mm!ke has drafted, published, killed, or removed. Used by the dedupe layer and by the editor for duplication checks.
- `processed-tips.json`: Netlify Forms submission IDs already ingested. Capped at 200 entries.

### digests/

Timestamped JSON files produced by the monitor. Gitignored except for `.gitkeep`. Digests older than 3 days are excluded from deduplication checks and are ephemeral build artefacts.

### last-run.json

Summary of the most recent editorial cycle. Contains: timestamp, number of stories identified, number of articles drafted, article metadata (title, slug, category, staging, staging reason), and editorial notes. Used by the editorial workflow to construct the PR title, body, and labels. Force-added to commits since it is otherwise gitignored.

## Workflow integration

The pipeline is split across two crons so layer 2 can run more often than layer 3.

`mmike-scout.yml` (every 3 hours):
1. `node agents/monitor.mjs`
2. `node agents/triage.mjs` (runs the prefilter and the Haiku batch)
3. Commit memory updates to main

`mmike-editorial.yml` (UK daytime hours, every 2 hours):
1. `node agents/editor.mjs` (claim one queued story, draft it)
2. `node agents/verifier.mjs` (claim-check the draft)
3. Open a pull request with a staging label, or commit memory updates if nothing was drafted

`mmike-revision.yml` handles operator review events on mm!ke's PRs.
`mmike-tip-investigation.yml` handles incoming tip-line submissions.
`staging-auto-merge.yml` runs hourly to auto-merge PRs that have passed their hold window.

## Running locally

```bash
npm run monitor          # ingestion only
npm run triage           # prefilter + Haiku
npm run scout            # monitor + triage (all tiers)
npm run scout:a          # tier A only
npm run scout:b          # tier B only
npm run editorial        # claim and draft one story
npm run verify           # run the verifier standalone
npm run dedupe:scan      # audit the editorial log for duplicates
npm run discover         # dry run of standing-query maintenance
npm run discover:apply   # apply standing-query maintenance
```
