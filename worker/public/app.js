/* Jobberman — mission control. Vanilla JS, no build step.
   All text that originates from postings is escaped before it touches innerHTML,
   and every posting URL goes through safeUrl(). */
(function () {
  "use strict";

  // ------------------------------------------------------------------ constants
  var STATUSES = ["Pending Review", "Approved to Apply", "Applied", "Interview", "Rejected", "Not Pursuing"];
  var APPLIED = ["Applied", "Interview", "Rejected", "Not Pursuing"];
  var ACTIVE = ["Pending Review", "Approved to Apply"];
  var STATUS_COLOR = {
    "Pending Review": "var(--st-1)",
    "Approved to Apply": "var(--st-2)",
    Applied: "var(--st-3)",
    Interview: "var(--st-4)",
    Rejected: "var(--st-closed)",
    "Not Pursuing": "var(--st-closed)",
  };
  var STATUS_HINT = {
    "Pending Review": "Freshly found",
    "Approved to Apply": "Worth applying to",
    Applied: "Submitted",
    Interview: "In process",
    Rejected: "Closed by them",
    "Not Pursuing": "Closed by you",
  };
  // Cron: Mon–Fri 06/07/19/20 UTC; :00 screens Italy-remote, :30 screens Sponsorship (see wrangler.jsonc).
  var CRON_HOURS = [6, 7, 19, 20];
  var REDUCED = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ------------------------------------------------------------------ helpers
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} },
  };
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function safeUrl(u) { return /^https?:\/\//i.test(u || "") ? u : "#"; }
  function ic(name, cls) { return '<svg class="ic' + (cls ? " " + cls : "") + '" aria-hidden="true"><use href="#i-' + name + '"/></svg>'; }
  function cap(s) { s = String(s || ""); return s.charAt(0).toUpperCase() + s.slice(1); }
  function isApplied(d) { return APPLIED.indexOf(d.status) !== -1; }
  function dayKey(d) { return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); }
  function fmtDay(iso) {
    var d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  function fmtWhen(d) {
    return d.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  }
  function relTime(iso) {
    var t = Date.parse(iso);
    if (isNaN(t)) return "";
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 45) return "just now";
    var m = Math.round(s / 60);
    if (m < 60) return m + "m ago";
    var h = Math.round(m / 60);
    if (h < 36) return h + "h ago";
    return Math.round(h / 24) + "d ago";
  }
  function untilText(date) {
    var m = Math.max(0, Math.round((date.getTime() - Date.now()) / 60000));
    var h = Math.floor(m / 60);
    if (h >= 36) return "in " + Math.round(h / 24) + " days";
    return h ? "in " + h + "h " + (m % 60) + "m" : "in " + m + "m";
  }
  function isUnclear(v) { return !v || /^unclear/i.test(v) || /^n\/a/i.test(v); }

  // ------------------------------------------------------------------ state
  var S = {
    docs: [],
    runs: null,
    loaded: false,
    view: store.get("jb.view") === "list" ? "list" : "board",
    filters: { decision: "", track: "", status: "", q: "" },
    sort: "score",
    open: null,
    token: store.get("jb.key") || "",
    dragging: null,
    sig: "",
    statSig: "",
    shown: { hero: 0 },
    running: false,
  };

  // ------------------------------------------------------------------ api
  function api(path, opts) {
    opts = opts || {};
    var headers = Object.assign({}, opts.headers || {}, { Authorization: "Bearer " + S.token });
    return fetch(path, Object.assign({}, opts, { headers: headers })).then(function (res) {
      if (res.status === 401) { var e = new Error("unauthorized"); e.code = 401; throw e; }
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res;
    });
  }

  function loadAll(silent) {
    return Promise.all([api("/api/postings"), api("/api/runs")])
      .then(function (r) { return Promise.all([r[0].json(), r[1].json()]); })
      .then(function (r) {
        var sig = JSON.stringify([r[0], r[1].runs, r[1].seen_count]);
        var first = !S.loaded;
        S.docs = r[0];
        S.runs = r[1];
        S.loaded = true;
        hideBanner();
        if (first || sig !== S.sig) { S.sig = sig; renderAll(); } else { renderHealth(); }
      })
      .catch(function (err) {
        if (err && err.code === 401) { showLock(S.token ? "That access key was not accepted." : ""); return; }
        if (!silent) showBanner("Couldn't load data (" + err.message + "). Retrying automatically.");
      });
  }

  // ------------------------------------------------------------------ derived data
  function filtered() {
    var f = S.filters, q = f.q.trim().toLowerCase();
    var out = S.docs.filter(function (d) {
      if (f.decision && d.decision !== f.decision) return false;
      if (f.track === "sponsorship" ? !d.sponsorship_verified : f.track === "italy-remote" ? d.sponsorship_verified : false) return false;
      if (f.status === "closed") { if (d.status !== "Rejected" && d.status !== "Not Pursuing") return false; }
      else if (f.status && d.status !== f.status) return false;
      if (q && (d.company + " " + d.title + " " + (d.location || "")).toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
    var cmp = {
      score: function (a, b) { return b.score - a.score || Date.parse(b.date_found) - Date.parse(a.date_found); },
      new: function (a, b) { return Date.parse(b.date_found) - Date.parse(a.date_found); },
      company: function (a, b) { return a.company.localeCompare(b.company); },
    }[S.sort] || function () { return 0; };
    return out.sort(cmp);
  }

  function health() {
    var runs = (S.runs && S.runs.runs) || [];
    var last = runs[0];
    if (!last) return { state: "warn", title: "No runs yet", sub: "The first scheduled run will appear here. You can also start one now." };
    if (last.status === "running") return { state: "run", title: "Run in progress", sub: "Started " + relTime(last.started_at) };
    if (last.status === "error") {
      var m = /FATAL: ([\s\S]*)$/.exec(last.notes || "");
      return { state: "bad", title: "Last run failed", sub: humanizeError(m ? m[1] : last.notes || "unknown error") };
    }
    var sub = "Last run " + relTime(last.finished_at || last.started_at) + " — screened " + last.postings_evaluated + ", added " + last.postings_added;
    return { state: "ok", title: "Pipeline healthy", sub: sub };
  }
  function humanizeError(t) {
    t = String(t || "");
    if (/credit balance/i.test(t)) return "Anthropic credit balance is too low — add credits at console.anthropic.com → Plans & Billing, then run again.";
    if (/Brave Search rejected/i.test(t)) return "Brave Search rejected the request — check the API key or whether the monthly quota is used up.";
    if (/Too many subrequests/i.test(t)) return "Hit Cloudflare's per-run request limit.";
    if (/Anthropic API \((401|403)\)/i.test(t)) return "Anthropic rejected the API key.";
    if (/interrupted/i.test(t)) return "The run was interrupted before it could finish.";
    return t.length > 170 ? t.slice(0, 170) + "…" : t;
  }
  function nextRun() {
    var now = new Date(), best = null;
    for (var d = 0; d < 9; d++) {
      var base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + d);
      var dow = new Date(base).getUTCDay();
      if (dow === 0 || dow === 6) continue;
      for (var i = 0; i < CRON_HOURS.length; i++) {
        for (var k = 0; k < 2; k++) {
          var t = new Date(base + (CRON_HOURS[i] * 60 + k * 30) * 60000);
          if (t > now && (!best || t < best.date)) best = { date: t, track: k ? "Sponsorship" : "Italy-remote" };
        }
      }
    }
    return best;
  }

  // ------------------------------------------------------------------ render: health
  function renderHealth() {
    var h = health(), nr = nextRun(), el = $("#health");
    el.innerHTML =
      '<div class="health-main"><span class="health-dot ' + h.state + '"></span><div>' +
      '<div class="health-title">' + esc(h.title) + "</div>" +
      '<div class="health-sub">' + esc(h.sub) + "</div></div></div>" +
      '<div class="health-next"><span class="tile-label">Next scheduled run</span>' +
      (nr ? "<span><b>" + esc(untilText(nr.date)) + "</b> · " + esc(fmtWhen(nr.date)) + " · " + esc(nr.track) + "</span>" : "") + "</div>" +
      '<div class="health-actions"><button class="btn" type="button" data-act="history">' + ic("pulse") + "Run history</button>" +
      '<button class="btn primary" type="button" data-act="run">' + ic("play") + "Run now</button></div>";
  }

  // ------------------------------------------------------------------ render: mission tiles
  function renderMission() {
    var el = $("#mission");
    if (!S.loaded) {
      el.innerHTML = '<div class="tile glass t-hero"><div class="skel" style="height:150px"></div></div><div class="tile glass t-funnel"><div class="skel" style="height:150px"></div></div><div class="tile glass t-daily"><div class="skel" style="height:150px"></div></div>';
      return;
    }
    var docs = S.docs, total = docs.length;
    var count = function (fn) { return docs.filter(fn).length; };
    var active = count(function (d) { return !isApplied(d); });
    var applied = count(isApplied);
    var stage = function (s) { return count(function (d) { return d.status === s; }); };
    var closed = stage("Rejected") + stage("Not Pursuing");
    var apply = count(function (d) { return d.decision === "apply"; });
    var review = count(function (d) { return d.decision === "review"; });
    var spon = count(function (d) { return d.sponsorship_verified; });
    var avg = total ? Math.round(docs.reduce(function (s, d) { return s + d.score; }, 0) / total) : 0;
    var daily = dailyCounts(14);

    var sig = JSON.stringify([active, applied, closed, apply, review, spon, avg, stage("Pending Review"), stage("Approved to Apply"), stage("Interview"), daily.map(function (x) { return x.n; }), S.filters.decision, S.filters.track, S.filters.status]);
    if (sig === S.statSig) return;
    S.statSig = sig;

    var kpi = function (label, val, filt, swatch) {
      var pressed = filt && S.filters[filt[0]] === filt[1];
      var inner = '<div class="kpi-v">' + esc(val) + '</div><div class="kpi-l">' + (swatch ? '<span class="sw" style="background:' + swatch + '"></span>' : "") + esc(label) + "</div>";
      return filt
        ? '<button type="button" class="kpi" data-kpi="' + filt[0] + ":" + filt[1] + '" aria-pressed="' + (pressed ? "true" : "false") + '">' + inner + "</button>"
        : '<div class="kpi">' + inner + "</div>";
    };

    var stages = [
      { key: "Pending Review", label: "Pending review", n: stage("Pending Review"), c: "var(--st-1)" },
      { key: "Approved to Apply", label: "Approved to apply", n: stage("Approved to Apply"), c: "var(--st-2)" },
      { key: "Applied", label: "Applied", n: stage("Applied"), c: "var(--st-3)" },
      { key: "Interview", label: "Interview", n: stage("Interview"), c: "var(--st-4)" },
      { key: "closed", label: "Closed", n: closed, c: "var(--st-closed)" },
    ];
    var bar = stages.filter(function (s) { return s.n > 0; }).map(function (s) {
      return '<button type="button" class="seg-f" data-status="' + s.key + '" style="flex:' + s.n + " 1 0;--c:" + s.c + '" aria-pressed="' + (S.filters.status === s.key ? "true" : "false") + '" aria-label="' + esc(s.label + ": " + s.n) + '" data-tip="' + esc(s.label + " · " + s.n + " (" + Math.round((s.n / total) * 100) + "%)") + '"></button>';
    }).join("");
    var legend = stages.map(function (s) {
      return '<li><button type="button" data-status="' + s.key + '"><span class="sw" style="--c:' + s.c + '"></span>' + esc(s.label) + '<span class="lv">' + s.n + "</span></button></li>";
    }).join("");

    el.innerHTML =
      '<article class="tile glass t-hero"><p class="tile-label">Awaiting your decision</p>' +
      '<div class="hero-row"><span class="hero-num" id="heroNum">' + S.shown.hero + '</span><span class="hero-unit">active postings</span></div>' +
      '<p class="hero-sub">' + applied + " applied · " + stage("Interview") + " in interview · " + total + " tracked</p>" +
      '<div class="kpis">' +
      kpi("Apply tier", apply, ["decision", "apply"], "var(--good)") +
      kpi("Review tier", review, ["decision", "review"], "var(--warning)") +
      kpi("Verified sponsorship", spon, ["track", "sponsorship"], "var(--purple-line)") +
      kpi("Average score", avg, null) +
      "</div></article>" +
      '<article class="tile glass t-funnel"><div class="tile-title"><h2 class="tile-label">Pipeline stages</h2><span class="tile-label">click to filter</span></div>' +
      (total ? '<div class="funnel-bar" role="group" aria-label="Pipeline stages">' + bar + "</div>" : '<div class="funnel-empty"></div>') +
      '<ul class="legend">' + legend + "</ul>" + (total ? '<p class="funnel-note"><b>' + applied + '</b> of ' + total + ' tracked postings applied to (' + Math.round((applied / total) * 100) + '%)</p>' : '') + "</article>" +
      '<article class="tile glass t-daily"><div class="tile-title"><h2 class="tile-label">Found per day</h2><span class="tile-label">last 14 days</span></div>' + dailyChart(daily) + "</article>";

    var hero = $("#heroNum");
    countUp(hero, active);
  }

  function countUp(el, to) {
    if (!el) return;
    var from = S.shown.hero;
    S.shown.hero = to;
    if (REDUCED || from === to) { el.textContent = to; return; }
    var t0 = performance.now(), dur = 650;
    (function step(t) {
      var p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(from + (to - from) * e);
      if (p < 1) requestAnimationFrame(step);
    })(t0);
  }

  function dailyCounts(days) {
    var out = [], map = {}, today = new Date();
    today = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    for (var i = days - 1; i >= 0; i--) {
      var d = new Date(today); d.setDate(d.getDate() - i);
      var o = { date: d, n: 0 };
      out.push(o); map[dayKey(d)] = o;
    }
    S.docs.forEach(function (p) {
      var dt = new Date(p.date_found);
      if (!isNaN(dt) && map[dayKey(dt)]) map[dayKey(dt)].n++;
    });
    return out;
  }

  function dailyChart(daily) {
    var slot = 22, bw = 12, base = 88, maxH = 68, W = slot * daily.length;
    var max = Math.max.apply(null, daily.map(function (d) { return d.n; }).concat([3]));
    var bars = "", hits = "", rows = "";
    daily.forEach(function (d, i) {
      var x = i * slot + (slot - bw) / 2, h = d.n ? Math.max(4, Math.round((d.n / max) * maxH)) : 2;
      var y = base - h, r = Math.min(4, h, bw / 2);
      var isNow = i === daily.length - 1;
      var tip = d.date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) + " · " + d.n + " found";
      bars += '<path class="col' + (isNow ? " now" : "") + '" d="M' + x + " " + base + " V" + (y + r) + " Q" + x + " " + y + " " + (x + r) + " " + y + " H" + (x + bw - r) + " Q" + (x + bw) + " " + y + " " + (x + bw) + " " + (y + r) + " V" + base + ' Z"/>';
      hits += '<rect class="hit" x="' + i * slot + '" y="0" width="' + slot + '" height="' + base + '" data-tip="' + esc(tip) + '"/>';
      if (isNow) bars += '<text class="val" x="' + (x + bw / 2) + '" y="' + (y - 6) + '" text-anchor="middle">' + d.n + "</text>";
      rows += "<tr><td>" + esc(fmtDay(d.date)) + "</td><td>" + d.n + "</td></tr>";
    });
    return (
      '<svg class="daily-svg" viewBox="0 0 ' + W + ' 112" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Postings found per day over the last 14 days">' +
      '<line class="base" x1="0" y1="' + base + '" x2="' + W + '" y2="' + base + '"/>' + bars + hits +
      '<text x="0" y="106">' + esc(fmtDay(daily[0].date)) + '</text><text x="' + W + '" y="106" text-anchor="end">Today</text></svg>' +
      '<table class="sr-only"><caption>Postings found per day</caption><tbody>' + rows + "</tbody></table>"
    );
  }

  // ------------------------------------------------------------------ render: toolbar
  function buildToolbar() {
    $("#toolbar").innerHTML =
      '<div class="tb-group"><span class="tb-label">Tier</span><div class="seg" data-group="decision" role="group" aria-label="Tier">' +
      '<button type="button" data-v="">All</button><button type="button" data-v="apply">Apply <span class="n" data-n="apply"></span></button><button type="button" data-v="review">Review <span class="n" data-n="review"></span></button></div></div>' +
      '<div class="tb-group"><span class="tb-label">Track</span><div class="seg" data-group="track" role="group" aria-label="Track">' +
      '<button type="button" data-v="">All</button><button type="button" data-v="italy-remote">Italy-remote</button><button type="button" data-v="sponsorship">Sponsorship</button></div></div>' +
      '<span id="statusChip"></span>' +
      '<label class="field">' + ic("search") + '<input id="q" type="search" placeholder="Filter…  ( / )" autocomplete="off" spellcheck="false" aria-label="Filter postings"></label>' +
      '<select id="sort" class="select" aria-label="Sort postings"><option value="score">Sort: score</option><option value="new">Sort: newest</option><option value="company">Sort: company</option></select>' +
      '<span class="tb-spacer"></span><span class="count" id="count" aria-live="polite"></span>';
  }
  function syncToolbar(shown) {
    $$("#toolbar .seg").forEach(function (seg) {
      var g = seg.getAttribute("data-group");
      $$("button", seg).forEach(function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-v") === S.filters[g])); });
    });
    $$("#toolbar [data-n]").forEach(function (n) {
      n.textContent = S.docs.filter(function (d) { return d.decision === n.getAttribute("data-n"); }).length;
    });
    var chip = $("#statusChip");
    chip.innerHTML = S.filters.status
      ? '<span class="chip-active">Stage: ' + esc(S.filters.status === "closed" ? "Closed" : S.filters.status) + '<button type="button" data-act="clear-status" aria-label="Clear stage filter">' + ic("x") + "</button></span>"
      : "";
    $("#count").textContent = shown + " of " + S.docs.length;
    var srt = $("#sort");
    if (srt.value !== S.sort) srt.value = S.sort;
  }

  // ------------------------------------------------------------------ render: postings
  function ringSvg(score, decision, size, lg) {
    var r = 15.5, c = 2 * Math.PI * r, dash = (Math.max(0, Math.min(100, score)) / 100) * c;
    var col = decision === "apply" ? "var(--good)" : decision === "review" ? "var(--warning)" : "var(--critical)";
    return '<svg class="ring' + (lg ? " ring-lg" : "") + '" viewBox="0 0 40 40" width="' + size + '" height="' + size + '" role="img" aria-label="Score ' + score + ' of 100">' +
      '<circle cx="20" cy="20" r="' + r + '" fill="none" stroke="var(--ring-track)" stroke-width="4"/>' +
      '<circle cx="20" cy="20" r="' + r + '" fill="none" stroke="' + col + '" stroke-width="4" stroke-linecap="round" stroke-dasharray="' + dash.toFixed(1) + " " + c.toFixed(1) + '" transform="rotate(-90 20 20)"/>' +
      '<text x="20" y="20" text-anchor="middle" dominant-baseline="central" class="ring-n">' + score + "</text></svg>";
  }
  function sponTag(d) {
    return '<span class="tag-spon">' + ic("shield") + "Sponsorship" + (d.sponsorship_country ? " · " + esc(d.sponsorship_country) : "") + "</span>";
  }
  function statusPill(d) {
    return '<span class="pill status" style="--c:' + STATUS_COLOR[d.status] + '"><i class="dot"></i>' + esc(d.status) + "</span>";
  }

  function cardHtml(d, mode, i) {
    var applied = isApplied(d), row = mode === "row";
    var tags = '<span class="pill ' + esc(d.decision) + '"><i class="dot"></i>' + cap(d.decision) + "</span>" +
      (d.sponsorship_verified ? sponTag(d) : "") + (row ? statusPill(d) : "");
    var meta = "";
    if (d.location) meta += '<span title="' + esc(d.location) + '">' + esc(d.location) + "</span>";
    if (!isUnclear(d.salary)) meta += '<span title="' + esc(d.salary) + '">' + esc(d.salary) + "</span>";
    var action = applied ? "" : '<button type="button" class="mini go" data-act="applied" data-id="' + esc(d.id) + '" aria-label="Mark ' + esc(d.company) + ' as applied">' + ic("check") + "Applied</button>";
    return (
      '<article class="card' + (row ? " row" : "") + '" data-id="' + esc(d.id) + '" tabindex="0" style="--i:' + Math.min(i, 12) + '"' + (row ? "" : ' draggable="true"') +
      ' aria-label="' + esc(d.company + " — " + d.title + ", score " + d.score + ", " + d.decision) + '">' +
      '<div class="card-head">' + ringSvg(d.score, d.decision, row ? 44 : 40) + '<div class="card-id"><div class="company">' + esc(d.company) + '</div><div class="role">' + esc(d.title) + "</div></div></div>" +
      (row ? '<p class="reason">' + esc(d.one_line_reason || "") + "</p>" : "") +
      '<div class="card-tags">' + tags + "</div>" +
      (meta ? '<div class="meta">' + meta + "</div>" : "") +
      '<div class="card-foot"><span class="found">found ' + esc(fmtDay(d.date_found)) + "</span>" + action + (row ? '<span class="chev">' + ic("chevron") + "</span>" : "") + "</div></article>"
    );
  }

  function skeletonBoard() {
    var col = function () { return '<div class="col"><div class="skel" style="height:22px;width:60%"></div><div class="skel" style="height:118px"></div><div class="skel" style="height:118px"></div></div>'; };
    return '<div class="board"><section class="group"><div class="cols">' + col() + col() + '</div></section><section class="group"><div class="cols">' + col() + col() + "</div></section></div>";
  }

  function renderViews() {
    var host = $("#views");
    if (!S.loaded) { host.innerHTML = skeletonBoard(); return; }
    var list = filtered();
    syncToolbar(list.length);
    var keepScroll = $(".board", host) ? $(".board", host).scrollLeft : 0;

    if (!S.docs.length) {
      host.innerHTML = '<div class="empty"><h3>No postings yet</h3><p>The first scheduled run will fill this in — or start one now.</p><button class="btn primary" type="button" data-act="run">' + ic("play") + "Run now</button></div>";
      return;
    }
    if (!list.length) {
      host.innerHTML = '<div class="empty"><h3>Nothing matches these filters</h3><p>Try widening the tier or track, or clear the filter text.</p><button class="btn" type="button" data-act="clear-filters">Clear filters</button></div>';
      return;
    }

    var idx = 0;
    if (S.view === "board") {
      var col = function (status) {
        var items = list.filter(function (d) { return d.status === status; });
        return '<div class="col' + (items.length ? '' : ' is-empty') + '" data-status="' + status + '" style="--c:' + STATUS_COLOR[status] + '">' +
          '<div class="col-head"><span class="sw"></span>' + esc(status) + '<span class="cn">' + items.length + "</span></div>" +
          '<div class="col-body">' + (items.length ? items.map(function (d) { return cardHtml(d, "board", idx++); }).join("") : '<div class="col-empty">' + esc(STATUS_HINT[status]) + "<br>drop a card here</div>") + "</div></div>";
      };
      host.innerHTML = '<div class="board">' +
        '<section class="group" aria-label="Active"><div class="group-head"><h2>Active</h2><span class="section-sub">needs your decision</span></div><div class="cols">' + ACTIVE.map(col).join("") + "</div></section>" +
        '<section class="group" aria-label="Applied jobs"><div class="group-head"><h2>Applied jobs</h2><span class="section-sub">moved here once applied</span><button class="btn sm" type="button" data-act="export">' + ic("download") + "Export CSV</button></div><div class=\"cols\">" + APPLIED.map(col).join("") + "</div></section></div>";
      var b = $(".board", host);
      if (b) b.scrollLeft = keepScroll;
    } else {
      var act = list.filter(function (d) { return !isApplied(d); });
      var app = list.filter(isApplied);
      var sec = function (title, sub, items, extra) {
        return '<div class="section-head"><h2>' + title + '</h2><span class="section-sub">' + sub + "</span>" + (extra || "") + "</div>" +
          (items.length ? '<div class="list">' + items.map(function (d) { return cardHtml(d, "row", idx++); }).join("") + "</div>" : '<div class="empty" style="margin-bottom:26px;padding:28px"><p>Nothing here with the current filters.</p></div>');
      };
      host.innerHTML = sec("Active", act.length + " awaiting a decision", act) +
        sec("Applied jobs", "moves here automatically once you set Applied, Interview, Rejected or Not Pursuing", app, '<button class="btn sm" type="button" data-act="export">' + ic("download") + "Export CSV</button>");
    }
    if (S.loadedOnce) host.classList.add("settled");
    S.loadedOnce = true;
    var sel = S.open && $('.card[data-id="' + cssEsc(S.open) + '"]');
    if (sel) sel.classList.add("sel");
  }
  function cssEsc(s) { return String(s).replace(/["\\]/g, "\\$&"); }

  function renderAll() {
    renderHealth();
    renderMission();
    renderViews();
    if (S.open) refreshDrawer();
    $$('.seg [data-view]').forEach(function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-view") === S.view)); });
  }

  // ------------------------------------------------------------------ status changes (optimistic + undo)
  function changeStatus(id, next, opts) {
    opts = opts || {};
    var doc = S.docs.filter(function (d) { return d.id === id; })[0];
    if (!doc || doc.status === next) return Promise.resolve();
    var prev = doc.status, prevAt = doc.status_changed_at;
    doc.status = next; doc.status_changed_at = new Date().toISOString();
    S.statSig = "";
    renderAll();
    return api("/api/postings/" + encodeURIComponent(id) + "/status", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: next }),
    }).then(function () {
      if (!opts.silent) toast(esc(doc.company) + " → <b>" + esc(next) + "</b>", { undo: function () { changeStatus(id, prev, { silent: true }); } });
    }).catch(function (err) {
      doc.status = prev; doc.status_changed_at = prevAt;
      S.statSig = "";
      renderAll();
      if (err && err.code === 401) showLock("Session expired — enter the access key again.");
      else toast("Couldn't save that change (" + esc(err.message) + "). It was reverted.", { error: true });
    });
  }

  // ------------------------------------------------------------------ drawer
  var lastFocus = null;
  function openDrawer(id) {
    var d = S.docs.filter(function (x) { return x.id === id; })[0];
    if (!d) return;
    S.open = id;
    lastFocus = document.activeElement;
    $("#scrim").hidden = false;
    var dr = $("#drawer");
    dr.hidden = false;
    dr.innerHTML = drawerHtml(d);
    var cl = $("#drClose", dr); if (cl) cl.focus();
    $$(".card.sel").forEach(function (c) { c.classList.remove("sel"); });
    var c = $('.card[data-id="' + cssEsc(id) + '"]'); if (c) c.classList.add("sel");
    setHash({ p: id });
  }
  function refreshDrawer() {
    var d = S.docs.filter(function (x) { return x.id === S.open; })[0];
    var dr = $("#drawer");
    if (!d) { closeDrawer(); return; }
    var body = $(".dr-body", dr), top = body ? body.scrollTop : 0;
    dr.innerHTML = drawerHtml(d);
    var nb = $(".dr-body", dr); if (nb) nb.scrollTop = top;
  }
  function closeDrawer() {
    if (!S.open) return;
    S.open = null;
    $("#drawer").hidden = true; $("#scrim").hidden = true;
    $$(".card.sel").forEach(function (c) { c.classList.remove("sel"); });
    setHash({ p: null });
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
  }
  function bullets(items, kind) {
    if (!items || !items.length) return '<p class="body" style="color:var(--ink-3)">None recorded.</p>';
    return '<ul class="bullets ' + kind + '">' + items.map(function (t) { return "<li>" + ic(kind === "good" ? "check" : "alert") + "<span>" + esc(t) + "</span></li>"; }).join("") + "</ul>";
  }
  function drawerHtml(d) {
    var kv = function (k, v) { return v ? "<dt>" + k + "</dt><dd>" + esc(v) + "</dd>" : ""; };
    return (
      '<header class="dr-head"><div style="min-width:0"><p class="eyebrow">' + esc(d.company) + '</p><h2 id="drTitle">' + esc(d.title) + "</h2></div>" +
      '<button class="icon-btn" id="drClose" type="button" data-act="close-drawer" aria-label="Close details">' + ic("x") + "</button></header>" +
      '<div class="dr-body">' +
      '<div class="dr-score">' + ringSvg(d.score, d.decision, 84, true) + '<div class="ds-meta"><div class="card-tags"><span class="pill ' + esc(d.decision) + '"><i class="dot"></i>' + cap(d.decision) + "</span>" + (d.sponsorship_verified ? sponTag(d) : "") + "</div>" +
      '<div class="ds-line">Confidence: ' + esc(d.confidence || "n/a") + " · " + esc(d.track === "sponsorship" ? "Sponsorship track" : "Italy-remote track") + "</div></div></div>" +
      '<div class="dr-actions"><a class="btn primary" href="' + esc(safeUrl(d.source_url)) + '" target="_blank" rel="noopener noreferrer">' + ic("external") + 'Open posting</a><button class="btn" type="button" data-act="copy-link" data-id="' + esc(d.id) + '">' + ic("copy") + "Copy link</button></div>" +
      "<section><h3>Why it scored this</h3><p class=\"body\">" + esc(d.one_line_reason || "—") + "</p></section>" +
      (d.sponsorship_verified && d.sponsorship_evidence
        ? '<section class="evidence"><h3>' + ic("shield") + 'Sponsorship — verified verbatim</h3><blockquote>' + esc(d.sponsorship_evidence) + '</blockquote><p class="src">Quoted from the employer\'s own posting, and checked against the fetched text before it was saved.</p></section>'
        : "") +
      '<section><h3>Details</h3><dl class="kv">' + kv("Location", d.location) + kv("Eligibility", d.remote_eligibility) + kv("Seniority", d.seniority_detected) + kv("Salary", d.salary) + kv("Found", d.date_found ? new Date(d.date_found).toLocaleString() : "") + "</dl></section>" +
      "<section><h3>Matches</h3>" + bullets(d.matched_requirements, "good") + "</section>" +
      "<section><h3>Gaps &amp; open questions</h3>" + bullets(d.gaps, "gap") + "</section>" +
      (d.tailored_summary ? '<section><h3>Tailoring note</h3><div class="note">' + esc(d.tailored_summary) + '<button class="icon-btn" type="button" data-act="copy-note" data-id="' + esc(d.id) + '" aria-label="Copy tailoring note">' + ic("copy") + "</button></div></section>" : "") +
      '<section><h3>Status</h3><div class="stepper">' + STATUSES.map(function (s) {
        return '<button type="button" data-act="set-status" data-id="' + esc(d.id) + '" data-status="' + esc(s) + '" style="--c:' + STATUS_COLOR[s] + '" aria-pressed="' + (d.status === s ? "true" : "false") + '"><span class="sw"></span>' + esc(s) + "</button>";
      }).join("") + "</div></section></div>"
    );
  }

  // ------------------------------------------------------------------ toasts, tooltip, banner
  function toast(html, opts) {
    opts = opts || {};
    var el = document.createElement("div");
    el.className = "toast" + (opts.error ? " err" : "");
    el.innerHTML = '<span class="tm">' + html + "</span>" + (opts.undo ? '<button class="btn" type="button">' + ic("undo") + "Undo</button>" : "");
    var close = function () { el.classList.add("out"); setTimeout(function () { el.remove(); }, 220); };
    if (opts.undo) $("button", el).addEventListener("click", function () { opts.undo(); close(); });
    $("#toasts").appendChild(el);
    while ($("#toasts").children.length > 3) $("#toasts").firstChild.remove();
    setTimeout(close, opts.error ? 9000 : 6500);
  }
  function showBanner(msg) { var b = $("#banner"); b.textContent = msg; b.hidden = false; }
  function hideBanner() { $("#banner").hidden = true; }

  var tipEl = null;
  function bindTooltip() {
    tipEl = $("#tip");
    document.addEventListener("pointermove", function (e) {
      var t = e.target.closest ? e.target.closest("[data-tip]") : null;
      if (!t) { tipEl.hidden = true; return; }
      tipEl.textContent = t.getAttribute("data-tip");
      tipEl.hidden = false;
      var w = tipEl.offsetWidth, x = Math.min(window.innerWidth - w - 8, Math.max(8, e.clientX + 12));
      tipEl.style.left = x + "px"; tipEl.style.top = e.clientY + 16 + "px";
    });
    document.addEventListener("pointerleave", function () { tipEl.hidden = true; });
  }

  // ------------------------------------------------------------------ lock
  function showLock(msg) {
    $("#lock").hidden = false;
    var err = $("#lockErr");
    err.textContent = msg || ""; err.hidden = !msg;
    setTimeout(function () { $("#lockInput").focus(); }, 30);
  }
  function hideLock() { $("#lock").hidden = true; }

  // ------------------------------------------------------------------ hash (deep links)
  function readHash() { return new URLSearchParams(location.hash.replace(/^#/, "")); }
  function setHash(patch) {
    var p = readHash();
    Object.keys(patch).forEach(function (k) { if (patch[k] == null) p.delete(k); else p.set(k, patch[k]); });
    var s = p.toString();
    history.replaceState(null, "", location.pathname + location.search + (s ? "#" + s : ""));
  }

  // ------------------------------------------------------------------ command palette
  var P = { open: false, items: [], sel: 0 };
  function commands() {
    return [
      { label: "Run pipeline now", hint: "search & screen both tracks", icon: "play", run: function () { openConsole(true); } },
      { label: "View run history", hint: "what ran, what it found", icon: "pulse", run: function () { openConsole(false); } },
      { label: "Switch to board view", hint: "b", icon: "board", run: function () { setView("board"); } },
      { label: "Switch to list view", hint: "l", icon: "list", run: function () { setView("list"); } },
      { label: "Filter: apply tier", icon: "check", run: function () { S.filters.decision = "apply"; refilter(); } },
      { label: "Filter: review tier", icon: "check", run: function () { S.filters.decision = "review"; refilter(); } },
      { label: "Filter: verified sponsorship", icon: "shield", run: function () { S.filters.track = "sponsorship"; refilter(); } },
      { label: "Filter: Italy-remote", icon: "check", run: function () { S.filters.track = "italy-remote"; refilter(); } },
      { label: "Clear all filters", icon: "x", run: function () { S.filters = { decision: "", track: "", status: "", q: "" }; $("#q").value = ""; refilter(); } },
      { label: "Export applied jobs (CSV)", icon: "download", run: exportCsv },
      { label: "Toggle light / dark theme", icon: "sun", run: toggleTheme },
      { label: "Lock this device", hint: "forget the access key", icon: "lock", run: lockDevice },
    ];
  }
  function paletteItems(q) {
    q = q.trim().toLowerCase();
    var cmds = commands().filter(function (c) { return !q || c.label.toLowerCase().indexOf(q) !== -1; });
    var posts = S.docs.filter(function (d) { return !q || (d.company + " " + d.title).toLowerCase().indexOf(q) !== -1; })
      .sort(function (a, b) { return b.score - a.score; }).slice(0, q ? 8 : 5);
    var items = [];
    cmds.forEach(function (c) { items.push({ g: "Actions", label: c.label, hint: c.hint || "", icon: c.icon, run: c.run }); });
    posts.forEach(function (d) { items.push({ g: "Postings", label: d.company + " — " + d.title, hint: d.score + " · " + d.status, icon: "chevron", run: function () { openDrawer(d.id); } }); });
    return items;
  }
  function renderPalette() {
    var list = $("#paletteList"), html = "", lastG = "";
    if (!P.items.length) { list.innerHTML = '<li class="pl-empty">No matches</li>'; return; }
    P.items.forEach(function (it, i) {
      if (it.g !== lastG) { html += '<li class="pl-group" role="presentation">' + it.g + "</li>"; lastG = it.g; }
      html += '<li class="pl-item" role="option" id="pl' + i + '" data-i="' + i + '" aria-selected="' + (i === P.sel) + '">' + ic(it.icon) + '<span class="pl-main">' + esc(it.label) + '</span><span class="pl-hint">' + esc(it.hint) + "</span></li>";
    });
    list.innerHTML = html;
    var cur = $("#pl" + P.sel); if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: "nearest" });
  }
  function openPalette() {
    if (P.open) return;
    P.open = true; lastFocus = document.activeElement;
    $("#palette").hidden = false;
    var inp = $("#paletteInput"); inp.value = ""; inp.focus();
    P.items = paletteItems(""); P.sel = 0; renderPalette();
  }
  function closePalette() {
    if (!P.open) return;
    P.open = false; $("#palette").hidden = true;
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
  }
  function runPaletteItem(i) {
    var it = P.items[i]; if (!it) return;
    P.open = false; $("#palette").hidden = true;
    it.run();
  }

  // ------------------------------------------------------------------ run console
  var runInfo = { logging: false };
  function openConsole(autorun) {
    var m = $("#console");
    m.hidden = false; lastFocus = lastFocus || document.activeElement;
    if (!runInfo.logging) renderHistory();
    $("#runGo").focus();
    if (autorun) startRun();
    else api("/api/runs").then(function (r) { return r.json(); }).then(function (r) { S.runs = r; if (!runInfo.logging) renderHistory(); renderHealth(); }).catch(function () {});
  }
  function closeConsole() {
    $("#console").hidden = true;
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
  }
  function renderHistory() {
    var runs = (S.runs && S.runs.runs) || [];
    $("#consoleSub").textContent = runs.length ? "Recent runs · " + ((S.runs && S.runs.seen_count) || 0) + " postings evaluated to date" : "No runs recorded yet";
    var body = $("#consoleBody");
    if (!runs.length) { body.innerHTML = '<p style="font-family:var(--font);color:var(--ink-3);padding:18px 0">No runs yet. Press “Run now” to start one, or wait for the next scheduled run.</p>'; return; }
    body.innerHTML = '<table class="hist"><thead><tr><th>When</th><th>Result</th><th>Screened</th><th>Added</th><th>Notes</th></tr></thead><tbody>' + runs.map(function (r) {
      var c = r.status === "ok" ? "var(--good)" : r.status === "error" ? "var(--critical)" : "var(--accent)";
      var lbl = r.status === "ok" ? "OK" : r.status === "error" ? "Failed" : "Running";
      return "<tr><td>" + esc(relTime(r.started_at)) + '<br><span class="notes">' + esc(new Date(r.started_at).toLocaleString()) + '</span></td><td><span class="st" style="--c:' + c + '"><i></i>' + lbl + "</span></td><td>" + r.postings_evaluated + "</td><td>" + r.postings_added + '</td><td class="notes">' + esc(humanizeError(r.notes || "")) + "</td></tr>";
    }).join("") + "</tbody></table>";
  }
  function logLine(cls, label, html) {
    var body = $("#consoleBody");
    var el = document.createElement("div");
    el.className = "log " + cls;
    el.innerHTML = '<span class="lb">' + label + '</span><span class="lm">' + html + "</span>";
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
  }
  function shortUrl(u) {
    try { var x = new URL(u); return x.hostname.replace(/^(jobs|job-boards)\./, "") + x.pathname.replace(/\/$/, ""); } catch (e) { return u; }
  }
  function handleRunEvent(e) {
    switch (e.type) {
      case "start": logLine("run", "START", "Run #" + e.run_id + " · " + esc(e.tracks.join(" + "))); break;
      case "search": logLine("search", "SEARCH", "<b>" + e.hits + "</b> hits <span class=\"dim\">· " + esc(e.query) + "</span>"); break;
      case "discovered": logLine("found", "FOUND", e.hits + " hits → <b>" + e.job_pages + "</b> real job pages → <b>" + e.fresh + "</b> not seen before"); break;
      case "candidate": {
        var lb = { added: "ADDED", screened: "SCREENED", skipped: "SKIPPED", unverified: "UNVERIFIED", expired: "GONE", error: "ERROR" }[e.outcome] || e.outcome.toUpperCase();
        var who = e.company || e.title ? "<b>" + esc(e.company || "") + "</b> " + esc(e.title || "") + (e.score != null ? " · <b>" + e.score + "</b> " + esc(e.decision || "") : "") + " — " : "";
        logLine(e.outcome, lb, who + '<span class="dim">' + esc(e.detail || "") + '</span> <a href="' + esc(safeUrl(e.url)) + '" target="_blank" rel="noopener noreferrer">' + esc(shortUrl(e.url)) + "</a>");
        break;
      }
      case "error": logLine(e.fatal ? "fatal" : "error", e.fatal ? "STOPPED" : "ERROR", esc(humanizeError(e.message))); break;
      case "done": logLine("done", "DONE", "Screened <b>" + e.evaluated + "</b>, added <b>" + e.added + "</b> · used " + e.budget_used + " of 44 outbound requests" + (e.status === "error" ? " · <b>ended with an error</b>" : "")); break;
    }
  }
  function startRun() {
    if (runInfo.logging) return;
    var track = ($("#runTrack [aria-pressed=true]") || {}).getAttribute ? $("#runTrack [aria-pressed=true]").getAttribute("data-track") : "";
    runInfo.logging = true;
    $("#runGo").disabled = true;
    $("#progress").hidden = false;
    $("#consoleBody").innerHTML = "";
    $("#consoleSub").textContent = "Live run · " + (track || "both tracks");
    var added = 0;
    fetch("/api/run", { method: "POST", headers: { Authorization: "Bearer " + S.token, "content-type": "application/json" }, body: JSON.stringify(track ? { track: track } : {}) })
      .then(function (res) {
        if (res.status === 401) { var e = new Error("unauthorized"); e.code = 401; throw e; }
        if (res.status === 409) throw new Error("A run is already in progress — try again in a minute.");
        if (!res.ok || !res.body) throw new Error("HTTP " + res.status);
        var reader = res.body.getReader(), dec = new TextDecoder(), buf = "";
        return (function pump() {
          return reader.read().then(function (r) {
            if (r.done) return;
            buf += dec.decode(r.value, { stream: true });
            var lines = buf.split("\n"); buf = lines.pop();
            lines.forEach(function (ln) {
              if (!ln.trim()) return;
              try { var ev = JSON.parse(ln); if (ev.type === "done") added = ev.added; handleRunEvent(ev); } catch (x) {}
            });
            return pump();
          });
        })();
      })
      .catch(function (err) {
        if (err && err.code === 401) { closeConsole(); showLock("Session expired — enter the access key again."); return; }
        logLine("fatal", "STOPPED", esc(err.message));
      })
      .then(function () {
        runInfo.logging = false;
        $("#runGo").disabled = false;
        $("#progress").hidden = true;
        loadAll(true);
        if ($("#console").hidden) toast("Pipeline run finished — " + added + " added.");
      });
  }

  // ------------------------------------------------------------------ misc actions
  function setView(v) {
    S.view = v; store.set("jb.view", v);
    S.statSig = ""; renderAll();
  }
  function refilter() { S.statSig = ""; renderMission(); renderViews(); }
  function toggleTheme() {
    var t = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", t); store.set("jb.theme", t);
    syncThemeIcon();
  }
  function syncThemeIcon() {
    var dark = document.documentElement.getAttribute("data-theme") === "dark";
    $("#themeBtn").innerHTML = ic(dark ? "sun" : "moon");
  }
  function lockDevice() { store.del("jb.key"); S.token = ""; S.loaded = false; S.docs = []; S.sig = ""; renderAll(); closeDrawer(); showLock(""); }
  function exportCsv() {
    api("/api/export/applied.csv").then(function (r) { return r.blob(); }).then(function (blob) {
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = "jobberman-applied-jobs.csv";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    }).catch(function (e) { toast("Couldn't export (" + esc(e.message) + ").", { error: true }); });
  }
  function copy(text, ok) {
    var done = function () { toast(ok); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { toast("Couldn't copy to the clipboard.", { error: true }); });
    else toast("Clipboard isn't available here.", { error: true });
  }

  // ------------------------------------------------------------------ events
  function trapTab(e, container) {
    if (e.key !== "Tab") return;
    var f = $$('a[href], button:not([disabled]), input, select, [tabindex="0"]', container).filter(function (x) { return x.offsetParent !== null; });
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function bindEvents() {
    // global clicks (delegated)
    document.addEventListener("click", function (e) {
      var t = e.target;
      var actEl = t.closest && t.closest("[data-act]");
      if (actEl) {
        var act = actEl.getAttribute("data-act"), id = actEl.getAttribute("data-id");
        if (act === "applied") { e.stopPropagation(); changeStatus(id, "Applied"); return; }
        if (act === "set-status") { changeStatus(id, actEl.getAttribute("data-status")); return; }
        if (act === "close-drawer") { closeDrawer(); return; }
        if (act === "run") { openConsole(true); return; }
        if (act === "history") { openConsole(false); return; }
        if (act === "export") { exportCsv(); return; }
        if (act === "clear-status") { S.filters.status = ""; refilter(); return; }
        if (act === "clear-filters") { S.filters = { decision: "", track: "", status: "", q: "" }; $("#q").value = ""; refilter(); return; }
        if (act === "copy-link") { copy(location.origin + location.pathname + "#p=" + encodeURIComponent(id), "Link copied."); return; }
        if (act === "copy-note") { var d = S.docs.filter(function (x) { return x.id === id; })[0]; if (d) copy(d.tailored_summary || "", "Tailoring note copied."); return; }
      }
      var kpi = t.closest && t.closest("[data-kpi]");
      if (kpi) { var kv = kpi.getAttribute("data-kpi").split(":"); S.filters[kv[0]] = S.filters[kv[0]] === kv[1] ? "" : kv[1]; refilter(); return; }
      var stg = t.closest && t.closest(".funnel-bar [data-status], .legend [data-status]");
      if (stg) { var s = stg.getAttribute("data-status"); S.filters.status = S.filters.status === s ? "" : s; refilter(); return; }
      var seg = t.closest && t.closest("#toolbar .seg button");
      if (seg) { S.filters[seg.parentNode.getAttribute("data-group")] = seg.getAttribute("data-v"); refilter(); return; }
      var vb = t.closest && t.closest("[data-view]");
      if (vb) { setView(vb.getAttribute("data-view")); return; }
      var rt = t.closest && t.closest("#runTrack button");
      if (rt) { $$("#runTrack button").forEach(function (b) { b.setAttribute("aria-pressed", String(b === rt)); }); return; }
      var card = t.closest && t.closest(".card");
      if (card && !t.closest("button, a")) { openDrawer(card.getAttribute("data-id")); return; }
      var pl = t.closest && t.closest(".pl-item");
      if (pl) { runPaletteItem(Number(pl.getAttribute("data-i"))); return; }
    });

    $("#scrim").addEventListener("click", closeDrawer);
    $("#palette").addEventListener("mousedown", function (e) { if (e.target === this) closePalette(); });
    $("#console").addEventListener("mousedown", function (e) { if (e.target === this) closeConsole(); });
    $("#consoleClose").addEventListener("click", closeConsole);
    $("#runGo").addEventListener("click", startRun);
    $("#cmdkBtn").addEventListener("click", openPalette);
    $("#themeBtn").addEventListener("click", toggleTheme);
    $("#lockBtn").addEventListener("click", lockDevice);

    $("#toolbar").addEventListener("input", function (e) {
      if (e.target.id === "q") { S.filters.q = e.target.value; renderViews(); }
    });
    $("#toolbar").addEventListener("change", function (e) {
      if (e.target.id === "sort") { S.sort = e.target.value; renderViews(); }
    });

    // palette input
    $("#paletteInput").addEventListener("input", function () { P.items = paletteItems(this.value); P.sel = 0; renderPalette(); });
    $("#paletteInput").addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); P.sel = Math.min(P.items.length - 1, P.sel + 1); renderPalette(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); P.sel = Math.max(0, P.sel - 1); renderPalette(); }
      else if (e.key === "Enter") { e.preventDefault(); runPaletteItem(P.sel); }
    });
    $("#paletteList").addEventListener("mousemove", function (e) {
      var it = e.target.closest(".pl-item");
      if (it && Number(it.getAttribute("data-i")) !== P.sel) { P.sel = Number(it.getAttribute("data-i")); $$(".pl-item").forEach(function (x) { x.setAttribute("aria-selected", String(x === it)); }); }
    });

    // lock form
    $("#lockForm").addEventListener("submit", function (e) {
      e.preventDefault();
      var v = $("#lockInput").value.trim(); if (!v) return;
      S.token = v;
      api("/api/ping").then(function () {
        store.set("jb.key", v); $("#lockInput").value = ""; hideLock(); loadAll();
      }).catch(function (err) {
        S.token = store.get("jb.key") || "";
        showLock(err && err.code === 401 ? "That access key was not accepted." : "Couldn't reach the server (" + err.message + ").");
      });
    });

    // card glow follows the pointer
    document.addEventListener("pointermove", function (e) {
      var c = e.target.closest && e.target.closest(".card");
      if (!c) return;
      var r = c.getBoundingClientRect();
      c.style.setProperty("--mx", e.clientX - r.left + "px"); c.style.setProperty("--my", e.clientY - r.top + "px");
    });

    // drag & drop between columns
    document.addEventListener("dragstart", function (e) {
      var c = e.target.closest && e.target.closest(".card[draggable]");
      if (!c) return;
      S.dragging = c.getAttribute("data-id");
      e.dataTransfer.setData("text/plain", S.dragging); e.dataTransfer.effectAllowed = "move";
      c.classList.add("dragging"); document.body.classList.add("is-dragging");
    });
    document.addEventListener("dragend", function () {
      S.dragging = null; document.body.classList.remove("is-dragging");
      $$(".card.dragging").forEach(function (c) { c.classList.remove("dragging"); });
      $$(".col.drop").forEach(function (c) { c.classList.remove("drop"); });
    });
    document.addEventListener("dragover", function (e) {
      var col = e.target.closest && e.target.closest(".col[data-status]");
      if (!col || !S.dragging) return;
      e.preventDefault(); e.dataTransfer.dropEffect = "move";
      $$(".col.drop").forEach(function (c) { if (c !== col) c.classList.remove("drop"); });
      col.classList.add("drop");
    });
    document.addEventListener("drop", function (e) {
      var col = e.target.closest && e.target.closest(".col[data-status]");
      if (!col || !S.dragging) return;
      e.preventDefault();
      var id = S.dragging; S.dragging = null;
      col.classList.remove("drop");
      changeStatus(id, col.getAttribute("data-status"));
    });

    // keyboard
    document.addEventListener("keydown", function (e) {
      var ae = document.activeElement, typing = ae && (/^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) || ae.isContentEditable);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); P.open ? closePalette() : openPalette(); return; }
      if (e.key === "Escape") {
        if (P.open) closePalette();
        else if (!$("#console").hidden) closeConsole();
        else if (S.open) closeDrawer();
        else if (ae && ae.id === "q") { if (ae.value) { ae.value = ""; S.filters.q = ""; renderViews(); } else ae.blur(); }
        return;
      }
      if (P.open) return;
      if (!$("#console").hidden) { trapTab(e, $("#console")); return; }
      if (S.open) { trapTab(e, $("#drawer")); }
      if (e.key === "Enter" && ae && ae.classList && ae.classList.contains("card")) { e.preventDefault(); openDrawer(ae.getAttribute("data-id")); return; }
      if (typing || e.ctrlKey || e.metaKey || e.altKey || !$("#lock").hidden) return;
      var k = e.key;
      if (k === "/") { e.preventDefault(); $("#q").focus(); }
      else if (k === "b") setView("board");
      else if (k === "l") setView("list");
      else if (k === "j" || k === "k") {
        var cards = $$(".card"); if (!cards.length) return;
        var i = cards.indexOf(ae), n = k === "j" ? Math.min(cards.length - 1, i + 1) : Math.max(0, i < 0 ? 0 : i - 1);
        cards[n].focus(); cards[n].scrollIntoView({ block: "nearest", inline: "nearest" });
      } else if (k === "a" && ae && ae.classList && ae.classList.contains("card")) {
        var d = S.docs.filter(function (x) { return x.id === ae.getAttribute("data-id"); })[0];
        if (d && !isApplied(d)) changeStatus(d.id, "Applied");
      }
    });
  }

  // ------------------------------------------------------------------ boot
  function init() {
    var h = readHash();
    if (h.get("key")) {
      S.token = h.get("key"); store.set("jb.key", S.token); setHash({ key: null });
    }
    if (h.get("view") === "list" || h.get("view") === "board") { S.view = h.get("view"); setHash({ view: null }); }
    syncThemeIcon();
    buildToolbar();
    bindTooltip();
    bindEvents();
    renderAll();

    var wantOpen = h.get("p");
    var deep = function () {
      if (wantOpen && S.docs.some(function (d) { return d.id === wantOpen; })) { var w = wantOpen; wantOpen = null; openDrawer(w); }
      if (h.get("cmdk")) { h.delete("cmdk"); setHash({ cmdk: null }); openPalette(); }
      if (h.get("console")) { h.delete("console"); setHash({ console: null }); openConsole(false); }
    };
    if (!S.token) showLock("");
    else loadAll().then(deep);

    setInterval(function () { if (S.token && !S.dragging && !runInfo.logging) loadAll(true); }, 60000);
    setInterval(renderHealth, 30000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
