import { describe, it, expect } from 'vitest';
import { toGenerateImages, imageMetadata } from '../images';
import { runSuggest } from '../suggest';
import { response } from '../../../../test/setup';
import { makeCfg, mockFetch, successBody, bodyOf } from '../../../../test/fixtures';

const BIB = { title: 'Cats', author: 'Tanaka', abstract: 'About cats.', tableOfContents: '', notes: '', images: [] };
const JSON_ANSWER = JSON.stringify({ subjectAnalysis: 'x', suggestions: [{ heading: 'Cats', kind: 'topical', reason: '' }] });

describe('[P4 row17] moved helpers: images (from legacyBridge)', () => {
  it('maps images [{data, name, type, size}] to [{mimeType, dataUrl}] (P3 bridge test, now through runSuggest)', async () => {
    const cfg = await makeCfg('gemini', { model: 'gemini-2.5-flash' });
    const fetchMock = mockFetch(response(successBody('gemini', JSON_ANSWER)));
    await runSuggest({
      cfg,
      rules: '',
      bibliographicInfo: {
        ...BIB,
        images: [
          { data: 'data:image/png;base64,AAAA', name: 'a.png', type: 'image/png', size: 3 },
          { data: 'data:image/jpeg;base64,BBBB', name: 'b.jpg', type: 'image/jpeg', size: 3 }
        ]
      }
    });
    expect(bodyOf(fetchMock).contents[0].parts.slice(1)).toEqual([
      { inlineData: { mimeType: 'image/png', data: 'AAAA' } },
      { inlineData: { mimeType: 'image/jpeg', data: 'BBBB' } }
    ]);
  });

  it('the pure mapping; missing images → []', () => {
    expect(toGenerateImages([{ data: 'data:x', type: 'image/png', name: 'n', size: 1 }])).toEqual([{ mimeType: 'image/png', dataUrl: 'data:x' }]);
    expect(toGenerateImages(undefined)).toEqual([]);
  });

  it('imageMetadata strips the data into a new array; the input is not mutated', () => {
    const images = [{ data: 'data:image/png;base64,AAAA', name: 'a.png', type: 'image/png', size: 3 }];
    const meta = imageMetadata(images);
    expect(meta).toEqual([{ name: 'a.png', type: 'image/png', size: 3 }]);
    expect(images[0].data).toBe('data:image/png;base64,AAAA');
    expect(imageMetadata([{ data: 'abcd', name: 'x', type: 'image/png' }])[0].size).toBe(4);
  });
});
