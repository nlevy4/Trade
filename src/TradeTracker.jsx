import { useState, useEffect, useMemo, useCallback, useRef, useLayoutEffect } from "react";
import { TrendingUp, TrendingDown, ChevronLeft, ChevronRight, AlertCircle, Activity, Pencil, Trash2, SquarePen, Download } from "lucide-react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from "recharts";
import { APP_VERSION } from "./version";

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

// Builds a realized-trade row for one matched (lot, closing-transaction) pair.
// isShort true means covering a short (txn is the buy, lot is the short-open sell).
function closeLot(lot, txn, matched, mult, isShort) {
  return {
    symbol: txn.symbol, desc: txn.desc, qty: matched,
    buyPrice: isShort ? txn.price : lot.price,
    sellPrice: isShort ? lot.price : txn.price,
    openDate: lot.date, closeDate: txn.date,
    pnl: (isShort ? lot.price - txn.price : txn.price - lot.price) * matched * mult,
    isOption: mult === 100, isShort,
    account: lot.account || txn.account,
    legs: [{ idx: txn._idx, qty: matched }, { idx: lot.idx, qty: matched }],
  };
}

// Removes and returns the queue entry matching a manually-picked lot
// (identified by its open date + price, since that survives array edits
// better than a positional index), or null if there's no such lot anymore.
function takeTargetedLot(queue, targetDate, targetPrice) {
  if (targetDate == null || targetPrice == null) return null;
  const pos = queue.findIndex((l) => l.date === targetDate && Math.abs(l.price - targetPrice) < 1e-6);
  if (pos === -1) return null;
  return { lot: queue[pos], pos };
}

// FIFO-match buy/sell legs per symbol. Handles both long trades (buy→sell)
// and short trades like sold puts (sell→buy). Each direction uses its own lot
// queue. A sell (or buy-to-close) can pin itself to a specific lot via
// targetLotDate/targetLotPrice — set from the manual-trade lot picker — to
// support cases like "sell against the lower-cost tax lot", ahead of FIFO.
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
        const targeted = takeTargetedLot(shortLots[key], t.targetLotDate, t.targetLotPrice);
        if (targeted) {
          const { lot, pos } = targeted;
          const matched = Math.min(remaining, lot.qty);
          realized.push(closeLot(lot, t, matched, mult, true));
          lot.qty -= matched;
          remaining -= matched;
          if (lot.qty <= 1e-9) shortLots[key].splice(pos, 1);
        }
        while (remaining > 1e-9 && shortLots[key].length) {
          const lot = shortLots[key][0];
          const matched = Math.min(remaining, lot.qty);
          realized.push(closeLot(lot, t, matched, mult, true));
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
        const targeted = takeTargetedLot(longLots[key], t.targetLotDate, t.targetLotPrice);
        if (targeted) {
          const { lot, pos } = targeted;
          const matched = Math.min(remaining, lot.qty);
          realized.push(closeLot(lot, t, matched, mult, false));
          lot.qty -= matched;
          remaining -= matched;
          if (lot.qty <= 1e-9) longLots[key].splice(pos, 1);
        }
        while (remaining > 1e-9 && longLots[key].length) {
          const lot = longLots[key][0];
          const matched = Math.min(remaining, lot.qty);
          realized.push(closeLot(lot, t, matched, mult, false));
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
      lots: remaining.map((l) => ({ idx: l.idx, qty: l.qty, price: l.price, date: l.date })),
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
      lots: remaining.map((l) => ({ idx: l.idx, qty: l.qty, price: l.price, date: l.date })),
    });
  }

  // Group legs closed at the same price on the same day (e.g. one sell filled
  // against several buy lots at different prices, or several same-priced sell
  // fills logged as separate records) into a single row with a qty-weighted
  // avg entry price, instead of one row per matched lot/fill. Shares only —
  // options (esp. 0DTE, which often have several distinct same-day trades at
  // the same fill price) are kept as separate rows.
  const groups = new Map();
  realized.forEach((r, i) => {
    const closePrice = r.isShort ? r.buyPrice : r.sellPrice;
    const key = r.isOption ? `opt-${i}` : `${r.symbol}|${r.account}|${r.closeDate}|${closePrice}|${r.isShort}`;
    let g = groups.get(key);
    if (!g) {
      g = { ...r, buyNotional: r.buyPrice * r.qty, sellNotional: r.sellPrice * r.qty, legs: [...r.legs] };
      groups.set(key, g);
    } else {
      g.qty += r.qty;
      g.pnl += r.pnl;
      g.buyNotional += r.buyPrice * r.qty;
      g.sellNotional += r.sellPrice * r.qty;
      g.legs.push(...r.legs);
      if (r.openDate < g.openDate) g.openDate = r.openDate;
    }
  });
  const coalesced = [...groups.values()].map((g) => {
    const { buyNotional, sellNotional, ...rest } = g;
    return { ...rest, buyPrice: buyNotional / g.qty, sellPrice: sellNotional / g.qty };
  });

  return { realized: coalesced, openPositions };
}

// A realized row can only be safely hand-edited when it maps 1:1 onto a single
// underlying buy and a single sell (not merged/split across several lots) —
// otherwise there's no unambiguous underlying trade to write the edit back to.
// Returns the raw trades-array indices to update, or null if not editable.
function simpleTradeLegs(t) {
  if (!t.legs || t.legs.length !== 2) return null;
  const [a, b] = t.legs;
  if (a.idx === b.idx || a.qty !== t.qty || b.qty !== t.qty) return null;
  return t.isShort ? { buyIdx: a.idx, sellIdx: b.idx } : { buyIdx: b.idx, sellIdx: a.idx };
}

function csvValue(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
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
  const open = [];
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

    if (!ticker || qty <= 0 || !openDate) continue;

    if (!closeDate) {
      // No exit yet — still an open position, not a realized round-trip.
      if (buyPrice <= 0) continue;
      open.push({
        symbol: ticker, tradeType, expiration, qty, buyPrice, openDate,
        account: 'Schwab', desc: '',
      });
      continue;
    }

    result.push({
      symbol: ticker, tradeType, expiration,
      qty, buyPrice, sellPrice, openDate, closeDate, pnl,
      isOption: tradeType.toLowerCase() !== 'shares',
      account: 'Schwab', desc: '', _note: noteVal,
    });
  }

  if (!result.length && !open.length)
    throw new Error('No valid trades found — check that Ticker, Entry Date, Contracts, and Entry Price columns are present (Exit Date/Price/Total $ only needed for closed trades)');

  return { realized: result, open };
}

