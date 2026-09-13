# Wire Terminal

Bloomberg Terminal–inspired **static** markets desk. Dark multi-panel layout meant to stay open on a second monitor: indices, futures/rates, news wire, and catalysts.

**Live:** https://samuelamericanu-lab.github.io/wire-terminal/

## Quick preview

```bash
cd /workspace/wire-terminal
python3 serve.py
```

Open **http://127.0.0.1:8765/**

`serve.py` serves the static files **and** a tiny allowlisted proxy (`/proxy?url=…`) for optional live Yahoo/RSS. GitHub Pages does not need the proxy.

Custom port: `python3 serve.py 9000`

### Static / GitHub Pages

The UI loads **same-origin** `data/quotes.json` and `data/news.json` first. That always works on Pages (no CORS). GitHub Actions refreshes those files about every **5 minutes**. The browser polls every **1 second** (in-flight guard); it may also try live Yahoo via CORS proxies, and keeps the same-origin JSON if live fails — never **UNAVAILABLE** when shipped prices exist.

```bash
python3 scripts/update_data.py   # refresh data/*.json locally
python3 -m http.server 8765
```

## Panels

| Panel | Content |
|--------|---------|
| Top bar | WIRE branding, local + UTC clocks (12-hour AM/PM), session badges, last refresh |
| Indices strip | S&P 500, Nasdaq, Dow, Stoxx 50, Nikkei, Hang Seng — price + % |
| Futures / rates | ES, NQ, WTI, Brent, US 10Y (`^TNX`), ZN |
| News wire | Markets/macro flashes (personal-finance fluff filtered out) |
| Watch next | Catalysts (CPI, FOMC, earnings, oil, session opens) |

Status pills: **LIVE** / **DEMO** / **UNAVAILABLE** / **PARTIAL**.

## Data pipeline

| Piece | Role |
|-------|------|
| `scripts/update_data.py` | Yahoo chart quotes + CNBC / BBC / Reuters / Yahoo RSS → `data/*.json` |
| `.github/workflows/update-data.yml` | Cron `*/5 * * * *` + `workflow_dispatch`; commit/push `data/` |
| `app.js` | Polls same-origin JSON every 1s; optional live fetch |

### Yahoo symbols

- Indices: `^GSPC`, `^IXIC`, `^DJI`, `^STOXX50E`, `^N225`, `^HSI`
- Futures: `ES=F`, `NQ=F`, `CL=F`, `BZ=F`, `ZN=F`
- Rates: `^TNX` (10Y yield %)

## Files

```
wire-terminal/
├── index.html
├── styles.css
├── app.js
├── serve.py
├── data/quotes.json   # same-origin prices
├── data/news.json     # same-origin wire
├── scripts/update_data.py
├── .github/workflows/update-data.yml
└── README.md
```

No npm / no build step.

## Disclaimer

Third-party public endpoints for personal/educational desk use. Not financial advice. Providers may rate-limit or change APIs without notice.
