/**
 * The shared catch-block logging of the workflow screens (moved from
 * legacyBridge.js, unchanged behavior).
 */
import { ProviderError } from '../providers/errors';

/**
 * Log a workflow error. Safe by construction: a ProviderError logs only
 * {providerId, kind, status}; any other value logs only a fixed
 * classification from `typeof` and a fixed message. No property of a
 * non-ProviderError value is read (a getter could throw or return a secret).
 * @param {string} label - What failed
 * @param {any} err - The error
 */
export function logWorkflowError(label, err) {
  let isProviderError = false;
  try {
    isProviderError = err instanceof ProviderError;
  } catch (e) {
    // A hostile value (for example a Proxy) is treated as a non-provider error.
  }
  if (isProviderError) {
    console.error(label, { providerId: err.providerId, kind: err.kind, status: err.status });
    return;
  }
  const LOCAL_CLASSES = {
    object: 'non-provider error (object)',
    string: 'non-provider error (string)',
    undefined: 'non-provider error (undefined)'
  };
  const errorType = LOCAL_CLASSES[typeof err] || 'non-provider error (other)';
  console.error(label, { errorType, message: 'Unexpected error (details are not logged).' });
}

export default logWorkflowError;
