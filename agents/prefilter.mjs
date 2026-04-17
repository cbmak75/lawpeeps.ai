/**
 * prefilter.mjs -- Deterministic keyword prefilter
 *
 * No LLM calls. Scores an item (title + summary) against the keyword
 * list and watch-list companies in sources.json, applies a recency
 * bonus, and classifies each item as accept, borderline, or reject.
 *
 * Purpose: keep 95% of raw items out of Claude's context. Only items
 * that clear the accept threshold reach the Haiku triage stage. Items
 * in the borderline band can optionally be sent for triage if budget
 * allows; reject items are dropped.
 *
 * Used by monitor.mjs (at ingestion) and triage.mjs (as a safety net).
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { fingerprint, findDuplicate, loadPriorFingerprints } from './dedupe.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCES_PATH = join(__dirname, 'sources.json');

const DEDUPE_THRESHOLD = 0.5;

let cachedConfig = null;
function loadConfig() {
  if (cachedConfig) return cachedConfig;
  if (!existsSync(SOURCES_PATH)) {
    throw new Error(`sources.json not found at ${SOURCES_PATH}`);
  }
  cachedConfig = JSON.parse(readFileSync(SOURCES_PATH, 'utf-8'));
  return cachedConfig;
}

/**
 * Score a single item using keywords, watch-list companies, recency,
 * and source tier/priority. Returns { score, matched, reasons }.
 *
 * Scoring:
 *   +2 per keyword match
 *   +3 per watch-list company match
 *   +4 if item younger than 6 hours, +2 under 12 hours, +1 under 24 hours
 *   +2 if source tier is A
 *   +2 if source priority is critical, +1 if high
 *
 * Title matches count double (core concepts usually appear in the title).
 */
export function scoreItem(item, config = loadConfig()) {
  const title = (item.title || '').toLowerCase();
  const summary = (item.summary || '').toLowerCase();
  const haystack = `${title} ${summary}`;

  let score = 0;
  const matched = { keywords: [], companies: [] };
  const reasons = [];

  for (const kw of config.scoring.keywords) {
    const needle = kw.toLowerCase();
    if (title.includes(needle)) {
      score += 4;
      matched.keywords.push(kw);
    } else if (summary.includes(needle)) {
      score += 2;
      matched.keywords.push(kw);
    }
  }

  for (const company of config.scoring.watch_list_companies) {
    const needle = company.toLowerCase();
    if (title.includes(needle)) {
      score += 6;
      matched.companies.push(company);
    } else if (summary.includes(needle)) {
      score += 3;
      matched.companies.push(company);
    }
  }

  if (item.published) {
    const age = Date.now() - new Date(item.published).getTime();
    const hours = age / (1000 * 60 * 60);
    if (hours < 6) {
      score += 4;
      reasons.push('recent:<6h');
    } else if (hours < 12) {
      score += 2;
      reasons.push('recent:<12h');
    } else if (hours < 24) {
      score += 1;
      reasons.push('recent:<24h');
    } else if (hours > 72) {
      score -= 2;
      reasons.push('stale:>72h');
    }
  }

  if (item.source_tier === 'A') {
    score += 2;
    reasons.push('tier:A');
  }

  if (item.source_priority === 'critical') {
    score += 2;
    reasons.push('priority:critical');
  } else if (item.source_priority === 'high') {
    score += 1;
    reasons.push('priority:high');
  }

  if (item.is_tip) {
    score += 5;
    reasons.push('tip-line');
  }

  return { score, matched, reasons };
}

/**
 * Classify a scored item against thresholds.
 *   reject:    below min_score_threshold, no watch-list match, or
 *              fingerprint-matches a recently-published or queued story
 *   borderline: at or just above threshold, sent for triage only if budget allows
 *   accept:    clearly relevant, always sent for triage
 *
 * If priorFingerprints is supplied, any item whose fingerprint overlaps
 * a prior above DEDUPE_THRESHOLD is rejected with decision_reason set
 * to 'duplicate' and duplicate_of populated.
 */
