import React, { createContext, useState, useContext, useEffect, useRef } from 'react';
import {
  loadSystemPromptRules, saveSystemPromptRules, getSettings, onSettingsChanged
} from '../services/settings';
import {
  initialRulesState, editRules, applyStoredRules, afterRulesSave, afterRulesReset
} from './promptRulesState';

// Create context
const AppContext = createContext();

// Custom hook to use the context
export const useAppContext = () => useContext(AppContext);

// Default system prompt template
const DEFAULT_SYSTEM_PROMPT_RULES = `# LCSH Selection Rules

1. Select subject headings that represent the main topics of the work.
2. Prefer established LCSH terms over creating new ones.
3. Use the most specific heading available for a topic.
4. Assign 1-6 subject headings, with 3-4 being optimal for most works.
5. For personal names, verify the authorized form in the LC Name Authority File (LCNAF).
6. For geographic subjects, use established subdivisions.
7. For works about multiple topics, assign a heading for each significant topic.
8. For works of literature, assign genre/form terms as appropriate.
9. For biographies, assign a heading for the subject of the biography.
10. For historical works, assign chronological subdivisions as appropriate.
11. If images are provided, analyze them for additional bibliographic information.
12. For book covers or title pages, extract relevant subject information.
13. Terms will be validated against both LCSH and LCNAF authorities.`;

const MAX_CONVERSATION_HISTORY = 25;

export const SETTINGS_LOAD_ERROR = 'Settings could not be loaded. Reload the page or check Chrome storage.';

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

const handleStorageError = (fallbackMessage) => {
    if (chrome.runtime.lastError) {
        console.error(fallbackMessage, chrome.runtime.lastError);
        return chrome.runtime.lastError.message || fallbackMessage;
    }

    return null;
};

export const AppProvider = ({ children }) => {
    // State for bibliographic information
    const [bibliographicInfo, setBibliographicInfo] = useState({
        title: '',
        author: '',
        abstract: '',
        tableOfContents: '',
        notes: '',
        images: []
    });

    // State for system prompt: the editor text, the stored value it was loaded from, and a stale flag
    const [rulesState, setRulesState] = useState(() => initialRulesState(DEFAULT_SYSTEM_PROMPT_RULES));
    const rulesStateRef = useRef(rulesState);
    rulesStateRef.current = rulesState;
    const systemPromptRules = rulesState.text;
    const setSystemPromptRules = (text) => setRulesState((state) => editRules(state, text));

    // State for settings loading ('loading' | 'ready' | 'error') and its message
    const [settingsStatus, setSettingsStatus] = useState('loading');
    const [settingsError, setSettingsError] = useState(null);

    // Provider/model that produced the current suggestions ({providerId, model} or null)
    const [suggestionProvenance, setSuggestionProvenance] = useState(null);

    // State for workflow
    const [activeStep, setActiveStep] = useState(0);
    const [initialSuggestions, setInitialSuggestions] = useState([]);
    const [scrapedResults, setScrapedResults] = useState({});
    const [finalRecommendations, setFinalRecommendations] = useState([]);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState(null);

    // State for conversation history
    const [conversationHistory, setConversationHistory] = useState([]);

    // Load settings (after migration) when component mounts
    useEffect(() => {
      let alive = true;
      initAppSettings(DEFAULT_SYSTEM_PROMPT_RULES).then((result) => {
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
      const unsubscribe = onSettingsChanged((changes) => {
        if (!Object.hasOwn(changes, 'systemPromptRules')) return;
        setRulesState((state) => applyStoredRules(state, changes.systemPromptRules.newValue));
      });

        // Load conversation history
        chrome.storage.local.get(['conversationHistory'], (result) => {
            const storageError = handleStorageError('Failed to load conversation history');
            if (storageError) {
                setError(storageError);
                return;
            }

            if (result.conversationHistory) {
                setConversationHistory(result.conversationHistory);
            }
        });

      return () => {
        alive = false;
        unsubscribe();
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
      const result = await saveSystemPromptRules(DEFAULT_SYSTEM_PROMPT_RULES, base);
      setRulesState((state) => afterRulesReset(state, result, snapshot));
      return result;
    };

    // Discard edits and load the rules stored now
    const reloadSystemPromptRules = async () => {
      const { systemPromptRules: stored } = await getSettings();
      setRulesState(initialRulesState(stored));
    };

    // Save conversation to history
    const saveConversation = (conversation) => {
        // Remove large image data before saving to storage
        const conversationToSave = { ...conversation };
        if (conversationToSave.bibliographicInfo && conversationToSave.bibliographicInfo.images) {
            // Replace full image data with just metadata to save space
            conversationToSave.bibliographicInfo.images = conversationToSave.bibliographicInfo.images.map(img => ({
                name: img.name,
                type: img.type,
                size: img.size || (img.data ? img.data.length : 0)
            }));
        }

        const updatedHistory = [...conversationHistory, {
            id: Date.now(),
            timestamp: new Date().toISOString(),
            ...conversationToSave
        }].slice(-MAX_CONVERSATION_HISTORY);

        setConversationHistory(updatedHistory);
        chrome.storage.local.set({ conversationHistory: updatedHistory }, () => {
            const storageError = handleStorageError('Failed to save conversation history');
            if (storageError) {
                setError(storageError);
            }
        });
    };

    // Delete conversation from history
    const deleteConversation = (id) => {
        const updatedHistory = conversationHistory.filter(conv => conv.id !== id);
        setConversationHistory(updatedHistory);
        chrome.storage.local.set({ conversationHistory: updatedHistory }, () => {
            const storageError = handleStorageError('Failed to delete conversation history item');
            if (storageError) {
                setError(storageError);
            }
        });
    };

    // Clear all conversation history
    const clearConversationHistory = () => {
        setConversationHistory([]);
        chrome.storage.local.remove(['conversationHistory'], () => {
            const storageError = handleStorageError('Failed to clear conversation history');
            if (storageError) {
                setError(storageError);
            }
        });
    };

    // Context value
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
        suggestionProvenance,
        setSuggestionProvenance,
        activeStep,
        setActiveStep,
        initialSuggestions,
        setInitialSuggestions,
        scrapedResults,
        setScrapedResults,
        finalRecommendations,
        setFinalRecommendations,
        isLoading,
        setIsLoading,
        error,
        setError,
        conversationHistory,
        saveConversation,
        deleteConversation,
        clearConversationHistory,
        DEFAULT_SYSTEM_PROMPT_RULES
    };

    return (
        <AppContext.Provider value={contextValue}>
            {children}
        </AppContext.Provider>
    );
};

export default AppContext;
