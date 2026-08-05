'use strict';

/**
 * In-memory rate limiting and sliding-window counters.
 *
 * Used by command cooldowns, the interaction throttle, every AutoMod module and
 * the anti-nuke/anti-raid detectors. Deliberately memory-bounded: entries are
 * swept on a timer so a long-running process never grows unbounded from
 * one-off offenders.
 */

/**
 * Sliding-window event counter.
 *
 * `hit(key)` records an event and returns how many events that key has produced
 * inside the window — the primitive every burst detector in this codebase uses.
 */
class SlidingWindow {
  /**
   * @param {number} windowMs window size in milliseconds
   * @param {{ max?: number }} [options] max distinct keys retained
   */
  constructor(windowMs, { max = 10_000 } = {}) {
    this.windowMs = windowMs;
    this.max = max;
    /** @type {Map<string, number[]>} */
    this.events = new Map();
  }

  /**
   * Record an event and return the current count within the window.
   * @param {string} key
   * @param {number} [weight] record the event `weight` times
   * @returns {number}
   */
  hit(key, weight = 1) {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    let stamps = this.events.get(key);
    if (!stamps) {
      stamps = [];
      this.events.set(key, stamps);
      if (this.events.size > this.max) this.prune(true);
    }
    // Drop expired entries from the front (timestamps are naturally ordered).
    let index = 0;
    while (index < stamps.length && stamps[index] <= cutoff) index += 1;
    if (index) stamps.splice(0, index);
    for (let i = 0; i < weight; i += 1) stamps.push(now);
    return stamps.length;
  }

  /** Current count without recording a new event. */
  count(key) {
    const stamps = this.events.get(key);
    if (!stamps) return 0;
    const cutoff = Date.now() - this.windowMs;
    return stamps.filter((stamp) => stamp > cutoff).length;
  }

  /** Forget a key entirely (e.g. after punishing the offender). */
  reset(key) {
    this.events.delete(key);
  }

  /**
   * Remove expired keys.
   * @param {boolean} [aggressive] also trim the oldest keys when over capacity
   */
  prune(aggressive = false) {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, stamps] of this.events) {
      const live = stamps.filter((stamp) => stamp > cutoff);
      if (live.length === 0) this.events.delete(key);
      else if (live.length !== stamps.length) this.events.set(key, live);
    }
    if (aggressive && this.events.size > this.max) {
      const excess = this.events.size - this.max;
      let removed = 0;
      for (const key of this.events.keys()) {
        this.events.delete(key);
        if (++removed >= excess) break;
      }
    }
  }

  get size() {
    return this.events.size;
  }
}

/**
 * Cooldown registry keyed by `scope:user`.
 */
class CooldownManager {
  constructor() {
    /** @type {Map<string, number>} expiry timestamps */
    this.entries = new Map();
  }

  /**
   * @param {string} scope command or component name
   * @param {string} userId
   * @param {number} seconds
   * @returns {number} milliseconds remaining (0 when not limited)
   */
  check(scope, userId, seconds) {
    if (!seconds || seconds <= 0) return 0;
    const key = `${scope}:${userId}`;
    const expiresAt = this.entries.get(key);
    const now = Date.now();
    if (expiresAt && expiresAt > now) return expiresAt - now;
    this.entries.set(key, now + seconds * 1000);
    return 0;
  }

  /** Clear a user's cooldown (used when a command fails before doing work). */
  clear(scope, userId) {
    this.entries.delete(`${scope}:${userId}`);
  }

  /** Drop every expired entry. */
  prune() {
    const now = Date.now();
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt <= now) this.entries.delete(key);
    }
  }

  get size() {
    return this.entries.size;
  }
}

/**
 * Simple token bucket used to throttle abusive interaction spam before it ever
 * reaches a handler.
 */
class TokenBucket {
  /**
   * @param {number} capacity maximum burst
   * @param {number} refillPerMinute tokens restored each minute
   */
  constructor(capacity, refillPerMinute) {
    this.capacity = capacity;
    this.refillRate = refillPerMinute / 60_000;
    /** @type {Map<string, { tokens: number, updatedAt: number }>} */
    this.buckets = new Map();
  }

  /**
   * Attempt to consume a token.
   * @param {string} key
   * @returns {boolean} true when allowed
   */
  consume(key) {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.capacity, updatedAt: now };
      this.buckets.set(key, bucket);
    }
    bucket.tokens = Math.min(this.capacity, bucket.tokens + (now - bucket.updatedAt) * this.refillRate);
    bucket.updatedAt = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /** Drop buckets that have fully refilled — they carry no state worth keeping. */
  prune() {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      const refilled = bucket.tokens + (now - bucket.updatedAt) * this.refillRate;
      if (refilled >= this.capacity) this.buckets.delete(key);
    }
  }

  get size() {
    return this.buckets.size;
  }
}

/**
 * Registry that sweeps every limiter on a shared interval so subsystems do not
 * each schedule their own timer.
 */
class LimiterRegistry {
  constructor(intervalMs = 60_000) {
    /** @type {Set<{prune: () => void}>} */
    this.limiters = new Set();
    this.timer = setInterval(() => this.sweep(), intervalMs);
    this.timer.unref?.();
  }

  /** @template T @param {T} limiter @returns {T} */
  register(limiter) {
    this.limiters.add(limiter);
    return limiter;
  }

  sweep() {
    for (const limiter of this.limiters) {
      try {
        limiter.prune();
      } catch {
        /* a failing sweep must never take the process down */
      }
    }
  }

  stop() {
    clearInterval(this.timer);
    this.limiters.clear();
  }
}

const registry = new LimiterRegistry();

module.exports = { SlidingWindow, CooldownManager, TokenBucket, LimiterRegistry, registry };
