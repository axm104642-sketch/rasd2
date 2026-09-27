const FEED = [
  ["BTCUSD", "BTC-USD", "crypto"],
  ["SPX", "^GSPC", "index"],
  ["SPY", "SPY", "stock"],
  ["QQQ", "QQQ", "stock"],
  ["IWM", "IWM", "stock"],
  ["DIA", "DIA", "stock"],
  ["NVDA", "NVDA", "stock"],
  ["AAPL", "AAPL", "stock"],
  ["MSFT", "MSFT", "stock"],
  ["AMZN", "AMZN", "stock"],
  ["GOOGL", "GOOGL", "stock"],
  ["META", "META", "stock"],
  ["TSLA", "TSLA", "stock"],
  ["AMD", "AMD", "stock"],
  ["SMCI", "SMCI", "stock"],
  ["AVGO", "AVGO", "stock"],
  ["PLTR", "PLTR", "stock"],
  ["JPM", "JPM", "stock"],
  ["BAC", "BAC", "stock"],
  ["V", "V", "stock"],
  ["MA", "MA", "stock"],
  ["XOM", "XOM", "stock"],
  ["CVX", "CVX", "stock"],
  ["LLY", "LLY", "stock"],
  ["UNH", "UNH", "stock"],
  ["BA", "BA", "stock"],
  ["WMT", "WMT", "stock"],
  ["NFLX", "NFLX", "stock"],
  ["DIS", "DIS", "stock"],
];

const MIN_SCORE = 75;
const MIN_RR = 2;
const MIN_FVG_ATR = 0.05;
const FVG_KILL_ATR = 0.1;
const FVG_AGE = 15;
const SWEEP_AGE = 25;
const MSS_ATR = 0.1;
const BODY_ATR = 0.5;
const BODY_RATIO = 0.6;
const SL_BUFFER = 0.1;
const MAX_RUN = 0.5;

function atr(bars, period = 14) {
  if (bars.length < period + 1) {
    const last = bars.at(-1);
    return last ? last.h - last.l : 0;
  }
  let sum = 0;
  for (let i = bars.length - period; i < bars.length; i += 1) {
    const prev = bars[i - 1].c;
    const bar = bars[i];
    sum += Math.max(bar.h - bar.l, Math.abs(bar.h - prev), Math.abs(bar.l - prev));
  }
  return sum / period;
}

function closedBars(bars, seconds) {
  const now = Date.now() / 1000;
  return bars.filter((bar) => bar.t + seconds <= now);
}

function swings(bars, wing = 2) {
  const out = [];
  for (let i = wing; i < bars.length - wing; i += 1) {
    let high = true;
    let low = true;
    for (let k = 1; k <= wing; k += 1) {
      if (bars[i].h < bars[i - k].h || bars[i].h < bars[i + k].h) high = false;
      if (bars[i].l > bars[i - k].l || bars[i].l > bars[i + k].l) low = false;
    }
    if (high) out.push({ index: i, price: bars[i].h, kind: "high" });
    else if (low) out.push({ index: i, price: bars[i].l, kind: "low" });
  }
  return out;
}

function biasOf(bars) {
  const points = swings(bars);
  const highs = points.filter((point) => point.kind === "high");
  const lows = points.filter((point) => point.kind === "low");
  const high = highs.at(-1);
  const prevHigh = highs.at(-2);
  const low = lows.at(-1);
  const prevLow = lows.at(-2);
  if (high && prevHigh && low && prevLow) {
    if (high.price > prevHigh.price && low.price > prevLow.price) return "up";
    if (high.price < prevHigh.price && low.price < prevLow.price) return "down";
  }
  return "range";
}

function rvol(bars, index) {
  const look = bars.slice(Math.max(0, index - 20), index);
  const avg = look.reduce((sum, bar) => sum + bar.v, 0) / (look.length || 1);
  if (!avg) return 0;
  return bars[index].v / avg;
}

function passesFilter(kind, bars) {
  const last = bars.at(-1);
  if (!last || last.c < 5 || bars.length < 60) return false;
  if (kind !== "stock") return true;
  const look = bars.slice(-20);
  const volume = look.reduce((sum, bar) => sum + bar.v, 0) / look.length;
  const dollars = volume * last.c;
  return volume >= 1_000_000 && dollars >= 20_000_000;
}

function findSweep(bars, level, side) {
  const start = Math.max(1, bars.length - SWEEP_AGE);
  let found = null;
  for (let i = start; i < bars.length; i += 1) {
    const bar = bars[i];
    if (side === "up" && bar.l < level && bar.c > level) found = { index: i, extreme: bar.l, level };
    if (side === "down" && bar.h > level && bar.c < level) found = { index: i, extreme: bar.h, level };
  }
  if (!found) return null;
  for (let i = found.index + 1; i < bars.length; i += 1) {
    if (side === "up" && bars[i].c < found.level) return null;
    if (side === "down" && bars[i].c > found.level) return null;
  }
  return found;
}

