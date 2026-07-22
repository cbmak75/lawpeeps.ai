# Agent pipeline architecture (v4)

Three layers, all LLM work on the Gemini API free tier (`GEMINI_API_KEY` from Google AI Studio). Nothing in the pipeline pays per token any more; the constraint is now requests per day, not spend. All calls go through the shared client in `llm.mjs`.

## Why v3 blew the budget (post-mortem)

Three leaks, all fixed in v4:

1. **Re-triage.** Nothing recorded which items had already been triaged. An RSS item sits in its feed for days, so at a 20-minute tier A cadence the same shortlist was re-sent to the API up to 72 times a day. Fixed by `memory/triaged-urls.json`: every item sent to triage is recorded and never sent again (14-day retention, capped at 2,000 entries). Most scout runs now make no API call at all.
2. **Prompt caching that never hit.** `cache_control: ephemeral` has a 5-minute TTL. Cycles ran 20 minutes to 8 hours apart, so every call paid the 25% cache-write surcharge and never got a cache read. All caching removed.
3. **Verifier web search on Sonnet.** Billed per search plus all result tokens as input, 5 to 8 searches per article. Replaced by a free deterministic fetch of the primary source URL (text passed into the prompt), with Gemini search grounding attached only for amber/red stories and capped at 3 searches.

## Layer 1 -- ingestion (no API spend)

`monitor.mjs` fetches every RSS feed in `sources.json`, parses items, dedupes by URL, scores by keyword and watch-list match, and writes `memory/latest-digest.json`. Supports a tier filter via the `MONITOR_TIER` env var. Unchanged from v3.

## Layer 2 -- triage (at most one Gemini Flash-Lite call per cycle)

`prefilter.mjs` applies a deterministic gate: items below `min_score_threshold` or without a watch-list hit are rejected without touching the API. Survivors are checked against `triaged-urls.json`; anything already judged is dropped. If the remaining shortlist is empty the cycle ends with zero API calls. Otherwise up to 20 items go to `triage.mjs`, which sends a single batched call to Gemini Flash-Lite (`GEMINI_MODEL_TRIAGE`) and gets JSON picks back. Top picks (score >= 6 and verdict=enqueue) are written to the story queue. Recent-coverage context is capped at 25 entries and item summaries at 200 chars.

## Layer 3 -- drafting and verification (Gemini Flash)

`editor.mjs` claims one story from the queue and drafts it with Gemini Flash (`GEMINI_MODEL_EDITOR`). `verifier.mjs` fetches the primary source URL in Node (free), passes up to 8,000 chars of its text to a single Gemini Flash call (`GEMINI_MODEL_VERIFIER`), and attaches Google Search grounding only when the triage brief estimated the story amber or red. Output ceilings: editor 4k, verifier 4k.

`rate-limit-helper.mjs`, `research.mjs` and `verify.mjs` were deleted in v4; retry logic lives in `llm.mjs`. The `revise`, `tip-scout` and `discover` agents were also ported to the shared Gemini client.

## What's no longer in the pipeline

The old `scout.mjs` ran a Sonnet + web search call that did discovery, research, and scoring in one shot. Replaced by monitor + triage.

The old `discover.mjs` ran a Sonnet + web search call to "find stories RSS missed". Replaced by Google News RSS query feeds inside `sources.json`, which are just feeds the monitor scans normally. The current `discover.mjs` is a deterministic standing-query maintainer (no API spend).

The old `research.mjs` ran a Sonnet + web search call on one candidate per cycle. Removed from the repo. The new pipeline skips this step: the editor drafts from the triage brief, and the verifier does claim-level fact-checking.

The old `verify.mjs` ran a two-call Sonnet + web search pipeline (claim extraction, then verification). Removed from the repo. Replaced by `verifier.mjs`, which combines extraction and verification into a single cached call.

## Cron schedule (v4)

- Hourly: `scout:a` -- tier A ingestion and triage (GitHub Actions: `mmike-scout-tier-a.yml`). The triage-once gate means most runs make no API call.
- Every 6 hours: `scout:b` -- tier B ingestion and triage (GitHub Actions: `mmike-scout.yml`)
- Once a day (08 UTC): `editorial` -- claim next story, draft, verify, stage PR (GitHub Actions: `mmike-editorial.yml`)
- Daily: `npm run discover` -- dry run of standing-query maintenance (run `discover:apply` once a week after reviewing the dry run)

Worst-case daily API usage: 24 triage calls + 1 draft + 1 verify = 26 requests, far inside the free tier's daily request allowance. Typical usage is much lower because triage skips cycles with nothing new.

## Configuring X / Twitter bridges

Seven tier-A sources in `sources.json` carry `feed_bridge_required: true`. They need an external service to convert a Twitter/X account into an RSS feed. Two options:

- **rss.app** -- paid, reliable. Create a Twitter-to-RSS feed per account, paste the resulting URL into the `feed` field of each bridge source.
- **nitter** -- free, self-hosted or public instance (public instances are often rate-limited or down). URL pattern is typically `https://nitter.example.org/<handle>/rss`.

Until bridges are configured, monitor will log "Skipping (bridge not configured)" for those sources.

## Cost envelope

Zero. The whole pipeline runs on the Gemini API free tier. The constraints that matter now:

- Requests per day and per minute on the free tier (check live limits for the key in Google AI Studio; they change).
- Free-tier prompts and responses may be used by Google to improve their products. Everything sent is public RSS content and editorial prompts, so this is acceptable. Do not route anything confidential through this pipeline.
- GitHub Actions minutes (the repo is public, so these are free too).

If a paid upgrade is ever wanted for drafting quality, the cheap options as at July 2026 are Gemini Flash-Lite (~$0.10/$0.40 per million tokens) or DeepSeek (~$0.14/$0.28); swapping models is a one-line env change per stage.

## Where to watch the numbers

- `memory/latest-digest.json` -- what monitor pulled
- `memory/latest-triage.json` -- what triage picked, including token usage
- `memory/triaged-urls.json` -- what has already been triaged (the re-triage guard)
- `memory/story-queue.json` -- what's in the editor's queue
- `memory/editorial-log.json` -- what the editor published

If the free-tier daily request limit is ever hit, check `latest-triage.json` first: `skipped_already_triaged` should be non-zero on most cycles. If it is always zero, the triage-once gate is not persisting (check that the scout workflow commits `agents/memory/` back to main).
