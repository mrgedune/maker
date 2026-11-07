/**
 * StartupTrace.js - Attributes the main-thread stalls a session takes while it
 * is starting up, and prints them once.
 *
 * Every session used to freeze five or six times inside its first half-minute,
 * the longest for 1.1-1.3s, and then run clean for the rest of the run - mean
 * frame time 6.1ms, no gap over 40ms after t=45s. That shape was measured
 * before anything here existed, from `SessionRecorder`'s paint counter, and it
 * cost a day to establish that the recorder was innocent. What the paint
 * counter could not say was *which work* was blocking the thread, and a
 * profiler session that has to be re-attached by hand cannot answer that for a
 * bug that only exists in the first thirty seconds of a cold launch.
 *
 * So this brackets the suspects instead. Three things get recorded:
 *
 * - **Gaps** between render-loop frames, with the time on the clock and how
 *   much of the gap the game's own tick accounts for. A 1200ms gap containing a
 *   6ms tick is not the game simulating slowly; it is something else on the
 *   thread, and that distinction is the whole diagnosis. It is the same
 *   distinction `AutoplayRunCapture.checkForStall` draws between a slow loop
 *   and a stopped one, drawn one frame at a time.
 * - **Spans** around named work, opened and closed by the code that owns it.
 * - **Long tasks**, from `PerformanceObserver`, which catch blocking that
 *   happens before the first frame is ever scheduled.
 *
 * The report prints once and names, for each gap, the spans that were open
 * across it. Anything left unattributed is the next thing to bracket.
 *
 * It stays in the shipped build because it costs one `performance.now()` per
 * frame until it reports and nothing at all afterwards, and because a startup
 * that starts stalling again should say so in the log rather than wait to be
 * noticed in a recording.
 */

/** A frame gap worth naming. Matches the recorder's stall threshold, so the two
 *  logs count the same events. */
const GAP_MS = 100;

/** How much of a session counts as "starting up". The measured freezes are all
 *  inside 30s; the extra covers the quiet stretch that proves they stopped. */
const REPORT_AFTER_MS = 35000;

/** Long tasks below this are ordinary frames, not stalls. */
const LONG_TASK_MS = 100;

/** Hard cap on retained records, so a pathological launch cannot grow this
 *  without bound before the report fires. */
const MAX_RECORDS = 400;

/**
 * Shortest span worth keeping.
 *
 * Spans are meant to be placed on the render path as well as the startup path,
 * and a per-frame bracket at 150fps fills any bounded list in seconds. Dropping
 * the ordinary ones keeps the interesting one - the first frame of a floor,
 * which is three orders of magnitude slower than the rest - rather than losing
 * it behind five thousand healthy siblings.
 */
const MIN_SPAN_MS = 20;

