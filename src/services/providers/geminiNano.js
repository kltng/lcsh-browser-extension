/**
 * Gemini Nano (Chrome built-in Prompt API) adapter (SPEC-P3 §4.3).
 * Never touches host permissions. Never starts a download from generate().
 */
import { ProviderError, errorContext } from './errors';
import { abortError, raceAbort } from './http';

/** Options for text-only sessions. */
export const TEXT_OPTS = {
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }]
};

/** Options for sessions that also take images. */
export const IMAGE_OPTS = {
  expectedInputs: [{ type: 'text', languages: ['en'] }, { type: 'image' }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }]
};

/** Tokens kept free for the answer. A heuristic: Nano offers no enforceable output limit. */
export const NANO_ANSWER_RESERVE = 1024;

const api = () => (typeof globalThis.LanguageModel !== 'undefined' ? globalThis.LanguageModel : null);

/**
 * Whether the Prompt API exists in this browser (Chrome 138+).
 * @returns {boolean}
 */
export const hasNanoApi = () => api() !== null;

/**
 * Availability for the given options; 'unavailable' when the API is missing or throws.
 * @param {object} opts - TEXT_OPTS or IMAGE_OPTS
 * @returns {Promise<'unavailable'|'downloadable'|'downloading'|'available'>}
 */
export const nanoAvailability = async (opts) => {
  const LM = api();
  if (!LM) return 'unavailable';
  try {
    return await LM.availability(opts);
  } catch (e) {
    return 'unavailable';
  }
};

/**
 * Turn a data URL into a Blob.
 * @param {string} dataUrl - `data:<mime>;base64,<data>`
 * @returns {Blob}
 */
export const dataUrlToBlob = (dataUrl) => {
  const comma = dataUrl.indexOf(',');
  const header = dataUrl.slice(0, comma);
  const mimeType = (header.match(/^data:([^;,]+)/) || [])[1] || 'application/octet-stream';
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
};

/**
 * Start a model download from a click handler. LanguageModel.create() is
 * called synchronously (no await before it), so it runs inside the user gesture.
 * The session is destroyed as soon as it arrives, also after a cancel.
 * @param {object} opts - TEXT_OPTS or IMAGE_OPTS
 * @param {(loaded:number)=>void} onProgress - Progress callback (0..1)
 * @returns {{promise:Promise<void>, cancel:()=>void}}
 */
export const startNanoDownload = (opts, onProgress) => {
  const controller = new AbortController();
  const created = api().create({
    ...opts,
    monitor(m) {
      m.addEventListener('downloadprogress', (e) => onProgress(e.loaded));
    },
    signal: controller.signal
  });
  const promise = Promise.resolve(created).then((session) => {
    session?.destroy?.();
  });
  return { promise, cancel: () => controller.abort() };
};

const mapException = (err, op, ctx, phase, constrained) => {
  if (err instanceof ProviderError) return err;
  if (op.reason()) return abortError(op, ctx);
  const name = err?.name;
  if (name === 'QuotaExceededError') return new ProviderError('too_long', { ...ctx, variant: 'nano_too_long' });
  const withConstraint = constrained && (phase === 'measure' || phase === 'prompt');
  if (name === 'NotSupportedError') {
    return withConstraint
      ? new ProviderError('invalid_output', { ...ctx, variant: 'nano_constraint' })
      : new ProviderError('unavailable', ctx);
  }
  if (name === 'NotAllowedError') return new ProviderError('unavailable', ctx);
  if (constrained && phase === 'prompt') return new ProviderError('invalid_output', { ...ctx, variant: 'nano_constraint' });
  return new ProviderError('unavailable', ctx);
};

/**
 * One generation call on Gemini Nano. `temperature` and `maxOutputTokens` are ignored.
 * @param {object} cfg - ProviderConfig
 * @param {object} req - GenerateRequest
 * @param {object} op - Operation from createOperation() (deadline + caller signal)
 * @returns {Promise<{text:string, finish:'stop', usage:object}>}
 */
export const generateNano = async (cfg, req, op) => {
  const ctx = errorContext(cfg);
  const LM = api();
  if (!LM) throw new ProviderError('unavailable', ctx);
  const images = req.images || [];
  const schema = req.schema || null;
  const opts = images.length > 0 ? IMAGE_OPTS : TEXT_OPTS;
  const { signal } = op;
  let phase = 'availability';
  let session = null;
  let finished = false;
  let destroyed = false;
  // One idempotent destroy, shared by the create continuation and `finally`.
  const destroyOnce = () => {
    if (!session || destroyed) return;
    destroyed = true;
    try {
      session.destroy?.();
    } catch (e) {
      // A failing destroy must not hide the real result.
    }
  };
  try {
    const state = await raceAbort(LM.availability(opts), signal);
    if (state !== 'available') throw new ProviderError('unavailable', ctx);

    phase = 'create';
    // Never start a session for an operation that is already cancelled or timed out.
    if (signal.aborted) throw abortError(op, ctx);
    const created = Promise.resolve(LM.create({
      ...opts,
      ...(req.system ? { initialPrompts: [{ role: 'system', content: req.system }] } : {}),
      signal
    }));
    // Ownership is taken in the create continuation itself, so a session that
    // resolves in the same task as an abort (or any time later) is still destroyed.
    const owned = created.then((value) => {
      session = value;
      if (finished) destroyOnce();
      return value;
    });
    owned.catch(() => {});
    await raceAbort(owned, signal);

    const input = images.length > 0
      ? [{
        role: 'user',
        content: [
          { type: 'text', value: req.userText },
          ...images.map((i) => ({ type: 'image', value: dataUrlToBlob(i.dataUrl) }))
        ]
      }]
      : req.userText;
    const callOpts = schema ? { responseConstraint: schema, signal } : { signal };

    phase = 'measure';
    const used = session.contextUsage ?? session.inputUsage ?? 0;
    const measure = session.measureContextUsage ?? session.measureInputUsage;
    const need = await raceAbort(measure.call(session, input, callOpts), signal);
    const cap = session.contextWindow ?? session.inputQuota;
    if (used + need + NANO_ANSWER_RESERVE > cap) {
      throw new ProviderError('too_long', { ...ctx, variant: 'nano_too_long' });
    }

    phase = 'prompt';
    const text = await raceAbort(session.prompt(input, callOpts), signal);
    if (typeof text !== 'string' || !text.trim()) {
      throw new ProviderError('invalid_output', ctx);
    }
    return { text, finish: 'stop', usage: { inputTokens: null, outputTokens: null } };
  } catch (err) {
    throw mapException(err, op, ctx, phase, Boolean(schema));
  } finally {
    finished = true;
    destroyOnce();
  }
};

export default generateNano;
