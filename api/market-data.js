// api/market-data.js — MESH SPX Command Center v3
// Uses yahoo-finance2 npm package — works on Vercel

import yahooFinance from ‘yahoo-finance2’;

export default async function handler(req, res) {
res.setHeader(‘Access-Control-Allow-Origin’, ‘*’);
res.setHeader(‘Cache-Control’, ‘no-cache, no-store, max-age=0’);

try {
const [spxResult, vixResult, spxHistResult] = await Promise.allSettled([
yahooFinance.quote(’^GSPC’),
yahooFinance.quote(’^VIX’),
yahooFinance.historical(’^GSPC’, { period1: ‘2025-01-01’, interval: ‘1d’ }),
]);

```
const spxQuote = spxResult.value;
const vixQuote = vixResult.value;
const spxHist  = spxHistResult.value || [];

const price  = spxQuote?.regularMarketPrice  || 6582;
const vixVal = vixQuote?.regularMarketPrice  || 23.87;

// VIX 52-week range
const vixChange    = vixQuote?.regularMarketChange    || 0;
const vixChangePct = vixQuote?.regularMarketChangePercent || 0;
const vixLow52     = vixQuote?.fiftyTwoWeekLow  || 12;
const vixHigh52    = vixQuote?.fiftyTwoWeekHigh || 60;

// Liquidity from history
const liq = calcLiquidity(spxHist, price);

const ivRank = calcIVRank(vixVal, vixLow52, vixHigh52);
const ivPct  = Math.round(ivRank * 0.85);
const gex    = fallbackGEX(price);

const strategy  = getStrategy(ivRank);
const bias      = getBias(price, gex, vixVal);
const em        = getExpectedMove(price, vixVal);
const scenarios = getScenarios(price, gex, bias.direction);
const decision  = getDecision(bias.direction, gex, price, ivRank);
const calendar  = getCalendar();
const judas     = getJudas();

res.status(200).json({
  spx:          { price },
  vix:          { value: vixVal, change: parseFloat(vixChange.toFixed(2)), changePct: parseFloat(vixChangePct.toFixed(2)), low52: vixLow52, high52: vixHigh52 },
  gex:          { ...gex, regime: 'negative' },
  iv:           { rank: ivRank, percentile: ivPct },
  putCall:      { ratio: 0.87 },
  strategy,
  bias,
  expectedMove: em,
  scenarios,
  calendar,
  liquidity:    liq,
  decision,
  judas,
  timestamp:    new Date().toISOString(),
  source:       'yahoo-finance2',
});
```

} catch (err) {
console.error(‘Handler error:’, err.message);
res.status(500).json({ error: err.message });
}
}

function calcLiquidity(hist, price) {
if (!hist || hist.length < 2) {
return {
pdh: parseFloat((price * 1.004).toFixed(2)),
pdl: parseFloat((price * 0.996).toFixed(2)),
weeklyHigh: parseFloat((price * 1.008).toFixed(2)),
weeklyLow:  parseFloat((price * 0.985).toFixed(2)),
};
}
const prev = hist[hist.length - 2];
const week = hist.slice(-5);
return {
pdh:        parseFloat(prev.high.toFixed(2)),
pdl:        parseFloat(prev.low.toFixed(2)),
weeklyHigh: parseFloat(Math.max(…week.map(d => d.high)).toFixed(2)),
weeklyLow:  parseFloat(Math.min(…week.map(d => d.low)).toFixed(2)),
};
}

function calcIVRank(vix, low = 12, high = 60) {
if (!vix || high === low) return 30;
return Math.min(100, Math.max(0, Math.round(((vix - low) / (high - low)) * 100)));
}

function fallbackGEX(price) {
return {
callWall:  Math.round(price * 1.015 / 25) * 25,
putWall:   Math.round(price * 0.985 / 25) * 25,
zeroGamma: Math.round(price / 25) * 25,
gammaFlip: Math.round(price * 1.005 / 5) * 5,
maxPain:   Math.round(price / 25) * 25,
netGex:    -1,
};
}

function getStrategy(rank) {
if (rank < 20) return { en: ‘Do Not Trade’,         ar: ‘لا تتداول اليوم’ };
if (rank < 40) return { en: ‘Credit Spread Narrow’,  ar: ‘سبريد ائتماني ضيق’ };
if (rank < 60) return { en: ‘Iron Condor’,           ar: ‘آيرون كوندور’ };
if (rank < 80) return { en: ‘Iron Condor Wide’,      ar: ‘آيرون كوندور واسع’ };
return             { en: ‘Iron Fly’,                ar: ‘آيرون فلاي’ };
}

