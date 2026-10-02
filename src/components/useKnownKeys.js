/**
 * Re-render a view that hides key-repeating text whenever the known keys
 * change (they load asynchronously and change with the settings).
 */
import { useSyncExternalStore } from 'react';
import { subscribeKeys, keysVersion } from '../services/keyGuard';

/**
 * Subscribe the calling component to the key registry.
 * @returns {number} - The current keys version (only its changes matter)
 */
export const useKnownKeys = () => useSyncExternalStore(subscribeKeys, keysVersion, keysVersion);

export default useKnownKeys;
