# Agent pipeline architecture (v3)

Three layers. Only the last one pays for Claude.

## Layer 1 -- ingestion (no API spend)

`monitor.mjs` fetches every RSS feed in `sources.json`, parses items, dedupes by URL, scores by keyword and watch-list match, and writes `memory/latest-digest.json`. Supports a tier filter via the `MONITOR_TIER` env var so tier A feeds (primary signal, polled every 15 to 30 minutes) and tier B feeds (commentary, polled every 2 to 6 hours) can run on separate cron schedules.

## Layer 2 -- triage (one cheap Haiku call per cycle)

`prefilter.mjs` applies a deterministic gate: items below `min_score_threshold` or without a watch-list hit are rejected without touching the API. A shortlist of up to 20 is passed to `triage.mjs`, which sends a single batched call to Haiku 4.5 with the stable system prompt cached. Haiku returns JSON picks. Top picks (score >= 6 and verdict=enqueue) are written to the story queue. Typical cost per run: fractions of a penny.

## Layer 3 -- drafting and verification (Sonnet, the only expensive layer)

`editor.mjs` claims one story at a time from the queue and drafts it with Sonnet. The system prompt is cached so repeat draft calls pay roughly 10% of the first call's input cost. `verifier.mjs` then runs a single Sonnet call with the web search tool enabled to check claims in the finished draft. Both use `max_tokens` ceilings sized for the actual output (editor 4k, verifier 6k) rather than the 16k / 10k wasted ceilings in v2.

## What's no longer in the pipeline

The old `scout.mjs` ran a Sonnet + web search call that did discovery, research, and scoring in one shot. Replaced by monitor + triage.

The old `discover.mjs` ran a Sonnet + web search call to "find stories RSS missed". Replaced by Google News RSS query feeds inside `sources.json`, which are just feeds the monitor scans normally. The current `discover.mjs` is a deterministic standing-query maintainer (no API spend).

The old `research.mjs` ran a Sonnet + web search call on one candidate per cycle. The new pipeline skips this step: the editor drafts from the triage brief, and the verifier does claim-level fact-checking. `research.mjs` is retained but no longer invoked by the default flow.

## Cron schedule

Suggested, for a solo pipeline aiming at one published piece per day:

- Every 20 minutes: `npm run scout:a` -- tier A ingestion and triage
- Every 3 hours: `npm run scout:b` -- tier B ingestion and triage
- Every 1 hour: `npm run editorial` -- claim next story, draft, verify, stage PR
- Daily: `npm run discover` -- dry run of standing-query maintenance (run `discover:apply` once a week after reviewing the dry run)

## Configuring X / Twitter bridges

Seven tier-A sources in `sources.json` carry `feed_bridge_required: true`. They need an external service to convert a Twitter/X account into an RSS feed. Two options:

- **rss.app** -- paid, reliable. Create a Twitter-to-RSS feed per account, paste the resulting URL into the `feed` field of each bridge source.
- **nitter** -- free, self-hosted or public instance (public instances are often rate-limited or down). URL pattern is typically `https://nitter.example.org/<handle>/rss`.

Until bridges are configured, monitor will log "Skipping (bridge not configured)" for those sources.

## Cost envelope

Estimated monthly spend with a daily publish cadence and prompt caching warmed:

- Triage: Haiku, roughly 3 pounds a month at every-20-minute cadence
- Editor draft: Sonnet, roughly 25 to 35 pounds a month at one piece per day
- Verifier: Sonnet with web search, roughly 8 to 15 pounds a month at one verification per published piece

Total envelope in the 35 to 55 pound range per month. Well below the old pipeline's likely spend once it started running at cadence.

## Where to watch the numbers

- `memory/latest-digest.json` -- what monitor pulled
- `memory/latest-triage.json` -- what Haiku picked, including token usage
- `memory/story-queue.json` -- what's in the editor's queue
- `memory/editorial-log.json` -- what the editor published

If spend looks off, check the `usage` block in `latest-triage.json` first (it is the only stage that scales with source count).
