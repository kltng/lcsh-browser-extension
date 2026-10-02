/**
 * History v2 (SPEC-P4 §8): an allowlisting entry builder, field-by-field
 * rebuilding on load, locked read-modify-write storage, and the read-only
 * adapter for entries saved by older versions.
 */
import { selectionsOf } from './pipeline/run';
import { guardExit, documentKeys } from './keyGuard';
import { readStoredApiKeys } from './settings';
import { imageMetadata } from './pipeline/images';
import { makeProvenance, VIAS } from './pipeline/types';

export const HISTORY_KEY = 'conversationHistory';
export const HISTORY_LOCK = 'lcsh-history';
export const MAX_ENTRIES = 25;
export const MAX_TOTAL_BYTES = 6 * 1024 * 1024;
export const MAX_ENTRY_BYTES = 256 * 1024;

export const LEGACY_HEADER = 'Saved by an older version. Its MARC was written by an AI model and was not checked.';
export const LEGACY_MARC_LABEL = 'Unverified AI-written MARC (older version)';
export const LEGACY_TEXT_LABEL = 'Text from the older version (not checked)';
export const LEGACY_COPY_PREFIX = 'UNVERIFIED (older version): ';

const MESSAGES = {
  too_large: 'This result is too large to save in the history (the limit is 256 KiB per entry).',
  write_failed: 'The history could not be saved. The saved history was not changed.',
  read_failed: 'The history could not be loaded.'
};

/** A history failure with a local message. */
export class HistoryError extends Error {
  /** @param {'too_large'|'write_failed'|'read_failed'} kind - Failure kind */
  constructor(kind) {
    super(MESSAGES[kind]);
    this.name = 'HistoryError';
    this.kind = kind;
  }
}

/**
 * UTF-8 size of a value serialized as JSON.
 * @param {any} value - Value
 * @returns {number}
 */
export const serializedBytes = (value) => new TextEncoder().encode(JSON.stringify(value)).length;

const str = (v) => (typeof v === 'string' ? v : '');
const strOrNull = (v) => (typeof v === 'string' ? v : null);
const intOrNull = (v) => (Number.isInteger(v) ? v : null);
const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);

const provenance = (p) => (p && typeof p === 'object' ? { providerId: str(p.providerId), model: str(p.model) } : null);

const replacementFromOf = (list) => arr(list).map((f) => obj(f))
  .map((f) => ({ authority: str(f.authority), localId: str(f.localId), label: str(f.label) }));

const candidateOf = (c, backend) => {
  const out = {
    cid: str(c.cid), authority: str(c.authority), localId: str(c.localId), uri: str(c.uri), label: str(c.label),
    marcKey: strOrNull(c.marcKey), matchClass: str(c.matchClass),
    rdfTypes: arr(c.rdfTypes).filter((t) => typeof t === 'string'),
    // An entry saved before P5 has no per-candidate source; the entry backend fills it.
    source: typeof c.source === 'string' ? c.source : backend
  };
  if (VIAS.includes(c.via)) out.via = c.via;
  if (Array.isArray(c.replacementFrom)) out.replacementFrom = replacementFromOf(c.replacementFrom);
  if (typeof c.marcKeySource === 'string') out.marcKeySource = c.marcKeySource;
  return out;
};

const replacementNoteOf = (n) => ({
  fromAuthority: str(n.fromAuthority), fromLocalId: str(n.fromLocalId), fromLabel: str(n.fromLabel),
  targetAuthority: str(n.targetAuthority), targetLocalId: str(n.targetLocalId),
  reason: pick(n.reason, ['not-in-database', 'deprecated-target'], 'not-in-database')
});

/**
 * The entry-level backend, DERIVED from the saved results' provenance (§9):
 * one backend if they all agree, else `'mixed'`. History never reads the
 * current installation.
 * @param {object[]} results - The saved lookup results
 * @returns {'loc-api'|'local-db'|'mixed'}
 */
export const derivedBackend = (results) => {
  const backends = new Set(arr(results).map((r) => makeProvenance(obj(r).provenance).backend));
  if (backends.size === 0) return 'loc-api';
  if (backends.size === 1) return [...backends][0];
  return 'mixed';
};

