import { getPublisher } from './publishers/index.js';
import { config } from './config.js';

// Publishes due posts. A post is claimed by moving it from "scheduled" to
// "publishing" in one UPDATE, so a post is never sent twice.
export function createScheduler(db, svc) {
  let timer = null;
  let running = false;

  function claim(id) {
    const r = db
      .prepare("UPDATE posts SET status = 'publishing', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'scheduled'")
      .run(new Date().toISOString(), id);
    return r.changes === 1;
  }

  async function publishOne(id) {
    if (!claim(id)) return svc.getPost(id);
    const post = svc.getPost(id);
    const channel = svc.getChannel(post.channel_id, true);
    const publisher = getPublisher(channel.network);
    const at = new Date().toISOString();
    try {
      if (!channel.active) throw Object.assign(new Error('Channel is paused'), { retryable: false });
      const result = await publisher.publish(channel.credentials, post, channel);
      db.prepare(
        "UPDATE posts SET status = 'published', published_at = ?, remote_id = ?, remote_url = ?, last_error = NULL, updated_at = ? WHERE id = ?"
      ).run(at, result?.id || null, result?.url || null, at, id);
      svc.log(id, 'info', `Published to ${channel.name}${result?.url ? ` (${result.url})` : ''}`);
    } catch (err) {
      const retry = err.retryable !== false && post.attempts < config.maxAttempts;
      if (retry) {
        // Back off 2, 4, 8… minutes.
        const next = new Date(Date.now() + 2 ** post.attempts * 60_000).toISOString();
        db.prepare("UPDATE posts SET status = 'scheduled', scheduled_at = ?, last_error = ?, updated_at = ? WHERE id = ?").run(next, err.message, at, id);
        svc.log(id, 'warn', `Attempt ${post.attempts} failed, retrying at ${next}: ${err.message}`);
      } else {
        db.prepare("UPDATE posts SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?").run(err.message, at, id);
        svc.log(id, 'error', `Failed: ${err.message}`);
      }
    }
    return svc.getPost(id);
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const due = db
        .prepare("SELECT id FROM posts WHERE status = 'scheduled' AND scheduled_at <= ? ORDER BY scheduled_at LIMIT 50")
        .all(new Date().toISOString());
      for (const { id } of due) await publishOne(id);
    } catch (err) {
      console.error('Scheduler error:', err);
    } finally {
      running = false;
    }
  }

  // Posts left in "publishing" by a crash may or may not have gone out.
  // Mark them failed so a person checks, rather than risk a duplicate post.
  function recover() {
    const stuck = db.prepare("SELECT id FROM posts WHERE status = 'publishing'").all();
    for (const { id } of stuck) {
      db.prepare("UPDATE posts SET status = 'failed', last_error = ? WHERE id = ?").run(
        'Dispatch stopped while this post was being published. Check the network to see whether it went out, then retry or delete it.',
        id
      );
      svc.log(id, 'error', 'Interrupted while publishing');
    }
  }

  return {
    publishOne,
    tick,
    start() {
      recover();
      timer = setInterval(tick, config.schedulerIntervalMs);
      tick();
    },
    stop() {
      clearInterval(timer);
    },
  };
}
