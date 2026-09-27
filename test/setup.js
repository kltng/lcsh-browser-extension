/**
 * Test fakes (SPEC-P3 §8.1): chrome.storage.local (with onChanged),
 * chrome.permissions, navigator.locks (one in-memory exclusive lock manager
 * shared by all fake pages), and LanguageModel. Installed fresh before each test.
 */
import { beforeEach, vi } from 'vitest';

const clone = (v) => (v === undefined ? undefined : structuredClone(v));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Captured before any test can install fake timers: events are delivered on a
// real macrotask, like Chrome, and never wait for vi.advanceTimersByTime().
const realSetTimeout = globalThis.setTimeout;

/** Let other pending async work run (makes races between fake pages real). */
export const yieldTicks = async (n = 3) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

/**
 * Wait until events scheduled by the fakes (storage.onChanged, permission events) are delivered.
 * @returns {Promise<void>}
 */
export const flushEvents = () => new Promise((resolve) => realSetTimeout(() => realSetTimeout(resolve, 0), 0));

/**
 * Support Chrome's callback form: `api(args, cb)` calls cb(result) and sets
 * chrome.runtime.lastError while the callback runs when the call failed.
 */
const withCallback = (fn) => (arg, cb) => {
  const promise = fn(arg);
  if (typeof cb !== 'function') return promise;
  promise.then(
    (result) => cb(result),
    (err) => {
      chrome.runtime.lastError = { message: err?.message || 'storage error' };
      try {
        cb(undefined);
      } finally {
        chrome.runtime.lastError = null;
      }
    }
  );
  return undefined;
};

/**
 * Fake chrome.storage.local + onChanged, with failure injection. Like Chrome,
 * onChanged events arrive ASYNCHRONOUSLY, after the write has completed.
 * @returns {object}
 */
export const createFakeStorage = () => {
  const data = new Map();
  const listeners = new Set();
  const failures = { get: [], set: [], remove: [] };
  const calls = { set: [], remove: [] };
  const fire = (changes) => {
    if (Object.keys(changes).length === 0) return;
    const snapshot = clone(changes);
    realSetTimeout(() => {
      for (const listener of [...listeners]) listener(clone(snapshot), 'local');
    }, 0);
  };
  const maybeFail = (op) => {
    const err = failures[op].shift();
    if (err) throw err;
  };
  const local = {
    async get(keys) {
      await yieldTicks();
      maybeFail('get');
      const out = {};
      if (keys === null || keys === undefined) {
        for (const [k, v] of data) out[k] = clone(v);
        return out;
      }
      const list = typeof keys === 'string' ? [keys] : (Array.isArray(keys) ? keys : Object.keys(keys));
      for (const k of list) {
        if (data.has(k)) out[k] = clone(data.get(k));
        else if (!Array.isArray(keys) && typeof keys === 'object') out[k] = keys[k];
      }
      return out;
    },
    async set(items) {
      await yieldTicks();
      maybeFail('set');
      calls.set.push(clone(items));
      const changes = {};
      for (const [k, v] of Object.entries(items)) {
        const old = data.get(k);
        if (!same(old, v)) changes[k] = { oldValue: clone(old), newValue: clone(v) };
        data.set(k, clone(v));
      }
      fire(changes);
    },
    async remove(keys) {
      await yieldTicks();
      maybeFail('remove');
      const list = typeof keys === 'string' ? [keys] : keys;
      calls.remove.push([...list]);
      const changes = {};
      for (const k of list) {
        if (data.has(k)) changes[k] = { oldValue: clone(data.get(k)) };
        data.delete(k);
      }
      fire(changes);
    },
    async clear() {
      data.clear();
    }
  };
  local.get = withCallback(local.get);
  local.set = withCallback(local.set);
  local.remove = withCallback(local.remove);
  return {
    local,
    onChanged: {
      addListener: (l) => listeners.add(l),
      removeListener: (l) => listeners.delete(l),
      hasListener: (l) => listeners.has(l)
    },
    data,
    calls,
    listeners,
    failNext: (op, err) => failures[op].push(err),
    seed: (obj) => {
      for (const [k, v] of Object.entries(obj)) data.set(k, clone(v));
    },
    dump: () => Object.fromEntries([...data].map(([k, v]) => [k, clone(v)]))
  };
};

/**
 * Fake Web Locks: exclusive, FIFO per name, shared by every fake page.
 * @returns {object}
 */
export const createFakeLocks = () => {
  const queues = new Map();
  const log = [];
  const stats = { maxConcurrent: 0, current: 0 };
  const request = (name, optsOrCb, maybeCb) => {
    const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
    if (!queues.has(name)) queues.set(name, { held: false, waiting: [] });
    const q = queues.get(name);
    return new Promise((resolve, reject) => {
      const run = async () => {
        q.held = true;
        stats.current += 1;
        stats.maxConcurrent = Math.max(stats.maxConcurrent, stats.current);
        log.push(`acquire:${name}`);
        try {
          resolve(await cb({ name, mode: 'exclusive' }));
        } catch (err) {
          reject(err);
        } finally {
          log.push(`release:${name}`);
          stats.current -= 1;
          q.held = false;
          const next = q.waiting.shift();
          if (next) next();
        }
      };
      if (q.held) q.waiting.push(run);
      else run();
    });
  };
  return {
    request: vi.fn(request),
    log,
    stats,
    isHeld: (name) => Boolean(queues.get(name)?.held),
    waiting: (name) => queues.get(name)?.waiting.length || 0
  };
};

/**
 * Fake chrome.permissions.
 * @returns {object}
 */
