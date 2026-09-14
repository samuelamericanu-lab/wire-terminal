/**
 * WIRE Options Desk v2
 * Same-origin data/*.json only — GitHub Pages safe (subpath /wire-terminal/).
 * Channels: #newswire · #spike · #fed
 */
(function () {
  "use strict";

  /* —— Path base: NEVER use root-absolute /data/... on Pages ——
   * GitHub Pages often serves /wire-terminal without a trailing slash.
   * new URL(".", thatHref) then resolves to the SITE ROOT and 404s data/.
   */
  function pageBaseHref() {
    var baseEl = document.querySelector("base");
    if (baseEl && baseEl.href) return baseEl.href;
    var path = location.pathname || "/";
    if (/\.html?$/i.test(path)) {
      path = path.replace(/\/[^/]+$/, "/");
    } else if (!path.endsWith("/")) {
      path = path + "/";
    }
    return location.origin + path;
  }

  var BASE = pageBaseHref();

  function dataUrl(file) {
    return new URL("data/" + file, BASE).href;
  }

  /** Candidate URLs — Pages trailing-slash + hardcoded project path fallback */
  function dataCandidates(file) {
    var out = [];
    var seen = {};
    function add(u) {
      if (!u || seen[u]) return;
      seen[u] = 1;
      out.push(u);
    }
    add(dataUrl(file));
    add(location.origin + "/wire-terminal/data/" + file);
    try {
      add(new URL("../data/" + file, location.href).href);
    } catch (e) {}
    return out;
  }

  async function fetchJsonAny(file) {
    var urls = dataCandidates(file);
    var lastErr;
    for (var i = 0; i < urls.length; i++) {
      try {
        var res = await fetch(urls[i], { cache: "no-store" });
        if (!res.ok) throw new Error("HTTP " + res.status + " " + urls[i]);
        return await res.json();
      } catch (e) {
        lastErr = e;
      }
    }
    if (window.__WIRE_BOOTSTRAP__ && window.__WIRE_BOOTSTRAP__[file]) {
      return window.__WIRE_BOOTSTRAP__[file];
    }
    throw lastErr || new Error("fetch failed " + file);
  }

  var REFRESH_MS = 1000;

  var INDICES = [
    { id: "^GSPC", label: "SPX" },
    { id: "^IXIC", label: "NASDAQ" },
    { id: "^DJI", label: "DOW" },
    { id: "^STOXX50E", label: "STOXX" },
    { id: "^N225", label: "NIKKEI" },
    { id: "^HSI", label: "HSI" },
  ];

  var FUTURES = [
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
      items: [{ id: "^TNX", label: "US10Y", name: "10Y Yield %" }],
    },
  ];

  var CATALYSTS = [
    {
      when: "FED",
      title: "Fed / FOMC · rate odds",
      note: "Cuts, holds, dots, presser — front-month rate + index vol. Watch #fed on wire.",
      impact: "high",
    },
    {
      when: "EARNINGS",
      title: "Mega-cap + high-beta prints",
      note: "Beat/miss + guide; IV crush vs index beta into the open/close.",
      impact: "high",
    },
    {
      when: "GEO",
      title: "Geopolitics / tariffs / energy",
      note: "Breaks that reprice oil, defense, and risk premia in minutes.",
      impact: "high",
    },
    {
      when: "CATALYST",
      title: "FDA / M&A / CEO events",
      note: "Binary outcomes — size for gap risk; critical = red on #newswire.",
      impact: "high",
    },
    {
      when: "TAPE",
      title: "Whole-market 3% 1m spikes",
      note: "#spike: liquid US / actives. Trade the move, not the fluff.",
      impact: "med",
    },
    {
      when: "SESSION",
      title: "US open / cash close",
      note: "ES/NQ basis into cash; gamma and dealer hedging into the close.",
      impact: "med",
    },
  ];

  var NEWS_DENY =
    /retirement|annuit(y|ies)|social security|cola\b|401\s*\(?k\)?|roth\b|when you die|what should i do|estate (plan|tax)|personal finance|nest egg|side hustle|how to (save|invest|budget)|best (credit cards?|savings)|my case for buying|says buy these|stocks? to buy|obliterating the s&?p|meet the magnificent|will be worth more by|history says that usually|from fashion to|dividend aristocrat|passive income|make you rich|could (turn|make) \$|if you invested|opinion:|you should (buy|sell)|why i('m| am) (buying|selling)|mortgage tips|debt payoff|emergency fund|lifestyle/i;

  var FED_RE =
    /\b(fed|fomc|federal reserve|rate (cut|hike|hold|decision)|dot plot|powell)\b/i;

  var newsFilter = "all";
  var newsItems = [];
  var newsStatus = "—";
  var spikeItems = [];
  var spikeMeta = { status: "—", note: "", threshold1m: 3 };
  var refreshInFlight = false;
  var refreshQueued = false;

  function $(sel) {
    return document.querySelector(sel);
  }
  function $$(sel) {
    return Array.prototype.slice.call(document.querySelectorAll(sel));
  }

  function pad(n) {
    return n < 10 ? "0" + n : String(n);
  }

  /** 12-hour clock with AM/PM */
  function formatClock(date, utc) {
    var h = utc ? date.getUTCHours() : date.getHours();
    var m = utc ? date.getUTCMinutes() : date.getMinutes();
    var s = utc ? date.getUTCSeconds() : date.getSeconds();
    var ampm = h >= 12 ? "PM" : "AM";
    var h12 = h % 12;
    if (h12 === 0) h12 = 12;
    return pad(h12) + ":" + pad(m) + ":" + pad(s) + " " + ampm;
  }

  function formatTimeShort(date) {
    var h = date.getHours();
    var m = date.getMinutes();
    var ampm = h >= 12 ? "PM" : "AM";
    var h12 = h % 12;
    if (h12 === 0) h12 = 12;
    return pad(h12) + ":" + pad(m) + " " + ampm;
  }

  function fmtPrice(n, digits) {
    if (n == null || Number.isNaN(n)) return "—";
    var d = digits != null ? digits : Math.abs(n) >= 1000 ? 2 : Math.abs(n) >= 100 ? 2 : 2;
    return Number(n).toLocaleString("en-US", {
      minimumFractionDigits: d,
      maximumFractionDigits: d,
    });
  }

  function fmtPct(n) {
    if (n == null || Number.isNaN(n)) return "—";
    var sign = n > 0 ? "+" : "";
    return sign + Number(n).toFixed(2) + "%";
  }

  function chgClass(n) {
    if (n == null || Number.isNaN(n) || n === 0) return "chg-flat";
    return n > 0 ? "chg-up" : "chg-down";
  }

  function isDeniedHeadline(t) {
    return NEWS_DENY.test(t || "");
  }

  function isCriticalHeadline(t) {
    return /earnings (beat|miss)|beats? estimates?|misses? estimates?|ceo (resign|steps down|ousted|fired)|\b(m&a|merger|acquisition|buyout|takeover)\b|\bfda\b.{0,20}(approv|reject)|fed (decision|rate (cut|hike))|fomc|oil (emergency|shock|disruption)|pipeline (halt|explosion)|\b(missile|airstrike|invasion|ceasefire|embargo)\b/i.test(
      t || ""
    );
  }

  function isCriticalItem(n) {
    return !!(n && (n.critical || String(n.tag).toLowerCase() === "breaking"));
  }

  function isFedItem(n) {
    if (!n) return false;
    if (n.fed === true) return true;
    return FED_RE.test(n.headline || "");
  }

  function classifyHeadline(t) {
    var s = (t || "").toLowerCase();
    if (/geopolit|tariff|sanction|war|conflict|israel|iran|ukraine|russia|missile|airstrike/.test(s))
      return "geo";
    if (/fed|fomc|cpi|inflation|gdp|treasury|yield|rate cut|jobs|payroll|oil|opec|brent/.test(s))
      return "macro";
    if (/stock|equity|shares|nasdaq|dow|s&p|earnings|ipo|ceo|fda|merger|acquisition/.test(s))
      return "equities";
    return "macro";
  }

  /* —— Sessions (UTC hours, rough cash) —— */
  function updateSessions() {
    var h = new Date().getUTCHours();
    var m = new Date().getUTCMinutes();
    var mins = h * 60 + m;
    // Asia ~00:00–08:00 UTC, Europe ~07:00–16:00, US ~13:30–20:00
    var asia = mins >= 0 && mins < 8 * 60;
    var europe = mins >= 7 * 60 && mins < 16 * 60;
    var us = mins >= 13 * 60 + 30 && mins < 20 * 60;
    var usClosing = mins >= 19 * 60 && mins < 20 * 60;
    $$("#sessions .session").forEach(function (el) {
      var key = el.getAttribute("data-session");
      el.classList.remove("active", "closing");
      if (key === "asia" && asia) el.classList.add("active");
      if (key === "europe" && europe) el.classList.add("active");
      if (key === "us" && us) {
        el.classList.add(usClosing ? "closing" : "active");
      }
    });
  }

  function tickClocks() {
    var now = new Date();
    var localEl = $("#clock-local .clock-time");
    var utcEl = $("#clock-utc .clock-time");
    if (localEl) localEl.textContent = formatClock(now, false);
    if (utcEl) utcEl.textContent = formatClock(now, true);
    var foot = $("#footer-clock");
    if (foot) foot.textContent = formatClock(now, false);
    updateSessions();
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

  /* —— Render —— */

  function renderIndices(quotesMap) {
    var strip = $("#indices-strip");
    if (!strip) return;
    strip.innerHTML = INDICES.map(function (idx) {
      var q = quotesMap[idx.id];
      var unavailable = !q || q.error;
      var priceHtml = "—";
      var chgHtml = "—";
      var cls = "chg-flat";
      var badge = "";
      if (unavailable) {
        badge = '<span class="index-badge">UNAVAILABLE</span>';
      } else {
        priceHtml = fmtPrice(q.price);
        chgHtml = fmtPct(q.changePct);
        cls = chgClass(q.changePct);
      }
      return (
        '<div class="index-card"><div class="index-name">' +
        idx.label +
        badge +
        '</div><div class="index-row"><span class="index-price">' +
        priceHtml +
        '</span><span class="index-chg ' +
        cls +
        '">' +
        chgHtml +
        "</span></div></div>"
      );
    }).join("");
  }

  function renderFutures(quotesMap) {
    var body = $("#futures-body");
    var badge = $("#futures-badge");
    if (!body) return;
    var anyLive = false;
    var anyFail = false;
    var chips = [];
    FUTURES.forEach(function (sec) {
      sec.items.forEach(function (item) {
        var q = quotesMap[item.id];
        if (!q || q.error) {
          anyFail = true;
          chips.push(
            '<div class="fut-chip" title="' +
              item.name +
              '"><span class="fut-sym">' +
              item.label +
              '</span><span class="fut-price">—</span><span class="fut-chg chg-flat">n/a</span></div>'
          );
          return;
        }
        anyLive = true;
        var dig = item.id === "^TNX" ? 3 : undefined;
        chips.push(
          '<div class="fut-chip" title="' +
            item.name +
            '"><span class="fut-sym">' +
            item.label +
            '</span><span class="fut-price">' +
            fmtPrice(q.price, dig) +
            '</span><span class="fut-chg ' +
            chgClass(q.changePct) +
            '">' +
            fmtPct(q.changePct) +
            "</span></div>"
        );
      });
    });
    body.innerHTML = chips.join("") || '<div class="loading-row">No futures</div>';
    if (badge) {
      badge.className = "panel-badge";
      if (anyLive && !anyFail) {
        badge.textContent = "LIVE";
        badge.classList.add("live");
      } else if (anyLive) {
        badge.textContent = "PARTIAL";
        badge.classList.add("partial");
      } else {
        badge.textContent = "UNAVAILABLE";
        badge.classList.add("unavailable");
      }
    }
  }

  function flashTimeLabel(d) {
    if (!d) return "--:--";
    var now = new Date();
    var sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    if (sameDay) return formatTimeShort(d);
    return pad(d.getMonth() + 1) + "/" + pad(d.getDate());
  }

  function renderNews() {
    var body = $("#news-body");
    var badge = $("#news-badge");
    if (!body) return;

    var filtered = newsItems.filter(function (n) {
      if (newsFilter === "all") return true;
      if (newsFilter === "critical") return isCriticalItem(n);
      return n.tag === newsFilter;
    });

    if (!filtered.length) {
      body.innerHTML = '<div class="loading-row">No flashes for filter.</div>';
    } else {
      body.innerHTML = filtered
        .map(function (n) {
          var critical = isCriticalItem(n);
          var fed = isFedItem(n);
          var tagLabel = critical ? "breaking" : n.tag || "macro";
          var tagClass =
            critical || tagLabel === "breaking"
              ? "breaking"
              : tagLabel === "geo"
                ? "geo"
                : tagLabel === "equities"
                  ? "equities"
                  : tagLabel === "futures"
                    ? "futures"
                    : "macro";
          var fedBadge = fed
            ? '<span class="news-tag fed">#fed</span>'
            : "";
          var breakBadge = critical
            ? '<span class="news-tag breaking">BREAKING</span>'
            : "";
          var href = n.link || "";
          var tag =
            href && !n.seed
              ? "a"
              : "div";
          var hrefAttr = tag === "a" ? ' href="' + href.replace(/"/g, "") + '" target="_blank" rel="noopener"' : "";
          var linkClass = tag === "a" ? " has-link" : "";
          return (
            "<" +
            tag +
            ' class="news-item' +
            (critical ? " critical" : "") +
            linkClass +
            '"' +
            hrefAttr +
            '><div class="news-time">' +
            flashTimeLabel(n.time) +
            '</div><div><div class="news-meta">' +
            breakBadge +
            '<span class="news-tag ' +
            tagClass +
            '">' +
            tagLabel +
            "</span>" +
            fedBadge +
            '<span class="news-src">' +
            (n.src || "WIRE") +
            '</span></div><div class="news-headline">' +
            escapeHtml(n.headline) +
            "</div></div></" +
            tag +
            ">"
          );
        })
        .join("");
    }

    if (badge) {
      badge.className = "panel-badge";
      var critCount = newsItems.filter(isCriticalItem).length;
      if (newsStatus === "LIVE") {
        badge.textContent = critCount ? "LIVE · " + critCount + " CRIT" : "LIVE";
        badge.classList.add(critCount ? "breaking" : "live");
      } else {
        badge.textContent = newsStatus;
        if (newsStatus === "UNAVAILABLE") badge.classList.add("unavailable");
      }
    }
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderSpikes() {
    var body = $("#spike-body");
    var badge = $("#spike-badge");
    var hint = $("#spike-hint");
    if (!body) return;

    if (hint) {
      hint.textContent =
        spikeMeta.note ||
        "≥" + (spikeMeta.threshold1m || 3) + "% 1m · liquid US / actives";
    }

    if (!spikeItems.length) {
      body.innerHTML =
        '<div class="spike-empty">No spike clears right now. Desk scans liquid US / actives for ≥3% 1m moves.</div>';
    } else {
      body.innerHTML = spikeItems
        .map(function (s) {
          var up = s.changePct >= 0;
          return (
            '<div class="spike-row ' +
            (up ? "up" : "down") +
            '"><span class="spike-sym">' +
            escapeHtml(s.symbol) +
            '</span><div class="spike-meta"><div class="spike-name">' +
            escapeHtml(s.name) +
            '</div><div class="spike-price">' +
            (s.price != null ? fmtPrice(s.price) : "—") +
            '</div></div><div class="spike-right"><span class="spike-pct ' +
            chgClass(s.changePct) +
            '">' +
            fmtPct(s.changePct) +
            '</span><span class="spike-win">' +
            escapeHtml(String(s.window || "1d").toUpperCase()) +
            "</span></div></div>"
          );
        })
        .join("");
    }

    if (badge) {
      badge.className = "panel-badge";
      var st = spikeMeta.status || "—";
      badge.textContent = st;
      if (st === "LIVE") badge.classList.add("live");
      else if (st === "PARTIAL") badge.classList.add("partial");
      else if (st === "EMPTY" || st === "UNAVAILABLE")
        badge.classList.add("unavailable");
    }
  }

  function renderWatch() {
    var body = $("#watch-body");
    if (!body) return;
    body.innerHTML = CATALYSTS.map(function (c) {
      return (
        '<div class="watch-item ' +
        (c.impact || "med") +
        '"><div class="watch-when">' +
        escapeHtml(c.when) +
        '</div><div class="watch-title">' +
        escapeHtml(c.title) +
        '</div><div class="watch-note">' +
        escapeHtml(c.note) +
        '</div><span class="watch-impact">' +
        String(c.impact || "med").toUpperCase() +
        " IMPACT</span></div>"
      );
    }).join("");
  }

  function setMarketStatus(mode) {
    var el = $("#data-status");
    if (!el) return;
    el.className = "status-pill";
    if (mode === "live") {
      el.textContent = "LIVE";
      el.classList.add("live");
    } else if (mode === "unavailable") {
      el.textContent = "UNAVAILABLE";
      el.classList.add("unavailable");
    } else {
      el.textContent = mode;
    }
  }

  function setLastRefresh(date) {
    var el = $("#last-refresh");
    if (!el) return;
    el.textContent = "Last " + formatClock(date, false);
  }

  /* —— Same-origin loaders (Pages-safe relative paths via BASE) —— */

  async function loadQuotes() {
    try {
      var data = await fetchJsonAny("quotes.json");
      var src = (data && data.quotes) || {};
      var map = {};
      allSymbols().forEach(function (sym) {
        var q = src[sym];
        if (q && q.price != null && !Number.isNaN(Number(q.price))) {
          map[sym] = {
            price: Number(q.price),
            change: q.change != null ? Number(q.change) : null,
            changePct: q.changePct != null ? Number(q.changePct) : null,
          };
        } else {
          map[sym] = { error: true };
        }
      });
      return { map: map, ok: countOkQuotes(map) };
    } catch (e) {
      console.warn("[WIRE] quotes load failed", e);
      return { map: null, ok: 0 };
    }
  }

  async function loadNews() {
    try {
      var data = await fetchJsonAny("news.json");
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
        var fed = it.fed === true || FED_RE.test(title);
        out.push({
          id: it.id || "static-" + i,
          time: d,
          tag: tag,
          src: it.src || "WIRE",
          headline: title,
          link: it.link || "",
          critical: crit,
          fed: fed,
          seed: false,
        });
      }
      out.sort(function (a, b) {
        if (isCriticalItem(a) !== isCriticalItem(b))
          return isCriticalItem(a) ? -1 : 1;
        return b.time - a.time;
      });
      return out;
    } catch (e) {
      console.warn("[WIRE] news load failed", e);
      return null;
    }
  }

  async function loadSpikes() {
    try {
      var data = await fetchJsonAny("spikes.json");
      var items = (data && data.items) || [];
      return {
        items: items
          .filter(function (s) {
            return s && s.symbol && s.changePct != null;
          })
          .map(function (s) {
            return {
              symbol: String(s.symbol),
              name: s.name || s.symbol,
              price: s.price != null ? Number(s.price) : null,
              changePct: Number(s.changePct),
              window: s.window || "1d",
            };
          }),
        status: (data && data.status) || (items.length ? "LIVE" : "EMPTY"),
        note: (data && data.note) || "",
        threshold1m: (data && data.threshold1m) || 3,
      };
    } catch (e) {
      console.warn("[WIRE] spikes load failed", e);
      return {
        items: [],
        status: "EMPTY",
        note: "spikes.json not present yet",
        threshold1m: 3,
      };
    }
  }

  async function refreshMarkets() {
    var result = await loadQuotes();
    var map;
    var mode;
    if (result.ok > 0) {
      map = result.map;
      mode = "live";
    } else {
      map = {};
      allSymbols().forEach(function (s) {
        map[s] = { error: true };
      });
      mode = "unavailable";
    }
    renderIndices(map);
    renderFutures(map);
    setMarketStatus(mode === "unavailable" ? "unavailable" : "live");
  }

  async function refreshNews() {
    var items = await loadNews();
    if (items && items.length) {
      newsItems = items;
      newsStatus = "LIVE";
    } else {
      newsItems = [
        {
          id: "seed-1",
          time: new Date(),
          tag: "macro",
          src: "WIRE",
          headline:
            "Awaiting #newswire — markets/macro/geo breaks only (no lifestyle fluff)",
          seed: true,
          critical: false,
          fed: false,
        },
      ];
      newsStatus = items === null ? "UNAVAILABLE" : "EMPTY";
    }
    renderNews();
  }

  async function refreshSpikes() {
    var data = await loadSpikes();
    spikeItems = data.items;
    spikeMeta = {
      status: data.status,
      note: data.note,
      threshold1m: data.threshold1m,
    };
    renderSpikes();
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
      var hint = $("#footer-hint");
      if (hint) {
        hint.textContent =
          "Auto-refresh 1s · " + dataUrl("quotes.json").replace(location.origin, "");
      }
      await Promise.all([refreshMarkets(), refreshNews(), refreshSpikes()]);
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
    var refreshBtn = $("#btn-refresh");
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
    // Expose for smoke tests / debugging
    window.__WIRE_BASE__ = BASE;
    window.__WIRE_DATA_URL__ = dataUrl;

    renderWatch();
    renderIndices({});
    renderFutures({});
    renderSpikes();
    newsItems = [];
    newsStatus = "—";
    renderNews();
    setMarketStatus("—");
    tickClocks();
    setInterval(tickClocks, 1000);
    bindUi();
    refreshAll();
    setInterval(refreshAll, REFRESH_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
