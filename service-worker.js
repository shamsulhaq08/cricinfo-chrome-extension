// service-worker.js - ESPN Cricinfo Classic Widget
const SCOREBOARD_ENDPOINTS = [
  'https://site.api.espn.com/apis/personalized/v2/scoreboard/header?sport=cricket&lang=en&region=pk',
  'https://site.web.api.espn.com/apis/personalized/v2/scoreboard/header?sport=cricket&lang=en&region=pk',
  'https://site.api.espn.com/apis/personalized/v2/scoreboard/header?sport=cricket',
  'https://api.allorigins.win/raw?url=https%3A%2F%2Fsite.api.espn.com%2Fapis%2Fpersonalized%2Fv2%2Fscoreboard%2Fheader%3Fsport%3Dcricket'
];

const NEWS_ENDPOINTS = [
  'https://site.web.api.espn.com/apis/site/v2/sports/cricket/8048/news?region=pk&lang=en',
  'https://site.api.espn.com/apis/site/v2/sports/cricket/8048/news?region=pk&lang=en',
  'https://site.api.espn.com/apis/site/v2/sports/cricket/8048/news',
  'https://api.allorigins.win/raw?url=https%3A%2F%2Fsite.api.espn.com%2Fapis%2Fsite%2Fv2%2Fsports%2Fcricket%2F8048%2Fnews'
];

const ALARM_NAME = 'cricinfo-classic-refresh';

// ----------------------------------------------------
// 1. DATA FETCHING
// ----------------------------------------------------

async function fetchScoreboardData(dateStr = '') {
  const ts = Date.now();
  const dateParam = dateStr ? `&dates=${dateStr}` : '';
  for (const baseUrl of SCOREBOARD_ENDPOINTS) {
    let url;
    if (baseUrl.includes('allorigins')) {
      url = `${baseUrl}${encodeURIComponent(dateParam)}&_=${ts}`;
    } else {
      const sep = baseUrl.includes('?') ? '&' : '?';
      url = `${baseUrl}${sep}${dateParam ? dateParam.replace(/^&/, '') + '&' : ''}_=${ts}`;
    }
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (res.ok) {
        const json = await res.json();
        if (json?.sports?.[0]?.leagues) {
          return json;
        }
      }
    } catch (e) {
      console.warn(`Scoreboard fetch failed for ${url}:`, e);
    }
  }
  return null;
}

async function fetchNewsData() {
  for (const url of NEWS_ENDPOINTS) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (res.ok) {
        const json = await res.json();
        if (Array.isArray(json?.articles) && json.articles.length > 0) {
          return json.articles;
        }
      }
    } catch (e) {
      console.warn(`News fetch failed for ${url}:`, e);
    }
  }
  return null;
}

async function fetchDismissalText(leagueId, eventId, currentPeriod = 1) {
  const lid = leagueId || '200';
  const periodParam = currentPeriod ? `&period=${currentPeriod}` : '';
  const ts = Date.now();
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
          let count = 0;
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
            count = dismissals.length;
          }
          return { text, count, bowler: currentBowler, batting: currentBatting, recentBalls, ballEvent: latestBallEvent, commentary: lastBallComm };
        }
      }
    } catch (err) {
      console.warn(`Dismissal fetch failed for event ${eventId}:`, err);
    }
  }
  return { text: '', count: 0, bowler: '', batting: null, recentBalls: null, ballEvent: null, commentary: null };
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

