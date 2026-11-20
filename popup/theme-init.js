// theme-init.js - Prevent flash of light/dark theme on startup
try {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    chrome.storage.local.get(['theme'], (d) => {
      if (d && d.theme) {
        document.documentElement.setAttribute('data-theme', d.theme);
        if (document.body) {
          document.body.setAttribute('data-theme', d.theme);
        }
      }
    });
  }
} catch (e) {}
