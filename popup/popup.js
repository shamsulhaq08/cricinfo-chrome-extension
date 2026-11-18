// popup.js - ESPN Cricinfo Classic Widget Controller

const STATE = {
  activeTab: 'live', // 'live' or 'upcoming'
  theme: 'light', // 'light', 'dark', or 'auto'
  liveMatches: [],
  upcomingMatches: [],
  pinnedMatchId: null,
  newsItems: [],
  refreshTimer: null,
  autoRefreshSeconds: 5, // Default: 5s Real-Time ⚡
  filterScope: 'intl', // 'intl' or 'all'
  timeZone: 'Asia/Karachi', // Default: Pakistan (PKT, UTC+5)
  liveEventsMap: {},
  isFirstMount: true
};

// DOM References
const elements = {
  cricinfoLogoLink: document.getElementById('cricinfoLogoLink'),
  tabLiveBtn: document.getElementById('tabLiveBtn'),
  tabUpcomingBtn: document.getElementById('tabUpcomingBtn'),
  realtimeStatusIndicator: document.getElementById('realtimeStatusIndicator'),
  realtimeStatusText: document.getElementById('realtimeStatusText'),
  liveScoresContent: document.getElementById('liveScoresContent'),
  upcomingScoresContent: document.getElementById('upcomingScoresContent'),
  moreMatchesLink: document.getElementById('moreMatchesLink'),
  latestNewsContent: document.getElementById('latestNewsContent'),
  btnSidePanel: document.getElementById('btnSidePanel'),
  btnThemeToggle: document.getElementById('btnThemeToggle'),
  themeIconSun: document.getElementById('themeIconSun'),
  themeIconMoon: document.getElementById('themeIconMoon'),
  btnHeaderRefresh: document.getElementById('btnHeaderRefresh'),
  btnSettings: document.getElementById('btnSettings'),
  settingsOverlay: document.getElementById('settingsOverlay'),
  btnCloseSettings: document.getElementById('btnCloseSettings'),
  btnSaveSettings: document.getElementById('btnSaveSettings'),
  btnManualRefresh: document.getElementById('btnManualRefresh'),
  selectRefreshInterval: document.getElementById('selectRefreshInterval'),
  selectFilterScope: document.getElementById('selectFilterScope'),
  selectTheme: document.getElementById('selectTheme'),
  selectTimeZone: document.getElementById('selectTimeZone')
};

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  // Detect if opened in Chrome Side Panel
  const isSidePanel = window.location.search.includes('sidepanel') || 
                      window.location.search.includes('panel') || 
                      (window.innerWidth > 0 && window.innerWidth !== 530 && !window.menubar?.visible);
  if (isSidePanel) {
    document.body.classList.add('in-sidepanel');
    if (elements.btnSidePanel) {
      elements.btnSidePanel.style.display = 'none';
    }
  }

  // 1. Clear unread news notification badge immediately and ensure no old alarms fire
  if (typeof chrome !== 'undefined') {
    if (chrome.action?.setBadgeText) {
      chrome.action.setBadgeText({ text: '' }).catch(() => {});
    }
    if (chrome.alarms?.clearAll) {
      // Clear legacy alarm so old in-memory service worker stops setting badge
      chrome.alarms.clearAll().then(() => {
        chrome.alarms.create('cricinfo-classic-refresh', { periodInMinutes: 1 });
      }).catch(() => {});
    }
    // Set readNewsIds to prevent any old worker from computing unread > 0
    if (chrome.storage?.local) {
      chrome.storage.local.get(['cachedNewsItems']).then(data => {
        const ids = (data.cachedNewsItems || []).map(i => String(i.id || i.title));
        chrome.storage.local.set({ readNewsIds: ids }).catch(() => {});
      }).catch(() => {});
    }
    if (chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: 'CLEAR_NEWS_BADGE' }, () => {});
    }
  }

  // 2. INSTANT CACHE RENDER: Render cached matches & news in <5ms without loading delay!
  await renderFromCacheIfAvailable();

  // 3. Load user preferences & attach event handlers
  await loadPreferences();
  setupEventListeners();

  // 4. Background revalidation: fetch fresh live scores and news non-blocking
  loadAllData();
  startRefreshTimer();
});

// Render from cache immediately if present (Zero delay)
async function renderFromCacheIfAvailable() {
  try {
    const cached = await getStored(['cachedLiveMatches', 'cachedUpcomingMatches', 'cachedNewsItems', 'pinnedMatchId']);
    if (cached.pinnedMatchId) {
      STATE.pinnedMatchId = cached.pinnedMatchId;
    }
    if (Array.isArray(cached.cachedLiveMatches) && cached.cachedLiveMatches.length > 0) {
      const validLive = STATE.filterScope === 'intl'
        ? cached.cachedLiveMatches.filter(m => isInternationalMatch(m, { name: m.leagueName }))
        : cached.cachedLiveMatches;
      if (validLive.length > 0) {
        STATE.liveMatches = sortMatchesByLivePriority(validLive, STATE.pinnedMatchId);
        renderLiveMatchesHtml();
      }
    }
    if (Array.isArray(cached.cachedUpcomingMatches) && cached.cachedUpcomingMatches.length > 0) {
      const validUpcoming = STATE.filterScope === 'intl'
        ? cached.cachedUpcomingMatches.filter(m => isInternationalMatch(m, { name: m.leagueName }))
        : cached.cachedUpcomingMatches;
      if (validUpcoming.length > 0) {
        STATE.upcomingMatches = validUpcoming;
        if (STATE.activeTab === 'upcoming') {
          renderUpcomingMatchesHtml();
        }
      }
    }
    if (Array.isArray(cached.cachedNewsItems) && cached.cachedNewsItems.length > 0) {
      STATE.newsItems = cached.cachedNewsItems.slice(0, 5); // 5 news items
      renderLatestNews();
    }
  } catch (err) {
    console.warn('Cache render error:', err);
  }
}

// Load user settings
async function loadPreferences() {
  try {
    const data = await getStored(['autoRefresh', 'filterScope', 'pinnedMatchId', 'theme', 'timeZone', 'liveEventsMap']);
    if (data.liveEventsMap && typeof data.liveEventsMap === 'object') {
      STATE.liveEventsMap = data.liveEventsMap;
    }
    if (data.autoRefresh !== undefined && data.autoRefresh != 15 && data.autoRefresh != 20) {
      STATE.autoRefreshSeconds = parseInt(data.autoRefresh, 10);
      elements.selectRefreshInterval.value = String(data.autoRefresh);
    } else {
      STATE.autoRefreshSeconds = 5;
      elements.selectRefreshInterval.value = '5';
      await setStored({ autoRefresh: 5 });
    }
    if (data.filterScope) {
      STATE.filterScope = data.filterScope;
      elements.selectFilterScope.value = data.filterScope;
    }
    if (data.pinnedMatchId) {
      STATE.pinnedMatchId = data.pinnedMatchId;
    }
    // Region / TimeZone
    if (data.timeZone) {
      STATE.timeZone = data.timeZone;
      if (elements.selectTimeZone) {
        elements.selectTimeZone.value = data.timeZone;
      }
    } else {
      STATE.timeZone = 'Asia/Karachi';
      if (elements.selectTimeZone) {
        elements.selectTimeZone.value = 'Asia/Karachi';
      }
    }
    // Theme (Day/Night mode)
    const savedTheme = data.theme || 'light';
    applyTheme(savedTheme);
    updateRealtimeStatusIndicator();
  } catch (err) {
    console.warn('Preferences load error:', err);
  }
}

// Apply Day/Night Theme
function applyTheme(theme) {
  STATE.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  document.body.setAttribute('data-theme', theme);

  if (elements.selectTheme) {
    elements.selectTheme.value = theme;
  }

  // Toggle Header Sun/Moon Icons
  const isDark = theme === 'dark' || (theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  if (elements.themeIconSun && elements.themeIconMoon) {
    if (isDark) {
      elements.themeIconSun.style.display = 'block';
      elements.themeIconSun.classList.remove('theme-icon-animate');
      void elements.themeIconSun.offsetWidth;
      elements.themeIconSun.classList.add('theme-icon-animate');
      elements.themeIconMoon.style.display = 'none';
      if (elements.btnThemeToggle) elements.btnThemeToggle.title = 'Switch to Day Mode (Light)';
    } else {
      elements.themeIconSun.style.display = 'none';
      elements.themeIconMoon.style.display = 'block';
      elements.themeIconMoon.classList.remove('theme-icon-animate');
      void elements.themeIconMoon.offsetWidth;
      elements.themeIconMoon.classList.add('theme-icon-animate');
      if (elements.btnThemeToggle) elements.btnThemeToggle.title = 'Switch to Night Mode (Dark)';
    }
  }
}

// 1-Click Toggle between Day and Night Mode
async function toggleTheme() {
  const current = STATE.theme || 'light';
  const nextTheme = current === 'dark' ? 'light' : 'dark';
  applyTheme(nextTheme);
  await setStored({ theme: nextTheme });
}

// Update the real-time indicator pill next to Live Scores tab
function updateRealtimeStatusIndicator() {
  if (!elements.realtimeStatusIndicator || !elements.realtimeStatusText) return;
  if (STATE.activeTab === 'upcoming') {
    elements.realtimeStatusIndicator.style.display = 'none';
    return;
  }
  elements.realtimeStatusIndicator.style.display = 'inline-flex';
  const sec = STATE.autoRefreshSeconds !== undefined ? STATE.autoRefreshSeconds : 5;
  if (sec <= 0) {
    elements.realtimeStatusIndicator.classList.add('paused');
    elements.realtimeStatusText.textContent = 'Off';
    elements.realtimeStatusIndicator.title = 'Auto-refresh is paused. Click Refresh button to update.';
  } else {
    elements.realtimeStatusIndicator.classList.remove('paused');
    elements.realtimeStatusText.textContent = `${sec}s`;
    elements.realtimeStatusIndicator.title = `Auto-refresh active (${sec}s)`;
  }
}

// Setup Event Listeners
function setupEventListeners() {
  // Open in Chrome Side Panel
  if (elements.btnSidePanel) {
    elements.btnSidePanel.addEventListener('click', async () => {
      try {
        if (typeof chrome !== 'undefined' && chrome.sidePanel?.open) {
          const win = await new Promise(r => chrome.windows.getCurrent(r));
          if (win?.id) {
            await chrome.sidePanel.open({ windowId: win.id });
            window.close();
            return;
          }
        }
        if (typeof browser !== 'undefined' && browser.sidebarAction?.open) {
          await browser.sidebarAction.open();
          window.close();
          return;
        }
        if (typeof chrome !== 'undefined' && chrome.windows?.create) {
          chrome.windows.create({
            url: chrome.runtime.getURL('popup/popup.html?sidepanel=1'),
            type: 'popup',
            width: 530,
            height: 720
          });
          window.close();
        }
      } catch (err) {
        console.warn('Could not open side panel, falling back to popup window:', err);
        if (typeof chrome !== 'undefined' && chrome.windows?.create) {
          chrome.windows.create({
            url: chrome.runtime.getURL('popup/popup.html?sidepanel=1'),
            type: 'popup',
            width: 530,
            height: 720
          });
          window.close();
        }
      }
    });
  }

  // Day / Night Mode 1-click Toggle
  if (elements.btnThemeToggle) {
    elements.btnThemeToggle.addEventListener('click', toggleTheme);
  }

  // Theme dropdown change in settings
  if (elements.selectTheme) {
    elements.selectTheme.addEventListener('change', async (e) => {
      const newTheme = e.target.value;
      applyTheme(newTheme);
      await setStored({ theme: newTheme });
    });
  }

  // Logo Click -> Open ESPNcricinfo in new browser tab
  if (elements.cricinfoLogoLink) {
    elements.cricinfoLogoLink.addEventListener('click', (e) => {
      e.preventDefault();
      if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
        chrome.tabs.create({ url: 'https://www.espncricinfo.com' });
      } else {
        window.open('https://www.espncricinfo.com', '_blank');
      }
    });
  }

  // Handle click on full match score line (Flag, Team names, Bat/Ball icons, Scores, Overs)
  document.addEventListener('click', (e) => {
    const link = e.target.closest('.match-title-link');
    if (link && link.href) {
      e.preventDefault();
      if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
        chrome.tabs.create({ url: link.href });
      } else {
        window.open(link.href, '_blank');
      }
    }
  });

  // Matches Section Tabs: Live Scores vs Upcoming
  if (elements.tabLiveBtn && elements.tabUpcomingBtn) {
    elements.tabLiveBtn.addEventListener('click', () => switchMatchesTab('live'));
    elements.tabUpcomingBtn.addEventListener('click', () => switchMatchesTab('upcoming'));
  }

  // Quick 1-click Header Refresh Button
  if (elements.btnHeaderRefresh) {
    elements.btnHeaderRefresh.addEventListener('click', async () => {
      elements.btnHeaderRefresh.classList.add('spinning');
      STATE.dismissalFetchesInFlight = new Set();
      await loadAllData();
      fetchMissingDismissalsAsync(true);
      setTimeout(() => elements.btnHeaderRefresh.classList.remove('spinning'), 600);
    });
  }

  // Settings Modal Toggle
  elements.btnSettings.addEventListener('click', () => {
    elements.settingsOverlay.style.display = 'flex';
  });
  elements.btnCloseSettings.addEventListener('click', () => {
    elements.settingsOverlay.style.display = 'none';
  });
  elements.btnSaveSettings.addEventListener('click', async () => {
    const refreshVal = parseInt(elements.selectRefreshInterval.value, 10);
    const scopeVal = elements.selectFilterScope.value;
    const themeVal = elements.selectTheme ? elements.selectTheme.value : STATE.theme;
    const timeZoneVal = elements.selectTimeZone ? elements.selectTimeZone.value : STATE.timeZone;
    STATE.autoRefreshSeconds = refreshVal;
    STATE.filterScope = scopeVal;
    STATE.theme = themeVal;
    STATE.timeZone = timeZoneVal;
    applyTheme(themeVal);
    await setStored({ autoRefresh: refreshVal, filterScope: scopeVal, theme: themeVal, timeZone: timeZoneVal });
    elements.settingsOverlay.style.display = 'none';
    startRefreshTimer();
    await loadAllData();
  });
  if (elements.selectTimeZone) {
    elements.selectTimeZone.addEventListener('change', async (e) => {
      STATE.timeZone = e.target.value;
      await setStored({ timeZone: STATE.timeZone });
      renderUpcomingMatchesHtml();
    });
  }
  elements.btnManualRefresh.addEventListener('click', async () => {
    elements.settingsOverlay.style.display = 'none';
    await loadAllData();
  });

  // Floating Tooltip for Ball Commentary on Mouse Hover
  let ballTooltipEl = document.getElementById('ball-comm-tooltip');
  if (!ballTooltipEl) {
    ballTooltipEl = document.createElement('div');
    ballTooltipEl.id = 'ball-comm-tooltip';
    ballTooltipEl.className = 'ball-comm-tooltip';
    document.body.appendChild(ballTooltipEl);
  }

  document.addEventListener('mouseover', (e) => {
    const chip = e.target.closest('.ball-chip');
    if (chip && chip.dataset.comm) {
      ballTooltipEl.textContent = chip.dataset.comm;
      ballTooltipEl.style.display = 'block';

      const rect = chip.getBoundingClientRect();
      const tipWidth = Math.min(340, Math.max(160, ballTooltipEl.offsetWidth));
      let left = rect.left + (rect.width / 2) - (tipWidth / 2);
      if (left < 10) left = 10;
      if (left + tipWidth > window.innerWidth - 10) left = window.innerWidth - tipWidth - 10;

      let top = rect.top - ballTooltipEl.offsetHeight - 6;
      if (top < 10) {
        top = rect.bottom + 6;
      }

      ballTooltipEl.style.left = `${left}px`;
      ballTooltipEl.style.top = `${top}px`;
    }
  });

  document.addEventListener('mouseout', (e) => {
    const chip = e.target.closest('.ball-chip');
    if (chip && ballTooltipEl) {
      ballTooltipEl.style.display = 'none';
    }
  });
}