const selectionOf = (s) => ({
  suggestionId: str(s.suggestionId), cid: strOrNull(s.cid), method: pick(s.method, ['ai', 'exact', 'manual', 'none'], 'none'),
  noneReason: strOrNull(s.noneReason), confidence: intOrNull(s.confidence), lexicalSimilarity: intOrNull(s.lexicalSimilarity),
  mainHeadingOnly: s.mainHeadingOnly === true, droppedSubdivisions: arr(s.droppedSubdivisions).filter((d) => typeof d === 'string')
});

const marcOf = (m) => ({
  status: pick(m.status, ['from-authority', 'unavailable'], 'unavailable'),
  tag: strOrNull(m.tag), ind1: strOrNull(m.ind1), ind2: strOrNull(m.ind2),
  subfields: arr(m.subfields).filter((sf) => Array.isArray(sf) && sf.length === 2 && sf.every((x) => typeof x === 'string'))
    .map(([code, value]) => [code, value]),
  text: strOrNull(m.text), reason: strOrNull(m.reason)
});

/**
 * A saved suggestion's authorship: missing → 'ai' (entries saved before
 * SPEC-UI2), 'ai' / 'user' kept, anything else 'unknown'.
 * @param {any} value - Stored `source`
 * @returns {'ai'|'user'|'unknown'}
 */
export const suggestionSourceOf = (value) => {
  if (value === undefined) return 'ai';
  return value === 'ai' || value === 'user' ? value : 'unknown';
};

/**
 * Rebuild a v2 entry field by field (allowlist; nothing is spread).
 * @param {object} raw - Stored or built v2 entry
 * @returns {object}
 */
export const rebuildV2 = (raw) => {
  const r = obj(raw);
  const bib = obj(r.bibliographicInfo);
  const lookup = obj(r.lookup);
  const results = arr(lookup.results).map((x) => {
    const one = obj(x);
    return {
      suggestionId: str(one.suggestionId), outcome: pick(one.outcome, ['found', 'no-results', 'failed', 'partial'], 'failed'),
      errorKind: strOrNull(one.errorKind), searchedAt: str(one.searchedAt),
      // Pre-P5 entries have no provenance and no notes: online, nothing replaced.
      provenance: makeProvenance(one.provenance),
      replacementNotes: arr(one.replacementNotes).map((n) => replacementNoteOf(obj(n))),
      candidates: arr(one.candidates)
    };
  });
  const backend = derivedBackend(results);
  const prov = obj(r.provenance);
  return {
    v: 2,
    id: str(r.id),
    timestamp: str(r.timestamp),
    bibliographicInfo: {
      title: str(bib.title), author: str(bib.author), abstract: str(bib.abstract),
      tableOfContents: str(bib.tableOfContents), notes: str(bib.notes), images: imageMetadata(bib.images)
    },
    subjectAnalysis: str(r.subjectAnalysis),
    suggestMode: pick(r.suggestMode, ['json', 'text-fallback'], 'json'),
    suggestions: arr(r.suggestions).map((s) => ({
      id: str(s?.id), heading: str(s?.heading), kind: pick(s?.kind, ['topical', 'geographic', 'name', 'genre', 'unknown'], 'unknown'),
      reason: str(s?.reason),
      // SPEC-UI2 §2: older v2 entries have no field (AI-written then); an
      // unsupported explicit value is never shown as known AI or user authorship.
      source: suggestionSourceOf(s?.source)
    })),
    lookup: {
      backend,
      results: results.map((x) => ({
        ...x,
        candidates: x.candidates.map((c) => candidateOf(obj(c), x.provenance.backend === 'mixed' ? 'loc-api' : x.provenance.backend))
      }))
    },
    selectMode: pick(r.selectMode, ['ai', 'exact-fallback'], 'ai'),
    selections: arr(r.selections).map((s) => selectionOf(obj(s))),
    recommendations: arr(r.recommendations).map((x) => {
      const rec = obj(x);
      return {
        cid: str(rec.cid), label: str(rec.label), authority: str(rec.authority), localId: str(rec.localId), uri: str(rec.uri),
        source: str(rec.source) || backend,
        ...(typeof rec.marcKeySource === 'string' ? { marcKeySource: rec.marcKeySource } : {}),
        selections: arr(rec.selections).map((s) => {
          const o = obj(s);
          return {
            suggestionId: strOrNull(o.suggestionId), method: pick(o.method, ['ai', 'exact', 'manual', 'none'], 'none'),
            confidence: intOrNull(o.confidence), lexicalSimilarity: intOrNull(o.lexicalSimilarity)
          };
        }),
        marc: marcOf(obj(rec.marc))
      };
    }),
    provenance: { suggest: provenance(prov.suggest), select: provenance(prov.select) }
  };
};