function sweepScore(depth) {
  if (depth > 0.3) return 15;
  if (depth >= 0.1) return 10;
  return 5;
}

function impulseOk(bar, side, rangeAtr) {
  const body = Math.abs(bar.c - bar.o);
  const range = Math.max(bar.h - bar.l, 1e-9);
  const dir = side === "up" ? bar.c > bar.o : bar.c < bar.o;
  return dir && body >= rangeAtr * BODY_ATR && body / range >= BODY_RATIO;
}

function findFvg(bars, side, from, rangeAtr) {
  const last = Math.min(bars.length - 1, from + FVG_AGE);
  for (let i = Math.max(2, from); i <= last; i += 1) {
    const older = bars[i - 2];
    const newer = bars[i];
    const bull = side === "up" && newer.l > older.h;
    const bear = side === "down" && newer.h < older.l;
    if (!bull && !bear) continue;
    const bottom = bull ? older.h : newer.h;
    const top = bull ? newer.l : older.l;
    const size = top - bottom;
    if (size < rangeAtr * MIN_FVG_ATR) continue;
    let dead = false;
    for (let k = i + 1; k < bars.length; k += 1) {
      if (k - i > FVG_AGE) dead = true;
      if (bull && bars[k].c < bottom - rangeAtr * FVG_KILL_ATR) dead = true;
      if (bear && bars[k].c > top + rangeAtr * FVG_KILL_ATR) dead = true;
    }
    if (dead) continue;
    return { bottom, top, mid: (bottom + top) / 2, index: i };
  }
  return null;
}

function retest(bars, zone, side) {
  for (let i = zone.index + 1; i < bars.length; i += 1) {
    const bar = bars[i];
    if (side === "up" && bar.l <= zone.mid && bar.c >= zone.mid) return i;
    if (side === "down" && bar.h >= zone.mid && bar.c <= zone.mid) return i;
  }
  return -1;
}

function confirmedAfter(bars, index, side) {
  for (let i = index + 1; i < bars.length; i += 1) {
    const bar = bars[i];
    const range = Math.max(bar.h - bar.l, 1e-9);
    const body = Math.abs(bar.c - bar.o);
    if (body / range < BODY_RATIO) continue;
    if (side === "up" && bar.c > bar.o) return i;
    if (side === "down" && bar.c < bar.o) return i;
  }
  return -1;
}

function analyze(side, trade, daily, rangeAtr) {
  const htf = biasOf(daily);
  if (htf === "range" || (side === "up" && htf !== "up") || (side === "down" && htf !== "down")) return null;
  const points = swings(trade);
  const highs = points.filter((point) => point.kind === "high");
  const lows = points.filter((point) => point.kind === "low");
  const priorHigh = highs.at(-2) ?? highs.at(-1);
  const priorLow = lows.at(-2) ?? lows.at(-1);
  const level = side === "up" ? priorLow?.price : priorHigh?.price;
  const target = side === "up" ? priorHigh?.price : priorLow?.price;
  const nextTarget = side === "up" ? highs.at(-3)?.price : lows.at(-3)?.price;
  if (!level || !target) return null;
  const sweep = findSweep(trade, level, side);
  if (!sweep) return null;
  const depth = Math.abs(sweep.level - sweep.extreme) / Math.max(rangeAtr, 1e-9);
  let breakIndex = -1;
  let weak = false;
  const pivot = side === "up"
    ? highs.filter((point) => point.index < sweep.index).at(-1)
    : lows.filter((point) => point.index < sweep.index).at(-1);
  if (!pivot) return null;
  for (let i = sweep.index + 1; i < trade.length; i += 1) {
    const distance = side === "up" ? trade[i].c - pivot.price : pivot.price - trade[i].c;
    if (distance <= 0) continue;
    breakIndex = i;
    weak = distance < rangeAtr * MSS_ATR;
    break;
  }
  if (breakIndex < 0 || weak) return null;
  const impulse = trade[breakIndex];
  if (!impulseOk(impulse, side, rangeAtr)) return null;
  const gap = findFvg(trade, side, breakIndex, rangeAtr);
  if (!gap) return null;
  const tested = retest(trade, gap, side);
  if (tested < 0) return null;
  const confirm = confirmedAfter(trade, tested, side);
  if (confirm < 0) return null;
  const entry = trade[confirm].c;
  const stop = side === "up"
    ? sweep.extreme - rangeAtr * SL_BUFFER
    : sweep.extreme + rangeAtr * SL_BUFFER;
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return null;
  const reward = Math.abs(target - entry);
  const rr = reward / risk;
  if (rr < MIN_RR) return null;
  if (side === "up" && !(target > entry && stop < entry)) return null;
  if (side === "down" && !(target < entry && stop > entry)) return null;
  const moved = Math.abs(trade.at(-1).c - entry) / Math.max(rangeAtr, 1e-9);
  if (moved > MAX_RUN) return null;
  const volPoints = rvol(trade, breakIndex) >= 1.2 ? 5 : 0;
  const score = 20 + 15 + sweepScore(depth) + 15 + 10 + 10 + volPoints + 10;
  if (score < MIN_SCORE) return null;
  return {
    side: side === "up" ? "LONG" : "SHORT",
    score,
    entry,
    stop,
    tp1: target,
    tp2: nextTarget && Math.abs(nextTarget - entry) > reward ? nextTarget : target,
    rr,
  };
}

