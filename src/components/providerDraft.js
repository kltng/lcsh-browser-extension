/**
 * Pure helpers for the Settings draft form (SPEC-P3 §2 stale-draft rule, §5.4).
 */
import { sameProviderValue } from '../services/settings';
import { baseURLFor, endpointOrigin, keyOriginOf } from '../services/providers/capabilities';
import { originFor, requestAccess, hasAccess } from '../services/providers/permissions';

const DRAFT_FIELDS = ['region', 'apiKey', 'baseURL', 'model', 'jsonMode'];

/**
 * A form draft from a stored provider value (empty strings for missing fields).
 * @param {object} [stored] - Stored `provider:<id>` value
 * @returns {object}
 */
export const draftFromStored = (stored = {}) => {
  const draft = {};
  for (const field of DRAFT_FIELDS) draft[field] = typeof stored?.[field] === 'string' ? stored[field] : '';
  draft.imagesOverride = stored?.imagesOverride === true;
  // P6 fix 11: the origin the saved key was entered for ('' = not recorded).
  draft.keyOrigin = typeof stored?.keyOrigin === 'string' ? stored.keyOrigin : '';
  // A key typed while the endpoint was not yet valid; bound to the first valid one.
  draft.keyPending = false;
  return draft;
};

/**
 * Form state loaded from a stored value: `base` is what the form was loaded from.
 * @param {object} [stored] - Stored value
 * @returns {{base:object, draft:object, dirty:boolean, stale:boolean}}
 */
export const initialDraftState = (stored = {}) => ({
  base: stored || {},
  draft: draftFromStored(stored),
  dirty: false,
  stale: false,
  locked: false,
  keyCleared: false
});

/**
 * Lock the form while a Save / Save & use is pending: edits are refused, so a
 * completing save can never erase an edit made during it.
 * @param {object} state - Form state
 * @returns {object}
 */
export const beginSave = (state) => ({ ...state, locked: true });

/**
 * Unlock the form after a save that did not complete (denied, failed).
 * @param {object} state - Form state
 * @returns {object}
 */
export const endSave = (state) => (state.locked ? { ...state, locked: false } : state);

/**
 * React to a stored value change (another tab saved). A clean form refreshes;
 * a dirty form keeps the user's edits and is marked stale.
 * @param {object} state - Form state
 * @param {object} stored - New stored value
 * @returns {object} - Next form state
 */
export const applyStoredChange = (state, stored) => {
  if (sameProviderValue(stored, state.base)) return state;
  if (!state.dirty) return initialDraftState(stored);
  return { ...state, stale: true };
};

/**
 * Apply the key-origin binding to one edit (P6 security review finding 1).
 * Typing a key binds it to the endpoint's current origin. An endpoint edit
 * (base URL or region) that changes the origin CLEARS the key, which must
 * then be entered again; a path change on the same origin keeps it.
 */
const bindKey = (entry, before, draft, field) => {
  const next = { ...draft };
  let cleared = false;
  if (field === 'apiKey') {
    const origin = endpointOrigin(entry, next);
    const typed = typeof next.apiKey === 'string' && next.apiKey.trim() !== '';
    next.keyOrigin = typed && origin ? origin : '';
    next.keyPending = typed && !origin;
    return { draft: next, cleared };
  }
  if (field !== 'baseURL' && field !== 'region') return { draft: next, cleared };
  if (!(typeof next.apiKey === 'string' && next.apiKey.trim())) return { draft: next, cleared };
  const origin = endpointOrigin(entry, next);
  if (before.keyPending) {
    // The key was typed before any valid endpoint: it belongs to the first one.
    if (origin) {
      next.keyOrigin = origin;
      next.keyPending = false;
    }
    return { draft: next, cleared };
  }
  if (keyOriginOf(entry, before) !== origin) {
    next.apiKey = '';
    next.keyOrigin = '';
    next.keyPending = false;
    cleared = true;
  }
  return { draft: next, cleared };
};

/**
 * Edit one draft field. With the registry `entry`, an endpoint change that
 * changes the origin clears the key (see bindKey); every provider form passes it.
 * @param {object} state - Form state
 * @param {string} field - Field name
 * @param {any} value - New value
 * @param {object} [entry] - Registry entry of the form's provider
 * @returns {object} - Next form state
 */
export const editDraft = (state, field, value, entry = null) => {
  if (state.locked) return state;
  const edited = { ...state.draft, [field]: value };
  if (!entry || entry.adapter === 'chrome-nano') return { ...state, draft: edited, dirty: true };
  const { draft, cleared } = bindKey(entry, state.draft, edited, field);
  const keyCleared = field === 'apiKey' ? false : (cleared || state.keyCleared === true);
  return { ...state, draft, dirty: true, keyCleared };
};

/**
 * Form state after a save attempt (also unlocks the form).
 * @param {object} state - Form state
 * @param {{saved:boolean, value?:object}} result - Result of saveProviderDraft()
 * @returns {object} - Next form state
 */
