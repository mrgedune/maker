/**
 * Browser- and Node-safe diagnostics collector.  It owns no DOM and performs
 * no logging by itself, so games can display, upload, or ignore its snapshots.
 */
export class EngineDiagnostics {
  constructor(options = {}) {
    const {
      now = defaultNow,
      sampleSize = 120,
      maxWarnings = 50
    } = options;

    if (typeof now !== 'function') throw new TypeError('now must be a function.');
    if (!Number.isInteger(sampleSize) || sampleSize < 1) {
      throw new RangeError('sampleSize must be a positive integer.');
    }
    if (!Number.isInteger(maxWarnings) || maxWarnings < 1) {
      throw new RangeError('maxWarnings must be a positive integer.');
    }

    this.now = now;
    this.sampleSize = sampleSize;
    this.maxWarnings = maxWarnings;
    this._frameStartedAt = null;
    this._frameTimes = [];
    this._lastFrameDurationMs = null;
    this._frameCount = 0;
    this._counters = new Map();
    this._gauges = new Map();
    this._warnings = [];
  }

  /** Mark the beginning of a frame and return the resolved timestamp. */
  beginFrame(timestamp = this.now()) {
    this._frameStartedAt = finiteTimestamp(timestamp, 'timestamp');
    return this._frameStartedAt;
  }

  /**
   * Mark the end of the current frame.  Returns the duration in milliseconds.
   */
  endFrame(timestamp = this.now()) {
    const endedAt = finiteTimestamp(timestamp, 'timestamp');
    if (this._frameStartedAt === null) {
      throw new Error('beginFrame must be called before endFrame.');
    }

    const duration = Math.max(0, endedAt - this._frameStartedAt);
    this._frameStartedAt = null;
    this._lastFrameDurationMs = duration;
    this._frameCount += 1;
    this._frameTimes.push(duration);
    if (this._frameTimes.length > this.sampleSize) this._frameTimes.shift();
    return duration;
  }

  /** Add an amount to a named monotonically increasing counter. */
  increment(name, amount = 1) {
    assertName(name);
    if (!Number.isFinite(amount)) throw new TypeError('amount must be a finite number.');
    const value = (this._counters.get(name) ?? 0) + amount;
    this._counters.set(name, value);
    return value;
  }

  record(name, amount = 1) {
    return this.increment(name, amount);
  }

  /** Set an instantaneous measurement such as draw calls or active lights. */
  setGauge(name, value) {
    assertName(name);
    if (!Number.isFinite(value)) throw new TypeError('gauge value must be a finite number.');
    this._gauges.set(name, value);
    return value;
  }

  /** Keep a bounded structured warning history for UI or telemetry consumers. */
  warn(code, message, details = undefined) {
    assertName(code, 'code');
    if (typeof message !== 'string' || message.length === 0) {
      throw new TypeError('warning message must be a non-empty string.');
    }

    const warning = Object.freeze({
      code,
      message,
      details: cloneDetails(details),
      timestamp: finiteTimestamp(this.now(), 'now()')
    });
    this._warnings.push(warning);
    if (this._warnings.length > this.maxWarnings) this._warnings.shift();
    return warning;
  }

  clearWarnings() {
    this._warnings.length = 0;
  }

  reset(options = {}) {
    const { counters = true, gauges = false, frameTiming = false, warnings = false } = options;
    if (counters) this._counters.clear();
    if (gauges) this._gauges.clear();
    if (frameTiming) {
      this._frameStartedAt = null;
      this._frameTimes.length = 0;
      this._lastFrameDurationMs = null;
      this._frameCount = 0;
    }
    if (warnings) this.clearWarnings();
  }

  /** Return a stable, serializable snapshot without clearing accumulated data. */
  snapshot() {
    const frameSamples = this._frameTimes.length;
    const averageFrameMs = frameSamples === 0
      ? null
      : this._frameTimes.reduce((sum, value) => sum + value, 0) / frameSamples;
    const maxFrameMs = frameSamples === 0 ? null : Math.max(...this._frameTimes);
    const minFrameMs = frameSamples === 0 ? null : Math.min(...this._frameTimes);

    return Object.freeze({
      frame: Object.freeze({
        count: this._frameCount,
        inProgress: this._frameStartedAt !== null,
        lastFrameMs: this._lastFrameDurationMs,
        averageFrameMs,
        minFrameMs,
        maxFrameMs,
        fps: averageFrameMs && averageFrameMs > 0 ? 1000 / averageFrameMs : null,
        sampleSize: frameSamples
      }),
      counters: Object.freeze(Object.fromEntries(this._counters)),
      gauges: Object.freeze(Object.fromEntries(this._gauges)),
      warnings: Object.freeze([...this._warnings])
    });
  }
}

function defaultNow() {
  const performanceApi = globalThis.performance;
  return performanceApi && typeof performanceApi.now === 'function'
    ? performanceApi.now()
    : Date.now();
}

function finiteTimestamp(value, name) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must return a finite number.`);
  return value;
}

function assertName(name, label = 'name') {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
}

function cloneDetails(value) {
  if (value === undefined || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Object.freeze([...value]);
  return Object.freeze({ ...value });
}
