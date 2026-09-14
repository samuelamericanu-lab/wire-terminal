#!/usr/bin/env python3
"""Fetch Yahoo quotes + markets RSS + short-window movers → data/*.json for Pages."""

from __future__ import annotations

import json
import re
import ssl
import sys
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
)

SYMBOLS = [
    "^GSPC",
    "^IXIC",
    "^DJI",
    "^STOXX50E",
    "^N225",
    "^HSI",
    "ES=F",
    "NQ=F",
    "CL=F",
    "BZ=F",
    "^TNX",
    "ZN=F",
]

SYMBOL_FALLBACKS = {
    "^STOXX50E": ["^STOXX", "EXSA.DE"],
}

# Liquid US names scanned for 1m / day spikes when screener is thin
SPIKE_UNIVERSE = [
    "AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "TSLA", "AMD", "NFLX",
    "AVGO", "CRM", "ORCL", "INTC", "QCOM", "MU", "SMCI", "ARM", "PLTR",
    "COIN", "MSTR", "HOOD", "SOFI", "MARA", "RIOT", "GME", "AMC",
    "SPY", "QQQ", "IWM", "DIA", "XLF", "XLE", "XLK", "ARKK",
    "BA", "CAT", "GE", "JPM", "GS", "BAC", "C", "XOM", "CVX", "OXY",
    "UNH", "LLY", "MRNA", "PFE", "JNJ", "ABBV",
    "DIS", "UBER", "SHOP", "SQ", "PYPL", "BABA", "JD", "NIO", "RIVN",
    "HPE", "HPQ", "DELL", "NTAP", "ON", "CDW", "OKLO", "HUT", "LEU",
    "M", "WMT", "TGT", "COST", "NKE", "SBUX", "F", "GM", "RIVN",
]


NEWS_FEEDS = [
    {
        "label": "CNBC",
        "url": "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114",
    },
    {
        "label": "CNBC",
        "url": "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=15839069",
    },
    {
        "label": "BBC",
        "url": "https://feeds.bbci.co.uk/news/business/rss.xml",
    },
    {
        "label": "BBC",
        "url": "https://feeds.bbci.co.uk/news/world/rss.xml",
    },
    {
        "label": "REUTERS",
        "url": "https://www.reutersagency.com/feed/?taxonomy=best-topics&post_type=best",
    },
    {
        "label": "REUTERS",
        "url": "https://feeds.reuters.com/reuters/businessNews",
    },
    {
        "label": "YAHOO",
        "url": "https://feeds.finance.yahoo.com/rss/2.0/headline?s=%5EGSPC&region=US&lang=en-US",
    },
]

# STRICT: drop personal finance / lifestyle / stock-tip fluff
NEWS_DENY = re.compile(
    r"retirement|annuit(y|ies)|social security|cola\b|401\s*\(?k\)?|roth\b|"
    r"when you die|what should i do|estate (plan|tax)|trade a job|"
    r"work[- ]life balance|personal finance|nest egg|side hustle|"
    r"what should i do with my money|how to (save|invest|budget)|"
    r"best (credit cards?|savings|cd rates)|millionaire next door|"
    r"fire movement|passive income tips|should you (buy|sell|refinance)|"
    r"refinance your|mortgage tips|debt payoff|emergency fund|"
    r"lifestyle (inflation|creep)|medicare (advantage|supplement)|"
    r"long[- ]term care insurance|penny stocks? tip|"
    r"will (and|or) testament|inheritance tips?|life insurance tips?|"
    r"my case for buying|says buy these|stocks? to buy|stocks? to (own|hold)|"
    r"obliterating the s&?p|meet the magnificent|will be worth more by|"
    r"history says that usually|from fashion to|"
    r"dividend aristocrat|passive income|make you rich|"
    r"could (turn|make) \$|if you invested|"
    r"opinion:|you should (buy|sell)|why i('m| am) (buying|selling)",
    re.I,
)

