import { describe, it, expect, vi } from 'vitest';
import { fetchWithDeadline, parseRetryAfter, createOperation } from '../http';
import { ProviderError } from '../errors';
import { response } from '../../../../test/setup';
import { mockFetch } from '../../../../test/fixtures';

const CTX = { providerId: 'openai', provider: 'OpenAI', host: 'api.openai.com' };
const URL_ = 'https://api.openai.com/v1/chat/completions';
const INIT = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' };

// Start the call and attach the result handlers at once (no unhandled rejection while timers advance).
const start = (opts) => {
  const settled = fetchWithDeadline(URL_, INIT, { ctx: CTX, deadlineMs: 10000, ...opts })
    .then((value) => ({ value }), (error) => ({ error }));
  return settled;
};

describe('[row 10] http', () => {
  it('429 → 200 retries once after 1 s', async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetch(response({}, { status: 429 }), response({ ok: 1 }));
    const pending = start();
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const { value } = await pending;
    expect(value).toEqual({ status: 200, text: '{"ok":1}' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('503 ×3 → overloaded after 1 s and 2 s backoff', async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetch(response({}, { status: 503 }));
    const pending = start();
    await vi.advanceTimersByTimeAsync(2999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    const { error } = await pending;
    expect(error).toMatchObject({ kind: 'overloaded', status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('Retry-After in seconds is honored when it fits', async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetch(response({}, { status: 429, headers: { 'Retry-After': '3' } }), response({ ok: 1 }));
    const pending = start();
    await vi.advanceTimersByTimeAsync(2999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).value.status).toBe(200);
  });

  it('Retry-After in seconds that does not fit stops at once with rate_limit', async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetch(response({}, { status: 429, headers: { 'Retry-After': '60' } }));
    const { error } = await start();
    expect(error).toMatchObject({ kind: 'rate_limit' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('Retry-After as an HTTP date, fitting and too long', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-26T12:00:00Z'));
    const soon = new Date('2026-09-26T12:00:04Z').toUTCString();
    const late = new Date('2026-09-26T13:00:00Z').toUTCString();
    let fetchMock = mockFetch(response({}, { status: 503, headers: { 'Retry-After': soon } }), response({ ok: 1 }));
    const pending = start();
    await vi.advanceTimersByTimeAsync(3999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).value.status).toBe(200);

    fetchMock = mockFetch(response({}, { status: 503, headers: { 'Retry-After': late } }));
    const { error } = await start();
    expect(error).toMatchObject({ kind: 'overloaded' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock = mockFetch(response({}, { status: 529, headers: { 'Retry-After': late } }));
    expect((await start()).error).toMatchObject({ kind: 'overloaded', status: 529 });
  });

  it('parseRetryAfter reads seconds and dates', () => {
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter(new Date(Date.now() + 10000).toUTCString())).toBeGreaterThan(8000);
  });

  it('a stalled body read hits the deadline', async () => {
    vi.useFakeTimers();
    const stalled = { ok: true, status: 200, headers: new Headers(), text: () => new Promise(() => {}) };
    mockFetch(stalled);
    const pending = start({ deadlineMs: 5000 });
    await vi.advanceTimersByTimeAsync(5000);
    expect((await pending).error).toMatchObject({ kind: 'timeout' });
  });

  it('an abort during backoff → cancelled, with no further attempt', async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetch(response({}, { status: 503 }));
    const controller = new AbortController();
    const pending = start({ signal: controller.signal });
    await vi.advanceTimersByTimeAsync(500);
    controller.abort();
    await vi.advanceTimersByTimeAsync(5000);
    expect((await pending).error).toMatchObject({ kind: 'cancelled' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('the deadline covers all attempts', async () => {
    vi.useFakeTimers();
    const slow503 = () => new Promise((resolve) => setTimeout(() => resolve(response({}, { status: 503 })), 800));
    const fetchMock = mockFetch(slow503);
    const pending = start({ deadlineMs: 2000 });
    await vi.advanceTimersByTimeAsync(2000);
    expect((await pending).error).toMatchObject({ kind: 'timeout' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('sends credentials:omit, no referrer and no cache, with one signal', async () => {
    const fetchMock = mockFetch(response({ ok: 1 }));
    await fetchWithDeadline(URL_, INIT, { ctx: CTX, deadlineMs: 1000 });
    const [, init] = fetchMock.mock.calls[0];
    expect(init).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', method: 'POST' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('a shared operation keeps one deadline across calls', async () => {
    vi.useFakeTimers();
    const op = createOperation({ deadlineMs: 1000 });
    mockFetch(() => new Promise((resolve) => setTimeout(() => resolve(response({ ok: 1 })), 600)));
    const first = fetchWithDeadline(URL_, INIT, { ctx: CTX, op }).then((v) => ({ v }), (e) => ({ e }));
    await vi.advanceTimersByTimeAsync(600);
    expect((await first).v.status).toBe(200);
    const second = fetchWithDeadline(URL_, INIT, { ctx: CTX, op }).then((v) => ({ v }), (e) => ({ e }));
    await vi.advanceTimersByTimeAsync(600);
    expect((await second).e).toMatchObject({ kind: 'timeout' });
    op.close();
  });
});

describe('[row 21] transport extras', () => {
  it.each([
    [402, 'billing'],
    [413, 'too_long'],
    [409, 'bad_request'],
    [451, 'bad_request'],
    [501, 'server'],
    [505, 'server']
  ])('HTTP %i → %s without retry', async (status, kind) => {
    const fetchMock = mockFetch(response({}, { status }));
    const { error } = await start();
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind, status });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('529 is retried like 503', async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetch(response({}, { status: 529 }), response({ ok: 1 }));
    const pending = start();
    await vi.advanceTimersByTimeAsync(1000);
    expect((await pending).value.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('fix-1 #7: discarded bodies are cancelled; cleanup ends outstanding transport', () => {
  it('a retried response body is cancelled before the retry; the 2xx body is read, not cancelled', async () => {
    vi.useFakeTimers();
    const busy = response('streaming error', { status: 503 });
    const ok = response({ ok: 1 });
    mockFetch(busy, ok);
    const pending = start();
    await vi.advanceTimersByTimeAsync(0);
    expect(busy.body.cancel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await pending).value.status).toBe(200);
    expect(busy.text).not.toHaveBeenCalled();
    expect(ok.body.cancel).not.toHaveBeenCalled();
    expect(ok.text).toHaveBeenCalledTimes(1);
  });

  it('a terminal non-2xx body is cancelled; the reported kind is unchanged', async () => {
    const denied = response(`{"error":"bad key"}`, { status: 401 });
    mockFetch(denied);
    const { error } = await start();
    expect(error).toMatchObject({ kind: 'auth', status: 401 });
    expect(denied.body.cancel).toHaveBeenCalledTimes(1);
    expect(denied.text).not.toHaveBeenCalled();
  });

  it('a throwing or rejecting cancel is swallowed; a body-less response is fine', async () => {
    const throwing = response('', { status: 400 });
    throwing.body.cancel = vi.fn(() => { throw new Error('locked'); });
    mockFetch(throwing);
    expect((await start()).error).toMatchObject({ kind: 'bad_request' });
    const rejecting = response('', { status: 400 });
    rejecting.body.cancel = vi.fn(() => Promise.reject(new Error('locked')));
    mockFetch(rejecting);
    expect((await start()).error).toMatchObject({ kind: 'bad_request' });
    mockFetch({ ...response('', { status: 400 }), body: null });
    expect((await start()).error).toMatchObject({ kind: 'bad_request' });
  });

  it('op.close() aborts the signal of outstanding work without setting a reason', () => {
    const op = createOperation({ deadlineMs: 1000 });
    expect(op.signal.aborted).toBe(false);
    op.close();
    expect(op.signal.aborted).toBe(true);
    expect(op.reason()).toBeNull();
  });

  it('after an error, the transport signal is aborted (a late body stream stops)', async () => {
    let seenSignal = null;
    globalThis.fetch = vi.fn(async (url, init) => {
      seenSignal = init.signal;
      return response('', { status: 403 });
    });
    expect((await start()).error).toMatchObject({ kind: 'forbidden' });
    expect(seenSignal.aborted).toBe(true);
  });
});
