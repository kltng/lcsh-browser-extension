/**
 * Content script for scraping the Library of Congress Subject Headings search results
 */

// Listen for messages from the extension
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'scrapeResults') {
    const results = scrapeSearchResults();
    sendResponse(results);
  }
  return true; // Keep the message channel open for asynchronous response
});

/**
 * Scrapes the search results from the LOC website
 * @returns {object} - The scraped results
 */
function scrapeSearchResults() {
  try {
    console.log('Scraping LOC search results...');
    
    // First, try to find the table with the nested tbody structure
    const tbodyGroups = document.querySelectorAll('tbody.tbody-group');
    
    if (tbodyGroups && tbodyGroups.length > 0) {
      console.log(`Found ${tbodyGroups.length} tbody groups`);
      
      const items = [];
      
      // Process each tbody group
      tbodyGroups.forEach((tbody) => {
        // Get the first row which contains the actual data
        const row = tbody.querySelector('tr');
        if (!row) return;
        
        // Get the cells in the row
        const cells = row.querySelectorAll('td');
        if (cells.length < 2) return;
        
        // Get the heading text and link
        const linkElement = cells[1].querySelector('a');
        if (!linkElement) return;
        
        const heading = linkElement.textContent.trim();
        const uri = linkElement.getAttribute('href');
        
        // Get the dataset type (3rd column)
        const datasetType = cells.length > 2 ? cells[2].textContent.trim() : '';
        
        // Get the type (4th column)
        const type = cells.length > 3 ? cells[3].textContent.trim() : '';
        
        // Get the identifier (6th column)
        const identifier = cells.length > 5 ? cells[5].textContent.trim() : '';
        
        // Add the item to the results
        items.push({
          heading,
          uri,
          datasetType,
          type,
          identifier
        });
      });
      
      console.log(`Scraped ${items.length} items from tbody groups`);
      
      if (items.length > 0) {
        return {
          success: true,
          items,
          pageTitle: document.title,
          searchTerm: extractSearchTerm()
        };
      }
    }
    
    // If we didn't find any tbody groups, try the regular table
    const resultsTable = document.querySelector('table.table-striped');
    
    if (!resultsTable) {
      console.log('No results table found on this page');
      
      // Check if there's a "no results" message
      const paragraphs = document.querySelectorAll('p');
      let noResultsFound = false;
      
      for (const p of paragraphs) {
        if (p.textContent.includes('No results')) {
          noResultsFound = true;
          break;
        }
      }
      
      if (noResultsFound) {
        return {
          success: false,
          error: 'No results found for this search term',
          items: []
        };
      }
      
      return {
        success: false,
        error: 'Could not find results table on this page',
        items: []
      };
    }

    // Get all table rows (skip the header row)
    const resultRows = resultsTable.querySelectorAll('tbody tr');
    const items = [];

    console.log(`Found ${resultRows.length} result rows`);

    // Process each result row
    resultRows.forEach((row) => {
      // Get the cells in the row
      const cells = row.querySelectorAll('td');
      if (cells.length < 2) return;
      
      // Get the heading text and link
      const linkElement = cells[1].querySelector('a');
      if (!linkElement) return;
      
      const heading = linkElement.textContent.trim();
      const uri = linkElement.getAttribute('href');
      
      // Get the dataset type
      const datasetType = cells.length > 2 ? cells[2].textContent.trim() : '';
      
      // Get the identifier
      const identifier = cells.length > 5 ? cells[5].textContent.trim() : '';
      
      // Add the item to the results
      items.push({
        heading,
        uri,
        datasetType,
        identifier
      });
    });

    // If we didn't find any items in the table, try an alternative approach
    if (items.length === 0) {
      // Try to find results in the list format
      const listItems = document.querySelectorAll('.search-results li');
      
      console.log(`Found ${listItems.length} list items`);
      
      if (listItems.length > 0) {
        listItems.forEach((item) => {
          // Get the heading text
          const headingElement = item.querySelector('a');
          if (!headingElement) return;
          
          const heading = headingElement.textContent.trim();
          const uri = headingElement.getAttribute('href');
          
          // Get the details
          const detailsElement = item.querySelector('.detail');
          const details = detailsElement ? detailsElement.textContent.trim() : '';
          
          // Add the item to the results
          items.push({
            heading,
            uri,
            details
          });
        });
      }
    }

    console.log(`Scraped ${items.length} items from the page`);

    // Return the results
    return {
      success: items.length > 0,
      items,
      pageTitle: document.title,
      searchTerm: extractSearchTerm()
    };
  } catch (error) {
    console.error('Error scraping search results:', error);
    return {
      success: false,
      error: error.message || 'Failed to scrape search results',
      items: []
    };
  }
}

/**
 * Extracts the search term from the URL
 * @returns {string} - The search term
 */
function extractSearchTerm() {
  try {
    const url = new URL(window.location.href);
    const searchParams = url.searchParams;
    const searchTerms = [];
    
    // Get all 'q' parameters
    for (const [key, value] of searchParams.entries()) {
      if (key === 'q' && !value.startsWith('cs:')) {
        searchTerms.push(value);
      }
    }
    
    return searchTerms.join(' ');
  } catch (error) {
    console.error('Error extracting search term:', error);
    return '';
  }
} 