NEWS_KEEP = re.compile(
    r"\b(market|markets|stock|stocks|equity|equities|share|shares|index|indices|"
    r"nasdaq|dow|s&?p|nikkei|hang seng|stoxx|ftse|dax|"
    r"future|futures|\bes\b|\bnq\b|oil|wti|brent|crude|opec|"
    r"fed\b|fomc|ecb|boe|rate|rates|yield|treasury|bond|bonds|"
    r"cpi|ppi|inflation|gdp|payroll|jobs report|unemployment|"
    r"earnings|ipo|rally|sell[- ]?off|volatility|vix|"
    r"geopolit|tariff|sanction|war|conflict|china|europe|israel|iran|ukraine|russia|"
    r"commodit|gold|copper|dollar|forex|currency|"
    r"wall street|wall st|trading|trader|hedge fund|bank|"
    r"recession|stimulus|policy|central bank|"
    r"ceo|cfo|fda|m&a|merger|acquisition|buyout|takeover|"
    r"ai\b|anthropic|openai|chip|semiconductor)\b",
    re.I,
)

CRITICAL_RE = re.compile(
    r"earnings (beat|miss|surprise)|beats? (estimates?|expectations?)|"
    r"misses? (estimates?|expectations?)|guides? (up|down)|"
    r"ceo (resign|steps down|ousted|fired)|chief executive (resign|steps down)|"
    r"\b(m&a|merger|acquisition|acquire[sd]?|buyout|takeover)\b|"
    r"\bfda\b.{0,20}(approv|reject|crl|warning)|"
    r"(approv|reject).{0,12}\bfda\b|"
    r"fed (decision|rate (cut|hike|hold)|cuts rates|hikes rates)|"
    r"fomc (decision|statement)|rate (cut|hike) (decision|expected)|"
    r"oil (supply )?(emergency|disruption|shock|halt)|"
    r"pipeline (halt|explosion|attack)|"
    r"opec (emergency|cuts production)|"
    r"\b(missile|airstrike|invasion|ceasefire|embargo)\b|"
    r"emergency (meeting|session)",
    re.I,
)

GEO_RE = re.compile(
    r"geopolit|tariff|sanction|war|conflict|israel|iran|ukraine|russia|"
    r"china (taiwan|military)|missile|airstrike|nato|middle east",
    re.I,
)

FED_RE = re.compile(
    r"\b(fed|fomc|federal reserve|rate (cut|hike|hold|decision)|dot plot|powell)\b",
    re.I,
)

CTX = ssl.create_default_context()
SPIKE_1M_THRESHOLD = 3.0  # percent
SPIKE_DAY_THRESHOLD = 5.0  # fallback unusual day move


def iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def fetch_bytes(url: str, timeout: float = 20.0) -> bytes:
    req = Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "*/*",
            "Accept-Language": "en-US,en;q=0.9",
        },
        method="GET",
    )
    with urlopen(req, timeout=timeout, context=CTX) as resp:
        return resp.read()


def fetch_text(url: str, timeout: float = 20.0) -> str:
    return fetch_bytes(url, timeout=timeout).decode("utf-8", errors="replace")


def parse_yahoo_chart(data: dict) -> dict:
    result = (data.get("chart") or {}).get("result") or []
    if not result:
        raise ValueError("No chart result")
    meta = result[0].get("meta") or {}
    quotes = ((result[0].get("indicators") or {}).get("quote") or [{}])[0]
    closes = [c for c in (quotes.get("close") or []) if c is not None]
    price = meta.get("regularMarketPrice")
    if price is None:
        price = meta.get("postMarketPrice")
    if price is None and closes:
        price = closes[-1]
    if price is None:
        raise ValueError("No price")

    change = meta.get("regularMarketChange")
    change_pct = meta.get("regularMarketChangePercent")
    prev = meta.get("chartPreviousClose")
    if prev is None:
        prev = meta.get("previousClose")
    if prev is None and len(closes) >= 2:
        prev = closes[-2]

    if change_pct is None and prev is not None and float(prev) != 0:
        change = float(price) - float(prev)
        change_pct = (change / float(prev)) * 100.0
    elif change is None and change_pct is not None:
        denom = 100.0 + float(change_pct)
        change = (float(price) * float(change_pct) / denom) if denom != 0 else None
    elif change is None and prev is not None:
        change = float(price) - float(prev)

    def round_num(v, nd=6):
        if v is None:
            return None
        return round(float(v), nd)

    return {
        "price": round_num(price),
        "change": round_num(change),
        "changePct": round_num(change_pct, 4),
    }