// Switch between Live Scores and Upcoming tabs
function switchMatchesTab(tab) {
  STATE.activeTab = tab;
  if (tab === 'live') {
    elements.tabLiveBtn?.classList.add('active');
    elements.tabUpcomingBtn?.classList.remove('active');
    if (elements.liveScoresContent) {
      elements.liveScoresContent.style.display = 'block';
      elements.liveScoresContent.classList.remove('tab-pane-animate');
      void elements.liveScoresContent.offsetWidth;
      elements.liveScoresContent.classList.add('tab-pane-animate');
    }
    if (elements.upcomingScoresContent) elements.upcomingScoresContent.style.display = 'none';
    if (elements.moreMatchesLink) {
      elements.moreMatchesLink.href = 'https://www.espncricinfo.com/live-cricket-score';
      elements.moreMatchesLink.textContent = 'more scores »';
    }
  } else {
    elements.tabLiveBtn?.classList.remove('active');
    elements.tabUpcomingBtn?.classList.add('active');
    if (elements.liveScoresContent) elements.liveScoresContent.style.display = 'none';
    if (elements.upcomingScoresContent) {
      elements.upcomingScoresContent.style.display = 'block';
      elements.upcomingScoresContent.classList.remove('tab-pane-animate');
      void elements.upcomingScoresContent.offsetWidth;
      elements.upcomingScoresContent.classList.add('tab-pane-animate');
    }
    if (elements.moreMatchesLink) {
      elements.moreMatchesLink.href = 'https://www.espncricinfo.com/cricket-fixtures';
      elements.moreMatchesLink.textContent = 'more fixtures »';
    }
    // Render existing cached upcoming fixtures instantly, then revalidate in background
    renderUpcomingMatchesHtml();
    loadUpcomingMatches();
  }
  updateRealtimeStatusIndicator();
}

// Fetch all live data (Live Scores, Upcoming Schedule, and News)
async function loadAllData() {
  await Promise.all([
    loadLiveScores(),
    loadUpcomingMatches(),
    loadLatestNews()
  ]);
}

// ----------------------------------------------------
// SECTION 1: LIVE SCORES & INTERNATIONAL FILTER
// ----------------------------------------------------

// Verified ESPN Cricket Country Flag IDs that definitely exist on ESPN CDN
const VALID_ESPN_FLAG_IDS = new Set([
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '11', '12', '13', '14', '15',
  '17', '19', '20', '21', '22', '25', '26', '27', '28', '29', '30', '33', '37', '38', '39', '40', '218211'
]);

// Country & Team Flag Map for authentic cricket flags
const TEAM_LOGO_MAP = {
  'pakistan': 'https://a.espncdn.com/i/teamlogos/cricket/500/7.png',
  'india': 'https://a.espncdn.com/i/teamlogos/cricket/500/6.png',
  'australia': 'https://a.espncdn.com/i/teamlogos/cricket/500/2.png',
  'england': 'https://a.espncdn.com/i/teamlogos/cricket/500/1.png',
  'south africa': 'https://a.espncdn.com/i/teamlogos/cricket/500/3.png',
  'new zealand': 'https://a.espncdn.com/i/teamlogos/cricket/500/5.png',
  'west indies': 'https://a.espncdn.com/i/teamlogos/cricket/500/4.png',
  'sri lanka': 'https://a.espncdn.com/i/teamlogos/cricket/500/8.png',
  'bangladesh': 'https://a.espncdn.com/i/teamlogos/cricket/500/25.png',
  'afghanistan': 'https://a.espncdn.com/i/teamlogos/cricket/500/40.png',
  'ireland': 'https://a.espncdn.com/i/teamlogos/cricket/500/29.png',
  'zimbabwe': 'https://a.espncdn.com/i/teamlogos/cricket/500/9.png',
  'netherlands': 'https://a.espncdn.com/i/teamlogos/cricket/500/15.png',
  'scotland': 'https://a.espncdn.com/i/teamlogos/cricket/500/30.png',
  'namibia': 'https://a.espncdn.com/i/teamlogos/cricket/500/28.png',
  'united arab emirates': 'https://a.espncdn.com/i/teamlogos/cricket/500/27.png',
  'uae': 'https://a.espncdn.com/i/teamlogos/cricket/500/27.png',
  'nepal': 'https://a.espncdn.com/i/teamlogos/cricket/500/33.png',
  'oman': 'https://a.espncdn.com/i/teamlogos/cricket/500/37.png',
  'canada': 'https://a.espncdn.com/i/teamlogos/cricket/500/17.png',
  'usa': 'https://a.espncdn.com/i/teamlogos/cricket/500/11.png',
  'united states': 'https://a.espncdn.com/i/teamlogos/cricket/500/11.png',
  'hong kong': 'https://a.espncdn.com/i/teamlogos/cricket/500/19.png',
  'papua new guinea': 'https://a.espncdn.com/i/teamlogos/cricket/500/20.png',
  'png': 'https://a.espncdn.com/i/teamlogos/cricket/500/20.png',
  'denmark': 'https://a.espncdn.com/i/teamlogos/cricket/500/13.png',
  'jersey': 'https://a.espncdn.com/i/teamlogos/cricket/500/218211.png',
  'kuwait': 'https://a.espncdn.com/i/teamlogos/cricket/500/38.png',
  'uganda': 'https://a.espncdn.com/i/teamlogos/cricket/500/39.png',
  'italy': 'https://a.espncdn.com/i/teamlogos/cricket/500/14.png',
  'bermuda': 'https://a.espncdn.com/i/teamlogos/cricket/500/12.png',
  'kenya': 'https://a.espncdn.com/i/teamlogos/cricket/500/26.png',
  'singapore': 'https://a.espncdn.com/i/teamlogos/cricket/500/22.png',
  'malaysia': 'https://a.espncdn.com/i/teamlogos/cricket/500/21.png'
};

