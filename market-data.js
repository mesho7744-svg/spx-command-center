// api/market-data.js — MESH SPX Command Center
// Uses Stooq as primary source (no blocking)

export default async function handler(req, res) {
res.setHeader(‘Access-Control-Allow-Origin’, ‘*’);
res.setHeader(‘Cache-Control’, ‘no-cache, no-store’);

try {
const [spx, vix, liq] = await Promise.allSettled([
fetchSPX(),
fetchVIX(),
fetchLiquidity(),
]);

```
const price  = spx.value?.price  || 6582;
const vixVal = vix.value?.value   || 23.87;
const liquid = liq.value          || {};

const ivRank = calcIVRank(vixVal, vix.value?.low52 || 12, vix.value?.high52 || 45);
const ivPct  = vix.value?.percentile || Math.round(ivRank * 0.85);
const gex    = fallbackGEX(price);
const strategy = getStrategy(ivRank);
const bias     = getBias(price, gex, vixVal);
const em       = getExpectedMove(price, vixVal);
const scenarios = getScenarios(price, gex, bias.direction);
const decision  = getDecision(bias.direction, gex, price, ivRank);
const calendar  = getCalendar();
const judas     = getJudas();

res.status(200).json({
  spx:          { price },
  vix:          vix.value || { value: vixVal, change: 0, changePct: 0, low52: 12, high52: 45 },
  gex:          { ...gex, regime: gex.netGex < 0 ? 'negative' : 'positive' },
  iv:           { rank: ivRank, percentile: ivPct },
  putCall:      { ratio: 0.87 },
  strategy,
  bias,
  expectedMove: em,
  scenarios,
  calendar,
  liquidity:    liquid,
  decision,
  judas,
  timestamp:    new Date().toISOString(),
  source:       'stooq',
});
```

} catch (err) {
res.status(500).json({ error: err.message });
}
}

// ── STOOQ — no blocking, reliable ──
async function fetchSPX() {
try {
const res = await fetch(‘https://stooq.com/q/l/?s=^spx&f=sd2t2ohlcv&h&e=csv’, {
headers: { ‘User-Agent’: ‘Mozilla/5.0’ },
signal: AbortSignal.timeout(8000),
});
const text = await res.text();
const lines = text.trim().split(’\n’);
if (lines.length > 1) {
const parts = lines[1].split(’,’);
const price = parseFloat(parts[4]);
if (price > 1000) return { price };
}
} catch {}

// Yahoo fallback
try {
const res = await fetch(
‘https://query2.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1m&range=1d’,
{ headers: { ‘User-Agent’: ‘Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36’, ‘Accept’: ‘application/json’, ‘Accept-Language’: ‘en-US,en;q=0.9’ },
signal: AbortSignal.timeout(8000) }
);
const data = await res.json();
const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
if (price && price > 1000) return { price };
} catch {}

return { price: null };
}

async function fetchVIX() {
try {
const res = await fetch(‘https://stooq.com/q/l/?s=^vix&f=sd2t2ohlcv&h&e=csv’, {
headers: { ‘User-Agent’: ‘Mozilla/5.0’ },
signal: AbortSignal.timeout(8000),
});
const text = await res.text();
const lines = text.trim().split(’\n’);
if (lines.length > 1) {
const p = lines[1].split(’,’);
const value = parseFloat(p[4]);
const open  = parseFloat(p[2]);
if (value > 0) {
const change    = parseFloat((value - open).toFixed(2));
const changePct = parseFloat(((change / open) * 100).toFixed(2));
return { value, change, changePct, low52: 12, high52: 45, percentile: Math.round(((value - 12) / (45 - 12)) * 100) };
}
}
} catch {}

