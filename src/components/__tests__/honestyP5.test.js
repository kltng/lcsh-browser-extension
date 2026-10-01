import { describe, it, expect, vi } from 'vitest';
import { MatchesPanel } from '../ScrapedResults';
import { RecommendationsPanel, hasUnresolvedNameKeys } from '../FinalRecommendations';
import {
  LocalDbSettings, ConfirmationBody, subscribePanel, confirmationLines, formatBytes, KEEP_TAB_OPEN, FULL_WARNING, COMMITTING_TEXT
} from '../LocalDbSettings';
import { V2EntryView } from '../ConversationHistory';
import { lcLink, sourceLine, viaNote, replacementNoteText, LOCAL_DB_ERROR_TEXT } from '../pipelineText';
import { buildHistoryEntry } from '../../services/history';
import { selectionsOf } from '../../services/pipeline/run';
import { renderHtml, textOf } from '../../../test/render';
import { builtRun, SUGGESTIONS, RESULTS, C, cand, result } from '../../../test/pipelineFixtures';

const IDENTITY = { profile: 'core', release: '2026.09.27.1', releaseCommit: 'a'.repeat(40), file: '/db-1.db' };

const localCand = (over = {}) => ({ ...cand('lcsh', 'sh85021262', 'Cats', 'exact-full', '150 0$aCats'), source: 'local-db', via: 'label', ...over });
const nameCand = (over = {}) => ({ ...cand('lcnaf', 'n79091264', 'Kurosawa, Akira, 1910-1998', 'exact-full', null), source: 'local-db', via: 'label', ...over });

const LOCAL_RESULTS = {
  s1: {
    ...result('s1', 'found', [
      localCand(),
      localCand({ cid: 'lcsh:sh85007901', localId: 'sh85007901', uri: 'http://id.loc.gov/authorities/subjects/sh85007901', label: 'Art, Slavic', matchClass: 'keyword', via: 'variant' }),
      localCand({ cid: 'lcsh:sh2021004026', localId: 'sh2021004026', uri: 'http://id.loc.gov/authorities/subjects/sh2021004026', label: 'New heading', matchClass: 'keyword', via: 'replacement', replacementFrom: [{ authority: 'lcsh', localId: 'sh00000273', label: 'Child concentration camp inmates' }] })
    ]),
    provenance: { backend: 'local-db', ...IDENTITY },
    replacementNotes: [{
      fromAuthority: 'lcsh', fromLocalId: 'sh0', fromLabel: 'Gay pornographic films',
      targetAuthority: 'lcgft', targetLocalId: 'gf2011026460', reason: 'not-in-database'
    }]
  },
  s5: {
    ...result('s5', 'found', [nameCand()]),
    provenance: { backend: 'mixed', ...IDENTITY },
    replacementNotes: []
  },
  s4: { ...result('s4', 'failed', [], 'local_db'), provenance: { backend: 'local-db', ...IDENTITY }, replacementNotes: [] }
};

const LOCAL_SUGGESTIONS = [
  { id: 's1', heading: 'Cats', kind: 'topical', reason: 'Cats.' },
  { id: 's5', heading: 'Kurosawa, Akira', kind: 'name', reason: 'Director.' },
  { id: 's4', heading: 'Zzz', kind: 'topical', reason: 'Nothing.' }
];

const ALLOWED_IDS = new Set(Object.values(LOCAL_RESULTS).flatMap((r) => r.candidates.map((c) => c.localId)));
const ALLOWED_LINKS = new Set(Object.values(LOCAL_RESULTS).flatMap((r) => r.candidates.map((c) => lcLink(c.uri))));
const hrefsOf = (html) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
const lcIdsOf = (text) => [...text.matchAll(/LC ID: (\S+)/g)].map((m) => m[1]);

const expectHonest = (html, { ids = ALLOWED_IDS, links = ALLOWED_LINKS } = {}) => {
  const text = textOf(html);
  expect(text).not.toMatch(/verif/i);
  expect(text).not.toMatch(/not in LC|not found in LC/i);
  for (const href of hrefsOf(html)) expect(links.has(href) || href.startsWith('https://huggingface.co/'), href).toBe(true);
  for (const id of lcIdsOf(text)) expect(ids.has(id), id).toBe(true);
  return text;
};

