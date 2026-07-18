import { useState, useEffect, useMemo, useCallback, useRef, useLayoutEffect } from "react";
import { TrendingUp, TrendingDown, ChevronLeft, ChevronRight, AlertCircle, Activity, Pencil, Trash2 } from "lucide-react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from "recharts";

const COLORS = {
  bg: "#0A0C10",
  panel: "#12151B",
  panel2: "#161A21",
  border: "#1E232B",
  text: "#E7E9ED",
  dim: "#6B7280",
  muted: "#8B92A0",
  green: "#22C55E",
  greenBg: "rgba(34,197,94,",
  red: "#F0506E",
  redBg: "rgba(240,80,110,",
  amber: "#F2A93B",
};

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DOWS = ['S','M','T','W','T','F','S'];

function fmt(v) {
  const abs = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${v >= 0 ? '+' : '-'}$${abs}`;
}

// Parses OCC-style option symbols like "SPY260616C00754000" or "SPY  260616C00754000"
// into { root, right, strike, dateLabel, label }. Returns null for plain equity tickers.
function parseOptionSymbol(raw) {
  if (!raw) return null;
  const compact = raw.replace(/\s+/g, '');
  const m = compact.match(/^([A-Z]{1,6})(\d{6})([CP])(\d{8})$/);
  if (!m) return null;
  const [, root, yymmdd, right, strikeRaw] = m;
  const mm = parseInt(yymmdd.slice(2, 4), 10);
  const dd = parseInt(yymmdd.slice(4, 6), 10);
  const yy = yymmdd.slice(0, 2);
  const strike = parseInt(strikeRaw, 10) / 1000;
  const strikeLabel = strike % 1 === 0 ? strike.toFixed(0) : strike.toFixed(2);
  const rightLabel = right === 'C' ? 'Call' : 'Put';
  const dateLabel = `${mm}/${dd}/${yy}`;
  return { root, right: rightLabel, strike, dateLabel, label: `${root} $${strikeLabel} ${rightLabel} · ${dateLabel}` };
}

// FIFO-match buy/sell legs per symbol. Handles both long trades (buy→sell)
// and short trades like sold puts (sell→buy). Each direction uses its own lot queue.
function computeRealized(trades) {
  const sorted = trades
    .map((t, idx) => ({ ...t, _idx: idx }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const longLots = {};
  const shortLots = {};
  const realized = [];
  for (const t of sorted) {
    const mult = parseOptionSymbol(t.symbol) ? 100 : 1;
    const key = `${t.account}|${t.symbol}`;
    if (!longLots[key]) longLots[key] = [];
    if (!shortLots[key]) shortLots[key] = [];
    if (t.side === 'buy') {
      if (shortLots[key].length > 0) {
        // Buy-to-close a short position (e.g. buying back a sold put)
        let remaining = t.qty;
        while (remaining > 1e-9 && shortLots[key].length) {
          const lot = shortLots[key][0];
          const matched = Math.min(remaining, lot.qty);
          realized.push({
            symbol: t.symbol, desc: t.desc, qty: matched,
            buyPrice: t.price, sellPrice: lot.price,
            openDate: lot.date, closeDate: t.date,
            pnl: (lot.price - t.price) * matched * mult,
            isOption: mult === 100, isShort: true,
            account: lot.account || t.account,
          });
          lot.qty -= matched;
          remaining -= matched;
          if (lot.qty <= 1e-9) shortLots[key].shift();
        }
        if (remaining > 1e-9) longLots[key].push({ qty: remaining, price: t.price, date: t.date, account: t.account, idx: t._idx });
      } else {
        longLots[key].push({ qty: t.qty, price: t.price, date: t.date, account: t.account, idx: t._idx });
      }
    } else {
      if (longLots[key].length > 0) {
        // Sell-to-close a long position
        let remaining = t.qty;
        while (remaining > 1e-9 && longLots[key].length) {
          const lot = longLots[key][0];
          const matched = Math.min(remaining, lot.qty);
          realized.push({
            symbol: t.symbol, desc: t.desc, qty: matched,
            buyPrice: lot.price, sellPrice: t.price,
            openDate: lot.date, closeDate: t.date,
            pnl: (t.price - lot.price) * matched * mult,
            isOption: mult === 100, isShort: false,
            account: lot.account || t.account,
          });
          lot.qty -= matched;
          remaining -= matched;
          if (lot.qty <= 1e-9) longLots[key].shift();
        }
        if (remaining > 1e-9) shortLots[key].push({ qty: remaining, price: t.price, date: t.date, account: t.account, idx: t._idx });
      } else {
        // Sell-to-open a short position (e.g. selling a put)
        shortLots[key].push({ qty: t.qty, price: t.price, date: t.date, account: t.account, idx: t._idx });
      }
    }
  }
  const openPositions = [];
  for (const [key, arr] of Object.entries(longLots)) {
    const remaining = arr.filter((l) => l.qty > 1e-9);
    if (!remaining.length) continue;
    const symbol = key.slice(key.indexOf('|') + 1);
    const totalQty = remaining.reduce((s, l) => s + l.qty, 0);
    const totalCost = remaining.reduce((s, l) => s + l.qty * l.price, 0);
    openPositions.push({
      symbol, qty: totalQty, avgPrice: totalCost / totalQty,
      account: remaining[0]?.account || '',
      openDate: remaining.reduce((min, l) => (!min || l.date < min ? l.date : min), null),
      isShort: false,
      lots: remaining.map((l) => ({ idx: l.idx, qty: l.qty })),
    });
  }
  for (const [key, arr] of Object.entries(shortLots)) {
    const remaining = arr.filter((l) => l.qty > 1e-9);
    if (!remaining.length) continue;
    const symbol = key.slice(key.indexOf('|') + 1);
    const totalQty = remaining.reduce((s, l) => s + l.qty, 0);
    const totalCost = remaining.reduce((s, l) => s + l.qty * l.price, 0);
    openPositions.push({
      symbol, qty: totalQty, avgPrice: totalCost / totalQty,
      account: remaining[0]?.account || '',
      openDate: remaining.reduce((min, l) => (!min || l.date < min ? l.date : min), null),
      isShort: true,
      lots: remaining.map((l) => ({ idx: l.idx, qty: l.qty })),
    });
  }

  const coalesced = [];
  const indexOf = new Map();
  for (const r of realized) {
    const key = `${r.symbol}|${r.openDate}|${r.closeDate}|${r.buyPrice}|${r.sellPrice}|${r.account}`;
    if (indexOf.has(key)) {
      const existing = coalesced[indexOf.get(key)];
      existing.qty += r.qty;
      existing.pnl += r.pnl;
    } else {
      indexOf.set(key, coalesced.length);
      coalesced.push({ ...r });
    }
  }

  return { realized: coalesced, openPositions };
}

// Display label for a trade — handles Robinhood OCC symbols and Schwab format
function getTradeDisplayLabel(t) {
  if (t.tradeType) {
    return t.tradeType.toLowerCase() === 'shares'
      ? t.symbol
      : `${t.symbol} ${t.tradeType}${t.expiration ? ` · ${t.expiration}` : ''}`;
  }
  const opt = parseOptionSymbol(t.symbol);
  return opt ? opt.label : t.symbol;
}

function isContractTrade(t) {
  if (t.tradeType) return t.tradeType.toLowerCase() !== 'shares';
  return !!parseOptionSymbol(t.symbol);
}

// Parse tab-separated text pasted from Excel (Schwab trade log format).
// Expected columns: Trade #, Ticker, (blank), Trade, Expiration, Contracts,
// Entry Date, Exit Date, Entry Price, Exit Price, % Gain/Loss, Total $ Gain/Loss,
// Setup / Thesis, Notes / Emotion, SUM
function parseSchwabTSV(text) {
  const lines = text.trim().split('\n').map(l => l.split('\t').map(c => c.trim()));

  let headerIdx = -1;
  let headers = [];
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    if (lines[i].some(c => c.toLowerCase() === 'ticker')) {
      headerIdx = i;
      headers = lines[i].map(c => c.toLowerCase());
      break;
    }
  }
  if (headerIdx === -1) throw new Error('Could not find a "Ticker" column — make sure to copy the header row too');

  const col = (...kws) => {
    for (const kw of kws) {
      const idx = headers.findIndex(h => h.includes(kw.toLowerCase()));
      if (idx !== -1) return idx;
    }
    return -1;
  };

  const tickerIdx    = col('ticker');
  const tradeTypeIdx = headers.findIndex(h => h === 'trade'); // exact match — avoid "trade #"
  const expirationIdx = col('expiration');
  const contractsIdx  = col('contracts');
  const entryDateIdx  = col('entry date');
  const exitDateIdx   = col('exit date');
  const entryPriceIdx = col('entry price');
  const exitPriceIdx  = col('exit price');
  const pnlIdx        = col('total $');
  const notesIdx      = col('notes / emotion', 'notes');

  const thisYear = new Date().getFullYear();

  const parseNum = (s) =>
    parseFloat((s || '').toString().replace(/,/g, '').replace(/[^0-9.\-]/g, '')) || 0;

  const parseMD = (val) => {
    if (!val) return null;
    const s = val.toString().trim();
    const parts = s.split('/');
    if (parts.length === 2) {
      const mo = parseInt(parts[0], 10), d = parseInt(parts[1], 10);
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31)
        return `${thisYear}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    if (parts.length === 3) {
      const mo = parseInt(parts[0], 10), d = parseInt(parts[1], 10);
      let y = parseInt(parts[2], 10);
      if (y < 100) y += 2000;
      return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    return null;
  };

  const result = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const row = lines[i];
    if (!row || row.length < 3) continue;
    const ticker = tickerIdx >= 0 ? row[tickerIdx] : '';
    if (!ticker) continue;

    const tradeType   = tradeTypeIdx >= 0 ? (row[tradeTypeIdx] || 'shares') : 'shares';
    const expiration  = expirationIdx >= 0 ? (row[expirationIdx] || '') : '';
    const qty         = parseNum(contractsIdx >= 0 ? row[contractsIdx] : '0');
    const openDate    = parseMD(entryDateIdx >= 0 ? row[entryDateIdx] : null);
    const closeDate   = parseMD(exitDateIdx >= 0 ? row[exitDateIdx] : null);
    const buyPrice    = parseNum(entryPriceIdx >= 0 ? row[entryPriceIdx] : '0');
    const sellPrice   = parseNum(exitPriceIdx >= 0 ? row[exitPriceIdx] : '0');
    const pnl         = parseNum(pnlIdx >= 0 ? row[pnlIdx] : '0');
    const noteVal     = notesIdx >= 0 ? (row[notesIdx] || '') : '';

    if (!ticker || qty <= 0 || !openDate || !closeDate) continue;

    result.push({
      symbol: ticker, tradeType, expiration,
      qty, buyPrice, sellPrice, openDate, closeDate, pnl,
      isOption: tradeType.toLowerCase() !== 'shares',
      account: 'Schwab', desc: '', _note: noteVal,
    });
  }

  if (!result.length)
    throw new Error('No valid trades found — check that Ticker, Entry/Exit Date, Contracts, Entry/Exit Price, and Total $ Gain/Loss columns are present');

  return result;
}

