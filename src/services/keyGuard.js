/**
 * The ONE key guard at every exit of the model-output pipeline (P6 security
 * review, fix 13). Model text is transformed in many places (parsing, search
 * normalization, subdivision extraction, export formatting), so instead of
 * checking each transformation, every EXIT checks exactly what leaves:
 *  (a) the LOC query string — `buildSearchUrl()`, locShared.js;
 *  (b) the history entry — `saveHistoryEntry()`, history.js;
 *  (c) Copy / Copy all / CSV text — `workflow.guard('export', …)`;
 *  (d) the values shown in the UI — the workflow's suggest commit.
 *
 * The length rules are the same as for the raw answer (fix 11b):
 *  - 8+ characters: the text CONTAINS the key;
 *  - 2–7 characters: the text contains the key as a WHOLE token (no letter or
 *    digit right before or after it);
 *  - 1 character: the text, trimmed, EQUALS the key.
 *
 * A hit throws KeyEchoError with local text only: it never contains the key
 * or any response text (HOUSE_RULES 6). Keys are kept in memory only.
 */

/** The local message of each exit. */
export const KEY_ECHO_MESSAGES = {
  lookup: 'A search term repeats an API key, so it was not sent to id.loc.gov.',
  history: 'This run contains text that repeats an API key, so it was not saved to history.',
  export: 'This text repeats an API key, so it was not copied or exported.',
  display: 'The AI answer repeats an API key, so it was not used.'
};

/** A key found at an exit. Local text only. */
export class KeyEchoError extends Error {
  /** @param {'lookup'|'history'|'export'|'display'} exit - The exit that refused */
  constructor(exit) {
    super(KEY_ECHO_MESSAGES[exit] || KEY_ECHO_MESSAGES.display);
    this.name = 'KeyEchoError';
    this.kind = 'key_echo';
    this.exit = Object.hasOwn(KEY_ECHO_MESSAGES, exit) ? exit : 'display';
  }
}

const isAlphanumeric = (ch) => /^[\p{L}\p{N}]$/u.test(ch);

/** Whether `text` contains `key` as a whole token: no letter or digit right before or after it. */
const containsToken = (text, key) => {
  for (let at = text.indexOf(key); at !== -1; at = text.indexOf(key, at + 1)) {
    const before = at > 0 ? text[at - 1] : '';
    const after = text[at + key.length] ?? '';
    if (!(before && isAlphanumeric(before)) && !(after && isAlphanumeric(after))) return true;
  }
  return false;
};

/**
 * Whether one string gives `key` back, by the length rules above.
 * @param {string} text - A string value
 * @param {string} key - A non-empty key
 * @param {{name?:boolean}} [opts] - `name`: the string is a property name (1-character keys skip names)
 * @returns {boolean}
 */
export const textHasKey = (text, key, { name = false } = {}) => {
  if (key.length >= 8) return text.includes(key);
  if (key.length >= 2) return containsToken(text, key);
  return !name && text.trim() === key;
};

const usableKeys = (keys) => [...new Set((keys || []).filter((k) => typeof k === 'string' && k.length > 0))];

/**
 * Whether any string (or property name) inside `value` gives any of `keys` back.
 * @param {any} value - A string, array or object
 * @param {string[]} keys - Keys to look for
 * @returns {boolean}
 */
export const valueHasKey = (value, keys) => {
  const list = usableKeys(keys);
  if (list.length === 0) return false;
  const seen = new Set();
  const walk = (v) => {
    if (typeof v === 'string') return list.some((key) => textHasKey(v, key));
    if (!v || typeof v !== 'object' || seen.has(v)) return false;
    seen.add(v);
    return Object.entries(v).some(([k, x]) => list.some((key) => textHasKey(k, key, { name: true })) || walk(x));
  };
  return walk(value);
};

/**
 * The fields of a finished export text: the whole text, each line, and each
 * part between the export's own separators (` | `, `, `, `: `, CSV quotes
 * and commas), so a 1-character key that stands alone as one field is found
 * in the FINAL text too.
 * @param {string} text - Copy / Copy all / CSV text
 * @returns {string[]}
 */