def fetch_yahoo_chart_raw(symbol: str, interval: str = "1d", range_: str = "5d") -> dict:
    url = (
        "https://query1.finance.yahoo.com/v8/finance/chart/"
        + quote(symbol, safe="")
        + f"?interval={interval}&range={range_}"
    )
    raw = fetch_text(url, timeout=15.0)
    data = json.loads(raw)
    if (data.get("chart") or {}).get("error"):
        raise ValueError(str(data["chart"]["error"]))
    return data


def fetch_yahoo_quote(symbol: str) -> dict:
    data = fetch_yahoo_chart_raw(symbol, "1d", "5d")
    return parse_yahoo_chart(data)


def collect_quotes() -> dict:
    quotes: dict = {}
    for primary in SYMBOLS:
        candidates = [primary] + SYMBOL_FALLBACKS.get(primary, [])
        last_err: Exception | None = None
        for sym in candidates:
            try:
                q = fetch_yahoo_quote(sym)
                quotes[primary] = q
                print(f"OK  {primary} <- {sym}: {q['price']}", flush=True)
                last_err = None
                break
            except Exception as e:  # noqa: BLE001
                last_err = e
                print(f"FAIL {sym}: {e}", flush=True)
                time.sleep(0.2)
        if last_err and primary not in quotes:
            print(f"SKIP {primary} (no data)", flush=True)
        time.sleep(0.12)
    return quotes


def local_tag(title: str) -> str:
    t = (title or "").lower()
    if GEO_RE.search(t):
        return "geo"
    if re.search(
        r"fed|ecb|cpi|inflation|gdp|treasury|yield|rate cut|fomc|jobs|payroll|macro|"
        r"oil|opec|brent|crude|bank of england|boe|tariff|sanction",
        t,
    ):
        return "macro"
    if re.search(r"future|futures|\bes\b|\bnq\b|commodity|oil price|wti", t):
        return "futures"
    if re.search(
        r"stock|equity|shares|nasdaq|dow|s&p|earnings|ipo|rally|sell.?off|megacap|tech|share price|"
        r"ceo|fda|merger|acquisition",
        t,
    ):
        return "equities"
    return "macro"


def is_critical(title: str) -> bool:
    return bool(CRITICAL_RE.search(title or ""))


def keep_headline(title: str) -> bool:
    if not title or not title.strip():
        return False
    if NEWS_DENY.search(title):
        return False
    if not NEWS_KEEP.search(title):
        return False
    return True