export default function TradeTracker() {
  // ── Robinhood state ──────────────────────────────────────────────────────────
  const [trades, setTrades] = useState([]);
  const [lastSynced, setLastSynced] = useState(null);
  const [notes, setNotes] = useState('');
  const [tradeNotes, setTradeNotes] = useState({});

  // ── Schwab state ─────────────────────────────────────────────────────────────
  const [schwabRealized, setSchwabRealized] = useState([]);
  const [schwabNotes, setSchwabNotes] = useState('');
  const [schwabTradeNotes, setSchwabTradeNotes] = useState({});
  const [schwabImportText, setSchwabImportText] = useState('');
  const [showSchwabImport, setShowSchwabImport] = useState(false);

  // ── Shared UI state ──────────────────────────────────────────────────────────
  const [activeAccount, setActiveAccount] = useState('robinhood');
  const [error, setError] = useState(null);
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState('');
  const [importNote, setImportNote] = useState(null);
  const [showPositions, setShowPositions] = useState(false);
  const [showTickerPnl, setShowTickerPnl] = useState(false);
  const [showBackup, setShowBackup] = useState(false);
  const [compactCalendar, setCompactCalendar] = useState(false);
  const [editingNoteKey, setEditingNoteKey] = useState(null);
  const [selectedDay, setSelectedDay] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [year, setYear] = useState(new Date().getFullYear());
  const [month, setMonth] = useState(new Date().getMonth());
  const calendarRef = useRef(null);
  const [calHeight, setCalHeight] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const raw = localStorage.getItem('trades-data');
        if (raw) {
          const parsed = JSON.parse(raw);
          const t = parsed.trades || [];
          setTrades(t);
          setLastSynced(parsed.lastSynced || null);
          setNotes(parsed.notes || '');
          setTradeNotes(parsed.tradeNotes || {});
          if (t.length) {
            const d = new Date(t[t.length - 1].date + 'T12:00:00');
            setYear(d.getFullYear());
            setMonth(d.getMonth());
          }
        }
      } catch (_) {}
      try {
        const raw = localStorage.getItem('trades-data-schwab');
        if (raw) {
          const parsed = JSON.parse(raw);
          setSchwabRealized(parsed.realized || []);
          setSchwabNotes(parsed.notes || '');
          setSchwabTradeNotes(parsed.tradeNotes || {});
        }
      } catch (_) {}
      setLoaded(true);
    })();
  }, []);

  // ── Robinhood import (JSON) ───────────────────────────────────────────────────
  const importTrades = useCallback((rawText) => {
    setError(null);
    try {
      const clean = rawText.replace(/```json|```/g, '').trim();
      const start = clean.indexOf('[');
      const end = clean.lastIndexOf(']');
      if (start === -1 || end === -1) throw new Error('Could not find a JSON array in the pasted text');

      const parsed = JSON.parse(clean.slice(start, end + 1));
      const incoming = parsed
        .map((t) => ({ date: t.d || t.date, symbol: t.s || t.symbol, desc: t.n || t.desc || '', side: t.a || t.side, qty: Number(t.q ?? t.qty), price: Number(t.p ?? t.price), account: t.c || t.account || '' }))
        .filter((t) => t.date && t.symbol && t.qty > 0 && t.price > 0 && (t.side === 'buy' || t.side === 'sell'));

      if (!incoming.length) throw new Error('No valid trades found in the pasted data');

      const keyOf = (t) => `${t.date}|${t.symbol}|${t.side}|${t.qty}|${t.price}`;
      const existingCounts = {};
      for (const t of trades) {
        const k = keyOf(t);
        existingCounts[k] = (existingCounts[k] || 0) + 1;
      }
      const merged = [...trades];
      let added = 0;
      for (const t of incoming) {
        const k = keyOf(t);
        const have = existingCounts[k] || 0;
        if (have > 0) { existingCounts[k] = have - 1; } else { merged.push(t); added++; }
      }
      merged.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

      setTrades(merged);
      const now = new Date().toISOString();
      setLastSynced(now);
      const d = new Date(merged[merged.length - 1].date + 'T12:00:00');
      setYear(d.getFullYear());
      setMonth(d.getMonth());

      try { localStorage.setItem('trades-data', JSON.stringify({ trades: merged, lastSynced: now, notes, tradeNotes })); } catch (_) {}
      setShowImport(false);
      setImportText('');
      setImportNote(`Added ${added} new trade${added === 1 ? '' : 's'}${incoming.length - added > 0 ? ` (${incoming.length - added} already in your history)` : ''}.`);
    } catch (e) {
      setError(e.message || 'Could not parse that data');
    }
  }, [trades, notes, tradeNotes]);

  const clearData = useCallback(() => {
    if (!window.confirm('Clear all Robinhood trade data and notes? This cannot be undone.')) return;
    try { localStorage.removeItem('trades-data'); } catch (_) {}
    setTrades([]); setLastSynced(null); setSelectedDay(null);
    setError(null); setImportNote(null); setNotes(''); setTradeNotes({}); setEditingNoteKey(null);
  }, []);

  // Removes just the unmatched (open) quantity of a position's underlying legs,
  // leaving any already-realized portion of those same trades intact.
  const deletePosition = useCallback((position) => {
    if (!window.confirm('Delete this open position? This removes the unmatched quantity from your trade history.')) return;
    setTrades((prev) => {
      const updated = prev
        .map((t, i) => {
          const lot = position.lots.find((l) => l.idx === i);
          if (!lot) return t;
          const newQty = t.qty - lot.qty;
          return newQty > 1e-9 ? { ...t, qty: newQty } : null;
        })
        .filter(Boolean);
      try {
        const raw = localStorage.getItem('trades-data');
        const parsed = raw ? JSON.parse(raw) : {};
        localStorage.setItem('trades-data', JSON.stringify({ ...parsed, trades: updated }));
      } catch (_) {}
      return updated;
    });
  }, []);

  // ── Schwab import (TSV from Excel paste) ─────────────────────────────────────
  const importSchwabTrades = useCallback((rawText) => {
    setError(null);
    try {
      const incoming = parseSchwabTSV(rawText);

      const keyOf = (t) => `${t.symbol}|${t.tradeType}|${t.openDate}|${t.closeDate}|${t.qty}|${t.buyPrice}`;
      const existingKeys = new Set(schwabRealized.map(keyOf));
      const newTrades = incoming.filter(t => !existingKeys.has(keyOf(t)));
      const merged = [...schwabRealized, ...newTrades].sort((a, b) => a.closeDate < b.closeDate ? -1 : 1);

      const updatedNotes = { ...schwabTradeNotes };
      for (const t of newTrades) {
        if (t._note) {
          const nk = `${t.symbol}|${t.openDate}|${t.closeDate}|${t.buyPrice}|${t.sellPrice}`;
          updatedNotes[nk] = t._note;
        }
      }

      setSchwabRealized(merged);
      setSchwabTradeNotes(updatedNotes);

      if (merged.length) {
        const last = merged[merged.length - 1];
        const d = new Date(last.closeDate + 'T12:00:00');
        setYear(d.getFullYear()); setMonth(d.getMonth());
      }

      try { localStorage.setItem('trades-data-schwab', JSON.stringify({ realized: merged, notes: schwabNotes, tradeNotes: updatedNotes })); } catch (_) {}
      setShowSchwabImport(false);
      setSchwabImportText('');
      setImportNote(`Added ${newTrades.length} new trade${newTrades.length === 1 ? '' : 's'}${incoming.length - newTrades.length > 0 ? ` (${incoming.length - newTrades.length} already imported)` : ''}.`);
    } catch (e) {
      setError(e.message || 'Could not parse that data');
    }
  }, [schwabRealized, schwabTradeNotes, schwabNotes]);

  const clearSchwabData = useCallback(() => {
    if (!window.confirm('Clear all Schwab trade data? This cannot be undone.')) return;
    try { localStorage.removeItem('trades-data-schwab'); } catch (_) {}
    setSchwabRealized([]); setSchwabNotes(''); setSchwabTradeNotes({});
    setSelectedDay(null); setError(null); setImportNote(null);
  }, []);

  const switchAccount = useCallback((acct) => {
    setActiveAccount(acct);
    setSelectedDay(null);
    setShowImport(false);
    setShowSchwabImport(false);
    setImportNote(null);
    setError(null);
    const arr = acct === 'robinhood' ? trades : schwabRealized;
    if (arr.length) {
      const last = arr[arr.length - 1];
      const dateStr = acct === 'robinhood' ? last.date : last.closeDate;
      if (dateStr) {
        const d = new Date(dateStr + 'T12:00:00');
        setYear(d.getFullYear()); setMonth(d.getMonth());
      }
    }
  }, [trades, schwabRealized]);

  // ── Derived data ──────────────────────────────────────────────────────────────
  const { realized: rhRealized, openPositions } = useMemo(() => computeRealized(trades), [trades]);

  const realized = useMemo(() =>
    activeAccount === 'robinhood' ? rhRealized : schwabRealized,
    [activeAccount, rhRealized, schwabRealized]
  );

  const activeTradeNotes = activeAccount === 'robinhood' ? tradeNotes : schwabTradeNotes;

  const dayPnl = useMemo(() => {
    const map = {};
    for (const r of realized) {
      if (!map[r.closeDate]) map[r.closeDate] = { pnl: 0, trades: [] };
      map[r.closeDate].pnl += r.pnl;
      map[r.closeDate].trades.push(r);
    }
    return map;
  }, [realized]);

  const stats = useMemo(() => {
    const days = Object.entries(dayPnl);
    const total = days.reduce((s, [, d]) => s + d.pnl, 0);
    const wins = days.filter(([, d]) => d.pnl > 0).length;
    const winRate = days.length ? Math.round((wins / days.length) * 100) : 0;
    let best = null, worst = null;
    for (const [date, d] of days) {
      if (!best || d.pnl > best.pnl) best = { date, pnl: d.pnl };
      if (!worst || d.pnl < worst.pnl) worst = { date, pnl: d.pnl };
    }
    return { total, winRate, best, worst, tradingDays: days.length };
  }, [dayPnl]);

  const avgStats = useMemo(() => {
    const avg = (arr) => arr.length ? arr.reduce((s, r) => s + r.pnl, 0) / arr.length : null;
    const winners = realized.filter((r) => r.pnl > 0);
    const losers  = realized.filter((r) => r.pnl < 0);
    return {
      shWin:   avg(winners.filter((r) => !r.isOption)),
      shLoss:  avg(losers.filter((r) => !r.isOption)),
      optWin:  avg(winners.filter((r) => r.isOption)),
      optLoss: avg(losers.filter((r) => r.isOption)),
    };
  }, [realized]);

  const equityCurve = useMemo(() => {
    const days = Object.entries(dayPnl).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    let cum = 0;
    return days.map(([date, d]) => { cum += d.pnl; return { date: date.slice(5), value: Math.round(cum * 100) / 100 }; });
  }, [dayPnl]);

  const { yMin, yMax, zeroOffset } = useMemo(() => {
    const values = equityCurve.map((d) => d.value);
    const max = Math.max(0, ...values);
    const min = Math.min(0, ...values);
    const offset = max === min ? 1 : max / (max - min);
    return { yMin: min, yMax: max, zeroOffset: Math.min(1, Math.max(0, offset)) };
  }, [equityCurve]);

  const monthlyBreakdown = useMemo(() => {
    const map = {};
    for (const r of realized) {
      const mo = r.closeDate.slice(0, 7);
      if (!map[mo]) map[mo] = { day: 0, swing: 0, dayCount: 0, swingCount: 0 };
      if (r.openDate === r.closeDate) { map[mo].day += r.pnl; map[mo].dayCount += 1; }
      else { map[mo].swing += r.pnl; map[mo].swingCount += 1; }
    }
    return Object.entries(map).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }, [realized]);

  const tickerByMonth = useMemo(() => {
    const map = {};
    for (const r of realized) {
      const monthKey = r.closeDate.slice(0, 7);
      const root = parseOptionSymbol(r.symbol)?.root ?? r.symbol;
      if (!map[monthKey]) map[monthKey] = {};
      if (!map[monthKey][root]) map[monthKey][root] = { pnl: 0, count: 0 };
      map[monthKey][root].pnl += r.pnl;
      map[monthKey][root].count += 1;
    }
    return Object.entries(map)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([key, tickers]) => ({ key, tickers: Object.entries(tickers).sort((a, b) => b[1].pnl - a[1].pnl) }));
  }, [realized]);

  const shiftMonth = (delta) => {
    let m = month + delta, y = year;
    if (m < 0) { m = 11; y--; }
    if (m > 11) { m = 0; y++; }
    setMonth(m); setYear(y);
  };

  const noteKey = (t) => `${t.symbol}|${t.openDate}|${t.closeDate}|${t.buyPrice}|${t.sellPrice}`;

  const saveTradeNote = (key, val) => {
    if (activeAccount === 'robinhood') {
      const updated = { ...tradeNotes, [key]: val };
      if (!val.trim()) delete updated[key];
      setTradeNotes(updated);
      try {
        const raw = localStorage.getItem('trades-data');
        const parsed = raw ? JSON.parse(raw) : {};
        localStorage.setItem('trades-data', JSON.stringify({ ...parsed, tradeNotes: updated }));
      } catch (_) {}
    } else {
      const updated = { ...schwabTradeNotes, [key]: val };
      if (!val.trim()) delete updated[key];
      setSchwabTradeNotes(updated);
      try {
        const raw = localStorage.getItem('trades-data-schwab');
        const parsed = raw ? JSON.parse(raw) : {};
        localStorage.setItem('trades-data-schwab', JSON.stringify({ ...parsed, tradeNotes: updated }));
      } catch (_) {}
    }
  };

  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const maxAbs = Math.max(1, ...Object.values(dayPnl).map((d) => Math.abs(d.pnl)));
  const monthKey = `${year}-${String(month + 1).padStart(2, '0')}`;
  const monthEntry = monthlyBreakdown.find(([key]) => key === monthKey);
  const monthPnl = monthEntry ? monthEntry[1].day + monthEntry[1].swing : null;
  const selectedTrades = selectedDay ? (dayPnl[selectedDay]?.trades || []) : realized.slice().reverse().slice(0, 20);
  const hasData = activeAccount === 'robinhood' ? trades.length > 0 : schwabRealized.length > 0;

  useLayoutEffect(() => {
    const el = calendarRef.current;
    if (!el) return;
    const update = () => setCalHeight(el.offsetHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [year, month, dayPnl]);

  return (
    <div style={{ background: COLORS.bg, color: COLORS.text, fontFamily: SANS, minHeight: 600, padding: 24, borderRadius: 12 }}>
      {/* ── Header ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 16, marginBottom: 24 }}>
        <div>
          <div style={{ fontSize: 11, letterSpacing: 1.5, color: COLORS.dim, textTransform: 'uppercase', marginBottom: 4 }}>
            {activeAccount === 'robinhood' ? 'Robinhood · via SnapTrade' : 'Charles Schwab'}
          </div>
          <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0, letterSpacing: -0.5 }}>Trade Tracker</h1>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {/* Account toggle */}
          <div style={{ display: 'flex', background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: 3, gap: 2 }}>
            {['robinhood', 'schwab'].map(acct => (
              <button key={acct} onClick={() => switchAccount(acct)}
                style={{ background: activeAccount === acct ? COLORS.text : 'none', color: activeAccount === acct ? COLORS.bg : COLORS.muted, border: 'none', borderRadius: 6, padding: '5px 14px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', transition: 'all .15s' }}>
                {acct === 'robinhood' ? 'Robinhood' : 'Schwab'}
              </button>
            ))}
          </div>

          <button onClick={() => setShowBackup(true)}
            style={{ background: 'none', color: COLORS.muted, border: `1px solid ${COLORS.border}`, borderRadius: 6, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
            Backup
          </button>
          {hasData && (
            <button onClick={() => setShowTickerPnl(true)}
              style={{ background: 'none', color: COLORS.muted, border: `1px solid ${COLORS.border}`, borderRadius: 6, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
              P&L by ticker
            </button>
          )}
          {activeAccount === 'robinhood' ? (
            <button onClick={() => { setShowImport(s => !s); setImportNote(null); }}
              style={{ display: 'flex', alignItems: 'center', gap: 8, background: showImport ? COLORS.panel2 : COLORS.text, color: showImport ? COLORS.muted : COLORS.bg, border: `1px solid ${COLORS.border}`, borderRadius: 6, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
              {showImport ? 'Cancel' : 'Import data'}
            </button>
          ) : (
            <button onClick={() => { setShowSchwabImport(s => !s); setImportNote(null); }}
              style={{ display: 'flex', alignItems: 'center', gap: 8, background: showSchwabImport ? COLORS.panel2 : COLORS.text, color: showSchwabImport ? COLORS.muted : COLORS.bg, border: `1px solid ${COLORS.border}`, borderRadius: 6, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
              {showSchwabImport ? 'Cancel' : 'Import trades'}
            </button>
          )}
        </div>
      </div>

      {/* ── Robinhood import panel ── */}
      {activeAccount === 'robinhood' && showImport && (
        <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: 16, marginBottom: 20 }}>
          <div style={{ fontSize: 11, letterSpacing: 1, color: COLORS.dim, textTransform: 'uppercase', marginBottom: 10 }}>Paste trade data</div>
          <div style={{ fontSize: 12, color: COLORS.muted, marginBottom: 10, lineHeight: 1.5 }}>
            Ask Claude in chat for your latest trades, then paste the JSON it gives you here. Format: an array of
            {' '}<code style={{ fontFamily: MONO, color: COLORS.text }}>{'{d,s,n,a,q,p,c}'}</code> objects (date, symbol, description, buy/sell, quantity, price, account).
          </div>
          <textarea value={importText} onChange={(e) => setImportText(e.target.value)}
            placeholder='[{"d":"2026-06-18","s":"AAPL","a":"buy","q":10,"p":195.20,"c":"Individual"}, ...]'
            style={{ width: '100%', minHeight: 110, background: COLORS.bg, color: COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 6, padding: 10, fontSize: 12, fontFamily: MONO, resize: 'vertical', boxSizing: 'border-box' }} />
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button onClick={() => importTrades(importText)} disabled={!importText.trim()}
              style={{ background: COLORS.text, color: COLORS.bg, border: 'none', borderRadius: 6, padding: '7px 14px', fontSize: 12.5, fontWeight: 600, cursor: importText.trim() ? 'pointer' : 'default', opacity: importText.trim() ? 1 : 0.5 }}>
              Load trades
            </button>
          </div>
        </div>
      )}

      {/* ── Schwab import panel ── */}
      {activeAccount === 'schwab' && showSchwabImport && (
        <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: 16, marginBottom: 20 }}>
          <div style={{ fontSize: 11, letterSpacing: 1, color: COLORS.dim, textTransform: 'uppercase', marginBottom: 10 }}>Paste from Excel</div>
          <div style={{ fontSize: 12, color: COLORS.muted, marginBottom: 10, lineHeight: 1.5 }}>
            Select all rows in your trade log (including the header row) and paste here. Columns needed: <code style={{ fontFamily: MONO, color: COLORS.text }}>Ticker, Trade, Expiration, Contracts, Entry Date, Exit Date, Entry Price, Exit Price, Total $ Gain/Loss</code>.
          </div>
          <textarea value={schwabImportText} onChange={(e) => setSchwabImportText(e.target.value)}
            placeholder="Paste Excel rows here (Ctrl+A in your sheet, then Ctrl+C, then paste here)…"
            style={{ width: '100%', minHeight: 120, background: COLORS.bg, color: COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 6, padding: 10, fontSize: 12, fontFamily: MONO, resize: 'vertical', boxSizing: 'border-box' }} />
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button onClick={() => importSchwabTrades(schwabImportText)} disabled={!schwabImportText.trim()}
              style={{ background: COLORS.text, color: COLORS.bg, border: 'none', borderRadius: 6, padding: '7px 14px', fontSize: 12.5, fontWeight: 600, cursor: schwabImportText.trim() ? 'pointer' : 'default', opacity: schwabImportText.trim() ? 1 : 0.5 }}>
              Load trades
            </button>
          </div>
        </div>
      )}

      {error && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', background: 'rgba(240,80,110,0.1)', border: `1px solid ${COLORS.red}`, color: COLORS.red, borderRadius: 8, padding: '10px 14px', marginBottom: 20, fontSize: 13 }}>
          <AlertCircle size={15} /> {error}
        </div>
      )}

      {importNote && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', background: 'rgba(34,197,94,0.1)', border: `1px solid ${COLORS.green}`, color: COLORS.green, borderRadius: 8, padding: '10px 14px', marginBottom: 20, fontSize: 13 }}>
          {importNote}
        </div>
      )}

      {activeAccount === 'robinhood' && lastSynced && (
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', fontSize: 11, color: COLORS.dim, marginBottom: 20, fontFamily: MONO }}>
          <span>Last updated {new Date(lastSynced).toLocaleString()}</span>
          <button onClick={clearData} style={{ background: 'none', border: 'none', color: COLORS.dim, textDecoration: 'underline', cursor: 'pointer', fontSize: 11, fontFamily: MONO, padding: 0 }}>clear data</button>
        </div>
      )}
      {activeAccount === 'schwab' && schwabRealized.length > 0 && (
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', fontSize: 11, color: COLORS.dim, marginBottom: 20, fontFamily: MONO }}>
          <span>{schwabRealized.length} trade{schwabRealized.length === 1 ? '' : 's'} imported</span>
          <button onClick={clearSchwabData} style={{ background: 'none', border: 'none', color: COLORS.dim, textDecoration: 'underline', cursor: 'pointer', fontSize: 11, fontFamily: MONO, padding: 0 }}>clear data</button>
        </div>
      )}

      {!loaded ? (
        <div style={{ textAlign: 'center', padding: 60, color: COLORS.dim }}>Loading…</div>
      ) : !hasData ? (
        <div style={{ textAlign: 'center', padding: '60px 20px', border: `1px dashed ${COLORS.border}`, borderRadius: 12 }}>
          <Activity size={28} color={COLORS.dim} style={{ marginBottom: 12 }} />
          <div style={{ fontSize: 15, marginBottom: 6 }}>No trade data yet</div>
          <div style={{ fontSize: 13, color: COLORS.dim, maxWidth: 360, margin: '0 auto' }}>
            {activeAccount === 'robinhood'
              ? 'Ask Claude in chat for your latest Robinhood trades, then click "Import data" above and paste them in.'
              : 'Click "Import trades" above, then copy your Excel trade log and paste it in.'}
          </div>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 20 }}>
            <StatCard label="Realized P&L" value={fmt(stats.total)} color={stats.total >= 0 ? COLORS.green : COLORS.red} />
            <StatCard label="Win Rate" value={`${stats.winRate}%`} color={COLORS.text} square />
            <StatCard label="Best Day" value={stats.best ? fmt(stats.best.pnl) : '—'} sub={stats.best?.date} color={COLORS.green} />
            <StatCard label="Worst Day" value={stats.worst ? fmt(stats.worst.pnl) : '—'} sub={stats.worst?.date} color={COLORS.red} />
            {activeAccount === 'robinhood' && (
              <StatCard label="Open Positions" value={openPositions.length} color={COLORS.amber} onClick={() => setShowPositions(true)} />
            )}
            <StatCard
              label="Avg Win"
              value={avgStats.shWin != null ? fmt(avgStats.shWin) : avgStats.optWin != null ? fmt(avgStats.optWin) : '—'}
              sub={avgStats.shWin != null && avgStats.optWin != null ? `(opts ${fmt(avgStats.optWin)})` : avgStats.shWin != null ? 'shares only' : avgStats.optWin != null ? 'options only' : null}
              color={COLORS.green}
            />
            <StatCard
              label="Avg Loss"
              value={avgStats.shLoss != null ? fmt(avgStats.shLoss) : avgStats.optLoss != null ? fmt(avgStats.optLoss) : '—'}
              sub={avgStats.shLoss != null && avgStats.optLoss != null ? `(opts ${fmt(avgStats.optLoss)})` : avgStats.shLoss != null ? 'shares only' : avgStats.optLoss != null ? 'options only' : null}
              color={COLORS.red}
            />
          </div>

          <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: '18px 18px 6px', marginBottom: 20 }}>
            <div style={{ fontSize: 11, letterSpacing: 1, color: COLORS.dim, textTransform: 'uppercase', marginBottom: 10 }}>Cumulative P&L</div>
            <ResponsiveContainer width="100%" height={160}>
              <AreaChart data={equityCurve} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
                <defs>
                  <linearGradient id="lineSplit" x1="0" y1="0" x2="0" y2="1">
                    <stop offset={zeroOffset} stopColor={COLORS.green} stopOpacity={1} />
                    <stop offset={zeroOffset} stopColor={COLORS.red} stopOpacity={1} />
                  </linearGradient>
                  <linearGradient id="fillSplit" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor={COLORS.green} stopOpacity={0.35} />
                    <stop offset={zeroOffset} stopColor={COLORS.green} stopOpacity={0.04} />
                    <stop offset={zeroOffset} stopColor={COLORS.red} stopOpacity={0.04} />
                    <stop offset="1" stopColor={COLORS.red} stopOpacity={0.35} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={COLORS.border} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" tick={{ fill: COLORS.dim, fontSize: 10, fontFamily: MONO }} axisLine={{ stroke: COLORS.border }} tickLine={false} />
                <YAxis domain={[yMin, yMax]} tick={{ fill: COLORS.dim, fontSize: 10, fontFamily: MONO }} axisLine={false} tickLine={false} width={56} />
                <ReferenceLine y={0} stroke={COLORS.border} strokeDasharray="2 2" />
                <Tooltip contentStyle={{ background: COLORS.panel2, border: `1px solid ${COLORS.border}`, borderRadius: 6, fontSize: 12, fontFamily: MONO }}
                  labelStyle={{ color: COLORS.muted }} formatter={(v) => [fmt(v), 'P&L']} />
                <Area type="monotone" dataKey="value" stroke="url(#lineSplit)" fill="url(#fillSplit)" strokeWidth={1.75} />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {monthlyBreakdown.length > 0 && <DaySwingCard monthlyBreakdown={monthlyBreakdown} />}

          <div className="tt-grid">
            {/* Calendar */}
            <div ref={calendarRef} style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: 18, alignSelf: 'start' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <button onClick={() => shiftMonth(-1)} style={navBtnStyle}><ChevronLeft size={14} /></button>
                  <div style={{ fontSize: 13, fontWeight: 600, minWidth: 92, textAlign: 'center' }}>{MONTHS[month]} {year}</div>
                  <button onClick={() => shiftMonth(1)} style={navBtnStyle}><ChevronRight size={14} /></button>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <button onClick={() => setCompactCalendar((c) => !c)}
                    title={compactCalendar ? 'Show trade details' : 'Show colors only'}
                    style={{ background: 'none', border: `1px solid ${COLORS.border}`, borderRadius: 6, padding: '4px 7px', display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
                    <span style={{ width: 10, height: 10, borderRadius: 2, background: compactCalendar ? COLORS.text : COLORS.dim, display: 'inline-block' }} />
                  </button>
                  {monthPnl != null && (
                    <div style={{ fontFamily: MONO, fontWeight: 700, fontSize: 13, color: monthPnl >= 0 ? COLORS.green : COLORS.red }}>
                      {fmt(monthPnl)}
                    </div>
                  )}
                </div>
              </div>
              {(() => {
                const weeks = [];
                let week = Array(firstDow).fill(null);
                for (let day = 1; day <= daysInMonth; day++) {
                  week.push(day);
                  if (week.length === 7) { weeks.push(week); week = []; }
                }
                if (week.length) { while (week.length < 7) week.push(null); weeks.push(week); }
                const cellMinHeight = compactCalendar ? 32 : 72;
                return (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 3 }}>
                    {[...DOWS, 'Wk'].map((h, i) => (
                      <div key={i} style={{ fontSize: 10, color: COLORS.dim, textAlign: 'center', padding: '2px 0' }}>{h}</div>
                    ))}
                    {weeks.flatMap((wk, wi) => {
                      const dateStr = (day) => `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                      const wkData = wk.filter(Boolean).map((day) => dayPnl[dateStr(day)]).filter(Boolean);
                      const wkPnl = wkData.reduce((s, d) => s + d.pnl, 0);
                      const wkTrades = wkData.flatMap((d) => d.trades);
                      const wkWinRate = wkTrades.length ? Math.round(wkTrades.filter((t) => t.pnl > 0).length / wkTrades.length * 100) : 0;
                      return [
                        ...wk.map((day, di) => {
                          if (!day) return <div key={`e${wi}-${di}`} />;
                          const ds = dateStr(day);
                          const d = dayPnl[ds];
                          const intensity = d ? Math.min(1, Math.abs(d.pnl) / maxAbs) : 0;
                          const isSel = selectedDay === ds;
                          const base = d ? (d.pnl >= 0 ? COLORS.greenBg : COLORS.redBg) : null;
                          const winRate = d ? Math.round(d.trades.filter((t) => t.pnl > 0).length / d.trades.length * 100) : 0;
                          return (
                            <div key={ds} onClick={() => d && setSelectedDay(isSel ? null : ds)}
                              style={{
                                minHeight: cellMinHeight, borderRadius: 5, padding: '5px 6px', cursor: d ? 'pointer' : 'default',
                                background: base ? `${base}${(0.12 + intensity * 0.55).toFixed(2)})` : 'transparent',
                                border: isSel ? `1.5px solid ${COLORS.amber}` : `1px solid ${COLORS.border}`,
                                display: 'flex', flexDirection: 'column', gap: 1,
                              }}>
                              <span style={{ fontSize: 10, color: COLORS.dim }}>{day}</span>
                              {d && !compactCalendar && <>
                                <span style={{ fontSize: 11, fontFamily: MONO, fontWeight: 700, color: d.pnl >= 0 ? COLORS.green : COLORS.red, marginTop: 3 }}>{fmt(d.pnl)}</span>
                                <span style={{ fontSize: 9.5, color: COLORS.dim, fontFamily: MONO }}>{d.trades.length} trade{d.trades.length === 1 ? '' : 's'}</span>
                                <span style={{ fontSize: 9.5, color: COLORS.dim, fontFamily: MONO }}>{winRate}%</span>
                              </>}
                            </div>
                          );
                        }),
                        wkData.length > 0
                          ? <div key={`ws${wi}`} style={{ minHeight: cellMinHeight, borderRadius: 5, padding: '5px 6px', background: wkPnl >= 0 ? `${COLORS.greenBg}0.08)` : `${COLORS.redBg}0.08)`, border: `1px solid ${COLORS.border}`, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', gap: 3 }}>
                              {!compactCalendar && <>
                                <span style={{ fontSize: 10, fontFamily: MONO, fontWeight: 700, color: wkPnl >= 0 ? COLORS.green : COLORS.red, textAlign: 'center' }}>{fmt(wkPnl)}</span>
                                <span style={{ fontSize: 9, color: COLORS.dim, fontFamily: MONO }}>{wkData.length}d</span>
                                <span style={{ fontSize: 9, color: COLORS.dim, fontFamily: MONO }}>{wkWinRate}%</span>
                              </>}
                            </div>
                          : <div key={`ws${wi}`} style={{ minHeight: cellMinHeight, borderRadius: 5, border: `1px solid ${COLORS.border}` }} />,
                      ];
                    })}
                  </div>
                );
              })()}
            </div>

            {/* Trade list */}
            <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: 18, boxSizing: 'border-box', alignSelf: 'start', height: calHeight ?? undefined, maxHeight: calHeight ?? 360, overflowY: 'auto' }}>
              <div style={{ fontSize: 11, letterSpacing: 1, color: COLORS.dim, textTransform: 'uppercase', marginBottom: 12 }}>
                {selectedDay ? `Trades · ${selectedDay}` : 'Recent realized trades'}
              </div>
              {selectedTrades.length === 0 ? (
                <div style={{ fontSize: 12, color: COLORS.dim }}>No closed trades on this day.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {selectedTrades.map((t, i) => {
                    const label = getTradeDisplayLabel(t);
                    const isContract = isContractTrade(t);
                    const nk = noteKey(t);
                    const hasNote = !!activeTradeNotes[nk];
                    const isEditing = editingNoteKey === nk;
                    return (
                      <div key={i} style={{ borderBottom: `1px solid ${COLORS.border}`, paddingBottom: 8 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 600 }}>
                              {label}{t.account ? <span style={{ fontWeight: 400, color: COLORS.dim }}> ({t.account})</span> : null}
                            </div>
                            <div style={{ fontSize: 10.5, color: COLORS.dim, fontFamily: MONO }}>
                              {t.qty} {isContract ? `contract${t.qty > 1 ? 's' : ''} (×100)` : 'sh'}{t.isShort ? ' short' : ''} · {t.isShort ? `${t.sellPrice.toFixed(2)} → ${t.buyPrice.toFixed(2)}` : `${t.buyPrice.toFixed(2)} → ${t.sellPrice.toFixed(2)}`}
                              {t.openDate !== t.closeDate ? ` · ${t.openDate}→${t.closeDate}` : ''}
                            </div>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <button onClick={() => setEditingNoteKey(isEditing ? null : nk)}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, position: 'relative', color: hasNote ? COLORS.amber : COLORS.dim, display: 'flex', alignItems: 'center' }}>
                              <Pencil size={12} />
                              {hasNote && !isEditing && <span style={{ position: 'absolute', top: 2, right: 2, width: 4, height: 4, borderRadius: '50%', background: COLORS.amber }} />}
                            </button>
                            <div style={{ fontFamily: MONO, fontWeight: 700, fontSize: 13, color: t.pnl >= 0 ? COLORS.green : COLORS.red, display: 'flex', alignItems: 'center', gap: 4 }}>
                              {t.pnl >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                              {fmt(t.pnl)}
                            </div>
                          </div>
                        </div>
                        {isEditing && (
                          <div style={{ marginTop: 8, position: 'relative' }}>
                            <textarea autoFocus value={activeTradeNotes[nk] || ''} onChange={(e) => saveTradeNote(nk, e.target.value)}
                              placeholder="Add a note for this trade…"
                              style={{ width: '100%', background: COLORS.bg, color: COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 5, padding: '7px 28px 7px 9px', fontSize: 12, fontFamily: SANS, resize: 'vertical', boxSizing: 'border-box', minHeight: 60, outline: 'none', lineHeight: 1.5 }} />
                            <button onClick={() => setEditingNoteKey(null)}
                              style={{ position: 'absolute', top: 5, right: 5, background: 'none', border: 'none', color: COLORS.dim, cursor: 'pointer', fontSize: 15, lineHeight: 1, padding: 2 }}>×</button>
                          </div>
                        )}
                        {!isEditing && hasNote && (
                          <div style={{ marginTop: 5, fontSize: 11.5, color: COLORS.muted, lineHeight: 1.5, paddingLeft: 2 }}>
                            {activeTradeNotes[nk]}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      <style>{`
        .tt-grid { display: grid; grid-template-columns: minmax(280px, 1.3fr) minmax(260px, 1fr); gap: 20px; }
        @media (max-width: 680px) { .tt-grid { grid-template-columns: 1fr; } }
      `}</style>

      {/* Open positions modal — Robinhood only */}
      {showPositions && activeAccount === 'robinhood' && (
        <div onClick={() => setShowPositions(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, zIndex: 100 }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 20, width: '100%', maxWidth: 480, maxHeight: '80vh', overflowY: 'auto', fontFamily: SANS, color: COLORS.text }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <div style={{ fontSize: 15, fontWeight: 700 }}>Open Positions</div>
              <button onClick={() => setShowPositions(false)}
                style={{ background: 'none', border: 'none', color: COLORS.dim, cursor: 'pointer', fontSize: 20, lineHeight: 1, padding: 4 }}>×</button>
            </div>
            {openPositions.length === 0 ? (
              <div style={{ fontSize: 13, color: COLORS.dim }}>No open positions - everything's closed out.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {openPositions.slice().sort((a, b) => (a.openDate < b.openDate ? -1 : 1)).map((p, i) => {
                  const opt = parseOptionSymbol(p.symbol);
                  const mult = opt ? 100 : 1;
                  const costBasis = p.avgPrice * p.qty * mult;
                  return (
                    <div key={i} style={{ borderBottom: `1px solid ${COLORS.border}`, paddingBottom: 10 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <div style={{ fontSize: 13.5, fontWeight: 600 }}>
                          {opt ? opt.label : p.symbol}
                          {p.isShort && <span style={{ fontSize: 11, fontWeight: 500, color: COLORS.amber, marginLeft: 6 }}>SHORT</span>}
                          {p.account ? <span style={{ fontWeight: 400, color: COLORS.dim }}> ({p.account})</span> : null}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700 }}>
                            ${costBasis.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </div>
                          <button onClick={() => deletePosition(p)} title="Delete this position"
                            style={{ flexShrink: 0, background: 'none', border: `1px solid ${COLORS.border}`, borderRadius: 6, color: COLORS.red, cursor: 'pointer', padding: '5px 7px', display: 'flex', alignItems: 'center' }}>
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>
                      <div style={{ fontSize: 11, color: COLORS.dim, fontFamily: MONO, marginTop: 2 }}>
                        {p.qty} {opt ? `contract${p.qty > 1 ? 's' : ''} (×100)` : 'sh'}{p.isShort ? ' short' : ''} · avg {p.isShort ? 'credit' : 'cost'} {p.avgPrice.toFixed(2)} · opened {p.openDate}
                      </div>
                    </div>
                  );
                })}
                {(() => {
                  const byAcct = {};
                  for (const p of openPositions) {
                    const key = p.account || 'Unknown';
                    const mult = parseOptionSymbol(p.symbol) ? 100 : 1;
                    byAcct[key] = (byAcct[key] || 0) + p.avgPrice * p.qty * mult;
                  }
                  const acctEntries = Object.entries(byAcct).sort((a, b) => a[0].localeCompare(b[0]));
                  const grandTotal = acctEntries.reduce((s, [, v]) => s + v, 0);
                  return (
                    <div style={{ borderTop: `1px solid ${COLORS.border}`, paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {acctEntries.map(([acct, total]) => (
                        <div key={acct} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <div style={{ fontSize: 11.5, color: COLORS.muted }}>{acct}</div>
                          <div style={{ fontFamily: MONO, fontSize: 13, fontWeight: 600, color: COLORS.text }}>
                            ${total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </div>
                        </div>
                      ))}
                      {acctEntries.length > 1 && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: `1px solid ${COLORS.border}`, paddingTop: 6, marginTop: 2 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: COLORS.muted }}>Total</div>
                          <div style={{ fontFamily: MONO, fontSize: 14, fontWeight: 700, color: COLORS.text }}>
                            ${grandTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}
                <div style={{ fontSize: 11, color: COLORS.dim }}>
                  Cost basis shown, not live market value - this app doesn't have a live price feed.
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {showTickerPnl && (
        <TickerPnlModal tickerByMonth={tickerByMonth} onClose={() => setShowTickerPnl(false)} />
      )}

      {showBackup && (
        <BackupModal onClose={() => setShowBackup(false)} />
      )}

    </div>
  );
}

function TickerPnlModal({ tickerByMonth, onClose }) {
  const ALL = '__all__';
  const [selMonth, setSelMonth] = useState(ALL);

  const tickers = selMonth === ALL
    ? (() => {
        const agg = {};
        for (const { tickers: t } of tickerByMonth)
          for (const [ticker, d] of t) {
            if (!agg[ticker]) agg[ticker] = { pnl: 0, count: 0 };
            agg[ticker].pnl += d.pnl;
            agg[ticker].count += d.count;
          }
        return Object.entries(agg).sort((a, b) => b[1].pnl - a[1].pnl);
      })()
    : (tickerByMonth.find((e) => e.key === selMonth)?.tickers ?? []);

  const total = tickers.reduce((s, [, d]) => s + d.pnl, 0);
  const isAll = selMonth === ALL;
  const maxAbs = Math.max(1, ...tickers.map(([, d]) => Math.abs(d.pnl)));
  const winners = tickers.filter(([, d]) => d.pnl >= 0).length;
  const losers = tickers.length - winners;

  return (
    <div onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 20, width: '100%', maxWidth: 480, maxHeight: '80vh', overflowY: 'auto', fontFamily: SANS, color: COLORS.text }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>P&L by Ticker</div>
            <select value={selMonth} onChange={(e) => setSelMonth(e.target.value)}
              style={{ background: COLORS.panel2, color: COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 5, padding: '3px 8px', fontSize: 12, fontFamily: SANS, cursor: 'pointer', outline: 'none' }}>
              <option value={ALL}>All Time</option>
              {tickerByMonth.map(({ key }) => {
                const [ky, km] = key.split('-');
                return <option key={key} value={key}>{MONTHS[parseInt(km, 10) - 1]} {ky}</option>;
              })}
            </select>
          </div>
          <button onClick={onClose}
            style={{ background: 'none', border: 'none', color: COLORS.dim, cursor: 'pointer', fontSize: 20, lineHeight: 1, padding: 4 }}>×</button>
        </div>
        {tickers.length === 0 ? (
          <div style={{ fontSize: 13, color: COLORS.dim }}>No trades{isAll ? '.' : ' this month.'}</div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 16, fontSize: 11.5, color: COLORS.muted, paddingBottom: 12, marginBottom: 12, borderBottom: `1px solid ${COLORS.border}` }}>
              <span>{tickers.length} ticker{tickers.length === 1 ? '' : 's'}</span>
              <span style={{ color: COLORS.green }}>{winners} winner{winners === 1 ? '' : 's'}</span>
              <span style={{ color: COLORS.red }}>{losers} loser{losers === 1 ? '' : 's'}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
              {tickers.map(([ticker, d]) => {
                const pct = Math.max(2, Math.round((Math.abs(d.pnl) / maxAbs) * 100));
                const barColor = d.pnl >= 0 ? COLORS.green : COLORS.red;
                return (
                  <div key={ticker}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, fontFamily: MONO }}>
                        {ticker} <span style={{ fontWeight: 400, fontSize: 10.5, color: COLORS.dim }}>· {d.count} trade{d.count === 1 ? '' : 's'}</span>
                      </div>
                      <div style={{ fontSize: 13, fontWeight: 700, fontFamily: MONO, color: barColor }}>{fmt(d.pnl)}</div>
                    </div>
                    <div style={{ height: 6, borderRadius: 3, background: COLORS.bg, overflow: 'hidden' }}>
                      <div style={{ width: `${pct}%`, height: '100%', borderRadius: 3, background: barColor }} />
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 14, marginTop: 14, borderTop: `1px solid ${COLORS.border}` }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: COLORS.muted }}>{isAll ? 'Overall total' : 'Month total'}</div>
              <div style={{ fontFamily: MONO, fontSize: 14, fontWeight: 700, color: total >= 0 ? COLORS.green : COLORS.red }}>{fmt(total)}</div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function BackupModal({ onClose }) {
  const [importText, setImportText] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(null);

  const exportJson = useMemo(() => {
    const data = {};
    try { const raw = localStorage.getItem('trades-data'); if (raw) data['trades-data'] = JSON.parse(raw); } catch (_) {}
    try { const raw = localStorage.getItem('trades-data-schwab'); if (raw) data['trades-data-schwab'] = JSON.parse(raw); } catch (_) {}
    return JSON.stringify(data, null, 2);
  }, []);

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(exportJson);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (_) {
      setError('Could not copy automatically — select the text above and copy it manually (Ctrl+A, Ctrl+C).');
    }
  };

  const loadBackup = () => {
    setError(null);
    let parsed;
    try {
      parsed = JSON.parse(importText);
    } catch (_) {
      setError('That doesn’t look like valid JSON.');
      return;
    }
    if (!parsed['trades-data'] && !parsed['trades-data-schwab']) {
      setError('No recognizable trade data found in that JSON.');
      return;
    }
    if (!window.confirm('Load this backup? This will overwrite the trade data currently stored here.')) return;
    try {
      if (parsed['trades-data']) localStorage.setItem('trades-data', JSON.stringify(parsed['trades-data']));
      if (parsed['trades-data-schwab']) localStorage.setItem('trades-data-schwab', JSON.stringify(parsed['trades-data-schwab']));
      window.location.reload();
    } catch (_) {
      setError('Could not save that backup to this browser.');
    }
  };

  return (
    <div onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 20, width: '100%', maxWidth: 560, maxHeight: '85vh', overflowY: 'auto', fontFamily: SANS, color: COLORS.text }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>Backup &amp; Restore</div>
          <button onClick={onClose}
            style={{ background: 'none', border: 'none', color: COLORS.dim, cursor: 'pointer', fontSize: 20, lineHeight: 1, padding: 4 }}>×</button>
        </div>

        <div style={{ fontSize: 11, letterSpacing: 1, color: COLORS.dim, textTransform: 'uppercase', marginBottom: 8 }}>Export</div>
        <div style={{ fontSize: 12, color: COLORS.muted, marginBottom: 10, lineHeight: 1.5 }}>
          Copy this and paste it into the app running elsewhere (another localhost, a Netlify deploy, etc.) to bring your trades and notes with you.
        </div>
        <textarea readOnly value={exportJson} onClick={(e) => e.target.select()}
          style={{ width: '100%', height: 130, background: COLORS.bg, color: COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 6, padding: 10, fontSize: 11.5, fontFamily: MONO, resize: 'vertical', boxSizing: 'border-box', marginBottom: 10 }} />
        <button onClick={copyToClipboard}
          style={{ background: COLORS.text, color: COLORS.bg, border: 'none', borderRadius: 6, padding: '7px 14px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
          {copied ? 'Copied!' : 'Copy to clipboard'}
        </button>

        <div style={{ fontSize: 11, letterSpacing: 1, color: COLORS.dim, textTransform: 'uppercase', margin: '20px 0 8px' }}>Import</div>
        <div style={{ fontSize: 12, color: COLORS.muted, marginBottom: 10, lineHeight: 1.5 }}>
          Paste a backup copied from another instance, then load it. This overwrites the data stored in this browser.
        </div>
        <textarea value={importText} onChange={(e) => setImportText(e.target.value)}
          placeholder="Paste backup JSON here…"
          style={{ width: '100%', height: 130, background: COLORS.bg, color: COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 6, padding: 10, fontSize: 11.5, fontFamily: MONO, resize: 'vertical', boxSizing: 'border-box', marginBottom: 10 }} />
        {error && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', background: 'rgba(240,80,110,0.1)', border: `1px solid ${COLORS.red}`, color: COLORS.red, borderRadius: 8, padding: '10px 14px', marginBottom: 10, fontSize: 13 }}>
            <AlertCircle size={15} /> {error}
          </div>
        )}
        <button onClick={loadBackup} disabled={!importText.trim()}
          style={{ background: COLORS.text, color: COLORS.bg, border: 'none', borderRadius: 6, padding: '7px 14px', fontSize: 12.5, fontWeight: 600, cursor: importText.trim() ? 'pointer' : 'default', opacity: importText.trim() ? 1 : 0.5 }}>
          Load backup
        </button>
      </div>
    </div>
  );
}

function DaySwingCard({ monthlyBreakdown }) {
  const years = useMemo(() => [...new Set(monthlyBreakdown.map(([key]) => key.slice(0, 4)))], [monthlyBreakdown]);
  const yearTotals = useMemo(() => {
    const map = {};
    for (const [key, d] of monthlyBreakdown) {
      const y = key.slice(0, 4);
      if (!map[y]) map[y] = { day: 0, swing: 0, dayCount: 0, swingCount: 0 };
      map[y].day += d.day; map[y].swing += d.swing;
      map[y].dayCount += d.dayCount; map[y].swingCount += d.swingCount;
    }
    return map;
  }, [monthlyBreakdown]);

  const [selectedMonth, setSelectedMonth] = useState(monthlyBreakdown[monthlyBreakdown.length - 1][0]);
  const isYear = selectedMonth.startsWith('Y:');
  const d = isYear ? yearTotals[selectedMonth.slice(2)] : (monthlyBreakdown.find(([m]) => m === selectedMonth)?.[1] ?? null);
  return (
    <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: '12px 16px', marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ fontSize: 11, letterSpacing: 1, color: COLORS.dim, textTransform: 'uppercase' }}>Day vs Swing</div>
        <select value={selectedMonth} onChange={(e) => setSelectedMonth(e.target.value)}
          style={{ background: COLORS.panel2, color: COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 5, padding: '3px 8px', fontSize: 12, fontFamily: SANS, cursor: 'pointer', outline: 'none' }}>
          {years.map((y) => (
            <optgroup key={y} label={y}>
              <option value={`Y:${y}`}>{y} Total</option>
              {monthlyBreakdown.filter(([key]) => key.startsWith(y)).map(([key]) => {
                const [ky, km] = key.split('-');
                return <option key={key} value={key}>{MONTHS[parseInt(km, 10) - 1]} {ky}</option>;
              })}
            </optgroup>
          ))}
        </select>
      </div>
      {d && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          <div style={{ background: COLORS.bg, borderRadius: 7, padding: '10px 12px' }}>
            <div style={{ fontSize: 10, color: COLORS.dim, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Day trades</div>
            <div style={{ fontFamily: MONO, fontSize: 15, fontWeight: 700, color: d.day >= 0 ? COLORS.green : COLORS.red }}>{fmt(d.day)}</div>
            <div style={{ fontSize: 10, color: COLORS.dim, fontFamily: MONO, marginTop: 2 }}>{d.dayCount} trade{d.dayCount === 1 ? '' : 's'}</div>
          </div>
          <div style={{ background: COLORS.bg, borderRadius: 7, padding: '10px 12px' }}>
            <div style={{ fontSize: 10, color: COLORS.dim, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Swing trades</div>
            <div style={{ fontFamily: MONO, fontSize: 15, fontWeight: 700, color: d.swing >= 0 ? COLORS.green : COLORS.red }}>{fmt(d.swing)}</div>
            <div style={{ fontSize: 10, color: COLORS.dim, fontFamily: MONO, marginTop: 2 }}>{d.swingCount} trade{d.swingCount === 1 ? '' : 's'}</div>
          </div>
          <div style={{ background: COLORS.bg, borderRadius: 7, padding: '10px 12px', borderLeft: `1px solid ${COLORS.border}` }}>
            <div style={{ fontSize: 10, color: COLORS.dim, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Total</div>
            <div style={{ fontFamily: MONO, fontSize: 15, fontWeight: 700, color: (d.day + d.swing) >= 0 ? COLORS.green : COLORS.red }}>{fmt(d.day + d.swing)}</div>
            <div style={{ fontSize: 10, color: COLORS.dim, fontFamily: MONO, marginTop: 2 }}>{d.dayCount + d.swingCount} trade{d.dayCount + d.swingCount === 1 ? '' : 's'}</div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, sub, color, onClick, square }) {
  return (
    <div onClick={onClick}
      style={{
        background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: '10px 12px',
        cursor: onClick ? 'pointer' : 'default', transition: 'border-color .15s', boxSizing: 'border-box',
        ...(square ? { width: 82, height: 82, flexShrink: 0, flexGrow: 0 } : { flex: '1 1 100px' }),
      }}
      onMouseEnter={(e) => { if (onClick) e.currentTarget.style.borderColor = COLORS.amber; }}
      onMouseLeave={(e) => { if (onClick) e.currentTarget.style.borderColor = COLORS.border; }}>
      <div style={{ fontSize: 9.5, color: COLORS.dim, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 5 }}>{label}</div>
      <div style={{ fontSize: 16.5, fontWeight: 700, fontFamily: MONO, color }}>{value}</div>
      {sub && <div style={{ fontSize: 9.5, color: COLORS.dim, marginTop: 2, fontFamily: MONO }}>{sub}</div>}
    </div>
  );
}

const navBtnStyle = { background: 'none', border: `1px solid ${COLORS.border}`, borderRadius: 6, color: COLORS.muted, padding: '4px 7px', display: 'flex', alignItems: 'center', cursor: 'pointer' };