// Check if a match is an official International match (Test, ODI, T20I)
// Excludes all domestic tournaments (Ranji, Quaid, SMAT, T10, Leagues, etc.), 'A' teams, youth, and women
function isInternationalMatch(event, league = null) {
  if (!event) return false;

  const comp = event.competitions?.[0] || event;
  const competitors = comp.competitors || event.competitors || [];
  const t1 = competitors[0] || (event.team1 ? { displayName: event.team1, id: event.team1Id } : {});
  const t2 = competitors[1] || (event.team2 ? { displayName: event.team2, id: event.team2Id } : {});

  const t1Name = (t1.displayName || t1.name || t1.shortName || (typeof event.team1 === 'string' ? event.team1 : '')).toLowerCase().trim();
  const t2Name = (t2.displayName || t2.name || t2.shortName || (typeof event.team2 === 'string' ? event.team2 : '')).toLowerCase().trim();
  const leagueName = (league?.name || event.leagueName || '').toLowerCase().trim();
  const eventName = (event.name || '').toLowerCase().trim();
  const combined = `${leagueName} ${eventName} ${t1Name} ${t2Name}`;

  // 1. Exclude youth / under-19
  const youthRegex = /\b(under[- ]?(?:19|23|21|18|17|16|15)s?|u[- ]?(?:19|23|21|18|17|16|15)s?|youth\s+(?:odi|t20|test|match))\b/i;
  if (youthRegex.test(combined)) return false;

  // 2. Exclude women matches
  const womenRegex = /\b(women(?:'s|s)?|wbbl|wpl|wt20i?|wodi|w-t20|w-odi|w-test)\b|\(w\)|\b[a-z]{2,10}-w\b|\b[a-z]{3,}\s+w\b/i;
  if (womenRegex.test(combined)) return false;

  // 3. Exclude 'A' teams, academy, XI, second XI, developmental, colts, rising stars, shaheens, lions
  const aTeamRegex = /\b(?:[a-z]+\s+)?(?:a|xi|shaheens?|lions?|development|emerging|rising\s+stars|academy|colts)\b/i;
  if (aTeamRegex.test(t1Name) || aTeamRegex.test(t2Name)) return false;

  // 4. Exclude matches where tournament or team is clearly domestic / franchise / club
  const iccMajor = /\b(world\s*cup|champions\s*trophy|asia\s*cup|world\s*test\s*championship|wtc|super\s*league)\b/i;
  const domesticRegex = /\b(trophy|shield|cup|league|county|blast|ranji|quaid|plunket|mushtaq|hazare|marsh|ford|bbl|ipl|psl|cpl|bpl|npl|t10|hundred|smash|division|premier|state|region|inter-state|inter-district|provincial|club|major\s+league|challenge\s+league|vitality|duleep|deodhar|president|pro50|pro20|csa\s+\d-day|csa\s+women|super\s+smash|slc\s+major|abu\s+dhabi\s+t10|ilt20|mlc|max60)\b/i;

  if (domesticRegex.test(leagueName) && !iccMajor.test(leagueName)) {
    return false;
  }

  // 5. Check ESPN internationalClassId
  // In ESPN: intlClassId > 0 means international Test (1), ODI (2), T20I (3), etc.
  // intlClassId === 0 means domestic / franchise / first-class / list-A
  const intlClassId = Number(event.class?.internationalClassId || comp.class?.internationalClassId || 0);
  if (intlClassId > 0) {
    return true;
  }

  // 6. If intlClassId is 0 or missing, only accept if both teams are confirmed national teams
  const t1Id = String(t1.id || '');
  const t2Id = String(t2.id || '');
  const isT1Nat = t1.isNational === true || VALID_ESPN_FLAG_IDS.has(t1Id) || Boolean(TEAM_LOGO_MAP[t1Name]);
  const isT2Nat = t2.isNational === true || VALID_ESPN_FLAG_IDS.has(t2Id) || Boolean(TEAM_LOGO_MAP[t2Name]);

  if (isT1Nat && isT2Nat && !domesticRegex.test(combined)) {
    return true;
  }

  return false;
}

// Ensure team batting first is Team 1 (left side) and team bowling first/batting second is Team 2 (right side)
function getOrderedTeams(competitors, event = null, comp = null) {
  if (!Array.isArray(competitors) || competitors.length < 2) {
    return [competitors?.[0] || {}, competitors?.[1] || {}];
  }

  const c0 = competitors[0] || {};
  const c1 = competitors[1] || {};

  // 1. Check ESPN competitor order (order 1 = batted first, order 2 = bowled first)
  const order1 = competitors.find(c => Number(c.order) === 1);
  const order2 = competitors.find(c => Number(c.order) === 2);
  if (order1 && order2 && order1 !== order2) {
    return [order1, order2];
  }

  // 2. In 1st innings (period <= 1) or when only one team has overs/score
  const s0 = (c0.score || '').trim();
  const s1 = (c1.score || '').trim();
  const period = event?.fullStatus?.period || comp?.fullStatus?.period || event?.period || comp?.period || 1;

  if (period <= 1) {
    const c0HasOvers = /\(\s*\d+(?:\.\d+)?(?:\/\d+)?\s*ov/i.test(s0);
    const c1HasOvers = /\(\s*\d+(?:\.\d+)?(?:\/\d+)?\s*ov/i.test(s1);

    if (c1HasOvers && !c0HasOvers && !s0) {
      return [c1, c0];
    }
    if (c0HasOvers && !c1HasOvers && !s1) {
      return [c0, c1];
    }
  }

  // 3. Check toss detail from summary
  const summary = (comp?.fullStatus?.summary || comp?.status?.type?.detail || event?.summary || '').toLowerCase();
  const n0 = (c0.displayName || c0.name || '').toLowerCase();
  const n1 = (c1.displayName || c1.name || '').toLowerCase();

  if (summary.includes('won toss & batted') || summary.includes('opted to bat') || summary.includes('elected to bat') || summary.includes('chose to bat')) {
    if (n1 && summary.includes(n1)) return [c1, c0];
    if (n0 && summary.includes(n0)) return [c0, c1];
  }
  if (summary.includes('won toss & fielded') || summary.includes('opted to bowl') || summary.includes('elected to field') || summary.includes('chose to field')) {
    if (n1 && summary.includes(n1)) return [c0, c1];
    if (n0 && summary.includes(n0)) return [c1, c0];
  }

  return [c0, c1];
}
async function loadLiveScores() {
  const rawData = await fetchScoresData();

  if (!rawData && typeof CLASSIC_FALLBACK_DATA !== 'undefined') {
    if (!STATE.liveMatches || STATE.liveMatches.length === 0) {
      STATE.liveMatches = CLASSIC_FALLBACK_DATA.liveMatches;
      renderLiveMatchesHtml();
    }
    return;
  }

  const matches = [];
  const leagues = rawData?.sports?.[0]?.leagues || [];

  // Track completion timestamps for ended matches to hide results after 1 hour
  const storedEnded = (await getStored(['endedMatchTimestamps'])).endedMatchTimestamps || {};
  const endedMap = { ...storedEnded };

  for (const league of leagues) {
    const leagueName = league.name || '';
    for (const event of (league.events || [])) {
      // Scope filter: if 'intl', strictly show international matches only (no domestic / youth / women / clubs)
      if (STATE.filterScope === 'intl' && !isInternationalMatch(event, league)) {
        continue;
      }

      const comp = event.competitions?.[0] || event;
      const eventName = event.name || '';

      const competitors = comp.competitors || event.competitors || [];
      const [team1, team2] = getOrderedTeams(competitors, event, comp);

      const t1Name = team1.displayName || team1.name || team1.shortName || 'Team 1';
      const t2Name = team2.displayName || team2.name || team2.shortName || 'Team 2';

      // Check if match is live or ended
      const rawState = comp.status?.type?.state || event.status || '';
      const isLive = rawState === 'in';
      const isEnded = rawState === 'post' || comp.status?.type?.state === 'post' || event.fullStatus?.type?.state === 'post';
      const period = event.fullStatus?.period || comp.fullStatus?.period || event.period || comp.period || 1;

      // User requirement: jis match ka result aa jy 1 hours bad wo display na ho
      const isEndedMoreThan1Hour = isEnded ? checkIsEndedMoreThan1Hour(event, endedMap) : false;

      const t1Logo = team1.logo || (VALID_ESPN_FLAG_IDS.has(String(team1.id)) ? `https://a.espncdn.com/i/teamlogos/cricket/500/${team1.id}.png` : '');
      const t2Logo = team2.logo || (VALID_ESPN_FLAG_IDS.has(String(team2.id)) ? `https://a.espncdn.com/i/teamlogos/cricket/500/${team2.id}.png` : '');

      const s1 = cleanCricketScore(team1.score);
      const s2 = cleanCricketScore(team2.score);

      const summary = (comp.fullStatus?.summary || comp.status?.type?.detail || event.summary || '').trim();
      const session = (comp.fullStatus?.session || '').trim();
      const statusText = session ? `${summary} • ${session}` : summary;

      // Check if match has not actually started (both scores empty or summary says "Starts at...")
      const isNotStarted = (!s1 && !s2) || /^starts\s+at/i.test(summary) || (period === 0 && !isEnded);

      // Real-time break, stumps or result state
      const breakInfo = extractMatchBreakInfo(event, isEnded);

      const leagueId = String(event.leagueId || league.id || '200');
      const rawUrl = event.link || `https://www.espncricinfo.com/series/match/${event.id}`;
      const matchUrl = toCricinfoUrl(rawUrl);

      // Determine how many wickets have fallen in the ACTIVE batting innings
      const battingId = comp.fullStatus?.battingTeamId || event.fullStatus?.battingTeamId;
      let currentInningsWickets = null;

      if (battingId) {
        const battingComp = competitors.find(c => String(c.id) === String(battingId));
        if (battingComp && battingComp.score) {
          const wMatch = battingComp.score.match(/(\d+)\s*\/\s*(\d+)/);
          if (wMatch) {
            currentInningsWickets = parseInt(wMatch[2], 10);
          } else if (/\(\s*\d+(?:\.\d+)?(?:\/\d+)?\s*ov/i.test(battingComp.score)) {
            // Score has overs but no slash (e.g. 325 (87.5 ov)) -> All out (10 wickets)
            currentInningsWickets = 10;
          }
        }
      }

      if (currentInningsWickets === null) {
        for (const c of competitors) {
          const sc = c.score || '';
          if (/\(\s*\d+(?:\.\d+)?(?:\/\d+)?\s*ov/i.test(sc)) {
            const wMatch = sc.match(/(\d+)\s*\/\s*(\d+)/);
            if (wMatch) {
              currentInningsWickets = parseInt(wMatch[2], 10);
              break;
            } else {
              currentInningsWickets = 10;
              break;
            }
          }
        }
      }

      // Check if existing state already has lastWicket cached
      const existingMatch = STATE.liveMatches.find(m => m.id === String(event.id));
      const isStumps = breakInfo.className === 'state-stumps' || /stumps|close\s+of\s+play/i.test(breakInfo.label || '') || /stumps/i.test(statusText || '');

      // Determine which team is batting and which is bowling
      let battingTeamNum = null;
      if (battingId) {
        if (String(team1.id) === String(battingId)) battingTeamNum = 1;
        else if (String(team2.id) === String(battingId)) battingTeamNum = 2;
      }
      if (battingTeamNum === null) {
        if (/\(\s*\d+(?:\.\d+)?(?:\/\d+)?\s*ov/i.test(s1)) battingTeamNum = 1;
        else if (/\(\s*\d+(?:\.\d+)?(?:\/\d+)?\s*ov/i.test(s2)) battingTeamNum = 2;
      }

      let bowlingTeamNum = null;
      if (battingTeamNum === 1) bowlingTeamNum = 2;
      else if (battingTeamNum === 2) bowlingTeamNum = 1;

      // Real-time delivery event tracking (Runs, Six, Four, Out, Dot)
      const eventIdStr = String(event.id);
      const activeScoreStr = battingTeamNum === 1 ? s1 : (battingTeamNum === 2 ? s2 : (s1 || s2));
      const currentParsed = parseCricketScore(activeScoreStr);

      STATE.liveEventsMap = STATE.liveEventsMap || {};
      const prevData = STATE.liveEventsMap[eventIdStr];
      let ballEvent = null;
      let wicketFellNow = false;

      if (isLive && !isEnded && !isNotStarted && !isStumps) {
        if (prevData?.parsed) {
          const p = prevData.parsed;
          if (currentParsed.wickets !== null && p.wickets !== null && currentParsed.wickets > p.wickets) {
            wicketFellNow = true;
            ballEvent = { type: 'wicket', text: '💥 OUT! WICKET', ts: Date.now() };
          } else if (currentParsed.runs !== null && p.runs !== null && currentParsed.runs > p.runs) {
            const diff = currentParsed.runs - p.runs;
            if (diff >= 6) ballEvent = { type: 'six', text: '🔥 6 SIX!', ts: Date.now() };
            else if (diff >= 4) ballEvent = { type: 'four', text: '🎯 4 FOUR', ts: Date.now() };
            else ballEvent = { type: 'runs', text: `+${diff} run${diff > 1 ? 's' : ''}`, ts: Date.now() };
          } else if (currentParsed.overs !== null && p.overs !== null && currentParsed.overs > p.overs && currentParsed.runs === p.runs) {
            ballEvent = { type: 'dot', text: '⚪ 0 dot', ts: Date.now() };
          }
        }

        // Keep recent event badge visible for 8 seconds then fade out
        if (!ballEvent && prevData?.lastEvent) {
          if (Date.now() - prevData.lastEvent.ts < 8000) {
            ballEvent = prevData.lastEvent;
          }
        }
      }

      STATE.liveEventsMap[eventIdStr] = {
        parsed: currentParsed,
        lastEvent: ballEvent || null
      };

      // Check if existing state already has lastWicket cached
      // Always retain existing lastWicket to prevent card collapsing/shaking while waiting for new dismissal
      const hasWicketsDown = currentInningsWickets === null || currentInningsWickets > 0;
      const periodChanged = period !== undefined &&
                            existingMatch?.period !== undefined &&
                            existingMatch?.period !== null &&
                            period !== existingMatch.period;

      let lastWicket = null;
      let currentBowler = '';
      let currentBatting = null;
      let recentBalls = null;
      let lastBallCommentary = null;

      // Only inherit previous match fields if innings (period) HAS NOT CHANGED
      if (!periodChanged && existingMatch) {
        if (!isStumps && !isEnded && isLive && hasWicketsDown) {
          lastWicket = existingMatch.lastWicket || null;
        }
        currentBowler = existingMatch.currentBowler || '';
        currentBatting = existingMatch.currentBatting || null;
        recentBalls = existingMatch.recentBalls || null;
        lastBallCommentary = existingMatch.lastBallCommentary || null;
      }

      // If period changed (e.g. innings break over, new innings began), clear in-flight flag to force immediate fetch
      if (periodChanged) {
        STATE.dismissalFetchesInFlight?.delete(eventIdStr);
      }

      matches.push({
        id: eventIdStr,
        leagueId,
        leagueName,
        team1: t1Name,
        team2: t2Name,
        team1Id: team1.id ? String(team1.id) : '',
        team2Id: team2.id ? String(team2.id) : '',
        logo1: t1Logo,
        logo2: t2Logo,
        score1: s1,
        score2: s2,
        isLive,
        isEnded,
        isEndedMoreThan1Hour,
        isNotStarted,
        period,
        summary: statusText,
        breakLabel: breakInfo.label,
        breakClass: breakInfo.className,
        currentInningsWickets,
        lastWicket,
        currentBowler,
        currentBatting,
        recentBalls,
        lastBallCommentary,
        battingTeamNum,
        bowlingTeamNum,
        ballEvent,
        matchUrl
      });
    }
  }

  // Candidate matches: Live in progress, break/stumps, or ended within the last 1 hour
  // (Results older than 1 hour are automatically filtered out)
  const candidateMatches = matches.filter(m => {
    if (m.isNotStarted) return false;
    if (m.isEnded && m.isEndedMoreThan1Hour) return false;
    return (m.isLive || m.isEnded || m.breakLabel);
  });

  // Cleanup endedMap entries older than 48 hours and persist
  const twoDaysAgo = Date.now() - 48 * 60 * 60 * 1000;
  for (const k in endedMap) {
    if (endedMap[k] < twoDaysAgo) delete endedMap[k];
  }
  await setStored({ endedMatchTimestamps: endedMap });

  // SORT MATCHES: Actively live at TOP, 🌙 Stumps and finished matches at LAST/BOTTOM!
  const sorted = sortMatchesByLivePriority(candidateMatches, STATE.pinnedMatchId);

  // Take top 8 matches for clean display
  STATE.liveMatches = sorted.slice(0, 8);

  // Update Chrome action hover tooltip with live match scores
  updateLiveTooltip();

  // Render immediately with updated scores
  renderLiveMatchesHtml();

  // Persist to cache (including liveEventsMap for ball-by-ball memory)
  await setStored({ cachedLiveMatches: STATE.liveMatches, liveEventsMap: STATE.liveEventsMap });

  // Dynamically update real-time polling indicator & timer
  updateRealtimeStatusIndicator();

  // Non-blocking background fetch of missing dismissals
  fetchMissingDismissalsAsync();
}

// Sort priority: Pinned (0) > Actively live (1) > Drinks/Innings break (2) > Tea/Lunch/Rain (3) > Stumps (4) > Ended Major (5.0) > Ended Sixes (5.5)
function sortMatchesByLivePriority(matchesList, pinnedId) {
  return [...matchesList].sort((a, b) => {
    if (pinnedId) {
      if (a.id === pinnedId) return -1;
      if (b.id === pinnedId) return 1;
    }
    const weightA = getMatchSortWeight(a);
    const weightB = getMatchSortWeight(b);
    return weightA - weightB;
  });
}

function getMatchSortWeight(m) {
  // Stumps (close of play for the day in Test match) -> near bottom
  const isStumps = m.breakClass === 'state-stumps' || /stumps|close\s+of\s+play/i.test(m.breakLabel || '') || /stumps/i.test(m.summary || '');
  if (isStumps) return 4;

  // Match ended/result ("won by", "won the match", "tied", "drawn", "abandoned", "no result", state === 'post')
  const isEnded = m.isEnded || /won\s+by|won\s+the\s+match|match\s+tied|drawn|no\s+result|abandoned/i.test(m.summary || '');
  if (isEnded) {
    const isSixes = /sixes/i.test(m.leagueName || '') || /\b6\s*ov\b/i.test((m.score1 || '') + (m.score2 || '') + (m.summary || ''));
    return isSixes ? 5.5 : 5.0; // Major match results (like NZ won by 87 runs) come before exhibition tournaments
  }

  // Rain delay / Bad light delay
  if (m.breakClass === 'state-delay' || /rain|bad\s+light/i.test(m.breakLabel || '')) return 3;

  // Temporary live break (Drinks / Tea / Lunch / Innings break)
  if (m.breakLabel) return 2;

  // Actively being played right now (ball by ball live)
  return 1;
}

// Extract real-time break state (Drinks, Stumps, Tea, Lunch, Rain, Innings Break, or Result)
function extractMatchBreakInfo(event, isEnded = false) {
  if (isEnded) {
    return { label: 'Result', className: 'state-result' };
  }

  const fs = event.fullStatus || {};
  const statusType = fs.type || {};
  const desc = (statusType.description || '').trim();
  const detail = (statusType.detail || '').trim();
  const summary = (fs.summary || '').trim();

  // If match is actively LIVE ball-by-ball, there is NO break!
  // (Do NOT check historical notes, which contain past days' tea/drinks logs)
  if (/^live$/i.test(desc) && /^(live|in)$/i.test(detail) && !/break|stumps|rain|delay/i.test(summary)) {
    return { label: '', className: '' };
  }

  const dayNum = fs.dayNumber || 0;
  const daySuffix = dayNum > 0 ? ` • Day ${dayNum}` : '';

  // 1. Stumps (Close of play for the day in Test match)
  if (/stumps|close\s+of\s+play/i.test(desc) || /\bstumps\b/i.test(summary)) {
    return { label: `🌙 Stumps${daySuffix}`, className: 'state-stumps' };
  }

  // 2. Innings Break
  if (/innings\s+break/i.test(desc) || /innings\s+break/i.test(detail) || /\binnings\s+break\b/i.test(summary) || /mid\s+innings/i.test(desc) || /mid\s+innings/i.test(summary) || /innings\s+break/i.test(statusType.shortDetail || '')) {
    return { label: `Innings Break`, className: 'state-break' };
  }

  // 3. Rain / Weather Delays
  if (/rain|wet\s+outfield|delayed/i.test(desc) || /rain\s+delay|match\s+delayed/i.test(summary)) {
    return { label: `🌧️ Rain Delay`, className: 'state-delay' };
  }
  if (/bad\s+light/i.test(desc) || /\bbad\s+light\b/i.test(summary)) {
    return { label: `⚠️ Bad Light Delay`, className: 'state-delay' };
  }

  // 4. Tea Break (Active only when desc or summary specifically states tea right now)
  if (/^tea(\s+break)?$/i.test(desc) || /\btea\s+break\b/i.test(summary)) {
    return { label: `☕ Tea Break${daySuffix}`, className: 'state-tea' };
  }

  // 5. Lunch Break (Active only when desc or summary specifically states lunch right now)
  if (/^lunch(\s+break)?$/i.test(desc) || /\blunch\s+break\b/i.test(summary)) {
    return { label: `🍽️ Lunch Break${daySuffix}`, className: 'state-lunch' };
  }

  // 6. Drinks Break (Active only when desc or summary specifically states drinks right now)
  if (/^drinks(\s+break)?$/i.test(desc) || /\bdrinks\s+break\b/i.test(summary)) {
    return { label: `🥤 Drinks Break`, className: 'state-drinks' };
  }

  return { label: '', className: '' };
}

// Check if an ended match completed more than 1 hour ago (User requirement: hide results after 1 hour)
function checkIsEndedMoreThan1Hour(event, endedMap) {
  try {
    const eventId = String(event.id);
    const ONE_HOUR_MS = 60 * 60 * 1000;
    const now = Date.now();

    if (endedMap && endedMap[eventId]) {
      return (now - endedMap[eventId]) > ONE_HOUR_MS;
    }

    // Estimate based on match start time and format
    const startTime = new Date(event.date).getTime();
    if (isNaN(startTime)) {
      if (endedMap) endedMap[eventId] = now;
      return false;
    }

    const notesText = Array.isArray(event.notes) ? event.notes.map(n => n?.text || '').join(' ') : '';
    const combined = `${event.name || ''} ${notesText}`.toLowerCase();

    let durationMs = 3.5 * 60 * 60 * 1000; // default 3.5 hours for T20
    if (/6-over|sixes/i.test(combined)) {
      durationMs = 45 * 60 * 1000; // 45 min
    } else if (/50-over|odi/i.test(combined)) {
      durationMs = 7.5 * 60 * 60 * 1000; // 7.5 hours
    } else if (/test|5-day|4-day/i.test(combined)) {
      const dayNum = event.fullStatus?.dayNumber || 1;
      durationMs = (dayNum * 24 + 7) * 60 * 60 * 1000;
    }

    const estEndTime = startTime + durationMs;
    const recordedEnd = Math.min(now, estEndTime);
    if (endedMap) endedMap[eventId] = recordedEnd;

    return (now - recordedEnd) > ONE_HOUR_MS;
  } catch (e) {
    return false;
  }
}

// Asynchronously fetch last wicket dismissals for live matches without blocking UI
async function fetchMissingDismissalsAsync(force = false) {
  STATE.dismissalFetchesInFlight = STATE.dismissalFetchesInFlight || new Set();

  for (const m of STATE.liveMatches) {
    const isStumps = m.breakClass === 'state-stumps' || /stumps|close\s+of\s+play/i.test(m.breakLabel || '') || /stumps/i.test(m.summary || '');
    const hasWicketsDown = m.currentInningsWickets === null || m.currentInningsWickets > 0;

    // Fetch for all actively live matches (including 0 wickets down for opening batting/bowling/overs)
    if (m.isLive && !isStumps && !m.isEnded && !m.isNotStarted) {
      if (!force && STATE.dismissalFetchesInFlight.has(m.id)) continue;
      STATE.dismissalFetchesInFlight.add(m.id);

      fetchLastWicketDismissal(m.leagueId, m.id, m.period).then((res) => {
        STATE.dismissalFetchesInFlight.delete(m.id);
        if (res) {
          const text = typeof res === 'string' ? res : (res.text || '');
          const bowler = typeof res === 'object' && res.bowler ? res.bowler : '';
          const batting = typeof res === 'object' && res.batting ? res.batting : null;
          const recentBalls = typeof res === 'object' && res.recentBalls ? res.recentBalls : null;
          const ballEvent = typeof res === 'object' && res.ballEvent ? res.ballEvent : null;
          const commentary = typeof res === 'object' && res.commentary ? res.commentary : null;

          m.lastWicket = text;
          m.currentBowler = bowler;
          m.currentBatting = batting;
          m.recentBalls = recentBalls;
          m.ballEvent = ballEvent;
          m.lastBallCommentary = commentary;

          const cardEl = document.querySelector(`.live-match-card[data-match-id="${m.id}"]`);
          if (cardEl) {
            const currentIsBreak = Boolean(m.breakLabel) || 
              (m.breakClass && m.breakClass !== '') || 
              /break|stumps|lunch|tea|drinks|rain|delay|bad\s+light/i.test(m.breakLabel || '') || 
              /break|stumps|lunch|tea|drinks|rain|delay|bad\s+light/i.test(m.summary || '');
            const currentHasWickets = m.currentInningsWickets === null || m.currentInningsWickets > 0;

            const batContainer = cardEl.querySelector('.current-batting-container');
            const bContainer = cardEl.querySelector('.current-bowler-container');
            const rContainer = cardEl.querySelector('.recent-balls-container');
            const lwContainer = cardEl.querySelector('.last-wicket-container');
            const rightEl = cardEl.querySelector('.status-bar-right');
            const centerEl = cardEl.querySelector('.status-bar-center');
            const commContainer = cardEl.querySelector('.comm-container');
            const r1El = cardEl.querySelector('.team-1-role');
            const r2El = cardEl.querySelector('.team-2-role');

            // Hide commentary button completely per user preference
            if (centerEl && centerEl.innerHTML !== '') centerEl.innerHTML = '';
            if (commContainer && commContainer.innerHTML !== '') commContainer.innerHTML = '';
            if (rightEl && rightEl.innerHTML !== '') rightEl.innerHTML = '';

            // If Break (Innings Break, Lunch, Tea, Stumps, Delay), or Match Ended: CLEAR batting, bowling, overs, last wicket, and bat/ball icons
            if (currentIsBreak || m.isEnded || m.isNotStarted) {
              if (batContainer && batContainer.innerHTML !== '') batContainer.innerHTML = '';
              if (bContainer && bContainer.innerHTML !== '') bContainer.innerHTML = '';
              if (rContainer && rContainer.innerHTML !== '') rContainer.innerHTML = '';
              if (lwContainer && lwContainer.innerHTML !== '') lwContainer.innerHTML = '';
              if (r1El && r1El.innerHTML !== '') r1El.innerHTML = '';
              if (r2El && r2El.innerHTML !== '') r2El.innerHTML = '';
            } else {
              // Clear right notification badge (hidden per user preference)
              if (rightEl && rightEl.innerHTML !== '') rightEl.innerHTML = '';

              // Update Current Batting Line in DOM (Facing batter updates on every single)
              const newBatHtml = m.currentBatting ? formatBattingHtml(m.currentBatting) : '';
              if (batContainer && batContainer.innerHTML !== newBatHtml) {
                batContainer.innerHTML = newBatHtml;
              }

              // Update Current Bowler Line in DOM
              const newBHtml = m.currentBowler
                ? `<div class="current-bowler-line"><span class="bowler-tag">Bowling:</span> ${formatBowlerHtml(m.currentBowler)}</div>`
                : '';
              if (bContainer && bContainer.innerHTML !== newBHtml) {
                bContainer.innerHTML = newBHtml;
              }

              // Update Recent Balls Line in DOM (2 Overs Timeline with current over bold)
              const newRHtml = (m.recentBalls && m.recentBalls.length > 0)
                ? `<div class="recent-balls-line"><span class="recent-tag">Overs:</span> <div class="recent-balls-track">${formatRecentBallsHtml(m.recentBalls)}</div></div>`
                : '';
              if (rContainer && rContainer.innerHTML !== newRHtml) {
                rContainer.innerHTML = newRHtml;
              }

              // Update Last Wicket Line in DOM
              const newLwHtml = (m.lastWicket && currentHasWickets)
                ? `<div class="last-wicket-line"><span class="lw-tag">Wicket:</span> ${formatDismissalHtml(m.lastWicket)}</div>`
                : '';
              if (lwContainer && lwContainer.innerHTML !== newLwHtml) {
                lwContainer.innerHTML = newLwHtml;
              }
            }
          }
          setStored({ cachedLiveMatches: STATE.liveMatches });
        }
      }).catch(() => {
        STATE.dismissalFetchesInFlight.delete(m.id);
      });
    }
  }
}



// Rich, high-contrast gradient palettes for custom cricket team badges
const TEAM_BADGE_PALETTES = [
  ['#1e3a8a', '#172554'], // Deep Navy / Midnight Blue
  ['#065f46', '#022c22'], // Forest / Emerald Green
  ['#991b1b', '#450a0a'], // Crimson / Dark Maroon
  ['#b45309', '#78350f'], // Amber / Burnt Bronze
  ['#0f766e', '#134e4a'], // Deep Teal / Dark Cyan
  ['#6b21a8', '#3b0764'], // Royal Purple / Violet
  ['#1f2937', '#111827'], // Slate / Obsidian
  ['#0369a1', '#082f49'], // Deep Cobalt / Ocean Blue
  ['#831843', '#500724'], // Deep Rose / Wine
  ['#365314', '#1a2e05'], // Olive / Field Green
  ['#4338ca', '#312e81'], // Indigo
  ['#c2410c', '#7c2d12']  // Rust / Terracotta
];

// Deterministically pick consistent badge colors from team name
function getTeamPalette(teamName = '') {
  let hash = 0;
  for (let i = 0; i < teamName.length; i++) {
    hash = (hash << 5) - hash + teamName.charCodeAt(i);
    hash |= 0;
  }
  const index = Math.abs(hash) % TEAM_BADGE_PALETTES.length;
  return TEAM_BADGE_PALETTES[index];
}

// Generate crisp 2-letter uppercase monogram (e.g. "South Western Districts" -> "SW", "Easterns" -> "EA")
function getTeamInitials(teamName = '') {
  if (!teamName) return 'CR';
  const clean = teamName.replace(/[^a-zA-Z0-9\s]/g, ' ').trim();
  if (!clean) return 'CR';
  const words = clean.split(/\s+/).filter(w => !/^(and|of|the|v|vs|xi|a|b|under|u\d+|men|cricket|club|cc)$/i.test(w));
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }
  return clean.slice(0, 2).toUpperCase();
}

// Check if a team has an authentic national cricket flag
function findCountryFlagUrl(teamName = '', teamId = '', logoUrl = '') {
  if (logoUrl) {
    const espnMatch = logoUrl.match(/\/cricket\/500\/(\d+)\.png/);
    if (espnMatch) {
      if (VALID_ESPN_FLAG_IDS.has(espnMatch[1])) return logoUrl;
    } else {
      return logoUrl;
    }
  }

  if (teamId && VALID_ESPN_FLAG_IDS.has(String(teamId).trim())) {
    return `https://a.espncdn.com/i/teamlogos/cricket/500/${teamId}.png`;
  }

  if (!teamName) return '';
  const clean = teamName.toLowerCase().trim();

  // Exact match
  if (TEAM_LOGO_MAP[clean]) {
    return TEAM_LOGO_MAP[clean];
  }

  // National team variants: "India A", "New Zealand A", "Pakistan Shaheens", "England Lions", etc.
  for (const [country, url] of Object.entries(TEAM_LOGO_MAP)) {
    const variantRegex = new RegExp(`^${country}\\s+(?:a|xi|under-19s?|u-?19|shaheens?|lions?|development|emerging)\\b`, 'i');
    if (variantRegex.test(clean)) {
      return url;
    }
  }

  return '';
}

// Render country flag or elegant custom team monogram badge
function getTeamFlagHtml(teamName = '', teamId = '', logoUrl = '') {
  if (typeof teamId === 'string' && (teamId.startsWith('http://') || teamId.startsWith('https://'))) {
    logoUrl = teamId;
    teamId = '';
  }

  const flagUrl = findCountryFlagUrl(teamName, teamId, logoUrl);
  if (flagUrl) {
    return `<img src="${escapeHtml(flagUrl)}" class="team-flag-img" alt="${escapeHtml(teamName)}">`;
  }

  // Custom team badge for domestic/provincial/club matches without flags
  const initials = getTeamInitials(teamName);
  const [c1, c2] = getTeamPalette(teamName);
  return `<span class="team-badge-custom" style="background: linear-gradient(135deg, ${c1}, ${c2});" title="${escapeHtml(teamName)}">${escapeHtml(initials)}</span>`;
}

// SVG Cricket Ball (Bowling indicator)
function getBowlingBallSvg(teamName = '') {
  return `<span class="role-indicator bowling-indicator" title="${escapeHtml(teamName ? teamName + ' is Bowling now' : 'Bowling now')}">
    <svg class="bowling-ball-icon" viewBox="0 0 20 20" width="13" height="13">
      <circle cx="10" cy="10" r="8" fill="#e11d48"/>
      <path d="M10 2 A8 8 0 0 1 18 10 A8 8 0 0 1 10 18 A8 8 0 0 0 10 2 Z" fill="#9f1239" opacity="0.4"/>
      <path d="M10 2 C 7 6, 7 14, 10 18" stroke="#ffffff" stroke-width="1.2" stroke-dasharray="1.2 0.8" fill="none"/>
      <path d="M10 2 C 13 6, 13 14, 10 18" stroke="#ffffff" stroke-width="1.2" stroke-dasharray="1.2 0.8" fill="none"/>
    </svg>
  </span>`;
}

// SVG Cricket Bat (Batting indicator)
function getBattingBatSvg(teamName = '') {
  return `<span class="role-indicator batting-indicator" title="${escapeHtml(teamName ? teamName + ' is Batting now' : 'Batting now')}">
    <svg class="batting-bat-icon" viewBox="0 0 20 20" width="13" height="13">
      <path d="M13 2 L16 5 L7 14 L4 14 L3 13 L13 2 Z" fill="#d97706" stroke="#92400e" stroke-width="0.8"/>
      <rect x="14.5" y="0.8" width="2" height="4.5" transform="rotate(45 14.5 0.8)" fill="#78350f" rx="0.5"/>
      <line x1="14" y1="2" x2="16" y2="4" stroke="#ffffff" stroke-width="0.8"/>
      <line x1="12" y1="4" x2="6" y2="12" stroke="#b45309" stroke-width="0.8"/>
    </svg>
  </span>`;
}

// Clean and normalize cricket score string: decode HTML entities & standardize spacing around '&'
function cleanCricketScore(scoreStr) {
  if (!scoreStr) return '';
  let s = String(scoreStr);
  // Decode HTML entities if present in API or string
  s = s.replace(/&amp;/gi, '&').replace(/&dagger;/gi, '†').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
  // Ensure clean single space around ampersand (&): e.g. "272 & 142"
  s = s.replace(/\s*&\s*/g, ' & ');
  // Ensure clean spacing before parenthesis: "54/0 (11.2 ov, target 170)"
  s = s.replace(/\s*\(\s*/g, ' (');
  // Collapse multi-spaces and trim
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// Parse runs, wickets, and overs from cricket score string
function parseCricketScore(scoreStr = '') {
  const cleaned = cleanCricketScore(scoreStr);
  let runs = null;
  let wickets = null;
  let overs = null;

  const ovMatch = cleaned.match(/\(\s*(\d+(?:\.\d+)?)(?:\/\d+)?\s*ov/i);
  if (ovMatch) {
    overs = parseFloat(ovMatch[1]);
  }

  const rwMatch = cleaned.match(/(\d+)\s*\/\s*(\d+)\s*(?:\([^)]*\))?$/);
  if (rwMatch) {
    runs = parseInt(rwMatch[1], 10);
    wickets = parseInt(rwMatch[2], 10);
  } else {
    const rMatch = cleaned.match(/(\d+)\s*(?:\([^)]*\))?$/);
    if (rMatch) {
      runs = parseInt(rMatch[1], 10);
      wickets = (overs !== null && overs > 0) ? 10 : 0;
    }
  }

  return { runs, wickets, overs };
}

// Check if existing cards in DOM can be updated in-place without rebuilding DOM
function canUpdateCardsInPlace() {
  const existingCards = elements.liveScoresContent.querySelectorAll('.live-match-card');
  if (existingCards.length === 0 || existingCards.length !== STATE.liveMatches.length) return false;
  for (let i = 0; i < existingCards.length; i++) {
    const card = existingCards[i];
    if (card.getAttribute('data-match-id') !== String(STATE.liveMatches[i].id)) {
      return false;
    }
    const teamLinks = card.querySelectorAll('.team-link');
    if (teamLinks.length >= 2) {
      if (teamLinks[0].textContent.trim() !== String(STATE.liveMatches[i].team1).trim() ||
          teamLinks[1].textContent.trim() !== String(STATE.liveMatches[i].team2).trim()) {
        return false;
      }
    }
  }
  return true;
}

// Render all live match cards cleanly with break badge AT THE TOP
function renderLiveMatchesHtml() {
  if (!STATE.liveMatches || STATE.liveMatches.length === 0) {
    elements.liveScoresContent.innerHTML = `
      <div class="empty-box-state">No live international cricket matches right now.</div>
    `;
    return;
  }

  // Helper to compute card content for a given match
  function computeMatchCardData(match) {
    const isPinned = STATE.pinnedMatchId === match.id;
    const clean1 = cleanCricketScore(match.score1);
    const clean2 = cleanCricketScore(match.score2);
    const score1Text = clean1 ? ` ${clean1}` : '';
    const score2Text = clean2 ? ` ${clean2}` : '';
    const score1Html = clean1 ? ` ${escapeHtml(clean1)}` : '';
    const score2Html = clean2 ? ` ${escapeHtml(clean2)}` : '';
    const flag1Html = getTeamFlagHtml(match.team1, match.team1Id, match.logo1);
    const flag2Html = getTeamFlagHtml(match.team2, match.team2Id, match.logo2);

    const isBreak = Boolean(match.breakLabel) || 
      (match.breakClass && match.breakClass !== '') || 
      /break|stumps|lunch|tea|drinks|rain|delay|bad\s+light/i.test(match.breakLabel || '') || 
      /break|stumps|lunch|tea|drinks|rain|delay|bad\s+light/i.test(match.summary || '');

    const isActivelyPlaying = match.isLive && !isBreak && !match.isEnded && !match.isNotStarted;

    const hasWicketsDown = match.currentInningsWickets === null || match.currentInningsWickets > 0;
    const showLastWicket = isActivelyPlaying && hasWicketsDown;
    const showBowler = isActivelyPlaying && Boolean(match.currentBowler);
    const showBatting = isActivelyPlaying && Boolean(match.currentBatting && match.currentBatting.striker?.name);
    const showRecent = isActivelyPlaying && Array.isArray(match.recentBalls) && match.recentBalls.length > 0;

    const formattedBatting = showBatting ? formatBattingHtml(match.currentBatting) : '';
    const battingHtml = formattedBatting ? formattedBatting : '';

    const formattedBowler = showBowler ? formatBowlerHtml(match.currentBowler) : '';
    const bowlerHtml = formattedBowler
      ? `<div class="current-bowler-line"><span class="bowler-tag">Bowling:</span> ${formattedBowler}</div>`
      : '';

    const formattedRecent = showRecent ? formatRecentBallsHtml(match.recentBalls) : '';
    const recentBallsHtml = formattedRecent
      ? `<div class="recent-balls-line"><span class="recent-tag">Overs:</span> <div class="recent-balls-track">${formattedRecent}</div></div>`
      : '';

    const formattedWicket = showLastWicket ? formatDismissalHtml(match.lastWicket) : '';
    const lastWicketHtml = formattedWicket
      ? `<div class="last-wicket-line"><span class="lw-tag">Wicket:</span> ${formattedWicket}</div>`
      : '';

    const situationHtml = match.summary
      ? `<div class="match-situation-line">${escapeHtml(match.summary)}</div>`
      : '';

    const cleanLastWicket = showLastWicket && match.lastWicket ? match.lastWicket.replace(/&dagger;/g, '†').replace(/&amp;/g, '&') : '';
    const recentBallsText = showRecent && match.recentBalls ? match.recentBalls.map(b => b.val || b.text).join(' ') : '';
    const hoverTooltipDetail = [
      `${match.team1}${score1Text} v ${match.team2}${score2Text}`,
      match.breakLabel ? `[${match.breakLabel}]` : '',
      match.summary ? `Status: ${match.summary}` : '',
      showBatting && match.currentBatting ? `Batting: ${match.currentBatting.striker.name} ${match.currentBatting.striker.runs}* (${match.currentBatting.striker.balls}b)` : '',
      showBowler && match.currentBowler ? `Bowling: ${match.currentBowler}` : '',
      recentBallsText ? `Overs: ${recentBallsText}` : '',
      cleanLastWicket ? cleanLastWicket : ''
    ].filter(Boolean).join('\n');

    let batNum = match.battingTeamNum;
    let bowlNum = match.bowlingTeamNum;
    if (batNum === null || batNum === undefined) {
      if (/\(\s*\d+(?:\.\d+)?(?:\/\d+)?\s*ov/i.test(clean1)) {
        batNum = 1;
        bowlNum = 2;
      } else if (/\(\s*\d+(?:\.\d+)?(?:\/\d+)?\s*ov/i.test(clean2)) {
        batNum = 2;
        bowlNum = 1;
      }
    }

    let team1RoleHtml = '';
    let team2RoleHtml = '';
    if (isActivelyPlaying) {
      if (batNum === 1) team1RoleHtml = getBattingBatSvg(match.team1);
      else if (bowlNum === 1) team1RoleHtml = getBowlingBallSvg(match.team1);

      if (batNum === 2) team2RoleHtml = getBattingBatSvg(match.team2);
      else if (bowlNum === 2) team2RoleHtml = getBowlingBallSvg(match.team2);
    }

    let leftStatusHtml = '';
    if (match.breakLabel) {
      leftStatusHtml = `<span class="break-pill ${match.breakClass}">${escapeHtml(match.breakLabel)}</span>`;
    } else if (isActivelyPlaying) {
      leftStatusHtml = `<span class="live-in-play-badge"><span class="live-dot-mini"></span>IN PLAY</span>`;
    }

    const rightStatusHtml = '';

    const commBtnHtml = '';
    const commPopoverHtml = '';

    return {
      isPinned,
      score1Text,
      score2Text,
      score1Html,
      score2Html,
      flag1Html,
      flag2Html,
      team1RoleHtml,
      team2RoleHtml,
      leftStatusHtml,
      rightStatusHtml,
      battingHtml,
      bowlerHtml,
      recentBallsHtml,
      lastWicketHtml,
      situationHtml,
      commBtnHtml,
      commPopoverHtml,
      hoverTooltipDetail
    };
  }

  // 1. FAST IN-PLACE DOM UPDATE (Zero visual flicker on recurring 5s ticks)
  if (canUpdateCardsInPlace()) {
    STATE.liveMatches.forEach((match) => {
      const d = computeMatchCardData(match);
      const card = elements.liveScoresContent.querySelector(`.live-match-card[data-match-id="${match.id}"]`);
      if (!card) return;

      const leftEl = card.querySelector('.status-bar-left');
      const centerEl = card.querySelector('.status-bar-center');
      const rightEl = card.querySelector('.status-bar-right');
      if (leftEl && leftEl.innerHTML !== d.leftStatusHtml) leftEl.innerHTML = d.leftStatusHtml;
      if (centerEl && centerEl.innerHTML !== '') centerEl.innerHTML = '';
      if (rightEl && rightEl.innerHTML !== '') rightEl.innerHTML = '';

      const s1El = card.querySelector('.score-1');
      if (s1El) {
        if (s1El.textContent !== d.score1Text) {
          s1El.textContent = d.score1Text;
          s1El.classList.remove('score-flash');
          void s1El.offsetWidth;
          s1El.classList.add('score-flash');
        }
      }

      const s2El = card.querySelector('.score-2');
      if (s2El) {
        if (s2El.textContent !== d.score2Text) {
          s2El.textContent = d.score2Text;
          s2El.classList.remove('score-flash');
          void s2El.offsetWidth;
          s2El.classList.add('score-flash');
        }
      }

      const r1El = card.querySelector('.team-1-role');
      const r2El = card.querySelector('.team-2-role');
      if (r1El && r1El.innerHTML !== d.team1RoleHtml) r1El.innerHTML = d.team1RoleHtml;
      if (r2El && r2El.innerHTML !== d.team2RoleHtml) r2El.innerHTML = d.team2RoleHtml;

      const btEl = card.querySelector('.current-batting-container');
      if (btEl && btEl.innerHTML !== d.battingHtml) btEl.innerHTML = d.battingHtml;

      const bEl = card.querySelector('.current-bowler-container');
      if (bEl && bEl.innerHTML !== d.bowlerHtml) bEl.innerHTML = d.bowlerHtml;

      const rbEl = card.querySelector('.recent-balls-container');
      if (rbEl && rbEl.innerHTML !== d.recentBallsHtml) rbEl.innerHTML = d.recentBallsHtml;

      const lwEl = card.querySelector('.last-wicket-container');
      if (lwEl && lwEl.innerHTML !== d.lastWicketHtml) lwEl.innerHTML = d.lastWicketHtml;

      const sitEl = card.querySelector('.situation-container');
      if (sitEl && sitEl.innerHTML !== d.situationHtml) sitEl.innerHTML = d.situationHtml;

      const commEl = card.querySelector('.comm-container');
      if (commEl && commEl.innerHTML !== '') commEl.innerHTML = '';

      const titleLinkEl = card.querySelector('.match-title-link');
      if (titleLinkEl && match.matchUrl && titleLinkEl.getAttribute('href') !== match.matchUrl) {
        titleLinkEl.setAttribute('href', match.matchUrl);
      }

      card.setAttribute('title', d.hoverTooltipDetail);
      const chk = card.querySelector('.match-checkbox');
      if (chk) chk.checked = d.isPinned;
    });

    updateLiveTooltip();
    return;
  }

  // 2. FULL RENDER (First load or when match list structure changes)
  const matchesHtml = STATE.liveMatches.map((match) => {
    const d = computeMatchCardData(match);
    return `
      <div class="live-match-card" data-match-id="${escapeHtml(match.id)}" title="${escapeHtml(d.hoverTooltipDetail)}">
        <div class="card-status-bar">
          <div class="status-bar-left">${d.leftStatusHtml}</div>
          <div class="status-bar-right">${d.rightStatusHtml}</div>
        </div>
        <div class="match-main-line">
          <input type="checkbox" class="match-checkbox" data-id="${escapeHtml(match.id)}" ${d.isPinned ? 'checked' : ''} title="Pin match">
          <a href="${escapeHtml(match.matchUrl)}" target="_blank" rel="noopener noreferrer" class="match-title-link match-title-text" title="Click to view live scorecard on ESPNcricinfo">
            ${d.flag1Html}<span class="team-link">${escapeHtml(match.team1)}</span><span class="team-role team-1-role">${d.team1RoleHtml}</span><span class="score-num score-1">${d.score1Html}</span> v 
            ${d.flag2Html}<span class="team-link">${escapeHtml(match.team2)}</span><span class="team-role team-2-role">${d.team2RoleHtml}</span><span class="score-num score-2">${d.score2Html}</span>
          </a>
        </div>
        <div class="current-batting-container">${d.battingHtml}</div>
        <div class="current-bowler-container">${d.bowlerHtml}</div>
        <div class="recent-balls-container">${d.recentBallsHtml}</div>
        <div class="last-wicket-container">${d.lastWicketHtml}</div>
        <div class="situation-container">${d.situationHtml}</div>
      </div>
    `;
  }).join('');

  elements.liveScoresContent.innerHTML = matchesHtml;
  attachCommListeners(elements.liveScoresContent);
  if (STATE.isFirstMount) {
    elements.liveScoresContent.classList.add('first-mount');
    setTimeout(() => {
      elements.liveScoresContent.classList.remove('first-mount');
      STATE.isFirstMount = false;
    }, 400);
  }

  // Attach pin checkbox listeners for all rendered matches
  elements.liveScoresContent.querySelectorAll('.match-checkbox').forEach((chk) => {
    chk.addEventListener('change', async (e) => {
      const mId = chk.getAttribute('data-id');
      if (e.target.checked) {
        STATE.pinnedMatchId = mId;
        await setStored({ pinnedMatchId: mId });
      } else {
        if (STATE.pinnedMatchId === mId) {
          STATE.pinnedMatchId = null;
          await setStored({ pinnedMatchId: null });
        }
      }
      STATE.liveMatches = sortMatchesByLivePriority(STATE.liveMatches, STATE.pinnedMatchId);
      renderLiveMatchesHtml();
      updateLiveTooltip();
    });
  });

  attachCommListeners(elements.liveScoresContent);
  updateLiveTooltip();
}

// Attach click listeners for 1-Ball Commentary button popovers
function attachCommListeners(container) {
  if (!container) return;
  container.querySelectorAll('.btn-ball-comm').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
      const mId = btn.getAttribute('data-match-id');
      STATE.openCommMatchIds = STATE.openCommMatchIds || new Set();
      const card = btn.closest('.live-match-card');
      const popover = card ? card.querySelector('.comm-popover') : null;
      if (STATE.openCommMatchIds.has(mId)) {
        STATE.openCommMatchIds.delete(mId);
        btn.classList.remove('active');
        if (popover) popover.classList.remove('is-open');
      } else {
        STATE.openCommMatchIds.add(mId);
        btn.classList.add('active');
        if (popover) popover.classList.add('is-open');
      }
    };
  });
}

// Update Chrome action hover tooltip with live matches
function updateLiveTooltip() {
  const activeMatches = (STATE.liveMatches || []).filter(m => m.isLive && !m.isNotStarted);
  const targetList = activeMatches.length > 0 ? activeMatches : (STATE.liveMatches || []).slice(0, 5);

  if (targetList.length === 0) {
    const text = 'Classic Cricket Scores\nNo live matches in progress';
    if (typeof chrome !== 'undefined') {
      if (chrome.action?.setTitle) chrome.action.setTitle({ title: text });
      if (chrome.runtime?.sendMessage) chrome.runtime.sendMessage({ type: 'UPDATE_LIVE_TOOLTIP', tooltipText: text }, () => {});
    }
    return;
  }

  const lines = targetList.map((m) => {
    const isPinned = STATE.pinnedMatchId === m.id;
    const prefix = isPinned ? '📌 ' : '• ';
    const s1 = m.score1 ? ` ${cleanCricketScore(m.score1)}` : '';
    const s2 = m.score2 ? ` ${cleanCricketScore(m.score2)}` : '';
    let line = `${prefix}${m.team1}${s1} v ${m.team2}${s2}`;
    if (m.summary) line += ` (${m.summary})`;
    return line;
  });

  const tooltipText = `🏏 Classic Cricket (${targetList.length} Live):\n` + lines.join('\n');
  if (typeof chrome !== 'undefined') {
    if (chrome.action?.setTitle) chrome.action.setTitle({ title: tooltipText });
    if (chrome.runtime?.sendMessage) chrome.runtime.sendMessage({ type: 'UPDATE_LIVE_TOOLTIP', tooltipText }, () => {});
  }
}

// Format current active bowler string (e.g. "Liam Dawson 1/5 (3.2 ov), Jofra Archer 0/12 (3 ov)")
function formatBowlerHtml(bowlerStr) {
  if (!bowlerStr) return '';
  const parts = bowlerStr.split(',').map(s => s.trim()).filter(Boolean);
  return parts.map(part => {
    const m = part.match(/^(.*?)\s+(\d+\/\d+)(\s*\(.*?\))?$/);
    if (m) {
      const name = escapeHtml(m[1].trim());
      const fig = escapeHtml(m[2].trim());
      const ov = m[3] ? escapeHtml(m[3].trim()) : '';
      return `<span class="bowler-name">${name}</span> <span class="bowler-figures">${fig}${ov ? ` ${ov}` : ''}</span>`;
    }
    return escapeHtml(part);
  }).join(', ');
}

// Extract current active batting (facing batter first with *, partner second)
function extractCurrentBatting(items, currentPeriod = null) {
  if (!Array.isArray(items) || items.length === 0) return null;
  let valid = items.filter(it => it && it.over && typeof it.over.overs === 'number');
  if (valid.length === 0) return null;

  const activePeriod = currentPeriod || valid[valid.length - 1].period;
  if (activePeriod) valid = valid.filter(it => it.period == activePeriod);
  if (valid.length === 0) return null;

  const lastBall = valid[valid.length - 1];
  const b1 = lastBall.batsman;
  const b2 = lastBall.otherBatsman;
  if (!b1 && !b2) return null;

  let striker = b1 || b2;
  let nonStriker = b2 || null;

  if (lastBall.dismissal && lastBall.dismissal.dismissal) {
    const outId = lastBall.dismissal.batsman?.athlete?.id;
    if (outId && b2 && b1?.athlete?.id === outId) {
      striker = b2;
      nonStriker = null;
    } else if (outId && b1 && b2?.athlete?.id === outId) {
      striker = b1;
      nonStriker = null;
    } else {
      striker = b2 || b1;
      nonStriker = null;
    }
  } else {
    striker = b1 || b2;
    nonStriker = (b1 && b2 && b1.athlete?.id !== b2.athlete?.id) ? b2 : null;
  }

  const sName = striker?.athlete?.displayName || striker?.athlete?.name || striker?.athlete?.shortName || '';
  const sRuns = striker?.totalRuns !== undefined ? striker.totalRuns : 0;
  const sBalls = striker?.faced !== undefined ? striker.faced : 0;

  let partner = null;
  if (nonStriker && nonStriker.athlete) {
    const pName = nonStriker.athlete?.displayName || nonStriker.athlete?.name || nonStriker.athlete?.shortName || '';
    if (pName && pName !== sName) {
      const pRuns = nonStriker.totalRuns !== undefined ? nonStriker.totalRuns : 0;
      const pBalls = nonStriker.faced !== undefined ? nonStriker.faced : 0;
      partner = { name: pName, runs: pRuns, balls: pBalls };
    }
  }

  return { striker: { name: sName, runs: sRuns, balls: sBalls }, partner };
}

// Format current batting into HTML (facing batter bold with * and runs, partner following)
function formatBattingHtml(battingData) {
  if (!battingData || !battingData.striker || !battingData.striker.name) return '';
  const s = battingData.striker;
  const sHtml = `<span class="batter-name">${escapeHtml(s.name)}</span> <span class="batter-figures">${s.runs}* (${s.balls}b)</span>`;
  let partnerHtml = '';
  if (battingData.partner && battingData.partner.name) {
    const p = battingData.partner;
    partnerHtml = `<span class="partner-sep">,</span> <span class="partner-name">${escapeHtml(p.name)}</span> <span class="partner-figures">${p.runs} (${p.balls}b)</span>`;
  }
  return `<div class="current-batting-line"><span class="batting-tag">Batting:</span> ${sHtml}${partnerHtml}</div>`;
}

// Extract exactly the last 13 balls (sliding window: as a new ball arrives, the oldest hides)
function extractRecentBalls(items, maxBalls = 13, currentPeriod = null) {
  if (!Array.isArray(items) || items.length === 0) return [];

  let valid = items.filter(it => it && it.over && (typeof it.over.overs === 'number' || typeof it.over.number === 'number' || typeof it.over.ball === 'number'));
  if (valid.length === 0) return [];

  const activePeriod = currentPeriod || valid[valid.length - 1].period;
  if (activePeriod) {
    const periodValid = valid.filter(it => it.period == activePeriod);
    if (periodValid.length > 0) valid = periodValid;
  }
  if (valid.length === 0) return [];

  // Exactly 13 balls sliding window per user requirement
  const targetItems = valid.slice(-13);

  const balls = [];
  let lastSeenOver = null;

  for (let i = 0; i < targetItems.length; i++) {
    const it = targetItems[i];
    const ov = it.over?.number ?? (typeof it.over?.overs === 'number' ? Math.floor(it.over.overs + 0.0001) : null);
    if (lastSeenOver !== null && ov !== null && ov !== lastSeenOver) {
      balls.push({ type: 'sep', val: '|' });
    }
    if (ov !== null) lastSeenOver = ov;

    const isWicket = Boolean(it.dismissal && it.dismissal.dismissal);
    const isWide = Boolean(it.over?.wide && it.over.wide > 0);
    const isNoBall = Boolean(it.over?.noBall && it.over.noBall > 0);
    const scoreVal = it.scoreValue ?? 0;

    let text = String(scoreVal);
    let ballType = 'dot';

    if (isWicket) {
      text = scoreVal > 0 ? `${scoreVal}W` : 'W';
      ballType = 'wicket';
    } else if (isWide) {
      text = scoreVal > 1 ? `${scoreVal}wd` : 'wd';
      ballType = 'extra';
    } else if (isNoBall) {
      text = scoreVal > 1 ? `${scoreVal}nb` : 'nb';
      ballType = 'extra';
    } else if (scoreVal === 0) {
      text = '0';
      ballType = 'dot';
    } else if (scoreVal === 4) {
      text = '4';
      ballType = 'four';
    } else if (scoreVal === 6) {
      text = '6';
      ballType = 'six';
    } else {
      text = String(scoreVal);
      ballType = 'run';
    }

    const isLatest = (i === targetItems.length - 1);

    const ovStr = it.over?.overs !== undefined ? `${it.over.overs}` : (it.over?.ball !== undefined ? `Ball ${it.over.ball}` : '');
    const shortTxt = (it.shortText || '').trim();
    const fullTxt = (it.text || '').replace(/<[^>]+>/g, '').trim();
    let comm = '';
    if (isWicket && it.dismissal?.text) {
      const dTxt = it.dismissal.text.replace(/&dagger;/g, '†').replace(/&amp;/g, '&').trim();
      comm = `${ovStr ? `[${ovStr}] ` : ''}OUT! ${dTxt}${fullTxt ? ` - ${fullTxt}` : ''}`;
    } else if (shortTxt && fullTxt) {
      comm = `${ovStr ? `[${ovStr}] ` : ''}${shortTxt} - ${fullTxt}`;
    } else if (shortTxt) {
      comm = `${ovStr ? `[${ovStr}] ` : ''}${shortTxt}`;
    } else if (fullTxt) {
      comm = `${ovStr ? `[${ovStr}] ` : ''}${fullTxt}`;
    } else if (ovStr) {
      comm = `Over ${ovStr}`;
    }

    balls.push({
      type: 'ball',
      ballType,
      text,
      over: it.over?.overs ?? it.over?.ball,
      comm,
      isLatest // Only the single newest ball bowled is bold
    });
  }
  return balls;
}

// Extract real-time delivery event for top notification badge directly from playbyplay
function extractLatestBallEvent(items, currentPeriod = null) {
  if (!Array.isArray(items) || items.length === 0) return null;
  let valid = items.filter(it => it && it.over && typeof it.over.overs === 'number');
  if (valid.length === 0) return null;

  const activePeriod = currentPeriod || valid[valid.length - 1].period;
  if (activePeriod) valid = valid.filter(it => it.period == activePeriod);
  if (valid.length === 0) return null;

  const lastBall = valid[valid.length - 1];
  const isWicket = Boolean(lastBall.dismissal && lastBall.dismissal.dismissal);
  const isWide = Boolean(lastBall.over?.wide && lastBall.over?.wide > 0);
  const isNoBall = Boolean(lastBall.over?.noBall && lastBall.over?.noBall > 0);
  const val = lastBall.scoreValue ?? 0;

  let type = 'dot';
  let text = '⚪ 0 DOT';

  if (isWicket) {
    type = 'wicket';
    text = val > 0 ? `💥 OUT! +${val}` : '💥 OUT! WICKET';
  } else if (val === 6) {
    type = 'six';
    text = '🔥 6 SIX!';
  } else if (val === 4) {
    type = 'four';
    text = '🎯 4 FOUR';
  } else if (isWide) {
    type = 'extra';
    text = val > 1 ? `+${val} WIDES` : '1 WIDE';
  } else if (isNoBall) {
    type = 'extra';
    text = val > 1 ? `+${val} NO BALL` : 'NO BALL';
  } else if (val === 0) {
    type = 'dot';
    text = '⚪ 0 DOT';
  } else {
    type = 'runs';
    text = `+${val} RUN${val > 1 ? 'S' : ''}`;
  }

  const ballKey = `${lastBall.period}_${lastBall.over?.overs}_${lastBall.over?.ball}`;
  return { type, text, ts: Date.now(), ballKey };
}

// Extract last ball text commentary for tooltip / popover
function extractLastBallCommentary(items, currentPeriod = null) {
  if (!Array.isArray(items) || items.length === 0) return null;
  let valid = items.filter(it => it && it.over && typeof it.over.overs === 'number');
  if (valid.length === 0) return null;

  const activePeriod = currentPeriod || valid[valid.length - 1].period;
  if (activePeriod) valid = valid.filter(it => it.period == activePeriod);
  if (valid.length === 0) return null;

  const lastBall = valid[valid.length - 1];
  const ov = lastBall.over?.overs ?? '';
  const shortText = lastBall.shortText || '';
  const fullText = (lastBall.text || '').replace(/<[^>]+>/g, '').trim();

  if (!shortText && !fullText) return null;

  return {
    over: ov,
    shortText,
    fullText,
    combined: [
      ov ? `[${ov}]` : '',
      shortText,
      fullText ? `- ${fullText}` : ''
    ].filter(Boolean).join(' ')
  };
}

// Format recent balls array into HTML badge chips
function formatRecentBallsHtml(balls) {
  if (!Array.isArray(balls) || balls.length === 0) return '';
  return balls.map((b) => {
    if (b.type === 'sep') {
      return `<span class="ball-sep">|</span>`;
    }
    const ballType = escapeHtml(b.ballType || 'dot');
    const text = escapeHtml(b.text || '0');
    const comm = escapeHtml(b.comm || (b.over !== undefined ? `Over ${b.over}` : ''));
    const latestClass = b.isLatest ? ' ball-latest' : '';
    return `<span class="ball-chip ball-${ballType}${latestClass}" data-comm="${comm}" title="${comm}">${text}</span>`;
  }).join('');
}

// Format raw dismissal into rich highlighted HTML (Batsman bold, Fielder and Bowler highlighted)
function formatDismissalHtml(text) {
  if (!text) return '';
  // Strip "Last Wicket: " prefix if present
  let raw = text.replace(/^last\s*wicket:\s*/i, '').trim();
  raw = raw.replace(/&dagger;/g, '†').replace(/&amp;/g, '&');

  // 1. Caught and Bowled: "Batsman c & b Bowler Runs (Stats)"
  let cbMatch = raw.match(/^(.*?)\s+c\s+&\s+b\s+([A-Za-z\s.-]+?)\s+(\d+.*)$/i);
  if (cbMatch) {
    return `<span class="lw-batsman">${escapeHtml(cbMatch[1].trim())}</span> <span class="lw-how">c & b</span> <span class="lw-bowler">${escapeHtml(cbMatch[2].trim())}</span> <span class="lw-stats">${escapeHtml(cbMatch[3].trim())}</span>`;
  }

  // 2. Caught by Fielder, Bowled by Bowler: "Batsman c Fielder b Bowler Runs (Stats)"
  let cMatch = raw.match(/^(.*?)\s+c\s+([†\w\s.+/-]+?)\s+b\s+([A-Za-z\s.-]+?)\s+(\d+.*)$/i);
  if (cMatch) {
    return `<span class="lw-batsman">${escapeHtml(cMatch[1].trim())}</span> <span class="lw-how">c</span> <span class="lw-fielder">${escapeHtml(cMatch[2].trim())}</span> <span class="lw-how">b</span> <span class="lw-bowler">${escapeHtml(cMatch[3].trim())}</span> <span class="lw-stats">${escapeHtml(cMatch[4].trim())}</span>`;
  }

  // 3. Bowled by Bowler: "Batsman b Bowler Runs (Stats)"
  let bMatch = raw.match(/^(.*?)\s+b\s+([A-Za-z\s.-]+?)\s+(\d+.*)$/i);
  if (bMatch) {
    return `<span class="lw-batsman">${escapeHtml(bMatch[1].trim())}</span> <span class="lw-how">b</span> <span class="lw-bowler">${escapeHtml(bMatch[2].trim())}</span> <span class="lw-stats">${escapeHtml(bMatch[3].trim())}</span>`;
  }

  // 4. LBW: "Batsman lbw b Bowler Runs (Stats)"
  let lbwMatch = raw.match(/^(.*?)\s+lbw\s+b\s+([A-Za-z\s.-]+?)\s+(\d+.*)$/i);
  if (lbwMatch) {
    return `<span class="lw-batsman">${escapeHtml(lbwMatch[1].trim())}</span> <span class="lw-how">lbw b</span> <span class="lw-bowler">${escapeHtml(lbwMatch[2].trim())}</span> <span class="lw-stats">${escapeHtml(lbwMatch[3].trim())}</span>`;
  }

  // 5. Run Out: "Batsman run out (Fielder) Runs (Stats)"
  let roMatch = raw.match(/^(.*?)\s+run\s+out\s*(?:\(([^)]+)\))?\s*(\d+.*)?$/i);
  if (roMatch) {
    let fld = roMatch[2] ? `(<span class="lw-fielder">${escapeHtml(roMatch[2].trim())}</span>)` : '';
    let st = roMatch[3] ? `<span class="lw-stats">${escapeHtml(roMatch[3].trim())}</span>` : '';
    return `<span class="lw-batsman">${escapeHtml(roMatch[1].trim())}</span> <span class="lw-how">run out</span> ${fld} ${st}`.trim();
  }

  // 6. Stumped: "Batsman st Keeper b Bowler Runs (Stats)"
  let stMatch = raw.match(/^(.*?)\s+st\s+([†\w\s.+/-]+?)\s+b\s+([A-Za-z\s.-]+?)\s+(\d+.*)$/i);
  if (stMatch) {
    return `<span class="lw-batsman">${escapeHtml(stMatch[1].trim())}</span> <span class="lw-how">st</span> <span class="lw-fielder">${escapeHtml(stMatch[2].trim())}</span> <span class="lw-how">b</span> <span class="lw-bowler">${escapeHtml(stMatch[3].trim())}</span> <span class="lw-stats">${escapeHtml(stMatch[4].trim())}</span>`;
  }

  // Fallback: escaped raw string
  return escapeHtml(raw);
}

// Fetch exact last wicket dismissal from commentary for the active innings
async function fetchLastWicketDismissal(leagueId, eventId, currentPeriod = 1) {
  const lid = leagueId || '200';
  const periodParam = currentPeriod ? `&period=${currentPeriod}` : '';
  const ts = Date.now();

  // Strategy 1: Direct Fetch with cache-busting & limit 1500 (Instant in popup, < 100ms)
  try {
    const endpoints = [
      `https://site.api.espn.com/apis/site/v2/sports/cricket/${lid}/playbyplay?event=${eventId}${periodParam}&limit=1500&_=${ts}`,
      `https://site.api.espn.com/apis/site/v2/sports/cricket/200/playbyplay?event=${eventId}${periodParam}&limit=1500&_=${ts}`
    ];

    for (const url of endpoints) {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          const items = data?.commentary?.items;
          if (Array.isArray(items) && items.length > 0) {
            let currentBowler = '';
            let b1 = null;
            let b2 = null;
            for (let i = items.length - 1; i >= 0; i--) {
              const item = items[i];
              if (!item) continue;
              if (currentPeriod && item.period && item.period != currentPeriod) continue;
              const b = item.bowler;
              if (b && b.athlete) {
                const bId = b.athlete.id;
                const bName = b.athlete.displayName || b.athlete.shortName || b.athlete.name || '';
                if (bName) {
                  const wkts = b.wickets !== undefined ? b.wickets : 0;
                  const runs = b.conceded !== undefined ? b.conceded : 0;
                  const ovs = b.overs ? ` (${b.overs} ov)` : '';
                  const bStr = `${bName} ${wkts}/${runs}${ovs}`;
                  if (!b1) {
                    b1 = { id: bId, name: bName, str: bStr };
                  } else if (!b2 && b1.id !== bId && b1.name !== bName) {
                    b2 = { id: bId, name: bName, str: bStr };
                    break;
                  }
                }
              }
            }
            if (b1 && b2) {
              currentBowler = `${b1.str}, ${b2.str}`;
            } else if (b1) {
              currentBowler = b1.str;
            }

            const currentBatting = extractCurrentBatting(items, currentPeriod);
            const recentBalls = extractRecentBalls(items, 16, currentPeriod);
            const latestBallEvent = extractLatestBallEvent(items, currentPeriod);
            const lastBallComm = extractLastBallCommentary(items, currentPeriod);

            const dismissals = items.filter(item => item?.dismissal && item.dismissal.dismissal === true && (!item.period || item.period == currentPeriod));
            let text = '';
            let dismissalCount = 0;
            if (dismissals.length > 0) {
              dismissals.sort((a, b) => (a.over?.unique ?? a.over?.overs ?? 0) - (b.over?.unique ?? b.over?.overs ?? 0));
              const lastD = dismissals[dismissals.length - 1].dismissal;
              const raw = lastD.text || '';
              if (raw) {
                const clean = raw.replace(/&dagger;/g, '†').replace(/&amp;/g, '&').trim();
                text = `Last Wicket: ${clean}`;
              } else {
                const bName = lastD.batsman?.athlete?.displayName || 'Batsman';
                const type = lastD.type || 'out';
                const bowler = lastD.bowler?.athlete?.shortName || '';
                text = `Last Wicket: ${bName} ${type}${bowler ? ` b ${bowler}` : ''}`;
              }
              dismissalCount = dismissals.length;
            }
            return { text, dismissalCount, bowler: currentBowler, batting: currentBatting, recentBalls, ballEvent: latestBallEvent, commentary: lastBallComm };
          }
        }
      } catch (e) {}
    }
  } catch (err) {
    console.warn('Direct last wicket fetch failed:', err);
  }

  // Strategy 2: Service Worker Fallback
  if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    try {
      const resp = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'FETCH_DISMISSAL', leagueId, eventId, period: currentPeriod }, (res) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(res);
        });
      });
      if (resp?.success && (resp.text || resp.bowler || resp.batting || resp.recentBalls || resp.ballEvent || resp.commentary)) {
        return { text: resp.text || '', dismissalCount: resp.count || 1, bowler: resp.bowler || '', batting: resp.batting || null, recentBalls: resp.recentBalls || null, ballEvent: resp.ballEvent || null, commentary: resp.commentary || null };
      }
    } catch (e) {}
  }

  return null;
}

