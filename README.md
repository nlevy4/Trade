# Trade Tracker

A local React app for tracking your trade P&L, calendar view, and open positions.

## Setup

```bash
npm install
npm run dev
```

Then open the URL it prints (usually http://localhost:5173).

## Loading your trades

The app starts empty. Click **"Import data"**, paste a JSON array of trades
(ask Claude in your SnapTrade chat for this), and click **"Load trades"**.

Format:
```json
[
  {"d":"2026-06-18","s":"AAPL","a":"buy","q":10,"p":195.20,"c":"Individual"},
  {"d":"2026-06-19","s":"AAPL","a":"sell","q":10,"p":198.50,"c":"Individual"}
]
```
- `d` = date (YYYY-MM-DD)
- `s` = symbol (ticker, or OCC option symbol like `SPY260618C00748000`)
- `a` = side (`buy` or `sell`)
- `q` = quantity
- `p` = price
- `c` = account name (optional)

Your data is saved to the browser's `localStorage`, so it persists between
sessions on the same browser/machine. Click "clear data" in the app to wipe it.