export const createFakePermissions = () => {
  const granted = new Set();
  const state = { nextRequestResult: true };
  const makeEvent = () => {
    const listeners = new Set();
    return {
      addListener: (l) => listeners.add(l),
      removeListener: (l) => listeners.delete(l),
      hasListener: (l) => listeners.has(l),
      listeners,
      // Delivered asynchronously, like Chrome.
      emit: (payload) => realSetTimeout(() => [...listeners].forEach((l) => l(payload)), 0)
    };
  };
  const onAdded = makeEvent();
  const onRemoved = makeEvent();
  return {
    granted,
    state,
    onAdded,
    onRemoved,
    contains: vi.fn(async ({ origins }) => origins.every((o) => granted.has(o))),
    request: vi.fn(({ origins }) => Promise.resolve().then(() => {
      if (state.nextRequestResult) {
        origins.forEach((o) => granted.add(o));
        onAdded.emit({ origins: [...origins], permissions: [] });
      }
      return state.nextRequestResult;
    })),
    /** A revocation (for example in chrome://extensions): removes and fires onRemoved. */
    remove: vi.fn(async ({ origins }) => {
      origins.forEach((o) => granted.delete(o));
      onRemoved.emit({ origins: [...origins], permissions: [] });
      return true;
    })
  };
};

const abortError = () => new DOMException('The operation was aborted.', 'AbortError');

/**
 * Fake LanguageModel (Prompt API). `config` fields can be changed during a test.
 * @param {object} [overrides] - Initial configuration
 * @returns {{LanguageModel:object, config:object, sessions:object[]}}
 */
export const createFakeLanguageModel = (overrides = {}) => {
  const config = {
    availability: { text: 'available', image: 'available' },
    family: 'context', // 'context' (contextUsage/…) or 'input' (inputUsage/…)
    used: 100,
    window: 6000,
    need: 500,
    promptResult: 'OK',
    promptError: null,
    measureError: null,
    createError: null,
    createGate: null,
    measureGate: null,
    honorCreateSignal: true,
    ...overrides
  };
  const sessions = [];
  const makeSession = (opts) => {
    const session = {
      createOptions: opts,
      destroy: vi.fn(),
      prompt: vi.fn(async (input, o) => {
        if (config.promptError) throw config.promptError;
        return config.promptResult;
      })
    };
    const measure = vi.fn(async (input, o) => {
      if (config.measureGate) await config.measureGate;
      if (o?.signal?.aborted) throw abortError();
      if (config.measureError) throw config.measureError;
      return config.need;
    });
    if (config.family === 'context') {
      session.contextUsage = config.used;
      session.contextWindow = config.window;
      session.measureContextUsage = measure;
    } else {
      session.inputUsage = config.used;
      session.inputQuota = config.window;
      session.measureInputUsage = measure;
    }
    sessions.push(session);
    return session;
  };
  const LanguageModel = {
    availability: vi.fn(async (opts) => (
      opts.expectedInputs.some((i) => i.type === 'image') ? config.availability.image : config.availability.text
    )),
    create: vi.fn(async (opts) => {
      if (typeof opts.monitor === 'function') {
        const monitor = new EventTarget();
        opts.monitor(monitor);
        const progress = new Event('downloadprogress');
        progress.loaded = 0.5;
        monitor.dispatchEvent(progress);
      }
      if (config.createGate) await config.createGate;
      if (config.honorCreateSignal && opts.signal?.aborted) throw abortError();
      if (config.createError) throw config.createError;
      return makeSession(opts);
    }),
    params: vi.fn(async () => ({}))
  };
  return { LanguageModel, config, sessions, makeSession };
};

/**
 * A fetch Response stand-in, with a body stream whose `cancel` is a spy.
 * @param {any} body - Object (sent as JSON) or string
 * @param {{status?:number, headers?:object}} [opts] - Status and headers
 * @returns {object}
 */
export const response = (body, { status = 200, headers = {} } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(headers),
  body: { cancel: vi.fn(async () => {}) },
  text: vi.fn(async () => (typeof body === 'string' ? body : JSON.stringify(body)))
});

/** The fakes of the current test (one shared object, even if this module is loaded twice). */
export const fakes = globalThis.__lcshTestFakes || (globalThis.__lcshTestFakes = {});

/**
 * A promise with its resolve function, for gating fake async work.
 * @returns {{promise:Promise<void>, open:()=>void}}
 */
export const gate = () => {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
};

/** Install a fake LanguageModel global for this test. */
export const installLanguageModel = (overrides) => {
  const fake = createFakeLanguageModel(overrides);
  globalThis.LanguageModel = fake.LanguageModel;
  fakes.nano = fake;
  return fake;
};

beforeEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  const storage = createFakeStorage();
  const permissions = createFakePermissions();
  const locks = createFakeLocks();
  const contexts = [];
  fakes.storage = storage;
  fakes.permissions = permissions;
  fakes.locks = locks;
  fakes.contexts = contexts;
  fakes.nano = null;
  globalThis.chrome = {
    storage: { local: storage.local, onChanged: storage.onChanged },
    permissions,
    runtime: {
      lastError: null,
      getURL: (path) => `chrome-extension://testid/${path}`,
      getContexts: vi.fn(async () => contexts)
    },
    tabs: { create: vi.fn(async (o) => ({ id: 99, ...o })), update: vi.fn(async () => ({})) },
    windows: { update: vi.fn(async () => ({})) }
  };
  Object.defineProperty(globalThis.navigator, 'locks', { value: locks, configurable: true, writable: true });
  delete globalThis.LanguageModel;
  globalThis.fetch = vi.fn(async () => {
    throw new Error('Unexpected network call in a test');
  });
});