export const textFields = (text) => {
  const s = String(text ?? '');
  const lines = s.split(/\r?\n/);
  const parts = lines.flatMap((line) => line.split(/ \| |, |: |","|^﻿?"|"$|^# /));
  return [s, ...lines, ...parts.map((p) => p.trim())];
};

/**
 * THE exit check. Throws KeyEchoError when `value` gives any key back.
 * @param {'lookup'|'history'|'export'|'display'} exit - The exit
 * @param {any} value - Exactly what leaves (a string, an export text or an object)
 * @param {string[]} keys - The keys to check
 * @returns {any} - `value`, unchanged
 */
export const guardExit = (exit, value, keys) => {
  const checked = exit === 'export' && typeof value === 'string' ? textFields(value) : value;
  if (valueHasKey(checked, keys)) throw new KeyEchoError(exit);
  return value;
};

// The keys of this document, in memory only: every key a run has used, and
// the keys stored for every provider (kept current by watchStoredKeys()).
const runKeys = new Set();
let storedKeys = [];
// Views that hide text re-render when the known keys change (P6 fix 14).
let keysVersionNumber = 0;
const keyListeners = new Set();
const keysChanged = () => {
  keysVersionNumber += 1;
  keyListeners.forEach((listener) => listener());
};

/**
 * Subscribe to changes of the known keys (for useSyncExternalStore).
 * @param {()=>void} listener - Called after a change
 * @returns {()=>void} - Unsubscribe
 */
export const subscribeKeys = (listener) => {
  keyListeners.add(listener);
  return () => keyListeners.delete(listener);
};

/** A number that changes whenever the known keys change. */
export const keysVersion = () => keysVersionNumber;

/**
 * Remember the key of a run's provider (the run snapshot).
 * @param {string|null|undefined} key - The run's API key
 */
export const rememberRunKey = (key) => {
  if (typeof key === 'string' && key.length > 0 && !runKeys.has(key)) {
    runKeys.add(key);
    keysChanged();
  }
};

/**
 * The API keys stored for every provider in a settings object.
 * @param {{providers?:Object<string,object>}} settings - Result of getSettings()
 * @returns {string[]}
 */
export const keysOfSettings = (settings) => Object.values(settings?.providers || {})
  .map((p) => (typeof p?.apiKey === 'string' ? p.apiKey.trim() : ''))
  .filter(Boolean);

/**
 * Replace the stored keys.
 * @param {string[]} keys - Every key stored now
 */
// P6 fix 15: readiness and ordering of the stored keys. A watcher makes the
// registry NOT ready until its first read succeeded; views show no model text
// before that. Every read takes a sequence number, and only a result newer
// than the last applied one is used, so a stale read that finishes late never
// overwrites a newer set.
let ready = true;
let loadedOnce = false;
let readSeq = 0;
let appliedSeq = 0;

const applyStoredKeys = (keys, seq) => {
  if (seq <= appliedSeq) return;
  appliedSeq = seq;
  loadedOnce = true;
  const next = usableKeys(keys);
  const same = next.length === storedKeys.length && next.every((k, i) => k === storedKeys[i]);
  storedKeys = next;
  if (!ready) ready = true;
  else if (same) return;
  keysChanged();
};

/**
 * Replace the stored keys with a set read just now (it counts as the newest).
 * @param {string[]} keys - Every key stored now
 */
export const setStoredKeys = (keys) => {
  readSeq += 1;
  applyStoredKeys(keys, readSeq);
};

/** Whether the stored keys have loaded at least once (or no watcher is waiting for them). */
export const keysReady = () => ready;

/**
 * The keys for exits (a) and (b): every run key of this document plus every
 * stored key, so a key of ANOTHER provider cannot leave either.
 * @returns {string[]}
 */
export const documentKeys = () => [...new Set([...runKeys, ...storedKeys])];

/**
 * Keep the stored keys current: once now, and on every provider change.
 * @param {{readStoredApiKeys:()=>Promise<string[]>, onSettingsChanged:Function}} deps - Settings functions
 * @returns {()=>void} - Unsubscribe
 */
export const watchStoredKeys = ({ readStoredApiKeys, onSettingsChanged }) => {
  let alive = true;
  if (!loadedOnce && ready) {
    ready = false;
    keysChanged();
  }
  const refresh = () => {
    readSeq += 1;
    const seq = readSeq;
    let reading;
    try {
      reading = Promise.resolve(readStoredApiKeys());
    } catch (err) {
      reading = Promise.reject(err);
    }
    return reading
      .then((keys) => { if (alive) applyStoredKeys(keys, seq); })
      .catch(() => {
        // The last good set is kept. Local text only: never the error or a key.
        console.error('[keys] The stored API keys could not be read; the last known set is kept.');
      });
  };
  refresh();
  const stop = onSettingsChanged((changes) => {
    if (Object.keys(changes).some((k) => k.startsWith('provider:') || k === 'geminiApiKey')) refresh();
  });
  return () => {
    alive = false;
    stop();
  };
};

/** The fixed text shown instead of a display value that repeats a known key. */
export const HIDDEN_TEXT = 'Hidden: this text repeats an API key.';

/**
 * Exit (d) for FINISHED display values (P6 fix 14): model text after it was
 * joined or formatted for display, and every model-derived field of a history
 * entry. Returns the value unchanged, or HIDDEN_TEXT when it repeats a known
 * key (every key a run used and every stored key). The same fields and length
 * rules as for export text apply.
 * @param {any} text - The finished display string
 * @param {string[]} [keys] - Keys to check (default: every known key)
 * @returns {any}
 */
export const shownText = (text, keys = documentKeys()) => {
  if (typeof text !== 'string' || text === '') return text;
  // Before the stored keys have loaded once, nothing model-derived is shown.
  if (!ready) return LOADING_TEXT;
  return valueHasKey(textFields(text), keys) ? HIDDEN_TEXT : text;
};

/** Shown instead of model-derived text until the stored keys have loaded once. */
export const LOADING_TEXT = 'Loading…';

/** Forget every key and reset readiness (tests). */
export const resetKeyRegistry = () => {
  runKeys.clear();
  storedKeys = [];
  ready = true;
  loadedOnce = false;
  readSeq = 0;
  appliedSeq = 0;
  keysChanged();
};
