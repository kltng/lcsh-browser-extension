import { describe, it, expect } from 'vitest';
import { buildCsv, csvCell, guardCell, BOM } from '../csv';

describe('[P4 row14] csv', () => {
  it.each([['=SUM(A1)'], ['+1'], ['-2'], ['@cmd'], ['\tx'], ['\rx'], ['  =x']])('the formula guard is kept: %j gets a leading quote', (value) => {
    expect(guardCell(value)).toBe(`'${value}`);
  });

  it('safe values are unchanged', () => {
    for (const value of ['Cats', '650 _0 $a Cats', '[85,null]', '', 'a=b', 'x-y']) expect(guardCell(value)).toBe(value);
    expect(guardCell(null)).toBe('');
    expect(guardCell(undefined)).toBe('');
    expect(guardCell(85)).toBe('85');
  });

  it('RFC 4180 quoting: quotes doubled; commas and newlines stay inside one quoted cell', () => {
    expect(csvCell('He said "hi"')).toBe('"He said ""hi"""');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvCell('=1,"x"')).toBe('"\'=1,""x"""');
  });

  it('CJK text, the UTF-8 BOM and CRLF line ends', () => {
    const csv = buildCsv([['label', 'lc_id'], ['日本電影人物志', 'sh1'], ['東京 (日本)', 'n2']]);
    expect(BOM).toBe(String.fromCharCode(0xfeff));
    expect(csv.startsWith(BOM)).toBe(true);
    expect(csv.slice(1)).toBe('"label","lc_id"\r\n"日本電影人物志","sh1"\r\n"東京 (日本)","n2"\r\n');
    expect(new TextEncoder().encode(csv).slice(0, 3)).toEqual(new Uint8Array([0xef, 0xbb, 0xbf]));
    expect(csv.split('\r\n')).toHaveLength(4);
  });
});
