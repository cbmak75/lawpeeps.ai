/**
 * scout.mjs -- Scout orchestrator (v4)
 *
 * The scout does not use an LLM for discovery. It runs the ingestion
 * chain:
 *
 *   monitor (RSS fetch + deterministic score)
 *     -> prefilter (keyword + watchlist gate, no LLM)
 *     -> triage (ONE batched Gemini Flash-Lite call, skipped when
 *        nothing new survives the triage-once gate)
 *     -> queue (editor picks up next cycle)
 *
 * Previously the scout ran a single Sonnet + web_search call that
 * did discovery AND research AND scoring in one shot. That call
 * cost roughly 10-30 cents per run, burned the rate limit, and
 * returned hallucinated "stories" when feeds were quiet.
 *
 * The v4 flow is free (Gemini free tier), scales with the size of
 * the source list without scaling API usage, and skips the API
 * entirely on cycles with nothing new.
 *
 * Run: node agents/scout.mjs [--tier A|B]
 */

import { prune, stats } from './queue.mjs';
import { runMonitor } from './monitor.mjs';
import { runTriage } from './triage.mjs';

async function runScout({ tierFilter = null } = {}) {
  const t0 = Date.now();
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[scout] SCOUT RUN: ${new Date().toISOString()}${tierFilter ? ` (tier ${tierFilter})` : ''}`);
  console.log(`${'='.repeat(60)}\n`);

  prune();

  if (tierFilter) {
    process.env.MONITOR_TIER = tierFilter;
  }

  // Phase 1: ingestion (no API call)
  const digest = await runMonitor();
  console.log(`[scout] Monitor: ${digest.item_count} items from ${digest.sources_checked} feeds`);

  if (digest.item_count === 0) {
    console.log('[scout] No items from feeds this cycle. Nothing to triage.');
    const elapsed = Math.round((Date.now() - t0) / 1000);
    console.log(`[scout] Run complete in ${elapsed}s`);
    return { enqueued: 0, digest_count: 0 };
  }

  // Phase 2: triage (at most one batched Gemini call)
  const triage = await runTriage({ tierFilter });

  const queueStats = stats();
  const elapsed = Math.round((Date.now() - t0) / 1000);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`[scout] SCOUT COMPLETE (${elapsed}s)`);
  console.log(`[scout] Ingested: ${digest.item_count} | Enqueued: ${triage.enqueued}`);
  console.log(`[scout] Queue: ${queueStats.pending} pending, ${queueStats.published} published`);
  console.log(`${'='.repeat(60)}\n`);

  return {
    enqueued: triage.enqueued,
    digest_count: digest.item_count,
    picks: triage.picks
  };
}

export { runScout };

if (process.argv[1] && process.argv[1].endsWith('scout.mjs')) {
  const tierArg = process.argv.includes('--tier')
    ? process.argv[process.argv.indexOf('--tier') + 1]
    : null;
  runScout({ tierFilter: tierArg }).catch(err => {
    console.error('[scout] Fatal error:', err);
    process.exit(1);
  });
}