export const afterSave = (state, result) => (
  result.saved ? initialDraftState(result.value) : { ...state, stale: true, locked: false }
);

/**
 * The fields of a draft that the provider uses, for saving.
 * @param {object} entry - Registry entry
 * @param {object} draft - Form draft
 * @returns {object}
 */
export const patchFromDraft = (entry, draft) => {
  // The key is saved with the origin it belongs to ('' removes a stale one).
  // A key saved before keys were bound gets its origin now when it is known
  // (a fixed provider endpoint); a user-typed endpoint's old key stays unbound.
  const keyOrigin = draft.apiKey ? (draft.keyOrigin || keyOriginOf(entry, draft) || '') : '';
  const patch = { apiKey: draft.apiKey, keyOrigin, model: draft.model };
  if (entry.regionSelectable) patch.region = draft.region;
  if (entry.id === 'custom' || entry.id === 'lmstudio') patch.baseURL = draft.baseURL;
  if (entry.json === 'user-choice') patch.jsonMode = draft.jsonMode;
  patch.imagesOverride = draft.imagesOverride === true;
  return patch;
};

/**
 * Steps 1–3 of the gesture rule, all synchronous: validate the value, compute
 * the origin, and call chrome.permissions.request (every time). Call it as the
 * first thing in a click handler, with no await before it. Nano skips 2–3.
 * @param {object} entry - Registry entry
 * @param {object} value - The draft (or the SAVED value, for Grant access)
 * @returns {{ok:true, host:string|null, granted:Promise<boolean>}|{ok:false, reason:string}}
 */
export const beginPermissionGesture = (entry, value) => {
  if (entry.adapter === 'chrome-nano') return { ok: true, host: null, granted: Promise.resolve(true) };
  const base = baseURLFor(entry, value);
  if (!base.ok) return { ok: false, reason: base.reason };
  const origin = originFor({ entry, baseURL: base.url });
  const granted = requestAccess(origin).then(Boolean, () => false);
  return { ok: true, host: new URL(base.url).host, granted };
};

/**
 * Run a Settings action under the gesture rule. The permission request is
 * started synchronously (first). A save locks the form until it completes.
 * A DENIED request saves nothing, shows "Permission needed to contact <host>",
 * and keeps the typed draft (the form is only unlocked).
 * @param {object} entry - Registry entry
 * @param {object} value - The draft (or the SAVED value, for Grant access)
 * @param {()=>Promise<void>} work - The action after a granted request
 * @param {{save?:boolean, setForm:Function, setBusy:Function, setMessages:Function,
 *   recheck:Function, onError:Function}} ui - Form state setters and callbacks
 * @returns {Promise<void>}
 */
export const runGestureAction = (entry, value, work, { save = false, setForm, setBusy, setMessages, recheck, onError }) => {
  const gesture = beginPermissionGesture(entry, value);
  if (!gesture.ok) {
    setMessages([{ severity: 'error', text: gesture.reason }]);
    return Promise.resolve();
  }
  setBusy(true);
  if (save) setForm(beginSave);
  setMessages([]);
  return gesture.granted
    .then(async (granted) => {
      if (!granted) {
        setMessages([{ severity: 'error', text: `Permission needed to contact ${gesture.host}` }]);
        recheck();
        return;
      }
      await work();
    })
    .catch(onError)
    .finally(() => {
      if (save) setForm(endSave);
      setBusy(false);
    });
};

/**
 * The permission origin of the SAVED configuration (never the draft), or null.
 * @param {object} entry - Registry entry
 * @param {object} stored - Stored `provider:<id>` value
 * @returns {string|null}
 */
export const savedOrigin = (entry, stored) => {
  const base = baseURLFor(entry, stored || {});
  return base.ok ? originFor({ entry, baseURL: base.url }) : null;
};

/**
 * Read-only check of the saved origin's access: once now, and again whenever
 * Chrome adds or removes a permission (for example a revocation in
 * chrome://extensions while the form stays open). Never requests anything.
 * @param {object} entry - Registry entry
 * @param {object} stored - Stored `provider:<id>` value
 * @param {(needsGrant:boolean)=>void} onChange - Called with the latest result
 * @returns {{recheck:()=>Promise<void>, unsubscribe:()=>void}}
 */
export const watchSavedAccess = (entry, stored, onChange) => {
  const origin = savedOrigin(entry, stored);
  let alive = true;
  const recheck = async () => {
    if (!origin) {
      if (alive) onChange(false);
      return;
    }
    let granted = false;
    try {
      granted = await hasAccess(origin);
    } catch (e) {
      granted = false;
    }
    if (alive) onChange(!granted);
  };
  const events = [chrome.permissions?.onRemoved, chrome.permissions?.onAdded].filter(Boolean);
  const listener = () => { recheck(); };
  events.forEach((event) => event.addListener(listener));
  recheck();
  return {
    recheck,
    unsubscribe: () => {
      alive = false;
      events.forEach((event) => event.removeListener(listener));
    }
  };
};
