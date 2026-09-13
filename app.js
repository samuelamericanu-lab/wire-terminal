/**
 * Wire Terminal — markets desk client
 *
 * Prefer same-origin /proxy (python3 serve.py). Falls back to public CORS
 * proxies. On total failure: UNAVAILABLE / DEMO badges — never silent fakes.
 */
(function () {
  "use strict";

  const REFRESH_MS = 45000;

  const INDICES = [
    { id: "^GSPC", label: "S&P 500", short: "SPX" },
    { id: "^IXIC", label: "NASDAQ", short: "COMP" },
    { id: "^DJI", label: "DOW", short: "DJI" },
    { id: "^STOXX", label: "STOXX 600", short: "SXXP" },
    { id: "^N225", label: "NIKKEI", short: "NKY" },
    { id: "^HSI", label: "HANG SENG", short: "HSI" },
  ];

  const SYMBOL_FALLBACKS = {
    "^STOXX": ["^STOXX50E", "EXSA.DE"],
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
        "Index strip populates from Yahoo Finance when fetch succeeds (use serve.py)",
      seed: true,
    },
    {
      id: "seed-3",
      tag: "futures",
      src: "WIRE",
      headline: "ES / NQ / oil / US10Y refresh on the same ~45s cycle as indices",
      seed: true,
    },
    {
      id: "seed-4",
      tag: "macro",
      src: "WIRE",
      headline:
        "News: CNBC / MarketWatch / BBC / Yahoo RSS via local /proxy or public JSON",
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

  let newsFilter = "all";
  let newsItems = [];
  let newsStatus = "SEED";
  let useLocalProxy = false;
  let refreshTimer = null;

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function formatClock(d, utc) {
    const h = utc ? d.getUTCHours() : d.getHours();
    const m = utc ? d.getUTCMinutes() : d.getMinutes();
    const s = utc ? d.getUTCSeconds() : d.getSeconds();
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
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
        }) +
        " · " +
        formatClock(now, true) +
        " UTC";
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

  const CORS_PROXIES = [
    (url) =>
      "https://api.allorigins.win/raw?url=" + encodeURIComponent(url),
  ];

  async function fetchText(url, timeoutMs) {
    timeoutMs = timeoutMs || 14000;
    const attempts = [];
    if (useLocalProxy) attempts.push(localProxyUrl(url));
    // Direct (works only if server sends ACAO — usually not for Yahoo)
    attempts.push(url);
    CORS_PROXIES.forEach((fn) => attempts.push(fn(url)));

    let lastErr;
    for (const endpoint of attempts) {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(endpoint, {
          signal: controller.signal,
          cache: "no-store",
          headers: { Accept: "application/json, application/xml, text/xml, */*" },
        });
        clearTimeout(t);
        if (!res.ok) throw new Error("HTTP " + res.status);
        return await res.text();
      } catch (e) {
        clearTimeout(t);
        lastErr = e;
      }
    }
    throw lastErr || new Error("fetch failed");
  }

  async function fetchJson(url) {
    return JSON.parse(await fetchText(url));
  }

  async function fetchYahooQuote(symbol) {
    const url =
      "https://query1.finance.yahoo.com/v8/finance/chart/" +
      encodeURIComponent(symbol) +
      "?interval=1d&range=5d";
    const data = await fetchJson(url);
    const result = data && data.chart && data.chart.result && data.chart.result[0];
    if (!result) throw new Error("No chart result");
    const meta = result.meta || {};
    const quotes = result.indicators && result.indicators.quote && result.indicators.quote[0];
    const closes =
      (quotes && quotes.close && quotes.close.filter(function (c) {
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
      symbol: symbol,
      price: price,
      change: change,
      changePct: changePct,
      currency: meta.currency,
      name: meta.shortName || meta.longName || symbol,
    };
  }

  async function fetchYahooWithFallback(primary) {
    const list = [primary].concat(SYMBOL_FALLBACKS[primary] || []);
    let lastErr;
    for (let i = 0; i < list.length; i++) {
      try {
        return await fetchYahooQuote(list[i]);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("Quote failed");
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

  function parseRssItems(xmlText, sourceLabel) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, "text/xml");
    const items = Array.prototype.slice.call(doc.querySelectorAll("item"), 0, 25);
    return items.map(function (item, i) {
      const title =
        (item.querySelector("title") &&
          item.querySelector("title").textContent.trim()) ||
        "Untitled";
      const linkEl = item.querySelector("link");
      const link = (linkEl && linkEl.textContent.trim()) || "";
      const pub =
        (item.querySelector("pubDate") && item.querySelector("pubDate").textContent) ||
        "";
      let d = pub ? new Date(pub) : new Date();
      if (Number.isNaN(d.getTime())) d = new Date();
      return {
        id: "rss-" + sourceLabel + "-" + i + "-" + d.getTime(),
        time: d,
        tag: classifyHeadline(title),
        src: sourceLabel,
        headline: title,
        link: link,
        seed: false,
      };
    });
  }

  async function fetchNews() {
    const collected = [];

    for (let f = 0; f < NEWS_FEEDS.length; f++) {
      const feed = NEWS_FEEDS[f];
      try {
        // rss2json when no local proxy
        if (!useLocalProxy) {
          try {
            const rss2 =
              "https://api.rss2json.com/v1/api.json?rss_url=" +
              encodeURIComponent(feed.url);
            const controller = new AbortController();
            const t = setTimeout(function () {
              controller.abort();
            }, 9000);
            const res = await fetch(rss2, { signal: controller.signal });
            clearTimeout(t);
            if (res.ok) {
              const json = await res.json();
              if (json.status === "ok" && Array.isArray(json.items)) {
                json.items.slice(0, 12).forEach(function (it, i) {
                  const d = it.pubDate ? new Date(it.pubDate) : new Date();
                  collected.push({
                    id: "r2j-" + feed.label + "-" + i + "-" + d.getTime(),
                    time: Number.isNaN(d.getTime()) ? new Date() : d,
                    tag: classifyHeadline(it.title),
                    src: feed.label,
                    headline: (it.title || "").trim(),
                    link: it.link || it.url || "",
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

        const xml = await fetchText(feed.url, 12000);
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
    if (sameDay) return pad(d.getHours()) + ":" + pad(d.getMinutes());
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
            '<article class="flash ' +
            (n.seed ? "seed" : "") +
            '" data-tag="' +
            n.tag +
            '">' +
            '<div class="flash-time">' +
            flashTimeLabel(n.time) +
            "</div><div>" +
            '<div class="flash-meta">' +
            '<span class="flash-tag ' +
            n.tag +
            '">' +
            n.tag.toUpperCase() +
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
      badge.textContent = newsStatus;
      if (newsStatus === "LIVE") badge.classList.add("live");
      else if (newsStatus === "SEED" || newsStatus === "DEMO")
        badge.classList.add("demo");
      else badge.classList.add("unavailable");
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
    el.textContent =
      "LAST " +
      pad(date.getHours()) +
      ":" +
      pad(date.getMinutes()) +
      ":" +
      pad(date.getSeconds());
  }

  /** Illustrative placeholders only — shown with DEMO badges. */
  function demoQuotes() {
    return {
      "^GSPC": { price: 5620.0, changePct: 0.42 },
      "^IXIC": { price: 17850.0, changePct: 0.65 },
      "^DJI": { price: 41200.0, changePct: 0.18 },
      "^STOXX": { price: 520.0, changePct: -0.22 },
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

  async function loadMarkets() {
    const symbols = INDICES.map(function (i) {
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

    const map = {};
    let ok = 0;
    const results = await Promise.allSettled(
      symbols.map(async function (sym) {
        const q = await fetchYahooWithFallback(sym);
        return { sym: sym, q: q };
      })
    );

    results.forEach(function (r, i) {
      const sym = symbols[i];
      if (r.status === "fulfilled") {
        map[sym] = r.value.q;
        ok++;
      } else {
        map[sym] = { error: true };
      }
    });

    if (ok === 0) {
      const demo = demoQuotes();
      Object.keys(demo).forEach(function (k) {
        map[k] = demo[k];
      });
      renderIndices(map, "demo");
      renderFutures(map, "demo");
      setMarketStatus("demo");
      return;
    }

    renderIndices(map, "live");
    renderFutures(map, "live");
    setMarketStatus("live");
  }

  function seedNewsWithTimes() {
    return SEED_NEWS.map(function (n, i) {
      return Object.assign({}, n, {
        time: new Date(Date.now() - i * 60000 * 11),
      });
    });
  }

  async function loadNews() {
    try {
      const items = await fetchNews();
      if (items && items.length) {
        newsItems = items;
        newsStatus = "LIVE";
      } else {
        newsItems = seedNewsWithTimes();
        newsStatus = "UNAVAILABLE";
      }
    } catch (_) {
      newsItems = seedNewsWithTimes();
      newsStatus = "UNAVAILABLE";
    }
    renderNews();
  }

  async function refreshAll() {
    const btn = $("#btn-refresh");
    if (btn) btn.classList.add("spinning");
    try {
      useLocalProxy = await detectLocalProxy();
      const hint = $("#footer-hint");
      if (hint) {
        hint.textContent = useLocalProxy
          ? "Auto-refresh ~45s · Local proxy ON · Yahoo + RSS"
          : "Auto-refresh ~45s · Prefer: python3 serve.py (local proxy)";
      }
      await Promise.all([loadMarkets(), loadNews()]);
      setLastRefresh(new Date());
    } finally {
      if (btn) btn.classList.remove("spinning");
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
