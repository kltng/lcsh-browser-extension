/**
 * Background script for the LCSH Recommendation Tool extension
 */

// Listen for installation
chrome.runtime.onInstalled.addListener(() => {
  console.log('LCSH Recommendation Tool extension installed');
});

// Listen for messages from content scripts or popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'openAppTab') {
    chrome.tabs.create({ url: chrome.runtime.getURL('app.html') });
    sendResponse({ success: true });
  }
  return true; // Keep the message channel open for asynchronous response
}); 