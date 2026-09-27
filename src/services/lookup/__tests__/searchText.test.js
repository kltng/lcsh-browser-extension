import { describe, it, expect } from 'vitest';
import { toSearch, keywordText, hasLetterOrNumber } from '../searchText';
import { createLocApiBackend } from '../locApi';
import { createScheduler, createRunCache } from '../scheduler';
import { mockLoc, fastSchedulerOptions } from '../../../../test/locFixtures';

const EN = String.fromCodePoint(0x2013);
const EM = String.fromCodePoint(0x2014);
const NBSP = String.fromCodePoint(0xa0);

describe('[P4 row2] searchText', () => {
  it('dash and space forms of the same heading give the same full/main', () => {
    const forms = [
      'Motion pictures--Japan--History',
      'Motion pictures -- Japan -- History',
      `Motion pictures ${EM} Japan ${EM} History`,
      `Motion pictures${EN}Japan${EN}History`,
      `Motion${NBSP}pictures  --Japan--  History.`,
      '  Motion pictures--Japan--History...  '
    ];
    for (const form of forms) {
      expect(toSearch(form)).toEqual({
        full: 'Motion pictures--Japan--History',
        main: 'Motion pictures',
        components: ['Motion pictures', 'Japan', 'History']
      });
    }
  });

  it('no subdivisions: main equals full; keywordText replaces -- with a space', () => {
    expect(toSearch('Cats')).toMatchObject({ full: 'Cats', main: 'Cats' });
    expect(keywordText('Japan--History--1868-')).toBe('Japan History 1868-');
  });

  it.each([[''], ['   '], ['...'], ['--'], ['—'], ['!?'], ['--History'], ['Cats--'], ['Cats----Dogs'], [null]])(
    'empty, punctuation-only or an empty component (%j) → null',
    (heading) => {
      expect(toSearch(heading)).toBeNull();
    }
  );

  it('hasLetterOrNumber counts any Unicode letter or number', () => {
    expect(hasLetterOrNumber('日本')).toBe(true);
    expect(hasLetterOrNumber('1990s')).toBe(true);
    expect(hasLetterOrNumber('-- . !')).toBe(false);
  });

  it('empty/punctuation-only → no-results with no requests', async () => {
    const loc = mockLoc();
    const backend = createLocApiBackend({ scheduler: createScheduler(fastSchedulerOptions), cache: createRunCache() });
    for (const heading of ['...', '--History', 'Cats--']) {
      const raw = await backend.lookup({ id: 's1', heading, kind: 'topical' });
      expect(raw).toMatchObject({ candidates: [], failures: [], requests: [] });
    }
    expect(loc.fetch).not.toHaveBeenCalled();
  });

  it('URLSearchParams does the encoding', async () => {
    const loc = mockLoc();
    const backend = createLocApiBackend({ scheduler: createScheduler(fastSchedulerOptions), cache: createRunCache() });
    await backend.lookup({ id: 's1', heading: 'Tom & Jerry?', kind: 'topical' });
    expect(loc.fetch.mock.calls[0][0]).toBe('https://id.loc.gov/authorities/subjects/suggest2?q=Tom+%26+Jerry%3F&count=10&searchtype=leftanchored');
  });
});