function decide(kind, daily, hourly) {
  if (!passesFilter(kind, daily)) return null;
  const trade = hourly.length >= 40 ? hourly : daily;
  const rangeAtr = atr(trade);
  if (rangeAtr <= 0) return null;
  return analyze("up", trade, daily, rangeAtr) ?? analyze("down", trade, daily, rangeAtr);
}

async function fetchChart(symbol, interval, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false`;
  let last = "تعذر جلب البيانات";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 429 || res.status >= 500) {
      last = "مصدر الأسعار مشغول";
      await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(res.status === 404 ? "الرمز غير موجود" : last);
    const payload = await res.json();
    const result = payload.chart?.result?.[0];
    const quote = result?.indicators?.quote?.[0];
    if (!result?.timestamp || !quote) throw new Error("لا توجد بيانات لهذا الرمز");
    const bars = [];
    result.timestamp.forEach((t, index) => {
      const o = quote.open?.[index];
      const h = quote.high?.[index];
      const l = quote.low?.[index];
      const c = quote.close?.[index];
      const v = quote.volume?.[index] ?? 0;
      if (![o, h, l, c].every(Number.isFinite) || c <= 0) return;
      bars.push({ t, o, h, l, c, v });
    });
    return bars;
  }
  throw new Error(last);
}

function money(value) {
  return Number(value).toFixed(2);
}

function message(row) {
  const up = row.side === "LONG";
  return [
    "قراءة اتجاه",
    "",
    `الرمز: ${row.symbol}`,
    `الاتجاه: ${row.side}`,
    "الحالة: TRADE_READY",
    `الدرجة: ${row.score}/100`,
    `الثقة: ${row.score >= 85 ? "عالية" : "متوسطة"}`,
    "الإطار: 1H",
    `الدخول: ${money(row.entry)}`,
    `الوقف: ${money(row.stop)}`,
    `الهدف 1: ${money(row.tp1)}`,
    `الهدف 2: ${money(row.tp2)}`,
    `العائد: ${row.rr.toFixed(2)}`,
    `السبب: ${up ? "سويب للقاع ثم كسر ثم فجوة ثم إعادة اختبار" : "سويب للقمة ثم كسر ثم فجوة ثم إعادة اختبار"}`,
    `الإلغاء: إغلاق ${up ? "تحت" : "فوق"} ${money(row.stop)}`,
    "",
    "التقويم مجهول",
    "قراءة اتجاه للسهم. ليست توصية شراء",
  ].join("\n");
}

async function sendTelegram(token, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 3900), disable_web_page_preview: true }),
    signal: AbortSignal.timeout(15000),
  });
  const payload = await res.json();
  if (!res.ok || !payload.ok) throw new Error(payload.description || "تيليجرام رفض الطلب");
}

async function one(item) {
  const [symbol, feed, kind] = item;
  const [dailyRaw, hourlyRaw] = await Promise.all([
    fetchChart(feed, "1d", "5y"),
    fetchChart(feed, "1h", "60d").catch(() => []),
  ]);
  const daySeconds = kind === "crypto" ? 86400 : 23 * 3600;
  const daily = closedBars(dailyRaw, daySeconds);
  const hourly = closedBars(hourlyRaw, 3600);
  const signal = decide(kind, daily, hourly);
  return signal ? { symbol, ...signal } : null;
}

const token = process.env.TELEGRAM_TOKEN?.trim() ?? "";
const chatId = process.env.TELEGRAM_CHAT?.trim() ?? "";
const dry = process.env.DRY === "1";
if ((!token || !chatId) && !dry) {
  console.error("ناقص توكن البوت أو رقم المحادثة");
  process.exit(1);
}

const ready = [];
const failed = [];
for (const item of FEED) {
  try {
    const signal = await one(item);
    if (signal) ready.push(signal);
    console.log(`${item[0]} ${signal ? signal.side : "لا صفقة"}`);
  } catch (error) {
    failed.push(item[0]);
    console.log(`${item[0]} تعذر`);
  }
}
console.log(`فُحص ${FEED.length}، إشارات ${ready.length}، تعذر ${failed.length}`);
if (ready.length === 0 || dry) process.exit(0);
for (const row of ready.slice(0, 4)) {
  await sendTelegram(token, chatId, message(row));
}
console.log("أُرسلت الرسالة");
