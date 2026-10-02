/**
 * Re-render a view that hides key-repeating text whenever the known keys
 * change (they load asynchronously and change with the settings).
 */
import React, { useSyncExternalStore } from 'react';
import { Alert, Button } from '@mui/material';
import {
  subscribeKeys, keysVersion, keysState, retryStoredKeys, KEYS_FAILED_MESSAGE
} from '../services/keyGuard';

/**
 * Subscribe the calling component to the key registry.
 * @returns {number} - The current keys version (only its changes matter)
 */
export const useKnownKeys = () => useSyncExternalStore(subscribeKeys, keysVersion, keysVersion);

/**
 * P6 fix 16: after a FAILED first key read, a page shows this local message
 * with "Try again" (which reads the stored keys again) instead of "Loading…"
 * for ever. Nothing is rendered in any other state.
 * @returns {JSX.Element|null}
 */
export const KeysUnavailableNotice = () => {
  useKnownKeys();
  if (keysState() !== 'failed') return null;
  return (
    <Alert
      severity="warning"
      sx={{ mb: 2 }}
      action={<Button color="inherit" size="small" onClick={() => { retryStoredKeys(); }}>Try again</Button>}
    >
      {KEYS_FAILED_MESSAGE}
    </Alert>
  );
};

export default useKnownKeys;