describe('[P5 row12] the Matches step with local and mixed candidates', () => {
  const selections = LOCAL_SUGGESTIONS.map((s) => ({
    suggestionId: s.id, cid: null, method: 'none', noneReason: 'not-chosen', confidence: null,
    lexicalSimilarity: null, mainHeadingOnly: false, droppedSubdivisions: []
  }));

  it('names the source of each candidate list, and both for mixed routing', () => {
    const html = renderHtml(MatchesPanel, {
      suggestions: LOCAL_SUGGESTIONS, results: LOCAL_RESULTS, selections, mode: 'ai', onChoose: vi.fn(), onRetry: vi.fn()
    });
    const text = expectHonest(html);
    expect(text).toContain('Source: Local database (release 2026.09.27.1)');
    expect(text).toContain('Source: Local database (release 2026.09.27.1) and Library of Congress online');
    expect(sourceLine(undefined)).toBe('Library of Congress online');
    expect(sourceLine({ backend: 'local-db' })).toBe('Local database');
  });

  it('a variant match is explained, never turned into an exact acceptance', () => {
    const html = renderHtml(MatchesPanel, {
      suggestions: LOCAL_SUGGESTIONS, results: LOCAL_RESULTS, selections, mode: 'ai', onChoose: vi.fn(), onRetry: vi.fn()
    });
    const text = expectHonest(html);
    expect(text).toContain('matched a variant name');
    // The variant row keeps the class its own preferred label earns.
    expect(text).toContain('keyword');
    expect(viaNote({ via: 'variant' })).toBe('matched a variant name');
    expect(viaNote({ via: 'label' })).toBeNull();
  });

  it('a replacement says which old heading it replaces', () => {
    const text = expectHonest(renderHtml(MatchesPanel, {
      suggestions: LOCAL_SUGGESTIONS, results: LOCAL_RESULTS, selections, mode: 'ai', onChoose: vi.fn(), onRetry: vi.fn()
    }));
    expect(text).toContain('replaces the old heading Child concentration camp inmates');
  });

  it('an unresolved replacement is a note, never a candidate', () => {
    const text = expectHonest(renderHtml(MatchesPanel, {
      suggestions: LOCAL_SUGGESTIONS, results: LOCAL_RESULTS, selections, mode: 'ai', onChoose: vi.fn(), onRetry: vi.fn()
    }));
    expect(text).toContain('The old heading Gay pornographic films names a replacement (gf2011026460): replacement not in this database.');
    expect(lcIdsOf(text)).toEqual([]);
    expect(replacementNoteText({ fromLabel: 'A', targetLocalId: 'x', reason: 'deprecated-target' }))
      .toBe('The old heading A names a replacement (x): the replacement is itself an old heading.');
  });

  it('a local failure is reported in plain words, with Retry lookup', () => {
    const text = expectHonest(renderHtml(MatchesPanel, {
      suggestions: LOCAL_SUGGESTIONS, results: LOCAL_RESULTS, selections, mode: 'ai', onChoose: vi.fn(), onRetry: vi.fn()
    }));
    expect(text).toContain(`Lookup failed: ${LOCAL_DB_ERROR_TEXT}`);
    expect(LOCAL_DB_ERROR_TEXT).toBe('The local database could not answer this search');
    expect(text).toContain('Retry lookup');
  });

  it('the online P4 panel is unchanged: no source line claims a local database', () => {
    const built = builtRun();
    const text = expectHonest(
      renderHtml(MatchesPanel, {
        suggestions: SUGGESTIONS, results: RESULTS, selections: selectionsOf(built), mode: 'ai', manual: built.select.manual
      }),
      { ids: new Set(Object.values(C).map((c) => c.localId)), links: new Set(Object.values(C).map((c) => lcLink(c.uri))) }
    );
    expect(text).toContain('Source: Library of Congress online');
    expect(text).not.toContain('Local database');
  });
});