export class StartupTrace {
  constructor() {
    this.origin = performance.now();
    this.gaps = [];
    this.spans = [];
    this.longTasks = [];
    this.open = new Map();
    this.lastFrameAt = 0;
    this.frames = 0;
    this.reported = false;
    this.observer = null;
    this.startObserver();
    // A capture run that dies at twenty seconds tears the page down before the
    // window closes, and the measurement it was launched to take would go with
    // it. The first attempt at this reported on a timer alone and lost three
    // runs that way.
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => this.report(), { once: true });
    }
  }

  /** Seconds since the module was first imported, which is close enough to page
   *  start to read timestamps against a launch log. */
  at(now = performance.now()) {
    return (now - this.origin) / 1000;
  }

  startObserver() {
    if (typeof PerformanceObserver !== 'function') return;
    try {
      this.observer = new PerformanceObserver(list => {
        if (this.reported) return;
        for (const entry of list.getEntries()) {
          if (entry.duration < LONG_TASK_MS) continue;
          if (this.longTasks.length >= MAX_RECORDS) return;
          this.longTasks.push({ at: this.at(entry.startTime), ms: entry.duration });
        }
      });
      this.observer.observe({ entryTypes: ['longtask'] });
    } catch (_error) {
      // Not every host exposes long tasks. The frame gaps are the primary
      // measurement and do not depend on this.
      this.observer = null;
    }
  }

  /** Opens a named span. Returns a token to close it with, so overlapping and
   *  repeated spans of the same name cannot close each other. */
  begin(label) {
    if (this.reported) return null;
    const token = { label, start: performance.now() };
    this.open.set(token, true);
    return token;
  }

  end(token) {
    if (!token || !this.open.has(token)) return;
    this.open.delete(token);
    if (this.spans.length >= MAX_RECORDS) return;
    const end = performance.now();
    if (end - token.start < MIN_SPAN_MS) return;
    this.spans.push({
      label: token.label,
      at: this.at(token.start),
      ms: end - token.start,
      start: token.start,
      end
    });
  }

  /** Brackets synchronous work and returns its result. */
  span(label, fn) {
    const token = this.begin(label);
    try {
      return fn();
    } finally {
      this.end(token);
    }
  }

  /**
   * Brackets awaited work.
   *
   * The number this produces is wall time, not thread time: an await that spends
   * its length off-thread reads exactly like one that blocks. That is why the
   * report cross-references spans against frame gaps instead of trusting a span
   * length on its own - a long span with no gap inside it is work that was
   * already asynchronous and is not the bug.
   */
  async spanAsync(label, fn) {
    const token = this.begin(label);
    try {
      return await fn();
    } finally {
      this.end(token);
    }
  }

  /**
   * Called once per render-loop frame.
   *
   * @param {number} now the frame's timestamp, in the same clock as `performance.now()`
   * @param {number} tickMs how long the game's own tick took on the previous frame
   */
  frame(now, tickMs = 0) {
    if (this.reported) return;
    this.frames += 1;
    const previous = this.lastFrameAt;
    this.lastFrameAt = now;
    if (previous) {
      const gap = now - previous;
      if (gap >= GAP_MS && this.gaps.length < MAX_RECORDS) {
        this.gaps.push({ at: this.at(previous), ms: gap, tickMs, start: previous, end: now });
      }
    }
    if (now - this.origin >= REPORT_AFTER_MS) this.report();
  }

  /** Spans that were open across a gap, innermost first. */
  blamedFor(gap) {
    return this.spans
      .filter(span => span.start <= gap.end && span.end >= gap.start)
      .sort((a, b) => a.ms - b.ms)
      .map(span => `${span.label} ${span.ms.toFixed(0)}ms`);
  }

  report() {
    if (this.reported) return;
    this.reported = true;
    if (this.observer) {
      try {
        this.observer.disconnect();
      } catch (_error) {
        // Already gone; nothing to release.
      }
    }
    const seconds = (performance.now() - this.origin) / 1000;
    const worst = this.gaps.reduce((max, gap) => Math.max(max, gap.ms), 0);
    console.log(`[StartupTrace] ${seconds.toFixed(0)}s, ${this.frames} frames,`
      + ` ${this.gaps.length} gaps over ${GAP_MS}ms (worst ${worst.toFixed(0)}ms)`);
    for (const gap of this.gaps) {
      const blame = this.blamedFor(gap);
      console.log(`[StartupTrace]   +${gap.at.toFixed(2)}s ${gap.ms.toFixed(0)}ms`
        + ` (tick ${gap.tickMs.toFixed(1)}ms)`
        + ` ${blame.length ? blame.join(' < ') : 'unattributed'}`);
    }
    const slowest = [...this.spans].sort((a, b) => b.ms - a.ms).slice(0, 12);
    for (const span of slowest) {
      console.log(`[StartupTrace]   span +${span.at.toFixed(2)}s ${span.ms.toFixed(0)}ms ${span.label}`);
    }
    for (const task of this.longTasks) {
      console.log(`[StartupTrace]   longtask +${task.at.toFixed(2)}s ${task.ms.toFixed(0)}ms`);
    }
    this.spans = [];
    this.gaps = [];
    this.longTasks = [];
    this.open.clear();
  }
}

/** One trace per session. Imported by whoever has work worth bracketing. */
export const startupTrace = new StartupTrace();

export default startupTrace;
