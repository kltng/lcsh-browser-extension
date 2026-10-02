/**
 * SPEC-UI2 §4: the saved subfield delimiter, kept current in open views (no
 * lookup or selection is rerun when it changes).
 */
import { useEffect, useState } from 'react';
import { getSettings, onSettingsChanged, DELIMITER_KEY } from '../services/settings';
import { resolveDelimiter, DEFAULT_DELIMITER } from '../services/pipeline/marcFormat';

/**
 * The current delimiter preference (`$` until it is read).
 * @returns {'$'|'‡'}
 */
export const useSubfieldDelimiter = () => {
  const [delimiter, setDelimiter] = useState(DEFAULT_DELIMITER);
  useEffect(() => {
    let alive = true;
    const read = () => getSettings()
      .then((settings) => { if (alive) setDelimiter(resolveDelimiter(settings.subfieldDelimiter)); })
      .catch(() => {});
    read();
    const stop = onSettingsChanged((changes) => {
      if (Object.hasOwn(changes, DELIMITER_KEY)) setDelimiter(resolveDelimiter(changes[DELIMITER_KEY]?.newValue));
    });
    return () => {
      alive = false;
      stop();
    };
  }, []);
  return delimiter;
};

export default useSubfieldDelimiter;
