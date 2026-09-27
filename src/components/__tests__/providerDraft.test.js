import { describe, it, expect, vi } from 'vitest';
import {
  draftFromStored, initialDraftState, applyStoredChange, editDraft, afterSave, patchFromDraft, beginPermissionGesture,
  beginSave, endSave, savedOrigin, watchSavedAccess
} from '../providerDraft';
import { saveProviderDraft, onSettingsChanged, providerKey } from '../../services/settings';
import { resolveConfigFromDraft } from '../../services/providers/config';
import { generate } from '../../services/providers/index';
import { TEST_SCHEMA } from '../../services/providers/schema';
import { fakes, response, flushEvents, gate } from '../../../test/setup';
import {
  entryOf, KEY, successBody, bodyOf, VALID_TEST_ANSWER
} from '../../../test/fixtures';

describe('[row 17] stale drafts: the form-state helpers (UI behavior: live verification owned by the lead)', () => {
  it('applyStoredChange refreshes a clean draft state from an (asynchronous) onSettingsChanged event', async () => {
    let form = initialDraftState({});
    const unsubscribe = onSettingsChanged((changes) => {
      const change = changes[providerKey('openai')];
      if (change) form = applyStoredChange(form, change.newValue);
    });
    await saveProviderDraft('openai', { apiKey: 'sk-from-tab-a' }, {});
    await flushEvents();
    unsubscribe();
    expect(form.dirty).toBe(false);
    expect(form.stale).toBe(false);
    expect(form.draft.apiKey).toBe('sk-from-tab-a');
    expect(form.base).toEqual({ apiKey: 'sk-from-tab-a' });
  });

  it('applyStoredChange keeps a dirty draft\'s edits and marks it stale; saving that draft writes nothing', async () => {
    let form = editDraft(initialDraftState({}), 'model', 'gpt-6-astra');
    const unsubscribe = onSettingsChanged((changes) => {
      const change = changes[providerKey('openai')];
      if (change) form = applyStoredChange(form, change.newValue);
    });
    await saveProviderDraft('openai', { apiKey: 'sk-from-tab-a' }, {});
    await flushEvents();
    unsubscribe();
    expect(form).toMatchObject({ dirty: true, stale: true, base: {} });
    expect(form.draft.model).toBe('gpt-6-astra');
    const setsBefore = fakes.storage.calls.set.length;
    const result = await saveProviderDraft('openai', patchFromDraft(entryOf('openai'), form.draft), form.base);
    expect(result).toEqual({ saved: false, reason: 'stale' });
    expect(fakes.storage.calls.set.length).toBe(setsBefore);
    expect(afterSave(form, result)).toMatchObject({ stale: true, draft: { model: 'gpt-6-astra' } });
  });

  it('an equal stored value changes nothing; a successful save resets the form', () => {
    const form = editDraft(initialDraftState({ apiKey: 'k' }), 'model', 'm');
    expect(applyStoredChange(form, { apiKey: 'k' })).toBe(form);
    const saved = afterSave(form, { saved: true, value: { apiKey: 'k', model: 'm' } });
    expect(saved).toEqual({
      base: { apiKey: 'k', model: 'm' }, draft: draftFromStored({ apiKey: 'k', model: 'm' }), dirty: false, stale: false, locked: false
    });
  });

  it('patchFromDraft sends only the fields the provider uses', () => {
    const draft = { region: 'cn', apiKey: 'k', baseURL: 'https://x/v1', model: 'm', jsonMode: 'prompt', imagesOverride: true };
    expect(patchFromDraft(entryOf('openai'), draft)).toEqual({ apiKey: 'k', model: 'm', imagesOverride: true });
    expect(patchFromDraft(entryOf('qwen'), draft)).toEqual({ apiKey: 'k', model: 'm', region: 'cn', imagesOverride: true });
    expect(patchFromDraft(entryOf('custom'), draft)).toEqual({ apiKey: 'k', model: 'm', baseURL: 'https://x/v1', jsonMode: 'prompt', imagesOverride: true });
  });
});

