import { describe, it, expect, vi, afterEach } from 'vitest';
import { createScheduler, createRunCache, LookupError, getPageScheduler } from '../scheduler';
import { response } from '../../../../test/setup';

const ok = () => response({ hits: [] });
const kindOf = (promise) => promise.then(() => 'ok', (err) => err.kind);
const startsOf = (s) => s.stats.starts.map((x) => [x.url, x.at]);

afterEach(() => {
  vi.useRealTimers();
});

describe('[P4 row8] scheduler: concurrency and spacing', () => {
  it('at most 2 in flight and at least 500 ms between request starts', async () => {
    vi.useFakeTimers({ now: 0 });
    const fetchImpl = vi.fn(() => new Promise((resolve) => setTimeout(() => resolve(ok()), 800)));
    const s = createScheduler({ fetchImpl });
    const all = Promise.all([1, 2, 3, 4, 5].map((i) => s.request(`u${i}`)));
    await vi.advanceTimersByTimeAsync(10000);
    await all;
    const times = s.stats.starts.map((x) => x.at);
    expect(times).toEqual([0, 500, 1000, 1500, 2000]);
    expect(s.stats.maxConcurrent).toBe(2);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(500);
  });

  it('a slow pair blocks a third start until one finishes', async () => {
    vi.useFakeTimers({ now: 0 });
    const fetchImpl = vi.fn(() => new Promise((resolve) => setTimeout(() => resolve(ok()), 3000)));
    const s = createScheduler({ fetchImpl });
    const all = Promise.all(['a', 'b', 'c'].map((u) => s.request(u)));
    await vi.advanceTimersByTimeAsync(10000);
    await all;
    expect(startsOf(s)).toEqual([['a', 0], ['b', 500], ['c', 3000]]);
  });

  it('each request: credentials omit, JSON accept, the User-Agent, a signal', async () => {
    const fetchImpl = vi.fn(async () => ok());
    await createScheduler({ fetchImpl }).request('https://id.loc.gov/x');
    const init = fetchImpl.mock.calls[0][1];
    expect(init).toMatchObject({ method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
    expect(init.headers.Accept).toBe('application/json');
    expect(init.headers['User-Agent']).toMatch(/^LCSH-Browser-Extension\//);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('one scheduler per page', () => {
    expect(getPageScheduler()).toBe(getPageScheduler());
  });
});

describe('[P4 row8] scheduler: 429/503 and Retry-After', () => {
  const answering = (plan) => {
    const counts = {};
    return vi.fn(async (url) => {
      counts[url] = (counts[url] || 0) + 1;
      const step = plan[url]?.[counts[url] - 1];
      return step ? step() : ok();
    });
  };
  const limited = (status, retryAfter) => () => response({}, { status, headers: retryAfter === undefined ? {} : { 'Retry-After': retryAfter } });

  it('shared cooldown: a 429 pauses the WHOLE queue, then the request is retried', async () => {
    vi.useFakeTimers({ now: 0 });
    const s = createScheduler({ fetchImpl: answering({ a: [limited(429, '3')] }) });
    const all = Promise.all([s.request('a'), s.request('b')]);
    await vi.advanceTimersByTimeAsync(10000);
    await all;
    expect(startsOf(s)).toEqual([['a', 0], ['a', 3000], ['b', 3500]]);
  });

  it('overlapping cooldowns: cooldownUntil = max(current, new)', async () => {
    vi.useFakeTimers({ now: 0 });
    const fetchImpl = answering({ a: [limited(429, '5')], b: [limited(503, '2')] });
    const s = createScheduler({ fetchImpl, spacingMs: 0 });
    const all = Promise.all([s.request('a'), s.request('b')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.cooldownUntil()).toBe(5000);
    await vi.advanceTimersByTimeAsync(10000);
    await all;
    const starts = startsOf(s);
    expect(starts.slice(0, 2)).toEqual([['a', 0], ['b', 0]]);
    expect(starts.slice(2).sort()).toEqual([['a', 5000], ['b', 5000]]);
  });

  const NOW = Date.UTC(2026, 8, 27, 12, 0, 0);
  it.each([
    ['seconds', '2', 2000],
    ['a past HTTP date', new Date(NOW - 60000).toUTCString(), 500],
    ['an invalid value', 'soon', 4000],
    ['a missing header', undefined, 4000],
    ['a future HTTP date', new Date(NOW + 10000).toUTCString(), 10000],
    ['exactly 20 s', '20', 20000]
  ])('Retry-After as %s → retry after the right wait', async (_, header, retryAfterMs) => {
    vi.useFakeTimers({ now: NOW });
    const s = createScheduler({ fetchImpl: answering({ a: [limited(429, header)] }) });
    const kind = kindOf(s.request('a'));
    await vi.advanceTimersByTimeAsync(30000);
    expect(await kind).toBe('ok');
    expect(startsOf(s)).toEqual([['a', NOW], ['a', NOW + retryAfterMs]]);
  });

  it('Retry-After > 20 s → rate_limit at once, no retry', async () => {
    vi.useFakeTimers({ now: 0 });
    const fetchImpl = answering({ a: [limited(429, '21')] });
    const s = createScheduler({ fetchImpl });
    const kind = kindOf(s.request('a'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(await kind).toBe('rate_limit');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('at most 2 retries per request: 429 → rate_limit, 503 → server', async () => {
    vi.useFakeTimers({ now: 0 });
    const always = (status) => [limited(status, '1'), limited(status, '1'), limited(status, '1'), limited(status, '1')];
    const fetchImpl = answering({ a: always(429), b: always(503) });
    const s = createScheduler({ fetchImpl });
    const kinds = Promise.all([kindOf(s.request('a')), kindOf(s.request('b'))]);
    await vi.advanceTimersByTimeAsync(30000);
    expect(await kinds).toEqual(['rate_limit', 'server']);
    expect(fetchImpl.mock.calls.filter(([u]) => u === 'a')).toHaveLength(3);
  });

  it('fix-1 #5: the third 429 (retries exhausted) with Retry-After 20 still pauses the queue for unrelated work', async () => {
    vi.useFakeTimers({ now: 0 });
    const fetchImpl = answering({ a: [limited(429, '1'), limited(429, '1'), limited(429, '20')] });
    const s = createScheduler({ fetchImpl });
    const kinds = Promise.all([kindOf(s.request('a')), kindOf(s.request('b'))]);
    await vi.advanceTimersByTimeAsync(60000);
    expect(await kinds).toEqual(['rate_limit', 'ok']);
    expect(startsOf(s)).toEqual([['a', 0], ['a', 1000], ['a', 2000], ['b', 22000]]);
  });

  it('fix-1 #5: exhausted-retry cooldowns overlap with max()', async () => {
    vi.useFakeTimers({ now: 0 });
    const fetchImpl = answering({ x: [limited(429, '10')], y: [limited(503, '3')] });
    const s = createScheduler({ fetchImpl, spacingMs: 0, maxRetries: 0 });
    const kinds = Promise.all(['x', 'y', 'z'].map((u) => kindOf(s.request(u))));
    await vi.advanceTimersByTimeAsync(0);
    expect(s.cooldownUntil()).toBe(10000);
    await vi.advanceTimersByTimeAsync(20000);
    expect(await kinds).toEqual(['rate_limit', 'server', 'ok']);
    expect(startsOf(s)).toEqual([['x', 0], ['y', 0], ['z', 10000]]);
  });

  it('fix-1 #5: a Retry-After over 20 s fails without pausing the queue', async () => {
    vi.useFakeTimers({ now: 0 });
    const s = createScheduler({ fetchImpl: answering({ a: [limited(429, '60')] }) });
    const kinds = Promise.all([kindOf(s.request('a')), kindOf(s.request('b'))]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await kinds).toEqual(['rate_limit', 'ok']);
    expect(s.cooldownUntil()).toBe(0);
    expect(startsOf(s)).toEqual([['a', 0], ['b', 500]]);
  });

  it('other statuses and network errors are not retried', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (url === 'net') throw new TypeError('Failed to fetch');
      return response({}, { status: url === 'e500' ? 500 : 404 });
    });
    const s = createScheduler({ fetchImpl, spacingMs: 0 });
    expect(await Promise.all(['e500', 'e404', 'net'].map((u) => kindOf(s.request(u))))).toEqual(['server', 'server', 'network']);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe('[P4 row8] scheduler: timeout and cancel', () => {
  it('15 s timeout covering the headers', async () => {
    vi.useFakeTimers({ now: 0 });
    const s = createScheduler({ fetchImpl: vi.fn(() => new Promise(() => {})) });
    const kind = kindOf(s.request('a'));
    await vi.advanceTimersByTimeAsync(14999);
    await vi.advanceTimersByTimeAsync(1);
    expect(await kind).toBe('timeout');
  });

  it('15 s timeout covering the body', async () => {
    vi.useFakeTimers({ now: 0 });
    const stalled = { ...ok(), text: vi.fn(() => new Promise(() => {})) };
    const s = createScheduler({ fetchImpl: vi.fn(async () => stalled) });
    const kind = kindOf(s.request('a'));
    await vi.advanceTimersByTimeAsync(15000);
    expect(await kind).toBe('timeout');
    expect(stalled.text).toHaveBeenCalled();
  });

  it('the caller signal cancels active AND queued work', async () => {
    vi.useFakeTimers({ now: 0 });
    const signals = [];
    const fetchImpl = vi.fn((url, init) => {
      signals.push(init.signal);
      return new Promise(() => {});
    });
    const s = createScheduler({ fetchImpl });
    const controller = new AbortController();
    const kinds = Promise.all(['a', 'b', 'c'].map((u) => kindOf(s.request(u, { signal: controller.signal }))));
    await vi.advanceTimersByTimeAsync(600);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(s.queued()).toBe(1);
    controller.abort();
    expect(await kinds).toEqual(['cancelled', 'cancelled', 'cancelled']);
    expect(signals.every((sig) => sig.aborted)).toBe(true);
    expect(s.queued()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(s.inFlight()).toBe(0);
  });

  it('an already aborted signal never reaches fetch', async () => {
    const fetchImpl = vi.fn(async () => ok());
    const controller = new AbortController();
    controller.abort();
    expect(await kindOf(createScheduler({ fetchImpl }).request('a', { signal: controller.signal }))).toBe('cancelled');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a cancel during a cooldown drops the queued retry', async () => {
    vi.useFakeTimers({ now: 0 });
    const fetchImpl = vi.fn(async () => response({}, { status: 429, headers: { 'Retry-After': '5' } }));
    const s = createScheduler({ fetchImpl });
    const controller = new AbortController();
    const kind = kindOf(s.request('a', { signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    expect(await kind).toBe('cancelled');
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('LookupError messages are local text', () => {
    for (const kind of ['network', 'timeout', 'rate_limit', 'server', 'invalid_output', 'cancelled']) {
      const err = new LookupError(kind, { status: 500 });
      expect(err.kind).toBe(kind);
      expect(err.message.length).toBeGreaterThan(5);
    }
  });
});

describe('[P4 row8] per-run cache', () => {
  it('a success is stored', async () => {
    const cache = createRunCache();
    const load = vi.fn(async () => 'value');
    expect(await cache.get('u', load)).toBe('value');
    expect(await cache.get('u', load)).toBe('value');
    expect(load).toHaveBeenCalledTimes(1);
    expect(cache.isDone('u')).toBe(true);
  });

  it('a failure is evicted (the next get loads again)', async () => {
    const cache = createRunCache();
    const load = vi.fn().mockRejectedValueOnce(new LookupError('server')).mockResolvedValueOnce('second');
    await expect(cache.get('u', load)).rejects.toMatchObject({ kind: 'server' });
    expect(cache.has('u')).toBe(false);
    expect(await cache.get('u', load)).toBe('second');
  });

  it('identical in-flight requests are coalesced', async () => {
    const cache = createRunCache();
    let open;
    const load = vi.fn(() => new Promise((resolve) => { open = resolve; }));
    const a = cache.get('u', load);
    const b = cache.get('u', load);
    await Promise.resolve();
    await Promise.resolve();
    open('shared');
    expect(await Promise.all([a, b])).toEqual(['shared', 'shared']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('cancelling one consumer does not cancel the shared request while another waits', async () => {
    const cache = createRunCache();
    let open;
    let sharedSignal;
    const load = vi.fn((signal) => {
      sharedSignal = signal;
      return new Promise((resolve) => { open = resolve; });
    });
    const one = new AbortController();
    const first = kindOf(cache.get('u', load, { signal: one.signal }));
    const second = cache.get('u', load);
    await Promise.resolve();
    await Promise.resolve();
    one.abort();
    expect(await first).toBe('cancelled');
    expect(sharedSignal.aborted).toBe(false);
    open('kept');
    expect(await second).toBe('kept');
  });

  it('when every consumer cancels, the shared request is aborted and evicted', async () => {
    const cache = createRunCache();
    let sharedSignal;
    const load = vi.fn((signal) => {
      sharedSignal = signal;
      return new Promise(() => {});
    });
    const c1 = new AbortController();
    const c2 = new AbortController();
    const kinds = Promise.all([kindOf(cache.get('u', load, { signal: c1.signal })), kindOf(cache.get('u', load, { signal: c2.signal }))]);
    await Promise.resolve();
    await Promise.resolve();
    c1.abort();
    c2.abort();
    expect(await kinds).toEqual(['cancelled', 'cancelled']);
    expect(sharedSignal.aborted).toBe(true);
    expect(cache.has('u')).toBe(false);
  });

  it('Retry bypasses a completed entry (a fresh attempt)', async () => {
    const cache = createRunCache();
    const load = vi.fn().mockResolvedValueOnce('old').mockResolvedValueOnce('new');
    expect(await cache.get('u', load)).toBe('old');
    expect(await cache.get('u', load, { bypass: true })).toBe('new');
    expect(await cache.get('u', load)).toBe('new');
    expect(load).toHaveBeenCalledTimes(2);
  });
});