function cleanCricketScore(scoreStr) {
  if (!scoreStr) return '';
  let s = String(scoreStr);
  s = s.replace(/&amp;/gi, '&').replace(/&dagger;/gi, '†').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
  s = s.replace(/\s*&\s*/g, ' & ');
  s = s.replace(/\s*\(\s*/g, ' (');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// ----------------------------------------------------
// 2. BACKGROUND NEWS CACHE WARMING
// (No badge numbers on icon: icon stays clean, real-time data on click)
// ----------------------------------------------------

async function warmNewsCache() {
  try {
    const articles = await fetchNewsData();
    if (!articles || articles.length === 0) return;

    const newsForCache = articles.slice(0, 5).map(a => ({
      id: a.id ? String(a.id) : '',
      title: a.headline || '',
      link: a.links?.web?.href || 'https://www.espncricinfo.com',
      description: a.description || ''
    }));
    const allIds = articles.map(a => String(a.id || a.headline));
    await chrome.storage.local.set({ cachedNewsItems: newsForCache, readNewsIds: allIds });

    // Ensure icon badge is completely clear
    await chrome.action.setBadgeText({ text: '' });
  } catch (err) {
    console.warn('Failed to warm news cache:', err);
  }
}

// Check if an ended match completed more than 1 hour ago
function checkIsEndedMoreThan1Hour(event, endedMap) {
  try {
    const eventId = String(event.id);
    const ONE_HOUR_MS = 60 * 60 * 1000;
    const now = Date.now();

    if (endedMap && endedMap[eventId]) {
      return (now - endedMap[eventId]) > ONE_HOUR_MS;
    }

    const startTime = new Date(event.date).getTime();
    if (isNaN(startTime)) {
      if (endedMap) endedMap[eventId] = now;
      return false;
    }

    const notesText = Array.isArray(event.notes) ? event.notes.map(n => n?.text || '').join(' ') : '';
    const combined = `${event.name || ''} ${notesText}`.toLowerCase();

    let durationMs = 3.5 * 60 * 60 * 1000;
    if (/6-over|sixes/i.test(combined)) {
      durationMs = 45 * 60 * 1000;
    } else if (/50-over|odi/i.test(combined)) {
      durationMs = 7.5 * 60 * 60 * 1000;
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

// ----------------------------------------------------
// 2.5 INTERNATIONAL MATCH VALIDATION (EXCLUDE ALL DOMESTIC/CLUB/YOUTH/WOMEN)
// ----------------------------------------------------

const VALID_ESPN_FLAG_IDS = new Set([
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '11', '12', '13', '14', '15',
  '17', '19', '20', '21', '22', '25', '26', '27', '28', '29', '30', '33', '37', '38', '39', '40', '218211'
]);

const NATIONAL_TEAMS_SET = new Set([
  'pakistan', 'india', 'australia', 'england', 'south africa', 'new zealand', 'west indies', 'sri lanka',
  'bangladesh', 'afghanistan', 'zimbabwe', 'ireland', 'scotland', 'netherlands', 'namibia',
  'united arab emirates', 'uae', 'nepal', 'oman', 'usa', 'united states', 'canada', 'papua new guinea',
  'png', 'uganda', 'jersey', 'bermuda', 'italy', 'kenya', 'hong kong', 'kuwait', 'bahrain', 'qatar',
  'saudi arabia', 'malaysia', 'singapore', 'fiji', 'tanzania', 'rwanda', 'botswana', 'nigeria',
  'ghana', 'vanuatu', 'bahamas', 'belize', 'argentina', 'brazil', 'chile', 'cayman islands',
  'falkland islands', 'costa rica'
]);

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
  const isT1Nat = t1.isNational === true || VALID_ESPN_FLAG_IDS.has(t1Id) || NATIONAL_TEAMS_SET.has(t1Name);
  const isT2Nat = t2.isNational === true || VALID_ESPN_FLAG_IDS.has(t2Id) || NATIONAL_TEAMS_SET.has(t2Name);

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

// ----------------------------------------------------
// 3. LIVE MATCHES ON MOUSE HOVER (CHROME ACTION TITLE TOOLTIP)
// (Mouse hover par live matches ke scores tooltip mein show hon)
// ----------------------------------------------------

async function updateLiveMatchesTooltip(scoreboardData = null) {
  try {
    const data = scoreboardData || await fetchScoreboardData();
    if (!data) return;

    const leagues = data?.sports?.[0]?.leagues || [];

    const stored = await chrome.storage.local.get(['pinnedMatchId', 'filterScope', 'endedMatchTimestamps']);
    const pinnedMatchId = stored.pinnedMatchId || null;
    const filterScope = stored.filterScope || 'intl';
    const endedMap = stored.endedMatchTimestamps || {};

    const liveList = [];

    for (const league of leagues) {
      const leagueName = league.name || '';
      for (const event of (league.events || [])) {
        // Exclude domestic matches when filterScope is intl
        if (filterScope === 'intl' && !isInternationalMatch(event, league)) continue;

        const comp = event.competitions?.[0] || event;
        const eventName = event.name || '';
        const competitors = comp.competitors || event.competitors || [];
        const [t1, t2] = getOrderedTeams(competitors, event, comp);

        const t1Name = t1.shortDisplayName || t1.displayName || t1.name || 'Team 1';
        const t2Name = t2.shortDisplayName || t2.displayName || t2.name || 'Team 2';

        const rawState = comp.status?.type?.state || event.status || '';
        const isLive = rawState === 'in';
        const isEnded = rawState === 'post' || comp.status?.type?.state === 'post' || event.fullStatus?.type?.state === 'post';
        const period = event.fullStatus?.period || event.period || 1;

        const s1 = cleanCricketScore(t1.score);
        const s2 = cleanCricketScore(t2.score);

        const summary = (comp.fullStatus?.summary || comp.status?.type?.detail || event.summary || '').trim();
        const isNotStarted = (!s1 && !s2) || /^starts\s+at/i.test(summary) || (period === 0 && !isEnded);

        if ((isLive || isEnded) && !isNotStarted) {
          // Skip results that ended more than 1 hour ago
          if (isEnded && checkIsEndedMoreThan1Hour(event, endedMap)) {
            continue;
          }

          liveList.push({
            id: String(event.id),
            team1: t1Name,
            team2: t2Name,
            score1: s1,
            score2: s2,
            summary: summary,
            isEnded
          });
        }
      }
    }

    if (liveList.length === 0) {
      await chrome.action.setTitle({
        title: 'Classic Cricket Scores\nNo live matches in progress'
      });
      return;
    }

    // If pinned match exists, place it at the top
    if (pinnedMatchId) {
      const pIdx = liveList.findIndex(m => m.id === pinnedMatchId);
      if (pIdx > 0) {
        const [pinned] = liveList.splice(pIdx, 1);
        liveList.unshift(pinned);
      }
    }

    const lines = liveList.map(m => {
      const isPinned = m.id === pinnedMatchId;
      const prefix = isPinned ? '📌 ' : '• ';
      const s1 = m.score1 ? ` ${cleanCricketScore(m.score1)}` : '';
      const s2 = m.score2 ? ` ${cleanCricketScore(m.score2)}` : '';
      let line = `${prefix}${m.team1}${s1} v ${m.team2}${s2}`;
      if (m.summary) line += ` (${m.summary})`;
      return line;
    });

    const titleText = `🏏 Classic Cricket (${liveList.length} Live):\n` + lines.join('\n');
    await chrome.action.setTitle({ title: titleText });
  } catch (err) {
    console.warn('Failed to update live tooltip:', err);
  }
}

// ----------------------------------------------------
// 4. BACKGROUND LIFECYCLE & ALARMS
// ----------------------------------------------------

// Ensure icon badge is immediately cleared whenever service worker boots
if (typeof chrome !== 'undefined' && chrome.action?.setBadgeText) {
  chrome.action.setBadgeText({ text: '' }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(['autoRefresh', 'filterScope']);
  if (existing.autoRefresh === undefined || existing.autoRefresh == 15 || existing.autoRefresh == 20) {
    await chrome.storage.local.set({ autoRefresh: 5 });
  }
  if (!existing.filterScope) {
    await chrome.storage.local.set({ filterScope: 'intl' });
  }

  // Ensure toolbar icon has NO badge number at all
  await chrome.action.setBadgeText({ text: '' });

  // Create 1-minute background refresh alarm
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });

  // Update live scores tooltip and warm news cache
  await updateLiveMatchesTooltip();
  await warmNewsCache();
});

chrome.runtime.onStartup.addListener(async () => {
  await chrome.action.setBadgeText({ text: '' });
  await updateLiveMatchesTooltip();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    await updateLiveMatchesTooltip();
    await warmNewsCache();
    await chrome.action.setBadgeText({ text: '' });
  }
});

// ----------------------------------------------------
// 5. MESSAGE LISTENER
// ----------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'FETCH_SCORES') {
    (async () => {
      const data = await fetchScoreboardData(message.dateStr || '');
      sendResponse({ success: Boolean(data), data });
    })();
    return true;
  }

  if (message.type === 'FETCH_NEWS') {
    (async () => {
      const articles = await fetchNewsData();
      sendResponse({ success: Boolean(articles && articles.length > 0), articles: articles || [] });
    })();
    return true;
  }

  if (message.type === 'FETCH_DISMISSAL') {
    (async () => {
      const result = await fetchDismissalText(message.leagueId, message.eventId, message.period);
      sendResponse({ success: true, text: result.text, count: result.count, bowler: result.bowler || '', batting: result.batting || null, recentBalls: result.recentBalls || null, ballEvent: result.ballEvent || null, commentary: result.commentary || null });
    })();
    return true;
  }

  if (message.type === 'FETCH_URL' && message.url) {
    (async () => {
      try {
        const res = await fetch(message.url, { cache: 'no-store' });
        if (res.ok) {
          const contentType = res.headers.get('content-type') || '';
          if (contentType.includes('json')) {
            const data = await res.json();
            sendResponse({ success: true, data });
          } else {
            const text = await res.text();
            sendResponse({ success: true, text });
          }
        } else {
          sendResponse({ success: false, status: res.status });
        }
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  // Clear any badge on icon
  if (message.type === 'CLEAR_NEWS_BADGE') {
    chrome.action.setBadgeText({ text: '' }).then(() => {
      sendResponse({ success: true });
    }).catch(() => {
      sendResponse({ success: true });
    });
    return true;
  }

  // Update hover tooltip text from popup
  if (message.type === 'UPDATE_LIVE_TOOLTIP' && message.tooltipText) {
    chrome.action.setTitle({ title: message.tooltipText }).then(() => {
      sendResponse({ success: true });
    }).catch(() => {
      sendResponse({ success: false });
    });
    return true;
  }
});