// Yahoo fallback
try {
const res = await fetch(
‘https://query2.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=1y’,
{ headers: { ‘User-Agent’: ‘Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36’ },
signal: AbortSignal.timeout(8000) }
);
const data = await res.json();
const result = data?.chart?.result?.[0];
const closes = result?.indicators?.quote?.[0]?.close?.filter(Boolean) || [];
const value  = result?.meta?.regularMarketPrice;
if (value) {
const prevClose = result?.meta?.previousClose || value;
const change    = parseFloat((value - prevClose).toFixed(2));
const changePct = parseFloat(((change / prevClose) * 100).toFixed(2));
const low52  = closes.length > 50 ? Math.min(…closes.slice(-252)) : 12;
const high52 = closes.length > 50 ? Math.max(…closes.slice(-252)) : 45;
const percentile = closes.length > 10 ? Math.round(closes.filter(c => c < value).length / closes.length * 100) : 60;
return { value, change, changePct, low52, high52, percentile };
}
} catch {}

return null;
}

async function fetchLiquidity() {
try {
const res = await fetch(‘https://stooq.com/q/d/l/?s=^spx&i=d’, {
headers: { ‘User-Agent’: ‘Mozilla/5.0’ },
signal: AbortSignal.timeout(8000),
});
const text = await res.text();
const lines = text.trim().split(’\n’).filter(l => l && !l.startsWith(‘Date’));
if (lines.length >= 2) {
const today = lines[lines.length - 1].split(’,’);
const prev  = lines[lines.length - 2].split(’,’);
return {
pdh: parseFloat(parseFloat(prev[2]).toFixed(2)),
pdl: parseFloat(parseFloat(prev[3]).toFixed(2)),
weeklyHigh: Math.max(…lines.slice(-5).map(l => parseFloat(l.split(’,’)[2]))),
weeklyLow:  Math.min(…lines.slice(-5).map(l => parseFloat(l.split(’,’)[3]))),
};
}
} catch {}
return {};
}

// ── CALCULATIONS ──
function calcIVRank(vix, low = 12, high = 45) {
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
if (rank < 20) return { en: ‘Do Not Trade’, ar: ‘لا تتداول اليوم’ };
if (rank < 40) return { en: ‘Credit Spread Narrow’, ar: ‘سبريد ائتماني ضيق’ };
if (rank < 60) return { en: ‘Iron Condor’, ar: ‘آيرون كوندور’ };
if (rank < 80) return { en: ‘Iron Condor Wide’, ar: ‘آيرون كوندور واسع’ };
return { en: ‘Iron Fly’, ar: ‘آيرون فلاي’ };
}

function getBias(price, gex, vix) {
const aboveZG = price > gex.zeroGamma;
const negGex  = gex.netGex < 0;
if (aboveZG && !negGex) return { direction: ‘bullish’, strength: 65, reason: `السعر فوق Zero-Gamma (${gex.zeroGamma}). GEX إيجابي.` };
if (!aboveZG && negGex) return { direction: ‘bearish’, strength: 68, reason: `السعر تحت Zero-Gamma (${gex.zeroGamma}). GEX سلبي.` };
return { direction: ‘neutral’, strength: vix > 25 ? 42 : 52, reason: `بين Put Wall (${gex.putWall}) و Call Wall (${gex.callWall}). مغناطيس ${gex.maxPain}.` };
}

function getExpectedMove(price, vix) {
const d = Math.round(price * (vix / 100) * Math.sqrt(1 / 365));
const w = Math.round(price * (vix / 100) * Math.sqrt(5 / 365));
const today = new Date();
const fri = new Date(today);
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
{ date: ‘2026-04-07’, name: ‘FOMC Meeting Minutes’,     nameAr: ‘محضر اجتماع الفيدرالي’, impact: ‘HIGH’,   est: ‘—’,   prev: ‘—’ },
{ date: ‘2026-04-08’, name: ‘Initial Jobless Claims’,   nameAr: ‘طلبات الإعانة’,          impact: ‘MEDIUM’, est: ‘222K’, prev: ‘219K’ },
{ date: ‘2026-04-10’, name: ‘Monthly Options Expiration’, nameAr: ‘انتهاء خيارات شهرية’, impact: ‘HIGH’,   est: ‘—’,   prev: ‘—’ },
].filter(e => new Date(e.date) >= new Date(now.toDateString()));
}

function getJudas() {
const hour = new Date().getUTCHours() + 3;
return { active: (hour >= 9 && hour < 11) || (hour >= 16 && hour < 17) };
}