describe('fix-1 #3: a pending save locks the draft (UI behavior: live verification owned by the lead)', () => {
  it('a delayed save followed by an attempted edit: the edit is impossible and the save result stands', async () => {
    const stored = { apiKey: 'sk-old' };
    fakes.storage.seed({ 'provider:openai': stored });
    let form = editDraft(initialDraftState(stored), 'apiKey', 'sk-new');
    // Click Save: the form locks at once, then the (delayed) save runs.
    form = beginSave(form);
    const submitted = form.draft;
    const writeGate = gate();
    const realSet = chrome.storage.local.set;
    chrome.storage.local.set = async (items) => {
      await writeGate.promise;
      return realSet(items);
    };
    const pending = saveProviderDraft('openai', patchFromDraft(entryOf('openai'), submitted), form.base);
    // The user types while the save is pending.
    const attempted = editDraft(form, 'model', 'typed-during-save');
    expect(attempted).toBe(form);
    expect(attempted.draft.model).toBe('');
    writeGate.open();
    const result = await pending;
    expect(result).toMatchObject({ saved: true, value: { apiKey: 'sk-new' } });
    form = afterSave(attempted, result);
    expect(form).toMatchObject({ locked: false, dirty: false, draft: { apiKey: 'sk-new', model: '' } });
    // After completion editing works again.
    expect(editDraft(form, 'model', 'm').draft.model).toBe('m');
  });

  it('a save that does not complete (denied or stale) unlocks and keeps the edits', () => {
    const form = beginSave(editDraft(initialDraftState({}), 'model', 'm'));
    expect(endSave(form)).toMatchObject({ locked: false, draft: { model: 'm' } });
    expect(afterSave(form, { saved: false, reason: 'stale' })).toMatchObject({ locked: false, stale: true, draft: { model: 'm' } });
  });
});

describe('fix-1 #8: a fresh custom/LM Studio draft uses json_schema', () => {
  it.each(['custom', 'lmstudio'])('%s: draftFromStored → resolveConfigFromDraft → generate sends json_schema controls', async (id) => {
    const stored = id === 'custom' ? { baseURL: 'https://llm.example.com/v1', model: 'm' } : { model: 'm' };
    const draft = draftFromStored(stored);
    expect(draft.jsonMode).toBe('');
    const cfg = await resolveConfigFromDraft(entryOf(id), draft);
    expect(cfg.caps.jsonMode).toBe('json_schema');
    fakes.permissions.granted.add(id === 'custom' ? 'https://llm.example.com/*' : 'http://localhost:1234/*');
    globalThis.fetch = vi.fn(async () => response(successBody('openai-style', JSON.stringify(VALID_TEST_ANSWER))));
    const result = await generate(cfg, { system: 'S', userText: 'U', schema: TEST_SCHEMA });
    expect(result.mode).toBe('json_schema');
    expect(bodyOf(globalThis.fetch).response_format).toEqual({
      type: 'json_schema', json_schema: { name: 'result', strict: true, schema: TEST_SCHEMA }
    });
  });

  it('an unsupported non-blank jsonMode → not_configured', async () => {
    await expect(resolveConfigFromDraft(entryOf('custom'), { baseURL: 'https://llm.example.com/v1', model: 'm', jsonMode: 'grammar' }))
      .rejects.toMatchObject({ kind: 'not_configured' });
    await expect(resolveConfigFromDraft(entryOf('lmstudio'), { model: 'm', jsonMode: '  ' }))
      .resolves.toMatchObject({ caps: { jsonMode: 'json_schema' } });
  });
});