// ----------------------------------------------------
// TIMEZONE & REGION UTILITIES
// ----------------------------------------------------
function resolveUserTimeZone() {
  const tz = STATE.timeZone || 'Asia/Karachi';
  if (tz === 'auto') {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Karachi';
    } catch {
      return 'Asia/Karachi';
    }
  }
  return tz;
}

function getTimeZoneMeta() {
  const tz = STATE.timeZone || 'Asia/Karachi';
  const resolved = resolveUserTimeZone();
  const metaMap = {
    'Asia/Karachi': { code: 'PKT', flag: '🇵🇰', name: 'Pakistan Time' },
    'Asia/Kolkata': { code: 'IST', flag: '🇮🇳', name: 'India / SL Time' },
    'Asia/Dhaka': { code: 'BST', flag: '🇧🇩', name: 'Bangladesh Time' },
    'Asia/Dubai': { code: 'GST', flag: '🇦🇪', name: 'Gulf Standard Time' },
    'Europe/London': { code: 'UK', flag: '🇬🇧', name: 'UK Time' },
    'Australia/Sydney': { code: 'AEST', flag: '🇦🇺', name: 'Australian Eastern' },
    'Australia/Perth': { code: 'AWST', flag: '🇦🇺', name: 'Australian Western' },
    'Pacific/Auckland': { code: 'NZST', flag: '🇳🇿', name: 'New Zealand Time' },
    'Africa/Johannesburg': { code: 'SAST', flag: '🇿🇦', name: 'South Africa Time' },
    'America/Port_of_Spain': { code: 'AST', flag: '🌴', name: 'Caribbean Time' },
    'America/New_York': { code: 'EST', flag: '🇺🇸', name: 'US Eastern Time' },
    'America/Los_Angeles': { code: 'PST', flag: '🇺🇸', name: 'US Pacific Time' },
    'UTC': { code: 'UTC', flag: '🌐', name: 'UTC' }
  };

  if (metaMap[tz]) return metaMap[tz];

  let code = 'Local';
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: resolved, timeZoneName: 'short' }).formatToParts(new Date());
    code = parts.find(p => p.type === 'timeZoneName')?.value || 'Local';
  } catch {}
  return { code, flag: '🕒', name: resolved };
}

