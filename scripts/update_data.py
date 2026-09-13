#!/usr/bin/env python3
"""Fetch Yahoo chart quotes + business RSS into same-origin data/*.json for GitHub Pages."""

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
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
)

# Primary Yahoo symbols shipped in quotes.json keys
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

# If primary fails, try these (Stoxx / others)
SYMBOL_FALLBACKS = {
    "^STOXX50E": ["^STOXX", "EXSA.DE"],
}

NEWS_FEEDS = [
    {
        "label": "CNBC",
        "url": "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114",
    },
    {
        "label": "BBC",
        "url": "https://feeds.bbci.co.uk/news/business/rss.xml",
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

# STRICT: drop personal finance / lifestyle
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
    r"will (and|or) testament|inheritance tips?|life insurance tips?",
    re.I,
)

# KEEP signal: markets / macro / equities / futures / oil / Fed / rates / geopolitics-with-markets
NEWS_KEEP = re.compile(
    r"\b(market|markets|stock|stocks|equity|equities|share|shares|index|indices|"
    r"nasdaq|dow|s&?p|nikkei|hang seng|stoxx|ftse|dax|"
    r"future|futures|\bes\b|\bnq\b|oil|wti|brent|crude|opec|"
    r"fed\b|fomc|ecb|boe|rate|rates|yield|treasury|bond|bonds|"
    r"cpi|ppi|inflation|gdp|payroll|jobs report|unemployment|"
    r"earnings|ipo|rally|selloff|volatility|vix|"
    r"geopolit|tariff|sanction|war|conflict|china|europe|"
    r"commodit|gold|copper|dollar|forex|currency|"
    r"wall street|wall st|trading|trader|hedge fund|bank|"
    r"recession|stimulus|policy|central bank)\b",
    re.I,
)

CTX = ssl.create_default_context()


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

    # Prefer Yahoo's changePct; only derive both from prev when pct missing
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

    out = {
        "price": round_num(price),
        "change": round_num(change),
        "changePct": round_num(change_pct, 4),
    }
    return out


def fetch_yahoo_quote(symbol: str) -> dict:
    from urllib.parse import quote

    url = (
        "https://query1.finance.yahoo.com/v8/finance/chart/"
        + quote(symbol, safe="")
        + "?interval=1d&range=5d"
    )
    raw = fetch_text(url, timeout=15.0)
    data = json.loads(raw)
    if (data.get("chart") or {}).get("error"):
        raise ValueError(str(data["chart"]["error"]))
    return parse_yahoo_chart(data)


def collect_quotes() -> dict:
    quotes: dict = {}
    for primary in SYMBOLS:
        candidates = [primary] + SYMBOL_FALLBACKS.get(primary, [])
        last_err: Exception | None = None
        for sym in candidates:
            try:
                q = fetch_yahoo_quote(sym)
                # Always key under the primary UI symbol
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
        time.sleep(0.15)
    return quotes


def local_tag(title: str) -> str:
    t = (title or "").lower()
    if re.search(
        r"fed|ecb|cpi|inflation|gdp|treasury|yield|rate cut|fomc|jobs|payroll|macro|"
        r"oil|opec|brent|crude|bank of england|boe|geopolit|tariff|war|sanction",
        t,
    ):
        return "macro"
    if re.search(r"future|futures|\bes\b|\bnq\b|commodity|oil price|wti", t):
        return "futures"
    if re.search(
        r"stock|equity|shares|nasdaq|dow|s&p|earnings|ipo|rally|selloff|megacap|tech|share price",
        t,
    ):
        return "equities"
    return "macro"


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

    # RSS 2.0 or Atom
    channel_items = root.findall(".//item")
    if not channel_items:
        # Atom
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
            items_out.append(
                {
                    "id": f"atom-{source_label}-{abs(hash(title + link)) % 10**10}",
                    "tag": local_tag(title),
                    "src": source_label,
                    "headline": title,
                    "link": link,
                    "time": time_s,
                }
            )
        return items_out

    for i, item in enumerate(channel_items[:30]):
        title_el = item.find("title")
        title = (title_el.text or "").strip() if title_el is not None else ""
        # Some feeds nest CDATA oddly; also try text of children
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
        items_out.append(
            {
                "id": f"rss-{source_label}-{i}-{abs(hash(title)) % 10**10}",
                "tag": local_tag(title),
                "src": source_label,
                "headline": title,
                "link": link,
                "time": time_s,
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
        time.sleep(0.2)

    # Dedupe by headline prefix
    seen: set[str] = set()
    unique: list[dict] = []
    collected.sort(key=lambda x: x.get("time") or "", reverse=True)
    for n in collected:
        key = (n.get("headline") or "")[:80].lower()
        if key in seen:
            continue
        seen.add(key)
        unique.append(n)
    return unique[:40]


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
    news_payload = {"updated": updated, "items": news_items}
    write_json(DATA_DIR / "news.json", news_payload)
    print(f"Wrote {DATA_DIR / 'news.json'} ({len(news_items)} items)", flush=True)

    if not quotes:
        print("WARNING: no quotes fetched", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
