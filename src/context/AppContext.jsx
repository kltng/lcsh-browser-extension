import React, { createContext, useState, useContext, useEffect } from 'react';

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
5. For personal names, verify the authorized form in the LC Name Authority File.
6. For geographic subjects, use established subdivisions.
7. For works about multiple topics, assign a heading for each significant topic.
8. For works of literature, assign genre/form terms as appropriate.
9. For biographies, assign a heading for the subject of the biography.
10. For historical works, assign chronological subdivisions as appropriate.`;

export const AppProvider = ({ children }) => {
    // State for bibliographic information
    const [bibliographicInfo, setBibliographicInfo] = useState({
        title: '',
        author: '',
        abstract: '',
        tableOfContents: '',
        notes: '',
    });

    // State for system prompt
    const [systemPromptRules, setSystemPromptRules] = useState(DEFAULT_SYSTEM_PROMPT_RULES);

    // State for API key
    const [apiKey, setApiKey] = useState('');

    // State for workflow
    const [activeStep, setActiveStep] = useState(0);
    const [initialSuggestions, setInitialSuggestions] = useState([]);
    const [scrapedResults, setScrapedResults] = useState({});
    const [finalRecommendations, setFinalRecommendations] = useState([]);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState(null);

    // State for conversation history
    const [conversationHistory, setConversationHistory] = useState([]);

    // Load API key from storage when component mounts
    useEffect(() => {
        chrome.storage.local.get(['geminiApiKey', 'systemPromptRules'], (result) => {
            if (result.geminiApiKey) {
                setApiKey(result.geminiApiKey);
            }

            if (result.systemPromptRules) {
                setSystemPromptRules(result.systemPromptRules);
            } else {
                // Save default system prompt rules to storage
                chrome.storage.local.set({ systemPromptRules: DEFAULT_SYSTEM_PROMPT_RULES });
            }
        });

        // Load conversation history
        chrome.storage.local.get(['conversationHistory'], (result) => {
            if (result.conversationHistory) {
                setConversationHistory(result.conversationHistory);
            }
        });
    }, []);

    // Reset system prompt rules to default
    const resetSystemPromptRules = () => {
        setSystemPromptRules(DEFAULT_SYSTEM_PROMPT_RULES);
        chrome.storage.local.set({ systemPromptRules: DEFAULT_SYSTEM_PROMPT_RULES });
    };

    // Save conversation to history
    const saveConversation = (conversation) => {
        const updatedHistory = [...conversationHistory, {
            id: Date.now(),
            timestamp: new Date().toISOString(),
            ...conversation
        }];

        setConversationHistory(updatedHistory);
        chrome.storage.local.set({ conversationHistory: updatedHistory });
    };

    // Delete conversation from history
    const deleteConversation = (id) => {
        const updatedHistory = conversationHistory.filter(conv => conv.id !== id);
        setConversationHistory(updatedHistory);
        chrome.storage.local.set({ conversationHistory: updatedHistory });
    };

    // Clear all conversation history
    const clearConversationHistory = () => {
        setConversationHistory([]);
        chrome.storage.local.remove(['conversationHistory']);
    };

    // Context value
    const contextValue = {
        bibliographicInfo,
        setBibliographicInfo,
        systemPromptRules,
        setSystemPromptRules,
        resetSystemPromptRules,
        apiKey,
        setApiKey,
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