function getYmdInTimeZone(d, timeZone) {
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    return formatter.format(d).replace(/-/g, '');
  } catch {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  }
}

// ----------------------------------------------------
// SECTION 1.5: UPCOMING MATCHES (Schedule & Fixtures)
// ----------------------------------------------------
async function loadUpcomingMatches() {
  try {
    const targetTz = resolveUserTimeZone();
    const now = new Date();
    const tomDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const day2Date = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    const day3Date = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);

    const todayYmd = getYmdInTimeZone(now, targetTz);
    const tomYmd = getYmdInTimeZone(tomDate, targetTz);
    const day2Ymd = getYmdInTimeZone(day2Date, targetTz);
    const day3Ymd = getYmdInTimeZone(day3Date, targetTz);

    // Fetch today's upcoming matches + upcoming international schedule for next 3 days
    const [todayData, tomData, day2Data, day3Data] = await Promise.all([
      fetchScoresData(''),
      fetchScoresData(tomYmd),
      fetchScoresData(day2Ymd),
      fetchScoresData(day3Ymd)
    ]);

    const seenIds = new Set();
    const upcomingList = [];

    const processLeagues = (data) => {
      const leagues = data?.sports?.[0]?.leagues || [];
      for (const league of leagues) {
        const leagueName = league.name || '';
        for (const event of (league.events || [])) {
          const eventId = String(event.id);
          if (seenIds.has(eventId)) continue;

          // Scope check: strictly exclude regional/domestic/youth/women matches when in international scope
          if (STATE.filterScope === 'intl' && !isInternationalMatch(event, league)) {
            continue;
          }

          const eventName = event.name || '';
          // Filter out filler / undecided placeholder fixtures
          if (/tbc\s+v\s+tbc/i.test(eventName) || /tbd\s+v\s+tbd/i.test(eventName)) continue;

          const comp = (event.competitions && event.competitions[0]) || event;
          const competitors = comp.competitors || event.competitors || [];
          const [team1, team2] = getOrderedTeams(competitors, event, comp);
          const t1Name = team1.displayName || team1.name || team1.shortName || (eventName.split(' v ')[0] || 'Team 1');
          const t2Name = team2.displayName || team2.name || team2.shortName || (eventName.split(' v ')[1] || 'Team 2');

          const rawState = comp.status?.type?.state || event.status || '';
          const period = event.fullStatus?.period || comp.fullStatus?.period || event.period || comp.period || 0;
          const isEnded = rawState === 'post' || comp.status?.type?.state === 'post' || event.fullStatus?.type?.state === 'post';

          const s1 = (team1.score || '').trim();
          const s2 = (team2.score || '').trim();
          const summary = (comp.fullStatus?.summary || comp.status?.type?.detail || event.summary || '').trim();

          // Match is upcoming if not ended and either pre-match or hasn't started yet
          const isUpcoming = (rawState === 'pre' || (!s1 && !s2 && period === 0 && !isEnded) || /^starts\s+at/i.test(summary)) && !isEnded;

          if (!isUpcoming) continue;

          seenIds.add(eventId);

          const t1Logo = team1.logo || (VALID_ESPN_FLAG_IDS.has(String(team1.id)) ? `https://a.espncdn.com/i/teamlogos/cricket/500/${team1.id}.png` : '');
          const t2Logo = team2.logo || (VALID_ESPN_FLAG_IDS.has(String(team2.id)) ? `https://a.espncdn.com/i/teamlogos/cricket/500/${team2.id}.png` : '');

          const rawUrl = event.link || `https://www.espncricinfo.com/series/match/${eventId}`;
          const matchUrl = toCricinfoUrl(rawUrl);

          const timeInfo = formatUpcomingMatchTime(event.date, summary, comp.venue, todayYmd, tomYmd, targetTz);
          const format = getMatchFormat(leagueName, eventName);
          const rank = getUpcomingMatchRank(leagueName, eventName);

          upcomingList.push({
            id: eventId,
            leagueName,
            team1: t1Name,
            team2: t2Name,
            team1Id: team1.id ? String(team1.id) : '',
            team2Id: team2.id ? String(team2.id) : '',
            logo1: t1Logo,
            logo2: t2Logo,
            format,
            rank,
            matchUrl,
            summary,
            venue: comp.venue || null,
            rawDate: event.date,
            startTimeMs: new Date(event.date).getTime() || 0,
            ...timeInfo
          });
        }
      }
    };

    if (todayData) processLeagues(todayData);
    if (tomData) processLeagues(tomData);
    if (day2Data) processLeagues(day2Data);
    if (day3Data) processLeagues(day3Data);

    // SORT: Pakistan matches Rank 1 at VERY TOP > Major International (Rank 2) > Associates (Rank 3) > Time
    upcomingList.sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return a.startTimeMs - b.startTimeMs;
    });

    STATE.upcomingMatches = upcomingList;

    // Persist to cache
    await setStored({ cachedUpcomingMatches: STATE.upcomingMatches });

    // Render if currently on upcoming tab
    if (STATE.activeTab === 'upcoming') {
      renderUpcomingMatchesHtml();
    }
  } catch (err) {
    console.warn('Error loading upcoming matches:', err);
  }
}