def parse_rss(xml_text: str, source_label: str) -> list[dict]:
    items_out: list[dict] = []
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return items_out

    channel_items = root.findall(".//item")
    if not channel_items:
        ns = {"a": "http://www.w3.org/2005/Atom"}
        for entry in root.findall(".//{http://www.w3.org/2005/Atom}entry") or root.findall(
            ".//a:entry", ns
        ):
            title_el = entry.find("{http://www.w3.org/2005/Atom}title")
            if title_el is None:
                title_el = entry.find("title")
            title = (title_el.text or "").strip() if title_el is not None else ""
            if not keep_headline(title):
                continue
            link = ""
            for link_el in entry.findall("{http://www.w3.org/2005/Atom}link"):
                href = link_el.attrib.get("href")
                if href:
                    link = href
                    break
            updated = entry.find("{http://www.w3.org/2005/Atom}updated")
            published = entry.find("{http://www.w3.org/2005/Atom}published")
            t_el = updated if updated is not None else published
            time_s = iso_now()
            if t_el is not None and t_el.text:
                try:
                    time_s = (
                        datetime.fromisoformat(t_el.text.replace("Z", "+00:00"))
                        .astimezone(timezone.utc)
                        .replace(microsecond=0)
                        .isoformat()
                        .replace("+00:00", "Z")
                    )
                except ValueError:
                    pass
            tag = local_tag(title)
            crit = is_critical(title)
            items_out.append(
                {
                    "id": f"atom-{source_label}-{abs(hash(title + link)) % 10**10}",
                    "tag": tag,
                    "src": source_label,
                    "headline": title,
                    "link": link,
                    "time": time_s,
                    "critical": crit,
                    "fed": bool(FED_RE.search(title)),
                    "channel": "newswire",
                }
            )
        return items_out

    for i, item in enumerate(channel_items[:35]):
        title_el = item.find("title")
        title = (title_el.text or "").strip() if title_el is not None else ""
        if not title and title_el is not None:
            title = "".join(title_el.itertext()).strip()
        if not keep_headline(title):
            continue
        link_el = item.find("link")
        link = ""
        if link_el is not None:
            link = (link_el.text or "").strip() or link_el.attrib.get("href", "")
        pub_el = item.find("pubDate")
        time_s = iso_now()
        if pub_el is not None and pub_el.text:
            try:
                dt = parsedate_to_datetime(pub_el.text.strip())
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                time_s = (
                    dt.astimezone(timezone.utc)
                    .replace(microsecond=0)
                    .isoformat()
                    .replace("+00:00", "Z")
                )
            except (TypeError, ValueError, IndexError):
                pass
        tag = local_tag(title)
        crit = is_critical(title)
        items_out.append(
            {
                "id": f"rss-{source_label}-{i}-{abs(hash(title)) % 10**10}",
                "tag": tag,
                "src": source_label,
                "headline": title,
                "link": link,
                "time": time_s,
                "critical": crit,
                "fed": bool(FED_RE.search(title)),
                "channel": "newswire",
            }
        )
    return items_out


def collect_news() -> list[dict]:
    collected: list[dict] = []
    for feed in NEWS_FEEDS:
        try:
            xml = fetch_text(feed["url"], timeout=18.0)
            items = parse_rss(xml, feed["label"])
            print(f"NEWS {feed['label']}: kept {len(items)}", flush=True)
            collected.extend(items)
        except Exception as e:  # noqa: BLE001
            print(f"NEWS FAIL {feed['label']}: {e}", flush=True)
        time.sleep(0.15)

    seen: set[str] = set()
    unique: list[dict] = []

    def _news_sort_key(x: dict):
        crit = 0 if x.get("critical") else 1
        try:
            ts = datetime.fromisoformat(x["time"].replace("Z", "+00:00")).timestamp()
        except Exception:
            ts = 0.0
        return (crit, -ts)

    collected.sort(key=_news_sort_key)
    for n in collected:
        key = (n.get("headline") or "")[:80].lower()
        if key in seen:
            continue
        seen.add(key)
        unique.append(n)
    return unique[:45]


def fetch_screener_symbols(scr_id: str, count: int = 25) -> list[dict]:
    """Yahoo predefined screener → list of {symbol, price, changePct, name}."""
    url = (
        "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved"
        f"?formatted=false&lang=en-US&region=US&scrIds={quote(scr_id, safe='')}&count={count}"
    )
    try:
        raw = fetch_text(url, timeout=18.0)
        data = json.loads(raw)
    except Exception as e:  # noqa: BLE001
        print(f"SCREENER FAIL {scr_id}: {e}", flush=True)
        return []

    quotes = (
        ((data.get("finance") or {}).get("result") or [{}])[0].get("quotes") or []
    )
    out = []
    for q in quotes:
        sym = q.get("symbol")
        if not sym or not re.match(r"^[A-Z][A-Z0-9.\-]{0,8}$", sym):
            continue
        # Skip warrants / preferred
        if any(x in sym for x in ("-W", "-P", "-R", ".WS")):
            continue
        pct = q.get("regularMarketChangePercent")
        price = q.get("regularMarketPrice")
        if price is None:
            continue
        out.append(
            {
                "symbol": sym,
                "name": q.get("shortName") or q.get("longName") or sym,
                "price": float(price),
                "changePct": float(pct) if pct is not None else None,
                "volume": q.get("regularMarketVolume"),
            }
        )
    print(f"SCREENER {scr_id}: {len(out)}", flush=True)
    return out


