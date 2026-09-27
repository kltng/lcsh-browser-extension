import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fakes, flushEvents } from '../../../test/setup';
import { DEFAULT_RULES } from '../pipeline/prompts';
import { OLD_DEFAULT_RULES, OLD_DEFAULT_RULES_V1_1_0, OLD_DEFAULT_RULES_V1_0 } from '../pipeline/legacyRules';

// Each call gives a separate module instance: one fake extension page.
// All pages share the fake chrome.storage and the fake navigator.locks.
const openPage = async () => {
  vi.resetModules();
  return import('../settings');
};

const state = () => fakes.storage.dump();

describe('[row 1] migration', () => {
  it('fresh install', async () => {
    const page = await openPage();
    await page.ready();
    expect(state()).toEqual({ activeProviderId: 'gemini', settingsVersion: 2, lookupBackend: 'loc-api' });
    const settings = await page.getSettings();
    expect(settings.activeProviderId).toBe('gemini');
    expect(settings.providers.gemini).toEqual({});
  });

  it('legacy key only', async () => {
    fakes.storage.seed({ geminiApiKey: 'AIza-legacy', systemPromptRules: 'my rules', conversationHistory: [{ id: 1 }] });
    const page = await openPage();
    await page.ready();
    expect(state()).toEqual({
      'provider:gemini': { apiKey: 'AIza-legacy' },
      activeProviderId: 'gemini',
      settingsVersion: 2,
      lookupBackend: 'loc-api',
      systemPromptRules: 'my rules',
      conversationHistory: [{ id: 1 }]
    });
  });

  it('legacy key + a different new key: the new one is kept', async () => {
    fakes.storage.seed({ geminiApiKey: 'AIza-old', 'provider:gemini': { apiKey: 'AIza-new', model: 'gemini-3.8-flash' } });
    const page = await openPage();
    await page.ready();
    expect(state()['provider:gemini']).toEqual({ apiKey: 'AIza-new', model: 'gemini-3.8-flash' });
    expect(state().geminiApiKey).toBeUndefined();
  });

  it('already migrated: nothing is written', async () => {
    fakes.storage.seed({
      settingsVersion: 2, activeProviderId: 'deepseek', lookupBackend: 'loc-api', 'provider:deepseek': { apiKey: 'sk-ds' }
    });
    const before = state();
    const page = await openPage();
    await page.ready();
    expect(state()).toEqual(before);
    expect(fakes.storage.calls.set).toEqual([]);
    expect(fakes.storage.calls.remove).toEqual([]);
  });

  it('crash after step 4: the next run removes the legacy key', async () => {
    fakes.storage.seed({ geminiApiKey: 'AIza-legacy' });
    fakes.storage.failNext('remove', new Error('page closed'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const first = await openPage();
    await first.ready();
    expect(state()).toMatchObject({ geminiApiKey: 'AIza-legacy', 'provider:gemini': { apiKey: 'AIza-legacy' }, settingsVersion: 2 });

    const setsBefore = fakes.storage.calls.set.length;
    const second = await openPage();
    await second.ready();
    expect(state().geminiApiKey).toBeUndefined();
    expect(state()['provider:gemini']).toEqual({ apiKey: 'AIza-legacy' });
    // Steps 2–4 change nothing the second time.
    expect(fakes.storage.calls.set.length).toBe(setsBefore);
  });

  it('two pages migrate while a third saves a new key and selects DeepSeek', async () => {
    fakes.storage.seed({ geminiApiKey: 'AIza-legacy' });
    const pageA = await openPage();
    const pageB = await openPage();
    const pageC = await openPage();
    // Forced interleaving: all three start before any finishes; the fake lock queues them FIFO.
    const results = await Promise.all([
      pageA.ready(),
      pageC.saveProviderAndActivate('deepseek', { apiKey: 'sk-ds-new' }, {}),
      pageB.ready(),
      pageC.updateProvider('gemini', { apiKey: 'AIza-newer' })
    ]);
    expect(results[1]).toMatchObject({ saved: true });
    // A late page migrating again must not undo the user's choice.
    const pageD = await openPage();
    await pageD.ready();
    expect(state()).toEqual({
      'provider:gemini': { apiKey: 'AIza-newer' },
      'provider:deepseek': { apiKey: 'sk-ds-new' },
      activeProviderId: 'deepseek',
      settingsVersion: 2,
      lookupBackend: 'loc-api'
    });
    expect(fakes.locks.stats.maxConcurrent).toBe(1);
    const log = fakes.locks.log;
    for (let i = 0; i < log.length; i += 2) {
      expect(log[i]).toBe('acquire:lcsh-settings');
      expect(log[i + 1]).toBe('release:lcsh-settings');
    }
  });

  it('a later page migrating does not overwrite a key saved after the first migration', async () => {
    fakes.storage.seed({ geminiApiKey: 'AIza-legacy' });
    const pageA = await openPage();
    const pageB = await openPage();
    await pageA.ready();
    await pageA.updateProvider('gemini', { apiKey: 'AIza-user' });
    await pageB.ready();
    expect(state()['provider:gemini']).toEqual({ apiKey: 'AIza-user' });
  });
});

describe('[row 2] updateProvider', () => {
  it('two pages patch different fields of the same provider → both are kept', async () => {
    fakes.storage.seed({ settingsVersion: 2, activeProviderId: 'gemini', lookupBackend: 'loc-api', 'provider:openai': { region: 'intl' } });
    const pageA = await openPage();
    const pageB = await openPage();
    await Promise.all([
      pageA.updateProvider('openai', { apiKey: 'sk-a' }),
      pageB.updateProvider('openai', { model: 'gpt-6-astra' })
    ]);
    expect(state()['provider:openai']).toEqual({ region: 'intl', apiKey: 'sk-a', model: 'gpt-6-astra' });
    expect(fakes.locks.stats.maxConcurrent).toBe(1);
  });

  it('patch keys replace; empty values remove the field; unknown ids are rejected', async () => {
    const page = await openPage();
    await page.updateProvider('qwen', { apiKey: 'k1', model: 'qwen3.7-plus', region: 'cn' });
    await page.updateProvider('qwen', { apiKey: 'k2', model: '' });
    expect(state()['provider:qwen']).toEqual({ apiKey: 'k2', region: 'cn' });
    await expect(page.updateProvider('nope', {})).rejects.toThrow();
  });

  it('setActiveProvider writes the id; getSettings falls back to gemini for a bad id', async () => {
    const page = await openPage();
    await page.setActiveProvider('moonshot');
    expect((await page.getSettings()).activeProviderId).toBe('moonshot');
    fakes.storage.seed({ activeProviderId: 'removed-provider' });
    expect((await page.getSettings()).activeProviderId).toBe('gemini');
  });
});

describe('[row 17] stale drafts', () => {
  it('tab A saves a key; tab B (dirty, older base) saves the model → stale, nothing written', async () => {
    const tabA = await openPage();
    const tabB = await openPage();
    await tabA.ready();
    await tabB.ready();
    const base = {};
    expect(await tabA.saveProviderDraft('openai', { apiKey: 'sk-a' }, base)).toEqual({ saved: true, value: { apiKey: 'sk-a' } });
    const setsBefore = fakes.storage.calls.set.length;
    expect(await tabB.saveProviderDraft('openai', { model: 'gpt-6-astra' }, base)).toEqual({ saved: false, reason: 'stale' });
    expect(fakes.storage.calls.set.length).toBe(setsBefore);
    expect(state()['provider:openai']).toEqual({ apiKey: 'sk-a' });
    expect(await tabB.saveProviderAndActivate('openai', { model: 'gpt-6-astra' }, base)).toEqual({ saved: false, reason: 'stale' });
    expect(state().activeProviderId).toBe('gemini');
  });

  it('a save with the current base succeeds', async () => {
    const tab = await openPage();
    await tab.saveProviderDraft('openai', { apiKey: 'sk-a' }, {});
    expect(await tab.saveProviderDraft('openai', { apiKey: 'sk-a', model: 'm' }, { apiKey: 'sk-a' })).toMatchObject({ saved: true });
  });

  it('Save & use is one combined write of provider:<id> and activeProviderId', async () => {
    const tab = await openPage();
    await tab.ready();
    const setsBefore = fakes.storage.calls.set.length;
    const result = await tab.saveProviderAndActivate('deepseek', { apiKey: 'sk-ds', model: 'deepseek-flash' }, {});
    expect(result).toMatchObject({ saved: true });
    expect(fakes.storage.calls.set.slice(setsBefore)).toEqual([{
      'provider:deepseek': { apiKey: 'sk-ds', model: 'deepseek-flash' },
      activeProviderId: 'deepseek'
    }]);
  });

  it('onSettingsChanged reports settings keys only and unsubscribes', async () => {
    const tab = await openPage();
    await tab.ready();
    // The migration's own writes are delivered asynchronously too; let them pass first.
    await flushEvents();
    const cb = vi.fn();
    const unsubscribe = tab.onSettingsChanged(cb);
    await tab.updateProvider('openai', { apiKey: 'sk-a' });
    // Like Chrome, the event arrives after the write completed, not inside it.
    expect(cb).not.toHaveBeenCalled();
    await chrome.storage.local.set({ conversationHistory: [] });
    await flushEvents();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(Object.keys(cb.mock.calls[0][0])).toEqual(['provider:openai']);
    unsubscribe();
    await tab.updateProvider('openai', { apiKey: 'sk-b' });
    await flushEvents();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('[row 25] settings readiness failure (settings module)', () => {
  it('a rejected storage.get makes ready() reject; a later call retries', async () => {
    fakes.storage.failNext('get', new Error('storage broken'));
    const page = await openPage();
    await expect(page.ready()).rejects.toThrow('storage broken');
    await expect(page.ready()).resolves.toBeUndefined();
  });
});

describe('[P4 row3] suggest: untouched old default rules are migrated to DEFAULT_RULES (fix-1 #7)', () => {
  const load = async () => (await openPage()).loadSystemPromptRules(DEFAULT_RULES);
  const rulesWrites = () => fakes.storage.calls.set.filter((items) => Object.hasOwn(items, 'systemPromptRules'));

  it('the frozen literals are byte-exact copies of the lead-provided historical defaults', () => {
    const files = [
      ['old_default_rules.txt', OLD_DEFAULT_RULES_V1_1_0, 947],
      ['old_default_rules_v1_0.txt', OLD_DEFAULT_RULES_V1_0, 948]
    ];
    for (const [name, literal, bytes] of files) {
      expect(Buffer.byteLength(literal, 'utf8')).toBe(bytes);
      const file = path.resolve(process.cwd(), '.dispatch/p4-fix-1', name);
      // The lead's copies live in the git-ignored .dispatch/ folder; compare when present.
      if (fs.existsSync(file)) expect(literal).toBe(fs.readFileSync(file, 'utf8'));
    }
    expect(OLD_DEFAULT_RULES).toEqual([OLD_DEFAULT_RULES_V1_1_0, OLD_DEFAULT_RULES_V1_0]);
  });

  it.each([['v1.1.0', OLD_DEFAULT_RULES_V1_1_0], ['v1.0.x', OLD_DEFAULT_RULES_V1_0]])('the exact %s default → migrated (one awaited write)', async (_, old) => {
    fakes.storage.seed({ settingsVersion: 2, activeProviderId: 'gemini', systemPromptRules: old });
    expect(await load()).toBe(DEFAULT_RULES);
    expect(fakes.storage.data.get('systemPromptRules')).toBe(DEFAULT_RULES);
    expect(rulesWrites()).toEqual([{ systemPromptRules: DEFAULT_RULES }]);
  });

  it.each([
    ['one extra space at the end', `${OLD_DEFAULT_RULES_V1_1_0} `],
    ['a trailing newline', `${OLD_DEFAULT_RULES_V1_1_0}\n`],
    ['one extra space inside', OLD_DEFAULT_RULES_V1_0.replace('1. Select', '1.  Select')],
    ['a custom rule set', '# My rules\n1. Verify names in LCNAF.'],
    ['the old default with one line edited', OLD_DEFAULT_RULES_V1_1_0.replace('1-6', '2-5')]
  ])('%s → untouched', async (_, custom) => {
    fakes.storage.seed({ settingsVersion: 2, activeProviderId: 'gemini', systemPromptRules: custom });
    expect(await load()).toBe(custom);
    expect(fakes.storage.data.get('systemPromptRules')).toBe(custom);
    expect(rulesWrites()).toEqual([]);
  });

  it('absent or empty → the default', async () => {
    expect(await load()).toBe(DEFAULT_RULES);
    fakes.storage.seed({ systemPromptRules: '' });
    expect(await load()).toBe(DEFAULT_RULES);
    expect(fakes.storage.data.get('systemPromptRules')).toBe(DEFAULT_RULES);
  });

  it('two pages loading at once → one write', async () => {
    fakes.storage.seed({ settingsVersion: 2, activeProviderId: 'gemini', systemPromptRules: OLD_DEFAULT_RULES_V1_1_0 });
    const pageA = await openPage();
    const pageB = await openPage();
    const [a, b] = await Promise.all([pageA.loadSystemPromptRules(DEFAULT_RULES), pageB.loadSystemPromptRules(DEFAULT_RULES)]);
    expect([a, b]).toEqual([DEFAULT_RULES, DEFAULT_RULES]);
    expect(rulesWrites()).toHaveLength(1);
  });

  it('the cross-tab stale-editor rule is kept: another tab sees the migration as a stored change', async () => {
    fakes.storage.seed({ settingsVersion: 2, activeProviderId: 'gemini', systemPromptRules: OLD_DEFAULT_RULES_V1_1_0 });
    const page = await openPage();
    const seen = [];
    const off = page.onSettingsChanged((changes) => {
      if (Object.hasOwn(changes, 'systemPromptRules')) seen.push(changes.systemPromptRules.newValue);
    });
    await page.loadSystemPromptRules(DEFAULT_RULES);
    await flushEvents();
    off();
    expect(seen).toEqual([DEFAULT_RULES]);
    // A dirty editor loaded from the OLD value is stale: its save is refused.
    expect(await page.saveSystemPromptRules('edited', OLD_DEFAULT_RULES_V1_1_0)).toEqual({ saved: false, reason: 'stale' });
  });
});
