import { describe, it, expect } from 'vitest';
import { copyAllText, csvRows, recommendationsCsv, COPY_ALL_HEADER, CSV_COLUMNS } from '../exports';
import { selectionsOf } from '../run';
import { builtRun, C } from '../../../../test/pipelineFixtures';

describe('[P4 row14] csv: the recommendation export', () => {
  it('columns, methods/confidence as JSON arrays aligned with selections, the subdivision note, the source', () => {
    const run = builtRun();
    const rows = csvRows(run.recommendations, selectionsOf(run));
    // P5 §9 adds `marc_reason` after `marc_status`.
    expect(rows[0]).toEqual(['label', 'lc_id', 'uri', 'authority', 'marc_field', 'marc_status', 'marc_reason', 'methods', 'confidence', 'subdivision_note', 'source']);
    expect(CSV_COLUMNS).toEqual(rows[0]);
    expect(rows[1]).toEqual([
      C.mpjh.label, 'sh2008108026', C.mpjh.uri, 'lcsh', '650 _0 $a Motion pictures $z Japan $x History', 'from-authority',
      '', '["ai"]', '[85]', '', 'loc-api'
    ]);
    expect(rows[2].slice(7, 9)).toEqual(['["manual"]', '[null]']);
    expect(rows[3].slice(7, 9)).toEqual(['["ai"]', '[45]']);
    expect(rows).toHaveLength(4);
    const csv = recommendationsCsv(run.recommendations, selectionsOf(run));
    expect(csv).toContain('"[""ai""]","[85]"');
  });

  it('a recommendation chosen twice: ["ai","manual"] and [85,null]; the note when subdivisions were dropped', () => {
    const rec = {
      cid: C.mp.cid, label: C.mp.label, authority: 'lcsh', localId: C.mp.localId, uri: C.mp.uri, source: 'loc-api',
      selections: [{ suggestionId: 's1', method: 'ai', confidence: 85, lexicalSimilarity: 50 }, { suggestionId: 's6', method: 'manual', confidence: null, lexicalSimilarity: 40 }],
      marc: { status: 'unavailable', tag: null, ind1: null, ind2: null, subfields: [], text: null, reason: 'no key' }
    };
    const selections = [
      { suggestionId: 's1', cid: C.mp.cid, method: 'ai', noneReason: null, confidence: 85, lexicalSimilarity: 50, mainHeadingOnly: true, droppedSubdivisions: ['Japan', 'History'] },
      { suggestionId: 's6', cid: C.mp.cid, method: 'manual', noneReason: null, confidence: null, lexicalSimilarity: 40, mainHeadingOnly: true, droppedSubdivisions: ['Japan', 'Biography'] }
    ];
    const [, row] = csvRows([rec], selections);
    expect(row[4]).toBe('');
    expect(row[5]).toBe('unavailable');
    expect(row[6]).toBe('no key');
    expect(row[7]).toBe('["ai","manual"]');
    expect(row[8]).toBe('[85,null]');
    expect(row[9]).toBe('The selected heading does not include these suggested subdivisions: Japan, History, Biography');
    const text = copyAllText([rec], selections);
    expect(text.split('\n')).toEqual([
      COPY_ALL_HEADER,
      'Motion pictures | sh85088164 | MARC not available (no key)',
      '# The selected heading does not include these suggested subdivisions: Japan, History, Biography'
    ]);
  });

  it('Copy all: the header line, then label | LC ID | MARC text, recommendations only', () => {
    const run = builtRun();
    const lines = copyAllText(run.recommendations, selectionsOf(run)).split('\n');
    expect(lines[0]).toBe('Headings from id.loc.gov; MARC fields generated from LC authority keys');
    expect(lines[1]).toBe('Motion pictures--Japan--History | sh2008108026 | 650 _0 $a Motion pictures $z Japan $x History');
    expect(lines.join('\n')).not.toContain('Japanese cinema');
  });
});
