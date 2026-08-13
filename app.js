/* Power Trasporti — Foglio Viaggi
   Local-first PWA. All data stays on this device (localStorage). */
(function () {
  "use strict";

  // Marks the page as running in the installed app (not a regular Safari
  // tab) as early as possible, using TWO checks together for reliability:
  // the modern standard (matchMedia display-mode) and the older,
  // iOS-specific navigator.standalone property that Safari has supported
  // for this exact purpose since early iOS versions. Adding a class in
  // JS (rather than relying purely on the CSS @media rule) sidesteps any
  // possible quirk with how a specific iOS/Safari version evaluates that
  // media query, and lets the CSS use a plain, simple class selector.
  var isStandaloneApp =
    (window.navigator && window.navigator.standalone === true) ||
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  if (isStandaloneApp) document.documentElement.classList.add('is-standalone');

  /* ---------------------------------------------------------------- */
  /* Constants                                                         */
  /* ---------------------------------------------------------------- */
  var LS_PROFILE = "pt_profile_v1";
  var LS_SHEETS = "pt_sheets_v1";
  var LS_CURRENT = "pt_current_sheet_v1";
  var LS_FUEL = "pt_fuel_v1"; // fuel receipts, keyed by month — independent of any client sheet

  var MESI = ["Gennaio", "Febbraio", "Marzo", "Aprile", "Maggio", "Giugno",
    "Luglio", "Agosto", "Settembre", "Ottobre", "Novembre", "Dicembre"];
  var GIORNI_SETT = ["Domenica", "Lunedì", "Martedì", "Mercoledì", "Giovedì", "Venerdì", "Sabato"];

  var COMPANY = {
    nomeLogo: "POWER TRASPORTI",
    indirizzo: "MARTINO E SOLFERINO, 128, PONTE SAN NICOLO' (PD)",
    cf: "CNDVTR95E01Z140M",
    piva: "05544500282"
  };

  /* ---------------------------------------------------------------- */
  /* Storage helpers                                                   */
  /* ---------------------------------------------------------------- */
  function loadJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (e) { return fallback; }
  }
  function saveJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* storage full/unavailable */ }
  }

  function loadProfile() {
    return loadJSON(LS_PROFILE, {
      nome: "", targa: "", perContoDi: "BARCELLA",
      da: "Ponte San Nicolò", provDa: "PD", frequent: {},
      dailyRate: ""
    });
  }
  function saveProfile(p) { saveJSON(LS_PROFILE, p); }

  function loadSheets() { return loadJSON(LS_SHEETS, []); }
  function saveSheets(arr) { saveJSON(LS_SHEETS, arr); }

  // Fuel receipts are logged per CALENDAR DAY, for the truck/driver as a
  // whole — never tied to any one client. Whether a month has one client
  // sheet or ten, the same set of receipts for that month is shared by
  // all of them: { "2026-8": { "5": {data,w,h}, "12": {...} }, ... }
  function loadFuel() { return loadJSON(LS_FUEL, {}); }
  function saveFuel(obj) { saveJSON(LS_FUEL, obj); }
  function fuelMonthKey(month, year) { return year + '-' + month; }

  function getCurrentSheetId() { return localStorage.getItem(LS_CURRENT) || null; }
  function setCurrentSheetId(id) { if (id) localStorage.setItem(LS_CURRENT, id); }

  var state = {
    profile: loadProfile(),
    sheets: loadSheets(),
    fuel: loadFuel(),
    currentSheetId: getCurrentSheetId(),
    editingDay: null,
    acResults: []
  };

  // Set when a new app version is ready but a modal is currently open — the
  // page reloads to pick it up as soon as that modal closes, so no unsaved
  // typing is lost, but the update still lands as quickly as possible.
  var pendingReloadAfterModalClose = false;
  function reloadIfUpdatePending() {
    if (pendingReloadAfterModalClose) window.location.reload();
  }

  /* ---------------------------------------------------------------- */
  /* Utilities                                                         */
  /* ---------------------------------------------------------------- */
  function uid() { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function pad2(n) { return n < 10 ? "0" + n : "" + n; }
  function daysInMonth(month, year) { return new Date(year, month, 0).getDate(); }
  function normalize(str) {
    return (str || "").toString().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  }
  function titleCase(str) {
    return (str || "").toLowerCase().replace(/(^|[\s'-])\p{L}/gu, function (m) { return m.toUpperCase(); });
  }
  function sortKey(sheet) { return sheet.year * 12 + sheet.month; }
  function findSheet(id) { return state.sheets.find(function (s) { return s.id === id; }) || null; }
  // The driver works in ONE month at a time — once a month ends, work
  // moves to the next one; a client from a past month can still be
  // opened/edited, but it can't be "active" again just because a sheet
  // for it was touched most recently. So "active" is the MONTH with the
  // highest month+year among all sheets — not a specific client, and not
  // simply whichever sheet was created last.
  function latestSheet() {
    if (!state.sheets.length) return null;
    return state.sheets.slice().sort(function (a, b) {
      var k = sortKey(b) - sortKey(a);
      if (k !== 0) return k;
      // Same month+year (e.g. two different clients) — the more recently
      // created one is what "open the latest sheet" should land on.
      return (b.createdAt || '').localeCompare(a.createdAt || '');
    })[0];
  }
  function activeMonthKey() {
    var latest = latestSheet();
    return latest ? (latest.year + '-' + latest.month) : null;
  }
  function isInActiveMonth(sheet) {
    if (!sheet) return false;
    return activeMonthKey() === (sheet.year + '-' + sheet.month);
  }
  function currentSheet() {
    var s = state.currentSheetId ? findSheet(state.currentSheetId) : null;
    return s || latestSheet();
  }
  function isNewestSheet(sheet) {
    var latest = latestSheet();
    return latest && sheet && latest.id === sheet.id;
  }
  // A physical paper sheet has exactly one client written at the top
  // ("Per conto di: ..."), covering the whole month. If a driver works for
  // more than one client within the same month, that means more than one
  // sheet — one per client, each its own separate document, just like on
  // paper. So a sheet is identified by month + year + client together,
  // not just month + year.
  function sheetForMonth(month, year, client) {
    var normClient = (client || '').trim().toUpperCase();
    return state.sheets.find(function (s) {
      return s.month === month && s.year === year && (s.perContoDi || '').trim().toUpperCase() === normClient;
    }) || null;
  }
  function sheetsForMonth(month, year) {
    return state.sheets.filter(function (s) { return s.month === month && s.year === year; });
  }
  function sheetKmAndTrips(sheet) {
    var viaggi = 0, km = 0;
    Object.keys(sheet.giorni).forEach(function (d) {
      var g = sheet.giorni[d];
      if (!g || !(g.a || g.ddt || g.kmFine !== "")) return;
      viaggi++;
      if (g.kmInizio !== "" && g.kmFine !== "" && !isNaN(g.kmFine - g.kmInizio)) {
        km += (Number(g.kmFine) - Number(g.kmInizio));
      }
    });
    return { viaggi: viaggi, km: km };
  }
  // Aggregates every client sheet that shares the same month+year — this is
  // what lets the app show "this month, across all clients" totals, plus a
  // per-client breakdown, instead of only ever showing one sheet at a time.
  function monthSummary(month, year) {
    var sheets = sheetsForMonth(month, year);
    var totalKm = 0, totalViaggi = 0;
    var byClient = sheets.map(function (s) {
      var stats = sheetKmAndTrips(s);
      totalKm += stats.km; totalViaggi += stats.viaggi;
      return { sheetId: s.id, client: s.perContoDi || '—', km: stats.km, viaggi: stats.viaggi };
    }).sort(function (a, b) { return b.km - a.km; });
    return { month: month, year: year, totalKm: totalKm, totalViaggi: totalViaggi, byClient: byClient };
  }

  // Today's trips/km, counted across EVERY client sheet for the real
  // current month — if the driver did two giri today for two different
  // clients, that's 2 trips today, not 1. Only meaningful when the month
  // being looked at is the actual current month; returns null otherwise.
  function todayStats(month, year) {
    var now = new Date();
    if (now.getMonth() + 1 !== month || now.getFullYear() !== year) return null;
    var day = now.getDate();
    var viaggi = 0, km = 0;
    sheetsForMonth(month, year).forEach(function (s) {
      var g = s.giorni[day];
      if (!g || !(g.a || g.ddt || g.kmFine !== "")) return;
      viaggi++;
      if (g.kmInizio !== "" && g.kmFine !== "" && !isNaN(g.kmFine - g.kmInizio)) km += (Number(g.kmFine) - Number(g.kmInizio));
    });
    return { viaggi: viaggi, km: km };
  }

  // The driver's pay is per WORKED DAY, not per giro — a day with trips
  // for two different clients still only counts once. Bonuses are added
  // per day (optional, entered in the day editor) and summed on top,
  // across every client sheet for the month, growing as each day is
  // filled in — never shown in the PDF, purely a personal reference.
  function monthEarnings(month, year) {
    var sheets = sheetsForMonth(month, year);
    var workedDays = {};
    var totalBonus = 0;
    sheets.forEach(function (s) {
      var countsForRate = s.countsForDailyRate !== false; // older sheets default to true
      Object.keys(s.giorni).forEach(function (d) {
        var g = s.giorni[d];
        if (!g) return;
        // A day only counts toward the daily rate if it has a trip on a
        // client sheet that's marked as counting for it. A client-only-
        // pays-a-bonus sheet never triggers the daily rate on its own.
        if (countsForRate && (g.a || g.ddt || g.kmFine !== "")) workedDays[d] = true;
        // Bonuses always add, regardless of which client's sheet they're on.
        if (g.bonus !== "" && g.bonus !== undefined && g.bonus !== null && !isNaN(g.bonus)) totalBonus += Number(g.bonus);
      });
    });
    var workedDaysCount = Object.keys(workedDays).length;
    var dailyRate = (state.profile.dailyRate === "" || state.profile.dailyRate === undefined) ? 0 : Number(state.profile.dailyRate);
    var dailyEarnings = workedDaysCount * dailyRate;
    return {
      workedDaysCount: workedDaysCount,
      dailyRate: dailyRate,
      dailyEarnings: dailyEarnings,
      totalBonus: totalBonus,
      totalEarnings: dailyEarnings + totalBonus,
      hasRate: state.profile.dailyRate !== "" && state.profile.dailyRate !== undefined
    };
  }

  function toast(msg) {
    var t = document.getElementById('toast');
    document.getElementById('toast-text').textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }

  /* ---------------------------------------------------------------- */
  /* Comuni / autocomplete                                             */
  /* ---------------------------------------------------------------- */
  var COMUNI = window.COMUNI_DB || [];
  // sorted by name length descending once, used for frazioni fallback matching
  var COMUNI_BY_LEN = COMUNI.slice().sort(function (a, b) { return b[0].length - a[0].length; });

  function lookupProvincia(nomeLocalita) {
    var n = normalize(nomeLocalita);
    if (!n) return "";
    var exact = COMUNI.find(function (c) { return normalize(c[0]) === n; });
    if (exact) return exact[1];
    // Fallback for frazioni/hamlets not in the comuni list, e.g. "Musano di Trevignano"
    // -> try to find a known comune name contained as a whole word inside the typed text
    // (checking longest names first so "San Vendemiano" wins over a shorter partial match).
    for (var i = 0; i < COMUNI_BY_LEN.length; i++) {
      var cname = normalize(COMUNI_BY_LEN[i][0]);
      if (cname.length < 4) continue; // avoid noisy short-name false positives
      var re = new RegExp('(^|\\s)' + cname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|\\s)');
      if (re.test(n)) return COMUNI_BY_LEN[i][1];
    }
    return "";
  }
  function searchComuni(query, limit) {
    limit = limit || 8;
    var q = normalize(query);
    var freq = state.profile.frequent || {};
    if (!q) {
      var favs = Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a]; }).slice(0, limit);
      return favs.map(function (name) {
        var prov = lookupProvincia(name);
        return { name: name, sigla: prov };
      });
    }
    var starts = [];
    var contains = [];
    for (var i = 0; i < COMUNI.length; i++) {
      var name = COMUNI[i][0], sigla = COMUNI[i][1];
      var nn = normalize(name);
      if (nn.indexOf(q) === 0) starts.push({ name: name, sigla: sigla, freq: freq[name] || 0 });
      else if (contains.length < 30 && nn.indexOf(q) > 0) contains.push({ name: name, sigla: sigla, freq: freq[name] || 0 });
      if (starts.length > 60) break;
    }
    starts.sort(function (a, b) { return (b.freq - a.freq) || a.name.localeCompare(b.name); });
    contains.sort(function (a, b) { return (b.freq - a.freq) || a.name.localeCompare(b.name); });
    return starts.concat(contains).slice(0, limit);
  }

  /* ---------------------------------------------------------------- */
  /* Sheet data model                                                   */
  /* ---------------------------------------------------------------- */
  function emptyGiorno(prefillDa, prefillProvDa) {
    return { da: prefillDa || "", provDa: prefillProvDa || "", a: "", provA: "", ddt: "", kmInizio: "", kmFine: "", bonus: "" };
  }

  function buildGiorni(month, year, da, provDa) {
    var n = daysInMonth(month, year);
    var g = {};
    for (var d = 1; d <= 31; d++) {
      if (d <= n) g[d] = emptyGiorno(da, provDa);
      else g[d] = null; // day does not exist this month
    }
    return g;
  }

  // Finds the last KM FINE value at/before `beforeDay` (exclusive) in `sheet`,
  // falling back to the previous month's sheet if nothing found.
  function findLastKmFine(sheet, beforeDay) {
    for (var d = beforeDay - 1; d >= 1; d--) {
      var g = sheet.giorni[d];
      if (g && g.kmFine !== "" && g.kmFine !== null && g.kmFine !== undefined) {
        return { value: g.kmFine, source: 'same' };
      }
    }
    // look at previous month
    var pm = sheet.month - 1, py = sheet.year;
    if (pm < 1) { pm = 12; py -= 1; }
    var prev = sheetForMonth(pm, py);
    if (prev) {
      for (var d2 = 31; d2 >= 1; d2--) {
        var g2 = prev.giorni[d2];
        if (g2 && g2.kmFine !== "" && g2.kmFine !== null && g2.kmFine !== undefined) {
          return { value: g2.kmFine, source: 'prev' };
        }
      }
    }
    return null;
  }

  function lastCompletedDay(sheet) {
    for (var d = 31; d >= 1; d--) {
      var g = sheet.giorni[d];
      if (g && (g.a || g.ddt || g.kmFine !== "")) return { day: d, giorno: g };
    }
    return null;
  }

  function lastKmFineOverall(sheet) {
    var lc = lastCompletedDay(sheet);
    if (lc && lc.giorno.kmFine !== "") return lc.giorno.kmFine;
    return null;
  }

  function createSheet(month, year, perContoDi, countsForDailyRate) {
    var client = (perContoDi || state.profile.perContoDi || 'BARCELLA').trim().toUpperCase();
    var existing = sheetForMonth(month, year, client);
    if (existing) return existing;
    var s = {
      id: uid(),
      month: month, year: year,
      nome: state.profile.nome, targa: state.profile.targa, perContoDi: client,
      // Whether a worked day on THIS client's sheet counts toward the
      // driver's daily rate (see monthEarnings). Most clients do — but
      // some drivers have a side client that only pays a small fixed
      // amount (entered as that day's bonus) instead of the full daily
      // rate, only earning the daily rate from their "own" main client.
      countsForDailyRate: countsForDailyRate !== false,
      createdAt: new Date().toISOString(),
      giorni: buildGiorni(month, year, state.profile.da, state.profile.provDa)
    };
    state.sheets.push(s);
    saveSheets(state.sheets);
    state.currentSheetId = s.id;
    setCurrentSheetId(s.id);
    return s;
  }

  function deleteSheet(id) {
    state.sheets = state.sheets.filter(function (s) { return s.id !== id; });
    saveSheets(state.sheets);
    var latest = latestSheet();
    state.currentSheetId = latest ? latest.id : null;
    setCurrentSheetId(state.currentSheetId);
  }

  /* ---------------------------------------------------------------- */
  /* Navigation                                                         */
  /* ---------------------------------------------------------------- */
  var currentScreen = 'home';
  var mainEl = document.querySelector('main');
  var scrollToLastDayPending = false;

  // Pinch-zoom stays locked at the page level everywhere — the PDF preview
  // instead uses the browser's own native PDF viewer for zoom/pan, scoped
  // naturally to just the document inside its frame.

  function showScreen(name) {
    currentScreen = name;
    ['home', 'foglio', 'archivio', 'pdf'].forEach(function (n) {
      document.getElementById('screen-' + n).classList.toggle('active', n === name);
    });
    document.querySelectorAll('.navbtn[data-nav]').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-nav') === name);
    });
    if (name === 'foglio') {
      scrollToLastDayPending = true;
      render();
    } else {
      render();
      if (mainEl) mainEl.scrollTop = 0;
    }
  }

  document.querySelectorAll('.navbtn[data-nav]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var nav = btn.getAttribute('data-nav');
      if (nav === 'foglio' && !currentSheet()) { openNewSheetFlow(); return; }
      showScreen(nav);
    });
  });

  /* ---------------------------------------------------------------- */
  /* Rendering                                                          */
  /* ---------------------------------------------------------------- */
  function render() {
    if (currentScreen === 'home') renderHome();
    else if (currentScreen === 'foglio') renderFoglio();
    else if (currentScreen === 'archivio') renderArchivio();
    else if (currentScreen === 'pdf') renderPdfScreen();
  }

  function svgIcon(name) {
    var icons = {
      truck: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="6" width="14" height="11"/><path d="M15 10h4l3 3v4h-7z"/><circle cx="6" cy="19" r="1.6"/><circle cx="17.5" cy="19" r="1.6"/></svg>',
      route: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="5" cy="6" r="2"/><circle cx="19" cy="18" r="2"/><path d="M5 8v4a4 4 0 0 0 4 4h6" stroke-dasharray="3 3"/></svg>',
      fuel: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="9" height="18" rx="1"/><rect x="6.3" y="5.5" width="4.4" height="4" rx="0.5"/><path d="M13 9h2.5l3 2.5v6.5a1.5 1.5 0 0 1-3 0v-3.5a1 1 0 0 0-1-1h-1.5"/></svg>'
    };
    return icons[name] || '';
  }

  function renderHome() {
    var el = document.getElementById('screen-home');
    var sheet = currentSheet();
    if (!sheet) {
      el.innerHTML =
        '<div class="empty-state">' +
        '<div class="icon">' + svgIcon('truck') + '</div>' +
        '<h3>Nessun foglio ancora</h3>' +
        '<p>Crea il tuo primo foglio viaggi mensile per iniziare a registrare i chilometri.</p>' +
        '<button class="btn btn-accent" id="home-create">Crea il primo foglio</button>' +
        '</div>';
      document.getElementById('home-create').addEventListener('click', openNewSheetFlow);
      return;
    }
    var lc = lastCompletedDay(sheet);
    var lastKm = lastKmFineOverall(sheet);
    var activeMonth = isInActiveMonth(sheet);
    var monthSheets = sheetsForMonth(sheet.month, sheet.year);
    var multiClient = monthSheets.length > 1;
    var summary = monthSummary(sheet.month, sheet.year);
    var today = todayStats(sheet.month, sheet.year);
    var earnings = monthEarnings(sheet.month, sheet.year);

    var html = '';

    // 1) Which month, which sheet is active, quick actions. "Active"
    // describes the MONTH (the driver works one month at a time), not a
    // specific client — a past month's client sheet can still be opened
    // and edited, but it isn't "active" again just because you touched it.
    html += '<div class="card active-card"><div class="route-dashes"></div>';
    html += '<button class="fuel-corner-btn" id="home-fuel" aria-label="Scontrini carburante">' + svgIcon('fuel') + '</button>';
    html += '<span class="badge ' + (activeMonth ? '' : 'muted') + '">' + (activeMonth ? 'Mese attivo' : 'Mese archiviato') + '</span>';
    html += '<h2>' + MESI[sheet.month - 1] + ' ' + sheet.year;
    if (multiClient) html += ' <span class="multi-badge">' + monthSheets.length + ' clienti</span>';
    html += '</h2>';
    html += '<div style="color:rgba(255,255,255,.6);font-size:13px;margin-top:-6px;margin-bottom:2px;">Per conto di ' + escapeHtml(sheet.perContoDi || '—') + '</div>';
    html += '<div class="meta">';
    html += '<div><b>' + escapeHtml(sheet.nome || '—') + '</b>Autista</div>';
    html += '<div><b>' + escapeHtml(sheet.targa || '—') + '</b>Targa</div>';
    html += '<div><b>' + (lc ? 'Giorno ' + lc.day : '—') + '</b>Ultimo viaggio</div>';
    html += '</div>';
    html += '<div class="odometer"><span class="lbl">Ultimo KM fine registrato</span><span class="val">' + (lastKm !== null ? Number(lastKm).toLocaleString('it-IT') : '—') + '</span></div>';
    html += '<div class="card-actions">';
    html += '<button class="btn btn-light" style="flex:1" id="home-continua">Apri foglio</button>';
    html += '<button class="btn btn-accent" style="flex:1" id="home-pdf">Anteprima PDF</button>';
    html += '</div></div>';

    if (!activeMonth) {
      html += '<button class="link-btn" id="home-jump-latest" style="display:block;margin:14px auto 0;">Vai al mese attivo →</button>';
    }

    // 2) Viaggi totali / KM totali — the whole month, all clients combined.
    html += '<div class="section-title"><h3>Totale mese</h3></div>';
    html += '<div class="card" style="display:flex;gap:0;">';
    html += '<div style="flex:1;text-align:center;"><div style="font-size:22px;font-weight:800;">' + summary.totalViaggi + '</div><div class="eyebrow" style="margin-top:2px;">Viaggi totali</div></div>';
    html += '<div style="width:1px;background:var(--line);"></div>';
    html += '<div style="flex:1;text-align:center;"><div style="font-size:22px;font-weight:800;">' + summary.totalKm.toLocaleString('it-IT') + '</div><div class="eyebrow" style="margin-top:2px;">KM totali</div></div>';
    html += '</div>';

    // 3) Viaggi/KM di oggi — updates every day, driver-only info. Only
    // shown when looking at the real current month (otherwise "oggi"
    // wouldn't mean anything for an archived past month).
    if (today) {
      html += '<div class="section-title"><h3>Oggi</h3></div>';
      html += '<div class="card" style="display:flex;gap:0;">';
      html += '<div style="flex:1;text-align:center;"><div style="font-size:22px;font-weight:800;">' + today.viaggi + '</div><div class="eyebrow" style="margin-top:2px;">Viaggi oggi</div></div>';
      html += '<div style="width:1px;background:var(--line);"></div>';
      html += '<div style="flex:1;text-align:center;"><div style="font-size:22px;font-weight:800;">' + today.km.toLocaleString('it-IT') + '</div><div class="eyebrow" style="margin-top:2px;">KM oggi</div></div>';
      html += '</div>';
    }

    // 4) Guadagno — driver-only, never printed in the PDF. Grows as each
    // worked day is filled in; bonuses (entered per day) add on top.
    html += '<div class="section-title"><h3>Guadagno <span class="eyebrow" style="font-weight:600;text-transform:none;letter-spacing:0;">— solo per te, non nel PDF</span></h3></div>';
    if (!earnings.hasRate) {
      html += '<div class="card" style="text-align:center;padding:20px;">';
      html += '<div style="font-size:13px;color:var(--ink-soft);margin-bottom:12px;">Imposta il tuo compenso giornaliero per vedere qui il guadagno del mese.</div>';
      html += '<button class="btn btn-outline btn-sm" id="home-set-rate">Imposta compenso</button>';
      html += '</div>';
    } else {
      html += '<div class="card earnings-card">';
      html += '<div class="earnings-row"><span>Giorni lavorati</span><b>' + earnings.workedDaysCount + ' × €' + earnings.dailyRate.toLocaleString('it-IT') + '</b></div>';
      if (earnings.totalBonus > 0) {
        html += '<div class="earnings-row"><span>Bonus</span><b>+€' + earnings.totalBonus.toLocaleString('it-IT') + '</b></div>';
      }
      html += '<div class="earnings-row earnings-total"><span>Totale</span><b>€' + earnings.totalEarnings.toLocaleString('it-IT') + '</b></div>';
      html += '</div>';
    }

    // 5) Riepilogo mese — which clients this month, one line each, always
    // shown (even for a single client) so it's clear who was worked for.
    html += '<div class="section-title"><h3>Riepilogo mese</h3></div>';
    html += '<div class="card" style="padding:8px 20px;">';
    summary.byClient.forEach(function (c, idx) {
      html += '<div class="client-breakdown-row" data-sheet="' + c.sheetId + '"' + (idx > 0 ? ' style="border-top:1px solid var(--line);"' : '') + '>';
      html += '<div class="client-breakdown-name">' + escapeHtml(c.client) + '<span class="client-breakdown-sub">' + c.viaggi + ' viaggi</span></div>';
      html += '<div class="client-breakdown-km">' + c.km.toLocaleString('it-IT') + '<span class="client-breakdown-sub">km</span></div>';
      html += '</div>';
    });
    html += '</div>';

    el.innerHTML = html;
    document.getElementById('home-continua').addEventListener('click', function () { showScreen('foglio'); });
    document.getElementById('home-pdf').addEventListener('click', function () { showScreen('pdf'); });
    document.getElementById('home-fuel').addEventListener('click', openFuelScreen);
    var jumpBtn = document.getElementById('home-jump-latest');
    if (jumpBtn) jumpBtn.addEventListener('click', function () {
      var latest = latestSheet();
      state.currentSheetId = latest.id; setCurrentSheetId(latest.id); renderHome();
    });
    el.querySelectorAll('.client-breakdown-row[data-sheet]').forEach(function (row) {
      row.addEventListener('click', function () {
        var id = row.getAttribute('data-sheet');
        state.currentSheetId = id; setCurrentSheetId(id);
        showScreen('foglio');
      });
    });
    var setRateBtn = document.getElementById('home-set-rate');
    if (setRateBtn) setRateBtn.addEventListener('click', function () { openSettingsModal(null); });
  }

  function escapeHtml(s) {
    return (s || "").toString().replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }


  function renderFoglio() {
    var el = document.getElementById('screen-foglio');
    var sheet = currentSheet();
    if (!sheet) {
      el.innerHTML = '<div class="empty-state"><div class="icon">' + svgIcon('route') + '</div><h3>Nessun foglio aperto</h3><p>Crea un nuovo foglio mensile per iniziare.</p><button class="btn btn-accent" id="foglio-create">Nuovo foglio</button></div>';
      document.getElementById('foglio-create').addEventListener('click', openNewSheetFlow);
      return;
    }
    var n = daysInMonth(sheet.month, sheet.year);
    var html = '';
    html += '<div class="card"><div class="sheet-header">';
    html += '<div><h2 style="font-size:18px;">' + MESI[sheet.month - 1] + ' ' + sheet.year + '</h2>';
    html += '<div class="who">' + escapeHtml(sheet.nome || 'Nome autista') + ' <b>·</b> <b>' + escapeHtml(sheet.targa || 'Targa') + '</b> <b>·</b> per ' + escapeHtml(sheet.perContoDi || '—') + '</div></div>';
    html += '<div class="pencil" id="foglio-edit"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></div>';
    html += '</div></div>';

    html += '<div class="giro-list">';
    for (var d = 1; d <= 31; d++) {
      var g = sheet.giorni[d];
      var exists = d <= n;
      var date = exists ? new Date(sheet.year, sheet.month - 1, d) : null;
      var dow = exists ? GIORNI_SETT[date.getDay()].slice(0, 3) : '';
      if (!exists) {
        html += '<div class="day-row disabled"><div class="day-num">' + d + '</div><div class="day-main"><span class="placeholder">Giorno inesistente</span></div></div>';
        continue;
      }
      var filled = g && (g.a || g.ddt || g.kmFine !== "");
      var kmtot = (g && g.kmInizio !== "" && g.kmFine !== "" && !isNaN(g.kmFine - g.kmInizio)) ? (Number(g.kmFine) - Number(g.kmInizio)) : null;
      html += '<div class="day-row ' + (filled ? 'filled' : '') + '" data-day="' + d + '">';
      html += '<div class="day-num">' + d + '</div>';
      html += '<div class="day-main">';
      if (filled) {
        html += '<div class="dest">' + (g.a ? escapeHtml(g.a) : 'Destinazione da inserire') + (g.provA ? ' <span style="color:var(--ink-faint);font-weight:600;">(' + g.provA + ')</span>' : '') + '</div>';
        html += '<div class="sub">' + dow + ' · ' + (g.ddt ? 'DDT ' + escapeHtml(g.ddt) : 'DDT —') + '</div>';
      } else {
        html += '<div class="dest placeholder">' + dow + ' ' + d + ' — nessun viaggio</div>';
      }
      html += '</div>';
      if (kmtot !== null) {
        html += '<div class="day-km"><div class="tot">' + kmtot.toLocaleString('it-IT') + '</div><div class="lbl">km</div></div>';
      }
      html += '<svg class="chev" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';
      html += '</div>';
    }
    html += '</div>';

    if (isNewestSheet(sheet) && state.sheets.length > 1) {
      html += '<button class="undo-link" id="foglio-undo">Annulla questo nuovo foglio</button>';
    } else if (isNewestSheet(sheet) && state.sheets.length === 1) {
      html += '<button class="undo-link" id="foglio-undo-single">Elimina questo foglio</button>';
    }

    el.innerHTML = html;
    el.querySelectorAll('.day-row[data-day]').forEach(function (row) {
      row.addEventListener('click', function () { openDayEditor(sheet, parseInt(row.getAttribute('data-day'), 10)); });
    });
    document.getElementById('foglio-edit').addEventListener('click', function () { openSettingsModal(sheet); });
    var undoBtn = document.getElementById('foglio-undo');
    if (undoBtn) undoBtn.addEventListener('click', function () { confirmUndoSheet(sheet); });
    var undoSingle = document.getElementById('foglio-undo-single');
    if (undoSingle) undoSingle.addEventListener('click', function () { confirmUndoSheet(sheet); });

    if (scrollToLastDayPending) {
      scrollToLastDayPending = false;
      var lc = lastCompletedDay(sheet);
      var targetDay = lc ? lc.day : null;
      if (targetDay) {
        var targetRow = el.querySelector('.day-row[data-day="' + targetDay + '"]');
        if (targetRow) {
          // Defer to next frame so the browser has laid out the new content first.
          requestAnimationFrame(function () {
            targetRow.scrollIntoView({ behavior: 'auto', block: 'center' });
          });
        }
      } else {
        if (mainEl) mainEl.scrollTop = 0;
      }
    }
  }

  function renderArchivio() {
    var el = document.getElementById('screen-archivio');
    var sorted = state.sheets.slice().sort(function (a, b) {
      var k = sortKey(b) - sortKey(a);
      if (k !== 0) return k;
      return (b.createdAt || '').localeCompare(a.createdAt || '');
    });
    if (!sorted.length) {
      el.innerHTML = '<div class="empty-state"><div class="icon">' + svgIcon('route') + '</div><h3>Archivio vuoto</h3><p>I fogli mensili completati appariranno qui.</p></div>';
      return;
    }
    // Group sheets by month, so it's clear at a glance which client-sheets
    // belong together (same month), instead of a flat list where that
    // wasn't obvious. "Active" describes the whole MONTH group, not any
    // one client inside it — once a month ends, work moves to the next
    // one, so a client can't stay "active" just because its sheet was
    // edited most recently.
    var monthsSeen = {};
    var groups = [];
    sorted.forEach(function (s) {
      var key = s.year + '-' + s.month;
      var group = monthsSeen[key];
      if (!group) {
        group = { month: s.month, year: s.year, sheets: [] };
        monthsSeen[key] = group;
        groups.push(group);
      }
      group.sheets.push(s);
    });
    var activeKey = activeMonthKey();

    var html = '';
    groups.forEach(function (grp) {
      var groupActive = activeKey === (grp.year + '-' + grp.month);
      html += '<div class="card archive-group">';
      html += '<div class="archive-group-title">' + MESI[grp.month - 1] + ' ' + grp.year;
      if (groupActive) html += '<span class="active-tag">MESE ATTIVO</span>';
      if (grp.sheets.length > 1) html += '<span class="archive-group-count">' + grp.sheets.length + ' fogli</span>';
      html += '</div>';
      grp.sheets.forEach(function (s, idx) {
        var filled = Object.keys(s.giorni).filter(function (d) { return s.giorni[d] && (s.giorni[d].a || s.giorni[d].kmFine !== ""); }).length;
        html += '<div class="archive-row" data-open="' + s.id + '"' + (idx > 0 ? ' style="border-top:1px solid var(--line);"' : '') + '>';
        html += '<div class="archive-row-left">';
        html += '<span class="client-chip">' + escapeHtml(s.perContoDi || '—') + '</span>';
        html += '<div class="archive-row-sub">' + escapeHtml(s.nome || '—') + ' · ' + escapeHtml(s.targa || '—') + ' · ' + filled + ' viaggi</div>';
        html += '</div>';
        html += '<div class="archive-row-actions">';
        html += '<button class="btn btn-ghost btn-sm" data-open-btn="' + s.id + '">Apri</button>';
        html += '<button class="btn btn-ghost btn-sm" data-pdf="' + s.id + '">PDF</button>';
        html += '</div></div>';
      });
      html += '</div>';
    });
    el.innerHTML = html;
    // Tapping anywhere on the row (the client info, not the buttons) does
    // the same thing as pressing "Apri" — a quicker way in. Both buttons
    // stay exactly as they were, equally prominent, for anyone who taps
    // those directly; each one stops the click from also triggering the
    // row's own tap, so nothing double-fires.
    el.querySelectorAll('.archive-row[data-open]').forEach(function (row) {
      row.addEventListener('click', function () {
        var id = row.getAttribute('data-open');
        state.currentSheetId = id; setCurrentSheetId(id);
        showScreen('foglio');
      });
    });
    el.querySelectorAll('[data-open-btn]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        var id = b.getAttribute('data-open-btn');
        state.currentSheetId = id; setCurrentSheetId(id);
        showScreen('foglio');
      });
    });
    el.querySelectorAll('[data-pdf]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation(); // don't also trigger the row's "open" tap
        var id = b.getAttribute('data-pdf');
        state.currentSheetId = id; setCurrentSheetId(id);
        showScreen('pdf');
      });
    });
  }

  /* ---------------------------------------------------------------- */
  /* Lazy-loading jsPDF (only needed to actually build the file) — the    */
  /* preview no longer needs its own renderer: it opens the generated    */
  /* PDF directly in the phone's own full-screen PDF viewer, which       */
  /* already has excellent, reliable pinch-zoom and panning built in.    */
  /* ---------------------------------------------------------------- */
  var pdfLibsPromise = null;
  function loadPdfLibs() {
    if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve();
    if (pdfLibsPromise) return pdfLibsPromise;
    function loadScript(src) {
      return new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = reject;
        document.body.appendChild(s);
      });
    }
    pdfLibsPromise = loadScript('vendor/jspdf.umd.min.js')
      .then(function () { return loadScript('vendor/jspdf.plugin.autotable.min.js'); });
    return pdfLibsPromise;
  }

  function renderPdfScreen() {
    var el = document.getElementById('screen-pdf');
    var sheet = currentSheet();
    if (!sheet) {
      el.innerHTML = '<div class="empty-state"><div class="icon">' + svgIcon('route') + '</div><h3>Nessun foglio da esportare</h3><p>Crea un foglio mensile per generare il PDF.</p></div>';
      return;
    }
    // Group by month+year — a single PDF export always covers the whole
    // month, with one page per client if there is more than one.
    var monthsSeen = {};
    var months = [];
    state.sheets.slice().sort(function (a, b) { return sortKey(b) - sortKey(a); }).forEach(function (s) {
      var key = s.year + '-' + s.month;
      if (monthsSeen[key]) return;
      monthsSeen[key] = true;
      months.push({ month: s.month, year: s.year, key: key });
    });
    var currentKey = sheet.year + '-' + sheet.month;

    var html = '';
    html += '<div class="card">';
    html += '<label class="eyebrow" style="display:block;margin-bottom:8px;">Mese da esportare</label>';
    html += '<select class="field-select" id="pdf-month-select">';
    months.forEach(function (mo) {
      var count = sheetsForMonth(mo.month, mo.year).length;
      var label = MESI[mo.month - 1] + ' ' + mo.year + (count > 1 ? ' (' + count + ' clienti)' : '');
      html += '<option value="' + mo.key + '" ' + (mo.key === currentKey ? 'selected' : '') + '>' + label + '</option>';
    });
    html += '</select>';
    html += '<div class="settings-driver-note" id="pdf-month-note" style="margin-top:10px;"></div>';
    html += '</div>';

    html += '<div class="card" style="margin-top:14px;text-align:center;padding:32px 20px;">';
    html += '<div style="width:56px;height:56px;border-radius:16px;background:var(--surface-2);display:flex;align-items:center;justify-content:center;margin:0 auto 16px;">' + svgIcon('route') + '</div>';
    html += '<div style="font-weight:800;font-size:15px;margin-bottom:6px;">Anteprima documento</div>';
    html += '<div style="font-size:13px;color:var(--ink-soft);margin-bottom:20px;line-height:1.5;">Si apre nel visualizzatore del telefono — puoi ingrandire e spostarti liberamente con le dita, come su qualsiasi altro PDF. Usa "indietro" per tornare all\'app.</div>';
    html += '<button class="btn btn-accent btn-block" id="pdf-open-preview">Apri anteprima a schermo intero</button>';
    html += '</div>';

    html += '<div class="card-actions" style="margin-top:14px;">';
    html += '<button class="btn btn-outline" style="flex:1" id="pdf-download-outline">Genera PDF</button>';
    html += '</div>';
    el.innerHTML = html;

    function updateMonthNote() {
      var key = document.getElementById('pdf-month-select').value;
      var parts = key.split('-');
      var y = parseInt(parts[0], 10), m = parseInt(parts[1], 10);
      var count = sheetsForMonth(m, y).length;
      var monthFuel = state.fuel[fuelMonthKey(m, y)] || {};
      var receiptCount = Object.keys(monthFuel).filter(function (d) { return monthFuel[d] && monthFuel[d].data; }).length;
      var note = count > 1
        ? 'Questo mese ha ' + count + ' clienti — il PDF conterrà ' + count + ' pagine, una per ciascuno.'
        : 'Questo mese ha un solo cliente — il PDF conterrà una pagina.';
      if (receiptCount > 0) {
        note += ' Più ' + receiptCount + (receiptCount === 1 ? ' scontrino carburante allegato' : ' scontrini carburante allegati') + '.';
      }
      document.getElementById('pdf-month-note').textContent = note;
    }
    updateMonthNote();

    // Start loading what's needed right away, in the background, so that
    // by the time the person actually taps the button, everything is
    // already to hand and the tab can open in the very same instant as
    // the tap — phones only allow opening a new tab as a direct,
    // uninterrupted response to a touch, not after any waiting.
    loadPdfLibs().catch(function () { /* will retry on click if needed */ });

    document.getElementById('pdf-month-select').addEventListener('change', function (e) {
      var parts = e.target.value.split('-');
      var y = parseInt(parts[0], 10), m = parseInt(parts[1], 10);
      var s = sheetsForMonth(m, y)[0];
      if (s) { state.currentSheetId = s.id; setCurrentSheetId(s.id); }
      updateMonthNote();
    });
    document.getElementById('pdf-open-preview').addEventListener('click', openPdfFullScreen);
    document.getElementById('pdf-download-outline').addEventListener('click', downloadCurrentPdf);
  }

  function selectedPdfMonth() {
    var key = document.getElementById('pdf-month-select').value;
    var parts = key.split('-');
    return { year: parseInt(parts[0], 10), month: parseInt(parts[1], 10) };
  }

  // Opens the generated PDF directly in the phone's own full-screen PDF
  // viewer (a real, dedicated browser tab, not squeezed into a small
  // frame inside our app) — the same mature, reliable pinch-zoom-and-pan
  // experience every phone already provides for any PDF.
  //
  // Important: the new tab has to open in the exact same instant as the
  // tap (no "await" in between) or phones block it as an unwanted popup.
  // Because loadPdfLibs() was already kicked off when this screen opened,
  // it's almost always ready by now, so the whole thing runs synchronously.
  function openPdfFullScreen() {
    var libsReady = window.jspdf && window.jspdf.jsPDF;
    if (!libsReady) {
      toast('Preparazione in corso — riprova tra un istante');
      loadPdfLibs().catch(function () { toast('Impossibile preparare il PDF — verifica la connessione'); });
      return;
    }
    try {
      var mo = selectedPdfMonth();
      var doc = buildPdfForMonth(mo.month, mo.year);
      if (!doc) { toast('Nessun foglio per questo mese'); return; }
      var blobUrl = doc.output('bloburl');
      // Navigate this same tab straight to the PDF — the phone's own
      // viewer takes over from here. No new tab/window involved, so
      // there's nothing for the browser to block; the person uses the
      // back button/gesture to return to the app afterwards, and all
      // their data is still exactly as they left it (nothing is lost —
      // it's all saved locally as they type, not just on this screen).
      window.location.href = blobUrl;
    } catch (err) {
      console.error(err);
      toast('Impossibile aprire l\'anteprima');
    }
  }

  function downloadCurrentPdf() {
    Promise.all([loadPdfLibs(), ensureLogoReady()]).then(function () {
      var mo = selectedPdfMonth();
      var doc = buildPdfForMonth(mo.month, mo.year);
      if (!doc) { toast('Nessun foglio per questo mese'); return; }
      var filename = 'Foglio_Viaggi_' + MESI[mo.month - 1] + '_' + mo.year + '.pdf';
      var blob = doc.output('blob');
      if (navigator.canShare && navigator.canShare({ files: [new File([blob], filename, { type: 'application/pdf' })] })) {
        navigator.share({ files: [new File([blob], filename, { type: 'application/pdf' })], title: filename }).catch(function () { doc.save(filename); });
      } else {
        doc.save(filename);
      }
      toast('PDF generato');
    }).catch(function (err) {
      console.error(err);
      toast('Impossibile generare il PDF — verifica la connessione');
    });
  }

  /* ---------------------------------------------------------------- */
  /* PDF generation — replicates the original Power Trasporti template */
  /* ---------------------------------------------------------------- */
  function ensureLogoReady() {
    return new Promise(function (resolve) {
      var img = document.getElementById('pt-logo-img');
      if (!img || (img.complete && img.naturalWidth > 0)) { resolve(); return; }
      img.onload = function () { resolve(); };
      img.onerror = function () { resolve(); };
      setTimeout(resolve, 1500); // safety net so a slow/broken image never blocks PDF generation
    });
  }

  // Draws one complete GIRO sheet onto an already-open jsPDF document, at
  // whatever the current page is — used both for a single-sheet PDF and,
  // when a month has multiple clients, for each additional page of a
  // combined multi-page PDF (see buildPdfForMonth below).
  function buildPdfPage(doc, sheet) {
    var pageW = 297, pageH = 210;
    var margin = 8;
    var contentW = pageW - margin * 2;

    // Outer border
    doc.setDrawColor(20, 20, 20);
    doc.setLineWidth(0.4);
    doc.rect(margin, margin, contentW, pageH - margin * 2);

    // Header block: logo (left) | company info (right)
    var headerH = 15;
    var logoW = contentW * 0.34;
    doc.line(margin + logoW, margin, margin + logoW, margin + headerH);
    doc.line(margin, margin + headerH, margin + contentW, margin + headerH);

    try {
      var img = document.getElementById('pt-logo-img');
      if (img && img.complete && img.naturalWidth > 0) {
        var ratio = img.naturalWidth / img.naturalHeight;
        var imgH = headerH * 0.6;
        var imgW = imgH * ratio;
        if (imgW > logoW - 8) { imgW = logoW - 8; imgH = imgW / ratio; }
        doc.addImage(img, 'PNG', margin + (logoW - imgW) / 2, margin + (headerH - imgH) / 2, imgW, imgH);
      }
    } catch (e) { /* logo unavailable */ }

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(20, 20, 20);
    doc.text(COMPANY.indirizzo, margin + logoW + contentW * (1 - 0.34) / 2, margin + 6.5, { align: 'center' });
    doc.setFontSize(9);
    doc.text('CF: ' + COMPANY.cf + '   P.IVA: ' + COMPANY.piva, margin + logoW + contentW * (1 - 0.34) / 2, margin + 11.5, { align: 'center' });

    // Fields row
    var fieldsH = 12.5;
    var fy = margin + headerH;
    var col1 = contentW * 0.30, col2 = contentW * 0.24, col3 = contentW * 0.24, col4 = contentW * 0.22;
    doc.line(margin + col1, fy, margin + col1, fy + fieldsH);
    doc.line(margin + col1 + col2, fy, margin + col1 + col2, fy + fieldsH);
    doc.line(margin + col1 + col2 + col3, fy, margin + col1 + col2 + col3, fy + fieldsH);
    doc.line(margin, fy + fieldsH, margin + contentW, fy + fieldsH);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.8);
    doc.text('Viaggi effettuati nel mese di:', margin + 2.5, fy + 4.8);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.text(MESI[sheet.month - 1] + '   ' + sheet.year, margin + 2.5, fy + 9.8);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.8);
    doc.text('Nome autista:', margin + col1 + 2.5, fy + 4.8);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.2);
    doc.text(sheet.nome || '—', margin + col1 + 2.5, fy + 10.2);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.8);
    doc.text('Targa Veicolo:', margin + col1 + col2 + 2.5, fy + 4.8);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.2);
    doc.text(sheet.targa || '—', margin + col1 + col2 + 2.5, fy + 10.2);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.text('Per conto di: ' + (sheet.perContoDi || '—'), margin + col1 + col2 + col3 + 2.5, fy + 7.5);

    // GIRO title bar
    var giroH = 6;
    var gy = fy + fieldsH;
    doc.setFillColor(230, 230, 228);
    doc.rect(margin, gy, contentW, giroH, 'F');
    doc.rect(margin, gy, contentW, giroH);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(20, 20, 20);
    doc.text('GIRO', margin + contentW / 2, gy + 4.2, { align: 'center' });

    // Table
    var tableY = gy + giroH;
    var colWidths = {
      data: contentW * 0.035,
      da: contentW * 0.145,
      provDa: contentW * 0.045,
      a: contentW * 0.165,
      provA: contentW * 0.045,
      ddt: contentW * 0.125,
      kmI: contentW * 0.125,
      kmF: contentW * 0.125,
      kmT: contentW * 0.14
    };

    var head = [
      [
        { content: 'Data', rowSpan: 2, styles: { valign: 'middle', halign: 'center' } },
        { content: 'Località di destinazione:', colSpan: 4, styles: { halign: 'center' } },
        { content: 'DDT', rowSpan: 2, styles: { valign: 'middle', halign: 'center' } },
        { content: 'KM INIZIO', rowSpan: 2, styles: { valign: 'middle', halign: 'center' } },
        { content: 'KM FINE', rowSpan: 2, styles: { valign: 'middle', halign: 'center' } },
        { content: 'KM TOT.', rowSpan: 2, styles: { valign: 'middle', halign: 'center' } }
      ],
      [
        { content: 'Da:', styles: { halign: 'center' } },
        { content: 'Prov.', styles: { halign: 'center' } },
        { content: 'A:', styles: { halign: 'center' } },
        { content: 'Prov.', styles: { halign: 'center' } }
      ]
    ];

    var body = [];
    var n = daysInMonth(sheet.month, sheet.year);
    for (var d = 1; d <= 31; d++) {
      var g = d <= n ? sheet.giorni[d] : null;
      if (!g) { body.push([d <= n ? d : '', '', '', '', '', '', '', '', '']); continue; }
      var kmTot = (g.kmInizio !== "" && g.kmFine !== "" && !isNaN(g.kmFine - g.kmInizio)) ? (Number(g.kmFine) - Number(g.kmInizio)) : '';
      body.push([
        d,
        g.da || '',
        g.provDa || '',
        g.a || '',
        g.provA || '',
        g.ddt || '',
        g.kmInizio !== "" ? g.kmInizio : '',
        g.kmFine !== "" ? g.kmFine : '',
        kmTot !== '' ? kmTot : ''
      ]);
    }

    doc.autoTable({
      startY: tableY,
      margin: { left: margin, right: margin },
      tableWidth: contentW,
      theme: 'grid',
      head: head,
      body: body,
      styles: { font: 'helvetica', fontSize: 7.4, cellPadding: { top: 0.7, bottom: 0.7, left: 1.1, right: 1.1 }, lineColor: [20, 20, 20], lineWidth: 0.25, textColor: [20, 20, 20], valign: 'middle' },
      headStyles: { fillColor: [255, 255, 255], textColor: [20, 20, 20], fontStyle: 'bold', fontSize: 7.2, cellPadding: { top: 1, bottom: 1, left: 1.1, right: 1.1 }, lineColor: [20, 20, 20], lineWidth: 0.25 },
      bodyStyles: { minCellHeight: 4.1 },
      columnStyles: {
        0: { cellWidth: colWidths.data, halign: 'center', fontStyle: 'bold' },
        1: { cellWidth: colWidths.da, halign: 'center' },
        2: { cellWidth: colWidths.provDa, halign: 'center' },
        3: { cellWidth: colWidths.a, halign: 'center' },
        4: { cellWidth: colWidths.provA, halign: 'center' },
        5: { cellWidth: colWidths.ddt, halign: 'center' },
        6: { cellWidth: colWidths.kmI, halign: 'center' },
        7: { cellWidth: colWidths.kmF, halign: 'center' },
        8: { cellWidth: colWidths.kmT, halign: 'center', fontStyle: 'bold' }
      }
    });
  }

  function buildPdf(sheet) {
    var jsPDFCtor = window.jspdf.jsPDF;
    var doc = new jsPDFCtor({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    buildPdfPage(doc, sheet);
    return doc;
  }

  // If a month has more than one client, the downloaded PDF should contain
  // one full page per client — the same way you'd hand over several
  // completed paper sheets stapled together, one per client, for that
  // month — instead of forcing a choice of just one.
  function buildPdfForMonth(month, year) {
    var sheets = sheetsForMonth(month, year).slice().sort(function (a, b) {
      return (a.perContoDi || '').localeCompare(b.perContoDi || '');
    });
    if (!sheets.length) return null;
    var jsPDFCtor = window.jspdf.jsPDF;
    var doc = new jsPDFCtor({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    sheets.forEach(function (s, i) {
      if (i > 0) doc.addPage();
      buildPdfPage(doc, s);
    });
    addReceiptPages(doc, month, year);
    return doc;
  }

  // Packs every fuel receipt into a compact grid, after the GIRO table
  // page(s) — instead of one mostly-empty page per receipt. How many
  // receipts a month has varies a lot (some drivers refuel daily, others
  // every two or three days), so the grid adapts on its own: however many
  // receipts there are, they're laid out edge to edge with no wasted
  // space, and the total count is printed at the top of the section.
  // Receipts are logged per calendar day for the month as a whole — never
  // tied to a specific client — so this section appears exactly once per
  // month's PDF, regardless of how many client sheets that month has.
  function addReceiptPages(doc, month, year) {
    var monthFuel = state.fuel[fuelMonthKey(month, year)] || {};
    var receipts = Object.keys(monthFuel).sort(function (a, b) { return Number(a) - Number(b); })
      .filter(function (d) { return monthFuel[d] && monthFuel[d].data; })
      .map(function (d) { return { day: d, scontrino: monthFuel[d] }; });
    if (!receipts.length) return;

    var pageW = 297, pageH = 210, margin = 10;
    var headerH = 10; // space reserved for the page title on each receipts page
    var cols = 4, rows = 2;
    var perPage = cols * rows;
    var gridW = pageW - margin * 2, gridH = pageH - margin * 2 - headerH;
    var cellW = gridW / cols, cellH = gridH / rows;
    var captionH = 5; // space for the "Giorno N" label inside each cell
    var totalCount = receipts.length;

    for (var i = 0; i < receipts.length; i += perPage) {
      doc.addPage();
      var pageReceipts = receipts.slice(i, i + perPage);

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(12);
      doc.setTextColor(20, 20, 20);
      var totalWord = totalCount === 1 ? 'totale' : 'totali';
      var pageLabel = totalCount > perPage
        ? 'Scontrini carburante — ' + totalCount + ' ' + totalWord + ' (pagina ' + (Math.floor(i / perPage) + 1) + ' di ' + Math.ceil(totalCount / perPage) + ')'
        : 'Scontrini carburante — ' + totalCount + ' ' + totalWord;
      doc.text(pageLabel, pageW / 2, margin + 3, { align: 'center' });

      pageReceipts.forEach(function (r, idx) {
        var col = idx % cols, row = Math.floor(idx / cols);
        var cellX = margin + col * cellW, cellY = margin + headerH + row * cellH;

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8);
        doc.setTextColor(90, 90, 90);
        doc.text('Giorno ' + r.day, cellX + cellW / 2, cellY + 3.5, { align: 'center' });

        try {
          var padX = 4, padY = 1;
          var maxW = cellW - padX * 2, maxH = cellH - captionH - padY * 2;
          var ratio = (r.scontrino.w && r.scontrino.h) ? r.scontrino.w / r.scontrino.h : 0.6;
          var w = maxW, h = w / ratio;
          if (h > maxH) { h = maxH; w = h * ratio; }
          var imgX = cellX + (cellW - w) / 2;
          var imgY = cellY + captionH + (maxH - h) / 2;
          doc.addImage(r.scontrino.data, 'JPEG', imgX, imgY, w, h);
        } catch (e) { /* skip a broken image rather than fail the whole PDF */ }
      });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Day editor                                                         */
  /* ---------------------------------------------------------------- */
  var dayModal = document.getElementById('modal-day');
  // Fuel receipt photos — logged from a dedicated screen (reachable
  // straight from Home), day by day, independent of a client sheet's
  // full trip-detail editor. The person crops the raw photo down to just
  // the receipt (excluding the table/background around it) using the
  // crop screen below, and only THEN is it converted to a small black-
  // and-white "document scan" and stored as base64 in localStorage.
  // Works fully offline, like the rest of the app.
  var cropRawImage = null; // the freshly-picked, not-yet-cropped photo
  var cropRect = null; // current crop rectangle, in on-screen pixels: {left,top,right,bottom}
  var cropDragMode = null; // null | 'move' | 'tl' | 'tr' | 'bl' | 'br'
  var cropDragStart = null;
  var fuelTargetDay = null; // which day the photo currently being added/replaced belongs to

  function loadPickedImage(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = reject;
      reader.onload = function () {
        var img = new Image();
        img.onerror = reject;
        img.onload = function () { resolve(img); };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // Turns an already-cropped canvas into the final small black-and-white
  // receipt image: grayscale with boosted contrast (like a document
  // scanner, not a color photo — a receipt is just text on paper, so
  // color carries no information but costs a lot of file size), resized,
  // then compressed.
  function processReceiptCanvas(sourceCanvas) {
    var maxDim = 1050;
    var scale = Math.min(1, maxDim / Math.max(sourceCanvas.width, sourceCanvas.height));
    var w = Math.round(sourceCanvas.width * scale), h = Math.round(sourceCanvas.height * scale);
    var canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext('2d');
    ctx.drawImage(sourceCanvas, 0, 0, w, h);
    var imgData = ctx.getImageData(0, 0, w, h);
    var d = imgData.data;
    var contrast = 3.2; // >1 pushes midtones toward black/white
    for (var i = 0; i < d.length; i += 4) {
      var gray = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      gray = (gray - 128) * contrast + 128;
      gray = Math.max(0, Math.min(255, gray));
      d[i] = d[i + 1] = d[i + 2] = gray;
    }
    ctx.putImageData(imgData, 0, 0);
    // Width/height stored alongside the data now, while we already have
    // them synchronously — avoids reloading the image (async) later just
    // to know its aspect ratio, e.g. when laying it out on a PDF page.
    return { data: canvas.toDataURL('image/jpeg', 0.7), w: w, h: h };
  }

  /* ---------------------------------------------------------------- */
  /* Fuel screen — day-by-day list, reachable from Home, for logging     */
  /* receipts directly without opening a day's full trip details. Fully  */
  /* independent of any client sheet — shared by the whole month.        */
  /* ---------------------------------------------------------------- */
  var fuelModal = document.getElementById('modal-fuel');
  var fuelActiveMonth = null, fuelActiveYear = null;
  function openFuelScreen() {
    var sheet = currentSheet();
    if (!sheet) { toast('Crea prima un foglio mensile'); return; }
    fuelActiveMonth = sheet.month; fuelActiveYear = sheet.year;
    document.getElementById('fuel-sub').textContent = MESI[sheet.month - 1] + ' ' + sheet.year;
    renderFuelList();
    fuelModal.classList.add('open');
  }
  function renderFuelList() {
    var n = daysInMonth(fuelActiveMonth, fuelActiveYear);
    var monthKey = fuelMonthKey(fuelActiveMonth, fuelActiveYear);
    var monthFuel = state.fuel[monthKey] || {};
    var html = '';
    for (var d = 1; d <= n; d++) {
      var receipt = monthFuel[d];
      var date = new Date(fuelActiveYear, fuelActiveMonth - 1, d);
      var dow = GIORNI_SETT[date.getDay()].slice(0, 3);
      var hasReceipt = receipt && receipt.data;
      html += '<div class="day-row' + (hasReceipt ? ' filled' : '') + '" data-fuel-day="' + d + '">';
      html += '<div class="day-num">' + d + '</div>';
      html += '<div class="day-main"><div class="dest">Giorno ' + d + '</div><div class="sub">' + dow + (hasReceipt ? ' · scontrino allegato' : ' · nessuno scontrino') + '</div></div>';
      if (hasReceipt) {
        html += '<div class="fuel-thumb-wrap"><img class="fuel-thumb" src="' + receipt.data + '" alt=""><span class="fuel-remove-x" data-fuel-remove="' + d + '">×</span></div>';
      } else {
        html += '<div class="fuel-add-icon">+</div>';
      }
      html += '</div>';
    }
    document.getElementById('fuel-list').innerHTML = html;
    document.querySelectorAll('#fuel-list [data-fuel-remove]').forEach(function (x) {
      x.addEventListener('click', function (e) {
        e.stopPropagation();
        var d = x.getAttribute('data-fuel-remove');
        var monthKey2 = fuelMonthKey(fuelActiveMonth, fuelActiveYear);
        if (state.fuel[monthKey2]) delete state.fuel[monthKey2][d];
        saveFuel(state.fuel);
        renderFuelList();
        toast('Scontrino rimosso');
      });
    });
    document.querySelectorAll('#fuel-list [data-fuel-day]').forEach(function (row) {
      row.addEventListener('click', function () {
        var d = row.getAttribute('data-fuel-day');
        var monthKey2 = fuelMonthKey(fuelActiveMonth, fuelActiveYear);
        var existing = state.fuel[monthKey2] && state.fuel[monthKey2][d];
        if (existing && existing.data) {
          openFuelViewer(d, existing);
        } else {
          fuelTargetDay = d;
          document.getElementById('in-fuel-photo').click();
        }
      });
    });
  }
  // Shows an already-attached receipt full-size, with its file size, so
  // the person can check what they saved without needing to replace it
  // just to look at it.
  var fuelViewModal = document.getElementById('modal-fuel-view');
  function openFuelViewer(day, receipt) {
    document.getElementById('fuel-view-title').textContent = 'Scontrino — Giorno ' + day;
    document.getElementById('fuel-view-img').src = receipt.data;
    var approxKB = Math.round(receipt.data.length * 0.75 / 1024 * 10) / 10;
    document.getElementById('fuel-view-size').textContent = approxKB + ' KB';
    fuelViewModal.dataset.day = day;
    fuelViewModal.classList.add('open');
  }
  function closeFuelViewer() { fuelViewModal.classList.remove('open'); }
  document.getElementById('fuel-view-close-x').addEventListener('click', closeFuelViewer);
  fuelViewModal.addEventListener('click', function (e) {
    if (e.target === fuelViewModal) closeFuelViewer();
  });
  document.getElementById('fuel-view-replace').addEventListener('click', function () {
    fuelTargetDay = fuelViewModal.dataset.day;
    closeFuelViewer();
    document.getElementById('in-fuel-photo').click();
  });
  document.getElementById('fuel-view-remove').addEventListener('click', function () {
    var d = fuelViewModal.dataset.day;
    var monthKey2 = fuelMonthKey(fuelActiveMonth, fuelActiveYear);
    if (state.fuel[monthKey2]) delete state.fuel[monthKey2][d];
    saveFuel(state.fuel);
    closeFuelViewer();
    renderFuelList();
    toast('Scontrino rimosso');
  });
  document.getElementById('fuel-close').addEventListener('click', function () {
    fuelModal.classList.remove('open');
  });
  document.getElementById('fuel-close-x').addEventListener('click', function () {
    fuelModal.classList.remove('open');
  });
  // Tapping the dark backdrop area (outside the panel itself) also closes
  // it — useful when someone opens this just to glance at it without
  // adding anything.
  fuelModal.addEventListener('click', function (e) {
    if (e.target === fuelModal) fuelModal.classList.remove('open');
  });
  document.getElementById('in-fuel-photo').addEventListener('change', function (e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    loadPickedImage(file).then(function (img) {
      cropRawImage = img;
      openCropScreen(img);
    }).catch(function () { toast('Impossibile leggere la foto'); });
  });

  /* ---------------------------------------------------------------- */
  /* Receipt crop screen — a simple rectangle (not free 4-corner        */
  /* perspective warp) the person drags to frame just the receipt.      */
  /* ---------------------------------------------------------------- */
  function openCropScreen(img) {
    document.getElementById('crop-img').src = img.src;
    document.getElementById('modal-crop').classList.add('open');
    requestAnimationFrame(function () {
      requestAnimationFrame(initCropRect); // second frame: image has laid out at full width by now
    });
  }
  function initCropRect() {
    var stage = document.getElementById('crop-stage');
    var imgEl = document.getElementById('crop-img');
    var stageW = stage.clientWidth, stageH = imgEl.clientHeight;
    var marginX = stageW * 0.06, marginY = stageH * 0.06;
    cropRect = { left: marginX, top: marginY, right: stageW - marginX, bottom: stageH - marginY };
    renderCropRect();
  }
  function renderCropRect() {
    var r = document.getElementById('crop-rect');
    r.style.left = cropRect.left + 'px';
    r.style.top = cropRect.top + 'px';
    r.style.width = (cropRect.right - cropRect.left) + 'px';
    r.style.height = (cropRect.bottom - cropRect.top) + 'px';
  }
  function stagePoint(e) {
    var stage = document.getElementById('crop-stage');
    var rect = stage.getBoundingClientRect();
    var t = (e.touches && e.touches[0]) || e;
    return { x: t.clientX - rect.left, y: t.clientY - rect.top };
  }
  function startCropDrag(mode, e) {
    e.stopPropagation();
    if (e.preventDefault) e.preventDefault();
    cropDragMode = mode;
    cropDragStart = { point: stagePoint(e), rect: { left: cropRect.left, top: cropRect.top, right: cropRect.right, bottom: cropRect.bottom } };
  }
  document.querySelectorAll('.crop-handle').forEach(function (handle) {
    handle.addEventListener('pointerdown', function (e) { startCropDrag(handle.getAttribute('data-corner'), e); });
  });
  document.getElementById('crop-rect').addEventListener('pointerdown', function (e) {
    if (e.target.classList.contains('crop-handle')) return;
    startCropDrag('move', e);
  });
  document.getElementById('crop-stage').addEventListener('pointermove', function (e) {
    if (!cropDragMode) return;
    if (e.preventDefault) e.preventDefault();
    var stage = document.getElementById('crop-stage');
    var stageW = stage.clientWidth, stageH = stage.clientHeight;
    var pt = stagePoint(e);
    var dx = pt.x - cropDragStart.point.x, dy = pt.y - cropDragStart.point.y;
    var r = { left: cropDragStart.rect.left, top: cropDragStart.rect.top, right: cropDragStart.rect.right, bottom: cropDragStart.rect.bottom };
    var minSize = 40;
    if (cropDragMode === 'move') {
      var w = r.right - r.left, h = r.bottom - r.top;
      r.left = Math.max(0, Math.min(stageW - w, r.left + dx));
      r.top = Math.max(0, Math.min(stageH - h, r.top + dy));
      r.right = r.left + w; r.bottom = r.top + h;
    } else {
      if (cropDragMode.indexOf('l') !== -1) r.left = Math.max(0, Math.min(r.right - minSize, r.left + dx));
      if (cropDragMode.indexOf('r') !== -1) r.right = Math.min(stageW, Math.max(r.left + minSize, r.right + dx));
      if (cropDragMode.indexOf('t') !== -1) r.top = Math.max(0, Math.min(r.bottom - minSize, r.top + dy));
      if (cropDragMode.indexOf('b') !== -1) r.bottom = Math.min(stageH, Math.max(r.top + minSize, r.bottom + dy));
    }
    cropRect = r;
    renderCropRect();
  });
  function endCropDrag() { cropDragMode = null; }
  document.getElementById('crop-stage').addEventListener('pointerup', endCropDrag);
  document.getElementById('crop-stage').addEventListener('pointercancel', endCropDrag);

  document.getElementById('crop-cancel').addEventListener('click', function () {
    document.getElementById('modal-crop').classList.remove('open');
    document.getElementById('in-fuel-photo').value = ''; // allow picking the same file again
    cropRawImage = null;
    fuelTargetDay = null;
  });
  document.getElementById('crop-confirm').addEventListener('click', function () {
    if (!cropRawImage || !cropRect || !fuelTargetDay) return;
    var imgEl = document.getElementById('crop-img');
    var scaleX = cropRawImage.naturalWidth / imgEl.clientWidth;
    var scaleY = cropRawImage.naturalHeight / imgEl.clientHeight;
    var sx = cropRect.left * scaleX, sy = cropRect.top * scaleY;
    var sw = (cropRect.right - cropRect.left) * scaleX, sh = (cropRect.bottom - cropRect.top) * scaleY;

    var srcCanvas = document.createElement('canvas');
    srcCanvas.width = Math.max(1, Math.round(sw)); srcCanvas.height = Math.max(1, Math.round(sh));
    srcCanvas.getContext('2d').drawImage(cropRawImage, sx, sy, sw, sh, 0, 0, srcCanvas.width, srcCanvas.height);

    var scontrino = processReceiptCanvas(srcCanvas);
    var monthKey = fuelMonthKey(fuelActiveMonth, fuelActiveYear);
    if (!state.fuel[monthKey]) state.fuel[monthKey] = {};
    state.fuel[monthKey][fuelTargetDay] = scontrino;
    saveFuel(state.fuel);
    renderFuelList();
    toast('Scontrino salvato — Giorno ' + fuelTargetDay);
    reportActivity();
    document.getElementById('modal-crop').classList.remove('open');
    document.getElementById('in-fuel-photo').value = '';
    cropRawImage = null;
    fuelTargetDay = null;
  });

  function openDayEditor(sheet, day) {
    state.editingDay = { sheetId: sheet.id, day: day };
    var g = sheet.giorni[day] || emptyGiorno(state.profile.da, state.profile.provDa);
    var date = new Date(sheet.year, sheet.month - 1, day);

    var kmInizioVal = g.kmInizio;
    if (kmInizioVal === "" || kmInizioVal === undefined) {
      var last = findLastKmFine(sheet, day);
      if (last) kmInizioVal = last.value;
    }

    document.getElementById('day-title').textContent = 'Giorno ' + day;
    document.getElementById('day-sub').textContent = GIORNI_SETT[date.getDay()] + ' ' + day + ' ' + MESI[sheet.month - 1] + ' ' + sheet.year;
    document.getElementById('day-da').value = g.da || state.profile.da || '';
    document.getElementById('day-provda').value = g.provDa || state.profile.provDa || '';
    document.getElementById('day-a').value = g.a || '';
    document.getElementById('day-prova').value = g.provA || '';
    document.getElementById('day-ddt').value = g.ddt || '';
    document.getElementById('day-kminizio').value = kmInizioVal !== undefined ? kmInizioVal : '';
    document.getElementById('day-kmfine').value = g.kmFine || '';
    document.getElementById('day-bonus').value = g.bonus || '';

    // For a client that doesn't count toward the daily rate, this field
    // IS the driver's whole payment for the day, not an extra on top —
    // label and note change accordingly so it's never confused with a
    // real bonus.
    var countsForRate = sheet.countsForDailyRate !== false;
    document.getElementById('day-bonus-label').textContent = countsForRate
      ? 'Bonus (€) — facoltativo'
      : 'Importo per questo cliente (€)';
    document.getElementById('day-bonus-note').textContent = countsForRate
      ? 'Visibile solo a te nella pagina Home — non appare mai nel PDF.'
      : 'Questo cliente non conta per il compenso giornaliero — questo importo è il tuo pagamento per la giornata. Visibile solo a te — non appare mai nel PDF.';

    updateKmTot();
    document.getElementById('ac-list').classList.remove('show');
    dayModal.classList.add('open');
  }
  function closeDayEditor() { dayModal.classList.remove('open'); state.editingDay = null; reloadIfUpdatePending(); }

  // Tapping the dark area outside the sheet (not the sheet itself) closes it
  // without saving — same as tapping "Svuota giorno" is NOT required just to dismiss.
  dayModal.addEventListener('click', function (e) {
    if (e.target === dayModal) closeDayEditor();
  });

  function updateKmTot() {
    var ki = document.getElementById('day-kminizio').value;
    var kf = document.getElementById('day-kmfine').value;
    var warn = document.getElementById('day-warn');
    var totField = document.getElementById('day-kmtot');
    if (ki !== '' && kf !== '' && !isNaN(ki) && !isNaN(kf)) {
      var tot = Number(kf) - Number(ki);
      if (tot < 0) { warn.classList.add('show'); totField.value = tot.toLocaleString('it-IT') + ' (verifica)'; }
      else { warn.classList.remove('show'); totField.value = tot.toLocaleString('it-IT') + ' km'; }
    } else {
      warn.classList.remove('show');
      totField.value = '';
    }
  }
  document.getElementById('day-kminizio').addEventListener('input', updateKmTot);
  document.getElementById('day-kmfine').addEventListener('input', updateKmTot);

  document.getElementById('day-save').addEventListener('click', function () {
    if (!state.editingDay) return;
    var sheet = findSheet(state.editingDay.sheetId);
    var day = state.editingDay.day;
    var aVal = document.getElementById('day-a').value.trim().toUpperCase();
    var daVal = document.getElementById('day-da').value.trim().toUpperCase();
    var provAVal = document.getElementById('day-prova').value.trim().toUpperCase();
    if (aVal && !provAVal) provAVal = lookupProvincia(aVal);

    var existingGiorno = sheet.giorni[day];
    var g = {
      da: daVal,
      provDa: document.getElementById('day-provda').value.trim().toUpperCase(),
      a: aVal,
      provA: provAVal,
      ddt: document.getElementById('day-ddt').value.trim(),
      kmInizio: document.getElementById('day-kminizio').value === '' ? '' : Number(document.getElementById('day-kminizio').value),
      kmFine: document.getElementById('day-kmfine').value === '' ? '' : Number(document.getElementById('day-kmfine').value),
      bonus: document.getElementById('day-bonus').value === '' ? '' : Math.max(0, Number(document.getElementById('day-bonus').value))
    };
    sheet.giorni[day] = g;

    if (aVal) {
      state.profile.frequent = state.profile.frequent || {};
      state.profile.frequent[aVal] = (state.profile.frequent[aVal] || 0) + 1;
      saveProfile(state.profile);
    }
    saveSheets(state.sheets);
    closeDayEditor();
    toast('Giorno ' + day + ' salvato');
    renderFoglio();
    reportActivity();
  });

  document.getElementById('day-clear').addEventListener('click', function () {
    if (!state.editingDay) return;
    var sheet = findSheet(state.editingDay.sheetId);
    var day = state.editingDay.day;
    sheet.giorni[day] = emptyGiorno(state.profile.da, state.profile.provDa);
    saveSheets(state.sheets);
    closeDayEditor();
    toast('Giorno ' + day + ' svuotato');
    renderFoglio();
  });

  // Autocomplete wiring
  var acInput = document.getElementById('day-a');
  var acList = document.getElementById('ac-list');
  acInput.addEventListener('input', function () {
    var results = searchComuni(acInput.value, 8);
    renderAcList(results);
  });
  acInput.addEventListener('focus', function () {
    var results = searchComuni(acInput.value, 8);
    renderAcList(results);
  });
  document.addEventListener('click', function (e) {
    if (!acList.contains(e.target) && e.target !== acInput) acList.classList.remove('show');
  });
  function renderAcList(results) {
    if (!results.length) {
      acList.innerHTML = '<div class="ac-empty">Nessun risultato — puoi digitare liberamente</div>';
      acList.classList.add('show');
      return;
    }
    acList.innerHTML = results.map(function (r) {
      return '<div class="ac-item" data-name="' + escapeHtml(r.name) + '" data-sigla="' + escapeHtml(r.sigla) + '"><span class="name">' + escapeHtml(r.name) + '</span>' + (r.sigla ? '<span class="prov">' + r.sigla + '</span>' : '') + '</div>';
    }).join('');
    acList.classList.add('show');
    acList.querySelectorAll('.ac-item').forEach(function (item) {
      item.addEventListener('click', function () {
        acInput.value = item.getAttribute('data-name').toUpperCase();
        document.getElementById('day-prova').value = item.getAttribute('data-sigla');
        acList.classList.remove('show');
      });
    });
  }

  /* ---------------------------------------------------------------- */
  /* Settings / onboarding modal                                       */
  /* ---------------------------------------------------------------- */
  var settingsModal = document.getElementById('modal-settings');
  var settingsTargetSheet = null;

  function openSettingsModal(sheetOverride) {
    settingsTargetSheet = sheetOverride || null;
    var src = settingsTargetSheet ? {
      nome: settingsTargetSheet.nome, targa: settingsTargetSheet.targa, perContoDi: settingsTargetSheet.perContoDi,
      da: state.profile.da, provDa: state.profile.provDa
    } : state.profile;
    document.getElementById('settings-title').textContent = settingsTargetSheet ? 'Dati foglio' : (state.profile.nome ? 'Impostazioni' : 'Benvenuto');
    document.getElementById('settings-sub').textContent = settingsTargetSheet
      ? 'Modifica i dati per il foglio di ' + MESI[settingsTargetSheet.month - 1] + ' ' + settingsTargetSheet.year + '. I nuovi fogli useranno comunque questi valori come predefiniti.'
      : 'Inserisci i dati autista per iniziare a compilare il foglio viaggi.';
    document.getElementById('in-nome').value = src.nome || '';
    document.getElementById('in-targa').value = src.targa || '';
    document.getElementById('in-conto').value = src.perContoDi || 'BARCELLA';
    document.getElementById('in-da').value = src.da || 'Ponte San Nicolò';
    document.getElementById('in-prov-da').value = src.provDa || 'PD';
    document.getElementById('in-daily-rate').value = state.profile.dailyRate || '';

    var sheetRateSection = document.getElementById('sheet-daily-rate-section');
    if (settingsTargetSheet) {
      sheetRateSection.classList.remove('hidden');
      document.getElementById('in-sheet-daily-rate').checked = settingsTargetSheet.countsForDailyRate !== false;
    } else {
      sheetRateSection.classList.add('hidden');
    }

    settingsModal.classList.add('open');
  }
  document.getElementById('btn-settings').addEventListener('click', function () { openSettingsModal(null); });
  document.getElementById('settings-cancel').addEventListener('click', function () {
    if (!state.profile.nome && !settingsTargetSheet) return; // force first-run completion
    settingsModal.classList.remove('open');
    reloadIfUpdatePending();
  });
  document.getElementById('settings-save').addEventListener('click', function () {
    var nome = document.getElementById('in-nome').value.trim();
    var targa = document.getElementById('in-targa').value.trim().toUpperCase();
    var conto = document.getElementById('in-conto').value.trim().toUpperCase() || 'BARCELLA';
    var da = (document.getElementById('in-da').value.trim() || 'Ponte San Nicolò').toUpperCase();
    var provDa = document.getElementById('in-prov-da').value.trim().toUpperCase() || 'PD';
    var dailyRateRaw = document.getElementById('in-daily-rate').value.trim();
    var dailyRate = dailyRateRaw === '' ? '' : Math.max(0, parseFloat(dailyRateRaw) || 0);

    if (!nome || !targa) { toast('Inserisci nome e targa'); return; }

    state.profile.nome = nome; state.profile.targa = targa; state.profile.perContoDi = conto;
    state.profile.da = da; state.profile.provDa = provDa;
    state.profile.dailyRate = dailyRate;
    saveProfile(state.profile);

    if (settingsTargetSheet) {
      settingsTargetSheet.nome = nome; settingsTargetSheet.targa = targa; settingsTargetSheet.perContoDi = conto;
      settingsTargetSheet.countsForDailyRate = document.getElementById('in-sheet-daily-rate').checked;
      saveSheets(state.sheets);
    }
    settingsModal.classList.remove('open');
    toast('Dati salvati');
    render();
    reportActivity();
    reloadIfUpdatePending();
  });

  /* ---------------------------------------------------------------- */
  /* Generic confirm modal                                             */
  /* ---------------------------------------------------------------- */
  var confirmModal = document.getElementById('modal-confirm');
  function showConfirm(opts) {
    document.getElementById('confirm-title').textContent = opts.title;
    document.getElementById('confirm-sub').textContent = opts.message;
    var okBtn = document.getElementById('confirm-ok');
    okBtn.className = 'btn ' + (opts.danger ? 'btn-danger' : 'btn-accent');
    okBtn.textContent = opts.confirmLabel || 'Conferma';
    document.getElementById('confirm-cancel').textContent = opts.cancelLabel || 'Annulla';
    var slot = document.getElementById('confirm-stepper-slot');
    slot.innerHTML = '';
    if (opts.stepperHtml) slot.innerHTML = opts.stepperHtml;
    confirmModal.classList.add('open');
    var onOk = function () { confirmModal.classList.remove('open'); cleanup(); opts.onConfirm && opts.onConfirm(); reloadIfUpdatePending(); };
    var onCancel = function () { confirmModal.classList.remove('open'); cleanup(); opts.onCancel && opts.onCancel(); reloadIfUpdatePending(); };
    function cleanup() {
      okBtn.removeEventListener('click', onOk);
      document.getElementById('confirm-cancel').removeEventListener('click', onCancel);
    }
    okBtn.addEventListener('click', onOk);
    document.getElementById('confirm-cancel').addEventListener('click', onCancel);
    return { refreshStepper: function (html) { slot.innerHTML = html; } };
  }

  /* ---------------------------------------------------------------- */
  /* New sheet flow                                                    */
  /* ---------------------------------------------------------------- */
  function openNewSheetFlow() {
    var base = latestSheet();
    var m, y;
    if (base) { m = base.month + 1; y = base.year; if (m > 12) { m = 1; y += 1; } }
    else { var now = new Date(); m = now.getMonth() + 1; y = now.getFullYear(); }
    var defaultClient = (base ? base.perContoDi : state.profile.perContoDi) || 'BARCELLA';
    renderNewSheetConfirm(m, y, defaultClient);
  }
  function renderNewSheetConfirm(m, y, client) {
    var stepperHtml =
      '<div class="month-stepper"><button id="ms-prev">−</button><div class="mval" id="ms-val">' + MESI[m - 1] + ' ' + y + '</div><button id="ms-next">+</button></div>' +
      '<div class="field" style="margin-top:8px;"><label>Per conto di</label><input id="ms-client" type="text" value="' + escapeHtml(client) + '" style="text-transform:uppercase"></div>' +
      '<div class="settings-driver-note" style="margin-top:-4px;">Se lavori per piu\' clienti nello stesso mese, crea un foglio separato per ciascuno — come su carta, un foglio per cliente.</div>' +
      '<label class="checkbox-row"><input type="checkbox" id="ms-daily-rate" checked><span>Questo cliente conta per il compenso giornaliero</span></label>' +
      '<div class="settings-driver-note" style="margin-top:-4px;">Disattivalo se questo cliente paga solo un importo fisso (inserito come bonus per giorno) invece dello stipendio giornaliero — utile per un secondo cliente occasionale.</div>';
    showConfirm({
      title: 'Crea nuovo foglio mensile?',
      message: 'Verrà creato un foglio separato. Il foglio precedente non viene modificato né eliminato.',
      confirmLabel: 'Conferma',
      stepperHtml: stepperHtml
      // onConfirm intentionally omitted: the Conferma button's behavior is
      // bound below via okBtn.onclick, since m/y/client change dynamically.
    });
    document.getElementById('ms-prev').addEventListener('click', function () {
      m -= 1; if (m < 1) { m = 12; y -= 1; }
      document.getElementById('ms-val').textContent = MESI[m - 1] + ' ' + y;
    });
    document.getElementById('ms-next').addEventListener('click', function () {
      m += 1; if (m > 12) { m = 1; y += 1; }
      document.getElementById('ms-val').textContent = MESI[m - 1] + ' ' + y;
    });
    // re-bind confirm to use latest m/y/client via closure workaround
    var okBtn = document.getElementById('confirm-ok');
    okBtn.onclick = function () {
      var chosenClient = (document.getElementById('ms-client').value || 'BARCELLA').trim().toUpperCase();
      var countsForRate = document.getElementById('ms-daily-rate').checked;
      confirmModal.classList.remove('open');
      var existing = sheetForMonth(m, y, chosenClient);
      if (existing) {
        state.currentSheetId = existing.id; setCurrentSheetId(existing.id);
        toast('Foglio ' + MESI[m - 1] + ' ' + y + ' (' + chosenClient + ') già esistente — aperto');
        showScreen('foglio');
        reloadIfUpdatePending();
        return;
      }
      createSheet(m, y, chosenClient, countsForRate);
      toast('Nuovo foglio creato: ' + MESI[m - 1] + ' ' + y + ' — ' + chosenClient);
      showScreen('foglio');
      reportActivity();
      reloadIfUpdatePending();
    };
  }
  document.getElementById('btn-nuovo-foglio').addEventListener('click', openNewSheetFlow);

  function confirmUndoSheet(sheet) {
    var hasData = Object.keys(sheet.giorni).some(function (d) {
      var g = sheet.giorni[d];
      return g && (g.a || g.ddt || g.kmFine !== "");
    });
    var isOnly = state.sheets.length === 1;
    showConfirm({
      title: isOnly ? 'Eliminare questo foglio?' : ('Annullare ' + MESI[sheet.month - 1] + ' ' + sheet.year + '?'),
      message: hasData
        ? 'Questo foglio contiene già dei dati. Confermando, i dati inseriti in questo foglio verranno eliminati definitivamente.'
        : (isOnly ? 'Non ci sono altri fogli. Il foglio verrà eliminato.' : 'Tornerai al foglio precedente. Questa azione non può essere annullata.'),
      danger: true,
      confirmLabel: 'Elimina',
      onConfirm: function () {
        deleteSheet(sheet.id);
        toast('Foglio eliminato');
        showScreen(state.sheets.length ? 'foglio' : 'home');
      }
    });
  }

  /* ---------------------------------------------------------------- */
  /* Init                                                               */
  /* ---------------------------------------------------------------- */
  // One-time data migration: any locality names saved before the
  // "uppercase" update (an earlier version of the app) are converted to
  // uppercase now, so old and new entries look consistent everywhere
  // (list, PDF) without the person needing to re-type anything.
  function migrateUppercaseLocalities() {
    var changed = false;
    state.sheets.forEach(function (sheet) {
      Object.keys(sheet.giorni).forEach(function (d) {
        var g = sheet.giorni[d];
        if (!g) return;
        if (g.da && g.da !== g.da.toUpperCase()) { g.da = g.da.toUpperCase(); changed = true; }
        if (g.a && g.a !== g.a.toUpperCase()) { g.a = g.a.toUpperCase(); changed = true; }
      });
    });
    if (state.profile.da && state.profile.da !== state.profile.da.toUpperCase()) {
      state.profile.da = state.profile.da.toUpperCase(); changed = true;
    }
    if (changed) { saveSheets(state.sheets); saveProfile(state.profile); }
  }

  // Measures the real rendered height of the fixed top/bottom bars and
  // exposes them as CSS variables, so the scrollable content in <main> is
  // padded to clear them exactly — no guessing, works identically on every
  // device and every safe-area inset.
  function syncBarHeights() {
    var topbar = document.querySelector('.topbar');
    var bottomnav = document.querySelector('.bottomnav');
    if (topbar) document.documentElement.style.setProperty('--topbar-h', topbar.offsetHeight + 'px');
    if (bottomnav) document.documentElement.style.setProperty('--bottomnav-h', bottomnav.offsetHeight + 'px');
  }

  /* ---------------------------------------------------------------- */
  /* Private usage reporting — lets ION (the app's creator) see, on a    */
  /* password-only page only he has, which drivers have installed the   */
  /* app and how active they are. The app can only SEND this data, never*/
  /* read anything back — no driver's phone can ever see this list.     */
  /* ---------------------------------------------------------------- */
  var SUPABASE_URL = 'https://chboalgzigdglygnnist.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNoYm9hbGd6aWdkZ2x5Z25uaXN0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY1NTc4MjMsImV4cCI6MjEwMjEzMzgyM30.vorEiww3SvVAadgnAqFH42M-MjbpXOojAlhNm-cIeMI';
  var LS_DEVICE_ID = 'pt_device_id_v1';

  function getDeviceId() {
    var id = localStorage.getItem(LS_DEVICE_ID);
    if (!id) {
      id = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID()
        : 'dev-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      localStorage.setItem(LS_DEVICE_ID, id);
    }
    return id;
  }

  function reportActivity() {
    if (!state.profile.nome) return; // nothing meaningful to report yet
    var active = latestSheet();
    var month = active ? active.month : null;
    var year = active ? active.year : null;
    var earnings = (month && year) ? monthEarnings(month, year) : { workedDaysCount: 0 };
    var deviceId = getDeviceId();
    var payload = {
      nome: state.profile.nome,
      targa: state.profile.targa || '',
      last_active: new Date().toISOString(),
      worked_days_this_month: earnings.workedDaysCount || 0,
      active_month: month,
      active_year: year,
      updated_at: new Date().toISOString()
    };
    var headers = {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': 'Bearer ' + SUPABASE_ANON_KEY
    };
    // Try updating this device's existing row first; if none exists yet
    // (first time this phone reports), fall back to inserting a new one.
    // (Not using a single "upsert" request here — combined with the
    // privacy rule that phones can never read this table, an INSERT ...
    // ON CONFLICT DO UPDATE fails Postgres' row-level security check in a
    // way a plain UPDATE-then-INSERT does not.)
    fetch(SUPABASE_URL + '/rest/v1/driver_activity?device_id=eq.' + encodeURIComponent(deviceId), {
      method: 'PATCH',
      headers: Object.assign({}, headers, { 'Prefer': 'return=representation' }),
      body: JSON.stringify(payload)
    }).then(function (res) { return res.json().catch(function () { return []; }); })
      .then(function (updated) {
        if (updated && updated.length > 0) return; // row existed, updated — done
        payload.device_id = deviceId;
        return fetch(SUPABASE_URL + '/rest/v1/driver_activity', {
          method: 'POST',
          headers: Object.assign({}, headers, { 'Prefer': 'return=minimal' }),
          body: JSON.stringify(payload)
        });
      })
      .catch(function () { /* offline or blocked — silently skip, never blocks the app */ });
  }

  function init() {
    migrateUppercaseLocalities();
    reportActivity();
    syncBarHeights();
    window.addEventListener('resize', syncBarHeights);
    window.addEventListener('orientationchange', function () { setTimeout(syncBarHeights, 200); });

    // hidden logo image used for PDF embedding — the bundled Power Trasporti
    // logo.
    var img = new Image();
    img.id = 'pt-logo-img';
    img.src = 'vendor/logo.png';
    img.style.display = 'none';
    document.body.appendChild(img);

    if (!state.profile.nome || !state.profile.targa) {
      openSettingsModal(null);
    }
    if (!state.currentSheetId) {
      var latest = latestSheet();
      if (latest) { state.currentSheetId = latest.id; setCurrentSheetId(latest.id); }
    }
    showScreen('home');

    // Installed home-screen apps sometimes resume from a suspended state
    // instead of doing a real page load — meaning the browser never even
    // checks whether app.js changed. To make the installed app update just
    // as fast as visiting the website directly, we actively ask the
    // service worker to check for updates (right away, whenever the app
    // comes back to the foreground, and periodically while it's open), and
    // reload automatically the moment a new version takes over — unless
    // the person has an unsaved form open, in which case we wait so
    // nothing gets lost.
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js').then(function (registration) {
          function checkForUpdate() { registration.update().catch(function () { /* offline, ignore */ }); }

          checkForUpdate();
          document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible') checkForUpdate();
          });
          setInterval(checkForUpdate, 60000);
        }).catch(function () { /* offline install may fail on first run without https */ });
      });

      var refreshingAfterUpdate = false;
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (refreshingAfterUpdate) return;
        var modalOpen = document.querySelector('.modal-overlay.open');
        if (modalOpen) {
          pendingReloadAfterModalClose = true;
          toast('Nuova versione pronta — verrà applicata alla chiusura di questa finestra');
          return;
        }
        refreshingAfterUpdate = true;
        window.location.reload();
      });
    }
  }

  init();
})();