// Detect match format (ODI, TEST, T20, SIXES)
function getMatchFormat(leagueName = '', eventName = '') {
  const combined = `${leagueName} ${eventName}`.toLowerCase();
  if (/\bodi\b|\btri-series\b|\b50-over\b/i.test(combined)) return { label: 'ODI', className: 'format-odi' };
  if (/\btest\b|\b4-day\b|\b5-day\b/i.test(combined)) return { label: 'TEST', className: 'format-test' };
  if (/\bsixes\b/i.test(combined)) return { label: 'SIXES', className: 'format-sixes' };
  if (/\bt20i?\b|\btwenty20\b/i.test(combined)) return { label: 'T20', className: 'format-t20' };
  return null;
}

// Rank upcoming matches: Pakistan #1, Major International #2, ICC Associates #3, Other #4
function getUpcomingMatchRank(leagueName = '', eventName = '') {
  const combined = `${leagueName} ${eventName}`.toLowerCase();
  // 1. Pakistan matches -> HIGHEST TOP PRIORITY
  if (/\bpakistan\b/i.test(combined)) return 1;
  // 2. Major test / ODI / T20 international nations
  if (/\b(india|australia|england|south africa|new zealand|west indies|sri lanka|bangladesh|afghanistan)\b/i.test(combined)) return 2;
  // 3. Other ICC international nations
  if (/\b(ireland|zimbabwe|netherlands|scotland|namibia|united arab emirates|uae|nepal|oman|usa|canada)\b/i.test(combined)) return 3;
  // 4. Other
  return 4;
}

