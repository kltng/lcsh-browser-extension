import React, { createContext, useState, useContext, useEffect, useRef, useSyncExternalStore } from 'react';
import {
  loadSystemPromptRules, saveSystemPromptRules, getSettings, onSettingsChanged
} from '../services/settings';
import { resolveConfig } from '../services/providers/index';
import {
  initialRulesState, editRules, applyStoredRules, afterRulesSave, afterRulesReset
} from './promptRulesState';
import { DEFAULT_RULES } from '../services/pipeline/prompts';
import { createWorkflow } from '../services/pipeline/workflow';
import {
  loadHistory, saveHistoryEntry, deleteHistoryEntry, clearHistory, onHistoryChanged, buildHistoryEntry
} from '../services/history';

// Create context
const AppContext = createContext();

// Custom hook to use the context
export const useAppContext = () => useContext(AppContext);

export const SETTINGS_LOAD_ERROR = 'Settings could not be loaded. Reload the page or check Chrome storage.';

/** Workflow steps (§7) and the pipeline operations each one owns. */
export const STEP_OPERATIONS = { 0: ['suggest'], 1: [], 2: ['lookup', 'select'], 3: [], 4: [] };

export const EMPTY_BIBLIOGRAPHIC_INFO = {
  title: '', author: '', abstract: '', tableOfContents: '', notes: '', images: []
};

/**
 * Load the settings the app needs at start (runs settings.ready() first).
 * @param {string} defaultRules - Default LCSH selection rules
 * @returns {Promise<{ok:true, systemPromptRules:string}|{ok:false, message:string}>}
 */
export const initAppSettings = async (defaultRules) => {
  try {
    const systemPromptRules = await loadSystemPromptRules(defaultRules);
    return { ok: true, systemPromptRules };
  } catch (err) {
    console.error('Failed to load settings');
    return { ok: false, message: SETTINGS_LOAD_ERROR };
  }
};

/**
 * ONE config snapshot of the active provider, plus the settings (for the lookup backend).
 * @returns {Promise<{cfg:object, settings:object}>}
 */
export const loadActiveConfig = async () => {
  const settings = await getSettings();
  const cfg = await resolveConfig(settings, settings.activeProviderId);
  return { cfg, settings };
};

/**
 * `localDbClient` is the ONE owner client of this document (SPEC-P5 §3.1),
 * created in app.jsx above the hash routes. The popup passes nothing, so it
 * never takes ownership.
 */
export const AppProvider = ({ children, localDbClient = null, localDbUpdates = null }) => {
  const [bibliographicInfo, setBibliographicInfo] = useState(EMPTY_BIBLIOGRAPHIC_INFO);

  // State for system prompt: the editor text, the stored value it was loaded from, and a stale flag
  const [rulesState, setRulesState] = useState(() => initialRulesState(DEFAULT_RULES));
  const rulesStateRef = useRef(rulesState);
  rulesStateRef.current = rulesState;
  const systemPromptRules = rulesState.text;
  const setSystemPromptRules = (text) => setRulesState((state) => editRules(state, text));

  // State for settings loading ('loading' | 'ready' | 'error') and its message
  const [settingsStatus, setSettingsStatus] = useState('loading');
  const [settingsError, setSettingsError] = useState(null);

  // The pipeline run (run.js state behind the workflow controller)
  const workflowRef = useRef(null);
  if (!workflowRef.current) workflowRef.current = createWorkflow({ loadConfig: loadActiveConfig, localClient: localDbClient });
  const workflow = workflowRef.current;
  // The third argument (the server snapshot) is the same state; the app is
  // client-rendered, and it lets a test render this provider with react-dom/server.
  const run = useSyncExternalStore(workflow.subscribe, workflow.getState, workflow.getState);

  const [activeStep, setActiveStepState] = useState(0);
  const activeStepRef = useRef(0);
  const [error, setError] = useState(null);
  const [conversationHistory, setConversationHistory] = useState([]);

  // Leaving a step invalidates its pending operations (§9)
  const setActiveStep = (step) => {
    const previous = activeStepRef.current;
    if (previous !== step) (STEP_OPERATIONS[previous] || []).forEach((op) => workflow.leave(op));
    activeStepRef.current = step;
    setActiveStepState(step);
  };

  useEffect(() => {
    let alive = true;
    initAppSettings(DEFAULT_RULES).then((result) => {
      if (!alive) return;
      if (result.ok) {
        setRulesState(initialRulesState(result.systemPromptRules));
        setSettingsStatus('ready');
      } else {
        setSettingsError(result.message);
        setSettingsStatus('error');
      }
    });

    // Rules saved in another tab: a clean editor refreshes, a dirty one becomes stale
    const unsubscribeSettings = onSettingsChanged((changes) => {
      if (!Object.hasOwn(changes, 'systemPromptRules')) return;
      setRulesState((state) => applyStoredRules(state, changes.systemPromptRules.newValue));
    });

    loadHistory()
      .then((entries) => { if (alive) setConversationHistory(entries); })
      .catch((err) => { if (alive) setError(err.message); });
    const unsubscribeHistory = onHistoryChanged((entries) => { if (alive) setConversationHistory(entries); });

    return () => {
      alive = false;
      unsubscribeSettings();
      unsubscribeHistory();
      workflow.dispose();
    };
  }, []);

  // Save the rules; stale (changed in another tab) keeps the editor text
  const saveRules = async () => {
    const { text, base } = rulesStateRef.current;
    const result = await saveSystemPromptRules(text, base);
    setRulesState((state) => afterRulesSave(state, result));
    return result;
  };

  // Reset system prompt rules to default, with the same stale rule
  const resetSystemPromptRules = async () => {
    const { text: snapshot, base } = rulesStateRef.current;
    const result = await saveSystemPromptRules(DEFAULT_RULES, base);
    setRulesState((state) => afterRulesReset(state, result, snapshot));
    return result;
  };

  // Discard edits and load the rules stored now
  const reloadSystemPromptRules = async () => {
    const { systemPromptRules: stored } = await getSettings();
    setRulesState(initialRulesState(stored));
  };

  // Save the current run to history (from the run's own input snapshot, not the
  // live form); resolves only after the write is confirmed
  const saveRunToHistory = async () => {
    const entries = await saveHistoryEntry(buildHistoryEntry({ run: workflow.getState() }));
    setConversationHistory(entries);
    return entries;
  };

  const deleteConversation = async (id) => setConversationHistory(await deleteHistoryEntry(id));
  const clearConversationHistory = async () => setConversationHistory(await clearHistory());

  const contextValue = {
    bibliographicInfo,
    setBibliographicInfo,
    systemPromptRules,
    setSystemPromptRules,
    saveSystemPromptRules: saveRules,
    resetSystemPromptRules,
    reloadSystemPromptRules,
    systemPromptStale: rulesState.stale,
    settingsStatus,
    settingsError,
    workflow,
    localDbClient,
    localDbUpdates,
    run,
    activeStep,
    setActiveStep,
    error,
    setError,
    conversationHistory,
    saveRunToHistory,
    deleteConversation,
    clearConversationHistory,
    DEFAULT_RULES
  };

  return (
    <AppContext.Provider value={contextValue}>
      {children}
    </AppContext.Provider>
  );
};

export default AppContext;