describe('[P5 row12] the Recommendations step with a local name', () => {
  const rec = (marc) => ({
    cid: 'lcnaf:n79091264', label: 'Kurosawa, Akira, 1910-1998', authority: 'lcnaf', localId: 'n79091264',
    uri: 'http://id.loc.gov/authorities/names/n79091264', source: 'local-db',
    selections: [{ suggestionId: 's5', method: 'manual', confidence: null, lexicalSimilarity: 90 }],
    marc
  });

  it('a name with no key shows the reason, and never an invented key', () => {
    const offline = rec({ status: 'unavailable', tag: null, ind1: null, ind2: null, subfields: [], text: null, reason: 'MARC not available offline' });
    const html = renderHtml(RecommendationsPanel, { recommendations: [offline], selections: [], suggestions: LOCAL_SUGGESTIONS });
    const text = expectHonest(html, { ids: new Set(['n79091264']), links: new Set([lcLink(offline.uri)]) });
    expect(text).toContain('MARC not available offline');
    expect(text).not.toContain('MARC record');
    expect(hasUnresolvedNameKeys([offline])).toBe(true);
  });

  // Live finding (lead): the §7 reason already starts with "MARC not
  // available", so the card read "MARC not available (MARC not available offline)".
  it('the card shows "MARC not available offline" exactly ONCE; other reasons keep the bracketed form', () => {
    const unavailable = (reason) => ({ status: 'unavailable', tag: null, ind1: null, ind2: null, subfields: [], text: null, reason });
    const offline = renderHtml(RecommendationsPanel, {
      recommendations: [rec(unavailable('MARC not available offline'))], selections: [], suggestions: LOCAL_SUGGESTIONS
    });
    const text = textOf(offline);
    expect(text.split('MARC not available').length - 1).toBe(1);
    expect(text).toContain('MARC not available offline');
    expect(text).not.toContain('MARC not available (MARC not available offline)');

    for (const reason of ['no key', 'Name MARC-key lookup failed', 'No matching name returned by this search', 'key does not match label']) {
      const other = textOf(renderHtml(RecommendationsPanel, {
        recommendations: [rec(unavailable(reason))], selections: [], suggestions: LOCAL_SUGGESTIONS
      }));
      expect(other, reason).toContain(`MARC not available (${reason})`);
    }
  });

  it('a resolved key is shown as a MARC field built from the authority key', () => {
    const resolved = {
      ...rec({
        status: 'from-authority', tag: '600', ind1: '1', ind2: '0',
        subfields: [['a', 'Kurosawa, Akira,'], ['d', '1910-1998']],
        text: '600 10 $a Kurosawa, Akira, $d 1910-1998', reason: null
      }),
      marcKeySource: 'loc-api'
    };
    const html = renderHtml(RecommendationsPanel, { recommendations: [resolved], selections: [], suggestions: LOCAL_SUGGESTIONS });
    const text = expectHonest(html, { ids: new Set(['n79091264']), links: new Set([lcLink(resolved.uri)]) });
    expect(text).toContain('MARC field (text form):');
    expect(text).toContain('600 10 $a Kurosawa, Akira, $d 1910-1998');
    expect(hasUnresolvedNameKeys([resolved])).toBe(false);
  });

  it('an LCSH row from the local database needs no online key', () => {
    const local = { ...rec({ status: 'from-authority', tag: '650', ind1: '_', ind2: '0', subfields: [['a', 'Cats']], text: '650 _0 $a Cats', reason: null }), cid: 'lcsh:sh85021262', authority: 'lcsh', localId: 'sh85021262', uri: 'http://id.loc.gov/authorities/subjects/sh85021262', label: 'Cats' };
    expect(hasUnresolvedNameKeys([local])).toBe(false);
  });
});

