import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
const SAME_ENTRY_ATR = 0.1;
const STATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "state.json");

export function nyParts(ms) {
  const map = {};
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  for (const part of parts) if (part.type !== "literal") map[part.type] = part.value;
  let hour = Number(map.hour);
  if (hour === 24) hour = 0;
  return {
    date: `${map.year}-${map.month}-${map.day}`,
    minutes: hour * 60 + Number(map.minute),
    weekday: map.weekday,
  };
}

export function marketOpen(ms = Date.now()) {
  const ny = nyParts(ms);
  if (ny.weekday === "Sat" || ny.weekday === "Sun") return false;
  return ny.minutes >= 9 * 60 + 30 && ny.minutes < 16 * 60;
}

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

export function swings(bars, wing = 2) {
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

export function biasOf(bars) {
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

function sma(bars, length) {
  if (bars.length < length) return null;
  const look = bars.slice(-length);
  return look.reduce((sum, bar) => sum + bar.c, 0) / length;
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
  return volume >= 1_000_000 && volume * last.c >= 20_000_000;
}

export function closedDaily(bars, kind, now = Date.now()) {
  if (kind === "crypto") {
    const nowSec = now / 1000;
    return bars.filter((bar) => bar.t + 86400 <= nowSec);
  }
  const today = nyParts(now);
  return bars.filter((bar) => {
    const ny = nyParts(bar.t * 1000);
    if (ny.date < today.date) return true;
    if (ny.date > today.date) return false;
    return today.minutes >= 16 * 60;
  });
}

export function closedIntraday(bars, seconds, now = Date.now()) {
  const nowSec = now / 1000;
  return bars.filter((bar) => bar.t + seconds <= nowSec);
}

export function to4h(bars, now = Date.now()) {
  const map = new Map();
  for (const bar of bars) {
    const key = Math.floor(bar.t / (4 * 3600)) * 4 * 3600;
    const cur = map.get(key);
    if (!cur) map.set(key, { t: key, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v });
    else {
      cur.h = Math.max(cur.h, bar.h);
      cur.l = Math.min(cur.l, bar.l);
      cur.c = bar.c;
      cur.v += bar.v;
    }
  }
  const nowSec = now / 1000;
  return [...map.values()].filter((bar) => bar.t + 4 * 3600 <= nowSec).sort((a, b) => a.t - b.t);
}

export function regular15(bars) {
  return bars.filter((bar) => {
    const ny = nyParts(bar.t * 1000);
    if (ny.weekday === "Sat" || ny.weekday === "Sun") return false;
    return ny.minutes >= 9 * 60 + 30 && ny.minutes < 16 * 60;
  });
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

function gapAt(bars, index, side, rangeAtr) {
  if (index < 2) return null;
  const older = bars[index - 2];
  const newer = bars[index];
  const bull = side === "up" && newer.l > older.h;
  const bear = side === "down" && newer.h < older.l;
  if (!bull && !bear) return null;
  const bottom = bull ? older.h : newer.h;
  const top = bull ? newer.l : older.l;
  if (top - bottom < rangeAtr * MIN_FVG_ATR) return null;
  return { bottom, top, mid: (bottom + top) / 2, index, bull };
}

function killed(bars, gap, from, to, rangeAtr) {
  for (let k = from; k <= to && k < bars.length; k += 1) {
    if (gap.bull && bars[k].c < gap.bottom - rangeAtr * FVG_KILL_ATR) return true;
    if (!gap.bull && bars[k].c > gap.top + rangeAtr * FVG_KILL_ATR) return true;
  }
  return false;
}

function retestWithin(bars, gap, side) {
  const last = Math.min(bars.length - 1, gap.index + FVG_AGE);
  for (let i = gap.index + 1; i <= last; i += 1) {
    const bar = bars[i];
    if (side === "up" && bar.l <= gap.mid && bar.c >= gap.mid) return i;
    if (side === "down" && bar.h >= gap.mid && bar.c <= gap.mid) return i;
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

export function pickTargets(side, entry, points, yHigh, yLow) {
  const pool = [];
  if (side === "up") {
    for (const point of points) if (point.kind === "high" && point.price > entry) pool.push(point.price);
    if (yHigh > entry) pool.push(yHigh);
  } else {
    for (const point of points) if (point.kind === "low" && point.price < entry) pool.push(point.price);
    if (yLow < entry) pool.push(yLow);
  }
  const uniq = [...new Set(pool.map((price) => price.toFixed(4)))].map(Number);
  uniq.sort((a, b) => (side === "up" ? a - b : b - a));
  if (uniq.length < 2 || Math.abs(uniq[0] - uniq.at(-1)) < 1e-9) return null;
  return { tp1: uniq[0], tp2: uniq.at(-1) };
}

function analyzeSide(side, trade, yHigh, yLow, rangeAtr) {
  const points = swings(trade);
  const highs = points.filter((point) => point.kind === "high");
  const lows = points.filter((point) => point.kind === "low");
  const levels = side === "up" ? lows.map((point) => point.price) : highs.map((point) => point.price);
  levels.push(side === "up" ? yLow : yHigh);
  let best = null;
  for (const level of [...new Set(levels.map((price) => price.toFixed(4)))].map(Number)) {
    const sweep = findSweep(trade, level, side);
    if (!sweep) continue;
    const pivot = side === "up"
      ? highs.filter((point) => point.index < sweep.index).at(-1)
      : lows.filter((point) => point.index < sweep.index).at(-1);
    if (!pivot) continue;
    let breakIndex = -1;
    for (let i = sweep.index + 1; i < trade.length; i += 1) {
      const distance = side === "up" ? trade[i].c - pivot.price : pivot.price - trade[i].c;
      if (distance < rangeAtr * MSS_ATR) continue;
      breakIndex = i;
      break;
    }
    if (breakIndex < 0 || !impulseOk(trade[breakIndex], side, rangeAtr)) continue;
    const gap = gapAt(trade, breakIndex, side, rangeAtr);
    if (!gap) continue;
    const tested = retestWithin(trade, gap, side);
    if (tested < 0 || killed(trade, gap, gap.index + 1, tested, rangeAtr)) continue;
    const confirm = confirmedAfter(trade, tested, side);
    if (confirm !== trade.length - 1) continue;
    if (killed(trade, gap, tested + 1, confirm, rangeAtr)) continue;
    const entry = trade[confirm].c;
    const stop = side === "up" ? sweep.extreme - rangeAtr * SL_BUFFER : sweep.extreme + rangeAtr * SL_BUFFER;
    const risk = Math.abs(entry - stop);
    if (!(risk > 0)) continue;
    if (side === "up" && !(stop < entry)) continue;
    if (side === "down" && !(stop > entry)) continue;
    const targets = pickTargets(side, entry, points, yHigh, yLow);
    if (!targets) continue;
    const reward = Math.abs(targets.tp1 - entry);
    const rr = reward / risk;
    if (rr < MIN_RR) continue;
    const moved = Math.abs(trade.at(-1).c - entry) / Math.max(rangeAtr, 1e-9);
    if (moved > MAX_RUN) continue;
    const depth = Math.abs(sweep.level - sweep.extreme) / Math.max(rangeAtr, 1e-9);
    const score = 20 + 15 + sweepScore(depth) + 15 + 10 + 10 + (rvol(trade, breakIndex) >= 1.2 ? 5 : 0) + 10;
    if (score < MIN_SCORE) continue;
    const row = {
      side: side === "up" ? "LONG" : "SHORT",
      rawSide: side,
      score,
      entry,
      stop,
      tp1: targets.tp1,
      tp2: targets.tp2,
      rr,
      atr: rangeAtr,
      entryT: trade[confirm].t,
    };
    if (!best || row.score > best.score) best = row;
  }
  return best;
}

export function decide(kind, daily, hourly, h4) {
  if (!passesFilter(kind, daily)) return null;
  const bias = biasOf(daily);
  if (bias === "range") return null;
  const average = sma(daily, 50);
  const last = daily.at(-1);
  if (average == null || !last) return null;
  if (bias === "up" && last.c <= average) return null;
  if (bias === "down" && last.c >= average) return null;
  if (biasOf(h4) !== bias) return null;
  const trade = hourly.length >= 40 ? hourly : daily;
  const rangeAtr = atr(trade);
  if (rangeAtr <= 0) return null;
  const yHigh = last.h;
  const yLow = last.l;
  return analyzeSide(bias, trade, yHigh, yLow, rangeAtr);
}

export function m15Agrees(bars, side) {
  const last = bars.at(-1);
  if (!last) return false;
  if (side === "LONG") return last.c > last.o;
  return last.c < last.o;
}

export function premarketText(kind, bars, now = Date.now()) {
  if (kind !== "stock") return "غير متوفر";
  const ny = nyParts(now);
  if (ny.weekday === "Sat" || ny.weekday === "Sun" || ny.minutes < 9 * 60 + 30) return "غير متوفر";
  const rows = bars.filter((bar) => {
    const part = nyParts(bar.t * 1000);
    return part.date === ny.date && part.minutes >= 4 * 60 && part.minutes < 9 * 60 + 30;
  });
  if (!rows.length) return "غير متوفر";
  const high = Math.max(...rows.map((bar) => bar.h));
  const low = Math.min(...rows.map((bar) => bar.l));
  return `الأعلى ${money(high)} / الأدنى ${money(low)}`;
}

export function stepFollow(position, bar) {
  const up = position.side === "LONG";
  const hitStop = up ? bar.l <= position.stop : bar.h >= position.stop;
  const hitTp1 = up ? bar.h >= position.tp1 : bar.l <= position.tp1;
  const hitTp2 = up ? bar.h >= position.tp2 : bar.l <= position.tp2;
  if (hitStop && (hitTp1 || hitTp2)) return { type: "unclear", price: bar.c };
  if (hitTp2) return { type: "tp2", price: bar.c };
  if (hitTp1 && !position.tp1Sent) return { type: "tp1", price: bar.c };
  if (hitStop) return { type: "stop", price: bar.c };
  return null;
}

export function sessionsAfter(bars, entryT, kind) {
  const dates = new Set();
  for (const bar of bars) {
    if (bar.t <= entryT) continue;
    dates.add(kind === "crypto" ? new Date(bar.t * 1000).toISOString().slice(0, 10) : nyParts(bar.t * 1000).date);
  }
  return dates.size;
}

export function sameIdea(open, row) {
  if (!open) return false;
  if (open.side !== row.side) return true;
  return Math.abs(open.entry - row.entry) <= (row.atr || open.atr || 1) * SAME_ENTRY_ATR;
}

function money(value) {
  return Number(value).toFixed(2);
}

function entryMessage(row) {
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
    `قبل الافتتاح: ${row.premarket}`,
    "",
    "التقويم مجهول",
    "قراءة اتجاه للسهم. ليست توصية شراء",
  ].join("\n");
}

function followMessage(type, symbol, position, price) {
  const tail = "\n\nقراءة اتجاه للسهم. ليست توصية شراء";
  if (type === "tp1") {
    return `متابعة\n\nالرمز: ${symbol}\nالحالة: وصل الهدف الأول\nالسعر الآن: ${money(price)}\nالهدف الثاني: ${money(position.tp2)}\nالوقف: ${money(position.stop)}${tail}`;
  }
  if (type === "tp2") {
    return `متابعة\n\nالرمز: ${symbol}\nالحالة: وصل الهدف الثاني\nالسعر الآن: ${money(price)}\nالمتابعة: انتهت${tail}`;
  }
  if (type === "stop") {
    return `متابعة\n\nالرمز: ${symbol}\nالحالة: تم وقف الخسارة\nالسعر الآن: ${money(price)}\nالمتابعة: انتهت${tail}`;
  }
  return `متابعة\n\nالرمز: ${symbol}\nالحالة: النتيجة غير واضحة\nالسبب: الوقف والهدف داخل نفس الشمعة\nالمتابعة: انتهت${tail}`;
}

async function fetchChart(symbol, interval, range, prepost) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=${prepost ? "true" : "false"}`;
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

function loadState() {
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    return { open: raw.open ?? {}, pending: raw.pending ?? {} };
  } catch {
    return { open: {}, pending: {} };
  }
}

function saveState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state));
}

function timingBars(kind, m15) {
  return kind === "crypto" ? m15 : regular15(m15);
}

async function main() {
  const token = process.env.TELEGRAM_TOKEN?.trim() ?? "";
  const chatId = process.env.TELEGRAM_CHAT?.trim() ?? "";
  const dry = process.env.DRY === "1";
  if ((!token || !chatId) && !dry) {
    console.error("ناقص توكن البوت أو رقم المحادثة");
    process.exit(1);
  }
  const now = Date.now();
  const openNow = marketOpen(now);
  const state = loadState();
  const feed = process.env.LIMIT ? FEED.slice(0, Number(process.env.LIMIT)) : FEED;
  const follows = [];
  const entries = [];
  const failed = [];
  let signals = 0;

  for (const [symbol, yahoo, kind] of feed) {
    try {
      const [dailyRaw, hourRaw, m15Raw] = await Promise.all([
        fetchChart(yahoo, "1d", "5y", false),
        fetchChart(yahoo, "1h", "60d", false),
        fetchChart(yahoo, "15m", "5d", true),
      ]);
      const daily = closedDaily(dailyRaw, kind, now);
      const hourly = closedIntraday(hourRaw, 3600, now);
      const m15 = closedIntraday(m15Raw, 900, now);
      const h4 = to4h(hourly, now);
      const position = state.open[symbol];
      let blocking = Boolean(position);
      if (position) {
        const bias = biasOf(daily);
        const against = (position.side === "LONG" && bias !== "up") || (position.side === "SHORT" && bias !== "down");
        if (against || sessionsAfter(daily, position.entryT, kind) >= 5) {
          delete state.open[symbol];
          blocking = false;
          console.log(`${symbol} انتهت المتابعة`);
        } else {
          const watched = { ...position };
          for (const bar of timingBars(kind, m15)) {
            if (bar.t < position.entryT + 3600) continue;
            const event = stepFollow(watched, bar);
            if (!event) continue;
            follows.push({ type: event.type, symbol, position: { ...watched }, price: event.price });
            if (event.type === "tp1") watched.tp1Sent = true;
            else {
              blocking = false;
              break;
            }
          }
        }
      }

      const sessionOk = kind === "crypto" || openNow;
      const signal = sessionOk ? decide(kind, daily, hourly, h4) : null;
      const bars15 = timingBars(kind, m15);
      const agrees = signal ? m15Agrees(bars15, signal.side) : false;
      if (!sessionOk) {
        delete state.pending[symbol];
        console.log(`${symbol} خارج الجلسة`);
      } else if (signal && blocking) {
        console.log(`${symbol} متابعة مفتوحة`);
      } else if (signal && agrees) {
        entries.push({
          symbol,
          row: { symbol, ...signal, premarket: premarketText(kind, m15Raw, now), kind },
        });
        delete state.pending[symbol];
        signals += 1;
        console.log(`${symbol} ${signal.side} ${signal.score}`);
      } else if (signal) {
        state.pending[symbol] = { ...signal, kind, until: signal.entryT + 2 * 3600 };
        console.log(`${symbol} انتظار`);
      } else if (state.pending[symbol] && now / 1000 <= state.pending[symbol].until && m15Agrees(bars15, state.pending[symbol].side) && !blocking) {
        const pending = state.pending[symbol];
        const moved = Math.abs((hourly.at(-1)?.c ?? pending.entry) - pending.entry) / Math.max(pending.atr, 1e-9);
        if (moved <= MAX_RUN) {
          entries.push({
            symbol,
            row: { symbol, ...pending, premarket: premarketText(kind, m15Raw, now), kind: pending.kind },
          });
          delete state.pending[symbol];
          signals += 1;
          console.log(`${symbol} ${pending.side} ${pending.score}`);
        } else console.log(`${symbol} لا صفقة`);
      } else {
        if (state.pending[symbol] && now / 1000 > state.pending[symbol].until) delete state.pending[symbol];
        if (!position) console.log(`${symbol} لا صفقة`);
      }
    } catch {
      failed.push(symbol);
      console.log(`${symbol} تعذر`);
    }
  }

  entries.sort((a, b) => b.row.score - a.row.score);
  console.log(`فُحص ${feed.length}، إشارات ${signals}، تعذر ${failed.length}`);
  if (!dry) {
    const sentFollow = new Set();
    for (const item of follows) {
      if (sentFollow.has(`${item.symbol}:stop`)) continue;
      try {
        await sendTelegram(token, chatId, followMessage(item.type, item.symbol, item.position, item.price));
        if (item.type === "tp1" && state.open[item.symbol]) state.open[item.symbol].tp1Sent = true;
        else delete state.open[item.symbol];
        if (item.type !== "tp1") sentFollow.add(`${item.symbol}:stop`);
        await new Promise((resolve) => setTimeout(resolve, 400));
      } catch {
        console.log(`${item.symbol} تعذر الإرسال`);
        sentFollow.add(`${item.symbol}:stop`);
      }
    }
    for (const item of entries) {
      if (state.open[item.symbol]) continue;
      try {
        await sendTelegram(token, chatId, entryMessage(item.row));
        state.open[item.symbol] = {
          side: item.row.side,
          entry: item.row.entry,
          stop: item.row.stop,
          tp1: item.row.tp1,
          tp2: item.row.tp2,
          atr: item.row.atr,
          entryT: item.row.entryT,
          tp1Sent: false,
          kind: item.row.kind,
        };
        await new Promise((resolve) => setTimeout(resolve, 400));
      } catch {
        console.log(`${item.symbol} تعذر الإرسال`);
      }
    }
  }
  saveState(state);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