export function classify(item, config = loadConfig(), priorFingerprints = null) {
  const { score, matched, reasons } = scoreItem(item, config);
  const threshold = config.scoring.min_score_threshold ?? 4;

  const fp = fingerprint(item, config);

  let duplicateOf = null;
  if (priorFingerprints && priorFingerprints.length > 0) {
    duplicateOf = findDuplicate(fp, priorFingerprints, DEDUPE_THRESHOLD);
  }

  // A topic match is required for anything to leave the prefilter.
  // Recency, tier, and priority are bonuses that lift the ceiling,
  // not the floor. Without at least one keyword or watch-list hit
  // we drop the item -- this is what stops unrelated breaking news
  // from reaching Haiku just because it is fresh.
  const hasTopicMatch = matched.keywords.length > 0 || matched.companies.length > 0;

  let decision;
  let decision_reason = null;
  if (duplicateOf) {
    decision = 'reject';
    decision_reason = 'duplicate';
    reasons.push(`duplicate_of:${duplicateOf.slug || duplicateOf.id} (sim=${duplicateOf.similarity.toFixed(2)})`);
  } else if (!hasTopicMatch && !item.is_tip) {
    decision = 'reject';
    decision_reason = 'no_topic_match';
  } else if (score >= threshold + 4 || matched.companies.length > 0) {
    decision = 'accept';
  } else if (score >= threshold) {
    decision = 'borderline';
  } else {
    decision = 'reject';
    decision_reason = 'below_threshold';
  }

  return { score, matched, reasons, decision, decision_reason, fingerprint: fp, duplicate_of: duplicateOf };
}

/**
 * Apply prefilter to an array of items. Returns an object with
 * accepted, borderline, rejected groups and summary stats.
 *
 * Prior fingerprints are loaded once up front (editorial log + queue)
 * so every candidate is checked against the same frozen set. Pass
 * { skipDedupe: true } to disable the dedupe check (e.g. for unit
 * tests or when running against a known-clean set).
 */
export function applyPrefilter(items, config = loadConfig(), opts = {}) {
  const out = { accept: [], borderline: [], reject: [] };
  const priorFingerprints = opts.skipDedupe ? [] : loadPriorFingerprints();

  let dupeRejects = 0;

  for (const item of items) {
    const result = classify(item, config, priorFingerprints);
    const enriched = { ...item, prefilter: result };
    out[result.decision].push(enriched);
    if (result.decision_reason === 'duplicate') dupeRejects++;
  }

  out.accept.sort((a, b) => b.prefilter.score - a.prefilter.score);
  out.borderline.sort((a, b) => b.prefilter.score - a.prefilter.score);

  return {
    accept: out.accept,
    borderline: out.borderline,
    reject: out.reject,
    stats: {
      total: items.length,
      accepted: out.accept.length,
      borderline: out.borderline.length,
      rejected: out.reject.length,
      rejected_as_duplicate: dupeRejects,
      accept_rate: items.length > 0
        ? Math.round((out.accept.length / items.length) * 100)
        : 0
    }
  };
}

/**
 * Build a shortlist for LLM triage. Takes accepted items and optionally
 * the top N borderline items. Caps at maxItems so the Haiku prompt stays
 * small. Defaults tuned for a single Haiku batched call of ~20 items.
 */
export function buildTriageShortlist(prefilterResult, { maxItems = 20, includeBorderline = true } = {}) {
  const shortlist = [...prefilterResult.accept];
  if (includeBorderline && shortlist.length < maxItems) {
    const slots = maxItems - shortlist.length;
    shortlist.push(...prefilterResult.borderline.slice(0, slots));
  }
  return shortlist.slice(0, maxItems);
}

export default { scoreItem, classify, applyPrefilter, buildTriageShortlist };