export default function TradeTracker() {
  // ── Robinhood state ──────────────────────────────────────────────────────────
  const [trades, setTrades] = useState([]);
  const [lastSynced, setLastSynced] = useState(null);
  const [notes, setNotes] = useState('');
  const [tradeNotes, setTradeNotes] = useState({});

  // ── Schwab state ─────────────────────────────────────────────────────────────
  const [schwabRealized, setSchwabRealized] = useState([]);
  const [schwabOpen, setSchwabOpen] = useState([]);
  const [schwabNotes, setSchwabNotes] = useState('');
  const [schwabTradeNotes, setSchwabTradeNotes] = useState({});
  const [schwabImportText, setSchwabImportText] = useState('');
  const [showSchwabImport, setShowSchwabImport] = useState(false);
  const [manualSchwabSymbol, setManualSchwabSymbol] = useState('');
  const [manualSchwabType, setManualSchwabType] = useState('shares');
  const [manualSchwabExpiration, setManualSchwabExpiration] = useState('');
  const [manualSchwabQty, setManualSchwabQty] = useState('');
  const [manualSchwabBuyPrice, setManualSchwabBuyPrice] = useState('');
  const [manualSchwabSellPrice, setManualSchwabSellPrice] = useState('');
  const [manualSchwabOpenDate, setManualSchwabOpenDate] = useState('');
  const [manualSchwabCloseDate, setManualSchwabCloseDate] = useState('');
  const [manualSchwabPnl, setManualSchwabPnl] = useState('');
  const [manualSchwabMode, setManualSchwabMode] = useState('closed'); // 'closed' | 'open' | 'split'
  const [manualSchwabSplitSells, setManualSchwabSplitSells] = useState([{ qty: '', price: '', date: '' }]);

  // ── Shared UI state ──────────────────────────────────────────────────────────
  const [activeAccount, setActiveAccount] = useState('robinhood');
  const [error, setError] = useState(null);
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState('');
  const [importNote, setImportNote] = useState(null);
  const [showManualTrade, setShowManualTrade] = useState(false);
  const [manualSymbol, setManualSymbol] = useState('');
  const [manualSide, setManualSide] = useState('buy');
  const [manualQty, setManualQty] = useState('');
  const [manualPrice, setManualPrice] = useState('');
  const [manualDate, setManualDate] = useState('');
  const [manualAccount, setManualAccount] = useState('Individual');
  const [manualDesc, setManualDesc] = useState('');
  const [manualTargetLot, setManualTargetLot] = useState('');
  const [manualSplitMode, setManualSplitMode] = useState(false);
  const [manualSplitSells, setManualSplitSells] = useState([{ qty: '', price: '', date: '' }]);
  const [showPositions, setShowPositions] = useState(false);
  const [showTickerPnl, setShowTickerPnl] = useState(false);
  const [showBackup, setShowBackup] = useState(false);
  const [compactCalendar, setCompactCalendar] = useState(false);
  const [editingNoteKey, setEditingNoteKey] = useState(null);
  const [editingTrade, setEditingTrade] = useState(null);
  const [chartAccount, setChartAccount] = useState('all');
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
          // Schwab is a single account — collapse any stray account labels
          // (e.g. old manual entries defaulted to "Individual") down to one.
          const realized = (parsed.realized || []).map((t) => ({ ...t, account: 'Schwab' }));
          const open = (parsed.open || []).map((t) => ({ ...t, account: 'Schwab' }));
          setSchwabRealized(realized);
          setSchwabOpen(open);
          setSchwabNotes(parsed.notes || '');
          setSchwabTradeNotes(parsed.tradeNotes || {});
          try { localStorage.setItem('trades-data-schwab', JSON.stringify({ ...parsed, realized, open })); } catch (_) {}
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

  // Fixes a position that shows as short only because its opening buy(s)
  // are missing from the imported history (the sell had no long lot to
  // match against). Inserts a synthetic buy dated the same day, placed
  // *before* the sell in trade order so FIFO matches it as a normal long
  // instead of leaving it open-short.
  const convertShortToLong = useCallback((position) => {
    const priceStr = window.prompt(
      `What price did you actually buy the ${position.qty} share${position.qty === 1 ? '' : 's'} of ${position.symbol} at?\n\nThis adds the missing buy so it FIFO-matches as a normal long instead of a short.`
    );
    if (priceStr == null) return;
    const price = parseFloat(priceStr);
    if (!(price > 0)) {
      window.alert('Enter a positive price.');
      return;
    }
    const newTrade = {
      date: position.openDate, symbol: position.symbol, desc: '', side: 'buy',
      qty: position.qty, price, account: position.account,
    };
    const merged = [newTrade, ...trades].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    setTrades(merged);
    const now = new Date().toISOString();
    setLastSynced(now);
    try { localStorage.setItem('trades-data', JSON.stringify({ trades: merged, lastSynced: now, notes, tradeNotes })); } catch (_) {}
    setImportNote('Position reclassified as a long.');
  }, [trades, notes, tradeNotes]);

  // Adds a single hand-entered trade. A sell can pin itself to a specific
  // open lot (picked in the UI below) via targetLotDate/targetLotPrice, so it
  // matches against that lot instead of always taking the oldest one (FIFO).
  const addManualTrade = useCallback(() => {
    setError(null);
    const symbol = manualSymbol.trim().toUpperCase();
    const qty = parseFloat(manualQty);
    const price = parseFloat(manualPrice);
    const account = manualAccount.trim() || 'Individual';
    if (!symbol || !manualDate || !(qty > 0) || !(price > 0)) {
      setError('Fill in symbol, date, a positive quantity, and a positive price.');
      return;
    }
    let targetLotDate = null, targetLotPrice = null;
    if (manualSide === 'sell' && manualTargetLot) {
      const [d, p] = manualTargetLot.split('|');
      targetLotDate = d;
      targetLotPrice = Number(p);
    }
    const newTrade = {
      date: manualDate, symbol, desc: manualDesc.trim(), side: manualSide, qty, price, account,
      ...(targetLotDate ? { targetLotDate, targetLotPrice } : {}),
    };
    const merged = [...trades, newTrade].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    setTrades(merged);
    const now = new Date().toISOString();
    setLastSynced(now);
    const d = new Date(merged[merged.length - 1].date + 'T12:00:00');
    setYear(d.getFullYear());
    setMonth(d.getMonth());
    try { localStorage.setItem('trades-data', JSON.stringify({ trades: merged, lastSynced: now, notes, tradeNotes })); } catch (_) {}
    setShowManualTrade(false);
    setManualSymbol(''); setManualQty(''); setManualPrice(''); setManualDesc(''); setManualTargetLot('');
    setImportNote('Trade added.');
  }, [manualSymbol, manualSide, manualQty, manualPrice, manualDate, manualAccount, manualDesc, manualTargetLot, trades, notes, tradeNotes]);

  // Adds one buy plus several sell legs against it in a single submit (e.g.
  // buy 4 @ 3.30, then sell 1 @ 3.50, 1 on 3/7, 1 on 3/9). The buy is placed
  // before the sells in trade order so same-day ties FIFO-match correctly;
  // any unsold remainder is left open, same as adding the legs one at a time.
  const addManualSplitTrade = useCallback(() => {
    setError(null);
    const symbol = manualSymbol.trim().toUpperCase();
    const qty = parseFloat(manualQty);
    const price = parseFloat(manualPrice);
    const account = manualAccount.trim() || 'Individual';
    if (!symbol || !manualDate || !(qty > 0) || !(price > 0)) {
      setError('Fill in symbol, date, a positive quantity, and a positive price for the buy.');
      return;
    }
    const sellRows = manualSplitSells.filter((r) => r.qty || r.price || r.date);
    if (!sellRows.length) {
      setError('Add at least one sell row.');
      return;
    }
    for (const r of sellRows) {
      if (!(parseFloat(r.qty) > 0) || !(parseFloat(r.price) > 0) || !r.date) {
        setError('Each sell row needs a positive quantity, a positive price, and a date.');
        return;
      }
    }
    const desc = manualDesc.trim();
    const newTrades = [
      { date: manualDate, symbol, desc, side: 'buy', qty, price, account },
      ...sellRows.map((r) => ({ date: r.date, symbol, desc, side: 'sell', qty: parseFloat(r.qty), price: parseFloat(r.price), account })),
    ];
    const merged = [...trades, ...newTrades].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    setTrades(merged);
    const now = new Date().toISOString();
    setLastSynced(now);
    const last = merged[merged.length - 1];
    const d = new Date(last.date + 'T12:00:00');
    setYear(d.getFullYear());
    setMonth(d.getMonth());
    try { localStorage.setItem('trades-data', JSON.stringify({ trades: merged, lastSynced: now, notes, tradeNotes })); } catch (_) {}
    setShowManualTrade(false);
    setManualSymbol(''); setManualQty(''); setManualPrice(''); setManualDesc('');
    setManualSplitMode(false); setManualSplitSells([{ qty: '', price: '', date: '' }]);
    setImportNote(`Added ${newTrades.length} trades.`);
  }, [manualSymbol, manualQty, manualPrice, manualDate, manualAccount, manualDesc, manualSplitSells, trades, notes, tradeNotes]);

  // Suggested P&L for a manual Schwab entry, used to prefill the field —
  // real fills can differ (commissions, multi-leg spreads) so it stays editable.
  const manualSchwabAutoPnl = useMemo(() => {
    const q = parseFloat(manualSchwabQty), bp = parseFloat(manualSchwabBuyPrice), sp = parseFloat(manualSchwabSellPrice);
    if (!(q > 0) || !(bp > 0) || !(sp > 0)) return null;
    const mult = manualSchwabType.trim().toLowerCase() !== 'shares' ? 100 : 1;
    return (sp - bp) * q * mult;
  }, [manualSchwabQty, manualSchwabBuyPrice, manualSchwabSellPrice, manualSchwabType]);

  // Adds a single hand-entered, already-closed Schwab trade (Schwab data is
  // stored as realized round-trips, unlike Robinhood's open buy/sell legs).
  const addManualSchwabTrade = useCallback(() => {
    setError(null);
    const symbol = manualSchwabSymbol.trim().toUpperCase();
    const qty = parseFloat(manualSchwabQty);
    const buyPrice = parseFloat(manualSchwabBuyPrice);
    const sellPrice = parseFloat(manualSchwabSellPrice);
    const pnl = manualSchwabPnl.trim() === '' ? manualSchwabAutoPnl : parseFloat(manualSchwabPnl);
    if (!symbol || !manualSchwabOpenDate || !manualSchwabCloseDate || !(qty > 0) || !(buyPrice > 0) || !(sellPrice > 0) || pnl == null || Number.isNaN(pnl)) {
      setError('Fill in symbol, both dates, a positive quantity, and positive buy/sell prices.');
      return;
    }
    const tradeType = manualSchwabType.trim() || 'shares';
    const newTrade = {
      symbol, tradeType, expiration: manualSchwabExpiration.trim(),
      qty, buyPrice, sellPrice, openDate: manualSchwabOpenDate, closeDate: manualSchwabCloseDate, pnl,
      isOption: tradeType.toLowerCase() !== 'shares',
      account: 'Schwab', desc: '',
    };
    const merged = [...schwabRealized, newTrade].sort((a, b) => (a.closeDate < b.closeDate ? -1 : 1));
    setSchwabRealized(merged);
    const d = new Date(newTrade.closeDate + 'T12:00:00');
    setYear(d.getFullYear());
    setMonth(d.getMonth());
    try { localStorage.setItem('trades-data-schwab', JSON.stringify({ realized: merged, notes: schwabNotes, tradeNotes: schwabTradeNotes })); } catch (_) {}
    setShowManualTrade(false);
    setManualSchwabSymbol(''); setManualSchwabExpiration(''); setManualSchwabQty('');
    setManualSchwabBuyPrice(''); setManualSchwabSellPrice(''); setManualSchwabPnl('');
    setImportNote('Trade added.');
  }, [manualSchwabSymbol, manualSchwabType, manualSchwabExpiration, manualSchwabQty, manualSchwabBuyPrice, manualSchwabSellPrice, manualSchwabOpenDate, manualSchwabCloseDate, manualSchwabPnl, manualSchwabAutoPnl, schwabRealized, schwabNotes, schwabTradeNotes]);

  // Adds a hand-entered Schwab position that hasn't been closed yet — no
  // sell price/close date/P&L, since none of that exists until it's exited.
  const addManualSchwabOpenPosition = useCallback(() => {
    setError(null);
    const symbol = manualSchwabSymbol.trim().toUpperCase();
    const qty = parseFloat(manualSchwabQty);
    const buyPrice = parseFloat(manualSchwabBuyPrice);
    if (!symbol || !manualSchwabOpenDate || !(qty > 0) || !(buyPrice > 0)) {
      setError('Fill in symbol, open date, a positive quantity, and a positive buy price.');
      return;
    }
    const tradeType = manualSchwabType.trim() || 'shares';
    const newPos = {
      symbol, tradeType, expiration: manualSchwabExpiration.trim(),
      qty, buyPrice, openDate: manualSchwabOpenDate,
      account: 'Schwab', desc: '',
    };
    const merged = [...schwabOpen, newPos].sort((a, b) => (a.openDate < b.openDate ? -1 : 1));
    setSchwabOpen(merged);
    const d = new Date(newPos.openDate + 'T12:00:00');
    setYear(d.getFullYear());
    setMonth(d.getMonth());
    try { localStorage.setItem('trades-data-schwab', JSON.stringify({ realized: schwabRealized, open: merged, notes: schwabNotes, tradeNotes: schwabTradeNotes })); } catch (_) {}
    setShowManualTrade(false);
    setManualSchwabSymbol(''); setManualSchwabExpiration(''); setManualSchwabQty(''); setManualSchwabBuyPrice('');
    setImportNote('Open position added.');
  }, [manualSchwabSymbol, manualSchwabType, manualSchwabExpiration, manualSchwabQty, manualSchwabBuyPrice, manualSchwabOpenDate, schwabOpen, schwabRealized, schwabNotes, schwabTradeNotes]);

  // Adds one buy closed out across several sell rows (e.g. buy 4 @ 3.30,
  // sell 1 @ 3.50, 1 on 3/7, 1 on 3/9) — one closed round-trip row per sell,
  // all sharing the same buy price/date. Schwab has no shared lot pool like
  // Robinhood, so any unsold remainder is added to schwabOpen explicitly.
  const addManualSchwabSplitTrades = useCallback(() => {
    setError(null);
    const symbol = manualSchwabSymbol.trim().toUpperCase();
    const qty = parseFloat(manualSchwabQty);
    const buyPrice = parseFloat(manualSchwabBuyPrice);
    if (!symbol || !manualSchwabOpenDate || !(qty > 0) || !(buyPrice > 0)) {
      setError('Fill in symbol, open date, a positive buy quantity, and a positive buy price.');
      return;
    }
    const sellRows = manualSchwabSplitSells.filter((r) => r.qty || r.price || r.date);
    if (!sellRows.length) {
      setError('Add at least one sell row.');
      return;
    }
    for (const r of sellRows) {
      if (!(parseFloat(r.qty) > 0) || !(parseFloat(r.price) > 0) || !r.date) {
        setError('Each sell row needs a positive quantity, a positive price, and a close date.');
        return;
      }
    }
    const soldQty = sellRows.reduce((s, r) => s + parseFloat(r.qty), 0);
    if (soldQty - qty > 1e-9) {
      setError(`Sell rows total ${soldQty} shares/contracts, more than the ${qty} bought.`);
      return;
    }
    const tradeType = manualSchwabType.trim() || 'shares';
    const expiration = manualSchwabExpiration.trim();
    const account = 'Schwab';
    const mult = tradeType.toLowerCase() !== 'shares' ? 100 : 1;
    const newTrades = sellRows.map((r) => {
      const rQty = parseFloat(r.qty), rPrice = parseFloat(r.price);
      return {
        symbol, tradeType, expiration, qty: rQty, buyPrice, sellPrice: rPrice,
        openDate: manualSchwabOpenDate, closeDate: r.date, pnl: (rPrice - buyPrice) * rQty * mult,
        isOption: tradeType.toLowerCase() !== 'shares', account, desc: '',
      };
    });
    const mergedRealized = [...schwabRealized, ...newTrades].sort((a, b) => (a.closeDate < b.closeDate ? -1 : 1));
    setSchwabRealized(mergedRealized);

    const remainder = qty - soldQty;
    let mergedOpen = schwabOpen;
    if (remainder > 1e-9) {
      const openPos = { symbol, tradeType, expiration, qty: remainder, buyPrice, openDate: manualSchwabOpenDate, account, desc: '' };
      mergedOpen = [...schwabOpen, openPos].sort((a, b) => (a.openDate < b.openDate ? -1 : 1));
      setSchwabOpen(mergedOpen);
    }

    const lastClose = newTrades.reduce((max, t) => (t.closeDate > max ? t.closeDate : max), newTrades[0].closeDate);
    const d = new Date(lastClose + 'T12:00:00');
    setYear(d.getFullYear());
    setMonth(d.getMonth());
    try { localStorage.setItem('trades-data-schwab', JSON.stringify({ realized: mergedRealized, open: mergedOpen, notes: schwabNotes, tradeNotes: schwabTradeNotes })); } catch (_) {}
    setShowManualTrade(false);
    setManualSchwabSymbol(''); setManualSchwabExpiration(''); setManualSchwabQty(''); setManualSchwabBuyPrice('');
    setManualSchwabMode('closed'); setManualSchwabSplitSells([{ qty: '', price: '', date: '' }]);
    setImportNote(`Added ${newTrades.length} trade${newTrades.length === 1 ? '' : 's'}${remainder > 1e-9 ? ' (1 position left open)' : ''}.`);
  }, [manualSchwabSymbol, manualSchwabType, manualSchwabExpiration, manualSchwabQty, manualSchwabBuyPrice, manualSchwabOpenDate, manualSchwabSplitSells, schwabRealized, schwabOpen, schwabNotes, schwabTradeNotes]);

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

  // Sells (or buys-to-cover, for a short) part or all of an open Robinhood
  // position directly from the Open Positions modal — same quick-trim
  // shortcut as Schwab's, without reopening the manual-trade form and
  // retyping the symbol/account. FIFO handles matching against the
  // position's lot(s) same as any other manually-entered trade.
  const trimRobinhoodPosition = useCallback((position) => {
    const opt = parseOptionSymbol(position.symbol);
    const label = opt ? opt.label : position.symbol;
    const unit = opt ? 'contracts' : 'shares';
    const action = position.isShort ? 'Buy to cover' : 'Sell';
    const qtyStr = window.prompt(`${action} how many of the ${position.qty} ${unit} of ${label}?`, String(position.qty));
    if (qtyStr == null) return;
    const qty = parseFloat(qtyStr);
    if (!(qty > 0) || qty > position.qty + 1e-9) {
      window.alert(`Enter a quantity between 0 and ${position.qty}.`);
      return;
    }
    const priceStr = window.prompt(`${action} price?`);
    if (priceStr == null) return;
    const price = parseFloat(priceStr);
    if (!(price > 0)) {
      window.alert('Enter a positive price.');
      return;
    }
    const dateStr = window.prompt('Date? (YYYY-MM-DD)', new Date().toISOString().slice(0, 10));
    if (dateStr == null) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      window.alert('Enter the date as YYYY-MM-DD.');
      return;
    }
    const newTrade = { date: dateStr, symbol: position.symbol, desc: '', side: position.isShort ? 'buy' : 'sell', qty, price, account: position.account };
    const merged = [...trades, newTrade].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    setTrades(merged);
    const now = new Date().toISOString();
    setLastSynced(now);
    const d = new Date(dateStr + 'T12:00:00');
    setYear(d.getFullYear());
    setMonth(d.getMonth());
    try { localStorage.setItem('trades-data', JSON.stringify({ trades: merged, lastSynced: now, notes, tradeNotes })); } catch (_) {}
    setImportNote('Trade added.');
  }, [trades, notes, tradeNotes]);

  // Deletes every realized trade that closed on a given day. For Robinhood this
  // walks each trade's contributing legs and trims/removes the underlying buy
  // and sell rows; for Schwab it just drops the matching imported rows.
  const deleteDay = useCallback((dateStr, dayTrades) => {
    if (!dayTrades || !dayTrades.length) return;
    if (!window.confirm(`Delete all trades closed on ${dateStr}? This cannot be undone.`)) return;
    if (activeAccount === 'robinhood') {
      const removeQty = {};
      for (const r of dayTrades) {
        for (const leg of r.legs || []) {
          removeQty[leg.idx] = (removeQty[leg.idx] || 0) + leg.qty;
        }
      }
      setTrades((prev) => {
        const updated = prev
          .map((t, i) => {
            const rem = removeQty[i];
            if (!rem) return t;
            const newQty = t.qty - rem;
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
    } else {
      setSchwabRealized((prev) => {
        const updated = prev.filter((t) => t.closeDate !== dateStr);
        try {
          const raw = localStorage.getItem('trades-data-schwab');
          const parsed = raw ? JSON.parse(raw) : {};
          localStorage.setItem('trades-data-schwab', JSON.stringify({ ...parsed, realized: updated }));
        } catch (_) {}
        return updated;
      });
    }
    setSelectedDay((sd) => (sd === dateStr ? null : sd));
  }, [activeAccount]);

  // Deletes a single realized trade row. For Robinhood this trims/removes just
  // that trade's contributing buy/sell legs; for Schwab it drops that one row.
  const deleteTrade = useCallback((t) => {
    if (!window.confirm('Delete this trade? This cannot be undone.')) return;
    if (activeAccount === 'robinhood') {
      const removeQty = {};
      for (const leg of t.legs || []) {
        removeQty[leg.idx] = (removeQty[leg.idx] || 0) + leg.qty;
      }
      setTrades((prev) => {
        const updated = prev
          .map((tr, i) => {
            const rem = removeQty[i];
            if (!rem) return tr;
            const newQty = tr.qty - rem;
            return newQty > 1e-9 ? { ...tr, qty: newQty } : null;
          })
          .filter(Boolean);
        try {
          const raw = localStorage.getItem('trades-data');
          const parsed = raw ? JSON.parse(raw) : {};
          localStorage.setItem('trades-data', JSON.stringify({ ...parsed, trades: updated }));
        } catch (_) {}
        return updated;
      });
    } else {
      setSchwabRealized((prev) => {
        const updated = prev.filter((r) => r !== t);
        try {
          const raw = localStorage.getItem('trades-data-schwab');
          const parsed = raw ? JSON.parse(raw) : {};
          localStorage.setItem('trades-data-schwab', JSON.stringify({ ...parsed, realized: updated }));
        } catch (_) {}
        return updated;
      });
    }
  }, [activeAccount]);

  // Writes edited field values back to the underlying trade(s). For Robinhood
  // this only works on rows with an unambiguous single buy + single sell
  // (see simpleTradeLegs); for Schwab every row is already 1:1.
  const updateTrade = useCallback((t, fields) => {
    if (activeAccount === 'robinhood') {
      const legs = simpleTradeLegs(t);
      if (!legs) return;
      // For shorts the buy is the *closing* leg and the sell is the *opening*
      // leg (opposite of a long trade), so the date each one takes is flipped.
      const buyDate = t.isShort ? fields.closeDate : fields.openDate;
      const sellDate = t.isShort ? fields.openDate : fields.closeDate;
      setTrades((prev) => {
        const updated = prev
          .map((tr, i) => {
            if (i === legs.buyIdx) return { ...tr, price: fields.buyPrice, date: buyDate, qty: fields.qty };
            if (i === legs.sellIdx) return { ...tr, price: fields.sellPrice, date: sellDate, qty: fields.qty };
            return tr;
          })
          .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
        try {
          const raw = localStorage.getItem('trades-data');
          const parsed = raw ? JSON.parse(raw) : {};
          localStorage.setItem('trades-data', JSON.stringify({ ...parsed, trades: updated }));
        } catch (_) {}
        return updated;
      });
    } else {
      setSchwabRealized((prev) => {
        const updated = prev
          .map((r) => (r === t ? { ...r, ...fields, isOption: fields.tradeType.toLowerCase() !== 'shares' } : r))
          .sort((a, b) => (a.closeDate < b.closeDate ? -1 : 1));
        try {
          const raw = localStorage.getItem('trades-data-schwab');
          const parsed = raw ? JSON.parse(raw) : {};
          localStorage.setItem('trades-data-schwab', JSON.stringify({ ...parsed, realized: updated }));
        } catch (_) {}
        return updated;
      });
    }
    setEditingTrade(null);
  }, [activeAccount]);

  // ── Schwab import (TSV from Excel paste) ─────────────────────────────────────
  const importSchwabTrades = useCallback((rawText) => {
    setError(null);
    try {
      const { realized: incoming, open: incomingOpen } = parseSchwabTSV(rawText);

      const keyOf = (t) => `${t.symbol}|${t.tradeType}|${t.openDate}|${t.closeDate}|${t.qty}|${t.buyPrice}`;
      const existingKeys = new Set(schwabRealized.map(keyOf));
      const newTrades = incoming.filter(t => !existingKeys.has(keyOf(t)));
      const merged = [...schwabRealized, ...newTrades].sort((a, b) => a.closeDate < b.closeDate ? -1 : 1);

      const openKeyOf = (t) => `${t.symbol}|${t.tradeType}|${t.openDate}|${t.qty}|${t.buyPrice}`;
      const existingOpenKeys = new Set(schwabOpen.map(openKeyOf));
      const newOpen = incomingOpen.filter(t => !existingOpenKeys.has(openKeyOf(t)));
      const mergedOpen = [...schwabOpen, ...newOpen].sort((a, b) => a.openDate < b.openDate ? -1 : 1);

      const updatedNotes = { ...schwabTradeNotes };
      for (const t of newTrades) {
        if (t._note) {
          const nk = `${t.symbol}|${t.openDate}|${t.closeDate}|${t.buyPrice}|${t.sellPrice}`;
          updatedNotes[nk] = t._note;
        }
      }

      setSchwabRealized(merged);
      setSchwabOpen(mergedOpen);
      setSchwabTradeNotes(updatedNotes);

      if (merged.length) {
        const last = merged[merged.length - 1];
        const d = new Date(last.closeDate + 'T12:00:00');
        setYear(d.getFullYear()); setMonth(d.getMonth());
      }

      try { localStorage.setItem('trades-data-schwab', JSON.stringify({ realized: merged, open: mergedOpen, notes: schwabNotes, tradeNotes: updatedNotes })); } catch (_) {}
      setShowSchwabImport(false);
      setSchwabImportText('');
      const addedTotal = newTrades.length + newOpen.length;
      const skippedTotal = (incoming.length - newTrades.length) + (incomingOpen.length - newOpen.length);
      setImportNote(`Added ${addedTotal} new trade${addedTotal === 1 ? '' : 's'}${newOpen.length ? ` (${newOpen.length} still open)` : ''}${skippedTotal > 0 ? ` (${skippedTotal} already imported)` : ''}.`);
    } catch (e) {
      setError(e.message || 'Could not parse that data');
    }
  }, [schwabRealized, schwabOpen, schwabTradeNotes, schwabNotes]);

  const clearSchwabData = useCallback(() => {
    if (!window.confirm('Clear all Schwab trade data? This cannot be undone.')) return;
    try { localStorage.removeItem('trades-data-schwab'); } catch (_) {}
    setSchwabRealized([]); setSchwabOpen([]); setSchwabNotes(''); setSchwabTradeNotes({});
    setSelectedDay(null); setError(null); setImportNote(null);
  }, []);

  // Deletes a hand-entered or imported open Schwab position (no underlying
  // legs to trim, unlike Robinhood — Schwab open rows are stored directly).
  const deleteSchwabOpenPosition = useCallback((position) => {
    if (!window.confirm('Delete this open position?')) return;
    setSchwabOpen((prev) => {
      const updated = prev.filter((p) => p !== position);
      try {
        const raw = localStorage.getItem('trades-data-schwab');
        const parsed = raw ? JSON.parse(raw) : {};
        localStorage.setItem('trades-data-schwab', JSON.stringify({ ...parsed, open: updated }));
      } catch (_) {}
      return updated;
    });
  }, []);

  // Sells part (or all) of an open Schwab position — a quick way to trim a
  // couple shares/contracts at a time without retyping symbol/type/buy price.
  // Writes a closed round-trip row for the sold qty and shrinks (or removes)
  // the open position by that amount.
  const trimSchwabPosition = useCallback((position) => {
    const unit = isContractTrade(position) ? 'contracts' : 'shares';
    const qtyStr = window.prompt(`Sell how many of the ${position.qty} ${unit} of ${position.symbol}?`, String(position.qty));
    if (qtyStr == null) return;
    const qty = parseFloat(qtyStr);
    if (!(qty > 0) || qty > position.qty + 1e-9) {
      window.alert(`Enter a quantity between 0 and ${position.qty}.`);
      return;
    }
    const priceStr = window.prompt('Sell price?');
    if (priceStr == null) return;
    const sellPrice = parseFloat(priceStr);
    if (!(sellPrice > 0)) {
      window.alert('Enter a positive price.');
      return;
    }
    const dateStr = window.prompt('Close date? (YYYY-MM-DD)', new Date().toISOString().slice(0, 10));
    if (dateStr == null) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      window.alert('Enter the date as YYYY-MM-DD.');
      return;
    }

    const mult = isContractTrade(position) ? 100 : 1;
    const newTrade = {
      symbol: position.symbol, tradeType: position.tradeType, expiration: position.expiration,
      qty, buyPrice: position.buyPrice, sellPrice, openDate: position.openDate, closeDate: dateStr,
      pnl: (sellPrice - position.buyPrice) * qty * mult,
      isOption: isContractTrade(position), account: position.account, desc: '',
    };
    const mergedRealized = [...schwabRealized, newTrade].sort((a, b) => (a.closeDate < b.closeDate ? -1 : 1));
    setSchwabRealized(mergedRealized);

    const remaining = position.qty - qty;
    const mergedOpen = remaining > 1e-9
      ? schwabOpen.map((p) => (p === position ? { ...p, qty: remaining } : p))
      : schwabOpen.filter((p) => p !== position);
    setSchwabOpen(mergedOpen);

    const d = new Date(dateStr + 'T12:00:00');
    setYear(d.getFullYear());
    setMonth(d.getMonth());
    try { localStorage.setItem('trades-data-schwab', JSON.stringify({ realized: mergedRealized, open: mergedOpen, notes: schwabNotes, tradeNotes: schwabTradeNotes })); } catch (_) {}
    setImportNote(remaining > 1e-9 ? `Sold ${qty} ${unit} — ${remaining} left open.` : `Sold all ${qty} ${unit} — position closed.`);
  }, [schwabRealized, schwabOpen, schwabNotes, schwabTradeNotes]);

  const switchAccount = useCallback((acct) => {
    setActiveAccount(acct);
    setSelectedDay(null);
    setShowImport(false);
    setShowSchwabImport(false);
    setShowManualTrade(false);
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

  // Normalized open-positions list for the Open Positions modal — Robinhood's
  // rows already have this shape; Schwab's open rows carry buyPrice instead
  // of avgPrice and have no long/short concept, so map them onto the same
  // fields (keeping a back-reference for delete).
  const displayOpenPositions = activeAccount === 'robinhood'
    ? openPositions
    : schwabOpen.map((p) => ({ ...p, avgPrice: p.buyPrice, isShort: false, _raw: p }));

  // Open (non-short) lots for whatever symbol/account is currently typed into
  // the manual-trade form, so a sell can be pinned to a specific one.
  const manualLotOptions = useMemo(() => {
    if (manualSide !== 'sell' || !manualSymbol.trim()) return [];
    const symbol = manualSymbol.trim().toUpperCase();
    const account = manualAccount.trim() || 'Individual';
    const pos = openPositions.find((p) => p.symbol === symbol && p.account === account && !p.isShort);
    return pos ? pos.lots.slice().sort((a, b) => (a.date < b.date ? -1 : 1)) : [];
  }, [manualSide, manualSymbol, manualAccount, openPositions]);

  const realized = useMemo(() =>
    activeAccount === 'robinhood' ? rhRealized : schwabRealized,
    [activeAccount, rhRealized, schwabRealized]
  );

  const activeTradeNotes = activeAccount === 'robinhood' ? tradeNotes : schwabTradeNotes;

  // Distinct sub-accounts (e.g. "Individual", "Roth IRA") present in the
  // current account's trades, for the Cumulative P&L chart's account toggle.
  const subAccounts = useMemo(() => {
    const set = new Set();
    for (const r of realized) if (r.account) set.add(r.account);
    return [...set].sort();
  }, [realized]);

  useEffect(() => {
    if (chartAccount !== 'all' && !subAccounts.includes(chartAccount)) setChartAccount('all');
  }, [subAccounts, chartAccount]);

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
    const filtered = chartAccount === 'all' ? realized : realized.filter((r) => r.account === chartAccount);
    const map = {};
    for (const r of filtered) map[r.closeDate] = (map[r.closeDate] || 0) + r.pnl;
    const days = Object.entries(map).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    let cum = 0;
    return days.map(([date, pnl]) => { cum += pnl; return { date: date.slice(5), value: Math.round(cum * 100) / 100 }; });
  }, [realized, chartAccount]);

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
  const hasData = activeAccount === 'robinhood' ? trades.length > 0 : (schwabRealized.length > 0 || schwabOpen.length > 0);

  const exportCsv = useCallback(() => {
    const header = ['Symbol', 'Type', 'Side', 'Qty', 'Buy Price', 'Sell Price', 'Open Date', 'Close Date', 'P&L', 'Account'];
    const rows = realized.map((r) => [
      getTradeDisplayLabel(r), r.isOption ? 'Option' : 'Share', r.isShort ? 'Short' : 'Long',
      r.qty, r.buyPrice.toFixed(2), r.sellPrice.toFixed(2), r.openDate, r.closeDate, r.pnl.toFixed(2), r.account,
    ]);
    const csv = [header, ...rows].map((row) => row.map(csvValue).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trades-${activeAccount}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [realized, activeAccount]);

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
          <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0, letterSpacing: -0.5, display: 'flex', alignItems: 'baseline', gap: 8 }}>
            Trade Tracker
            <span style={{ fontSize: 11, fontWeight: 600, color: COLORS.dim, fontFamily: MONO }}>v{APP_VERSION}</span>
          </h1>
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
            <button onClick={exportCsv} title="Export realized trades as CSV"
              style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', color: COLORS.muted, border: `1px solid ${COLORS.border}`, borderRadius: 6, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
              <Download size={13} /> CSV
            </button>
          )}
          {hasData && (
            <button onClick={() => setShowTickerPnl(true)}
              style={{ background: 'none', color: COLORS.muted, border: `1px solid ${COLORS.border}`, borderRadius: 6, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
              P&L by ticker
            </button>
          )}
          {activeAccount === 'robinhood' ? (
            <>
              <button onClick={() => { setShowManualTrade(s => !s); setImportNote(null); }}
                style={{ display: 'flex', alignItems: 'center', gap: 8, background: showManualTrade ? COLORS.panel2 : 'none', color: showManualTrade ? COLORS.muted : COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 6, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                {showManualTrade ? 'Cancel' : 'Manual trade'}
              </button>
              <button onClick={() => { setShowImport(s => !s); setImportNote(null); }}
                style={{ display: 'flex', alignItems: 'center', gap: 8, background: showImport ? COLORS.panel2 : COLORS.text, color: showImport ? COLORS.muted : COLORS.bg, border: `1px solid ${COLORS.border}`, borderRadius: 6, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                {showImport ? 'Cancel' : 'Import data'}
              </button>
            </>
          ) : (
            <>
              <button onClick={() => { setShowManualTrade(s => !s); setImportNote(null); }}
                style={{ display: 'flex', alignItems: 'center', gap: 8, background: showManualTrade ? COLORS.panel2 : 'none', color: showManualTrade ? COLORS.muted : COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 6, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                {showManualTrade ? 'Cancel' : 'Manual trade'}
              </button>
              <button onClick={() => { setShowSchwabImport(s => !s); setImportNote(null); }}
                style={{ display: 'flex', alignItems: 'center', gap: 8, background: showSchwabImport ? COLORS.panel2 : COLORS.text, color: showSchwabImport ? COLORS.muted : COLORS.bg, border: `1px solid ${COLORS.border}`, borderRadius: 6, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                {showSchwabImport ? 'Cancel' : 'Import trades'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* ── Manual trade entry panel ── */}
      {activeAccount === 'robinhood' && showManualTrade && (
        <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: 16, marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={{ fontSize: 11, letterSpacing: 1, color: COLORS.dim, textTransform: 'uppercase' }}>
              {manualSplitMode ? 'Add a buy, then sell it in pieces' : 'Add a trade by hand'}
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: COLORS.muted, cursor: 'pointer' }}>
              <input type="checkbox" checked={manualSplitMode}
                onChange={(e) => { setManualSplitMode(e.target.checked); if (e.target.checked) { setManualSide('buy'); setManualTargetLot(''); } }} />
              Split into multiple sells
            </label>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10, marginBottom: 10 }}>
            <div>
              <label style={labelStyle}>Symbol</label>
              <input value={manualSymbol} onChange={(e) => setManualSymbol(e.target.value)} placeholder="AAPL"
                style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Side</label>
              <select value={manualSide} disabled={manualSplitMode}
                onChange={(e) => { setManualSide(e.target.value); setManualTargetLot(''); }} style={inputStyle}>
                <option value="buy">Buy</option>
                <option value="sell">Sell</option>
              </select>
            </div>
            <div>
              <label style={labelStyle}>Quantity{manualSplitMode ? ' (bought)' : ''}</label>
              <input type="number" value={manualQty} onChange={(e) => setManualQty(e.target.value)} placeholder="10" style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Price{manualSplitMode ? ' (buy)' : ''}</label>
              <input type="number" step="0.01" value={manualPrice} onChange={(e) => setManualPrice(e.target.value)} placeholder="195.20" style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Date{manualSplitMode ? ' (buy)' : ''}</label>
              <input type="date" value={manualDate} onChange={(e) => setManualDate(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Account</label>
              <input value={manualAccount} onChange={(e) => setManualAccount(e.target.value)} placeholder="Individual" style={inputStyle} />
            </div>
          </div>
          <div style={{ marginBottom: 10 }}>
            <label style={labelStyle}>Note (optional)</label>
            <input value={manualDesc} onChange={(e) => setManualDesc(e.target.value)} placeholder="" style={{ ...inputStyle, width: '100%', boxSizing: 'border-box' }} />
          </div>
          {manualSplitMode ? (
            <div style={{ marginBottom: 10 }}>
              <label style={labelStyle}>Sells</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {manualSplitSells.map((row, i) => (
                  <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: 6, alignItems: 'end' }}>
                    <input type="number" value={row.qty} placeholder="Qty" style={inputStyle}
                      onChange={(e) => setManualSplitSells((rows) => rows.map((r, j) => j === i ? { ...r, qty: e.target.value } : r))} />
                    <input type="number" step="0.01" value={row.price} placeholder="Price" style={inputStyle}
                      onChange={(e) => setManualSplitSells((rows) => rows.map((r, j) => j === i ? { ...r, price: e.target.value } : r))} />
                    <input type="date" value={row.date} style={inputStyle}
                      onChange={(e) => setManualSplitSells((rows) => rows.map((r, j) => j === i ? { ...r, date: e.target.value } : r))} />
                    <button onClick={() => setManualSplitSells((rows) => rows.length > 1 ? rows.filter((_, j) => j !== i) : rows)}
                      title="Remove this sell" style={{ background: 'none', border: `1px solid ${COLORS.border}`, borderRadius: 6, color: COLORS.dim, cursor: 'pointer', padding: '6px 8px', display: 'flex', alignItems: 'center' }}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
              <button onClick={() => setManualSplitSells((rows) => [...rows, { qty: '', price: '', date: '' }])}
                style={{ marginTop: 8, background: 'none', border: `1px solid ${COLORS.border}`, borderRadius: 6, color: COLORS.text, cursor: 'pointer', padding: '5px 10px', fontSize: 12, fontWeight: 600 }}>
                + Add another sell
              </button>
            </div>
          ) : manualSide === 'sell' && manualLotOptions.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <label style={labelStyle}>Which lot is this selling?</label>
              <select value={manualTargetLot} onChange={(e) => setManualTargetLot(e.target.value)} style={{ ...inputStyle, width: '100%', boxSizing: 'border-box' }}>
                <option value="">Auto (FIFO — oldest lot first)</option>
                {manualLotOptions.map((lot, i) => (
                  <option key={i} value={`${lot.date}|${lot.price}`}>
                    {lot.qty} sh @ {lot.price.toFixed(2)} · opened {lot.date}
                  </option>
                ))}
              </select>
              <div style={{ fontSize: 11, color: COLORS.dim, marginTop: 4 }}>
                Pick the specific tax lot you sold (e.g. the lower-cost one), instead of the default oldest-first matching.
              </div>
            </div>
          )}
          <button onClick={manualSplitMode ? addManualSplitTrade : addManualTrade}
            style={{ background: COLORS.text, color: COLORS.bg, border: 'none', borderRadius: 6, padding: '7px 14px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
            {manualSplitMode ? 'Add buy + sells' : 'Add trade'}
          </button>
        </div>
      )}

      {/* ── Schwab manual trade entry panel ── */}
      {activeAccount === 'schwab' && showManualTrade && (
        <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: 16, marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
            <div style={{ fontSize: 11, letterSpacing: 1, color: COLORS.dim, textTransform: 'uppercase' }}>
              {manualSchwabMode === 'open' ? 'Add an open position by hand' : manualSchwabMode === 'split' ? 'Add a buy, then sell it in pieces' : 'Add a closed trade by hand'}
            </div>
            <select value={manualSchwabMode} onChange={(e) => setManualSchwabMode(e.target.value)}
              style={{ ...inputStyle, width: 'auto' }}>
              <option value="closed">Closed trade</option>
              <option value="open">Still open (no exit yet)</option>
              <option value="split">Split into multiple sells</option>
            </select>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10, marginBottom: 10 }}>
            <div>
              <label style={labelStyle}>Symbol</label>
              <input value={manualSchwabSymbol} onChange={(e) => setManualSchwabSymbol(e.target.value)} placeholder="AAPL" style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Type</label>
              <input value={manualSchwabType} onChange={(e) => setManualSchwabType(e.target.value)} placeholder="shares / Calls / Puts" style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Expiration</label>
              <input value={manualSchwabExpiration} onChange={(e) => setManualSchwabExpiration(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Quantity{manualSchwabMode === 'split' ? ' (bought)' : ''}</label>
              <input type="number" value={manualSchwabQty} onChange={(e) => setManualSchwabQty(e.target.value)} placeholder="10" style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Buy price</label>
              <input type="number" step="0.01" value={manualSchwabBuyPrice} onChange={(e) => setManualSchwabBuyPrice(e.target.value)} placeholder="195.20" style={inputStyle} />
            </div>
            {manualSchwabMode === 'closed' && (
              <div>
                <label style={labelStyle}>Sell price</label>
                <input type="number" step="0.01" value={manualSchwabSellPrice} onChange={(e) => setManualSchwabSellPrice(e.target.value)} placeholder="201.50" style={inputStyle} />
              </div>
            )}
            <div>
              <label style={labelStyle}>Open date</label>
              <input type="date" value={manualSchwabOpenDate} onChange={(e) => setManualSchwabOpenDate(e.target.value)} style={inputStyle} />
            </div>
            {manualSchwabMode === 'closed' && (
              <>
                <div>
                  <label style={labelStyle}>Close date</label>
                  <input type="date" value={manualSchwabCloseDate} onChange={(e) => setManualSchwabCloseDate(e.target.value)} style={inputStyle} />
                </div>
                <div>
                  <label style={labelStyle}>P&L</label>
                  <input type="number" step="0.01" value={manualSchwabPnl} onChange={(e) => setManualSchwabPnl(e.target.value)}
                    placeholder={manualSchwabAutoPnl != null ? manualSchwabAutoPnl.toFixed(2) : '0.00'} style={inputStyle} />
                </div>
              </>
            )}
          </div>
          {manualSchwabMode === 'split' && (
            <div style={{ marginBottom: 10 }}>
              <label style={labelStyle}>Sells</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {manualSchwabSplitSells.map((row, i) => (
                  <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: 6, alignItems: 'end' }}>
                    <input type="number" value={row.qty} placeholder="Qty" style={inputStyle}
                      onChange={(e) => setManualSchwabSplitSells((rows) => rows.map((r, j) => j === i ? { ...r, qty: e.target.value } : r))} />
                    <input type="number" step="0.01" value={row.price} placeholder="Sell price" style={inputStyle}
                      onChange={(e) => setManualSchwabSplitSells((rows) => rows.map((r, j) => j === i ? { ...r, price: e.target.value } : r))} />
                    <input type="date" value={row.date} style={inputStyle}
                      onChange={(e) => setManualSchwabSplitSells((rows) => rows.map((r, j) => j === i ? { ...r, date: e.target.value } : r))} />
                    <button onClick={() => setManualSchwabSplitSells((rows) => rows.length > 1 ? rows.filter((_, j) => j !== i) : rows)}
                      title="Remove this sell" style={{ background: 'none', border: `1px solid ${COLORS.border}`, borderRadius: 6, color: COLORS.dim, cursor: 'pointer', padding: '6px 8px', display: 'flex', alignItems: 'center' }}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
              <button onClick={() => setManualSchwabSplitSells((rows) => [...rows, { qty: '', price: '', date: '' }])}
                style={{ marginTop: 8, background: 'none', border: `1px solid ${COLORS.border}`, borderRadius: 6, color: COLORS.text, cursor: 'pointer', padding: '5px 10px', fontSize: 12, fontWeight: 600 }}>
                + Add another sell
              </button>
              <div style={{ fontSize: 11, color: COLORS.dim, marginTop: 6 }}>
                Any bought quantity left over after these sells is added as a separate open position.
              </div>
            </div>
          )}
          <button onClick={manualSchwabMode === 'open' ? addManualSchwabOpenPosition : manualSchwabMode === 'split' ? addManualSchwabSplitTrades : addManualSchwabTrade}
            style={{ background: COLORS.text, color: COLORS.bg, border: 'none', borderRadius: 6, padding: '7px 14px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
            {manualSchwabMode === 'open' ? 'Add position' : manualSchwabMode === 'split' ? 'Add buy + sells' : 'Add trade'}
          </button>
        </div>
      )}

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
            <StatCard label="Open Positions" value={activeAccount === 'robinhood' ? openPositions.length : schwabOpen.length} color={COLORS.amber} onClick={() => setShowPositions(true)} />
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
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
              <div style={{ fontSize: 11, letterSpacing: 1, color: COLORS.dim, textTransform: 'uppercase' }}>Cumulative P&L</div>
              {activeAccount === 'robinhood' && subAccounts.length > 1 && (
                <div style={{ display: 'flex', background: COLORS.panel2, border: `1px solid ${COLORS.border}`, borderRadius: 7, padding: 2, gap: 2, flexWrap: 'wrap' }}>
                  <button onClick={() => setChartAccount('all')}
                    style={{ background: chartAccount === 'all' ? COLORS.text : 'none', color: chartAccount === 'all' ? COLORS.bg : COLORS.muted, border: 'none', borderRadius: 5, padding: '3px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                    Combined
                  </button>
                  {subAccounts.map((acct) => (
                    <button key={acct} onClick={() => setChartAccount(acct)}
                      style={{ background: chartAccount === acct ? COLORS.text : 'none', color: chartAccount === acct ? COLORS.bg : COLORS.muted, border: 'none', borderRadius: 5, padding: '3px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                      {acct}
                    </button>
                  ))}
                </div>
              )}
            </div>
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
                    <div style={{ fontFamily: MONO, fontWeight: 700, fontSize: 13, color: compactCalendar ? COLORS.dim : (monthPnl >= 0 ? COLORS.green : COLORS.red) }}>
                      {compactCalendar ? '****' : fmt(monthPnl)}
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
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                <span style={{ fontSize: 10, color: COLORS.dim }}>{day}</span>
                                {d && (
                                  <button onClick={(e) => { e.stopPropagation(); deleteDay(ds, d.trades); }}
                                    title="Delete this day's trades"
                                    style={{ background: 'none', border: 'none', color: COLORS.dim, cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', opacity: 0.55 }}>
                                    <Trash2 size={9} />
                                  </button>
                                )}
                              </div>
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
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <div style={{ fontSize: 11, letterSpacing: 1, color: COLORS.dim, textTransform: 'uppercase' }}>
                  {selectedDay ? `Trades · ${selectedDay}` : 'Recent realized trades'}
                </div>
                {selectedDay && selectedTrades.length > 0 && (
                  <button onClick={() => deleteDay(selectedDay, selectedTrades)} title="Delete all trades for this day"
                    style={{ background: 'none', border: 'none', color: COLORS.dim, cursor: 'pointer', padding: 2, display: 'flex', alignItems: 'center' }}>
                    <Trash2 size={13} />
                  </button>
                )}
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
                    const canEditTrade = activeAccount === 'schwab' || !!simpleTradeLegs(t);
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
                            {canEditTrade && (
                              <button onClick={() => setEditingTrade(t)} title="Edit this trade"
                                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: COLORS.dim, display: 'flex', alignItems: 'center' }}>
                                <SquarePen size={12} />
                              </button>
                            )}
                            <button onClick={() => deleteTrade(t)} title="Delete this trade"
                              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: COLORS.dim, display: 'flex', alignItems: 'center' }}>
                              <Trash2 size={12} />
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

      {/* Open positions modal — Robinhood (raw open/short lots) and Schwab (hand-entered/imported open rows) */}
      {showPositions && (
        <div onClick={() => setShowPositions(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, zIndex: 100 }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 20, width: '100%', maxWidth: 640, maxHeight: '80vh', overflowY: 'auto', fontFamily: SANS, color: COLORS.text }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <div style={{ fontSize: 15, fontWeight: 700 }}>Open Positions</div>
              <button onClick={() => setShowPositions(false)}
                style={{ background: 'none', border: 'none', color: COLORS.dim, cursor: 'pointer', fontSize: 20, lineHeight: 1, padding: 4 }}>×</button>
            </div>
            {displayOpenPositions.length === 0 ? (
              <div style={{ fontSize: 13, color: COLORS.dim }}>No open positions - everything's closed out.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 18 }}>
                  {[
                    { label: 'Shares', items: displayOpenPositions.filter((p) => !isContractTrade(p)) },
                    { label: 'Options', items: displayOpenPositions.filter((p) => isContractTrade(p)) },
                  ].map(({ label, items }) => (
                    <div key={label}>
                      <div style={{ fontSize: 10, letterSpacing: 0.5, color: COLORS.dim, textTransform: 'uppercase', marginBottom: 8 }}>{label}</div>
                      {items.length === 0 ? (
                        <div style={{ fontSize: 11, color: COLORS.dim }}>None</div>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                          {items.slice().sort((a, b) => (a.openDate < b.openDate ? -1 : 1)).map((p, i) => {
                            const isOpt = isContractTrade(p);
                            const mult = isOpt ? 100 : 1;
                            const posLabel = getTradeDisplayLabel(p);
                            const costBasis = p.avgPrice * p.qty * mult;
                            return (
                              <div key={i} style={{ borderBottom: `1px solid ${COLORS.border}`, paddingBottom: 8 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 6 }}>
                                  <div style={{ fontSize: 11.5, fontWeight: 600, lineHeight: 1.3 }}>
                                    {posLabel}
                                    {p.isShort && <span style={{ fontSize: 9.5, fontWeight: 500, color: COLORS.amber, marginLeft: 4 }}>SHORT</span>}
                                    {p.isShort && (
                                      <button onClick={() => convertShortToLong(p)} title="Not actually a short — add the missing buy so it FIFO-matches as a normal long"
                                        style={{ marginLeft: 4, background: 'none', border: 'none', color: COLORS.dim, cursor: 'pointer', padding: 0, fontSize: 9.5, textDecoration: 'underline' }}>
                                        fix
                                      </button>
                                    )}
                                    {p.account && <div style={{ fontWeight: 400, color: COLORS.dim, fontSize: 9.5 }}>{p.account}</div>}
                                  </div>
                                  <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 5 }}>
                                    <button onClick={() => activeAccount === 'robinhood' ? trimRobinhoodPosition(p) : trimSchwabPosition(p._raw)} title="Sell some or all of this position"
                                      style={{ background: 'none', border: `1px solid ${COLORS.border}`, borderRadius: 5, color: COLORS.text, cursor: 'pointer', padding: '3px 5px', display: 'flex', alignItems: 'center' }}>
                                      <TrendingDown size={11} />
                                    </button>
                                    <button onClick={() => activeAccount === 'robinhood' ? deletePosition(p) : deleteSchwabOpenPosition(p._raw)} title="Delete this position"
                                      style={{ background: 'none', border: `1px solid ${COLORS.border}`, borderRadius: 5, color: COLORS.red, cursor: 'pointer', padding: '3px 5px', display: 'flex', alignItems: 'center' }}>
                                      <Trash2 size={11} />
                                    </button>
                                  </div>
                                </div>
                                <div style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, marginTop: 3 }}>
                                  ${costBasis.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                </div>
                                <div style={{ fontSize: 9.5, color: COLORS.dim, fontFamily: MONO, marginTop: 1 }}>
                                  {p.qty} {isOpt ? 'x100' : 'sh'}{p.isShort ? ' short' : ''} · {p.isShort ? 'cr' : 'cost'} {p.avgPrice.toFixed(2)} · {p.openDate}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                {(() => {
                  const byAcct = {};
                  for (const p of displayOpenPositions) {
                    const key = p.account || 'Unknown';
                    const mult = isContractTrade(p) ? 100 : 1;
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

      {editingTrade && (
        <EditTradeModal trade={editingTrade} isRobinhood={activeAccount === 'robinhood'}
          onSave={(fields) => updateTrade(editingTrade, fields)} onClose={() => setEditingTrade(null)} />
      )}

    </div>
  );
}

function EditTradeModal({ trade, isRobinhood, onSave, onClose }) {
  const [buyPrice, setBuyPrice] = useState(String(trade.buyPrice));
  const [sellPrice, setSellPrice] = useState(String(trade.sellPrice));
  const [qty, setQty] = useState(String(trade.qty));
  const [openDate, setOpenDate] = useState(trade.openDate);
  const [closeDate, setCloseDate] = useState(trade.closeDate);
  const [symbol, setSymbol] = useState(trade.symbol);
  const [tradeType, setTradeType] = useState(trade.tradeType || 'shares');
  const [expiration, setExpiration] = useState(trade.expiration || '');
  const [pnl, setPnl] = useState(String(trade.pnl));
  const [error, setError] = useState(null);

  const save = () => {
    const q = parseFloat(qty), bp = parseFloat(buyPrice), sp = parseFloat(sellPrice);
    if (!(q > 0) || !(bp > 0) || !(sp > 0) || !openDate || !closeDate) {
      setError('Quantity, buy price, sell price, and both dates are required.');
      return;
    }
    if (isRobinhood) {
      onSave({ buyPrice: bp, sellPrice: sp, qty: q, openDate, closeDate });
    } else {
      const p = parseFloat(pnl);
      if (!symbol.trim() || Number.isNaN(p)) {
        setError('Symbol and P&L are required.');
        return;
      }
      onSave({ symbol: symbol.trim().toUpperCase(), tradeType, expiration: expiration.trim(), account: 'Schwab', buyPrice: bp, sellPrice: sp, qty: q, openDate, closeDate, pnl: p });
    }
  };

  return (
    <div onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 20, width: '100%', maxWidth: 420, maxHeight: '85vh', overflowY: 'auto', fontFamily: SANS, color: COLORS.text }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>Edit Trade</div>
          <button onClick={onClose}
            style={{ background: 'none', border: 'none', color: COLORS.dim, cursor: 'pointer', fontSize: 20, lineHeight: 1, padding: 4 }}>×</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {!isRobinhood && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <label style={labelStyle}>Symbol</label>
                <input value={symbol} onChange={(e) => setSymbol(e.target.value)} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Type</label>
                <input value={tradeType} onChange={(e) => setTradeType(e.target.value)} placeholder="shares / Calls / Puts" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Expiration</label>
                <input value={expiration} onChange={(e) => setExpiration(e.target.value)} style={inputStyle} />
              </div>
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <label style={labelStyle}>Quantity</label>
              <input type="number" value={qty} onChange={(e) => setQty(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>{isRobinhood && trade.isShort ? 'Cover price' : 'Buy price'}</label>
              <input type="number" step="0.01" value={buyPrice} onChange={(e) => setBuyPrice(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>{isRobinhood && trade.isShort ? 'Open (short) price' : 'Sell price'}</label>
              <input type="number" step="0.01" value={sellPrice} onChange={(e) => setSellPrice(e.target.value)} style={inputStyle} />
            </div>
            {!isRobinhood && (
              <div>
                <label style={labelStyle}>P&L</label>
                <input type="number" step="0.01" value={pnl} onChange={(e) => setPnl(e.target.value)} style={inputStyle} />
              </div>
            )}
            <div>
              <label style={labelStyle}>Open date</label>
              <input type="date" value={openDate} onChange={(e) => setOpenDate(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Close date</label>
              <input type="date" value={closeDate} onChange={(e) => setCloseDate(e.target.value)} style={inputStyle} />
            </div>
          </div>
          {error && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', background: 'rgba(240,80,110,0.1)', border: `1px solid ${COLORS.red}`, color: COLORS.red, borderRadius: 8, padding: '8px 12px', fontSize: 12.5 }}>
              <AlertCircle size={14} /> {error}
            </div>
          )}
          <button onClick={save}
            style={{ background: COLORS.text, color: COLORS.bg, border: 'none', borderRadius: 6, padding: '8px 14px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', alignSelf: 'flex-start' }}>
            Save changes
          </button>
        </div>
      </div>
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
const labelStyle = { display: 'block', fontSize: 10.5, color: COLORS.dim, marginBottom: 3 };
const inputStyle = { width: '100%', background: COLORS.bg, color: COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 6, padding: '6px 8px', fontSize: 12.5, fontFamily: SANS, boxSizing: 'border-box', outline: 'none', colorScheme: 'dark' };