describe('[P5 row12] a local run re-renders honestly from history', () => {
  it('a v2 entry with local provenance keeps its source line and its notes', () => {
    const run = builtRun();
    const entry = buildHistoryEntry({
      run: {
        ...run,
        lookup: { ...run.lookup, results: { ...run.lookup.results, s1: { ...run.lookup.results.s1, ...LOCAL_RESULTS.s1, suggestionId: 's1' } } }
      }
    });
    const html = renderHtml(V2EntryView, { entry });
    const text = textOf(html);
    expect(text).not.toMatch(/verif/i);
    expect(text).toContain('Source: Local database (release 2026.09.27.1)');
    expect(text).toContain('matched a variant name');
    expect(text).toContain('replaces the old heading Child concentration camp inmates');
  });
});

describe('[P5 row12] the Lookup source settings section', () => {
  const pointer = {
    release: '2026.09.27.1',
    profiles: {
      core: { gzSize: 62_000_000, dbSize: 205_000_000 },
      full: { gzSize: 1_870_000_000, dbSize: 5_400_000_000 }
    }
  };

  it('offers both profiles with the pointer sizes, and warns about the full one', () => {
    const html = renderHtml(LocalDbSettings, {
      lookupBackend: 'loc-api', installed: null, state: null, pointer, operation: null,
      onBackendChange: vi.fn(), onInstall: vi.fn(), onRepair: vi.fn(), onUninstall: vi.fn(),
      onCancel: vi.fn(), onRetryOwnership: vi.fn()
    });
    const text = textOf(html);
    expect(text).toContain('Library of Congress (online)');
    expect(text).toContain('Core — subjects and genres (download 62 MB, disk 205 MB)');
    expect(text).toContain('Names are looked up online.');
    expect(text).toContain('Full — also 12 million names (download 1.87 GB, disk 5.40 GB)');
    expect(text).toContain(FULL_WARNING);
    expect(text).not.toMatch(/free disk space/i);
  });

  it('shows the §2 fallback message when local-db is selected with nothing installed', () => {
    const text = textOf(renderHtml(LocalDbSettings, {
      lookupBackend: 'local-db', installed: null, state: null, pointer: null, operation: null,
      onBackendChange: vi.fn(), onInstall: vi.fn(), onRepair: vi.fn(), onUninstall: vi.fn(),
      onCancel: vi.fn(), onRetryOwnership: vi.fn()
    }));
    expect(text).toContain('Local database not installed; using the Library of Congress online.');
  });

  it('Cancel is disabled from the moment the install is committing', () => {
    const downloading = textOf(renderHtml(LocalDbSettings, {
      lookupBackend: 'local-db', installed: null, state: null, pointer, progress: { phase: 'downloading', done: 1_000_000, total: 62_000_000 },
      operation: { operationId: 'op1', phase: 'downloading' },
      onBackendChange: vi.fn(), onInstall: vi.fn(), onRepair: vi.fn(), onUninstall: vi.fn(), onCancel: vi.fn(), onRetryOwnership: vi.fn()
    }));
    expect(downloading).toContain('Cancel');
    expect(downloading).toContain(KEEP_TAB_OPEN);

    const committingHtml = renderHtml(LocalDbSettings, {
      lookupBackend: 'local-db', installed: null, state: null, pointer, progress: null,
      operation: { operationId: 'op1', phase: 'committing' },
      onBackendChange: vi.fn(), onInstall: vi.fn(), onRepair: vi.fn(), onUninstall: vi.fn(), onCancel: vi.fn(), onRetryOwnership: vi.fn()
    });
    expect(textOf(committingHtml)).toContain(COMMITTING_TEXT);
    expect(committingHtml).toMatch(/disabled=""[^>]*>Finishing install…|Finishing install…/);
    expect(committingHtml).toContain('disabled');
  });

  it('every §3 state is shown with what the user can do', () => {
    for (const [state, expected] of Object.entries({
      'other-tab': 'The local database is open in another tab of this extension.',
      'repair-needed': 'The local database is damaged or missing.',
      'recovery-unavailable': 'Local database settings could not be read.'
    })) {
      const html = renderHtml(LocalDbSettings, {
        lookupBackend: 'local-db', installed: { profile: 'core', release: '2026.09.27.1', dbSize: 205_000_000, installedAt: '2026-09-27T00:00:00.000Z' },
        state, pointer: null, operation: null,
        onBackendChange: vi.fn(), onInstall: vi.fn(), onRepair: vi.fn(), onUninstall: vi.fn(), onCancel: vi.fn(), onRetryOwnership: vi.fn()
      });
      const text = textOf(html);
      expect(text).toContain(expected);
      if (state === 'other-tab') expect(text).toContain('Try again');
      expect(text).toContain('Repair');
      expect(text).toContain('Uninstall');
    }
  });

  it('the confirmation names the additional and the peak space, from the pointer', () => {
    const lines = confirmationLines({
      profile: 'full', entry: pointer.profiles.full, release: '2026.09.27.1',
      installed: { dbSize: 205_000_000 }
    });
    expect(lines).toContain('Download: 1.87 GB');
    expect(lines).toContain('Database size: 5.40 GB');
    expect(lines).toContain('Additional space needed now: 5.40 GB');
    expect(lines).toContain('Peak database storage during the install: 5.61 GB');
    expect(lines).toContain(KEEP_TAB_OPEN);
    expect(lines).toContain(FULL_WARNING);
    // With nothing installed the peak is the new database alone.
    expect(confirmationLines({ profile: 'core', entry: pointer.profiles.core, release: '2026.09.27.1', installed: null }))
      .toContain('Peak database storage during the install: 205 MB');
  });

  it('the confirmation is shown before any download, with every §4.3 line', () => {
    const html = renderHtml(ConfirmationBody, {
      pending: { profile: 'full', repair: false, entry: pointer.profiles.full },
      release: '2026.09.27.1',
      installed: { dbSize: 205_000_000 },
      onConfirm: vi.fn(),
      onClose: vi.fn()
    });
    const text = textOf(html);
    expect(text).toContain('Profile: full');
    expect(text).toContain('Release: 2026.09.27.1');
    expect(text).toContain('Download: 1.87 GB');
    expect(text).toContain('Peak database storage during the install: 5.61 GB');
    expect(text).toContain(KEEP_TAB_OPEN);
    expect(text).toContain(FULL_WARNING);
    expect(text).toContain('Download');
    expect(text).toContain('Cancel');

    // Nothing is shown until a profile was chosen.
    expect(textOf(renderHtml(ConfirmationBody, {
      pending: null, release: null, installed: null, onConfirm: vi.fn(), onClose: vi.fn()
    }))).not.toContain(KEEP_TAB_OPEN);
  });

  it('the storage estimate is never called free disk space', () => {
    const text = textOf(renderHtml(LocalDbSettings, {
      lookupBackend: 'local-db', installed: null, state: null, pointer: null, operation: null,
      storageEstimate: { usage: 210_000_000, quota: 60_000_000_000 },
      onBackendChange: vi.fn(), onInstall: vi.fn(), onRepair: vi.fn(), onUninstall: vi.fn(), onCancel: vi.fn(), onRetryOwnership: vi.fn()
    }));
    expect(text).toContain('Estimated storage used by this extension: 210 MB of a 60.00 GB quota.');
    expect(text).toContain('This is not free disk space.');
  });

  it('formatBytes never invents a number', () => {
    expect(formatBytes(0)).toBe('—');
    expect(formatBytes(NaN)).toBe('—');
    expect(formatBytes(undefined)).toBe('—');
    expect(formatBytes(62_000_000)).toBe('62 MB');
  });

  // Review finding 13: a recent update check must not hide the controls.
  it('the download and check controls are there WITHOUT a cached pointer', () => {
    const html = renderHtml(LocalDbSettings, {
      lookupBackend: 'local-db', installed: null, state: null, pointer: null, operation: null,
      onBackendChange: vi.fn(), onInstall: vi.fn(), onRepair: vi.fn(), onUninstall: vi.fn(),
      onCancel: vi.fn(), onRetryOwnership: vi.fn(), onCheckUpdate: vi.fn()
    });
    const text = textOf(html);
    expect(text).toContain('Core — subjects and genres');
    expect(text).toContain('Full — also 12 million names');
    expect(text).toContain('Check for a new release');
    expect(text).toContain('Download');
    // No pointer means no numbers are claimed.
    expect(text).toContain('(download —, disk —)');
    expect(html).not.toMatch(/disabled=""[^>]*>Download/);
  });

  /**
   * N3: a panel mounted DURING an install reads the pre-install settings. When
   * the document-owned mutation completes, the panel that is mounted at that
   * moment must reload — the one that started the install may be long gone.
   */
  it('a panel remounted during an install shows the new installation when it completes', async () => {
    const listeners = new Set();
    let operation = { operationId: 'op1', phase: 'downloading' };
    const client = {
      operation: () => operation,
      snapshot: () => ({ state: 'ready', record: null, operation, progress: null, gated: false }),
      onChange: (fn) => {
        listeners.add(fn);
        fn(client.snapshot());
        return () => listeners.delete(fn);
      },
      onProgress: (fn) => {
        listeners.add(fn);
        fn(client.snapshot());
        return () => listeners.delete(fn);
      }
    };
    const before = { lookupBackend: 'local-db', localDb: null, localDbPendingDeletes: [] };
    const after = {
      lookupBackend: 'local-db',
      localDb: {
        profile: 'core', release: '2026.09.27.1', dbSize: 205_000_000, installedAt: '2026-09-27T00:00:00.000Z'
      },
      localDbPendingDeletes: []
    };
    let stored = before;

    // The panel that started the install is UNMOUNTED.
    const gone = [];
    const stopGone = subscribePanel({
      client, updates: null, onStatus: vi.fn(), onRelease: vi.fn(), onSettings: (s) => gone.push(s), readSettings: async () => stored
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    stopGone();

    // A NEW panel mounts while the install is still running.
    const seen = [];
    const statuses = [];
    const stop = subscribePanel({
      client, updates: null, onStatus: (s) => statuses.push(s), onRelease: vi.fn(), onSettings: (s) => seen.push(s), readSettings: async () => stored
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen.at(-1).localDb).toBeNull();
    expect(statuses.at(-1).operation).toEqual({ operationId: 'op1', phase: 'downloading' });

    // The install finishes: the settings are written, then the client clears
    // the operation.
    stored = after;
    operation = null;
    for (const fn of listeners) fn(client.snapshot());
    await new Promise((resolve) => setTimeout(resolve, 0));

    const settings = seen.at(-1);
    expect(settings.localDb.release).toBe('2026.09.27.1');
    // The unmounted panel got nothing more.
    expect(gone).toHaveLength(1);
    expect(gone[0].localDb).toBeNull();

    // And that panel now renders the installed details with its controls.
    const text = textOf(renderHtml(LocalDbSettings, {
      lookupBackend: settings.lookupBackend, installed: settings.localDb, state: null, pointer: null, operation: null,
      cleanupPending: false,
      onBackendChange: vi.fn(), onInstall: vi.fn(), onRepair: vi.fn(), onUninstall: vi.fn(),
      onCancel: vi.fn(), onRetryOwnership: vi.fn()
    }));
    expect(text).toContain('Installed: core · release 2026.09.27.1 · 205 MB · installed 2026-09-27');
    expect(text).toContain('Repair');
    expect(text).toContain('Uninstall');
    expect(text).not.toContain('Local database not installed');
    stop();
  });

  // Review finding 9: a gate event must not re-enable Cancel.
  it('Cancel stays disabled while the operation is committing, whatever the gate does', () => {
    const committingHtml = renderHtml(LocalDbSettings, {
      lookupBackend: 'local-db', installed: null, state: null, pointer,
      // The client never downgrades a committing phase, and `gated` is not a phase.
      operation: { operationId: 'op1', phase: 'committing' },
      progress: { phase: 'downloading', done: 1, total: 2 },
      onBackendChange: vi.fn(), onInstall: vi.fn(), onRepair: vi.fn(), onUninstall: vi.fn(),
      onCancel: vi.fn(), onRetryOwnership: vi.fn()
    });
    const text = textOf(committingHtml);
    expect(text).toContain(COMMITTING_TEXT);
    expect(text).not.toContain('Cancel');
    // While a mutation runs, no new download can be started either.
    expect(text).not.toContain('Core — subjects and genres');
  });
});
