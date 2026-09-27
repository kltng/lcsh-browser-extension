import { describe, it, expect } from 'vitest';
import {
  initialRulesState, editRules, applyStoredRules, afterRulesSave, afterRulesReset, isRulesDirty
} from '../promptRulesState';
import { saveSystemPromptRules, loadSystemPromptRules, onSettingsChanged } from '../../services/settings';
import { fakes, flushEvents, gate } from '../../../test/setup';

const DEFAULT = 'default rules';

describe('fix-1 #4: system prompt rules use a stale base (UI behavior: live verification owned by the lead)', () => {
  it('tab B saving from an older base is rejected as stale; nothing is written; tab B keeps its text', async () => {
    fakes.storage.seed({ systemPromptRules: 'v1' });
    let tabA = initialRulesState(await loadSystemPromptRules(DEFAULT));
    let tabB = initialRulesState(await loadSystemPromptRules(DEFAULT));
    tabA = editRules(tabA, 'v2 from A');
    const resultA = await saveSystemPromptRules(tabA.text, tabA.base);
    expect(resultA).toEqual({ saved: true, value: 'v2 from A' });
    tabA = afterRulesSave(tabA, resultA);
    expect(tabA).toEqual({ text: 'v2 from A', base: 'v2 from A', stale: false });

    tabB = editRules(tabB, 'v2 from B');
    const setsBefore = fakes.storage.calls.set.length;
    const resultB = await saveSystemPromptRules(tabB.text, tabB.base);
    expect(resultB).toEqual({ saved: false, reason: 'stale' });
    expect(fakes.storage.calls.set.length).toBe(setsBefore);
    expect(fakes.storage.data.get('systemPromptRules')).toBe('v2 from A');
    tabB = afterRulesSave(tabB, resultB);
    expect(tabB).toMatchObject({ text: 'v2 from B', stale: true });
  });

  it('a clean editor refreshes from an (asynchronous) onSettingsChanged event; a dirty one becomes stale', async () => {
    fakes.storage.seed({ systemPromptRules: 'v1' });
    let clean = initialRulesState(await loadSystemPromptRules(DEFAULT));
    let dirty = editRules(initialRulesState('v1'), 'my edit');
    const unsubscribe = onSettingsChanged((changes) => {
      if (!Object.hasOwn(changes, 'systemPromptRules')) return;
      clean = applyStoredRules(clean, changes.systemPromptRules.newValue);
      dirty = applyStoredRules(dirty, changes.systemPromptRules.newValue);
    });
    await saveSystemPromptRules('v2', 'v1');
    await flushEvents();
    unsubscribe();
    expect(clean).toEqual({ text: 'v2', base: 'v2', stale: false });
    expect(dirty).toEqual({ text: 'my edit', base: 'v1', stale: true });
    expect(applyStoredRules(clean, 'v2')).toBe(clean);
  });

  it('reset follows the same stale rule', async () => {
    fakes.storage.seed({ systemPromptRules: 'v1' });
    let editor = editRules(initialRulesState('v1'), 'draft');
    // Fresh base: reset writes the default and the editor shows it.
    const ok = await saveSystemPromptRules(DEFAULT, editor.base);
    editor = afterRulesReset(editor, ok, editor.text);
    expect(editor).toEqual({ text: DEFAULT, base: DEFAULT, stale: false });
    // Another tab changes the rules; a reset from the old base writes nothing and keeps the text.
    await saveSystemPromptRules('other tab', DEFAULT);
    editor = editRules(editor, 'kept text');
    const stale = await saveSystemPromptRules(DEFAULT, editor.base);
    expect(stale).toEqual({ saved: false, reason: 'stale' });
    expect(fakes.storage.data.get('systemPromptRules')).toBe('other tab');
    expect(afterRulesReset(editor, stale, editor.text)).toMatchObject({ text: 'kept text', stale: true });
  });

  it('fix-2 #2: a delayed reset with typing during it → the typed text survives', async () => {
    fakes.storage.seed({ systemPromptRules: 'v1' });
    let editor = editRules(initialRulesState('v1'), 'before reset');
    // Reset starts: snapshot the text, then the write is delayed.
    const snapshot = editor.text;
    const writeGate = gate();
    const realSet = chrome.storage.local.set;
    chrome.storage.local.set = async (items) => {
      await writeGate.promise;
      return realSet(items);
    };
    const pending = saveSystemPromptRules(DEFAULT, editor.base);
    editor = editRules(editor, 'typed during reset');
    writeGate.open();
    const result = await pending;
    expect(result).toEqual({ saved: true, value: DEFAULT });
    editor = afterRulesReset(editor, result, snapshot);
    expect(editor).toEqual({ text: 'typed during reset', base: DEFAULT, stale: false });
    expect(isRulesDirty(editor)).toBe(true);
    // Without typing, the defaults replace the text.
    expect(afterRulesReset(initialRulesState('x'), { saved: true, value: DEFAULT }, 'x'))
      .toEqual({ text: DEFAULT, base: DEFAULT, stale: false });
  });

  it('text typed while a save runs stays an unsaved edit', () => {
    const editor = editRules(initialRulesState('v1'), 'typed later');
    const next = afterRulesSave(editor, { saved: true, value: 'submitted' });
    expect(next).toEqual({ text: 'typed later', base: 'submitted', stale: false });
    expect(isRulesDirty(next)).toBe(true);
  });
});
