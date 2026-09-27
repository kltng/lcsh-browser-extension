import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createPreviewTracker } from '../previewUrls';

const spyUrls = () => {
  let n = 0;
  const create = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:preview-${++n}`);
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  return { create, revoke };
};

describe('[P4 fix-1 #9] image preview URLs are released (HOUSE_RULES 12)', () => {
  it('a removed image revokes its URL once; revokeAll (unmount) revokes every outstanding URL', () => {
    const { create, revoke } = spyUrls();
    const tracker = createPreviewTracker();
    const a = tracker.create(new Blob(['a']));
    const b = tracker.create(new Blob(['b']));
    const c = tracker.create(new Blob(['c']));
    expect(create).toHaveBeenCalledTimes(3);
    tracker.revoke(b);
    tracker.revoke(b);
    expect(revoke.mock.calls).toEqual([[b]]);
    expect(tracker.outstanding()).toEqual([a, c]);
    // Unmount after a successful Suggest, an error, or a cancel: all remaining URLs are released.
    tracker.revokeAll();
    expect(revoke.mock.calls).toEqual([[b], [a], [c]]);
    expect(tracker.outstanding()).toEqual([]);
    tracker.revokeAll();
    expect(revoke).toHaveBeenCalledTimes(3);
  });

  it('an unknown URL is not revoked', () => {
    const { revoke } = spyUrls();
    createPreviewTracker().revoke('blob:other');
    expect(revoke).not.toHaveBeenCalled();
  });

  it('BibliographicInfoForm creates and revokes previews only through the tracker, and revokes all on unmount', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../BibliographicInfoForm.jsx'), 'utf8');
    expect(source).not.toMatch(/URL\.(createObjectURL|revokeObjectURL)/);
    expect(source).toContain('previewsRef.current.create(file)');
    expect(source).toContain('previewsRef.current.revoke(');
    expect(source).toMatch(/useEffect\(\(\) => \(\) => previewsRef\.current\.revokeAll\(\), \[\]\)/);
  });
});
