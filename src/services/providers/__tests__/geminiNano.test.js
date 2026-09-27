import { describe, it, expect, vi } from 'vitest';
import {
  TEXT_OPTS, IMAGE_OPTS, hasNanoApi, nanoAvailability, startNanoDownload, dataUrlToBlob
} from '../geminiNano';
import { generate } from '../index';
import { TEST_SCHEMA } from '../schema';
import { fakes, installLanguageModel, gate, flushEvents } from '../../../../test/setup';
import { makeCfg, VALID_TEST_ANSWER } from '../../../../test/fixtures';

const REQ = { system: 'SYS', userText: 'USER' };
const PNG = { mimeType: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' };
const JPG = { mimeType: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,/9j/4AAQ' };

const outcome = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));
const domError = (name) => new DOMException('x', name);

describe('[row 13] Nano', () => {
  it('no API → unavailable, and availability reports unavailable', async () => {
    expect(hasNanoApi()).toBe(false);
    expect(await nanoAvailability(TEXT_OPTS)).toBe('unavailable');
    const cfg = await makeCfg('gemini-nano');
    await expect(generate(cfg, REQ)).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it.each(['unavailable', 'downloadable', 'downloading'])('availability %s → unavailable, no create, no download', async (state) => {
    const { LanguageModel } = installLanguageModel({ availability: { text: state, image: state } });
    const cfg = await makeCfg('gemini-nano');
    await expect(generate(cfg, REQ)).rejects.toMatchObject({ kind: 'unavailable' });
    expect(LanguageModel.create).not.toHaveBeenCalled();
  });

  it('available → create options match the availability options; destroy on success', async () => {
    const { LanguageModel, sessions } = installLanguageModel({ promptResult: 'Answer' });
    const cfg = await makeCfg('gemini-nano');
    const result = await generate(cfg, REQ);
    expect(result).toMatchObject({ text: 'Answer', finish: 'stop', mode: 'text', json: null, usage: { inputTokens: null, outputTokens: null } });
    const availabilityOpts = LanguageModel.availability.mock.calls.at(-1)[0];
    const createOpts = LanguageModel.create.mock.calls[0][0];
    expect(createOpts.expectedInputs).toEqual(availabilityOpts.expectedInputs);
    expect(createOpts.expectedOutputs).toEqual(availabilityOpts.expectedOutputs);
    expect(sessions[0].destroy).toHaveBeenCalledTimes(1);
  });

  it('responseConstraint is passed to measure and prompt', async () => {
    const { sessions } = installLanguageModel({ promptResult: JSON.stringify(VALID_TEST_ANSWER) });
    const cfg = await makeCfg('gemini-nano');
    const result = await generate(cfg, { ...REQ, schema: TEST_SCHEMA });
    expect(result.json).toEqual(VALID_TEST_ANSWER);
    expect(sessions[0].prompt.mock.calls[0][1]).toMatchObject({ responseConstraint: TEST_SCHEMA });
    expect(sessions[0].measureContextUsage.mock.calls[0][1]).toMatchObject({ responseConstraint: TEST_SCHEMA });
  });

  it('an image becomes a Blob', async () => {
    const blob = dataUrlToBlob(PNG.dataUrl);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('image/png');
    expect(blob.size).toBe(8);
    const { sessions } = installLanguageModel();
    const cfg = await makeCfg('gemini-nano');
    await generate(cfg, { ...REQ, images: [PNG] });
    const value = sessions[0].prompt.mock.calls[0][0][0].content[1].value;
    expect(value).toBeInstanceOf(Blob);
    expect(value.type).toBe('image/png');
    expect(sessions[0].measureContextUsage.mock.calls[0][0]).toBe(sessions[0].prompt.mock.calls[0][0]);
  });

  it.each(['context', 'input'])('budget with the %s API names: fits and too_long', async (family) => {
    installLanguageModel({ family, used: 1000, need: 3976, window: 6000 });
    const cfg = await makeCfg('gemini-nano');
    await expect(generate(cfg, REQ)).resolves.toMatchObject({ text: 'OK' });
    fakes.nano.config.need = 3977;
    await expect(generate(cfg, REQ)).rejects.toMatchObject({ kind: 'too_long' });
    expect(fakes.nano.sessions.at(-1).prompt).not.toHaveBeenCalled();
    expect(fakes.nano.sessions.at(-1).destroy).toHaveBeenCalled();
  });

  it.each([
    ['QuotaExceededError during prompt', { promptError: domError('QuotaExceededError') }, false, 'too_long'],
    ['NotSupportedError with a constraint', { promptError: domError('NotSupportedError') }, true, 'invalid_output'],
    ['NotSupportedError without a constraint', { promptError: domError('NotSupportedError') }, false, 'unavailable'],
    ['NotSupportedError from measure with a constraint', { measureError: domError('NotSupportedError') }, true, 'invalid_output'],
    ['NotSupportedError from create', { createError: domError('NotSupportedError') }, true, 'unavailable'],
    ['NotAllowedError', { createError: domError('NotAllowedError') }, false, 'unavailable'],
    ['anything else during a constrained prompt', { promptError: new Error('boom') }, true, 'invalid_output'],
    ['anything else otherwise', { promptError: new Error('boom') }, false, 'unavailable'],
    ['anything else from create', { createError: new Error('boom') }, true, 'unavailable']
  ])('%s → %s', async (_, config, withSchema, kind) => {
    installLanguageModel(config);
    const cfg = await makeCfg('gemini-nano');
    const { error } = await outcome(generate(cfg, { ...REQ, schema: withSchema ? TEST_SCHEMA : null }));
    expect(error.kind).toBe(kind);
    if (kind === 'invalid_output') expect(error.message).toBe('Gemini Nano cannot produce this structured output.');
    for (const session of fakes.nano.sessions) expect(session.destroy).toHaveBeenCalledTimes(1);
  });

  it('destroy on cancel', async () => {
    const measureGate = gate();
    const { sessions } = installLanguageModel({ measureGate: measureGate.promise });
    const cfg = await makeCfg('gemini-nano');
    const controller = new AbortController();
    const pending = outcome(generate(cfg, { ...REQ, signal: controller.signal }));
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    controller.abort();
    expect((await pending).error.kind).toBe('cancelled');
    expect(sessions[0].destroy).toHaveBeenCalledTimes(1);
    measureGate.open();
  });
});

describe('fix-1 #6: Nano create/abort boundary', () => {
  it('create resolves and the signal aborts in the same task → the session is destroyed exactly once', async () => {
    const fake = installLanguageModel({ honorCreateSignal: false });
    let resolveCreate = null;
    fake.LanguageModel.create.mockImplementationOnce((opts) => new Promise((resolve) => {
      resolveCreate = () => resolve(fake.makeSession(opts));
    }));
    const cfg = await makeCfg('gemini-nano');
    const controller = new AbortController();
    const pending = outcome(generate(cfg, { ...REQ, signal: controller.signal }));
    await vi.waitFor(() => expect(resolveCreate).toBeTypeOf('function'));
    // Same task: the create promise resolves, then the caller aborts, before any microtask runs.
    resolveCreate();
    controller.abort();
    expect((await pending).error.kind).toBe('cancelled');
    await flushEvents();
    expect(fake.sessions).toHaveLength(1);
    expect(fake.sessions[0].destroy).toHaveBeenCalledTimes(1);
    expect(fake.sessions[0].prompt).not.toHaveBeenCalled();
  });

  it('an abort during availability → create is never called', async () => {
    const fake = installLanguageModel();
    const cfg = await makeCfg('gemini-nano');
    const controller = new AbortController();
    fake.LanguageModel.availability.mockImplementationOnce(async () => {
      controller.abort();
      return 'available';
    });
    expect((await outcome(generate(cfg, { ...REQ, signal: controller.signal }))).error.kind).toBe('cancelled');
    expect(fake.LanguageModel.create).not.toHaveBeenCalled();
  });

  it('a normal run still destroys exactly once', async () => {
    const fake = installLanguageModel();
    const cfg = await makeCfg('gemini-nano');
    await generate(cfg, REQ);
    await flushEvents();
    expect(fake.sessions[0].destroy).toHaveBeenCalledTimes(1);
  });
});

describe('[row 20] Nano extras', () => {
  it('the image download uses IMAGE_OPTS, calls create synchronously, reports progress and destroys the session', async () => {
    const { LanguageModel, sessions } = installLanguageModel();
    const progress = [];
    const job = startNanoDownload(IMAGE_OPTS, (loaded) => progress.push(loaded));
    expect(LanguageModel.create).toHaveBeenCalledTimes(1);
    const opts = LanguageModel.create.mock.calls[0][0];
    expect(opts.expectedInputs).toEqual(IMAGE_OPTS.expectedInputs);
    expect(opts.expectedOutputs).toEqual(IMAGE_OPTS.expectedOutputs);
    expect(typeof opts.monitor).toBe('function');
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    await job.promise;
    expect(progress).toEqual([0.5]);
    expect(sessions[0].destroy).toHaveBeenCalledTimes(1);
  });

  it('the text download uses TEXT_OPTS; cancel aborts its signal', async () => {
    const createGate = gate();
    const { LanguageModel } = installLanguageModel({ createGate: createGate.promise });
    const job = startNanoDownload(TEXT_OPTS, () => {});
    expect(LanguageModel.create.mock.calls[0][0].expectedInputs).toEqual(TEXT_OPTS.expectedInputs);
    job.cancel();
    expect(LanguageModel.create.mock.calls[0][0].signal.aborted).toBe(true);
    createGate.open();
    await expect(job.promise).rejects.toHaveProperty('name', 'AbortError');
  });

  it('cancel during create → cancelled; the late session is destroyed when it arrives', async () => {
    const createGate = gate();
    const { sessions } = installLanguageModel({ createGate: createGate.promise, honorCreateSignal: false });
    const cfg = await makeCfg('gemini-nano');
    const controller = new AbortController();
    const pending = outcome(generate(cfg, { ...REQ, signal: controller.signal }));
    await vi.waitFor(() => expect(fakes.nano.LanguageModel.create).toHaveBeenCalled());
    controller.abort();
    expect((await pending).error.kind).toBe('cancelled');
    expect(sessions).toHaveLength(0);
    createGate.open();
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    await vi.waitFor(() => expect(sessions[0].destroy).toHaveBeenCalledTimes(1));
    expect(sessions[0].prompt).not.toHaveBeenCalled();
  });

  it('cancel during measure → cancelled, session destroyed', async () => {
    const measureGate = gate();
    const { sessions } = installLanguageModel({ measureGate: measureGate.promise });
    const cfg = await makeCfg('gemini-nano');
    const controller = new AbortController();
    const pending = outcome(generate(cfg, { ...REQ, signal: controller.signal }));
    await vi.waitFor(() => expect(sessions[0]?.measureContextUsage).toHaveBeenCalled());
    controller.abort();
    expect((await pending).error.kind).toBe('cancelled');
    expect(sessions[0].destroy).toHaveBeenCalledTimes(1);
    expect(sessions[0].prompt).not.toHaveBeenCalled();
    measureGate.open();
  });

  it('deadline → timeout, caller abort → cancelled (the recorded source decides)', async () => {
    const createGate = gate();
    const { LanguageModel } = installLanguageModel({ createGate: createGate.promise, honorCreateSignal: false });
    const cfg = await makeCfg('gemini-nano');
    expect((await outcome(generate(cfg, { ...REQ, deadlineMs: 20 }))).error.kind).toBe('timeout');
    const controller = new AbortController();
    const pending = outcome(generate(cfg, { ...REQ, signal: controller.signal, deadlineMs: 60000 }));
    await vi.waitFor(() => expect(LanguageModel.create).toHaveBeenCalledTimes(2));
    controller.abort();
    expect((await pending).error.kind).toBe('cancelled');
    createGate.open();
    await vi.waitFor(() => {
      expect(fakes.nano.sessions).toHaveLength(2);
      for (const s of fakes.nano.sessions) expect(s.destroy).toHaveBeenCalledTimes(1);
    });
  });

  it('an empty image array takes the text path', async () => {
    const { LanguageModel, sessions } = installLanguageModel();
    const cfg = await makeCfg('gemini-nano');
    await generate(cfg, { ...REQ, images: [] });
    expect(LanguageModel.availability).toHaveBeenLastCalledWith(TEXT_OPTS);
    expect(LanguageModel.create.mock.calls[0][0].expectedInputs).toEqual(TEXT_OPTS.expectedInputs);
    expect(sessions[0].prompt.mock.calls[0][0]).toBe('USER');
  });

  it('two images are passed in order', async () => {
    const { sessions } = installLanguageModel();
    const cfg = await makeCfg('gemini-nano');
    await generate(cfg, { ...REQ, images: [PNG, JPG] });
    const content = sessions[0].prompt.mock.calls[0][0][0].content;
    expect(content.map((c) => c.type)).toEqual(['text', 'image', 'image']);
    expect(content[1].value.type).toBe('image/png');
    expect(content[2].value.type).toBe('image/jpeg');
  });

  it('images with image input not available → images_unsupported before create', async () => {
    const { LanguageModel } = installLanguageModel({ availability: { text: 'available', image: 'downloadable' } });
    const cfg = await makeCfg('gemini-nano');
    await expect(generate(cfg, { ...REQ, images: [PNG] })).rejects.toMatchObject({ kind: 'images_unsupported' });
    expect(LanguageModel.create).not.toHaveBeenCalled();
  });
});
