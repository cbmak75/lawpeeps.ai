/**
 * queue.mjs -- Story Queue
 *
 * Simple file-based queue for stories. The scout agent deposits
 * researched story briefs here. mm!ke picks them up, curates,
 * writes, and stages them.
 *
 * Queue file: agents/memory/story-queue.json
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUEUE_PATH = join(__dirname, 'memory', 'story-queue.json');

function loadQueue() {
  if (!existsSync(QUEUE_PATH)) {
    return { stories: [], last_updated: null };
  }
  return JSON.parse(readFileSync(QUEUE_PATH, 'utf-8'));
}

function saveQueue(queue) {
  queue.last_updated = new Date().toISOString();
  writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2));
}

/**
 * Add a story to the queue. The scout deposits stories here.
 * Each story has a unique ID based on its slug.
 */
function enqueue(story) {
  const queue = loadQueue();

  // Deduplicate by slug
  const existing = queue.stories.find(s => s.slug === story.slug);
  if (existing) {
    console.log(`[queue] Story already queued: ${story.slug}`);
    return false;
  }

  queue.stories.push({
    ...story,
    queued_at: new Date().toISOString(),
    status: 'pending',       // pending | claimed | published | killed
    claimed_by: null,
    claimed_at: null
  });

  saveQueue(queue);
  console.log(`[queue] Enqueued: ${story.title} (${story.slug})`);
  return true;
}

/**
 * Claim the next pending story for mm!ke to write.
 * Returns the story or null if the queue is empty.
 */
function claimNext() {
  const queue = loadQueue();
  const pending = queue.stories.filter(s => s.status === 'pending');

  if (pending.length === 0) return null;

  // Sort by score (highest first), then by queued_at (oldest first)
  pending.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return new Date(a.queued_at) - new Date(b.queued_at);
  });

  const story = pending[0];
  story.status = 'claimed';
  story.claimed_by = 'mmike';
  story.claimed_at = new Date().toISOString();

  saveQueue(queue);
  console.log(`[queue] Claimed: ${story.title}`);
  return story;
}

/**
 * Mark a story as published after mm!ke stages it.
 */
function markPublished(slug) {
  const queue = loadQueue();
  const story = queue.stories.find(s => s.slug === slug);
  if (story) {
    story.status = 'published';
    story.published_at = new Date().toISOString();
    saveQueue(queue);
  }
}

/**
 * Mark a story as killed (mm!ke decided not to run it).
 */
function markKilled(slug, reason) {
  const queue = loadQueue();
  const story = queue.stories.find(s => s.slug === slug);
  if (story) {
    story.status = 'killed';
    story.killed_at = new Date().toISOString();
    story.kill_reason = reason;
    saveQueue(queue);
  }
}

/**
 * Get queue stats for logging.
 */
function stats() {
  const queue = loadQueue();
  const counts = { pending: 0, claimed: 0, published: 0, killed: 0 };
  for (const s of queue.stories) {
    counts[s.status] = (counts[s.status] || 0) + 1;
  }
  return { total: queue.stories.length, ...counts };
}

/**
 * Prune old stories (published/killed more than 7 days ago).
 */
function prune() {
  const queue = loadQueue();
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const before = queue.stories.length;
  queue.stories = queue.stories.filter(s => {
    if (s.status === 'published' && s.published_at < cutoff) return false;
    if (s.status === 'killed' && s.killed_at < cutoff) return false;
    return true;
  });

  if (queue.stories.length < before) {
    saveQueue(queue);
    console.log(`[queue] Pruned ${before - queue.stories.length} old stories`);
  }
}

export { enqueue, claimNext, markPublished, markKilled, stats, prune, loadQueue };
