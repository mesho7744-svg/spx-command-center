// api/market-data.js — Vercel Serverless Function
// SPX Command Center — MESH Trading System

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');

  try {
    const [spxData, vixData, optionsData, calendarData] = await Promise.allSettled([
      fetchSPX(),
      fetchVIX(),
      fetchOptionsData(),
      fetchCalendar(),
    ]);

    const spx = spxData.value || {};
    const vix = vixData.value || {};
    const options = optionsData.value || {};
    const calendar = calendarData.value || [];

    const price = spx.price || 6500;
    const vixVal = vix.value || 20;
    const ivRank = calculateIVRank(vixVal, vix.low52, vix.high52);
    const ivPct = vix.percentile || ivRank * 0.9;

    const gex = options.gex || calculateFallbackGEX(price);
    const maxPain = options.maxPain || Math.round(price / 25) * 25;
    const putCall = options.putCall || { ratio: 0.87 };

    const strategy = getStrategy(ivRank);
    const bias = getBias(price, gex, vixVal);
    const expectedMove = getExpectedMove(price, vixVal);
    const scenarios = getScenarios(price, gex, bias.direction, expectedMove);
    const liquidity = options.liquidity || {};
    const decision = getDecision(bias.direction, gex, price, ivRank);
    const judas = getJudas();

    res.status(200).json({
      spx: { price },
      vix: { value: vixVal, change: vix.change || 0, changePct: vix.changePct || 0, low52: vix.low52, high52: vix.high52 },
      gex: { ...gex, maxPain, regime: gex.netGex < 0 ? 'negative' : 'positive' },
      iv: { rank: ivRank, percentile: ivPct },
      putCall,
      strategy,
      bias,
      expectedMove,
      scenarios,
      calendar,
      liquidity,
      decision,
      judas,
      timestamp: new Date().toISOString(),
    });

  } catch (err) {
    console.error('API Error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ══════════════════════════════════════════════
//   DATA SOURCES
// ══════════════════════════════════════════════

async function fetchSPX() {
  try {
    const res = await fetch(
      'https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1m&range=1d',
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    const price = result?.meta?.regularMarketPrice;
    return { price };
  } catch {
    return { price: null };
  }
}

async function fetchVIX() {
  try {
    const res = await fetch(
      'https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=1y',
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    const closes = result?.indicators?.quote?.[0]?.close?.filter(Boolean) || [];
    const value = result?.meta?.regularMarketPrice;
    const prevClose = result?.meta?.previousClose || value;
    const change = value - prevClose;
    const changePct = (change / prevClose) * 100;
    const low52 = Math.min(...closes.slice(-252));
    const high52 = Math.max(...closes.slice(-252));
    const percentile = closes.filter(c => c < value).length / closes.length * 100;
    return { value, change, changePct, low52, high52, percentile };
  } catch {
    return { value: null };
  }
}

async function fetchOptionsData() {
  try {
    // Get SPX options chain from Yahoo Finance
    const spxRes = await fetch(
      'https://query1.finance.yahoo.com/v7/finance/options/%5ESPX',
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const data = await spxRes.json();
    const result = data?.optionChain?.result?.[0];
    if (!result) return {};

    const price = result.quote?.regularMarketPrice;
    const calls = result.options?.[0]?.calls || [];
    const puts = result.options?.[0]?.puts || [];

    // Calculate Max Pain
    const maxPain = calculateMaxPain(calls, puts);

    // Calculate GEX levels from OI
    const gex = calculateGEXFromOI(calls, puts, price);

    // Liquidity from historical data
    const liquidity = await fetchLiquidity();

    // Put/Call Ratio
    const totalCallOI = calls.reduce((s, c) => s + (c.openInterest || 0), 0);
    const totalPutOI = puts.reduce((s, p) => s + (p.openInterest || 0), 0);
    const ratio = totalCallOI > 0 ? totalPutOI / totalCallOI : 0.87;

    return { gex, maxPain, liquidity, putCall: { ratio: parseFloat(ratio.toFixed(2)) } };
  } catch {
    return {};
  }
}

async function fetchLiquidity() {
  try {
    const res = await fetch(
      'https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&range=5d',
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    const highs = result?.indicators?.quote?.[0]?.high || [];
    const lows = result?.indicators?.quote?.[0]?.low || [];
    const closes = result?.indicators?.quote?.[0]?.close || [];

    const pdh = highs[highs.length - 2];
    const pdl = lows[lows.length - 2];
    const weeklyHigh = Math.max(...highs.slice(-5));
    const weeklyLow = Math.min(...lows.slice(-5));

    return { pdh, pdl, weeklyHigh, weeklyLow };
  } catch {
    return {};
  }
}

async function fetchCalendar() {
  // Static economic calendar for current week
  const now = new Date();
  const weekEvents = [
    { date: '2026-04-07', name: 'FOMC Meeting Minutes', nameAr: 'محضر اجتماع الفيدرالي', impact: 'HIGH', est: '—', prev: '—' },
    { date: '2026-04-08', name: 'Initial Jobless Claims', nameAr: 'طلبات الإعانة', impact: 'MEDIUM', est: '222K', prev: '219K' },
    { date: '2026-04-10', name: 'Monthly Options Expiration', nameAr: 'انتهاء خيارات شهرية', impact: 'HIGH', est: '—', prev: '—' },
  ];
  return weekEvents.filter(e => new Date(e.date) >= now);
}

// ══════════════════════════════════════════════
//   CALCULATIONS
// ══════════════════════════════════════════════

function calculateMaxPain(calls, puts) {
  if (!calls.length || !puts.length) return null;

  const allStrikes = [...new Set([
    ...calls.map(c => c.strike),
    ...puts.map(p => p.strike)
  ])].sort((a, b) => a - b);

  let minLoss = Infinity;
  let maxPainStrike = allStrikes[Math.floor(allStrikes.length / 2)];

  for (const testStrike of allStrikes) {
    let totalLoss = 0;
    for (const call of calls) {
      if (call.strike < testStrike) {
        totalLoss += (testStrike - call.strike) * (call.openInterest || 0);
      }
    }
    for (const put of puts) {
      if (put.strike > testStrike) {
        totalLoss += (put.strike - testStrike) * (put.openInterest || 0);
      }
    }
    if (totalLoss < minLoss) {
      minLoss = totalLoss;
      maxPainStrike = testStrike;
    }
  }
  return maxPainStrike;
}

function calculateGEXFromOI(calls, puts, price) {
  // Find Call Wall (highest call OI above price)
  const callsAbove = calls.filter(c => c.strike > price).sort((a, b) => (b.openInterest || 0) - (a.openInterest || 0));
  const callWall = callsAbove[0]?.strike || Math.round(price * 1.02 / 25) * 25;

  // Find Put Wall (highest put OI below price)
  const putsBelow = puts.filter(p => p.strike < price).sort((a, b) => (b.openInterest || 0) - (a.openInterest || 0));
  const putWall = putsBelow[0]?.strike || Math.round(price * 0.98 / 25) * 25;

  // Zero Gamma (balance point between call/put OI)
  const zeroGamma = Math.round((callWall + putWall) / 2 / 5) * 5;

  // Gamma Flip (where net gamma transitions)
  const gammaFlip = Math.round((zeroGamma + price) / 2 / 5) * 5;

  // Net GEX signal
  const totalCallOI = callsAbove.slice(0, 5).reduce((s, c) => s + (c.openInterest || 0), 0);
  const totalPutOI = putsBelow.slice(0, 5).reduce((s, p) => s + (p.openInterest || 0), 0);
  const netGex = totalCallOI - totalPutOI;

  return { callWall, putWall, zeroGamma, gammaFlip, netGex };
}

function calculateFallbackGEX(price) {
  return {
    callWall: Math.round(price * 1.015 / 25) * 25,
    putWall: Math.round(price * 0.985 / 25) * 25,
    zeroGamma: Math.round(price / 25) * 25,
    gammaFlip: Math.round(price * 1.005 / 5) * 5,
    netGex: -1,
  };
}

function calculateIVRank(vix, low52 = 12, high52 = 35) {
  if (!vix) return 30;
  return Math.round(((vix - low52) / (high52 - low52)) * 100);
}

function getStrategy(ivRank) {
  if (ivRank < 20) return 'no_trade';
  if (ivRank < 40) return 'cs_narrow';
  if (ivRank < 60) return 'iron_condor';
  if (ivRank < 80) return 'ic_wide';
  return 'iron_fly';
}

function getBias(price, gex, vix) {
  const aboveZeroGamma = price > (gex.zeroGamma || price);
  const negativeGex = gex.netGex < 0;
  const highVix = vix > 25;

  let direction, strength, reason;

  if (aboveZeroGamma && !negativeGex) {
    direction = 'bullish';
    strength = 65;
    reason = 'Price above Zero-Gamma. Positive GEX regime favors stability and upward drift.';
  } else if (!aboveZeroGamma && negativeGex) {
    direction = 'bearish';
    strength = 68;
    reason = 'Price below Zero-Gamma. Negative GEX amplifies moves — bearish bias.';
  } else {
    direction = 'neutral';
    strength = 50 + (highVix ? -10 : 0);
    reason = `Price between Put Wall (${gex.putWall}) and Call Wall (${gex.callWall}). Balanced positioning with Max Pain magnet at ${gex.maxPain}.`;
  }

  return { direction, strength, reason };
}

function getExpectedMove(price, vix) {
  const dailyMove = price * (vix / 100) * Math.sqrt(1 / 365);
  const weeklyMove = price * (vix / 100) * Math.sqrt(5 / 365);

  const today = new Date();
  const friday = new Date(today);
  friday.setDate(today.getDate() + (5 - today.getDay() + 7) % 7 || 7);
  const expDate = friday.toISOString().split('T')[0];

  return {
    dailyUpper: Math.round(price + dailyMove),
    dailyLower: Math.round(price - dailyMove),
    weeklyUpper: Math.round(price + weeklyMove),
    weeklyLower: Math.round(price - weeklyMove),
    expDate,
  };
}

function getScenarios(price, gex, biasDir, em) {
  const callWall = gex.callWall || price * 1.015;
  const putWall = gex.putWall || price * 0.985;
  const maxPain = gex.maxPain || price;

  if (biasDir === 'bearish') {
    return [
      { type: 'bearish', icon: '↘', name: 'Bearish Continuation', nameAr: 'هبوط مستمر', prob: 55, target: putWall, stop: gex.zeroGamma || price * 1.005 },
      { type: 'neutral-s', icon: '→', name: 'Range-Bound', nameAr: 'تداول في نطاق', prob: 30, target: maxPain, stop: putWall * 0.995 },
      { type: 'bullish', icon: '↗', name: 'Bullish Reversal', nameAr: 'انعكاس صاعد', prob: 15, target: gex.zeroGamma || price * 1.01, stop: putWall },
    ];
  } else if (biasDir === 'bullish') {
    return [
      { type: 'bullish', icon: '↗', name: 'Bullish Breakout', nameAr: 'اختراق صعودي', prob: 50, target: callWall, stop: gex.zeroGamma || price * 0.995 },
      { type: 'neutral-s', icon: '→', name: 'Range-Bound', nameAr: 'تداول في نطاق', prob: 35, target: maxPain, stop: putWall },
      { type: 'bearish', icon: '↘', name: 'Bearish Flush', nameAr: 'هبوط نحو الدعم', prob: 15, target: putWall, stop: callWall },
    ];
  } else {
    return [
      { type: 'neutral-s', icon: '→', name: 'Range-Bound Consolidation', nameAr: 'تداول في نطاق محدد', prob: 55, target: maxPain, stop: putWall * 0.995 },
      { type: 'bullish', icon: '↗', name: 'Bullish Breakout', nameAr: 'اختراق صعودي', prob: 25, target: callWall, stop: gex.zeroGamma || price * 0.995 },
      { type: 'bearish', icon: '↘', name: 'Bearish Flush to Put Wall', nameAr: 'تصحيح هبوطي نحو جدار البيع', prob: 20, target: putWall, stop: price * 1.005 },
    ];
  }
}

function getDecision(bias, gex, price, ivRank) {
  if (ivRank < 20) {
    return { action: '⛔ لا تتداول اليوم', detail: 'IV منخفض جداً — Credit Spreads غير مجدية' };
  }

  const distToCall = gex.callWall - price;
  const distToPut = price - gex.putWall;

  if (bias === 'bearish' && distToCall < distToPut * 1.5) {
    return {
      action: '🔴 SELL CALL Credit Spread',
      detail: `الدخول عند ارتداد نحو ${Math.round(gex.zeroGamma || price * 1.005)} — الجدار عند ${gex.callWall}`,
    };
  } else if (bias === 'bullish' && distToPut < distToCall * 1.5) {
    return {
      action: '🟢 SELL PUT Credit Spread',
      detail: `الدخول عند ارتداد نحو ${Math.round(gex.zeroGamma || price * 0.995)} — الدعم عند ${gex.putWall}`,
    };
  } else {
    return {
      action: '⚖️ Iron Condor',
      detail: `بيع بين ${gex.putWall} و ${gex.callWall} — مغناطيس عند ${gex.maxPain}`,
    };
  }
}

function getJudas() {
  const now = new Date();
  const hour = now.getUTCHours() + 3; // Riyadh UTC+3
  const isLondonOpen = hour >= 9 && hour < 11;
  const isNYOpen = hour >= 16 && hour < 17;
  return { active: isLondonOpen || isNYOpen };
}