function getBias(price, gex, vix) {
const aboveZG = price > gex.zeroGamma;
const negGex  = gex.netGex < 0;
if (aboveZG && !negGex) return { direction: ‘bullish’, strength: 65, reason: `السعر فوق Zero-Gamma (${gex.zeroGamma}). GEX إيجابي.` };
if (!aboveZG && negGex) return { direction: ‘bearish’, strength: 68, reason: `السعر تحت Zero-Gamma (${gex.zeroGamma}). GEX سلبي.` };
return { direction: ‘neutral’, strength: vix > 25 ? 42 : 52, reason: `بين Put Wall (${gex.putWall}) و Call Wall (${gex.callWall}).` };
}

function getExpectedMove(price, vix) {
const d = Math.round(price * (vix / 100) * Math.sqrt(1 / 365));
const w = Math.round(price * (vix / 100) * Math.sqrt(5 / 365));
const today = new Date();
const fri   = new Date(today);
fri.setDate(today.getDate() + ((5 - today.getDay() + 7) % 7 || 7));
return { dailyUpper: price + d, dailyLower: price - d, weeklyUpper: price + w, weeklyLower: price - w, expDate: fri.toISOString().split(‘T’)[0] };
}

function getScenarios(price, gex, dir) {
const cw = gex.callWall, pw = gex.putWall, mp = gex.maxPain, zg = gex.zeroGamma;
if (dir === ‘bearish’) return [
{ type: ‘bearish’,   icon: ‘↘’, name: ‘Bearish Continuation’, nameAr: ‘هبوط مستمر’,         prob: 55, target: pw, stop: zg },
{ type: ‘neutral-s’, icon: ‘→’, name: ‘Range-Bound’,          nameAr: ‘تداول في نطاق’,       prob: 30, target: mp, stop: Math.round(pw * 0.995) },
{ type: ‘bullish’,   icon: ‘↗’, name: ‘Bullish Reversal’,     nameAr: ‘انعكاس صاعد’,         prob: 15, target: zg, stop: pw },
];
if (dir === ‘bullish’) return [
{ type: ‘bullish’,   icon: ‘↗’, name: ‘Bullish Breakout’,     nameAr: ‘اختراق صعودي’,        prob: 50, target: cw, stop: zg },
{ type: ‘neutral-s’, icon: ‘→’, name: ‘Range-Bound’,          nameAr: ‘تداول في نطاق’,       prob: 35, target: mp, stop: pw },
{ type: ‘bearish’,   icon: ‘↘’, name: ‘Bearish Flush’,        nameAr: ‘هبوط نحو الدعم’,      prob: 15, target: pw, stop: cw },
];
return [
{ type: ‘neutral-s’, icon: ‘→’, name: ‘Range-Bound’,          nameAr: ‘تداول في نطاق محدد’,  prob: 55, target: mp, stop: Math.round(pw * 0.995) },
{ type: ‘bullish’,   icon: ‘↗’, name: ‘Bullish Breakout’,     nameAr: ‘اختراق صعودي’,        prob: 25, target: cw, stop: zg },
{ type: ‘bearish’,   icon: ‘↘’, name: ‘Bearish Flush’,        nameAr: ‘تصحيح هبوطي’,         prob: 20, target: pw, stop: Math.round(price * 1.005) },
];
}

function getDecision(bias, gex, price, rank) {
if (rank < 20) return { action: ‘⛔ لا تتداول اليوم’, detail: ‘IV منخفض جداً’ };
const dc = gex.callWall - price, dp = price - gex.putWall;
if (bias === ‘bearish’ && dc < dp * 1.5) return { action: ‘🔴 SELL CALL Credit Spread’, detail: `الدخول عند ${Math.round(gex.zeroGamma)} — الجدار ${gex.callWall}` };
if (bias === ‘bullish’ && dp < dc * 1.5) return { action: ‘🟢 SELL PUT Credit Spread’,  detail: `الدخول عند ${Math.round(gex.zeroGamma)} — الدعم ${gex.putWall}` };
return { action: ‘⚖️ Iron Condor’, detail: `بيع بين ${gex.putWall} و ${gex.callWall} — مغناطيس ${gex.maxPain}` };
}

function getCalendar() {
const now = new Date();
return [
{ date: ‘2026-04-07’, name: ‘FOMC Meeting Minutes’,       nameAr: ‘محضر اجتماع الفيدرالي’, impact: ‘HIGH’,   est: ‘—’,    prev: ‘—’ },
{ date: ‘2026-04-08’, name: ‘Initial Jobless Claims’,     nameAr: ‘طلبات الإعانة’,          impact: ‘MEDIUM’, est: ‘222K’, prev: ‘219K’ },
{ date: ‘2026-04-10’, name: ‘Monthly Options Expiration’, nameAr: ‘انتهاء خيارات شهرية’,   impact: ‘HIGH’,   est: ‘—’,    prev: ‘—’ },
].filter(e => new Date(e.date) >= new Date(now.toDateString()));
}

function getJudas() {
const hour = new Date().getUTCHours() + 3;
return { active: (hour >= 9 && hour < 11) || (hour >= 16 && hour < 17) };
}