/**
 * Build a v2 entry from the run state. The bibliographic info is the run's
 * input snapshot (taken when the run started: text fields and image metadata
 * only), NEVER the current form, so the entry describes exactly the input the
 * model received. Images are reduced to metadata in a COPY.
 * @param {{run:object, id?:string, timestamp?:string}} args - Run state, optional id and time
 * @returns {object}
 */
export const buildHistoryEntry = ({ run, id = crypto.randomUUID(), timestamp = new Date().toISOString() }) => {
  const suggestions = run.suggest?.suggestions || [];
  return rebuildV2({
    id, timestamp, bibliographicInfo: run.input || {},
    subjectAnalysis: run.suggest?.subjectAnalysis, suggestMode: run.suggest?.suggestMode, suggestions,
    // The entry-level backend is DERIVED in rebuildV2 from the saved results.
    lookup: { results: suggestions.map((s) => run.lookup.results[s.id]).filter(Boolean) },
    selectMode: run.select.mode === 'exact-fallback' ? 'exact-fallback' : 'ai',
    selections: selectionsOf(run),
    recommendations: run.recommendations || [],
    provenance: { suggest: run.run.snapshots.suggest, select: run.run.snapshots.select }
  });
};

/**
 * A stored entry for display: v2 entries are rebuilt; older entries are kept as stored.
 * @param {any} raw - Stored entry
 * @returns {object}
 */
export const rebuildEntry = (raw) => (raw && raw.v === 2 ? rebuildV2(raw) : raw);

/**
 * The run-like view of a v2 entry, used to re-render steps 2–4 read-only.
 * @param {object} entry - Rebuilt v2 entry
 * @returns {object}
 */
export const runViewOf = (entry) => ({
  suggest: { subjectAnalysis: entry.subjectAnalysis, suggestions: entry.suggestions, suggestMode: entry.suggestMode },
  results: Object.fromEntries(entry.lookup.results.map((r) => [r.suggestionId, r])),
  selections: entry.selections,
  selectMode: entry.selectMode,
  recommendations: entry.recommendations
});

/**
 * Copy text of legacy (AI-written) MARC: every line is prefixed.
 * @param {string} text - Legacy MARC text
 * @returns {string}
 */
export const legacyMarcCopyText = (text) => String(text ?? '').split('\n').map((line) => `${LEGACY_COPY_PREFIX}${line}`).join('\n');

/**
 * Read-only view model of an entry saved by v1.1.0 or P3 (no `v`). The stored original is not changed.
 * @param {object} raw - Stored legacy entry
 * @returns {object}
 */
export const adaptLegacyEntry = (raw) => {
  const r = obj(raw);
  const bib = obj(r.bibliographicInfo);
  const marcRecords = obj(r.marcRecords);
  const items = arr(r.finalRecommendations)
    .filter((rec) => rec && (rec.similarity || 0) > 30 && rec.bestMatch)
    .map((rec) => ({
      heading: str(rec.bestMatch.heading) || str(rec.term),
      term: str(rec.term),
      similarity: Number.isFinite(rec.similarity) ? rec.similarity : null,
      identifier: str(rec.bestMatch.identifier),
      link: str(rec.bestMatch.uri),
      justification: str(rec.justification),
      marc: typeof marcRecords[rec.term] === 'string' ? marcRecords[rec.term] : str(rec.marc)
    }));
  return {
    id: r.id,
    timestamp: str(r.timestamp),
    title: str(bib.title),
    author: str(bib.author),
    bibliographicInfo: bib,
    averageSimilarity: Number.isFinite(r.averageSimilarity) ? r.averageSimilarity : null,
    specialConsiderations: str(obj(r.initialSuggestions).specialConsiderations),
    suggestionProvenance: r.suggestionProvenance ? provenance(r.suggestionProvenance) : null,
    marcProvenance: r.marcProvenance ? provenance(r.marcProvenance) : null,
    items
  };
};