def compute_1m_pct(symbol: str) -> tuple[float | None, float | None, float | None]:
    """
    Returns (price, pct_1m, day_pct).
    pct_1m = last 1m close vs prior 1m close when bars exist.
    """
    try:
        data = fetch_yahoo_chart_raw(symbol, "1m", "1d")
    except Exception:  # noqa: BLE001
        return None, None, None

    result = (data.get("chart") or {}).get("result") or []
    if not result:
        return None, None, None
    meta = result[0].get("meta") or {}
    quotes = ((result[0].get("indicators") or {}).get("quote") or [{}])[0]
    closes = quotes.get("close") or []
    # Keep last non-null closes
    valid = [float(c) for c in closes if c is not None]
    price = meta.get("regularMarketPrice")
    if price is None and valid:
        price = valid[-1]
    if price is None:
        return None, None, None
    price = float(price)

    pct_1m = None
    if len(valid) >= 2 and valid[-2] != 0:
        pct_1m = ((valid[-1] - valid[-2]) / valid[-2]) * 100.0
    # Also try ~5 bars (~5m) if single-bar noise
    pct_5m = None
    if len(valid) >= 6 and valid[-6] != 0:
        pct_5m = ((valid[-1] - valid[-6]) / valid[-6]) * 100.0

    day_pct = meta.get("regularMarketChangePercent")
    if day_pct is not None:
        day_pct = float(day_pct)
    else:
        prev = meta.get("chartPreviousClose") or meta.get("previousClose")
        if prev and float(prev) != 0:
            day_pct = ((price - float(prev)) / float(prev)) * 100.0

    # Prefer true 1m; if tiny, keep 5m as secondary signal in caller
    return price, pct_1m, day_pct if day_pct is not None else pct_5m