function formatUpcomingMatchTime(dateStr, summary = '', venue = null, todayYmd = '', tomYmd = '', targetTz = null) {
  let userTime = '';
  let dayBadge = 'UPCOMING';
  let badgeClass = 'badge-upcoming';
  let groundTime = '';

  const tz = targetTz || resolveUserTimeZone();
  const d = new Date(dateStr);
  if (!isNaN(d.getTime())) {
    try {
      const userFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      });
      userTime = userFormatter.format(d);

      const matchYmd = getYmdInTimeZone(d, tz);

      if (matchYmd === todayYmd) {
        dayBadge = 'TODAY';
        badgeClass = 'badge-today';
      } else if (matchYmd === tomYmd) {
        dayBadge = 'TOMORROW';
        badgeClass = 'badge-tomorrow';
      } else {
        const shortDateFmt = new Intl.DateTimeFormat('en-US', {
          timeZone: tz,
          weekday: 'short',
          month: 'short',
          day: 'numeric'
        });
        dayBadge = shortDateFmt.format(d).toUpperCase();
        badgeClass = 'badge-upcoming';
      }
    } catch (e) {
      userTime = '';
    }
  }

  // 2. Ground / Local Time (Extracted from summary e.g. "Starts at 13:00 local time")
  const m = summary.match(/starts\s+at\s+([0-9:]+(?:\s*(?:am|pm))?(?:\s*local(?:\s*time)?)?)/i);
  if (m) {
    groundTime = m[1].replace(/time$/i, '').trim();
    if (!/local/i.test(groundTime)) {
      groundTime += ' local';
    }
  } else if (/local\s*time/i.test(summary)) {
    groundTime = summary.replace(/^starts\s+at\s*/i, '').trim();
  } else if (venue?.address?.city) {
    groundTime = venue.address.city;
  }

  return {
    userTime,
    pktTime: userTime,
    groundTime,
    dayBadge,
    badgeClass
  };
}

