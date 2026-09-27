/**
 * Pure state helpers for the LCSH selection rules editor: the text, the stored
 * value it was loaded from (`base`), and whether another tab changed it (`stale`).
 */

/**
 * Editor state loaded from a stored value.
 * @param {string|null} stored - Stored rules
 * @returns {{text:string, base:string|null, stale:boolean}}
 */
export const initialRulesState = (stored) => ({ text: stored ?? '', base: stored ?? null, stale: false });

/**
 * Whether the editor has unsaved edits.
 * @param {object} state - Editor state
 * @returns {boolean}
 */
export const isRulesDirty = (state) => state.text !== (state.base ?? '');

/**
 * Edit the text.
 * @param {object} state - Editor state
 * @param {string} text - New text
 * @returns {object}
 */
export const editRules = (state, text) => ({ ...state, text });

/**
 * React to a stored change (another tab saved). A clean editor refreshes; a
 * dirty editor keeps its text and becomes stale.
 * @param {object} state - Editor state
 * @param {string|null|undefined} stored - New stored rules
 * @returns {object}
 */
export const applyStoredRules = (state, stored) => {
  if ((stored ?? null) === (state.base ?? null)) return state;
  if (!isRulesDirty(state)) return initialRulesState(stored ?? null);
  return { ...state, stale: true };
};

/**
 * State after a save attempt. On success the saved text becomes the base; text
 * typed while the save was running is kept (it stays an unsaved edit).
 * @param {object} state - Editor state
 * @param {{saved:boolean, value?:string}} result - Result of settings.saveSystemPromptRules()
 * @returns {object}
 */
export const afterRulesSave = (state, result) => {
  if (!result.saved) return { ...state, stale: true };
  if (state.text !== result.value) return { text: state.text, base: result.value, stale: false };
  return initialRulesState(result.value);
};

/**
 * State after a reset attempt. On success the editor shows the saved default
 * only if its text is still what it was when Reset started; text typed during
 * the reset is kept, with the saved default as its base.
 * @param {object} state - Editor state
 * @param {{saved:boolean, value?:string}} result - Result of settings.saveSystemPromptRules()
 * @param {string} snapshot - The editor text when Reset started
 * @returns {object}
 */
export const afterRulesReset = (state, result, snapshot) => {
  if (!result.saved) return { ...state, stale: true };
  if (state.text !== snapshot) return { text: state.text, base: result.value, stale: false };
  return initialRulesState(result.value);
};