def collect_spikes() -> dict:
    """
    Build spikes.json: 1m movers when Yahoo 1m bars available;
    else day gainers/losers / actives with honest window badge.
    """
    updated = iso_now()
    candidates: dict[str, dict] = {}

    for scr in ("day_gainers", "day_losers", "most_actives"):
        for row in fetch_screener_symbols(scr, 25):
            sym = row["symbol"]
            if sym not in candidates:
                candidates[sym] = row
        time.sleep(0.2)

    for sym in SPIKE_UNIVERSE:
        if sym not in candidates:
            candidates[sym] = {"symbol": sym, "name": sym, "price": None, "changePct": None}

    spikes_1m: list[dict] = []
    unusual_day: list[dict] = []
    all_day: list[dict] = []
    scanned = 0
    one_m_ok = 0

    scan_list = list(candidates.values())
    scan_list.sort(key=lambda r: (0 if r.get("volume") else 1, r["symbol"]))
    scan_list = scan_list[:55]

    for row in scan_list:
        sym = row["symbol"]
        scanned += 1
        try:
            price, pct_1m, day_pct = compute_1m_pct(sym)
            time.sleep(0.08)
        except Exception as e:  # noqa: BLE001
            print(f"SPIKE FAIL {sym}: {e}", flush=True)
            continue

        if price is None:
            # Fall back to screener fields alone
            price = row.get("price")
            day_pct = row.get("changePct") if day_pct is None else day_pct
            if price is None:
                continue
            price = float(price)

        name = row.get("name") or sym
        if pct_1m is not None:
            one_m_ok += 1
            if abs(pct_1m) >= SPIKE_1M_THRESHOLD:
                spikes_1m.append(
                    {
                        "symbol": sym,
                        "name": name,
                        "price": round(float(price), 4),
                        "changePct": round(pct_1m, 4),
                        "window": "1m",
                        "channel": "spike",
                        "volume": row.get("volume"),
                    }
                )

        day = day_pct if day_pct is not None else row.get("changePct")
        if day is not None:
            entry = {
                "symbol": sym,
                "name": name,
                "price": round(float(price), 4),
                "changePct": round(float(day), 4),
                "window": "1d",
                "channel": "spike",
                "volume": row.get("volume"),
            }
            all_day.append(entry)
            if abs(float(day)) >= SPIKE_DAY_THRESHOLD:
                unusual_day.append(entry)

    spikes_1m.sort(key=lambda x: abs(x["changePct"]), reverse=True)
    unusual_day.sort(key=lambda x: abs(x["changePct"]), reverse=True)
    all_day.sort(key=lambda x: abs(x["changePct"]), reverse=True)

    seen_1m = {s["symbol"] for s in spikes_1m}
    unusual_day = [u for u in unusual_day if u["symbol"] not in seen_1m]

    def _is_tradable(entry: dict) -> bool:
        sym = entry["symbol"]
        if not re.match(r"^[A-Z]{1,5}$", sym):
            return False
        if sym in SPIKE_UNIVERSE:
            return True
        vol = entry.get("volume")
        if vol is not None and int(vol) >= 500_000:
            return True
        # Allow strong day moves even without volume field
        if abs(entry.get("changePct") or 0) >= 7 and len(sym) <= 4:
            return True
        return False

    def _liquid_rank(entry: dict) -> tuple:
        sym = entry["symbol"]
        known = 0 if sym in SPIKE_UNIVERSE else 1
        vol = entry.get("volume") or 0
        return (known, -int(vol), -abs(entry["changePct"]))

    def _pick(pool: list[dict], n: int) -> list[dict]:
        ranked = sorted([e for e in pool if _is_tradable(e)], key=_liquid_rank)
        out = []
        seen: set[str] = set()
        for e in ranked:
            if e["symbol"] in seen:
                continue
            seen.add(e["symbol"])
            # Strip volume from shipped JSON (optional field)
            shipped = {k: v for k, v in e.items() if k != "volume"}
            out.append(shipped)
            if len(out) >= n:
                break
        return out

    items = _pick(spikes_1m, 20) + _pick(unusual_day, 15)
    # de-dupe
    _seen: set[str] = set()
    deduped = []
    for e in items:
        if e["symbol"] in _seen:
            continue
        _seen.add(e["symbol"])
        deduped.append(e)
    items = deduped[:25]

    status = "LIVE"
    note = "1m bars from Yahoo where available; day movers as unusual tape"

    if not spikes_1m and not unusual_day:
        items = _pick([u for u in all_day if u["symbol"] not in seen_1m], 20)
        status = "PARTIAL"
        note = "No ≥3% 1m / ≥5% day clears; showing largest day moves (PARTIAL)"
    elif not spikes_1m:
        status = "PARTIAL"
        note = f"No ≥{SPIKE_1M_THRESHOLD:g}% 1m clears right now; day unusual movers shown"

    print(
        f"SPIKES scanned={scanned} 1m_ok={one_m_ok} "
        f"spikes_1m={len(spikes_1m)} day={len(unusual_day)} status={status}",
        flush=True,
    )

    return {
        "updated": updated,
        "status": status,
        "threshold1m": SPIKE_1M_THRESHOLD,
        "note": note,
        "items": items,
        "channel": "spike",
    }


def write_json(path: Path, obj: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def main() -> int:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    updated = iso_now()

    quotes = collect_quotes()
    quotes_payload = {"updated": updated, "quotes": quotes}
    write_json(DATA_DIR / "quotes.json", quotes_payload)
    print(f"Wrote {DATA_DIR / 'quotes.json'} ({len(quotes)} symbols)", flush=True)

    news_items = collect_news()
    news_payload = {
        "updated": updated,
        "channel": "newswire",
        "items": news_items,
    }
    write_json(DATA_DIR / "news.json", news_payload)
    print(f"Wrote {DATA_DIR / 'news.json'} ({len(news_items)} items)", flush=True)

    spikes_payload = collect_spikes()
    write_json(DATA_DIR / "spikes.json", spikes_payload)
    print(
        f"Wrote {DATA_DIR / 'spikes.json'} ({len(spikes_payload.get('items') or [])} items)",
        flush=True,
    )

    if not quotes:
        print("WARNING: no quotes fetched", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
