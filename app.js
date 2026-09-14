/**
 * Wire Terminal — markets desk client
 *
 * PRIMARY: same-origin data/quotes.json + data/news.json (GitHub Pages safe).
 * Optional live Yahoo via local /proxy or CORS proxies; if live fails, keep
 * same-origin JSON — never UNAVAILABLE when static prices exist.
 * Clocks are 12-hour with AM/PM. Refresh ~1s with in-flight guard.
 */
(function () {
  "use strict";

  const REFRESH_MS = 1000;

  const INDICES = [
    { id: "^GSPC", label: "S&P 500", short: "SPX" },
    { id: "^IXIC", label: "NASDAQ", short: "COMP" },
    { id: "^DJI", label: "DOW", short: "DJI" },
    { id: "^STOXX50E", label: "STOXX 50", short: "SX5E" },
    { id: "^N225", label: "NIKKEI", short: "NKY" },
    { id: "^HSI", label: "HANG SENG", short: "HSI" },
  ];

  const SYMBOL_FALLBACKS = {
    "^STOXX50E": ["^STOXX", "EXSA.DE"],
  };

  /** Yahoo → Stooq last-quote symbols (backup when Yahoo proxies fail). */
  const STOOQ_MAP = {
    "^GSPC": "^spx",
    "^DJI": "^dji",
    "^IXIC": ["^ndq", "^ixic", "^ndx"],
    "^N225": "^nkx",
    "^HSI": "^hsi",
    "^STOXX50E": ["^sx5e", "^sxxp"],
    "ES=F": "es.f",
    "NQ=F": "nq.f",
    "CL=F": "cl.f",
    "BZ=F": "brn.f",
    "^TNX": ["10yty.b", "us10y"],
    "ZN=F": ["zn.f", "ty.f"],
  };

  const FUTURES = [
    {
      section: "EQUITY INDEX",
      items: [
        { id: "ES=F", label: "ES", name: "S&P 500 Fut" },
        { id: "NQ=F", label: "NQ", name: "Nasdaq 100 Fut" },
      ],
    },
    {
      section: "ENERGY",
      items: [
        { id: "CL=F", label: "WTI", name: "Crude Oil" },
        { id: "BZ=F", label: "BRENT", name: "Brent Crude" },
      ],
    },
    {
      section: "RATES",
      items: [
        { id: "^TNX", label: "US10Y", name: "10Y Yield %" },
        { id: "ZN=F", label: "ZN", name: "10Y Note Fut" },
      ],
    },
  ];

  const SEED_NEWS = [
    {
      id: "seed-1",
      tag: "macro",
      src: "WIRE",
      headline:
        "Awaiting live wire — Fed speakers and CPI path remain key macro focus",
      seed: true,
    },
    {
      id: "seed-2",
      tag: "equities",
      src: "WIRE",
      headline:
        "Index strip populates from Yahoo Finance when fetch succeeds",
      seed: true,
    },
    {
      id: "seed-3",
      tag: "futures",
      src: "WIRE",
      headline: "ES / NQ / oil / US10Y refresh on the same ~1s cycle as indices",
      seed: true,
    },
    {
      id: "seed-4",
      tag: "macro",
      src: "WIRE",
      headline:
        "News: CNBC / MarketWatch / BBC / Yahoo RSS via proxy fallbacks",
      seed: true,
    },
  ];

  const CATALYSTS = [
    {
      when: "THIS WEEK",
      title: "US CPI / PPI prints",
      note: "Inflation data continues to drive rates pricing and equity multiples.",
      impact: "high",
    },
    {
      when: "THIS WEEK",
      title: "FOMC speakers / minutes window",
      note: "Watch for shifts in cut timing language vs sticky services inflation.",
      impact: "high",
    },
    {
      when: "ONGOING",
      title: "Earnings season — mega-cap tech",
      note: "Guidance and capex (AI) commentary remain the equity catalyst stack.",
      impact: "high",
    },
    {
      when: "ONGOING",
      title: "Oil inventory & OPEC+ signals",
      note: "WTI/Brent responsive to DOE inventories and supply discipline headlines.",
      impact: "med",
    },
    {
      when: "SESSION",
      title: "US equity open / cash close",
      note: "Futures → cash handover; watch ES/NQ basis into the open.",
      impact: "med",
    },
    {
      when: "ASIA",
      title: "Nikkei / Hang Seng open",
      note: "Regional risk tone often sets overnight futures direction.",
      impact: "low",
    },
    {
      when: "EUROPE",
      title: "Stoxx open & ECB calendar",
      note: "EU data and policy remarks can move Stoxx and EUR crosses.",
      impact: "med",
    },
  ];

  const NEWS_FEEDS = [
    {
      label: "CNBC",
      url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114",
    },
    {
      label: "MARKETWATCH",
      url: "https://feeds.content.dowjones.io/public/rss/mw_topstories",
    },
    {
      label: "BBC",
      url: "https://feeds.bbci.co.uk/news/business/rss.xml",
    },
    {
      label: "YAHOO",
      url: "https://feeds.finance.yahoo.com/rss/2.0/headline?s=%5EGSPC&region=US&lang=en-US",
    },
  ];

  /** Personal-finance / lifestyle fluff — drop from the wire. */
  const NEWS_DENY =
    /retirement|annuit(y|ies)|social security|cola\b|401\s*\(?k\)?|roth\b|when you die|what should i do|estate (plan|tax)|trade a job|work[- ]life balance|what should i do with my money|how to (save|invest|budget)|best (credit cards?|savings|cd rates)|personal finance|nest egg|side hustle|millionaire next door|fire movement|passive income tips|should you (buy|sell|refinance)|refinance your|mortgage tips|debt payoff|emergency fund|lifestyle (inflation|creep)|medicare (advantage|supplement)|long[- ]term care insurance|penny stocks? tip/i;

  let newsFilter = "all";
  let newsItems = [];
  let newsStatus = "SEED";
  let useLocalProxy = false;
  let refreshTimer = null;
  let refreshInFlight = false;
  let refreshQueued = false;

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  /** 12-hour clock with AM/PM, e.g. 3:39:49 PM */
  function formatClock(d, utc) {
    const h24 = utc ? d.getUTCHours() : d.getHours();
    const m = utc ? d.getUTCMinutes() : d.getMinutes();
    const s = utc ? d.getUTCSeconds() : d.getSeconds();
    const ampm = h24 >= 12 ? "PM" : "AM";
    let h12 = h24 % 12;
    if (h12 === 0) h12 = 12;
    return h12 + ":" + pad(m) + ":" + pad(s) + " " + ampm;
  }

  function formatTimeShort(d) {
    const h24 = d.getHours();
    const ampm = h24 >= 12 ? "PM" : "AM";
    let h12 = h24 % 12;
    if (h12 === 0) h12 = 12;
    return h12 + ":" + pad(d.getMinutes()) + " " + ampm;
  }

  function updateSessions(now) {
    const utcH = now.getUTCHours() + now.getUTCMinutes() / 60;
    const specs = [
      { key: "asia", open: 0, close: 8 },
      { key: "europe", open: 7, close: 16 },
      { key: "us", open: 13.5, close: 20 },
    ];
    specs.forEach(({ key, open, close }) => {
      const el = $(`.session[data-session="${key}"]`);
      if (!el) return;
      el.classList.remove("active", "closing");
      if (utcH >= open && utcH < close) {
        el.classList.add("active");
        if (utcH >= close - 1) el.classList.add("closing");
      }
    });
  }

  function tickClocks() {
    const now = new Date();
    const localEl = $("#clock-local .clock-time");
    const utcEl = $("#clock-utc .clock-time");
    if (localEl) localEl.textContent = formatClock(now, false);
    if (utcEl) utcEl.textContent = formatClock(now, true);
    const foot = $("#footer-clock");
    if (foot) {
      foot.textContent =
        now.toLocaleString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
          year: "numeric",
          hour: "numeric",
          minute: "2-digit",
          second: "2-digit",
          hour12: true,
        }) + " · " + formatClock(now, true) + " UTC";
    }
    updateSessions(now);
  }

  function fmtPrice(n, digits) {
    if (n == null || Number.isNaN(n)) return "—";
    const d =
      digits != null
        ? digits
        : Math.abs(n) >= 1000
          ? 2
          : Math.abs(n) >= 100
            ? 2
            : 3;
    return Number(n).toLocaleString(undefined, {
      minimumFractionDigits: d,
      maximumFractionDigits: d,
    });
  }

  function fmtPct(n) {
    if (n == null || Number.isNaN(n)) return "—";
    const sign = n > 0 ? "+" : "";
    return sign + n.toFixed(2) + "%";
  }

  function chgClass(n) {
    if (n == null || Number.isNaN(n) || n === 0) return "chg-flat";
    return n > 0 ? "chg-up" : "chg-down";
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, "&#39;");
  }

  /* —— Fetch layer —— */

  async function detectLocalProxy() {
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      if (!res.ok) return false;
      const j = await res.json();
      return !!j.ok;
    } catch (_) {
      return false;
    }
  }

  function localProxyUrl(url) {
    return "/proxy?url=" + encodeURIComponent(url);
  }

  /** Try in order — corsproxy.io free for github.io; allorigins; codetabs. */
  const CORS_PROXIES = [
    function (url) {
      return "https://corsproxy.io/?" + encodeURIComponent(url);
    },
    function (url) {
      return "https://corsproxy.io/?url=" + encodeURIComponent(url);
    },
    function (url) {
      return "https://api.allorigins.win/raw?url=" + encodeURIComponent(url);
    },
    function (url) {
      return "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(url);
    },
  ];

  function looksLikeUsefulBody(text) {
    if (!text || text.length < 8) return false;
    const t = text.trim();
    if (t.charAt(0) === "{" || t.charAt(0) === "[") return true;
    if (/^Symbol,/i.test(t) || /^"[Ss]ymbol"/i.test(t)) return true;
    if (t.indexOf("<rss") !== -1 || t.indexOf("<feed") !== -1) return true;
    if (t.indexOf("<item") !== -1 || t.indexOf("<channel") !== -1) return true;
    if (t.indexOf('"chart"') !== -1 || t.indexOf('"meta"') !== -1) return true;
    if (/^[\w.^]+,/.test(t) && t.split("\n").length >= 2) return true;
    return false;
  }

  async function fetchText(url, timeoutMs) {
    timeoutMs = timeoutMs || 10000;
    const attempts = [];
    if (useLocalProxy) attempts.push(localProxyUrl(url));
    attempts.push(url);
    CORS_PROXIES.forEach(function (fn) {
      attempts.push(fn(url));
    });
    // allorigins JSON envelope as last resort
    attempts.push(
      "https://api.allorigins.win/get?url=" + encodeURIComponent(url)
    );

    let lastErr;
    for (let i = 0; i < attempts.length; i++) {
      const endpoint = attempts[i];
      const controller = new AbortController();
      const t = setTimeout(function () {
        controller.abort();
      }, timeoutMs);
      try {
        const res = await fetch(endpoint, {
          signal: controller.signal,
          cache: "no-store",
          headers: {
            Accept: "application/json, application/xml, text/xml, text/csv, */*",
          },
        });
        clearTimeout(t);
        if (!res.ok) throw new Error("HTTP " + res.status);
        let text = await res.text();
        // Unwrap allorigins /get envelope
        if (
          endpoint.indexOf("allorigins.win/get") !== -1 &&
          text.trim().charAt(0) === "{"
        ) {
          try {
            const wrap = JSON.parse(text);
            if (typeof wrap.contents === "string") text = wrap.contents;
          } catch (_) {
            /* keep raw */
          }
        }
        if (!looksLikeUsefulBody(text)) {
          throw new Error("empty/useless body");
        }
        return text;
      } catch (e) {
        clearTimeout(t);
        lastErr = e;
      }
    }
    throw lastErr || new Error("fetch failed");
  }

  async function fetchJson(url, timeoutMs) {
    return JSON.parse(await fetchText(url, timeoutMs));
  }

  function parseYahooChart(data) {
    const result =
      data && data.chart && data.chart.result && data.chart.result[0];
    if (!result) throw new Error("No chart result");
    const meta = result.meta || {};
    const quotes =
      result.indicators &&
      result.indicators.quote &&
      result.indicators.quote[0];
    const closes =
      (quotes &&
        quotes.close &&
        quotes.close.filter(function (c) {
          return c != null;
        })) ||
      [];
    const price =
      meta.regularMarketPrice != null
        ? meta.regularMarketPrice
        : meta.postMarketPrice != null
          ? meta.postMarketPrice
          : closes[closes.length - 1];
    if (price == null) throw new Error("No price");

    let changePct =
      meta.regularMarketChangePercent != null
        ? meta.regularMarketChangePercent
        : null;
    let change =
      meta.regularMarketChange != null ? meta.regularMarketChange : null;

    if (changePct == null) {
      const prev =
        meta.chartPreviousClose != null
          ? meta.chartPreviousClose
          : meta.previousClose != null
            ? meta.previousClose
            : closes.length >= 2
              ? closes[closes.length - 2]
              : null;
      if (prev != null && prev !== 0) {
        change = price - prev;
        changePct = (change / prev) * 100;
      }
    }

    return {
      symbol: meta.symbol,
      price: price,
      change: change,
      changePct: changePct,
      currency: meta.currency,
      name: meta.shortName || meta.longName || meta.symbol,
      source: "yahoo",
    };
  }

  async function fetchYahooQuote(symbol) {
    const url =
      "https://query1.finance.yahoo.com/v8/finance/chart/" +
      encodeURIComponent(symbol) +
      "?interval=1d&range=5d";
    const data = await fetchJson(url, 9000);
    return parseYahooChart(data);
  }

  function parseStooqCsv(text) {
    const lines = text
      .trim()
      .split(/\r?\n/)
      .filter(function (l) {
        return l.trim().length;
      });
    if (lines.length < 2) throw new Error("Stooq empty");
    const header = lines[0].toLowerCase().split(",");
    const row = lines[1].split(",");
    function col(name) {
      const i = header.indexOf(name);
      return i >= 0 ? row[i] : null;
    }
    let close = parseFloat(col("close"));
    if (Number.isNaN(close)) {
      // fallback positional: Symbol,Date,Time,Open,High,Low,Close,Volume
      close = parseFloat(row[6]);
    }
    if (Number.isNaN(close)) throw new Error("Stooq no close");
    const open = parseFloat(col("open") != null ? col("open") : row[3]);
    let changePct = null;
    let change = null;
    if (!Number.isNaN(open) && open !== 0) {
      change = close - open;
      changePct = (change / open) * 100;
    }
    return {
      symbol: (col("symbol") || row[0] || "").replace(/"/g, ""),
      price: close,
      change: change,
      changePct: changePct,
      source: "stooq",
    };
  }

  async function fetchStooqQuote(stooqSym) {
    const url =
      "https://stooq.com/q/l/?s=" +
      encodeURIComponent(stooqSym) +
      "&f=sd2t2ohlcv&h&e=csv";
    const text = await fetchText(url, 8000);
    if (/does not exist|nie istnieje|verify your browser/i.test(text)) {
      throw new Error("Stooq blocked/missing");
    }
    return parseStooqCsv(text);
  }

  async function fetchQuoteForSymbol(primary) {
    const yahooList = [primary].concat(SYMBOL_FALLBACKS[primary] || []);
    let lastErr;
    for (let i = 0; i < yahooList.length; i++) {
      try {
        const q = await fetchYahooQuote(yahooList[i]);
        q.requested = primary;
        return q;
      } catch (e) {
        lastErr = e;
      }
    }

    const mapped = STOOQ_MAP[primary];
    if (mapped) {
      const list = Array.isArray(mapped) ? mapped : [mapped];
      for (let j = 0; j < list.length; j++) {
        try {
          const q = await fetchStooqQuote(list[j]);
          q.requested = primary;
          return q;
        } catch (e) {
          lastErr = e;
        }
      }
    }

    throw lastErr || new Error("Quote failed");
  }

  /** Bound concurrency so 1s refresh + many symbols don't stampede proxies. */
  async function mapPool(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;
    async function run() {
      while (next < items.length) {
        const i = next++;
        try {
          results[i] = { status: "fulfilled", value: await worker(items[i], i) };
        } catch (e) {
          results[i] = { status: "rejected", reason: e };
        }
      }
    }
    const runners = [];
    for (let r = 0; r < Math.min(limit, items.length); r++) {
      runners.push(run());
    }
    await Promise.all(runners);
    return results;
  }

  /* —— Render indices / futures —— */

  function renderIndices(quotesMap, mode) {
    const strip = $("#indices-strip");
    if (!strip) return;
    strip.innerHTML = INDICES.map(function (idx) {
      const q = quotesMap[idx.id];
      const unavailable = !q || q.error;
      let priceHtml = "—";
      let chgHtml = "—";
      let cls = "chg-flat";
      let badge = "";
      if (unavailable) {
        badge = '<span class="index-badge">UNAVAILABLE</span>';
      } else {
        priceHtml = fmtPrice(q.price);
        chgHtml = fmtPct(q.changePct);
        cls = chgClass(q.changePct);
        if (mode === "demo") badge = '<span class="index-badge">DEMO</span>';
      }
      return (
        '<div class="index-card" data-symbol="' +
        idx.id +
        '">' +
        '<div class="index-name">' +
        idx.label +
        badge +
        "</div>" +
        '<div class="index-row">' +
        '<span class="index-price">' +
        priceHtml +
        "</span>" +
        '<span class="index-chg ' +
        cls +
        '">' +
        chgHtml +
        "</span>" +
        "</div></div>"
      );
    }).join("");
  }

  function renderFutures(quotesMap, mode) {
    const body = $("#futures-body");
    const badge = $("#futures-badge");
    if (!body) return;

    let anyLive = false;
    let anyFail = false;

    const html = FUTURES.map(function (sec) {
      const rows = sec.items
        .map(function (item) {
          const q = quotesMap[item.id];
          if (!q || q.error) {
            anyFail = true;
            return (
              '<div class="fut-row"><div>' +
              '<span class="fut-sym">' +
              item.label +
              "</span>" +
              '<span class="fut-name">' +
              item.name +
              " · UNAVAILABLE</span></div>" +
              '<span class="fut-price">—</span>' +
              '<span class="fut-chg chg-flat">—</span></div>'
            );
          }
          anyLive = true;
          const dig = item.id === "^TNX" ? 3 : undefined;
          return (
            '<div class="fut-row"><div>' +
            '<span class="fut-sym">' +
            item.label +
            "</span>" +
            '<span class="fut-name">' +
            item.name +
            (mode === "demo" ? " · DEMO" : "") +
            "</span></div>" +
            '<span class="fut-price">' +
            fmtPrice(q.price, dig) +
            "</span>" +
            '<span class="fut-chg ' +
            chgClass(q.changePct) +
            '">' +
            fmtPct(q.changePct) +
            "</span></div>"
          );
        })
        .join("");
      return '<div class="fut-section">' + sec.section + "</div>" + rows;
    }).join("");

    body.innerHTML = html;

    if (badge) {
      badge.className = "panel-badge";
      if (mode === "demo") {
        badge.textContent = "DEMO";
        badge.classList.add("demo");
      } else if (anyLive && !anyFail) {
        badge.textContent = "LIVE";
        badge.classList.add("live");
      } else if (anyLive) {
        badge.textContent = "PARTIAL";
        badge.classList.add("demo");
      } else {
        badge.textContent = "UNAVAILABLE";
        badge.classList.add("unavailable");
      }
    }
  }

  /* —— News —— */

  function isDeniedHeadline(title) {
    return NEWS_DENY.test(title || "");
  }

  function classifyHeadline(title) {
    const t = (title || "").toLowerCase();
    if (
      /fed|ecb|cpi|inflation|gdp|treasury|yield|rate cut|fomc|jobs|payroll|macro|oil|opec|brent|crude|bank of england|boe/.test(
        t
      )
    )
      return "macro";
    if (/future|futures|\bes\b|\bnq\b|commodity|oil price|wti/.test(t))
      return "futures";
    if (
      /stock|equity|shares|nasdaq|dow|s&p|earnings|ipo|rally|selloff|megacap|tech|share price/.test(
        t
      )
    )
      return "equities";
    return "macro";
  }

  /** Market-moving breaks: earnings surprise, CEO resign, M&A, FDA, Fed decision, oil emergency. */
  function isCriticalHeadline(title) {
    const t = (title || "").toLowerCase();
    return /earnings (beat|miss|surprise)|beats? (estimates?|expectations?)|misses? (estimates?|expectations?)|ceo (resign|steps down|ousted|fired)|chief executive (resign|steps down)|\b(m&a|merger|acquisition|acquire[sd]?|buyout|takeover)\b|\bfda\b (approv|reject|crl|warning)|fed (decision|rate (cut|hike|hold)|cuts rates|hikes rates)|fomc (decision|statement)|oil (supply )?(emergency|disruption|shock|halt)|pipeline (halt|explosion|attack)|opec (emergency|cuts production)/.test(
      t
    );
  }

  function isCriticalItem(n) {
    if (!n) return false;
    if (n.critical === true) return true;
    var tag = (n.tag || "").toLowerCase();
    if (tag === "breaking" || tag === "critical") return true;
    return isCriticalHeadline(n.headline || n.title || "");
  }

  function parseRssItems(xmlText, sourceLabel) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, "text/xml");
    const items = Array.prototype.slice.call(doc.querySelectorAll("item"), 0, 25);
    return items
      .map(function (item, i) {
        const title =
          (item.querySelector("title") &&
            item.querySelector("title").textContent.trim()) ||
          "Untitled";
        if (isDeniedHeadline(title)) return null;
        const linkEl = item.querySelector("link");
        const link = (linkEl && linkEl.textContent.trim()) || "";
        const pub =
          (item.querySelector("pubDate") &&
            item.querySelector("pubDate").textContent) ||
          "";
        let d = pub ? new Date(pub) : new Date();
        if (Number.isNaN(d.getTime())) d = new Date();
        var tag = classifyHeadline(title);
        var crit = isCriticalHeadline(title) || tag === "breaking";
        return {
          id: "rss-" + sourceLabel + "-" + i + "-" + d.getTime(),
          time: d,
          tag: tag,
          src: sourceLabel,
          headline: title,
          link: link,
          critical: crit,
          seed: false,
        };
      })
      .filter(Boolean);
  }

  async function fetchNews() {
    const collected = [];

    for (let f = 0; f < NEWS_FEEDS.length; f++) {
      const feed = NEWS_FEEDS[f];
      try {
        if (!useLocalProxy) {
          try {
            const rss2 =
              "https://api.rss2json.com/v1/api.json?rss_url=" +
              encodeURIComponent(feed.url);
            const controller = new AbortController();
            const t = setTimeout(function () {
              controller.abort();
            }, 8000);
            const res = await fetch(rss2, { signal: controller.signal });
            clearTimeout(t);
            if (res.ok) {
              const json = await res.json();
              if (json.status === "ok" && Array.isArray(json.items)) {
                json.items.slice(0, 12).forEach(function (it, i) {
                  const title = (it.title || "").trim();
                  if (!title || isDeniedHeadline(title)) return;
                  const d = it.pubDate ? new Date(it.pubDate) : new Date();
                  var tag = classifyHeadline(title);
                  var crit = isCriticalHeadline(title) || tag === "breaking";
                  collected.push({
                    id: "r2j-" + feed.label + "-" + i + "-" + d.getTime(),
                    time: Number.isNaN(d.getTime()) ? new Date() : d,
                    tag: tag,
                    src: feed.label,
                    headline: title,
                    link: it.link || it.url || "",
                    critical: crit,
                    seed: false,
                  });
                });
                continue;
              }
            }
          } catch (_) {
            /* fall through */
          }
        }

        const xml = await fetchText(feed.url, 10000);
        collected.push.apply(collected, parseRssItems(xml, feed.label));
      } catch (_) {
        /* next feed */
      }
    }

    if (!collected.length) return null;

    collected.sort(function (a, b) {
      return b.time - a.time;
    });
    const seen = {};
    const unique = [];
    for (let i = 0; i < collected.length; i++) {
      const n = collected[i];
      const key = n.headline.slice(0, 80).toLowerCase();
      if (seen[key]) continue;
      seen[key] = true;
      unique.push(n);
    }
    return unique.slice(0, 40);
  }

  function flashTimeLabel(d) {
    if (!d) return "--:--";
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    if (sameDay) return formatTimeShort(d);
    return pad(d.getMonth() + 1) + "/" + pad(d.getDate());
  }

  function renderNews() {
    const body = $("#news-body");
    const badge = $("#news-badge");
    if (!body) return;

    const filtered =
      newsFilter === "all"
        ? newsItems
        : newsItems.filter(function (n) {
            return n.tag === newsFilter;
          });

    if (!filtered.length) {
      body.innerHTML = '<div class="loading-row">No flashes for filter.</div>';
    } else {
      body.innerHTML = filtered
        .map(function (n) {
          const critical = isCriticalItem(n);
          const tagLabel = critical
            ? "breaking"
            : n.tag === "breaking"
              ? "breaking"
              : n.tag;
          const tagClass = critical || tagLabel === "breaking"
            ? "breaking tag-breaking"
            : n.tag;
          const headline = n.link
            ? '<a class="flash-headline" href="' +
              escapeAttr(n.link) +
              '" target="_blank" rel="noopener noreferrer">' +
              escapeHtml(n.headline) +
              "</a>"
            : '<div class="flash-headline">' +
              escapeHtml(n.headline) +
              "</div>";
          return (
            '<article class="flash news-item ' +
            (n.seed ? "seed " : "") +
            (critical ? "critical " : "") +
            '" data-tag="' +
            (n.tag || "") +
            '" data-critical="' +
            (critical ? "true" : "false") +
            '">' +
            '<div class="flash-time">' +
            flashTimeLabel(n.time) +
            "</div><div>" +
            '<div class="flash-meta">' +
            '<span class="flash-tag ' +
            tagClass +
            '">' +
            String(tagLabel).toUpperCase() +
            "</span>" +
            '<span class="flash-src">' +
            escapeHtml(n.src) +
            "</span></div>" +
            headline +
            "</div></article>"
          );
        })
        .join("");
    }

    if (badge) {
      badge.className = "panel-badge";
      var anyCritical = newsItems.some(function (n) {
        return isCriticalItem(n);
      });
      if (anyCritical) {
        badge.textContent = "BREAKING";
        badge.classList.add("breaking");
      } else {
        badge.textContent = newsStatus;
        if (newsStatus === "LIVE") badge.classList.add("live");
        else if (newsStatus === "SEED" || newsStatus === "DEMO")
          badge.classList.add("demo");
        else badge.classList.add("unavailable");
      }
    }
  }

  function renderWatch() {
    const body = $("#watch-body");
    if (!body) return;
    body.innerHTML = CATALYSTS.map(function (c) {
      return (
        '<div class="cat-item">' +
        '<div class="cat-when">' +
        escapeHtml(c.when) +
        "</div>" +
        '<div class="cat-title">' +
        escapeHtml(c.title) +
        "</div>" +
        '<div class="cat-note">' +
        escapeHtml(c.note) +
        "</div>" +
        '<span class="cat-impact ' +
        c.impact +
        '">' +
        c.impact.toUpperCase() +
        " IMPACT</span></div>"
      );
    }).join("");
  }

  function setMarketStatus(mode) {
    const el = $("#data-status");
    if (!el) return;
    el.className = "status-pill";
    if (mode === "live") {
      el.textContent = "LIVE";
      el.classList.add("live");
    } else if (mode === "demo") {
      el.textContent = "DEMO";
      el.classList.add("demo");
    } else if (mode === "unavailable") {
      el.textContent = "UNAVAILABLE";
      el.classList.add("unavailable");
    } else {
      el.textContent = mode;
    }
  }

  function setLastRefresh(date) {
    const el = $("#last-refresh");
    if (!el) return;
    el.textContent = "LAST " + formatClock(date, false);
  }

  /** Illustrative placeholders only — shown with DEMO badges. */
  function demoQuotes() {
    return {
      "^GSPC": { price: 5620.0, changePct: 0.42 },
      "^IXIC": { price: 17850.0, changePct: 0.65 },
      "^DJI": { price: 41200.0, changePct: 0.18 },
      "^STOXX50E": { price: 520.0, changePct: -0.22 },
      "^N225": { price: 39200.0, changePct: 0.91 },
      "^HSI": { price: 17800.0, changePct: -0.55 },
      "ES=F": { price: 5645.0, changePct: 0.35 },
      "NQ=F": { price: 20120.0, changePct: 0.58 },
      "CL=F": { price: 78.4, changePct: -0.8 },
      "BZ=F": { price: 82.1, changePct: -0.65 },
      "^TNX": { price: 3.95, changePct: 0.02 },
      "ZN=F": { price: 111.2, changePct: -0.12 },
    };
  }

  function allSymbols() {
    return INDICES.map(function (i) {
      return i.id;
    }).concat(
      FUTURES.reduce(function (acc, s) {
        return acc.concat(
          s.items.map(function (i) {
            return i.id;
          })
        );
      }, [])
    );
  }

  function countOkQuotes(map) {
    var n = 0;
    Object.keys(map || {}).forEach(function (k) {
      var q = map[k];
      if (q && !q.error && q.price != null && !Number.isNaN(q.price)) n++;
    });
    return n;
  }

  /** Same-origin JSON shipped with the static site (GitHub Pages). */
  async function loadSameOriginQuotes() {
    try {
      var res = await fetch("data/quotes.json", { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      var data = await res.json();
      var src = (data && data.quotes) || {};
      var map = {};
      allSymbols().forEach(function (sym) {
        var q = src[sym];
        if (q && q.price != null && !Number.isNaN(Number(q.price))) {
          map[sym] = {
            price: Number(q.price),
            change: q.change != null ? Number(q.change) : null,
            changePct: q.changePct != null ? Number(q.changePct) : null,
            source: "static",
          };
        } else {
          map[sym] = { error: true };
        }
      });
      return { map: map, updated: data && data.updated, ok: countOkQuotes(map) };
    } catch (e) {
      return { map: null, updated: null, ok: 0, error: e };
    }
  }

  async function loadSameOriginNews() {
    try {
      var res = await fetch("data/news.json", { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      var data = await res.json();
      var items = (data && data.items) || [];
      var out = [];
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var title = (it.headline || it.title || "").trim();
        if (!title || isDeniedHeadline(title)) continue;
        var d = it.time ? new Date(it.time) : new Date();
        if (Number.isNaN(d.getTime())) d = new Date();
        var tag = it.tag || classifyHeadline(title);
        var crit =
          it.critical === true ||
          String(tag).toLowerCase() === "breaking" ||
          String(tag).toLowerCase() === "critical" ||
          isCriticalHeadline(title);
        out.push({
          id: it.id || "static-" + i + "-" + d.getTime(),
          time: d,
          tag: tag,
          src: it.src || "WIRE",
          headline: title,
          link: it.link || "",
          critical: crit,
          seed: false,
        });
      }
      out.sort(function (a, b) {
        return b.time - a.time;
      });
      return out;
    } catch (_) {
      return null;
    }
  }

  async function fetchLiveQuotesMap() {
    var symbols = allSymbols();
    var map = {};
    var ok = 0;
    var results = await mapPool(symbols, 4, async function (sym) {
      return { sym: sym, q: await fetchQuoteForSymbol(sym) };
    });
    results.forEach(function (r, i) {
      var sym = symbols[i];
      if (r && r.status === "fulfilled") {
        map[sym] = r.value.q;
        ok++;
      } else {
        map[sym] = { error: true };
      }
    });
    return { map: map, ok: ok };
  }

  async function loadMarkets() {
    var staticResult = await loadSameOriginQuotes();
    var live = { map: null, ok: 0 };
    try {
      live = await fetchLiveQuotesMap();
    } catch (_) {
      live = { map: null, ok: 0 };
    }

    var map;
    var mode;
    if (live.ok > 0) {
      map = live.map;
      // Fill gaps from same-origin so we never flash UNAVAILABLE when static has data
      if (staticResult.map) {
        allSymbols().forEach(function (sym) {
          if ((!map[sym] || map[sym].error) && staticResult.map[sym] && !staticResult.map[sym].error) {
            map[sym] = staticResult.map[sym];
          }
        });
      }
      mode = "live";
    } else if (staticResult.ok > 0) {
      map = staticResult.map;
      mode = "live"; // real shipped prices — not DEMO
    } else {
      map = demoQuotes();
      mode = "demo";
    }

    renderIndices(map, mode);
    renderFutures(map, mode);
    setMarketStatus(mode === "demo" ? "demo" : "live");
  }

  function seedNewsWithTimes() {
    return SEED_NEWS.map(function (n, i) {
      return Object.assign({}, n, {
        time: new Date(Date.now() - i * 60000 * 11),
      });
    });
  }

  async function loadNews() {
    var staticItems = await loadSameOriginNews();
    var liveItems = null;
    try {
      liveItems = await fetchNews();
    } catch (_) {
      liveItems = null;
    }

    if (liveItems && liveItems.length) {
      newsItems = liveItems;
      newsStatus = "LIVE";
    } else if (staticItems && staticItems.length) {
      newsItems = staticItems;
      newsStatus = "LIVE";
    } else {
      newsItems = seedNewsWithTimes();
      newsStatus = "UNAVAILABLE";
    }
    renderNews();
  }

  async function refreshAll() {
    if (refreshInFlight) {
      refreshQueued = true;
      return;
    }
    refreshInFlight = true;
    refreshQueued = false;
    var btn = $("#btn-refresh");
    if (btn) btn.classList.add("spinning");
    try {
      useLocalProxy = await detectLocalProxy();
      var hint = $("#footer-hint");
      if (hint) {
        hint.textContent = useLocalProxy
          ? "Auto-refresh 1s · Local proxy ON · same-origin data/ fallback"
          : "Auto-refresh 1s · same-origin data/ · live optional";
      }
      await Promise.all([loadMarkets(), loadNews()]);
      setLastRefresh(new Date());
    } finally {
      if (btn) btn.classList.remove("spinning");
      refreshInFlight = false;
      if (refreshQueued) {
        refreshQueued = false;
        setTimeout(refreshAll, 50);
      }
    }
  }

  function bindUi() {
    const refreshBtn = $("#btn-refresh");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", function () {
        refreshAll();
      });
    }
    $$(".news-filters .filter").forEach(function (btn) {
      btn.addEventListener("click", function () {
        $$(".news-filters .filter").forEach(function (b) {
          b.classList.remove("active");
        });
        btn.classList.add("active");
        newsFilter = btn.getAttribute("data-filter") || "all";
        renderNews();
      });
    });
  }

  function init() {
    newsItems = seedNewsWithTimes();
    newsStatus = "SEED";
    renderNews();
    renderWatch();
    renderIndices({}, "unavailable");
    renderFutures({}, "unavailable");
    setMarketStatus("—");
    tickClocks();
    setInterval(tickClocks, 1000);
    bindUi();
    refreshAll();
    refreshTimer = setInterval(refreshAll, REFRESH_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
