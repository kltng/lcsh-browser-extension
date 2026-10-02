/**
 * The app's route, read LIVE (ui-2c item 2). The location hash `#settings`
 * opens Settings; every other hash shows the workflow. A Next continuation
 * checks this at the moment it resumes, so a browser hash change whose
 * `hashchange` event has not been delivered yet still ends it.
 */

export const SETTINGS_HASH = '#settings';

/**
 * Whether the current location shows the workflow (not Settings).
 * @param {{location?:{hash?:string}}} [win] - The window
 * @returns {boolean}
 */
export const isWorkflowRoute = (win = typeof window !== 'undefined' ? window : undefined) => (
  (win?.location?.hash ?? '') !== SETTINGS_HASH
);
