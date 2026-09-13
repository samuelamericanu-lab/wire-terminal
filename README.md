# Wire Terminal

Bloomberg Terminal–inspired **static** markets desk. Dark multi-panel layout meant to stay open on a second monitor: indices, futures/rates, news wire, and catalysts.

**Title:** Wire Terminal  
**Path:** `/workspace/wire-terminal/`

## Quick preview (recommended)

```bash
cd /workspace/wire-terminal
python3 serve.py
```

Open **http://127.0.0.1:8765/**

`serve.py` serves the static files **and** a tiny allowlisted proxy (`/proxy?url=…`) so the browser can load Yahoo Finance quotes and RSS without CORS pain.

Custom port: `python3 serve.py 9000`

### Alternative (static only)

```bash
python3 -m http.server 8765
```

or open `index.html` via `file://`. Without the proxy, market/news fetches often fail in-browser; the UI then shows clearly labeled **DEMO** / **UNAVAILABLE** badges (never silent fake “live” numbers).

## Panels

| Panel | Content |
|--------|---------|
| Top bar | WIRE branding, local + UTC clocks, Asia / Europe / US session badges, last refresh, Refresh |
| Indices strip | S&P 500, Nasdaq, Dow, Stoxx 600, Nikkei, Hang Seng — price + % (green/red) |
| Futures / rates | ES, NQ, WTI, Brent, US 10Y (`^TNX`), ZN |
| News wire | Chronological flashes (macro / equities / futures), newest first, filters |
| Watch next | Catalysts (CPI, FOMC, earnings, oil, session opens) |

Auto-refresh ≈ **1 second** (in-flight guard skips overlaps). Status pills: **LIVE** / **DEMO** / **UNAVAILABLE** / **PARTIAL**.

## Data sources (free / public)

| Data | Source | Auth |
|------|--------|------|
| Indices & futures | [Yahoo Finance](https://finance.yahoo.com) chart API `query1.finance.yahoo.com/v8/finance/chart/{symbol}` | None (unofficial) |
| News | CNBC, MarketWatch, BBC Business, Yahoo Finance headline RSS | None |
| Optional later | Finnhub free tier | Set env / query key and extend `app.js` — not required |

### Yahoo symbols

- Indices: `^GSPC`, `^IXIC`, `^DJI`, `^STOXX` (fallback `^STOXX50E`), `^N225`, `^HSI`
- Futures: `ES=F`, `NQ=F`, `CL=F`, `BZ=F`, `ZN=F`
- Rates: `^TNX` (10Y yield %)

### How fetching works

1. App probes `/api/health` — if `serve.py` is running, **local proxy ON**.
2. Quotes/RSS go through `/proxy?url=…` (allowlisted hosts only).
3. If you use plain `http.server` or GitHub Pages, the client tries direct fetch, then CORS proxies in order (`corsproxy.io`, `allorigins`, `codetabs`), then Stooq CSV backup per symbol; news via `rss2json` / RSS. On failure → DEMO / UNAVAILABLE.
4. Clocks are **12-hour with AM/PM**.

## Files

```
wire-terminal/
├── index.html    # Layout shell
├── styles.css    # Near-black / amber terminal chrome
├── app.js        # Clocks, sessions, fetch, render, ~45s refresh
├── serve.py      # Static + CORS proxy (recommended)
└── README.md
```

No npm / no build step.

## Design

Near-black background, amber/orange accents, IBM Plex Mono + Sans, dense data typography — a markets desk tool, not a marketing site.

## Disclaimer

Third-party public endpoints for personal/educational desk use. Not financial advice. Providers may rate-limit or change APIs without notice.