function renderUpcomingMatchesHtml() {
  if (!elements.upcomingScoresContent) return;

  if (!STATE.upcomingMatches || STATE.upcomingMatches.length === 0) {
    elements.upcomingScoresContent.innerHTML = `
      <div class="empty-box-state">No upcoming international matches scheduled right now.</div>
    `;
    return;
  }

  const targetTz = resolveUserTimeZone();
  const tzMeta = getTimeZoneMeta();
  const now = new Date();
  const tomDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const todayYmd = getYmdInTimeZone(now, targetTz);
  const tomYmd = getYmdInTimeZone(tomDate, targetTz);

  const matchesHtml = STATE.upcomingMatches.map((m) => {
    // If rawDate is available, re-format with the current active timezone
    const timeInfo = m.rawDate 
      ? formatUpcomingMatchTime(m.rawDate, m.summary || '', m.venue || null, todayYmd, tomYmd, targetTz)
      : { userTime: m.userTime || m.pktTime, groundTime: m.groundTime, dayBadge: m.dayBadge, badgeClass: m.badgeClass };

    const flag1Html = getTeamFlagHtml(m.team1, m.team1Id, m.logo1);
    const flag2Html = getTeamFlagHtml(m.team2, m.team2Id, m.logo2);

    const formatPillHtml = m.format
      ? `<span class="format-pill ${m.format.className}">${escapeHtml(m.format.label)}</span>`
      : '';

    const timeDisplay = timeInfo.userTime
      ? `<span class="time-pkt" title="${escapeHtml(tzMeta.name)} (${escapeHtml(tzMeta.code)})">${tzMeta.flag} ${escapeHtml(tzMeta.code)}: <b>${escapeHtml(timeInfo.userTime)}</b></span>`
      : '';
    const groundDisplay = timeInfo.groundTime
      ? `<span class="time-ground" title="Ground / Venue Local Time">🏟️ Ground: <b>${escapeHtml(timeInfo.groundTime)}</b></span>`
      : '';

    return `
      <div class="upcoming-match-card" data-match-id="${escapeHtml(m.id)}">
        <div class="upcoming-top-row">
          <span class="day-badge ${timeInfo.badgeClass}">${escapeHtml(timeInfo.dayBadge)}</span>
          ${formatPillHtml}
          <span class="upcoming-league-title" title="${escapeHtml(m.leagueName)}">${escapeHtml(m.leagueName)}</span>
        </div>
        <div class="match-main-line">
          <a href="${escapeHtml(m.matchUrl)}" target="_blank" rel="noopener noreferrer" class="match-title-link match-title-text" title="Click to view match fixtures on ESPNcricinfo">
            ${flag1Html}<span class="team-link">${escapeHtml(m.team1)}</span> v 
            ${flag2Html}<span class="team-link">${escapeHtml(m.team2)}</span>
          </a>
        </div>
        <div class="match-times-row">
          ${timeDisplay}
          ${groundDisplay}
        </div>
      </div>
    `;
  }).join('');

  elements.upcomingScoresContent.innerHTML = matchesHtml;
}

// ----------------------------------------------------
// SECTION 2: LATEST NEWS (Optimized: 5 Headlines, Fast Render)
// ----------------------------------------------------
async function loadLatestNews() {
  const articles = await fetchNewsArticles();

  if (articles && articles.length > 0) {
    const items = articles.map((a) => {
      return {
        id: a.id ? String(a.id) : '',
        title: a.headline || '',
        link: toCricinfoUrl(a.links?.web?.href),
        description: a.description || ''
      };
    });

    // Display 5 top headlines (faster load and clean interface)
    STATE.newsItems = items.slice(0, 5);

    // Save to cache
    await setStored({ cachedNewsItems: STATE.newsItems });

    // User has viewed the news: clear unread notification badge
    const articleIds = articles.map(a => String(a.id || a.headline));
    if (typeof chrome !== 'undefined') {
      if (chrome.action?.setBadgeText) {
        chrome.action.setBadgeText({ text: '' }).catch(() => {});
      }
      if (chrome.storage?.local) {
        chrome.storage.local.set({ readNewsIds: articleIds }).catch(() => {});
      }
      if (chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ type: 'CLEAR_NEWS_BADGE', articleIds }, () => {});
      }
    }
  } else if (typeof CLASSIC_FALLBACK_DATA !== 'undefined') {
    if (!STATE.newsItems || STATE.newsItems.length === 0) {
      STATE.newsItems = CLASSIC_FALLBACK_DATA.news.slice(0, 5);
    }
  }

  renderLatestNews();
}

function renderLatestNews() {
  if (!STATE.newsItems || STATE.newsItems.length === 0) {
    elements.latestNewsContent.innerHTML = `<div class="empty-box-state">No news stories available.</div>`;
    return;
  }

  elements.latestNewsContent.innerHTML = STATE.newsItems.map((item, idx) => `
    <div class="news-item">
      <div class="news-header-row">
        <span class="news-expand-box" data-index="${idx}" title="Click to view details">[+]</span>
        <a href="${escapeHtml(item.link)}" target="_blank" rel="noopener noreferrer" class="news-headline-link">${escapeHtml(item.title)}</a>
      </div>
      <div class="news-desc-box" id="news-desc-${idx}" style="display:none;">${escapeHtml(item.description)}</div>
    </div>
  `).join('');

  // Expand / Collapse click listeners
  elements.latestNewsContent.querySelectorAll('.news-expand-box').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = btn.getAttribute('data-index');
      const descEl = document.getElementById(`news-desc-${idx}`);
      if (!descEl) return;

      if (descEl.style.display === 'none') {
        descEl.style.display = 'block';
        descEl.classList.remove('news-desc-animate');
        void descEl.offsetWidth;
        descEl.classList.add('news-desc-animate');
        btn.textContent = '[-]';
      } else {
        descEl.style.display = 'none';
        btn.textContent = '[+]';
      }
    });
  });
}

function startRefreshTimer() {
  if (STATE.refreshTimer) clearInterval(STATE.refreshTimer);
  const sec = (STATE.autoRefreshSeconds !== undefined && STATE.autoRefreshSeconds > 0) ? STATE.autoRefreshSeconds : 5;
  if (STATE.autoRefreshSeconds <= 0) {
    updateRealtimeStatusIndicator();
    return;
  }

  updateRealtimeStatusIndicator();

  STATE.refreshTimer = setInterval(async () => {
    if (STATE.activeTab === 'live') {
      await loadLiveScores();
    }
  }, sec * 1000);
}

// ----------------------------------------------------
// MULTI-TIER DATA FETCH HELPERS
// ----------------------------------------------------
async function fetchScoresData(dateStr = '') {
  const ts = Date.now();
  const dateParam = dateStr ? `&dates=${dateStr}` : '';
  const endpoints = [
    `https://site.api.espn.com/apis/personalized/v2/scoreboard/header?sport=cricket${dateParam}&lang=en&region=pk&_=${ts}`,
    `https://site.web.api.espn.com/apis/personalized/v2/scoreboard/header?sport=cricket${dateParam}&lang=en&region=pk&_=${ts}`,
    `https://site.api.espn.com/apis/personalized/v2/scoreboard/header?sport=cricket${dateParam}&_=${ts}`
  ];

  // Strategy 1: Instant Direct Fetch with cache-busting (Fastest: < 200ms)
  for (const url of endpoints) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (res.ok) {
        const json = await res.json();
        if (json?.sports?.[0]?.leagues) return json;
      }
    } catch (err) {}
  }

  // Strategy 2: Background Service Worker Fallback
  if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    try {
      const resp = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'FETCH_SCORES', dateStr }, (res) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(res);
        });
      });
      if (resp?.success && resp.data) {
        return resp.data;
      }
    } catch (e) {}
  }

  // Strategy 3: CORS Proxy Fallback
  try {
    const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(`https://site.api.espn.com/apis/personalized/v2/scoreboard/header?sport=cricket${dateParam}&_=${ts}`)}`;
    const res = await fetch(proxyUrl, { cache: 'no-store' });
    if (res.ok) {
      const json = await res.json();
      if (json?.sports?.[0]?.leagues) return json;
    }
  } catch (err) {}

  return null;
}

async function fetchNewsArticles() {
  // Strategy 1: Extension Background Service Worker
  if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    try {
      const resp = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'FETCH_NEWS' }, (res) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(res);
        });
      });
      if (resp?.success && Array.isArray(resp.articles) && resp.articles.length > 0) {
        return resp.articles;
      }
    } catch (e) {}
  }

  // Strategy 2: Direct ESPNcricinfo API
  const endpoints = [
    'https://site.web.api.espn.com/apis/site/v2/sports/cricket/8048/news?region=pk&lang=en',
    'https://site.api.espn.com/apis/site/v2/sports/cricket/8048/news?region=pk&lang=en',
    'https://site.api.espn.com/apis/site/v2/sports/cricket/8048/news',
    'https://api.allorigins.win/raw?url=https%3A%2F%2Fsite.api.espn.com%2Fapis%2Fsite%2Fv2%2Fsports%2Fcricket%2F8048%2Fnews'
  ];
  for (const url of endpoints) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (res.ok) {
        const json = await res.json();
        if (Array.isArray(json?.articles) && json.articles.length > 0) {
          return json.articles;
        }
      }
    } catch (err) {}
  }
  return null;
}

// Convert any ESPN domain link into authentic espncricinfo.com link
function toCricinfoUrl(url) {
  if (!url) return 'https://www.espncricinfo.com';
  return url
    .replace(/^https?:\/\/(?:www\.)?espn\.com\/cricket\//, 'https://www.espncricinfo.com/')
    .replace(/^https?:\/\/(?:www\.)?espn\.in\/cricket\//, 'https://www.espncricinfo.com/')
    .replace(/^https?:\/\/site\.api\.espn\.com\/.*[?&]event=([0-9]+)/, 'https://www.espncricinfo.com/series/match/$1');
}

function getStored(keys) {
  return new Promise(resolve => {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.get(keys, resolve);
    } else {
      resolve({});
    }
  });
}

function setStored(obj) {
  return new Promise(resolve => {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.set(obj, resolve);
    } else {
      resolve();
    }
  });
}

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
