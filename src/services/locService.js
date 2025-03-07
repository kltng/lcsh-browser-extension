/**
 * Constructs a search URL for the Library of Congress Subject Headings
 * @param {string} term - The search term
 * @returns {string} - The search URL
 */
export const constructLocSearchUrl = (term) => {
  const encodedTerm = encodeURIComponent(term);
  return `https://id.loc.gov/search/?q=${encodedTerm}&q=cs%3Ahttp%3A%2F%2Fid.loc.gov%2Fauthorities%2Fsubjects`;
};

/**
 * Sends a message to the content script to scrape the LOC search results
 * @param {string} term - The search term
 * @returns {Promise<object>} - The scraped results
 */
export const scrapeLocResults = async (term) => {
  try {
    console.log(`Scraping LOC results for term: "${term}"`);
    
    // Create a tab to load the LOC search page
    const tab = await new Promise((resolve) => {
      chrome.tabs.create(
        { url: constructLocSearchUrl(term), active: false },
        (newTab) => {
          resolve(newTab);
        }
      );
    });

    // Wait for the page to load and then inject the content script
    await new Promise((resolve) => {
      const listener = (tabId, changeInfo) => {
        if (tabId === tab.id && changeInfo.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          // Give the page a moment to fully render
          setTimeout(resolve, 1000);
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });

    // Execute the content script to scrape the results
    const results = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { action: 'scrapeResults' }, (response) => {
        console.log(`Received scraping results for "${term}":`, response);
        resolve(response || { success: false, error: 'No response from content script', items: [] });
      });
    });

    // Close the tab
    chrome.tabs.remove(tab.id);

    return {
      term,
      results
    };
  } catch (error) {
    console.error(`Error scraping LOC results for term "${term}":`, error);
    return {
      term,
      results: {
        success: false,
        error: error.message || 'Failed to scrape LOC results',
        items: []
      }
    };
  }
};

/**
 * Scrapes multiple LOC search terms in parallel
 * @param {string[]} terms - The search terms
 * @param {number} concurrency - The number of concurrent requests
 * @returns {Promise<object>} - The scraped results for all terms
 */
export const scrapeMultipleTerms = async (terms, concurrency = 2) => {
  console.log(`Scraping multiple terms: ${terms.join(', ')}`);
  const results = {};
  const queue = [...terms];
  
  const processQueue = async () => {
    while (queue.length > 0) {
      const term = queue.shift();
      console.log(`Processing term: "${term}"`);
      const result = await scrapeLocResults(term);
      results[term] = result.results;
    }
  };
  
  // Create multiple workers to process the queue in parallel
  const workers = [];
  for (let i = 0; i < Math.min(concurrency, terms.length); i++) {
    workers.push(processQueue());
  }
  
  // Wait for all workers to complete
  await Promise.all(workers);
  
  console.log('Finished scraping all terms:', results);
  return results;
};

export default {
  constructLocSearchUrl,
  scrapeLocResults,
  scrapeMultipleTerms
}; 