const storage = () => chrome.storage.local;
const withHistoryLock = (fn) => navigator.locks.request(HISTORY_LOCK, { mode: 'exclusive' }, fn);
const readStored = async () => {
  const got = await storage().get([HISTORY_KEY]);
  return Array.isArray(got?.[HISTORY_KEY]) ? got[HISTORY_KEY] : [];
};
const write = async (next) => {
  try {
    await storage().set({ [HISTORY_KEY]: next });
  } catch (e) {
    throw new HistoryError('write_failed');
  }
};

/**
 * Load the history (not locked; plain read).
 * @returns {Promise<object[]>}
 */
export const loadHistory = async () => {
  try {
    return (await readStored()).map(rebuildEntry);
  } catch (e) {
    throw new HistoryError('read_failed');
  }
};

/**
 * The stored entry for the exit key check, without the MARC STRUCTURE codes
 * (tag, indicators, subfield codes). Those are fixed one-to-three-character
 * codes from the LC authority record and our MARC builder ("a", "0", "_"),
 * never model text; with a one-character key such as LM Studio's "a" they
 * would refuse every save. Every subfield VALUE and every other field is
 * still checked.
 * @param {object} entry - Serialized-and-parsed v2 entry
 * @returns {object}
 */
const withoutMarcCodes = (entry) => ({
  ...entry,
  recommendations: (entry.recommendations || []).map((rec) => (rec?.marc ? {
    ...rec,
    marc: {
      ...rec.marc,
      tag: null,
      ind1: null,
      ind2: null,
      subfields: Array.isArray(rec.marc.subfields) ? rec.marc.subfields.map((pair) => [null, Array.isArray(pair) ? pair[1] : pair]) : rec.marc.subfields
    }
  } : rec))
});

/**
 * Save an entry: a locked read-modify-write; the oldest entries are evicted
 * (max 25 entries and 6 MiB) in the SAME write. Resolves after the write is confirmed.
 * @param {object} entry - v2 entry from buildHistoryEntry()
 * @returns {Promise<object[]>} - The history after the save
 */
export const saveHistoryEntry = async (entry) => {
  const clean = rebuildV2(entry);
  if (serializedBytes(clean) > MAX_ENTRY_BYTES) throw new HistoryError('too_large');
  // Exit (b), P6 fix 13: the FINAL entry, exactly as it will be stored
  // (serialized and read back), is checked against every key of this
  // document — the runs' keys and every key stored now. Nothing is written
  // when it repeats one.
  guardExit('history', withoutMarcCodes(JSON.parse(JSON.stringify(clean))), [...documentKeys(), ...(await readStoredApiKeys())]);
  return withHistoryLock(async () => {
    let next = [...(await readStored()), clean];
    while (next.length > 1 && (next.length > MAX_ENTRIES || serializedBytes(next) > MAX_TOTAL_BYTES)) next = next.slice(1);
    await write(next);
    return next.map(rebuildEntry);
  });
};

/**
 * Delete one entry (locked read-modify-write).
 * @param {string|number} id - Entry id (older entries use numbers)
 * @returns {Promise<object[]>}
 */
export const deleteHistoryEntry = (id) => withHistoryLock(async () => {
  const next = (await readStored()).filter((e) => e?.id !== id);
  await write(next);
  return next.map(rebuildEntry);
});

/**
 * Clear the history (locked).
 * @returns {Promise<object[]>}
 */
export const clearHistory = () => withHistoryLock(async () => {
  await write([]);
  return [];
});

/**
 * Subscribe to history changes made in any tab.
 * @param {(entries:object[])=>void} cb - Called with the rebuilt list
 * @returns {()=>void} - Unsubscribe
 */
export const onHistoryChanged = (cb) => {
  const listener = (changes, area) => {
    if (area !== 'local' || !Object.hasOwn(changes, HISTORY_KEY)) return;
    const value = changes[HISTORY_KEY].newValue;
    cb((Array.isArray(value) ? value : []).map(rebuildEntry));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
};
