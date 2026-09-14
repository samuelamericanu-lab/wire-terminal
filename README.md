# WIRE — Options Desk

Fast desk for **calls/puts off news + tape**: `#newswire` breaks, `#spike` movers, `#fed` rate odds.

**Live:** https://samuelamericanu-lab.github.io/wire-terminal/

## Why the data paths matter

GitHub Pages serves this under `/wire-terminal/`, not domain root. The app resolves JSON with a **page-relative base**:

```js
const BASE = document.querySelector('base')?.href || new URL('.', location.href).href;
// → data/quotes.json  (never /data/quotes.json)
```

So fetches hit `…/wire-terminal/data/quotes.json` on Pages.

## Local

```bash
python3 scripts/update_data.py   # writes data/quotes.json, news.json, spikes.json
python3 serve.py                 # optional local server + proxy
```

Open `index.html` via the server (or any static host). UI polls ~1s. Clocks are 12-hour with AM/PM. Critical headlines show **BREAKING** in red.

## Data files

| File | Contents |
|------|----------|
| `data/quotes.json` | Indices + futures prices |
| `data/news.json` | Markets-only wire (`critical`, `fed` flags) |
| `data/spikes.json` | 1m / day unusual movers (honest status) |

Not financial advice. Public third-party data for personal desk use.