describe('fix-1 #5: saved-origin access is rechecked on revocation (UI behavior: live verification owned by the lead)', () => {
  it('revocation while mounted with a different unsaved URL → needsGrant for the SAVED origin', async () => {
    const stored = { baseURL: 'https://saved.example.com/v1', model: 'm' };
    const unsavedDraft = { ...draftFromStored(stored), baseURL: 'https://other.example.org/v1' };
    expect(savedOrigin(entryOf('custom'), stored)).toBe('https://saved.example.com/*');
    fakes.permissions.granted.add('https://saved.example.com/*');
    fakes.permissions.granted.add('https://other.example.org/*');
    const seen = [];
    const watcher = watchSavedAccess(entryOf('custom'), stored, (needsGrant) => seen.push(needsGrant));
    await vi.waitFor(() => expect(seen).toEqual([false]));
    // The user revokes the saved origin in chrome://extensions; the form stays open with its draft.
    await chrome.permissions.remove({ origins: ['https://saved.example.com/*'] });
    await vi.waitFor(() => expect(seen).toEqual([false, true]));
    expect(unsavedDraft.baseURL).toBe('https://other.example.org/v1');
    // The recheck is read-only: nothing was requested.
    expect(fakes.permissions.request).not.toHaveBeenCalled();
    // Granting again (onAdded) clears it.
    await chrome.permissions.request({ origins: ['https://saved.example.com/*'] });
    await vi.waitFor(() => expect(seen.at(-1)).toBe(false));
    watcher.unsubscribe();
    expect(fakes.permissions.onRemoved.listeners.size).toBe(0);
    expect(fakes.permissions.onAdded.listeners.size).toBe(0);
  });

  it('recheck() after a permission error reports the current state; Nano has no origin', async () => {
    const stored = { apiKey: KEY };
    const seen = [];
    const watcher = watchSavedAccess(entryOf('openai'), stored, (v) => seen.push(v));
    await watcher.recheck();
    expect(seen.at(-1)).toBe(true);
    watcher.unsubscribe();
    const nano = [];
    const nanoWatcher = watchSavedAccess(entryOf('gemini-nano'), {}, (v) => nano.push(v));
    await nanoWatcher.recheck();
    expect(nano).toEqual([false, false]);
    expect(fakes.permissions.contains).toHaveBeenCalledTimes(2);
    nanoWatcher.unsubscribe();
  });
});

describe('[row 14] permissions: the gesture rule', () => {
  it('validates, computes the origin and calls chrome.permissions.request synchronously', async () => {
    const gesture = beginPermissionGesture(entryOf('deepseek'), draftFromStored({}));
    // Called before any await: the request is already recorded.
    expect(fakes.permissions.request).toHaveBeenCalledWith({ origins: ['https://api.deepseek.com/*'] });
    expect(gesture.host).toBe('api.deepseek.com');
    expect(await gesture.granted).toBe(true);
  });

  it('requests every time, also when already granted', async () => {
    fakes.permissions.granted.add('https://api.openai.com/*');
    await beginPermissionGesture(entryOf('openai'), {}).granted;
    await beginPermissionGesture(entryOf('openai'), {}).granted;
    expect(fakes.permissions.request).toHaveBeenCalledTimes(2);
  });

  it('uses the draft region and URL; an invalid URL stops before any request', () => {
    beginPermissionGesture(entryOf('moonshot'), { region: 'cn' });
    expect(fakes.permissions.request).toHaveBeenLastCalledWith({ origins: ['https://api.moonshot.cn/*'] });
    const bad = beginPermissionGesture(entryOf('custom'), { baseURL: 'http://example.com/v1' });
    expect(bad.ok).toBe(false);
    expect(fakes.permissions.request).toHaveBeenCalledTimes(1);
  });

  it('a denied request resolves false', async () => {
    fakes.permissions.state.nextRequestResult = false;
    expect(await beginPermissionGesture(entryOf('openai'), {}).granted).toBe(false);
  });

  it('Nano skips the permission step', async () => {
    const gesture = beginPermissionGesture(entryOf('gemini-nano'), {});
    expect(await gesture.granted).toBe(true);
    expect(fakes.permissions.request).not.toHaveBeenCalled();
  });

  it('a rejected request counts as denied', async () => {
    fakes.permissions.request.mockImplementationOnce(() => Promise.reject(new Error('no gesture')));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await beginPermissionGesture(entryOf('openai'), {}).granted).toBe(false);
  });
});
