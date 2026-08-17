/* Power Trasporti — Foglio Viaggi
   Local-first PWA. All data stays on this device (localStorage). */
(function () {
  "use strict";

  // EARLY, SELF-CONTAINED VERSION CHECK — runs before absolutely anything
  // else in this file. If this phone is ever stuck running a stale copy
  // of this exact script (for example, one that still refers to an
  // element ID that got renamed in a later change elsewhere in this
  // file), that stale script would throw an uncaught error the moment it
  // reaches the broken part, and everything after that point — including
  // a version check placed near the bottom, as this used to be — would
  // simply never run, leaving a blank page with no way to self-heal.
  // Putting this check first means it always gets a chance to notice a
  // mismatch and reload to a fresh copy BEFORE reaching any code later in
  // this file that might be broken. Deliberately minimal and wrapped in
  // its own try/catch so this early check itself can never be the thing
  // that breaks the page.
  //
  // The fetch itself still fires immediately — but with updates shipping
  // often during active development, a newer version is very frequently
  // already available the moment the app opens, which meant the reload
  // this triggers was interrupting the splash screen mid-animation almost
  // every time — small icon, reload, splash restarts, again. The reload
  // itself is delayed (not the check) until just past the splash's own
  // 3.4s, so the splash always plays start to finish uninterrupted, and
  // an update (if one was found) applies right after, quietly, instead of
  // visibly restarting the splash sequence.
  try {
    var SPLASH_DURATION_MS = 2400;
    var pageLoadStart = Date.now();
    var EARLY_RELOAD_COOLDOWN_MS = 20000;
    var lastAutoReload = sessionStorage.getItem('pt_last_auto_reload');
    var reloadedRecently = !!(lastAutoReload && (Date.now() - parseInt(lastAutoReload, 10)) < EARLY_RELOAD_COOLDOWN_MS);
    if (!reloadedRecently) {
      fetch('version.json', { cache: 'no-store' })
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (data && data.v && data.v !== "pt-foglio-v174") {
            var doReload = function () {
              try { sessionStorage.setItem('pt_last_auto_reload', String(Date.now())); } catch (e) { /* ignore */ }
              window.location.reload();
            };
            var elapsed = Date.now() - pageLoadStart;
            var remaining = SPLASH_DURATION_MS + 200 - elapsed; // small buffer past the splash's own hide timer
            if (remaining > 0) { setTimeout(doReload, remaining); } else { doReload(); }
          }
        })
        .catch(function () { /* offline or blocked — silently skip, try again later */ });
    }
  } catch (e) { /* never let this early check itself break the page */ }

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
  var APP_VERSION = "pt-foglio-v174"; // bumped alongside sw.js CACHE_VERSION and version.json, every release
  var LS_PROFILE = "pt_profile_v1";
  var LS_SHEETS = "pt_sheets_v1";
  var LS_CURRENT = "pt_current_sheet_v1";
  var LS_FUEL = "pt_fuel_v1"; // fuel receipts, keyed by month — independent of any client sheet
  var LS_VEHICLE = "pt_vehicle_v1"; // commercial-vehicle dimensions/weight, used by the Navigatore for restriction-aware routing
  var LS_NAV_FREQUENT = "pt_nav_frequent_v1"; // addresses actually used in a calculated route, remembered and suggested again — like Chrome's own address bar history
  var LS_NAV_HOMEWORK = "pt_nav_homework_v1"; // Casa/Lavoro shortcuts, set once by the driver — same idea as Google Maps' own Home/Work shortcuts, stored locally only (no sync, per ION's decision)

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

  function loadVehicle() {
    return loadJSON(LS_VEHICLE, {
      tipo: "furgone", altezza: "", larghezza: "", lunghezza: "",
      massa: "", massaAssi: "", rimorchio: false, classeEmissioni: ""
    });
  }
  function saveVehicle(v) { saveJSON(LS_VEHICLE, v); }

  // Addresses actually used to calculate a route — remembered and
  // proposed again, most-used first, the same idea as Chrome's own
  // address bar suggesting sites visited often.
  function loadNavFrequent() { return loadJSON(LS_NAV_FREQUENT, []); }
  function saveNavFrequent(list) { saveJSON(LS_NAV_FREQUENT, list); }
  function recordNavFrequentUse(point, text) {
    if (!point || !text) return;
    var list = loadNavFrequent();
    var key = point.lat.toFixed(4) + ',' + point.lon.toFixed(4); // small rounding — the same real place, picked slightly differently, still counts as the same entry
    var existing = list.filter(function (e) { return e.key === key; })[0];
    if (existing) { existing.count++; existing.lastUsed = Date.now(); existing.text = text; }
    else { list.push({ key: key, text: text, lat: point.lat, lon: point.lon, count: 1, lastUsed: Date.now() }); }
    list.sort(function (a, b) { return b.count - a.count || b.lastUsed - a.lastUsed; });
    saveNavFrequent(list.slice(0, 20)); // no need to keep more than the addresses that would ever realistically surface as "frequent"
  }

  // Casa/Lavoro — set once by the driver, then offered as one-tap
  // shortcuts every time, same as Google Maps' own Home/Work chips.
  function loadNavHomeWork() { return loadJSON(LS_NAV_HOMEWORK, { home: null, work: null }); }
  function saveNavHomeWork(hw) { saveJSON(LS_NAV_HOMEWORK, hw); }


  function loadSheets() { return loadJSON(LS_SHEETS, []); }
  function saveSheets(arr) { saveJSON(LS_SHEETS, arr); }

  // Fuel receipts are logged per CALENDAR DAY, for the truck/driver as a
  // whole — never tied to any one client. Whether a month has one client
  // sheet or ten, the same set of receipts for that month is shared by
  // all of them: { "2026-8": { "5": {data,w,h}, "12": {...} }, ... }
  function loadFuel() { return loadJSON(LS_FUEL, {}); }
  function saveFuel(obj) { saveJSON(LS_FUEL, obj); }
  function fuelMonthKey(month, year) { return year + '-' + month; }

  // Registry of available PDF layouts. Each client (sheet) can use a
  // different one — different companies sometimes require a different
  // document shape for the same driver. New layouts get added here over
  // time; 'code' is the short label shown when picking one, kept to a
  // few letters so it stays easy to tell apart and remember at a glance.
  var PDF_TEMPLATES = {
    'classic': { code: 'STD', name: 'Standard', desc: 'Un giro al giorno' },
    'due-giri': { code: '2G', name: 'Due Giri/Giorno', desc: 'Due destinazioni e DDT separati nello stesso giorno' }
  };
  var DEFAULT_PDF_TEMPLATE = 'classic';
  // Removes ONE specific receipt photo (by index) from a day — a day can
  // now hold several receipts (e.g. if the pump printed more than one, or
  // something went wrong and it needed retrying), so deleting means
  // removing just that one photo from the day's list, not the whole day.
  // Also drops the now-empty day/month wrappers entirely (rather than
  // leaving empty [] / {} behind) so nothing lingers in storage once
  // every receipt has been removed.
  function deleteFuelReceipt(monthKey, day, index) {
    if (!state.fuel[monthKey] || !state.fuel[monthKey][day]) return;
    state.fuel[monthKey][day].splice(index, 1);
    if (state.fuel[monthKey][day].length === 0) delete state.fuel[monthKey][day];
    if (Object.keys(state.fuel[monthKey]).length === 0) delete state.fuel[monthKey];
    saveFuel(state.fuel);
  }

  function getCurrentSheetId() { return localStorage.getItem(LS_CURRENT) || null; }
  function setCurrentSheetId(id) { if (id) localStorage.setItem(LS_CURRENT, id); }

  var state = {
    profile: loadProfile(),
    sheets: loadSheets(),
    fuel: loadFuel(),
    vehicle: loadVehicle(),
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
    toast._t = setTimeout(function () { t.classList.remove('show'); }, 3000);
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
    return {
      da: prefillDa || "", provDa: prefillProvDa || "", a: "", provA: "", ddt: "",
      // Second destination/DDT — only shown and used on sheets using the
      // 'due-giri' PDF template; present on every giorno regardless, kept
      // simply empty otherwise, so switching a sheet's template later
      // doesn't require migrating existing days.
      a2: "", provA2: "", ddt2: "",
      kmInizio: "", kmFine: "", bonus: ""
    };
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

  function createSheet(month, year, perContoDi, countsForDailyRate, pdfTemplate) {
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
      // Which PDF layout this client's sheet uses (see PDF_TEMPLATES) —
      // set once when the sheet is created, since it reflects what
      // paperwork that specific client requires, not a global preference.
      pdfTemplate: (pdfTemplate && PDF_TEMPLATES[pdfTemplate]) ? pdfTemplate : DEFAULT_PDF_TEMPLATE,
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
    // The local copy is gone, but the server's own row for this sheet
    // (used by admin) never gets touched by an ordinary sync — sync only
    // ever upserts sheets that still exist locally, it never notices one
    // that's disappeared. Tell the server explicitly, so admin doesn't
    // keep showing a sheet the driver deleted, with data that's now
    // permanently stuck at whatever it was the moment before deletion.
    var deviceId = getDeviceId();
    fetch(SUPABASE_URL + '/rest/v1/driver_sheets_summary?device_id=eq.' + encodeURIComponent(deviceId) + '&sheet_id=eq.' + encodeURIComponent(id), {
      method: 'DELETE',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + SUPABASE_ANON_KEY
      }
    }).catch(function () { /* offline or blocked — the row just lingers until the next successful attempt */ });
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
    ['home', 'foglio', 'archivio', 'pdf', 'navigatore'].forEach(function (n) {
      document.getElementById('screen-' + n).classList.toggle('active', n === name);
    });
    document.querySelectorAll('.navbtn[data-nav]').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-nav') === name);
    });
    // The navigator wants to feel exactly like opening Google Maps —
    // edge-to-edge, with only its own floating search bar as the
    // "header", not this app's own title bar sitting above it. Hidden
    // only for this one screen, restored everywhere else.
    document.body.classList.toggle('nav-fullbleed', name === 'navigatore');
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
    else if (currentScreen === 'navigatore') renderNavigatore();
  }

  function svgIcon(name) {
    var icons = {
      truck: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="6" width="14" height="11"/><path d="M15 10h4l3 3v4h-7z"/><circle cx="6" cy="19" r="1.6"/><circle cx="17.5" cy="19" r="1.6"/></svg>',
      route: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="5" cy="6" r="2"/><circle cx="19" cy="18" r="2"/><path d="M5 8v4a4 4 0 0 0 4 4h6" stroke-dasharray="3 3"/></svg>',
      fuel: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="9" height="18" rx="1"/><rect x="6.3" y="5.5" width="4.4" height="4" rx="0.5"/><path d="M13 9h2.5l3 2.5v6.5a1.5 1.5 0 0 1-3 0v-3.5a1 1 0 0 0-1-1h-1.5"/></svg>',
      share: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><path d="M16 6l-4-4-4 4"/><path d="M12 2v13"/></svg>',
      calendar: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M8 3v4"/><path d="M16 3v4"/></svg>',
      // Turn-by-turn navigation glyphs, from the "ADB Smart Navigator"
      // SVG pack ION commissioned — plain line icons on a transparent
      // background (currentColor, so they take on whatever color the
      // surrounding button/banner needs). These replace an earlier
      // hand-drawn set; the exact type-number → icon mapping below
      // matches ORS's own documented instruction-type table
      // (giscience.github.io/openrouteservice/.../instruction-types) —
      // the previous mapping had sharp turns, roundabouts, and the
      // actual U-turn type pointing at the wrong glyphs.
      'nav-turn-left': '<svg viewBox="0 0 96 96" width="26" height="26"><path d="M68 66V44c0-10-8-18-18-18H22" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/><path d="M34 14L22 26l12 12" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      'nav-turn-right': '<svg viewBox="0 0 96 96" width="26" height="26"><path d="M28 66V44c0-10 8-18 18-18h28" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/><path d="M62 14l12 12-12 12" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      'nav-sharp-left': '<svg viewBox="0 0 96 96" width="26" height="26"><path d="M60 72V48c0-6-3-10-8-14L24 16" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/><path d="M40 12H20v20" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      'nav-sharp-right': '<svg viewBox="0 0 96 96" width="26" height="26"><path d="M36 72V48c0-6 3-10 8-14l28-18" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/><path d="M56 12h20v20" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      'nav-slight-left': '<svg viewBox="0 0 96 96" width="26" height="26"><path d="M58 74V38L26 20" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/><path d="M40 18H24v16" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      'nav-slight-right': '<svg viewBox="0 0 96 96" width="26" height="26"><path d="M38 74V38l32-18" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/><path d="M56 18h16v16" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      'nav-straight': '<svg viewBox="0 0 96 96" width="26" height="26"><path d="M48 74V20" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round"/><path d="M34 30l14-14 14 14" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      'nav-roundabout-enter': '<svg viewBox="0 0 96 96" width="26" height="26"><circle cx="48" cy="44" r="18" fill="none" stroke="currentColor" stroke-width="7"/><path d="M48 8v18" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round"/><path d="M36 18l12-12 12 12" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/><path d="M30 44H12" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round"/><path d="M24 32L12 44l12 12" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      'nav-roundabout-exit': '<svg viewBox="0 0 96 96" width="26" height="26"><circle cx="48" cy="44" r="18" fill="none" stroke="currentColor" stroke-width="7"/><path d="M48 8v18" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round"/><path d="M36 18l12-12 12 12" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/><path d="M60 44h18" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round"/><path d="M66 32l12 12-12 12" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      'nav-uturn': '<svg viewBox="0 0 96 96" width="26" height="26"><path d="M62 74V34c0-12-10-22-22-22S18 22 18 34v10" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round"/><path d="M6 34l12 12 12-12" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      'nav-finish': '<svg viewBox="0 0 96 96" width="26" height="26"><path d="M48 74V20" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round"/><circle cx="48" cy="12" r="7" fill="currentColor"/></svg>',
      'nav-keep-left': '<svg viewBox="0 0 96 96" width="26" height="26"><path d="M48 74V24" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round"/><path d="M48 40L26 18" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round"/><path d="M18 18h16v16" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      'nav-keep-right': '<svg viewBox="0 0 96 96" width="26" height="26"><path d="M48 74V24" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round"/><path d="M48 40l22-22" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round"/><path d="M54 18h16v16" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      // Control-button glyphs, same pack — replace emoji (🛰️🔍✕ etc.)
      // that were rendering as full-color emoji with their own baked-in
      // background on iOS, impossible to restyle from CSS.
      'nav-search': '<svg viewBox="0 0 96 96" width="26" height="26"><circle cx="42" cy="42" r="18" fill="none" stroke="currentColor" stroke-width="6"/><path d="M56 56l14 14" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round"/></svg>',
      'nav-layers': '<svg viewBox="0 0 96 96" width="22" height="22"><path d="M48 24l20 10-20 10-20-10z" fill="none" stroke="currentColor" stroke-width="5" stroke-linejoin="round"/><path d="M28 44l20 10 20-10" fill="none" stroke="currentColor" stroke-width="5" stroke-linejoin="round"/><path d="M28 54l20 10 20-10" fill="none" stroke="currentColor" stroke-width="5" stroke-linejoin="round"/></svg>',
      'nav-close': '<svg viewBox="0 0 96 96" width="18" height="18"><path d="M28 28l40 40M68 28L28 68" stroke="currentColor" stroke-width="8" stroke-linecap="round"/></svg>',
      'nav-recenter': '<svg viewBox="0 0 96 96" width="22" height="22"><circle cx="48" cy="48" r="18" fill="none" stroke="currentColor" stroke-width="6"/><circle cx="48" cy="48" r="5" fill="currentColor"/><path d="M48 12v14M48 70v14M12 48h14M70 48h14" stroke="currentColor" stroke-width="6" stroke-linecap="round"/></svg>',
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
    html += '<button class="calendar-corner-btn" id="home-calendar" aria-label="Calendario">' + svgIcon('calendar') + '</button>';
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
    document.getElementById('home-calendar').addEventListener('click', function () { openCalendarModal(sheet.month, sheet.year); });
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

  // Real calendar grid for a given month — every day, with a filled
  // (has a real trip logged, checked across every client sheet that
  // month, not just the currently-open one) day circled. Remembers which
  // month is currently showing, so prev/next can step through any month
  // that's ever had a sheet.
  var calendarShowingMonth = null, calendarShowingYear = null;
  function openCalendarModal(month, year) {
    calendarShowingMonth = month; calendarShowingYear = year;
    renderCalendarModal();
    document.getElementById('modal-calendar').classList.add('open');
  }
  function renderCalendarModal() {
    var month = calendarShowingMonth, year = calendarShowingYear;
    document.getElementById('calendar-title').textContent = MESI[month - 1] + ' ' + year;

    // Free navigation to any month — not limited to months that happen to
    // have a sheet already (a driver should be able to browse forward
    // to see an upcoming empty month, or back through old, unworked
    // months, same as any ordinary calendar app). Only a wide sanity
    // bound (10 years either way) to stop someone from scrolling forever
    // by mistake.
    var now = new Date();
    var thisKey = year * 12 + (month - 1);
    var todayKey = now.getFullYear() * 12 + now.getMonth();
    document.getElementById('calendar-prev').disabled = thisKey <= todayKey - 120;
    document.getElementById('calendar-next').disabled = thisKey >= todayKey + 120;

    // Every day in this month, across every client sheet, that has an
    // actual trip logged (same check used in Archivio).
    var filledDays = {};
    state.sheets.forEach(function (s) {
      if (s.month !== month || s.year !== year) return;
      Object.keys(s.giorni).forEach(function (d) {
        var g = s.giorni[d];
        if (g && (g.a || g.kmFine !== "")) filledDays[Number(d)] = true;
      });
    });

    var firstOfMonth = new Date(year, month - 1, 1);
    var daysInMonth = new Date(year, month, 0).getDate();
    // JS getDay(): 0=Sunday..6=Saturday — shifted so Monday is column 0,
    // matching the "L M M G V S D" header already in the markup.
    var startOffset = (firstOfMonth.getDay() + 6) % 7;
    var today = new Date();
    var isCurrentMonth = today.getFullYear() === year && (today.getMonth() + 1) === month;

    var html = '';
    for (var i = 0; i < startOffset; i++) html += '<div class="calendar-day empty"></div>';
    for (var day = 1; day <= daysInMonth; day++) {
      var classes = 'calendar-day';
      if (filledDays[day]) classes += ' has-entry';
      if (isCurrentMonth && today.getDate() === day) classes += ' is-today';
      html += '<button type="button" class="' + classes + '">' + day + '</button>';
    }
    document.getElementById('calendar-grid').innerHTML = html;
  }
  document.getElementById('calendar-prev').addEventListener('click', function () {
    calendarShowingMonth--;
    if (calendarShowingMonth < 1) { calendarShowingMonth = 12; calendarShowingYear--; }
    renderCalendarModal();
  });
  document.getElementById('calendar-next').addEventListener('click', function () {
    calendarShowingMonth++;
    if (calendarShowingMonth > 12) { calendarShowingMonth = 1; calendarShowingYear++; }
    renderCalendarModal();
  });
  document.getElementById('calendar-close-x').addEventListener('click', function () {
    document.getElementById('modal-calendar').classList.remove('open');
  });
  document.getElementById('modal-calendar').addEventListener('click', function (e) {
    if (e.target === document.getElementById('modal-calendar')) document.getElementById('modal-calendar').classList.remove('open');
  });
  // Swiping left/right directly over the calendar grid changes the month
  // — much easier to hit reliably on a phone than the small arrow
  // buttons. A minimum horizontal distance (and staying mostly
  // horizontal, not vertical) keeps an ordinary tap-on-a-day from
  // accidentally triggering navigation.
  (function () {
    var grid = document.getElementById('calendar-grid');
    var startX = null, startY = null;
    grid.addEventListener('touchstart', function (e) {
      startX = e.touches[0].clientX; startY = e.touches[0].clientY;
    }, { passive: true });
    grid.addEventListener('touchend', function (e) {
      if (startX === null) return;
      var dx = e.changedTouches[0].clientX - startX;
      var dy = e.changedTouches[0].clientY - startY;
      startX = null; startY = null;
      if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.5) return; // too short, or too vertical — not a swipe
      var btn = document.getElementById(dx < 0 ? 'calendar-next' : 'calendar-prev');
      if (btn && !btn.disabled) btn.click();
    }, { passive: true });
  })();

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

  /* ---------------------------------------------------------------- */
  /* Navigatore — commercial-vehicle-aware routing                     */
  /* ---------------------------------------------------------------- */
  // Uses OpenRouteService (openrouteservice.org) — a free, open routing
  // service with a dedicated "driving-hgv" (heavy goods vehicle) profile
  // that actually understands truck-specific restrictions (height,
  // width, length, weight, axle load), not just car routing. Needs a
  // free API key (no payment method required) — set below once ION has
  // registered one at openrouteservice.org/dev/#/signup.
  var ORS_API_KEY = "eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6IjA3YzdmZTgwZTc5YjQ0OTliNjYxYzdlZGFiY2JlZDdlIiwiaCI6Im11cm11cjY0In0=";

  var TIPO_VEICOLO_OPTS = [
    { v: 'furgone', l: 'Furgone' },
    { v: 'cassonato', l: 'Cassonato' },
    { v: 'camion', l: 'Camion' },
    { v: 'autoarticolato', l: 'Autoarticolato' }
  ];

  var navMap = null, navRouteLayer = null;
  var navLocateMarker = null; // "you are here" marker dropped by the standalone locate button, kept separate from the active-navigation position marker
  var navSearchFocusPoint = null; // driver's GPS position, cached once per Navigatore visit, used to bias/rank geocoding results toward nearby places first — without this, a generic query like "Via Roma 5" ranks results from anywhere in Italy with no sense of which one is actually relevant

  function renderNavigatore() {
    // A RETURN visit — the person switched to another tab (Home,
    // Foglio, etc.) while actively navigating and has now come back.
    // Previously this whole function ran unconditionally every time,
    // rebuilding the entire screen from scratch — including
    // initNavMap(), which always tears down and recreates the Leaflet
    // map instance. That silently destroyed the live GPS watch, the
    // drawn route, and the whole active-navigation overlay the moment
    // someone came back, ending the trip from their perspective even
    // though they never pressed Termina. If navigation is already
    // running (a GPS watch is attached) and the map still exists, skip
    // the rebuild entirely — the screen's own DOM was only hidden via
    // CSS while away, never removed, so it's already exactly as it
    // should be; showScreen's own class toggle handles making it
    // visible again.
    if (navWatchId != null && navMap) {
      return;
    }
    var el = document.getElementById('screen-navigatore');
    var html = '';

    html += '<div class="nav-map-wrap">';
    html += '<div id="nav-map-tilt-wrap" class="nav-map-tilt-wrap"><div id="nav-map-rotate-wrap" class="nav-map-rotate-wrap"><div id="nav-map" class="nav-map nav-map-tall"></div></div></div>';

    // The search bar itself IS the header — no separate title row above
    // it, same as Google Maps: a rounded pill floating directly on the
    // map, hamburger-style icon on the left, a round settings icon on
    // the right where Google puts the profile picture.
    html += '<div class="nav-search-bar" id="nav-search-bar">';
    html += '<span class="nav-search-icon">' + svgIcon('nav-search') + '</span><span id="nav-search-label">Dove vuoi andare?</span>';
    html += '<button type="button" class="nav-search-gear" id="nav-gear-btn" aria-label="Impostazioni veicolo">⚙</button>';
    html += '</div>';
    html += '<div class="nav-search-panel" id="nav-search-panel" style="display:none;">';
    html += '<div class="nav-shortcuts-row" id="nav-shortcuts-row"></div>';
    html += '<div id="nav-waypoints-list"></div>';
    html += '<button type="button" class="nav-add-stop-btn" id="nav-add-stop">+ Aggiungi tappa</button>';
    html += '<button type="button" class="btn btn-accent btn-block" id="nav-calc-btn" style="margin-top:12px;">Calcola percorso</button>';
    html += '</div>';

    // Floating controls, bottom-right — same spot Google Maps puts its
    // own layers toggle and "my location" button.
    html += '<div class="nav-float-controls" id="nav-float-controls">';
    html += '<button type="button" class="nav-float-btn" id="nav-layers-btn" aria-label="Vista satellite">' + svgIcon('nav-layers') + '</button>';
    html += '<button type="button" class="nav-float-btn" id="nav-locate-btn" aria-label="La mia posizione"><svg viewBox="0 0 60 60" width="22" height="22"><circle cx="30" cy="30" r="27" fill="#ffffff" stroke="#e4e8ef" stroke-width="2"/><circle cx="30" cy="30" r="10" fill="#6fa3ff"/><circle cx="30" cy="30" r="18" fill="#6fa3ff" fill-opacity="0.18"/></svg></button>';
    html += '</div>';

    html += '<div id="nav-result" class="nav-result" style="display:none;"></div>';

    html += '<div id="nav-active-overlay" class="nav-active-overlay" style="display:none;">';
    html += '<div class="nav-instruction-banner">' +
      '<button type="button" class="nav-exit-x" id="nav-exit-x" aria-label="Esci dalla navigazione">✕</button>' +
      '<div class="nav-instruction-icon-wrap"><span id="nav-instr-icon">' + svgIcon('nav-straight') + '</span></div>' +
      '<div class="nav-instruction-copy"><div class="nav-instruction-dist" id="nav-instr-dist">—</div><div class="nav-instruction-text" id="nav-instr-text"></div></div>' +
      '</div>';
    html += '<div class="nav-active-float-controls">' +
      '<button type="button" class="nav-float-btn" id="nav-active-layers-btn" aria-label="Vista satellite">' + svgIcon('nav-layers') + '</button>' +
      '<button type="button" class="nav-compass-badge" id="nav-compass-btn" aria-label="Direzione di marcia"><span id="nav-compass-needle">N</span></button>' +
      '</div>';
    html += '<div class="nav-speed-badge" id="nav-speed-badge" style="display:none;"><b id="nav-speed-value">0</b><span>km/h</span></div>';
    html += '<button type="button" class="nav-recenter-btn" id="nav-recenter-btn" style="display:none;" aria-label="Ricentra">' + svgIcon('nav-recenter') + '</button>';
    html += '<div class="nav-active-bottom">' +
      '<div class="nav-stat-col"><b id="nav-active-arrival"></b><span>arrivo</span></div>' +
      '<div class="nav-stat-col nav-stat-eta"><b id="nav-active-eta"></b><span>tempo</span></div>' +
      '<div class="nav-stat-col"><b id="nav-active-remaining"></b><span>distanza</span></div>' +
      '<button type="button" class="nav-end-btn" id="nav-end-btn" aria-label="Termina navigazione">Termina</button>' +
      '</div>';
    html += '</div>';
    html += '</div>';

    el.innerHTML = html;
    renderNavWaypointsList();
    renderNavShortcuts();
    populateNavVehicleForm();

    document.getElementById('nav-search-bar').addEventListener('click', function () {
      var panel = document.getElementById('nav-search-panel');
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    });
    // Tapping anywhere else on the map (outside the panel and the
    // search bar that opens it) closes the trip-planning panel — same
    // convention as the modals, applied here too since this floating
    // panel isn't a ".modal-overlay" and wouldn't otherwise get it.
    document.addEventListener('click', function (e) {
      var panel = document.getElementById('nav-search-panel');
      var bar = document.getElementById('nav-search-bar');
      if (!panel || panel.style.display === 'none') return;
      if (panel.contains(e.target) || (bar && bar.contains(e.target))) return;
      if (navPickingWaypointId) return; // map-picking mode already hides the panel on its own and needs the tap for placing the pin
      panel.style.display = 'none';
    });
    document.getElementById('nav-gear-btn').addEventListener('click', function (e) {
      e.stopPropagation();
      document.getElementById('modal-nav-vehicle').classList.add('open');
    });
    document.getElementById('nav-vehicle-close-x').addEventListener('click', function () {
      document.getElementById('modal-nav-vehicle').classList.remove('open');
    });
    document.getElementById('nav-vehicle-save').addEventListener('click', function () {
      state.vehicle = {
        tipo: document.getElementById('veh-tipo').value,
        altezza: document.getElementById('veh-altezza').value,
        larghezza: document.getElementById('veh-larghezza').value,
        lunghezza: document.getElementById('veh-lunghezza').value,
        massa: document.getElementById('veh-massa').value,
        massaAssi: document.getElementById('veh-massaAssi').value,
        rimorchio: document.getElementById('veh-rimorchio').checked,
        classeEmissioni: document.getElementById('veh-classeEmissioni').value
      };
      saveVehicle(state.vehicle);
      toast('Veicolo salvato');
      document.getElementById('modal-nav-vehicle').classList.remove('open');
    });
    document.getElementById('nav-calc-btn').addEventListener('click', calculateNavRoute);
    document.getElementById('nav-add-stop').addEventListener('click', addNavWaypointBeforeDest);
    document.getElementById('nav-layers-btn').addEventListener('click', toggleNavSatelliteView);
    document.getElementById('nav-active-layers-btn').addEventListener('click', toggleNavSatelliteView);
    // The screen's whole HTML is rebuilt fresh every time Navigatore is
    // (re-)opened, so any earlier "on" class from a previous visit is
    // gone from the DOM even though navShowingSatellite itself (and the
    // actual map layer) may still be true — sync the button's own look
    // to match reality right away, not just the next time it's tapped.
    ['nav-layers-btn', 'nav-active-layers-btn'].forEach(function (id) {
      var btn = document.getElementById(id);
      if (btn) btn.classList.toggle('on', navShowingSatellite);
    });
    document.getElementById('nav-locate-btn').addEventListener('click', function () {
      var btn = document.getElementById('nav-locate-btn');
      btn.classList.add('on'); // immediate feedback that the tap registered — a GPS fix can genuinely take a few seconds, so without this the button looked like it was doing nothing
      currentPosition()
        .then(function (p) {
          navMap.setView([p.lat, p.lon], 16, { animate: true });
          // A visible "you are here" marker — previously this only
          // panned the map, which (especially if already roughly
          // nearby) could look like nothing happened at all.
          if (navLocateMarker) navMap.removeLayer(navLocateMarker);
          navLocateMarker = L.marker([p.lat, p.lon], {
            icon: L.divIcon({
              className: 'nav-locate-marker',
              html: '<svg viewBox="0 0 60 60" width="26" height="26"><circle cx="30" cy="30" r="27" fill="#ffffff" stroke="#e4e8ef" stroke-width="2"/><circle cx="30" cy="30" r="10" fill="#6fa3ff"/><circle cx="30" cy="30" r="18" fill="#6fa3ff" fill-opacity="0.18"/></svg>',
              iconSize: [26, 26], iconAnchor: [13, 13]
            })
          }).addTo(navMap);
        })
        .catch(function () { toast('Posizione non disponibile — verifica i permessi di localizzazione'); })
        .then(function () { btn.classList.remove('on'); });
    });

    // Wired ONCE here, at render time — not inside startActiveNavigation,
    // which runs again every time "Avvia" is pressed (including a
    // restart after "Termina", per the "route stays ready" behavior).
    // These three buttons live in the DOM for the whole visit to this
    // screen without ever being rebuilt, so attaching their listeners
    // inside startActiveNavigation meant a SECOND (third, fourth…)
    // click listener stacked on the very same button element every
    // time navigation restarted — several handlers firing on one tap,
    // which is exactly the kind of thing that can net out to "nothing
    // visibly happens" (this was reported broken even before the
    // rotate plugin existed, so it isn't that; this stacking bug fits
    // the symptom directly and is a real, structural bug regardless).
    document.getElementById('nav-end-btn').addEventListener('click', stopActiveNavigation);
    document.getElementById('nav-exit-x').addEventListener('click', stopActiveNavigation);
    document.getElementById('nav-recenter-btn').addEventListener('click', function () {
      navFollowingUser = true;
      document.getElementById('nav-recenter-btn').style.display = 'none';
      // Instant jump using whatever position is already known — no
      // waiting on anything, so there's immediate visual feedback the
      // tap did something, even before a fresh GPS read comes back.
      if (navLastPosition) navMap.setView([navLastPosition.lat, navLastPosition.lon], 18, { animate: false });
      // navLastPosition only updates whenever the background watch
      // happens to fire next — it can genuinely be several seconds
      // stale (this was very likely why recentering felt like it took
      // ~10s: the map wasn't actually slow, it was waiting on the
      // NEXT natural GPS update to arrive before it had anything more
      // current to show). Requesting a fresh, high-accuracy fix
      // directly — same call the "la mia posizione" button already
      // uses — refines the view immediately instead of waiting on that.
      currentPosition().then(function (p) {
        navLastPosition = { lat: p.lat, lon: p.lon };
        if (navFollowingUser) navMap.setView([p.lat, p.lon], 18, { animate: false });
      }).catch(function () { /* the instant jump above already used the best position available — nothing more to do if a fresh read fails */ });
    });

    initNavMap();
    // If the vehicle isn't configured yet, open settings automatically
    // once — there's nothing useful to route without it, same as a
    // first-run prompt.
    if (!vehicleIsConfigured(state.vehicle)) document.getElementById('modal-nav-vehicle').classList.add('open');
    requestNavLocationPermission();
  }

  function populateNavVehicleForm() {
    var v = state.vehicle;
    var sel = document.getElementById('veh-tipo');
    sel.innerHTML = TIPO_VEICOLO_OPTS.map(function (o) { return '<option value="' + o.v + '"' + (v.tipo === o.v ? ' selected' : '') + '>' + o.l + '</option>'; }).join('');
    document.getElementById('veh-altezza').value = v.altezza;
    document.getElementById('veh-larghezza').value = v.larghezza;
    document.getElementById('veh-lunghezza').value = v.lunghezza;
    document.getElementById('veh-massa').value = v.massa;
    document.getElementById('veh-massaAssi').value = v.massaAssi;
    document.getElementById('veh-classeEmissioni').value = v.classeEmissioni;
    document.getElementById('veh-rimorchio').checked = !!v.rimorchio;
  }

  function vehicleIsConfigured(v) {
    return !!(v.altezza && v.larghezza && v.lunghezza && v.massa);
  }

  var navStreetLayer = null, navSatelliteLayer = null;
  function initNavMap() {
    var mapEl = document.getElementById('nav-map');
    if (!mapEl || typeof L === 'undefined') return;
    if (navMap) { navMap.remove(); navMap = null; }
    navWaypointMarkers = {}; // the old map instance (and any markers on it) is gone
    navRouteLayer = null;
    navLocateMarker = null;
    // REVERTED — real map rotation (leaflet-rotate plugin) caused a
    // cascade of real, confirmed problems while actually driving: the
    // car icon pointing sideways instead of forward, the recenter
    // button not working, the position marker drifting off the road,
    // the camera losing track of the car entirely. The plugin's own
    // documentation describes itself as a "proof of concept", and this
    // is now the third confirmed failure of an attempt at rotating the
    // map (after two earlier CSS-transform attempts also failed).
    // Fixed north-up, no rotation at all, is what was actually proven
    // stable before any of these attempts — reliability while driving
    // matters far more than a rotating camera, so this stays plain
    // until (if ever) a genuinely solid rotation approach is found and
    // very carefully verified, not guessed at again.
    navMap = L.map(mapEl, { zoomControl: false }).setView([45.4642, 9.19], 6); // centered on Northern Italy by default
    // CARTO's free "Voyager" style — light background, clear road/place
    // labels, closer to the familiar look people already know from
    // Google Maps than the plainer default OpenStreetMap tiles.
    navStreetLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      attribution: '© OpenStreetMap contributors © CARTO',
      maxZoom: 20,
      subdomains: 'abcd'
    });
    // Esri's free World Imagery — real satellite/aerial photography, the
    // same idea as switching Google Maps to satellite view.
    navSatelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles © Esri',
      maxZoom: 19
    });
    // The whole map gets torn down and rebuilt from scratch every time
    // Navigatore is (re-)opened — always defaulting back to street tiles
    // regardless of navShowingSatellite would silently reset the view
    // (and desync it from the satellite button's own "on" state) every
    // single time. Add whichever one actually matches the current mode.
    (navShowingSatellite ? navSatelliteLayer : navStreetLayer).addTo(navMap);
    navMap.on('click', function (e) {
      if (navPickingWaypointId) handleNavMapPick(e.latlng);
    });
    // Re-drop markers for any waypoints already resolved from an earlier
    // visit to this screen (the map itself is fresh, but the trip plan
    // persists). Uses the lightweight icon-only refresh (not the full
    // dropNavWaypointMarker) so the map doesn't visibly jump from one
    // waypoint to the next while restoring several at once — instead,
    // it fits the view to all of them together, once, at the end.
    var resolvedForBounds = [];
    navWaypoints.forEach(function (wp) {
      if (wp.point) { refreshNavWaypointMarkerIcon(wp.id, wp.point); resolvedForBounds.push([wp.point.lat, wp.point.lon]); }
    });
    if (resolvedForBounds.length === 1) {
      navMap.setView(resolvedForBounds[0], 11);
    } else if (resolvedForBounds.length > 1) {
      navMap.fitBounds(L.latLngBounds(resolvedForBounds), { padding: [32, 32] });
    }
    if (resolvedForBounds.length > 1) updateLiveRoutePreview();
  }

  var navShowingSatellite = false;
  function toggleNavSatelliteView() {
    if (!navMap || !navStreetLayer || !navSatelliteLayer) return;
    navShowingSatellite = !navShowingSatellite;
    if (navShowingSatellite) { navMap.removeLayer(navStreetLayer); navSatelliteLayer.addTo(navMap); }
    else { navMap.removeLayer(navSatelliteLayer); navStreetLayer.addTo(navMap); }
    // Both satellite buttons (the one shown before navigation starts,
    // and the separate one inside the active-navigation overlay) stay
    // in sync, whichever is currently visible — previously neither
    // ever showed whether satellite view was actually on, only the map
    // itself changing gave any indication.
    ['nav-layers-btn', 'nav-active-layers-btn'].forEach(function (id) {
      var btn = document.getElementById(id);
      if (btn) btn.classList.toggle('on', navShowingSatellite);
    });
  }

  // Tapping the pin (📍) button next to a waypoint field arms "pick from
  // map" mode for it — the next tap anywhere on the map sets that exact
  // point, reverse-geocoded into a readable address for the field, same
  // as dropping a pin in Google Maps.
  var navPickingWaypointId = null;
  function startNavMapPicking(waypointId) {
    navPickingWaypointId = waypointId;
    var mapEl = document.getElementById('nav-map');
    if (mapEl) mapEl.classList.add('picking');
    // Close the search panel first — it sits on top of the map (needed
    // for the fields themselves), but would otherwise block the exact
    // spot the person is trying to tap, right when they need the whole
    // map visible to choose a point.
    document.getElementById('nav-search-panel').style.display = 'none';
    document.getElementById('nav-search-bar').style.display = 'flex';
    toast('Tocca la mappa per scegliere il punto');
  }

  function handleNavMapPick(latlng) {
    var waypointId = navPickingWaypointId;
    navPickingWaypointId = null;
    var mapEl = document.getElementById('nav-map');
    if (mapEl) mapEl.classList.remove('picking');
    document.getElementById('nav-search-panel').style.display = 'block'; // back to filling in the rest of the trip, now that the point is chosen
    var point = { lon: latlng.lng, lat: latlng.lat, label: null };
    var input = document.getElementById('wpinput-' + waypointId);
    if (input) input.value = 'Ricerca indirizzo…';
    var wp = navWaypoints.filter(function (w) { return w.id === waypointId; })[0];
    if (wp) { wp.point = point; }
    dropNavWaypointMarker(waypointId, point);

    // Best-effort reverse geocoding, just to show a readable label — the
    // point itself is already set and usable even if this fails or is
    // slow (offline, rate-limited, etc.).
    fetch('https://api.openrouteservice.org/geocode/reverse?api_key=' + encodeURIComponent(ORS_API_KEY) + '&point.lon=' + latlng.lng + '&point.lat=' + latlng.lat + '&size=1')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var label = (data.features && data.features[0] && data.features[0].properties.label) || (latlng.lat.toFixed(5) + ', ' + latlng.lng.toFixed(5));
        if (wp) wp.text = label;
        if (input) input.value = label;
      })
      .catch(function () {
        var fallback = latlng.lat.toFixed(5) + ', ' + latlng.lng.toFixed(5);
        if (wp) wp.text = fallback;
        if (input) input.value = fallback;
      });
  }

  // The waypoints for this trip, in order — always at least 2 (Partenza,
  // Destinazione), with any number of stops insertable in between. No
  // artificial cap on how many. Each one carries its own map marker,
  // dropped the moment a real place is picked — same as Google Maps.
  var navWaypoints = [
    { id: 'wp0', role: 'origin', text: '', point: null },
    { id: 'wp1', role: 'dest', text: '', point: null }
  ];
  var navWaypointCounter = 2;
  var navWaypointMarkers = {}; // id -> Leaflet marker

  function navWaypointLabel(wp, idx) {
    if (wp.role === 'origin') return 'Partenza';
    if (wp.role === 'dest') {
      // "Destinazione" only makes sense when the trip is a plain
      // origin→destination with nothing in between — once real stops
      // exist, the last point is just the final stop in that sequence,
      // same as how Google Maps numbers every waypoint through to the
      // end rather than singling out a "destination" once there's a
      // real multi-stop itinerary.
      var hasStops = navWaypoints.some(function (w) { return w.role === 'stop'; });
      return hasStops ? 'Tappa ' + idx : 'Destinazione';
    }
    return 'Tappa ' + idx;
  }

  function renderNavWaypointsList() {
    var container = document.getElementById('nav-waypoints-list');
    if (!container) return;
    var stopNumber = 0;
    var html = navWaypoints.map(function (wp, i) {
      if (wp.role === 'stop') stopNumber++;
      var label = navWaypointLabel(wp, wp.role === 'dest' ? stopNumber + 1 : stopNumber);
      var placeholder = wp.role === 'origin' ? 'Indirizzo, CAP, civico — o lascia vuoto per la posizione attuale' : 'Indirizzo, CAP o numero civico';
      // The X to remove a row now shows on any real stop, AND on the
      // final destination itself as long as there's at least one stop
      // before it to fall back to — this is exactly "undo Aggiungi
      // tappa": removing the just-added (still empty) destination
      // slot un-does adding it, and the stop right before it quietly
      // becomes the destination again (see removeNavWaypoint). Origin
      // never gets a remove button, and neither does the destination
      // when it's the only real point left (Partenza + Destinazione)
      // — there always has to be a destination.
      var canRemove = wp.role === 'stop' || (wp.role === 'dest' && navWaypoints.length > 2);
      var removeBtn = canRemove ? '<button type="button" class="nav-wp-remove" data-remove="' + wp.id + '">✕</button>' : '';
      // Reordering: a stop can move up unless the thing right above it
      // is the origin (always first), and down unless the thing right
      // below it is the destination (always last) — matches how Google
      // Maps keeps start/end fixed while letting stops be reordered.
      // A real drag handle (⠿) instead of small tap-to-move arrows —
      // matches how Google Maps itself lets you reorder stops, by
      // grabbing and dragging a row, rather than tapping tiny buttons.
      var reorderBtns = wp.role === 'stop'
        ? '<div class="nav-wp-drag-handle" data-drag-handle="' + wp.id + '">⠿</div>'
        : '<div class="nav-wp-drag-spacer"></div>';
      return '<div class="nav-wp-row" data-wp-row="' + wp.id + '">' +
        reorderBtns +
        '<div class="field autocomplete-wrap" style="flex:1;margin-bottom:8px;">' +
        '<label>' + label + '</label>' +
        '<input type="text" id="wpinput-' + wp.id + '" value="' + escapeHtml(wp.text) + '" placeholder="' + placeholder + '" autocomplete="off">' +
        '<button type="button" class="ac-clear-btn" id="wpclear-' + wp.id + '" aria-label="Cancella">✕</button>' +
        '<div class="ac-list" id="wpac-' + wp.id + '"></div>' +
        '</div>' +
        '<button type="button" class="nav-wp-pin" data-pin="' + wp.id + '" aria-label="Scegli sulla mappa">📍</button>' +
        removeBtn +
        '</div>';
    }).join('');
    container.innerHTML = html;

    navWaypoints.forEach(function (wp) {
      wireNavAddressAutocomplete(wp.id);
      wireNavClearButton(
        document.getElementById('wpinput-' + wp.id),
        document.getElementById('wpclear-' + wp.id),
        function () { clearNavWaypointField(wp.id); }
      );
    });
    container.querySelectorAll('[data-remove]').forEach(function (btn) {
      btn.addEventListener('click', function () { removeNavWaypoint(btn.getAttribute('data-remove')); });
    });
    container.querySelectorAll('[data-drag-handle]').forEach(function (handle) {
      wireNavWaypointDrag(handle);
    });
    container.querySelectorAll('[data-pin]').forEach(function (btn) {
      btn.addEventListener('click', function () { startNavMapPicking(btn.getAttribute('data-pin')); });
    });
  }

  // Small "×" inside the field itself to instantly empty an address —
  // separate from the ✕ next to a stop, which removes the whole row;
  // this only clears the text/point, same idea as the clear button
  // browsers put inside a search box.
  function wireNavClearButton(input, clearBtn, onClear) {
    if (!input || !clearBtn) return;
    function sync() { clearBtn.classList.toggle('show', input.value.trim().length > 0); }
    sync();
    input.addEventListener('input', sync);
    clearBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      input.value = '';
      sync();
      onClear();
      input.focus();
    });
  }

  function clearNavWaypointField(waypointId) {
    var wp = navWaypoints.filter(function (w) { return w.id === waypointId; })[0];
    if (wp) { wp.text = ''; wp.point = null; wp.useCurrentPosition = false; }
    var list = document.getElementById('wpac-' + waypointId);
    if (list) list.classList.remove('show');
    if (navWaypointMarkers[waypointId]) { navMap.removeLayer(navWaypointMarkers[waypointId]); delete navWaypointMarkers[waypointId]; }
    if (navRouteLayer) { navMap.removeLayer(navRouteLayer); navRouteLayer = null; }
  }

  // Casa/Lavoro chips, drawn above the waypoints list — tapping a chip
  // that's already set fills the destination straight away (same as
  // tapping "Casa" in Google Maps); tapping one that isn't set yet
  // opens the small "Indirizzi preferiti" sheet to configure it first.
  function renderNavShortcuts() {
    var row = document.getElementById('nav-shortcuts-row');
    if (!row) return;
    var hw = loadNavHomeWork();
    function chipHtml(kind, icon, label, entry) {
      var cls = entry ? 'nav-shortcut-chip' : 'nav-shortcut-chip unset';
      return '<button type="button" class="' + cls + '" data-shortcut="' + kind + '">' +
        '<span class="icon">' + icon + '</span><span>' + (entry ? label : label + ' —') + '</span></button>';
    }
    row.innerHTML =
      chipHtml('home', '🏠', 'Casa', hw.home) +
      chipHtml('work', '💼', 'Lavoro', hw.work) +
      '<button type="button" class="nav-shortcut-edit-btn" id="nav-shortcut-edit-btn" aria-label="Modifica indirizzi preferiti">✎</button>';
    row.querySelectorAll('[data-shortcut]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var kind = btn.getAttribute('data-shortcut');
        var entry = hw[kind];
        if (entry) { fillNavDestinationWithEntry(entry); }
        else { openNavHomeWorkModal(); }
      });
    });
    var editBtn = document.getElementById('nav-shortcut-edit-btn');
    if (editBtn) editBtn.addEventListener('click', openNavHomeWorkModal);
  }

  // Fills the last waypoint (always the trip's final destination) with
  // a saved Casa/Lavoro entry and updates the map/preview — the same
  // handling already used when picking a frequent or searched address.
  function fillNavDestinationWithEntry(entry) {
    var destWp = navWaypoints[navWaypoints.length - 1];
    var point = { lon: entry.lon, lat: entry.lat, label: entry.text };
    destWp.text = entry.text;
    destWp.point = point;
    destWp.useCurrentPosition = false;
    var input = document.getElementById('wpinput-' + destWp.id);
    if (input) input.value = entry.text;
    dropNavWaypointMarker(destWp.id, point);
  }

  function openNavHomeWorkModal() {
    var hw = loadNavHomeWork();
    var homeInput = document.getElementById('hw-home-input');
    var workInput = document.getElementById('hw-work-input');
    homeInput.value = hw.home ? hw.home.text : '';
    workInput.value = hw.work ? hw.work.text : '';
    var pickedHome = hw.home, pickedWork = hw.work;
    var setPickedHome = function (entry) { pickedHome = entry; };
    var setPickedWork = function (entry) { pickedWork = entry; };
    wireNavHomeWorkField(homeInput, document.getElementById('hw-home-ac'), setPickedHome);
    wireNavHomeWorkField(workInput, document.getElementById('hw-work-ac'), setPickedWork);
    wireNavClearButton(homeInput, document.getElementById('hw-home-clear'), function () { setPickedHome(null); document.getElementById('hw-home-ac').classList.remove('show'); });
    wireNavClearButton(workInput, document.getElementById('hw-work-clear'), function () { setPickedWork(null); document.getElementById('hw-work-ac').classList.remove('show'); });
    document.getElementById('modal-nav-homework').classList.add('open');
    document.getElementById('nav-homework-close-x').onclick = function () {
      document.getElementById('modal-nav-homework').classList.remove('open');
    };
    document.getElementById('nav-homework-save').onclick = function () {
      // If the field still matches what was typed for a resolved pick,
      // keep it; if the person cleared the field, that address is
      // removed instead of keeping a stale saved point.
      if (!homeInput.value.trim()) pickedHome = null;
      if (!workInput.value.trim()) pickedWork = null;
      saveNavHomeWork({ home: pickedHome, work: pickedWork });
      renderNavShortcuts();
      document.getElementById('modal-nav-homework').classList.remove('open');
      toast('Indirizzi salvati');
    };
  }

  // A small, self-contained ORS geocoding autocomplete for the
  // Casa/Lavoro fields — deliberately separate from
  // wireNavAddressAutocomplete (which is tightly bound to navWaypoints)
  // to avoid touching that already-working code.
  function wireNavHomeWorkField(input, list, onPick) {
    var debounceTimer = null;

    function renderCurrentPosOption() {
      list.innerHTML = '<div class="ac-item ac-frequent ac-current-pos" data-current-pos="1"><span class="ac-freq-icon">📍</span><span class="name">La tua posizione</span></div>';
      list.classList.add('show');
      list.querySelector('[data-current-pos]').addEventListener('click', function () {
        list.classList.remove('show');
        currentPosition().then(function (p) {
          input.value = 'La tua posizione';
          onPick({ text: 'La tua posizione', lon: p.lon, lat: p.lat });
        }).catch(function () { toast('Posizione non disponibile'); });
      });
    }

    // Same as any other address field now — "La tua posizione" is
    // offered the moment an empty Casa/Lavoro field is focused, not
    // just when typing an actual address.
    input.addEventListener('focus', function () {
      if (!input.value.trim()) renderCurrentPosOption();
    });

    input.oninput = function () {
      onPick(null); // typing invalidates whatever was picked before, until a suggestion is chosen again
      clearTimeout(debounceTimer);
      var text = input.value;
      if (!text.trim()) { renderCurrentPosOption(); return; }
      if (text.trim().length < 3) { list.classList.remove('show'); return; }
      debounceTimer = setTimeout(function () {
        navGeocodeFetch('autocomplete', text)
          .then(function (data) {
            var features = data.features || [];
            list.innerHTML = features.map(function (f, i) {
              var p = f.properties;
              if (p.layer === 'venue' && p.name && p.name !== p.label) {
                var secondary = [p.street, p.housenumber].filter(Boolean).join(' ') || [p.locality, p.region].filter(Boolean).join(', ');
                return '<div class="ac-item ac-two-line" data-idx="' + i + '"><span class="name">' + escapeHtml(p.name) + '</span>' +
                  (secondary ? '<span class="ac-secondary">' + escapeHtml(secondary) + '</span>' : '') + '</div>';
              }
              return '<div class="ac-item" data-idx="' + i + '"><span class="name">' + escapeHtml(p.label) + '</span></div>';
            }).join('');
            list.classList.toggle('show', features.length > 0);
            list.querySelectorAll('[data-idx]').forEach(function (item) {
              item.addEventListener('click', function () {
                var f = features[Number(item.getAttribute('data-idx'))];
                input.value = f.properties.label;
                list.classList.remove('show');
                onPick({ text: f.properties.label, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] });
              });
            });
          })
          .catch(function () { /* offline or blocked — the person can still save once a suggestion loads */ });
      }, 350);
    };
    document.addEventListener('click', function (e) {
      if (!list.contains(e.target) && e.target !== input) list.classList.remove('show');
    });
  }

  // "Aggiungi tappa" always adds the NEW EMPTY field at the very END —
  // whatever was already the destination (address, point, marker) just
  // becomes the next intermediate stop, keeping everything it already
  // had, and a fresh empty field becomes the new final destination to
  // fill in. Doing it again repeats the same shift: the field just
  // filled becomes another stop, a new empty one appears after it —
  // exactly the ordering Google Maps itself uses when you add a stop.
  function addNavWaypointBeforeDest() {
    var oldDest = navWaypoints[navWaypoints.length - 1];
    oldDest.role = 'stop';
    var newId = 'wp' + (navWaypointCounter++);
    navWaypoints.push({ id: newId, role: 'dest', text: '', point: null });
    // Redraws oldDest's own marker right away so its icon/label on the
    // map reflects "now a numbered stop" immediately, rather than
    // waiting for the next "Calcola percorso" to catch up.
    if (oldDest.point) dropNavWaypointMarker(oldDest.id, oldDest.point);
    renderNavWaypointsList();
  }

  function removeNavWaypoint(id) {
    navWaypoints = navWaypoints.filter(function (wp) { return wp.id !== id; });
    if (navWaypointMarkers[id]) { navMap.removeLayer(navWaypointMarkers[id]); delete navWaypointMarkers[id]; }
    // If the destination itself was the one removed, the new last item
    // (whatever was the stop right before it) needs to become the
    // destination in its place — there always has to be exactly one,
    // and it's always the last item.
    var newLast = navWaypoints[navWaypoints.length - 1];
    if (newLast && newLast.role !== 'dest') newLast.role = 'dest';
    // Every stop AFTER the removed one shifts down a number (what was
    // "Tappa 3" becomes "Tappa 2", etc.) — same underlying issue as the
    // drag-reorder fix: refreshing every marker icon here, not just the
    // promoted destination, keeps every number on the map matching
    // what's actually being routed, instead of showing stale numbers
    // that no longer match the real order.
    navWaypoints.forEach(function (w) {
      if (w.point) refreshNavWaypointMarkerIcon(w.id, w.point);
    });
    updateLiveRoutePreview();
    renderNavWaypointsList();
  }

  // Real drag-to-reorder for stops — grabbing the handle (⠿) and
  // dragging up or down swaps it past whichever stop it's currently
  // over, live, the same interaction Google Maps itself uses. Pointer
  // events (not HTML5 drag-and-drop, which is mouse-oriented) work
  // consistently for a real finger on a touchscreen.
  function wireNavWaypointDrag(handle) {
    var waypointId = handle.getAttribute('data-drag-handle');
    handle.addEventListener('pointerdown', function (startEvent) {
      startEvent.preventDefault();
      var container = document.getElementById('nav-waypoints-list');
      var row = handle.closest('.nav-wp-row');
      row.classList.add('nav-wp-dragging');
      handle.setPointerCapture(startEvent.pointerId);

      function onMove(moveEvent) {
        var overEl = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
        var overRow = overEl && overEl.closest('.nav-wp-row');
        if (!overRow || overRow === row) return;
        var overId = overRow.getAttribute('data-wp-row');
        var overWp = navWaypoints.filter(function (w) { return w.id === overId; })[0];
        if (!overWp || overWp.role !== 'stop') return; // only ever swaps with another real stop — origin/destination stay fixed
        var fromIdx = navWaypoints.findIndex(function (w) { return w.id === waypointId; });
        var toIdx = navWaypoints.findIndex(function (w) { return w.id === overId; });
        if (fromIdx === -1 || toIdx === -1) return;
        var moved = navWaypoints.splice(fromIdx, 1)[0];
        navWaypoints.splice(toIdx, 0, moved);
        renderNavWaypointsList();
        // The text fields above already relabel themselves correctly
        // (Tappa 1/2/3) via renderNavWaypointsList — but the NUMBERED
        // MARKERS on the map itself were never being refreshed here,
        // so they kept showing the pre-drag numbers/positions after a
        // reorder. The route recalculates correctly for the new order
        // (updateLiveRoutePreview, on drag end, reads navWaypoints in
        // its real array order), but the stale marker numbers made it
        // look like the route was looping nonsensically — it wasn't;
        // the map just hadn't caught up to what order the stops were
        // actually in. refreshNavWaypointMarkerIcon recomputes each
        // marker's correct number from the CURRENT navWaypoints order
        // without recentring the map or opening a popup for each one —
        // just the icon itself, so this stays smooth mid-drag.
        navWaypoints.forEach(function (w) {
          if (w.point) refreshNavWaypointMarkerIcon(w.id, w.point);
        });
        // Re-wiring the list just replaced this row — reattach dragging
        // state to the same logical stop so the gesture continues
        // smoothly instead of ending abruptly mid-drag.
        var newHandle = document.querySelector('[data-drag-handle="' + waypointId + '"]');
        if (newHandle) {
          newHandle.closest('.nav-wp-row').classList.add('nav-wp-dragging');
          try { newHandle.setPointerCapture(moveEvent.pointerId); } catch (e) { /* already captured elsewhere mid-gesture — fine to ignore */ }
        }
      }
      function onUp() {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.querySelectorAll('.nav-wp-dragging').forEach(function (el) { el.classList.remove('nav-wp-dragging'); });
        updateLiveRoutePreview();
      }
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
  }

  // Live address suggestions as the person types (ORS's own geocoding
  // autocomplete, debounced so it doesn't fire on every keystroke), plus
  // an immediate marker on the map for whichever waypoint is picked.
  function wireNavAddressAutocomplete(waypointId) {
    var input = document.getElementById('wpinput-' + waypointId);
    var list = document.getElementById('wpac-' + waypointId);
    if (!input || !list) return;
    var debounceTimer = null;

    // Focusing an EMPTY field immediately offers the most-used
    // addresses — same idea as Chrome showing frequent sites the moment
    // you click an empty address bar, before typing anything.
    input.addEventListener('focus', function () {
      if (!input.value.trim()) renderNavSuggestions([], list, input, waypointId, loadNavFrequent());
    });

    input.addEventListener('input', function () {
      var wp = navWaypoints.filter(function (w) { return w.id === waypointId; })[0];
      if (wp) { wp.text = input.value; wp.point = null; }
      clearTimeout(debounceTimer);
      var text = input.value;
      if (!text.trim()) { renderNavSuggestions([], list, input, waypointId, loadNavFrequent()); return; }
      // Frequent addresses matching what's typed so far show immediately
      // (no network round-trip needed for those) — live geocoding
      // results, once they arrive, are appended after.
      var matchingFrequent = loadNavFrequent().filter(function (e) {
        return e.text.toLowerCase().indexOf(text.toLowerCase()) !== -1;
      });
      renderNavSuggestions([], list, input, waypointId, matchingFrequent);
      if (text.trim().length < 3) return;
      debounceTimer = setTimeout(function () {
        navGeocodeFetch('autocomplete', text)
          .then(function (data) { renderNavSuggestions(data.features || [], list, input, waypointId, matchingFrequent); })
          .catch(function () { /* offline or blocked — the frequent matches (if any) are still shown */ });
      }, 350);
    });
    document.addEventListener('click', function (e) {
      if (!list.contains(e.target) && e.target !== input) list.classList.remove('show');
    });
  }

  function renderNavSuggestions(features, list, input, waypointId, frequentEntries) {
    frequentEntries = frequentEntries || [];
    var wp = navWaypoints.filter(function (w) { return w.id === waypointId; })[0];
    // "La tua posizione" is offered on every field now, not just
    // Partenza — a driver might just as well want "where I am right
    // now" as a stop or even (rarely, but why not) as the destination,
    // same flexibility Google Maps itself allows on any field.
    var showCurrentPositionOption = !!wp;
    if (!features.length && !frequentEntries.length && !showCurrentPositionOption) { list.classList.remove('show'); return; }
    var html = '';
    if (showCurrentPositionOption) {
      html += '<div class="ac-item ac-frequent ac-current-pos" data-current-pos="1"><span class="ac-freq-icon">📍</span><span class="name">La tua posizione</span></div>';
    }
    html += frequentEntries.map(function (e, i) {
      return '<div class="ac-item ac-frequent" data-freq="' + i + '"><span class="ac-freq-icon">🕐</span><span class="name">' + escapeHtml(e.text) + '</span></div>';
    }).join('');
    html += features.map(function (f, i) {
      var p = f.properties;
      // Businesses/POIs ("venue" layer) get a two-line look — bold name
      // on top, address in smaller grey text below — same as Google's
      // own search results. Plain street/address matches stay one line,
      // since the full label already reads naturally on its own.
      if (p.layer === 'venue' && p.name && p.name !== p.label) {
        var secondary = [p.street, p.housenumber].filter(Boolean).join(' ') || [p.locality, p.region].filter(Boolean).join(', ');
        return '<div class="ac-item ac-two-line" data-idx="' + i + '"><span class="name">' + escapeHtml(p.name) + '</span>' +
          (secondary ? '<span class="ac-secondary">' + escapeHtml(secondary) + '</span>' : '') + '</div>';
      }
      return '<div class="ac-item" data-idx="' + i + '"><span class="name">' + escapeHtml(p.label) + '</span></div>';
    }).join('');
    list.innerHTML = html;
    list.classList.add('show');
    var currentPosItem = list.querySelector('[data-current-pos]');
    if (currentPosItem) {
      currentPosItem.addEventListener('click', function () {
        input.value = 'La tua posizione';
        list.classList.remove('show');
        if (wp) { wp.text = 'La tua posizione'; wp.point = null; wp.useCurrentPosition = true; }
        currentPosition().then(function (p) { dropNavWaypointMarker(waypointId, p); if (wp) wp.point = p; }).catch(function () { /* resolved again, freshly, at calc time */ });
      });
    }
    list.querySelectorAll('[data-freq]').forEach(function (item) {
      item.addEventListener('click', function () {
        var e = frequentEntries[Number(item.getAttribute('data-freq'))];
        var point = { lon: e.lon, lat: e.lat, label: e.text };
        input.value = e.text;
        list.classList.remove('show');
        var wp = navWaypoints.filter(function (w) { return w.id === waypointId; })[0];
        if (wp) { wp.text = e.text; wp.point = point; wp.useCurrentPosition = false; }
        dropNavWaypointMarker(waypointId, point);
      });
    });
    list.querySelectorAll('[data-idx]').forEach(function (item) {
      item.addEventListener('click', function () {
        var f = features[Number(item.getAttribute('data-idx'))];
        var point = { lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], label: f.properties.label };
        input.value = f.properties.label;
        list.classList.remove('show');
        var wp = navWaypoints.filter(function (w) { return w.id === waypointId; })[0];
        if (wp) { wp.text = f.properties.label; wp.point = point; wp.useCurrentPosition = false; }
        dropNavWaypointMarker(waypointId, point);
      });
    });
  }

  function dropNavWaypointMarker(waypointId, point) {
    if (!navMap) return;
    var marker = refreshNavWaypointMarkerIcon(waypointId, point);
    if (marker) marker.openPopup();
    navMap.setView([point.lat, point.lon], 11);
    updateLiveRoutePreview();
  }

  // Just the marker icon itself (correct number, correct pin style for
  // its role) — no recentring, no live-preview trigger, no popup
  // opened. Used when refreshing MULTIPLE markers at once (after a
  // reorder or a removal shifts everyone's numbers) so the map doesn't
  // visibly jump from waypoint to waypoint, or pop open several
  // bubbles at once; the caller recentres/refreshes once, after the
  // whole batch, instead. dropNavWaypointMarker (above) still does the
  // full version for the single-waypoint case (a fresh pick from
  // autocomplete or the map) where snapping the view to it, and
  // showing its label, is exactly what's wanted.
  function refreshNavWaypointMarkerIcon(waypointId, point) {
    if (!navMap) return null;
    var wp = navWaypoints.filter(function (w) { return w.id === waypointId; })[0];
    var stopNumber = navWaypoints.filter(function (w) { return w.role === 'stop' && navWaypoints.indexOf(w) <= navWaypoints.indexOf(wp); }).length;
    var hasStops = navWaypoints.some(function (w) { return w.role === 'stop'; });
    if (navWaypointMarkers[waypointId]) navMap.removeLayer(navWaypointMarkers[waypointId]);
    var marker = L.marker([point.lat, point.lon], { icon: navNumberedMarkerIcon(wp, stopNumber, hasStops) }).addTo(navMap).bindPopup(navWaypointLabel(wp, stopNumber));
    navWaypointMarkers[waypointId] = marker;
    return marker;
  }

  // Draws the real, road-following path on the map the moment there are
  // at least two resolved points — updating live as stops are added or
  // picked, same as Google Maps does while building a trip, instead of
  // waiting for an explicit "Calcola percorso" tap. Debounced, since
  // picking several stops in quick succession would otherwise fire one
  // request per point.
  var liveRoutePreviewTimer = null;
  function updateLiveRoutePreview() {
    clearTimeout(liveRoutePreviewTimer);
    liveRoutePreviewTimer = setTimeout(function () {
      if (!ORS_API_KEY || !vehicleIsConfigured(state.vehicle)) return;
      var resolvedPoints = navWaypoints.map(function (wp) { return wp.point; }).filter(Boolean);
      if (resolvedPoints.length < 2) return;
      computeMultiStopRoute(resolvedPoints)
        .then(function (result) {
          // A live preview just draws the line — no stats panel, no
          // alternative-route buttons, so it doesn't fight with
          // whatever's already shown from a previous "Calcola percorso".
          var feature = result.alternatives[0];
          if (navRouteLayer) navMap.removeLayer(navRouteLayer);
          navRouteLayer = L.geoJSON(feature, { style: { color: '#E8542B', weight: 4, opacity: 0.75, dashArray: '2 6' } }).addTo(navMap);
        })
        .catch(function () { /* offline, out of quota, or not enough info yet — the markers alone are still useful */ });
    }, 600);
  }

  // Builds a Pelias/ORS geocoding URL with the parameters that actually
  // matter for finding real addresses reliably in Italy:
  //  - boundary.country=ITA: keeps results to Italy, so a generic
  //    street name doesn't compete with identical ones abroad.
  //  - layers=address,venue,street,locality (unless opts.noLayers):
  //    explicitly includes the "address" layer (exact civic numbers)
  //    and "venue" layer (businesses/POIs). Pelias silently EXCLUDES
  //    the address layer on short/ambiguous queries as a performance
  //    optimization unless it's asked for explicitly.
  //  - opts.venueOnly: restricts to ONLY the venue (business) layer —
  //    used as a last-resort retry for a "business name + town name"
  //    query typed as one string with no comma. Pelias's own parser
  //    can end up favoring a locality/street interpretation of that
  //    combined text over the business-name one; asking for venue
  //    results exclusively forces it to match on the name instead.
  //  - focus.point.*: a SOFT bias toward the driver's current GPS
  //    position — nudges genuinely close results upward without ever
  //    hiding a clearly better match just because it's far away.
  //    Deliberately NOT combined with boundary.circle (a hard distance
  //    filter) here — that was tried and caused a real bug: searching
  //    for the actual city of "Trieste" returned "Via Trieste,
  //    Villatora" instead, a same-named LOCAL STREET, because the hard
  //    filter excluded the real, far-away city before Pelias's own
  //    text relevance ever got to correctly prefer the exact match.
  function navGeocodeUrl(endpoint, text, opts) {
    opts = opts || {};
    var url = 'https://api.openrouteservice.org/geocode/' + endpoint + '?api_key=' + encodeURIComponent(ORS_API_KEY) +
      '&text=' + encodeURIComponent(text) + '&size=8' +
      '&boundary.country=ITA';
    if (opts.venueOnly) url += '&layers=venue';
    else if (!opts.noLayers) url += '&layers=address,venue,street,locality';
    if (navSearchFocusPoint) {
      url += '&focus.point.lat=' + navSearchFocusPoint.lat + '&focus.point.lon=' + navSearchFocusPoint.lon;
    }
    return url;
  }

  // A SOFT preference for nearby results (focus.point, always applied
  // automatically in navGeocodeUrl whenever the driver's position is
  // known) — not a hard restriction. An earlier version of this used
  // boundary.circle to hard-EXCLUDE anything outside 5km on the first
  // attempt, which caused a real, confirmed bug: searching for the
  // actual city of "Trieste" (120km+ away) returned "Via Trieste,
  // Villatora" instead — a LOCAL STREET that happens to share the
  // name — because the hard radius filter excluded the real city
  // entirely before Pelias's own text-relevance ranking ever got a
  // chance to correctly prefer the exact city match. A soft bias
  // doesn't have that failure mode: it still nudges genuinely
  // close-but-lower-relevance results upward (a nearby "tabaccheria"
  // over a distant one), without ever hiding a clearly better, exact
  // match just because it's far away.
  // NOTE: none of this can find a business that simply isn't in
  // OpenStreetMap yet (a very recently opened shop, in a small town
  // with few local contributors) — that's a real gap in the free data
  // itself, not something any query tuning can work around.
  function navGeocodeFetch(endpoint, text) {
    var attempts = [{}, { noLayers: true }];
    if (navSearchFocusPoint) attempts.push({ venueOnly: true }); // last resort: business-name-only, still softly biased nearby

    function tryNext(i) {
      if (i >= attempts.length) return Promise.resolve({ features: [] });
      return fetch(navGeocodeUrl(endpoint, text, attempts[i]))
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.features && data.features.length) return data;
          return tryNext(i + 1);
        })
        .catch(function () { return tryNext(i + 1); }); // this attempt failed outright (offline etc.) — still worth trying the next, less strict one
    }
    return tryNext(0);
  }

  function geocodeAddress(text) {
    if (!text || !text.trim()) return Promise.resolve(null);
    return navGeocodeFetch('search', text)
      .then(function (data) {
        if (!data.features || !data.features.length) return null;
        var coords = data.features[0].geometry.coordinates; // [lon, lat]
        return { lon: coords[0], lat: coords[1], label: data.features[0].properties.label };

      });
  }

  function currentPosition() {
    return new Promise(function (resolve, reject) {
      if (!navigator.geolocation) { reject(new Error('no geolocation')); return; }
      navigator.geolocation.getCurrentPosition(
        function (pos) { resolve({ lon: pos.coords.longitude, lat: pos.coords.latitude, label: 'Posizione attuale' }); },
        function (err) { reject(err); },
        // Matches the settings already proven reliable elsewhere in
        // the Navigator (requestNavLocationPermission, active-nav
        // watchPosition) — the previous version here used neither
        // enableHighAccuracy nor a realistic timeout, so it was
        // meaningfully more likely to fail (or silently take too long)
        // right when GPS genuinely needs a moment for a first fix —
        // most likely why "la mia posizione" felt broken.
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
      );
    });
  }

  // Actively asks for location permission the moment the Navigatore
  // screen opens — not waiting until "Avvia" is pressed — so the
  // phone's own permission prompt appears right away, and by the time
  // navigation is actually needed, it's already granted and ready to
  // use. Also drops a "you are here" marker as soon as it's confirmed,
  // so there's a clear, visible sign the permission worked.
  function requestNavLocationPermission() {
    if (!navigator.geolocation) {
      showNavLocationBanner('Il GPS non è disponibile su questo dispositivo — la navigazione richiede la posizione.');
      return;
    }
    showNavLocationBanner('Ricerca della posizione in corso…', true);
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        hideNavLocationBanner();
        navSearchFocusPoint = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        if (navMap) {
          var marker = L.circleMarker([pos.coords.latitude, pos.coords.longitude], {
            radius: 8, color: '#fff', weight: 3, fillColor: '#4285F4', fillOpacity: 1
          }).addTo(navMap);
          navMap.setView([pos.coords.latitude, pos.coords.longitude], 13);
          setTimeout(function () { if (navMap) navMap.removeLayer(marker); }, 4000); // just a brief confirmation the permission worked — the real live marker only appears once "Avvia" actually starts tracking
        }
      },
      function (err) {
        // code 1 = PERMISSION_DENIED, 2 = POSITION_UNAVAILABLE, 3 =
        // TIMEOUT — a GPS cold start (especially indoors, or the very
        // first time) can genuinely take longer than a few seconds, so
        // a timeout here isn't necessarily a permission problem, but
        // the person still deserves to see SOMETHING rather than
        // silence, so every case gets a clear, distinct message.
        if (err.code === 1) {
          showNavLocationBanner('Posizione bloccata per questo sito.', false, true);
        } else if (err.code === 3) {
          showNavLocationBanner('Ricerca della posizione ancora in corso — può richiedere più tempo la prima volta, specialmente al chiuso.');
        } else {
          showNavLocationBanner('Impossibile determinare la posizione al momento — riprova tra poco.');
        }
      },
      { timeout: 25000, enableHighAccuracy: true, maximumAge: 0 }
    );
  }

  function showNavLocationBanner(message, isLoading, showUnlockGuide) {
    var mapWrap = document.querySelector('.nav-map-wrap');
    if (!mapWrap) return;
    var existing = document.getElementById('nav-location-banner');
    if (existing) existing.remove();
    var banner = document.createElement('div');
    banner.id = 'nav-location-banner';
    banner.className = 'nav-location-banner' + (isLoading ? ' nav-location-banner-loading' : '');
    banner.textContent = message;
    if (showUnlockGuide) {
      var guideBtn = document.createElement('button');
      guideBtn.type = 'button';
      guideBtn.className = 'nav-unlock-guide-btn';
      guideBtn.textContent = 'Come sbloccarla →';
      guideBtn.addEventListener('click', openNavLocationUnlockGuide);
      banner.appendChild(guideBtn);
    }
    mapWrap.appendChild(banner);
  }

  // A site that's been denied once can't be re-prompted by any code on
  // any website — every browser blocks that deliberately. What actually
  // saves time here is skipping the hunting: platform-specific, exact
  // steps, shown the moment they're needed, so it's a couple of taps to
  // follow rather than a search through unfamiliar settings menus.
  function openNavLocationUnlockGuide() {
    var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    // Installed as a home-screen app (standalone) is a completely
    // different situation from a regular browser tab — Android treats
    // an installed PWA as its OWN app, with its own separate entry
    // (and its own separate Location permission) in the phone's own
    // Settings, nothing to do with Chrome's own address-bar icon,
    // which doesn't even exist in this mode (no visible address bar at
    // all). iOS home-screen apps, by contrast, still route their
    // permission through Safari's own settings.
    var steps;
    if (isStandaloneApp && !isIOS) {
      steps = [
        'Apri "Impostazioni" sul telefono.',
        'Tocca "App" (o "App e notifiche").',
        'Cerca e tocca "ADB Smart" nell\'elenco — è installata come una vera app.',
        'Tocca "Autorizzazioni" (o "Permessi").',
        'Tocca "Posizione" e scegli "Consenti".',
        'Torna qui e ricarica la pagina.'
      ];
    } else if (isIOS) {
      steps = [
        'Apri "Impostazioni" sul telefono (l\'app grigia con l\'ingranaggio).',
        'Scorri e tocca "Safari".',
        'Tocca "Posizione".',
        'Scegli "Consenti" (o "Chiedi").',
        'Torna qui e ricarica la pagina.'
      ];
    } else {
      steps = [
        'Tocca l\'icona 🔒 (o "ⓘ") accanto all\'indirizzo, in alto.',
        'Tocca "Autorizzazioni" o "Permessi".',
        'Tocca "Posizione".',
        'Scegli "Consenti".',
        'Torna qui e ricarica la pagina.'
      ];
    }
    var subLabel = isStandaloneApp && !isIOS ? 'App installata su Android' : (isIOS ? 'Su iPhone' : 'Su Android, nel browser');
    var html = '<div class="nav-unlock-modal-inner">';
    html += '<div class="modal-title">Sblocca la posizione</div>';
    html += '<div class="modal-sub">' + subLabel + ', in pochi passaggi:</div>';
    html += '<ol class="nav-unlock-steps">' + steps.map(function (s) { return '<li>' + escapeHtml(s) + '</li>'; }).join('') + '</ol>';
    html += '<button type="button" class="btn btn-accent btn-block" id="nav-unlock-guide-close">Ho capito</button>';
    html += '</div>';
    var modal = document.getElementById('modal-nav-unlock-guide');
    modal.innerHTML = html;
    modal.classList.add('open');
    document.getElementById('nav-unlock-guide-close').addEventListener('click', function () { modal.classList.remove('open'); });
  }
  function hideNavLocationBanner() {
    var existing = document.getElementById('nav-location-banner');
    if (existing) existing.remove();
  }

  // Straight-line distance (km) — good enough just to decide whether a
  // trip is likely to be under or over the ~100km limit the free public
  // OpenRouteService API enforces per single request (a hard server-side
  // cap, not something adjustable from this side).
  function haversineKm(a, b) {
    var R = 6371, toRad = function (d) { return d * Math.PI / 180; };
    var dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
    var s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  }

  function calculateNavRoute() {
    if (!ORS_API_KEY) {
      toast('Manca la chiave API di OpenRouteService — da configurare');
      return;
    }
    var v = state.vehicle;
    if (!vehicleIsConfigured(v)) {
      toast('Configura prima le dimensioni del veicolo');
      document.getElementById('modal-nav-vehicle').classList.add('open');
      return;
    }
    var destWp = navWaypoints[navWaypoints.length - 1];
    if (!destWp.text.trim()) { toast('Inserisci una destinazione'); return; }

    var btn = document.getElementById('nav-calc-btn');
    btn.disabled = true; btn.textContent = 'Calcolo in corso…';

    // Resolve every waypoint to a real point — prefer whatever was
    // actually picked from the suggestion list over re-geocoding
    // whatever text happens to be sitting in the field right now. The
    // very first one, left empty, falls back to the phone's current
    // position.
    var resolvePromises = navWaypoints.map(function (wp, i) {
      if (wp.point) return Promise.resolve(wp.point);
      if (wp.useCurrentPosition || (i === 0 && !wp.text.trim())) return currentPosition().catch(function () { return null; });
      return geocodeAddress(wp.text);
    });

    Promise.all(resolvePromises)
      .then(function (points) {
        var badIdx = points.indexOf(null);
        if (badIdx !== -1) {
          throw new Error(badIdx === 0 ? 'Impossibile trovare il punto di partenza' : 'Impossibile trovare "' + navWaypoints[badIdx].text + '"');
        }
        // A route was actually resolved and about to be requested — worth
        // remembering these addresses for next time, regardless of
        // whether the directions call itself succeeds afterward.
        points.forEach(function (p, i) { recordNavFrequentUse(p, navWaypoints[i] ? navWaypoints[i].text : null); });
        return computeMultiStopRoute(points);
      })
      .then(function (route) {
        displayNavRoute(route);
      })
      .catch(function (err) {
        console.error(err);
        toast(err.message || 'Impossibile calcolare il percorso');
      })
      .then(function () {
        btn.disabled = false; btn.textContent = 'Calcola percorso';
      });
  }

  var ORS_SEGMENT_LIMIT_KM = 95; // stays safely under the public API's ~100km hard cap per request

  // Resolves a route across EVERY waypoint the person added, in order —
  // not just origin/destination. Each consecutive pair is routed
  // separately (reusing the same >100km-safe chaining as a single long
  // leg), then every leg's geometry/distance/duration is stitched
  // together into one continuous route for display. Alternatives are
  // only meaningful for a plain two-point trip — with real stops in
  // between, there's one path that visits all of them in order.
  function computeMultiStopRoute(points) {
    if (points.length === 2) {
      return fetchTruckRoute(points[0], points[1]).then(function (result) {
        var alternatives = Array.isArray(result) ? result : result.alternatives;
        return { alternatives: alternatives, points: points, legs: [alternatives[0]] };
      });
    }
    var chain = Promise.resolve([]);
    for (var i = 0; i < points.length - 1; i++) {
      (function (from, to) {
        chain = chain.then(function (acc) {
          return fetchTruckRoute(from, to).then(function (result) {
            var alternatives = Array.isArray(result) ? result : result.alternatives;
            acc.push(alternatives[0]); // the primary route for this leg — no alternatives once there are real stops to honor in order
            return acc;
          });
        });
      })(points[i], points[i + 1]);
    }
    return chain.then(function (legFeatures) {
      // Kept as SEPARATE per-leg features (not merged into one line) —
      // this is what lets the map render the first, current leg more
      // vividly and the rest lighter, same as Google Maps distinguishes
      // "the stretch you're on now" from "what comes after".
      var merged = mergeRouteSegments(legFeatures.map(function (f) { return [f]; }), points[0], points[points.length - 1]);
      return { alternatives: merged.alternatives, points: points, legs: legFeatures };
    });
  }

  function fetchTruckRoute(origin, dest) {
    var straightLineKm = haversineKm(origin, dest);
    if (straightLineKm <= ORS_SEGMENT_LIMIT_KM) {
      return fetchTruckRouteSegment(origin, dest, true);
    }
    // Longer trip — the free public API refuses any single request whose
    // route exceeds ~100km, so break the trip into a chain of
    // intermediate stops (straight-line spaced, well under the limit),
    // route each leg separately, then stitch the pieces into one
    // continuous route on the map. Costs more API calls (counts against
    // the daily free quota) but is the only way to cover a real trucking
    // distance on the free tier.
    var legs = Math.ceil(straightLineKm / ORS_SEGMENT_LIMIT_KM);
    var waypoints = [origin];
    for (var i = 1; i < legs; i++) {
      var t = i / legs;
      waypoints.push({ lon: origin.lon + (dest.lon - origin.lon) * t, lat: origin.lat + (dest.lat - origin.lat) * t });
    }
    waypoints.push(dest);

    var chain = Promise.resolve([]);
    for (var j = 0; j < waypoints.length - 1; j++) {
      (function (from, to) {
        chain = chain.then(function (acc) {
          // Alternatives deliberately NEVER requested for any leg of a
          // chained long-haul route (matches the comment in
          // fetchTruckRouteSegment) — this used to pass `isLast` here
          // by mistake, which meant the FINAL leg of every multi-leg
          // trip silently asked for alternate routes anyway. ORS only
          // allows alternative_routes on a leg whose actual DRIVEN
          // distance (not straight-line) stays under 100km — real
          // roads curve, so a leg capped at 95km straight-line could
          // easily drive out past that limit, and ORS would reject the
          // whole request outright. That's very likely exactly what
          // happened on a long trip like Vilatora → Trieste: the last
          // leg tipped past the alternatives limit and the entire
          // chain failed with an error, instead of just that one leg
          // quietly not getting alternatives it was never supposed to
          // request in the first place.
          return fetchTruckRouteSegment(from, to, false).then(function (segment) { acc.push(segment); return acc; });
        });
      })(waypoints[j], waypoints[j + 1]);
    }
    return chain.then(function (segments) { return mergeRouteSegments(segments, origin, dest); });
  }

  function fetchTruckRouteSegment(origin, dest, requestAlternatives) {
    var v = state.vehicle;
    var restrictions = {
      height: Number(v.altezza) || undefined,
      width: Number(v.larghezza) || undefined,
      length: Number(v.lunghezza) || undefined,
      weight: Number(v.massa) || undefined
    };
    if (v.massaAssi) restrictions.axleload = Number(v.massaAssi);
    var body = {
      coordinates: [[origin.lon, origin.lat], [dest.lon, dest.lat]],
      // "fastest" (rather than "recommended") is the lever ORS actually
      // offers for genuinely favoring motorways/tangenziali/superstrade
      // when they save real time — recommended sometimes trades a
      // faster highway stretch for a marginally shorter secondary road.
      preference: 'fastest',
      language: 'it',
      options: { profile_params: { restrictions: restrictions } }
    };
    // Alternatives only requested for a short (single-segment) trip —
    // combining them with the multi-leg chain for long trips would
    // multiply requests and complicate stitching, for little real
    // benefit over a long haul. target_count: 3 is ORS's own documented
    // maximum on the free tier (openrouteservice.org/restrictions) —
    // asking for more would simply be rejected.
    if (requestAlternatives) {
      body.alternative_routes = { target_count: 3, weight_factor: 1.6, share_factor: 0.6 };
    }
    return fetch('https://api.openrouteservice.org/v2/directions/driving-hgv/geojson', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': ORS_API_KEY },
      body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (e) { throw new Error(e.error && e.error.message ? e.error.message : 'Errore nel calcolo del percorso'); });
      return r.json();
    }).then(function (geojson) {
      if (!geojson.features || !geojson.features.length) throw new Error('Nessun percorso trovato per questo veicolo');
      return geojson.features; // one feature per alternative, if any were requested
    });
  }

  // Combines the per-leg route segments of a long-distance trip into one
  // continuous route for display — sums distance/duration, concatenates
  // the line geometry in order, and merges any restriction warnings from
  // every leg.
  function mergeRouteSegments(segmentsList, origin, dest) {
    var allCoords = [];
    var totalDistance = 0, totalDuration = 0, allWarnings = [];
    segmentsList.forEach(function (features) {
      var f = features[0]; // primary route for each leg — alternatives aren't requested on long-haul legs
      totalDistance += f.properties.summary.distance;
      totalDuration += f.properties.summary.duration;
      (f.properties.warnings || []).forEach(function (w) { allWarnings.push(w.message); });
      var coords = f.geometry.coordinates;
      if (allCoords.length && coords.length) coords = coords.slice(1); // avoid a duplicated joint point between legs
      allCoords = allCoords.concat(coords);
    });
    var merged = {
      type: 'Feature',
      properties: { summary: { distance: totalDistance, duration: totalDuration }, warnings: allWarnings.map(function (m) { return { message: m }; }) },
      geometry: { type: 'LineString', coordinates: allCoords }
    };
    return { alternatives: [merged], origin: origin, dest: dest };
  }

  // ORS's own warning messages come back in English, even when
  // language:'it' is set for turn-by-turn instructions (that parameter
  // covers step-by-step directions, not these route-level notices). A
  // small, known-message translation table covers this — falling back
  // to a plain, still-useful Italian sentence for anything unrecognized,
  // rather than silently leaving English text on screen.
  var NAV_WARNING_TRANSLATIONS = {
    'There may be restrictions on some roads': 'Alcune strade potrebbero avere restrizioni non completamente verificate',
    'This route may contain roads which are not suitable for the chosen mode of transport': 'Questo percorso potrebbe includere strade non adatte al veicolo scelto',
    'This route contains steep hills, so please drive carefully': 'Il percorso include tratti in forte pendenza — guida con prudenza',
    'The distance of this route may be smaller than expected due to internal simplifications': 'La distanza indicata potrebbe essere leggermente approssimata'
  };
  function translateNavWarning(message) {
    return NAV_WARNING_TRANSLATIONS[message] || 'Attenzione: possibili restrizioni non completamente verificate su questo percorso';
  }

  function displayNavRoute(routeResult) {
    displayNavRouteChoice(routeResult.alternatives, routeResult.points, 0, routeResult.legs);
  }

  var navCurrentAlternatives = null, navCurrentPoints = null;
  // Draws the route with motorway/trunk/primary stretches (ORS's own
  // "State Road" classification — exactly autostrade, tangenziali,
  // superstrade) in a distinct highway color, the rest in the app's
  // usual accent — the same visual language Google Maps uses to make
  // its own highways stand out from ordinary streets. Falls back to a
  // single-color line when road-type data isn't available for this
  // particular route (e.g. a long, multi-leg trip, where that detail
  // isn't preserved across the merge).
  // One color rule, simple and consistent: the street being driven
  // RIGHT NOW is always a strong, clearly visible dark blue — no
  // exceptions for road type. Anything still ahead (the 2nd, 3rd…
  // stop of a multi-stop trip) is the same blue family, just lighter/
  // more transparent, so the two read as "same route, different
  // urgency" rather than two unrelated colors. The previous version
  // additionally colored ordinary roads orange (vs. blue highways),
  // which read as confusing/inconsistent — removed entirely.
  function drawColorCodedRoute(feature, lighter) {
    if (lighter) {
      return L.geoJSON(feature, { style: { color: '#8AB4F8', weight: 6, opacity: 0.7, lineCap: 'round', lineJoin: 'round' } });
    }
    return L.geoJSON(feature, { style: { color: '#1A73E8', weight: 8, lineCap: 'round', lineJoin: 'round' } });
  }

  function displayNavRouteChoice(alternatives, points, chosenIndex, legs) {
    navCurrentAlternatives = alternatives; navCurrentPoints = points;
    // The trip-planning panel (Partenza/Destinazione/Calcola percorso)
    // closes itself the moment a route is ready — otherwise it stays
    // open on top of the map, pushing the result (km/tempo/Avvia) out
    // of view and making it look like it needs a swipe up to reach.
    // With it closed, the search bar up top, the map with the route
    // drawn, and the result card at the bottom are all visible together
    // at once, same as Google Maps itself right after calculating.
    var panel = document.getElementById('nav-search-panel');
    if (panel) panel.style.display = 'none';
    var feature = alternatives[chosenIndex];
    var props = feature.properties.summary;
    var km = (props.distance / 1000).toFixed(1);
    var minutes = Math.round(props.duration / 60);
    var hours = Math.floor(minutes / 60);
    var mins = minutes % 60;
    var durationText = hours > 0 ? (hours + ' h ' + mins + ' min') : (mins + ' min');
    var warnings = (feature.properties.warnings || []).map(function (w) { return translateNavWarning(w.message); });

    var resultEl = document.getElementById('nav-result');
    var html = '<div class="nav-result-stats"><div><b>' + km + ' km</b><span>distanza</span></div><div><b>' + durationText + '</b><span>tempo stimato</span></div></div>';
    if (warnings.length) html += '<div class="nav-warning-box">⚠️ ' + warnings.join('<br>') + '</div>';
    if (alternatives.length > 1) {
      html += '<div class="nav-alt-row">';
      alternatives.forEach(function (alt, i) {
        var altKm = (alt.properties.summary.distance / 1000).toFixed(0);
        var altMin = Math.round(alt.properties.summary.duration / 60);
        html += '<button type="button" class="nav-alt-btn' + (i === chosenIndex ? ' active' : '') + '" data-alt="' + i + '">Percorso ' + (i + 1) + ' · ' + altKm + ' km · ' + altMin + ' min</button>';
      });
      html += '</div>';
    }
    html += '<button type="button" class="btn btn-accent btn-block nav-avvia-btn" id="nav-avvia-btn">▶ Avvia navigazione</button>';
    resultEl.innerHTML = html;
    resultEl.style.display = 'block';
    resultEl.querySelectorAll('.nav-alt-btn').forEach(function (btn) {
      btn.addEventListener('click', function () { displayNavRouteChoice(alternatives, points, Number(btn.getAttribute('data-alt')), legs); });
    });
    document.getElementById('nav-avvia-btn').addEventListener('click', function () { startActiveNavigation(feature, legs, points); });

    if (navRouteLayer) navMap.removeLayer(navRouteLayer);
    Object.keys(navWaypointMarkers).forEach(function (id) { navMap.removeLayer(navWaypointMarkers[id]); });
    navWaypointMarkers = {};

    // With real stops (more than one leg), draw each leg separately —
    // the first, current stretch a strong, visible dark blue,
    // everything after it a lighter shade of the same blue, same as
    // how Google Maps visually distinguishes "the road you're on now"
    // from the rest of a multi-stop trip. A simple origin→destination
    // trip (one leg) just uses the normal coloring.
    // Legs are added to the map in REVERSE order (future stops first,
    // current leg LAST) — Leaflet paints later-added layers on top, so
    // wherever the current street crosses one you'll drive later, the
    // one you're actually on right now stays clearly visible above it,
    // not hidden underneath.
    if (legs && legs.length > 1 && chosenIndex === 0) {
      navRouteLayer = L.featureGroup(); // needs getBounds() for the fitBounds call below — a plain layerGroup doesn't have it
      for (var li = legs.length - 1; li >= 0; li--) {
        var legLayer = (li === 0) ? drawColorCodedRoute(legs[li], false) : drawColorCodedRoute(legs[li], true);
        legLayer.addTo(navRouteLayer);
      }
      navRouteLayer.addTo(navMap);
    } else if (alternatives.length > 1) {
      // Every alternative gets drawn on the map at once, not just the
      // chosen one — the un-chosen ones a muted grey, UNDER the chosen
      // one (added last, so it paints on top and stays clearly
      // visible wherever routes overlap). Tapping a grey line switches
      // to it directly on the map, same as the "Percorso 2/3" buttons
      // below already do — just without needing to look away from the
      // map to find them.
      navRouteLayer = L.featureGroup();
      alternatives.forEach(function (alt, i) {
        if (i === chosenIndex) return;
        var altLayer = L.geoJSON(alt, { style: { color: '#9aa5b1', weight: 6, opacity: 0.85, lineCap: 'round', lineJoin: 'round' } });
        altLayer.on('click', function () { displayNavRouteChoice(alternatives, points, i, legs); });
        altLayer.addTo(navRouteLayer);
      });
      drawColorCodedRoute(feature).addTo(navRouteLayer);
      navRouteLayer.addTo(navMap);
    } else {
      navRouteLayer = drawColorCodedRoute(feature);
      navRouteLayer.addTo(navMap);
    }
    var stopNumber = 0;
    var hasStops = navWaypoints.some(function (w) { return w.role === 'stop'; });
    points.forEach(function (point, i) {
      var wp = navWaypoints[i];
      if (wp && wp.role === 'stop') stopNumber++;
      var displayNumber = wp && wp.role === 'dest' ? stopNumber + 1 : stopNumber;
      var label = !wp ? '' : navWaypointLabel(wp, displayNumber);
      var marker = L.marker([point.lat, point.lon], { icon: navNumberedMarkerIcon(wp, displayNumber, hasStops) }).addTo(navMap).bindPopup(label);
      if (wp) navWaypointMarkers[wp.id] = marker;
    });
    navMap.fitBounds(navRouteLayer.getBounds(), { padding: [24, 24] });
  }

  // Origin gets the same blue "current location" dot Google Maps uses
  // (from the SVG pack — a soft blue halo behind a solid dot), the
  // final destination gets the classic red teardrop pin (same pack),
  // and any real intermediate stop keeps the numbered circle badge —
  // exactly how Google Maps itself distinguishes "where you are",
  // "where you're headed", and "everything in between" on a multi-stop
  // trip, all legible at a glance directly on the map.
  function navNumberedMarkerIcon(wp, displayNumber, hasStops) {
    var isOrigin = wp && wp.role === 'origin';
    if (isOrigin) {
      return L.divIcon({
        className: 'nav-pin-origin',
        html: '<svg viewBox="0 0 60 60" width="26" height="26"><circle cx="30" cy="30" r="27" fill="#ffffff" stroke="#e4e8ef" stroke-width="2"/><circle cx="30" cy="30" r="10" fill="#6fa3ff"/><circle cx="30" cy="30" r="18" fill="#6fa3ff" fill-opacity="0.18"/></svg>',
        iconSize: [26, 26], iconAnchor: [13, 13]
      });
    }
    var isFinalDest = wp && wp.role === 'dest';
    if (isFinalDest) {
      return L.divIcon({
        className: 'nav-pin-destination',
        html: '<svg viewBox="0 0 72 96" width="34" height="45"><path d="M36 92s24-22 24-46a24 24 0 1 0-48 0c0 24 24 46 24 46z" fill="#e53935"/><circle cx="36" cy="44" r="10" fill="#ffffff"/></svg>',
        iconSize: [34, 45], iconAnchor: [17, 45]
      });
    }
    var showNumber = hasStops || (wp && wp.role === 'stop');
    var content = showNumber ? displayNumber : '';
    return L.divIcon({ className: 'nav-pin-numbered', html: '<div>' + content + '</div>', iconSize: [28, 28], iconAnchor: [14, 14] });
  }

  // Live, turn-by-turn active navigation — "Avvia navigazione" starts
  // tracking the phone's real position continuously, keeps the map
  // centered on it as it moves (same as Google Maps), and shows the
  // current turn instruction as a banner, advancing automatically as
  // each maneuver point is reached.
  var navWatchId = null;
  var navLegs = null, navLegPoints = null, navCurrentLegIndex = 0, navArrivalPromptShown = false;
  var navActiveSteps = null; // flattened list of {instruction, coordLat, coordLon, distanceFromStart}
  var navOffRouteCount = 0; // consecutive position updates where the driver is meaningfully off the current leg's line
  var navLastRerouteTime = 0; // Date.now() of the last recalculation — cooldown guard, see onActiveNavPosition
  var navRerouting = false; // guards against firing a second recalculation while one is already in flight
  var navActiveStepIndex = 0;
  var navPositionMarker = null;
  var navActiveFeature = null;

  // ORS's numeric maneuver "type" codes, mapped to a simple directional
  // glyph for the instruction banner.
  // Matches ORS's own documented instruction-type table exactly
  // (giscience.github.io/openrouteservice/.../instruction-types) — the
  // previous version of this had sharp turns falling back to plain
  // turn icons, roundabouts showing a U-turn icon, and the actual
  // U-turn type (9) not mapped at all.
  var NAV_TURN_ICONS = {
    0: 'nav-turn-left', 1: 'nav-turn-right',
    2: 'nav-sharp-left', 3: 'nav-sharp-right',
    4: 'nav-slight-left', 5: 'nav-slight-right',
    6: 'nav-straight',
    7: 'nav-roundabout-enter', 8: 'nav-roundabout-exit',
    9: 'nav-uturn',
    10: 'nav-finish', 11: 'nav-straight', // 11 = Depart — no dedicated icon exists; straight is the reasonable default for "you're setting off"
    12: 'nav-keep-left', 13: 'nav-keep-right'
  };

  // Shared between starting navigation fresh and recalculating
  // mid-trip (rerouteFromCurrentPosition) — flattens a route feature's
  // turn-by-turn segments into the simple {instruction, type, lat, lon}
  // list the instruction banner reads from.
  function buildNavActiveSteps(feature) {
    var coords = feature.geometry.coordinates; // [lon, lat] pairs along the whole route
    var segments = feature.properties.segments || [];
    var steps = [];
    segments.forEach(function (seg) {
      (seg.steps || []).forEach(function (step) {
        var wp = step.way_points[0];
        var c = coords[wp];
        if (c) steps.push({ instruction: step.instruction, type: step.type, lat: c[1], lon: c[0] });
      });
    });
    return steps;
  }

  function startActiveNavigation(feature, legs, points) {
    navActiveFeature = feature;
    navActiveSteps = buildNavActiveSteps(feature);
    navActiveStepIndex = 0;

    // Per-leg tracking, for a multi-stop trip — lets the map show
    // "the stretch you're on right now" fully colored (with its own
    // highway/road-type detail) and everything after it fainter, then
    // progressively drop each leg once its stop is reached and promote
    // the next one, exactly the visual language Google Maps uses.
    navLegs = legs || [feature];
    navLegPoints = points || null;
    navCurrentLegIndex = 0;
    navArrivalPromptShown = false;
    // Unconditional now (was only for multi-stop trips) — a plain
    // origin→destination trip needs the SAME progressive trimming as
    // it's driven, not just multi-stop trips. This uses drawActiveNavLegs
    // rather than the plain drawColorCodedRoute call from before
    // starting navigation, specifically because it's the one that knows
    // how to trim.
    drawActiveNavLegs();

    if (!navigator.geolocation) { toast('Il GPS non è disponibile su questo dispositivo'); return; }

    document.getElementById('nav-active-overlay').style.display = 'flex';
    document.getElementById('nav-search-bar').style.display = 'none';
    document.getElementById('nav-search-panel').style.display = 'none';
    document.getElementById('nav-result').style.display = 'none';
    // The pre-navigation floating buttons (satellite, "la mia
    // posizione") were never hidden here before — they stayed in the
    // DOM, absolutely positioned, right alongside the active-nav
    // overlay's own satellite/compass/speed/recenter buttons, visually
    // piling up together at the bottom of the screen.
    document.getElementById('nav-float-controls').style.display = 'none';
    document.querySelector('.nav-map-wrap').classList.add('nav-fullscreen');
    setTimeout(function () { if (navMap) navMap.invalidateSize(); }, 50);
    // Rotate into heading-up mode immediately on "Avvia" — not only
    // once the first GPS heading arrives, since heading can stay null
    // for a while if the vehicle hasn't started moving yet.
    rotateNavMapToHeading(0);
    // Zoom in close right away using a FRESH position fetch — this used
    // to jump straight to navSearchFocusPoint, which is only ever
    // captured ONCE, back when the Navigatore screen was first opened.
    // If any real time passed between opening the screen and actually
    // pressing "Avvia" — including having already started driving — that
    // cached position could be meaningfully stale (confirmed in
    // real-world testing: it showed the trip starting back at home,
    // even though the driver was already out on the road). A fresh,
    // high-accuracy read here avoids that; if it's slow or fails, the
    // very next watchPosition update (started right below) still
    // corrects the view with real, live data either way.
    currentPosition().then(function (p) {
      if (navMap) navMap.setView([p.lat, p.lon], 18, { animate: true });
    }).catch(function () { /* watchPosition below will catch up with a real fix shortly */ });

    updateActiveInstructionBanner();

    // Auto-follow starts on — the map re-centers on the driver as they
    // move. Dragging the map manually (checking to the side, looking
    // ahead at an upcoming junction) turns it off, same as Google Maps
    // — a "recenter" button then appears to turn it back on.
    navFollowingUser = true;
    document.getElementById('nav-recenter-btn').style.display = 'none';
    navMap.on('dragstart', navOnManualMapDrag);

    navWatchId = navigator.geolocation.watchPosition(
      onActiveNavPosition,
      function (err) {
        // Permission denied specifically — worth a clear message, since
        // silently doing nothing would leave the person staring at a
        // navigation screen that never shows their position. Any other
        // error (brief signal loss, timeout) just keeps the last known
        // instruction visible instead.
        if (err.code === 1) toast('Posizione non consentita — attiva l\'accesso alla posizione per navigare');
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 }
    );
  }

  // Fixed north-up map, no rotation at all — see the note on
  // initNavMap for why (a real, confirmed cascade of driving-time bugs
  // traced back to the rotation plugin, reverted). Since the map
  // itself no longer turns to match the direction of travel, the
  // position marker (the car icon) needs to rotate ON ITS OWN to show
  // which way it's actually facing — this is exactly what was missing
  // while the rotation plugin was active (the marker was deliberately
  // left non-rotating back then, relying on the map to do that job
  // instead) and is very likely why the car appeared to be "facing
  // sideways" while driving straight.
  var navLastHeading = 0;
  function rotateNavMapToHeading(heading) {
    if (heading != null && !isNaN(heading)) navLastHeading = heading;
    if (navPositionMarker) {
      var iconEl = navPositionMarker.getElement();
      var innerDiv = iconEl && iconEl.querySelector('div');
      if (innerDiv) innerDiv.style.transform = 'rotate(' + navLastHeading + 'deg)';
    }
    // Plain, read-only bearing readout (N/NE/E/…) — informational only,
    // not a button with a mode to toggle.
    var needle = document.getElementById('nav-compass-needle');
    if (needle) needle.textContent = headingToCompassLabel(navLastHeading);
  }

  function headingToCompassLabel(heading) {
    var dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    var normalized = ((heading % 360) + 360) % 360;
    return dirs[Math.round(normalized / 45) % 8];
  }

  var navFollowingUser = true;
  var navLastPosition = null;
  function navOnManualMapDrag() {
    if (!navFollowingUser) return; // already off, nothing to do
    navFollowingUser = false;
    document.getElementById('nav-recenter-btn').style.display = 'flex';
  }

  // Top-down vehicle silhouette for the active-navigation position
  // marker, shaped to actually match the configured vehicle rather
  // than always the same generic car outline. Both use the same
  // headlight/windshield/shadow visual language as the original car
  // icon, just with a body shape that reads as "van" vs. "truck with a
  // trailer" from directly above.
  function navPositionMarkerSvg() {
    var tipo = state.vehicle && state.vehicle.tipo;
    if (tipo === 'camion' || tipo === 'cassonato' || tipo === 'autoarticolato') {
      // Cab + a visibly SEPARATE cargo box behind it, with a gap at the
      // coupling point — the real silhouette of a truck/articulated
      // lorry from above, not just a longer version of the car shape.
      return '<svg viewBox="0 0 96 170" width="26" height="46">' +
        '<ellipse cx="48" cy="150" rx="26" ry="9" fill="#000" fill-opacity="0.12"/>' +
        '<rect x="26" y="94" width="44" height="66" rx="6" fill="#eef2f7" stroke="#9aa5b1" stroke-width="3"/>' + // trailer/cargo box
        '<rect x="30" y="16" width="36" height="70" rx="14" fill="#eef2f7" stroke="#9aa5b1" stroke-width="3"/>' + // cab
        '<rect x="35" y="30" width="26" height="30" rx="6" fill="#ffffff" stroke="#bdc5cf" stroke-width="2"/>' + // windshield
        '<path d="M30 32c-6 6-8 12-8 18v14c0 5 2 9 6 12l2 1V33z" fill="#d64242" fill-opacity="0.85"/>' + // left headlight
        '<path d="M66 32c6 6 8 12 8 18v14c0 5-2 9-6 12l-2 1V33z" fill="#42a5f5" fill-opacity="0.85"/>' + // right marker light
        '</svg>';
    }
    // Furgone (or unset) — a single, uniform boxy body, no separate
    // trailer, matching a van's actual silhouette.
    return '<svg viewBox="0 0 96 150" width="26" height="41">' +
      '<ellipse cx="48" cy="132" rx="24" ry="8" fill="#000" fill-opacity="0.12"/>' +
      '<rect x="24" y="18" width="48" height="112" rx="18" fill="#eef2f7" stroke="#9aa5b1" stroke-width="3"/>' +
      '<rect x="31" y="34" width="34" height="56" rx="8" fill="#ffffff" stroke="#bdc5cf" stroke-width="2"/>' +
      '<path d="M24 36c-8 8-10 16-10 24v28c0 6 3 12 8 16l2 2V44z" fill="#d64242" fill-opacity="0.85"/>' +
      '<path d="M72 36c8 8 10 16 10 24v28c0 6-3 12-8 16l-2 2V44z" fill="#42a5f5" fill-opacity="0.85"/>' +
      '<rect x="38" y="96" width="20" height="20" rx="6" fill="#dde5ee"/>' +
      '</svg>';
  }

  function onActiveNavPosition(position) {
    var lat = position.coords.latitude, lon = position.coords.longitude;
    var heading = position.coords.heading;
    navLastPosition = { lat: lat, lon: lon };

    // Trims the already-driven part of the CURRENT leg off the map on
    // every real position update — not just when a full stop is
    // reached. Needs navLegs to exist yet (it's set at the very start
    // of startActiveNavigation, so this is safe from the first fix
    // onward).
    if (navLegs) drawActiveNavLegs(lat, lon);

    // Off-route detection — was completely missing before: if the
    // driver missed a turn or otherwise left the calculated street,
    // the app just kept showing the original route and instructions
    // regardless, with no way back to a correct route short of
    // stopping and recalculating by hand.
    //
    // Two ways to trigger, matching the two real-world cases:
    // 1) SUSTAINED distance — off the line by more than 30m for 3
    //    consecutive fixes. A single reading over the threshold isn't
    //    enough on its own (ordinary GPS noise can put you 20-30m off
    //    a road you're actually still on), but a sustained deviation
    //    over a few real seconds is a genuine signal.
    // 2) FAST heading-based trigger — off the line by more than 20m
    //    AND heading a clearly different direction than the route
    //    itself goes there (>70°) AND actually moving at a meaningful
    //    speed (>10 km/h, so this never fires while stopped or
    //    crawling, where heading is unreliable anyway). This one
    //    doesn't wait for consecutive fixes — heading mismatch this
    //    large while genuinely moving is already a strong, fast signal
    //    of a real wrong turn, not GPS noise, so there's no reason to
    //    wait several more seconds to confirm it.
    //
    // Cooldown: even once triggered, won't fire again within 30s of the
    // last reroute — recalculating repeatedly in a tight loop (e.g.
    // while the fresh route is still catching up to a slightly-still-off
    // position right after a reroute) would be worse than just waiting
    // a moment.
    var REROUTE_COOLDOWN_MS = 30000;
    if (navLegs && navLegs[navCurrentLegIndex] && !navRerouting &&
        (!navLastRerouteTime || Date.now() - navLastRerouteTime > REROUTE_COOLDOWN_MS)) {
      var deviation = routeDeviation(navLegs[navCurrentLegIndex].geometry.coordinates, lat, lon);
      var speedKmh = (position.coords.speed != null && !isNaN(position.coords.speed)) ? position.coords.speed * 3.6 : 0;
      var headingMismatch = (heading != null && !isNaN(heading) && deviation.routeBearing != null)
        ? angleDifference(heading, deviation.routeBearing) : 0;
      var fastTrigger = deviation.distance > 20 && headingMismatch > 70 && speedKmh > 10;
      if (fastTrigger) {
        navOffRouteCount = 0;
        rerouteFromCurrentPosition(lat, lon);
      } else if (deviation.distance > 30) {
        navOffRouteCount++;
        if (navOffRouteCount >= 3) {
          navOffRouteCount = 0;
          rerouteFromCurrentPosition(lat, lon);
        }
      } else {
        navOffRouteCount = 0;
      }
    }

    // Real current speed, straight from GPS (m/s → km/h) — shown only
    // when the device actually reports it (many phones return null
    // while stationary or with a weak fix), never estimated or
    // guessed. This is deliberately NOT a speed-limit sign like
    // Google's own — that would need real speed-limit data per road
    // segment, which no free source used here provides, and inventing
    // a number would be worse than not showing one.
    var speedBadge = document.getElementById('nav-speed-badge');
    if (speedBadge) {
      var speedMs = position.coords.speed;
      if (speedMs != null && !isNaN(speedMs) && speedMs >= 0) {
        document.getElementById('nav-speed-value').textContent = Math.round(speedMs * 3.6);
        speedBadge.style.display = 'flex';
      } else {
        speedBadge.style.display = 'none';
      }
    }

    // Update the EXISTING marker's position instead of destroying and
    // recreating it on every GPS fix — the previous version tore down
    // and rebuilt the marker each time, which teleports it instantly
    // rather than letting it move. Combined with the CSS transition on
    // .nav-heading-arrow below, setLatLng() here glides smoothly
    // between real GPS fixes (roughly once every 1-2s) instead of
    // jumping — this is the single biggest contributor to the
    // "sacadat" (jerky) feel compared to Google Maps' own fluid camera.
    if (navPositionMarker) {
      navPositionMarker.setLatLng([lat, lon]);
    } else {
      // A top-down icon matching the actually-configured vehicle —
      // furgone gets a van silhouette, camion/cassonato/autoarticolato
      // get a truck-with-trailer silhouette (a visibly separate cab and
      // cargo box, since that's the real shape of the bigger vehicles
      // this app is built for) — rather than always the same generic
      // car shape regardless of what's actually being driven. Rotates
      // to show the real direction of travel — the map itself stays
      // fixed, north-up (see rotateNavMapToHeading), only this marker
      // turns.
      navPositionMarker = L.marker([lat, lon], {
        icon: L.divIcon({
          className: 'nav-heading-arrow',
          html: '<div>' + navPositionMarkerSvg() + '</div>',
          iconSize: [30, 46], iconAnchor: [15, 23]
        })
      }).addTo(navMap);
    }

    // Multi-stop trip — offer to confirm arrival once genuinely close
    // to the next stop, rather than auto-completing it silently. Only
    // prompts once per stop (not on every position update while
    // sitting there).
    if (navLegs && navLegs.length > 1 && navLegPoints && !navArrivalPromptShown) {
      var nextStopIdx = navCurrentLegIndex + 1;
      if (nextStopIdx < navLegPoints.length - 1) { // the final destination has its own "sei arrivato" instruction already — this is only for intermediate stops
        var nextStop = navLegPoints[nextStopIdx];
        var distToNextStop = haversineKm({ lat: lat, lon: lon }, { lat: nextStop.lat, lon: nextStop.lon }) * 1000;
        // Was 80m — far too generous, per real-world testing (the
        // prompt appeared with ~50m still to go). Tightened to 25m.
        // Not pushed all the way down to the 5-10m actually asked for:
        // ordinary phone GPS accuracy is typically 5-15m even with a
        // good signal, sometimes worse — a threshold that tight risks
        // never firing at all if the GPS reading is a little off, which
        // would be worse than firing a bit early. 25m is a real,
        // meaningfully tighter improvement while staying reliable.
        if (distToNextStop < 25) {
          navArrivalPromptShown = true;
          showNavArrivalPrompt(nextStopIdx);
        }
      }
    }

    if (navFollowingUser) {
      navMap.setView([lat, lon], 18, { animate: true });
    }
    if (heading != null && !isNaN(heading)) rotateNavMapToHeading(heading);

    // Advance through steps as each maneuver point is reached (within
    // ~40m — GPS on a phone isn't precise enough to require reaching
    // the exact point). The very first instruction is always shown as
    // step 0 initially — the route naturally starts right at that same
    // point, so this only starts checking distance from step 1 onward,
    // rather than skipping straight past the first instruction before
    // the person ever sees it.
    while (navActiveStepIndex < navActiveSteps.length - 1) {
      var nextStep = navActiveSteps[navActiveStepIndex + 1];
      var distToNextStep = haversineKm({ lat: lat, lon: lon }, { lat: nextStep.lat, lon: nextStep.lon }) * 1000;
      var currentStep = navActiveSteps[navActiveStepIndex];
      var distToCurrentStep = haversineKm({ lat: lat, lon: lon }, { lat: currentStep.lat, lon: currentStep.lon }) * 1000;
      // Only advance once genuinely closer to the NEXT maneuver than to
      // the current one — not just "near the current step's own point",
      // which is trivially true at the very start of the route.
      if (distToNextStep < 40 && distToNextStep < distToCurrentStep) { navActiveStepIndex++; } else { break; }
    }
    updateActiveInstructionBanner(lat, lon);
  }

  // Recalculates the rest of the trip from wherever the driver actually
  // is right now, through every stop still remaining — this is what
  // was completely missing before: if a turn was missed, the app just
  // kept showing the original (now wrong) route and instructions with
  // no way back short of stopping and starting over by hand. Reuses
  // computeMultiStopRoute exactly as the initial calculation does, just
  // with the live position standing in for the origin. Any leg already
  // completed before this point stays completed; only what's still
  // ahead gets replaced.
  function rerouteFromCurrentPosition(lat, lon) {
    if (navRerouting || !navLegPoints) return;
    navRerouting = true;
    toast('Fuori percorso — ricalcolo del percorso…');
    var remainingPoints = [{ lat: lat, lon: lon }].concat(navLegPoints.slice(navCurrentLegIndex + 1));
    computeMultiStopRoute(remainingPoints)
      .then(function (result) {
        navLegs = result.legs;
        navLegPoints = remainingPoints;
        navCurrentLegIndex = 0;
        navArrivalPromptShown = false;
        navActiveFeature = result.alternatives[0];
        navActiveSteps = buildNavActiveSteps(navActiveFeature);
        navActiveStepIndex = 0;
        drawActiveNavLegs(lat, lon);
        updateActiveInstructionBanner(lat, lon);
        toast('Percorso ricalcolato');
      })
      .catch(function () {
        // Couldn't get a fresh route (offline, out of quota, weak
        // signal) — the old route and instructions just stay as they
        // were rather than leaving the screen in a broken state; the
        // off-route counter will simply try again on the next fixes.
        toast('Impossibile ricalcolare — riprovo al prossimo segnale');
      })
      .then(function () { navRerouting = false; navLastRerouteTime = Date.now(); });
  }

  function updateActiveInstructionBanner(lat, lon) {
    var step = navActiveSteps[navActiveStepIndex];
    if (!step) return;
    document.getElementById('nav-instr-icon').innerHTML = svgIcon(NAV_TURN_ICONS[step.type] || 'nav-straight');
    document.getElementById('nav-instr-text').textContent = step.instruction;
    if (lat != null) {
      var distM = haversineKm({ lat: lat, lon: lon }, { lat: step.lat, lon: step.lon }) * 1000;
      document.getElementById('nav-instr-dist').textContent = distM < 1000 ? Math.round(distM) + ' m' : (distM / 1000).toFixed(1) + ' km';
    }
    var props = navActiveFeature.properties.summary;
    var minutes = Math.round(props.duration / 60);
    var hours = Math.floor(minutes / 60), mins = minutes % 60;
    document.getElementById('nav-active-eta').textContent = (hours > 0 ? hours + ' h ' : '') + mins + ' min';
    document.getElementById('nav-active-remaining').textContent = (props.distance / 1000).toFixed(1) + ' km';
    // Estimated clock time of arrival — "arrivo" column, same idea as
    // Google Maps' own nav bar always showing a real clock time
    // alongside the remaining minutes, not just a countdown.
    var arrival = new Date(Date.now() + props.duration * 1000);
    document.getElementById('nav-active-arrival').textContent = arrival.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  }

  // Draws only the legs from the current one onward — the completed
  // legs behind the driver simply aren't shown anymore. The current
  // (next-to-drive) leg gets the full, detailed coloring (including its
  // own highway/road-type distinction); everything still ahead of that
  // stays the same soft, receded blue — exactly the progressive visual
  // Google Maps uses as a multi-stop trip advances.
  // Finds the index of the coordinate in a route's own geometry that's
  // closest to a given lat/lon — a simple nearest-vertex search (not a
  // full point-to-segment projection), which is precise enough here
  // since ORS route geometries are already densely sampled.
  function nearestCoordIndex(coords, lat, lon) {
    var bestIdx = 0, bestDist = Infinity;
    for (var i = 0; i < coords.length; i++) {
      var dx = coords[i][0] - lon, dy = coords[i][1] - lat;
      var d = dx * dx + dy * dy;
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    return bestIdx;
  }

  // Compass bearing (0-360°) from point a to point b.
  function bearingBetween(a, b) {
    var lat1 = a.lat * Math.PI / 180, lat2 = b.lat * Math.PI / 180;
    var dLon = (b.lon - a.lon) * Math.PI / 180;
    var y = Math.sin(dLon) * Math.cos(lat2);
    var x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  // Smallest angle (0-180°) between two compass bearings.
  function angleDifference(a, b) {
    var d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  // Distance from the driver to the current leg's line, PLUS the
  // route's own local direction at that nearest point (the bearing from
  // that point to the next one along the geometry) — used together for
  // off-route detection: being some distance from the line isn't
  // itself proof of a wrong turn (GPS noise, or a wide junction), but
  // being off the line AND heading a clearly different direction than
  // the road actually goes is a much stronger, faster signal.
  function routeDeviation(coords, lat, lon) {
    var idx = nearestCoordIndex(coords, lat, lon);
    var c = coords[idx];
    var distance = haversineKm({ lat: lat, lon: lon }, { lat: c[1], lon: c[0] }) * 1000;
    var nextC = coords[idx + 1] || coords[idx - 1]; // fall back to the previous point at the very end of the line
    var routeBearing = nextC ? bearingBetween({ lat: c[1], lon: c[0] }, { lat: nextC[1], lon: nextC[0] }) : null;
    return { distance: distance, routeBearing: routeBearing };
  }

  // Returns a copy of a leg's feature with the already-driven portion
  // cut off — the part of the line behind the driver's current
  // position simply isn't there anymore, rather than staying the same
  // solid color the whole leg through. Matches the real-time trimming
  // Google Maps does; this app previously only ever dropped a leg
  // ENTIRELY once a full stop was reached, never trimmed WITHIN a leg
  // as the driver actually made progress along it.
  function trimmedLegFeature(feature, lat, lon) {
    var coords = feature.geometry.coordinates;
    var idx = nearestCoordIndex(coords, lat, lon);
    if (idx <= 0) return feature; // nothing driven yet on this leg
    var trimmedCoords = coords.slice(idx);
    if (trimmedCoords.length < 2) return feature; // avoid degenerating to an empty/invalid line right at the very end
    return { type: 'Feature', properties: feature.properties, geometry: { type: 'LineString', coordinates: trimmedCoords } };
  }

  // Draws only the legs from the current one onward — the completed
  // legs behind the driver simply aren't shown anymore. The current
  // (next-to-drive) leg is the strong dark blue, everything still
  // ahead of that stays the lighter shade. Added in REVERSE order
  // (furthest-ahead leg first, current leg last) so the current leg
  // paints on top wherever it crosses a future one — always the one
  // that's clearly visible.
  // lat/lon (optional): the driver's live position — when given, the
  // CURRENT leg is additionally trimmed back to start from the nearest
  // point to here, so the stretch already driven disappears in
  // real time, not just when a full stop is reached.
  function drawActiveNavLegs(lat, lon) {
    if (navRouteLayer) navMap.removeLayer(navRouteLayer);
    navRouteLayer = L.featureGroup();
    for (var i = navLegs.length - 1; i >= navCurrentLegIndex; i--) {
      var isCurrent = i === navCurrentLegIndex;
      var legFeature = navLegs[i];
      if (isCurrent && lat != null && lon != null) legFeature = trimmedLegFeature(legFeature, lat, lon);
      var legLayer = drawColorCodedRoute(legFeature, !isCurrent);
      legLayer.addTo(navRouteLayer);
    }
    navRouteLayer.addTo(navMap);
  }

  function showNavArrivalPrompt(stopIdx) {
    var stopNumber = stopIdx; // stops are 1-indexed in the UI (origin is index 0 in navLegPoints)
    var banner = document.createElement('div');
    banner.id = 'nav-arrival-prompt';
    banner.className = 'nav-arrival-prompt';
    banner.innerHTML =
      '<span>Sei arrivato alla Tappa ' + stopNumber + '?</span>' +
      '<button type="button" id="nav-arrival-confirm">✓ Conferma</button>' +
      '<button type="button" id="nav-arrival-dismiss">✕</button>';
    document.querySelector('.nav-map-wrap').appendChild(banner);
    document.getElementById('nav-arrival-confirm').addEventListener('click', function () {
      banner.remove();
      confirmNavArrivalAtStop();
    });
    document.getElementById('nav-arrival-dismiss').addEventListener('click', function () {
      banner.remove();
      navArrivalPromptShown = false; // lets it prompt again if still nearby a bit later — dismissing just means "not yet"
    });
  }

  // Advancing to the next leg — the just-completed stretch disappears
  // from the map entirely, its marker is removed, and the leg that was
  // "next" becomes the new fully-colored current one. Also nudges the
  // turn-by-turn instruction index forward to the first step that
  // belongs to the new current leg, so the banner doesn't keep showing
  // a stale instruction from the leg just finished.
  function confirmNavArrivalAtStop() {
    var reachedWp = navWaypoints[navCurrentLegIndex + 1];
    if (reachedWp && navWaypointMarkers[reachedWp.id]) {
      navMap.removeLayer(navWaypointMarkers[reachedWp.id]);
      delete navWaypointMarkers[reachedWp.id];
    }
    navCurrentLegIndex++;
    navArrivalPromptShown = false;
    drawActiveNavLegs();
    if (navLastPosition) {
      while (navActiveStepIndex < navActiveSteps.length - 1) {
        var step = navActiveSteps[navActiveStepIndex];
        var d = haversineKm(navLastPosition, { lat: step.lat, lon: step.lon }) * 1000;
        if (d < 150) { navActiveStepIndex++; } else { break; }
      }
    }
    updateActiveInstructionBanner(navLastPosition ? navLastPosition.lat : null, navLastPosition ? navLastPosition.lon : null);
    toast('Tappa raggiunta — prossima tratta');
  }

  function stopActiveNavigation() {
    if (navWatchId != null) { navigator.geolocation.clearWatch(navWatchId); navWatchId = null; }
    if (navPositionMarker) { navMap.removeLayer(navPositionMarker); navPositionMarker = null; }
    navMap.off('dragstart', navOnManualMapDrag);
    if (navMap.setBearing) navMap.setBearing(0); // back to plain north-up once navigation ends
    document.getElementById('nav-recenter-btn').style.display = 'none';
    var arrivalPrompt = document.getElementById('nav-arrival-prompt');
    if (arrivalPrompt) arrivalPrompt.remove();
    navLegs = null; navLegPoints = null; navCurrentLegIndex = 0; navArrivalPromptShown = false;
    navOffRouteCount = 0; navLastRerouteTime = 0; navRerouting = false;
    document.getElementById('nav-active-overlay').style.display = 'none';
    document.getElementById('nav-search-bar').style.display = '';
    document.getElementById('nav-float-controls').style.display = '';
    document.querySelector('.nav-map-wrap').classList.remove('nav-fullscreen');
    if (navActiveFeature) navMap.fitBounds(navRouteLayer.getBounds(), { padding: [24, 24] });
    // Termina / the X during active navigation goes back to the
    // already-calculated route (distance, time, alternatives, "Avvia
    // navigazione" again) — NOT all the way back to an empty trip
    // planner. nav-result's content was never cleared, only hidden
    // when "Avvia" started, so simply showing it again is enough; the
    // Avvia button inside it still has its original click handler,
    // closed over the very same calculated route, ready to reuse
    // without recalculating. A real recalculation only happens if the
    // person actually edits the trip (add/change/remove a waypoint),
    // which already re-triggers "Calcola percorso" through the normal
    // flow — this doesn't change that.
    document.getElementById('nav-result').style.display = 'block';
    setTimeout(function () { if (navMap) navMap.invalidateSize(); }, 50); // the map container's real size changed leaving fullscreen — Leaflet needs to recalculate its own dimensions
    // Deliberately NOT forcing a pending reload here even if one was
    // deferred during navigation — that would immediately wipe the
    // "route still calculated, ready for Avvia again" state above,
    // right after building it. The periodic version check (every 60s)
    // will pick this moment up naturally, once navigatingActively is
    // false, without fighting this screen.
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
    html += '<button class="btn btn-outline" style="flex:1;display:flex;align-items:center;justify-content:center;gap:8px;" id="pdf-download-outline">' + svgIcon('share') + '<span>Condividi PDF</span></button>';
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
      var filename = 'Foglio_Viaggi_' + MESI[mo.month - 1] + '_' + mo.year;
      openPdfViewerModal(doc.output('arraybuffer'), filename);
    } catch (err) {
      console.error(err);
      toast('Impossibile aprire l\'anteprima');
    }
  }

  // Our own PDF viewer, rendering each page to a plain <canvas> via
  // PDF.js — instead of leaning on the phone's own PDF handling, which
  // varies wildly by device (confirmed structurally unreliable on many
  // Android browsers/WebViews, especially older ones — often just a
  // blank/black screen). This looks and feels identical everywhere,
  // regardless of device age or browser.
  var pdfViewerOriginalViewport = null;
  function openPdfViewerModal(pdfArrayBuffer, title) {
    document.getElementById('pdfviewer-title').textContent = title || 'Anteprima';
    document.getElementById('pdfviewer-pages').innerHTML = '';
    document.getElementById('pdfviewer-loading').style.display = '';
    document.getElementById('modal-pdfviewer').classList.add('open');

    // Pinch-zoom is locked at the page level everywhere else in the app
    // (see the crop tool for the same pattern) — temporarily allow real
    // native pinch-to-zoom here, exactly like a proper PDF viewer, then
    // restore the normal lock on close.
    var meta = document.getElementById('viewport-meta');
    pdfViewerOriginalViewport = meta.getAttribute('content');
    meta.setAttribute('content', 'width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=5, user-scalable=yes');

    pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
    pdfjsLib.getDocument({ data: pdfArrayBuffer }).promise.then(function (pdf) {
      var container = document.getElementById('pdfviewer-pages');
      var renderPage = function (pageNum) {
        return pdf.getPage(pageNum).then(function (page) {
          var scale = (window.devicePixelRatio > 1.5) ? 2.2 : 1.6; // sharp on retina-class screens without being wasteful on older/lower-res ones
          var viewport = page.getViewport({ scale: scale });
          var canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          container.appendChild(canvas);
          return page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport }).promise;
        });
      };
      var chain = Promise.resolve();
      for (var i = 1; i <= pdf.numPages; i++) {
        (function (n) { chain = chain.then(function () { return renderPage(n); }); })(i);
      }
      return chain;
    }).then(function () {
      document.getElementById('pdfviewer-loading').style.display = 'none';
    }).catch(function (err) {
      console.error(err);
      document.getElementById('pdfviewer-loading').textContent = 'Impossibile generare l\'anteprima.';
    });
  }
  function closePdfViewerModal() {
    document.getElementById('modal-pdfviewer').classList.remove('open');
    if (pdfViewerOriginalViewport) {
      document.getElementById('viewport-meta').setAttribute('content', pdfViewerOriginalViewport);
      pdfViewerOriginalViewport = null;
    }
  }
  document.getElementById('pdfviewer-close').addEventListener('click', closePdfViewerModal);
  document.getElementById('pdfviewer-download').addEventListener('click', downloadCurrentPdf);

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
    var isDueGiri = sheet.pdfTemplate === 'due-giri';
    var colWidths, head, body;

    if (isDueGiri) {
      // Two separate trips (each with its own destination + DDT) can
      // happen on the same day — some clients require that split
      // explicitly rather than combining it into one row.
      colWidths = {
        data: contentW * 0.028, da: contentW * 0.115, provDa: contentW * 0.032,
        a1: contentW * 0.105, provA1: contentW * 0.032, ddt1: contentW * 0.085,
        a2: contentW * 0.105, provA2: contentW * 0.032, ddt2: contentW * 0.085,
        kmI: contentW * 0.12, kmF: contentW * 0.12, kmT: contentW * 0.141
      };
      head = [
        [
          { content: 'Data', rowSpan: 2, styles: { valign: 'middle', halign: 'center' } },
          { content: 'Partenza', colSpan: 2, styles: { halign: 'center' } },
          { content: 'Giro 1', colSpan: 3, styles: { halign: 'center' } },
          { content: 'Giro 2', colSpan: 3, styles: { halign: 'center' } },
          { content: 'KM INIZIO', rowSpan: 2, styles: { valign: 'middle', halign: 'center' } },
          { content: 'KM FINE', rowSpan: 2, styles: { valign: 'middle', halign: 'center' } },
          { content: 'KM TOT.', rowSpan: 2, styles: { valign: 'middle', halign: 'center' } }
        ],
        [
          { content: 'Da:', styles: { halign: 'center' } },
          { content: 'Prov.', styles: { halign: 'center' } },
          { content: 'A:', styles: { halign: 'center' } },
          { content: 'Prov.', styles: { halign: 'center' } },
          { content: 'DDT', styles: { halign: 'center' } },
          { content: 'A:', styles: { halign: 'center' } },
          { content: 'Prov.', styles: { halign: 'center' } },
          { content: 'DDT', styles: { halign: 'center' } }
        ]
      ];
      body = [];
      var n2 = daysInMonth(sheet.month, sheet.year);
      for (var d2 = 1; d2 <= 31; d2++) {
        var g2 = d2 <= n2 ? sheet.giorni[d2] : null;
        if (!g2) { body.push([d2 <= n2 ? d2 : '', '', '', '', '', '', '', '', '', '', '', '']); continue; }
        var kmTot2 = (g2.kmInizio !== "" && g2.kmFine !== "" && !isNaN(g2.kmFine - g2.kmInizio)) ? (Number(g2.kmFine) - Number(g2.kmInizio)) : '';
        body.push([
          d2,
          g2.da || '', g2.provDa || '',
          g2.a || '', g2.provA || '', g2.ddt || '',
          g2.a2 || '', g2.provA2 || '', g2.ddt2 || '',
          g2.kmInizio !== "" ? g2.kmInizio : '',
          g2.kmFine !== "" ? g2.kmFine : '',
          kmTot2 !== '' ? kmTot2 : ''
        ]);
      }
    } else {
      colWidths = {
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

      head = [
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

      body = [];
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
    }

    var columnStyles = isDueGiri ? {
      0: { cellWidth: colWidths.data, halign: 'center', fontStyle: 'bold' },
      1: { cellWidth: colWidths.da, halign: 'center' },
      2: { cellWidth: colWidths.provDa, halign: 'center' },
      3: { cellWidth: colWidths.a1, halign: 'center' },
      4: { cellWidth: colWidths.provA1, halign: 'center' },
      5: { cellWidth: colWidths.ddt1, halign: 'center' },
      6: { cellWidth: colWidths.a2, halign: 'center' },
      7: { cellWidth: colWidths.provA2, halign: 'center' },
      8: { cellWidth: colWidths.ddt2, halign: 'center' },
      9: { cellWidth: colWidths.kmI, halign: 'center' },
      10: { cellWidth: colWidths.kmF, halign: 'center' },
      11: { cellWidth: colWidths.kmT, halign: 'center', fontStyle: 'bold' }
    } : {
      0: { cellWidth: colWidths.data, halign: 'center', fontStyle: 'bold' },
      1: { cellWidth: colWidths.da, halign: 'center' },
      2: { cellWidth: colWidths.provDa, halign: 'center' },
      3: { cellWidth: colWidths.a, halign: 'center' },
      4: { cellWidth: colWidths.provA, halign: 'center' },
      5: { cellWidth: colWidths.ddt, halign: 'center' },
      6: { cellWidth: colWidths.kmI, halign: 'center' },
      7: { cellWidth: colWidths.kmF, halign: 'center' },
      8: { cellWidth: colWidths.kmT, halign: 'center', fontStyle: 'bold' }
    };

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
      columnStyles: columnStyles
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
  // Packs every fuel receipt edge-to-edge, in day order, after the GIRO
  // table page(s) — instead of a fixed grid with wide, mostly-empty
  // cells (receipts are narrow, so a grid sized for a generic cell left
  // a lot of visible gap around each one). Each receipt is drawn at a
  // shared row height, placed right after the previous one with a small
  // fixed gap, and wraps to a new row (or page) only when it no longer
  // fits — so however many happen to fit side by side, they end up
  // genuinely close together, not spread across an artificial grid.
  function addReceiptPages(doc, month, year) {
    var monthFuel = state.fuel[fuelMonthKey(month, year)] || {};
    var receipts = [];
    Object.keys(monthFuel).sort(function (a, b) { return Number(a) - Number(b); }).forEach(function (d) {
      var dayReceipts = monthFuel[d];
      if (!dayReceipts || !dayReceipts.length) return;
      dayReceipts.forEach(function (r, idx) {
        if (!r || !r.data) return;
        receipts.push({ day: d, indexInDay: idx, totalInDay: dayReceipts.length, scontrino: r });
      });
    });
    if (!receipts.length) return;

    var pageW = 297, pageH = 210, margin = 10;
    var headerH = 10; // space reserved for the page title on each receipts page
    var gap = 2; // mm between receipts, both across a row and between rows
    var captionH = 4; // space for the "Giorno N" label above each image
    var rowH = 78; // shared image height each receipt is scaled to
    var usableW = pageW - margin * 2;
    var usableH = pageH - margin * 2 - headerH;
    var totalCount = receipts.length;
    var totalWord = totalCount === 1 ? 'totale' : 'totali';

    // Pass 1: simulate the flow layout to find out how many pages it
    // takes, so each page's title can say "pagina X di Y" correctly —
    // with a flow layout (unlike a fixed grid) that isn't known upfront.
    function simulateLayout() {
      var x = 0, y = 0, pages = 1;
      receipts.forEach(function (r) {
        var ratio = (r.scontrino.w && r.scontrino.h) ? r.scontrino.w / r.scontrino.h : 0.6;
        var w = rowH * ratio;
        if (x + w > usableW && x > 0) { x = 0; y += rowH + captionH + gap; }
        if (y + captionH + rowH > usableH) { pages++; x = 0; y = 0; }
        x += w + gap;
      });
      return pages;
    }
    var totalPages = simulateLayout();

    var x = margin, y = margin + headerH, pageNum = 0;
    function startPage() {
      doc.addPage();
      pageNum++;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(12);
      doc.setTextColor(20, 20, 20);
      var pageLabel = totalPages > 1
        ? 'Scontrini carburante — ' + totalCount + ' ' + totalWord + ' (pagina ' + pageNum + ' di ' + totalPages + ')'
        : 'Scontrini carburante — ' + totalCount + ' ' + totalWord;
      doc.text(pageLabel, pageW / 2, margin + 3, { align: 'center' });
      x = margin; y = margin + headerH;
    }
    startPage();

    receipts.forEach(function (r) {
      var ratio = (r.scontrino.w && r.scontrino.h) ? r.scontrino.w / r.scontrino.h : 0.6;
      var w = rowH * ratio, h = rowH;
      if (x + w > margin + usableW && x > margin) { x = margin; y += rowH + captionH + gap; }
      if (y + captionH + h > margin + headerH + usableH) { startPage(); }

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7);
      doc.setTextColor(90, 90, 90);
      var label = 'G.' + r.day + (r.totalInDay > 1 ? ' (' + (r.indexInDay + 1) + '/' + r.totalInDay + ')' : '');
      doc.text(label, x + w / 2, y + 3, { align: 'center' });

      try {
        doc.addImage(r.scontrino.data, 'JPEG', x, y + captionH, w, h);
      } catch (e) { /* skip a broken image rather than fail the whole PDF */ }

      x += w + gap;
    });
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

  // ION reconsidered the earlier approach after testing a real photo that
  // came out unreadable: forcing every receipt through heavy grayscale +
  // contrast + shadow-removal processing was too aggressive and could
  // destroy real detail, especially on already-tricky photos. The budget
  // was also based on a mistaken assumption — these images never leave
  // the phone (nothing is uploaded to any server), so there was never a
  // real reason to compress them as hard as possible; 10KB was solving a
  // problem that didn't exist. The photo now stays close to what the
  // camera actually captured — same colors, same detail — with only a
  // small, fixed brightness lift (not a full contrast stretch) so a
  // photo taken in dim light is a little easier to read, without
  // washing out one taken in daylight, since it's the same small nudge
  // either way rather than something that reacts to how bright the
  // original already was.
  function processReceiptCanvas(sourceCanvas) {
    var budgetBytes = 50 * 1024; // stored locally only — no server/upload cost to weigh against
    var dimSteps = [1400, 1200, 1000, 800, 600, 450];
    var qualitySteps = [0.85, 0.78, 0.7, 0.62, 0.54, 0.46, 0.38, 0.3, 0.2];
    var brightnessLift = 16; // small, fixed — enough to help a dim photo without blowing out a bright one
    var best = null; // smallest result found so far, kept as a fallback

    for (var dIdx = 0; dIdx < dimSteps.length; dIdx++) {
      var maxDim = dimSteps[dIdx];
      var scale = Math.min(1, maxDim / Math.max(sourceCanvas.width, sourceCanvas.height));
      var w = Math.max(1, Math.round(sourceCanvas.width * scale));
      var h = Math.max(1, Math.round(sourceCanvas.height * scale));
      var canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      var ctx = canvas.getContext('2d');
      ctx.drawImage(sourceCanvas, 0, 0, w, h);

      var imgData = ctx.getImageData(0, 0, w, h);
      var d = imgData.data;
      for (var p = 0; p < d.length; p += 4) {
        d[p] = Math.min(255, d[p] + brightnessLift);
        d[p + 1] = Math.min(255, d[p + 1] + brightnessLift);
        d[p + 2] = Math.min(255, d[p + 2] + brightnessLift);
      }
      ctx.putImageData(imgData, 0, 0);

      for (var q = 0; q < qualitySteps.length; q++) {
        var data = canvas.toDataURL('image/jpeg', qualitySteps[q]);
        if (!best || data.length < best.data.length) best = { data: data, w: w, h: h };
        if (data.length * 0.75 <= budgetBytes) return best;
      }
    }
    // Even the smallest/lowest-quality attempt didn't fit — this should
    // only happen in extreme, unusual cases; return the smallest one
    // found rather than nothing, so saving a receipt never simply fails.
    return best;
  }

  /* ---------------------------------------------------------------- */
  /* Fuel screen — day-by-day list, reachable from Home, for logging     */
  /* receipts directly without opening a day's full trip details. Fully  */
  /* independent of any client sheet — shared by the whole month.        */
  /* ---------------------------------------------------------------- */
  var fuelModal = document.getElementById('modal-fuel');
  var fuelActiveMonth = null, fuelActiveYear = null;
  var fuelScrollPending = false;
  function openFuelScreen() {
    var sheet = currentSheet();
    if (!sheet) { toast('Crea prima un foglio mensile'); return; }
    fuelActiveMonth = sheet.month; fuelActiveYear = sheet.year;
    document.getElementById('fuel-sub').textContent = MESI[sheet.month - 1] + ' ' + sheet.year;
    fuelScrollPending = true;
    renderFuelList();
    fuelModal.classList.add('open');
  }
  function renderFuelList() {
    var n = daysInMonth(fuelActiveMonth, fuelActiveYear);
    var monthKey = fuelMonthKey(fuelActiveMonth, fuelActiveYear);
    var monthFuel = state.fuel[monthKey] || {};
    var html = '';
    var lastReceiptDay = null;
    for (var d = 1; d <= n; d++) {
      var receipts = monthFuel[d];
      var date = new Date(fuelActiveYear, fuelActiveMonth - 1, d);
      var dow = GIORNI_SETT[date.getDay()].slice(0, 3);
      var count = (receipts && receipts.length) || 0;
      if (count > 0) lastReceiptDay = d;
      html += '<div class="day-row' + (count > 0 ? ' filled' : '') + '" data-fuel-day="' + d + '">';
      html += '<div class="day-num">' + d + '</div>';
      var subLabel = count === 0 ? 'nessuno scontrino' : (count === 1 ? '1 scontrino allegato' : count + ' scontrini allegati');
      html += '<div class="day-main"><div class="dest">Giorno ' + d + '</div><div class="sub">' + dow + ' · ' + subLabel + '</div></div>';
      if (count > 0) {
        var lastPhoto = receipts[receipts.length - 1];
        html += '<div class="fuel-thumb-wrap"><img class="fuel-thumb" src="' + lastPhoto.data + '" alt="">';
        if (count > 1) html += '<span class="fuel-count-badge">' + count + '</span>';
        html += '</div>';
      } else {
        html += '<div class="fuel-add-icon">+</div>';
      }
      html += '</div>';
    }
    document.getElementById('fuel-list').innerHTML = html;
    document.querySelectorAll('#fuel-list [data-fuel-day]').forEach(function (row) {
      row.addEventListener('click', function () {
        var d = row.getAttribute('data-fuel-day');
        var monthKey2 = fuelMonthKey(fuelActiveMonth, fuelActiveYear);
        var dayReceipts = state.fuel[monthKey2] && state.fuel[monthKey2][d];
        if (dayReceipts && dayReceipts.length === 1) {
          openFuelViewer(d, 0, dayReceipts[0]);
        } else if (dayReceipts && dayReceipts.length > 1) {
          openFuelGallery(d, dayReceipts);
        } else {
          fuelTargetDay = d;
          document.getElementById('in-fuel-photo').click();
        }
      });
    });

    // Same convenience as Foglio: land straight on the last day that
    // already has a receipt, ready to tap the next one along — instead of
    // always starting scrolled to the top of the whole month.
    if (fuelScrollPending) {
      fuelScrollPending = false;
      if (lastReceiptDay) {
        var targetRow = document.querySelector('#fuel-list [data-fuel-day="' + lastReceiptDay + '"]');
        if (targetRow) {
          requestAnimationFrame(function () {
            targetRow.scrollIntoView({ behavior: 'auto', block: 'center' });
          });
        }
      }
    }
  }

  // Shown when a day has MORE than one receipt — a small gallery of
  // thumbnails to pick from (tap to view full-size and zoom), each with
  // its own remove button, plus a clear way to add yet another.
  var fuelGalleryModal = document.getElementById('modal-fuel-gallery');
  function openFuelGallery(day, receipts) {
    document.getElementById('fuel-gallery-title').textContent = 'Giorno ' + day + ' — ' + receipts.length + ' scontrini';
    var html = '';
    receipts.forEach(function (r, idx) {
      html += '<div class="fuel-gallery-item" data-gallery-index="' + idx + '">';
      html += '<img src="' + r.data + '" alt="">';
      html += '<span class="fuel-remove-x" data-gallery-remove="' + idx + '">×</span>';
      html += '</div>';
    });
    document.getElementById('fuel-gallery-grid').innerHTML = html;
    fuelGalleryModal.dataset.day = day;
    document.querySelectorAll('#fuel-gallery-grid [data-gallery-index]').forEach(function (item) {
      item.addEventListener('click', function (e) {
        if (e.target.hasAttribute('data-gallery-remove')) return;
        var idx = parseInt(item.getAttribute('data-gallery-index'), 10);
        var monthKey2 = fuelMonthKey(fuelActiveMonth, fuelActiveYear);
        var current = state.fuel[monthKey2][day];
        fuelGalleryModal.classList.remove('open');
        openFuelViewer(day, idx, current[idx]);
      });
    });
    document.querySelectorAll('#fuel-gallery-grid [data-gallery-remove]').forEach(function (x) {
      x.addEventListener('click', function (e) {
        e.stopPropagation();
        var idx = parseInt(x.getAttribute('data-gallery-remove'), 10);
        var monthKey2 = fuelMonthKey(fuelActiveMonth, fuelActiveYear);
        deleteFuelReceipt(monthKey2, day, idx);
        var remaining = (state.fuel[monthKey2] && state.fuel[monthKey2][day]) || [];
        renderFuelList();
        toast('Scontrino rimosso');
        if (remaining.length <= 1) {
          fuelGalleryModal.classList.remove('open');
        } else {
          openFuelGallery(day, remaining);
        }
      });
    });
    fuelGalleryModal.classList.add('open');
  }
  document.getElementById('fuel-gallery-close-x').addEventListener('click', function () {
    fuelGalleryModal.classList.remove('open');
  });
  fuelGalleryModal.addEventListener('click', function (e) {
    if (e.target === fuelGalleryModal) fuelGalleryModal.classList.remove('open');
  });
  document.getElementById('fuel-gallery-add').addEventListener('click', function () {
    fuelTargetDay = fuelGalleryModal.dataset.day;
    fuelGalleryModal.classList.remove('open');
    document.getElementById('in-fuel-photo').click();
  });

  // Shows an already-attached receipt full-size, with its file size, so
  // the person can check what they saved without needing to replace it
  // just to look at it. Supports real pinch-to-zoom and drag-to-pan (not
  // just a bigger static image), plus double-tap as a quick shortcut —
  // built by hand with pointer events, since the page's own viewport zoom
  // is disabled app-wide and wouldn't reach into this modal anyway.
  var fuelViewModal = document.getElementById('modal-fuel-view');
  var fuelZoom = { scale: 1, panX: 0, panY: 0 };
  var fuelZoomPointers = {};
  var fuelZoomPinchStart = null;
  var fuelZoomPanStart = null;
  var fuelZoomLastTap = 0;
  function applyFuelZoom() {
    var img = document.getElementById('fuel-view-img');
    img.style.transform = 'translate(' + fuelZoom.panX + 'px,' + fuelZoom.panY + 'px) scale(' + fuelZoom.scale + ')';
  }
  function resetFuelZoom() {
    fuelZoom = { scale: 1, panX: 0, panY: 0 };
    applyFuelZoom();
  }
  function clampFuelPan() {
    var maxPan = 140 * fuelZoom.scale;
    fuelZoom.panX = Math.max(-maxPan, Math.min(maxPan, fuelZoom.panX));
    fuelZoom.panY = Math.max(-maxPan, Math.min(maxPan, fuelZoom.panY));
  }
  var fuelViewStage = document.getElementById('fuel-view-stage');
  fuelViewStage.addEventListener('pointerdown', function (e) {
    try { fuelViewStage.setPointerCapture(e.pointerId); } catch (err) { /* not critical — tracking below still works without it */ }
    fuelZoomPointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    var ids = Object.keys(fuelZoomPointers);
    if (ids.length === 2) {
      var p1 = fuelZoomPointers[ids[0]], p2 = fuelZoomPointers[ids[1]];
      fuelZoomPinchStart = { dist: Math.hypot(p2.x - p1.x, p2.y - p1.y), scale: fuelZoom.scale };
      fuelZoomPanStart = null;
    } else if (ids.length === 1) {
      fuelZoomPanStart = { x: e.clientX, y: e.clientY, panX: fuelZoom.panX, panY: fuelZoom.panY };
      var now = Date.now();
      if (now - fuelZoomLastTap < 300) {
        if (fuelZoom.scale > 1.3) resetFuelZoom();
        else { fuelZoom.scale = 2.5; applyFuelZoom(); }
      }
      fuelZoomLastTap = now;
    }
  });
  fuelViewStage.addEventListener('pointermove', function (e) {
    if (!(e.pointerId in fuelZoomPointers)) return;
    fuelZoomPointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    var ids = Object.keys(fuelZoomPointers);
    if (ids.length === 2 && fuelZoomPinchStart) {
      var p1 = fuelZoomPointers[ids[0]], p2 = fuelZoomPointers[ids[1]];
      var dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      fuelZoom.scale = Math.max(1, Math.min(5, fuelZoomPinchStart.scale * (dist / fuelZoomPinchStart.dist)));
      applyFuelZoom();
    } else if (ids.length === 1 && fuelZoomPanStart && fuelZoom.scale > 1) {
      fuelZoom.panX = fuelZoomPanStart.panX + (e.clientX - fuelZoomPanStart.x);
      fuelZoom.panY = fuelZoomPanStart.panY + (e.clientY - fuelZoomPanStart.y);
      clampFuelPan();
      applyFuelZoom();
    }
  });
  function endFuelZoomPointer(e) {
    delete fuelZoomPointers[e.pointerId];
    var ids = Object.keys(fuelZoomPointers);
    if (ids.length < 2) fuelZoomPinchStart = null;
    if (ids.length < 1) fuelZoomPanStart = null;
  }
  fuelViewStage.addEventListener('pointerup', endFuelZoomPointer);
  fuelViewStage.addEventListener('pointercancel', endFuelZoomPointer);

  function openFuelViewer(day, index, receipt) {
    document.getElementById('fuel-view-title').textContent = 'Scontrino — Giorno ' + day;
    document.getElementById('fuel-view-img').src = receipt.data;
    var approxKB = Math.round(receipt.data.length * 0.75 / 1024 * 10) / 10;
    document.getElementById('fuel-view-size').textContent = approxKB + ' KB';
    resetFuelZoom();
    fuelViewModal.dataset.day = day;
    fuelViewModal.dataset.index = index;
    fuelViewModal.classList.add('open');
  }
  function closeFuelViewer() { fuelViewModal.classList.remove('open'); }
  document.getElementById('fuel-view-close-x').addEventListener('click', closeFuelViewer);
  fuelViewModal.addEventListener('click', function (e) {
    if (e.target === fuelViewModal) closeFuelViewer();
  });
  // Repurposed as "add another" rather than "replace this one" — with a
  // day now able to hold several receipts, adding a new one is the far
  // more common need (e.g. the pump printed more than one, or a retry).
  document.getElementById('fuel-view-replace').addEventListener('click', function () {
    fuelTargetDay = fuelViewModal.dataset.day;
    closeFuelViewer();
    document.getElementById('in-fuel-photo').click();
  });
  document.getElementById('fuel-view-remove').addEventListener('click', function () {
    var d = fuelViewModal.dataset.day;
    var idx = parseInt(fuelViewModal.dataset.index, 10);
    var monthKey2 = fuelMonthKey(fuelActiveMonth, fuelActiveYear);
    deleteFuelReceipt(monthKey2, d, idx);
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
    var imgEl = document.getElementById('crop-img');
    imgEl.src = img.src;
    document.getElementById('modal-crop').classList.add('open');
    cropRect = null; // reset — guards a premature "Conferma" tap while the photo is still loading
    // Waiting on 'load'/'complete' (the image genuinely finished decoding
    // and laying out) rather than just a couple of animation frames — a
    // real camera photo can take real time to decode, especially on an
    // older phone, and a fixed short delay isn't reliable: tapping
    // "Conferma" before the crop rectangle was actually positioned left
    // it silently doing nothing.
    function afterImageReady() {
      requestAnimationFrame(function () {
        requestAnimationFrame(initCropRect);
      });
    }
    if (imgEl.complete && imgEl.naturalWidth > 0) {
      afterImageReady();
    } else {
      imgEl.onload = afterImageReady;
    }
  }
  function initCropRect() {
    var stage = document.getElementById('crop-stage');
    var imgEl = document.getElementById('crop-img');
    var stageW = stage.clientWidth, stageH = imgEl.clientHeight;
    // Defensive extra safety net: if the stage/image somehow haven't
    // actually laid out yet (0 size), retry shortly instead of leaving
    // cropRect degenerate — this should be rare now that openCropScreen
    // waits for the image's own 'load' event, but costs nothing to guard.
    if (stageW < 10 || stageH < 10) { setTimeout(initCropRect, 80); return; }
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
  document.getElementById('crop-close-x').addEventListener('click', function () {
    document.getElementById('crop-cancel').click();
  });
  document.getElementById('modal-crop').addEventListener('click', function (e) {
    if (e.target === document.getElementById('modal-crop')) document.getElementById('crop-cancel').click();
  });
  document.getElementById('crop-confirm').addEventListener('click', function () {
    if (!cropRawImage || !fuelTargetDay) return;
    if (!cropRect) { toast('Un istante, la foto si sta ancora preparando…'); return; }
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
    if (!state.fuel[monthKey][fuelTargetDay]) state.fuel[monthKey][fuelTargetDay] = [];
    state.fuel[monthKey][fuelTargetDay].push(scontrino);
    var savedCount = state.fuel[monthKey][fuelTargetDay].length;
    saveFuel(state.fuel);
    renderFuelList();
    toast(savedCount > 1 ? 'Scontrino ' + savedCount + ' salvato — Giorno ' + fuelTargetDay : 'Scontrino salvato — Giorno ' + fuelTargetDay);
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

    // Second giro (destination + DDT) — only for sheets using the
    // 'due-giri' PDF template, where a single day can have two separate
    // trips, each needing its own DDT.
    var isDueGiri = sheet.pdfTemplate === 'due-giri';
    document.getElementById('day-second-giro-wrap').classList.toggle('hidden', !isDueGiri);
    document.getElementById('day-a-label').textContent = isDueGiri ? 'Località di destinazione (A: 1)' : 'Località di destinazione (A)';
    document.getElementById('day-ddt-label').textContent = isDueGiri ? 'DDT - 1' : 'DDT';
    document.getElementById('day-a2').value = g.a2 || '';
    document.getElementById('day-prova2').value = g.provA2 || '';
    document.getElementById('day-ddt2').value = g.ddt2 || '';

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
  document.getElementById('day-close-x').addEventListener('click', closeDayEditor);

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
    var a2Val = document.getElementById('day-a2').value.trim().toUpperCase();
    var provA2Val = document.getElementById('day-prova2').value.trim().toUpperCase();
    if (a2Val && !provA2Val) provA2Val = lookupProvincia(a2Val);
    var g = {
      da: daVal,
      provDa: document.getElementById('day-provda').value.trim().toUpperCase(),
      a: aVal,
      provA: provAVal,
      ddt: document.getElementById('day-ddt').value.trim(),
      a2: a2Val,
      provA2: provA2Val,
      ddt2: document.getElementById('day-ddt2').value.trim(),
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
    if (a2Val) {
      state.profile.frequent = state.profile.frequent || {};
      state.profile.frequent[a2Val] = (state.profile.frequent[a2Val] || 0) + 1;
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

  // Autocomplete wiring — reusable so the exact same behavior (search
  // suggestions, uppercase on pick, auto-filled province) applies to
  // every destination field, not just the first one. Each call wires up
  // one independent input/province/dropdown trio.
  function wireDestinationAutocomplete(inputId, provInputId, listId) {
    var input = document.getElementById(inputId);
    var list = document.getElementById(listId);
    if (!input || !list) return;
    function render(results) {
      if (!results.length) {
        list.innerHTML = '<div class="ac-empty">Nessun risultato — puoi digitare liberamente</div>';
        list.classList.add('show');
        return;
      }
      list.innerHTML = results.map(function (r) {
        return '<div class="ac-item" data-name="' + escapeHtml(r.name) + '" data-sigla="' + escapeHtml(r.sigla) + '"><span class="name">' + escapeHtml(r.name) + '</span>' + (r.sigla ? '<span class="prov">' + r.sigla + '</span>' : '') + '</div>';
      }).join('');
      list.classList.add('show');
      list.querySelectorAll('.ac-item').forEach(function (item) {
        item.addEventListener('click', function () {
          input.value = item.getAttribute('data-name').toUpperCase();
          document.getElementById(provInputId).value = item.getAttribute('data-sigla');
          list.classList.remove('show');
        });
      });
    }
    input.addEventListener('input', function () { render(searchComuni(input.value, 8)); });
    input.addEventListener('focus', function () { render(searchComuni(input.value, 8)); });
    document.addEventListener('click', function (e) {
      if (!list.contains(e.target) && e.target !== input) list.classList.remove('show');
    });
  }
  wireDestinationAutocomplete('day-a', 'day-prova', 'ac-list');
  wireDestinationAutocomplete('day-a2', 'day-prova2', 'ac-list2');

  /* ---------------------------------------------------------------- */
  /* Settings / onboarding modal                                       */
  /* ---------------------------------------------------------------- */
  var settingsModal = document.getElementById('modal-settings');
  var emailModal = document.getElementById('modal-email-required');
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

    // The "Account" row (showing the confirmed email + reminder/logout)
    // only makes sense in the main settings view, and only once there
    // actually is a confirmed account to show — a per-sheet override
    // edit isn't the place to manage login, and first-run has nothing to
    // show yet either.
    var accountRow = document.getElementById('settings-account-row');
    if (settingsTargetSheet || !emailIsSatisfied()) {
      accountRow.classList.add('hidden');
    } else {
      accountRow.classList.remove('hidden');
      document.getElementById('account-email-display').textContent = currentAccountEmail();
    }

    settingsModal.classList.add('open');
  }

  // Whether the "email required" condition is currently satisfied —
  // strict: only an actually-confirmed email counts, not merely having
  // sent a link and being unconfirmed. Confirmed via either a real local
  // session, OR a server-verified confirmation for the email this device
  // already asked to confirm — the second path exists because clicking
  // the magic link opens a *different* browser context than the
  // installed app on iOS (they don't share local storage at all), so
  // checking local state alone can never see a confirmation that
  // happened elsewhere.
  function emailIsSatisfied() {
    var session = getAuthSession();
    if (session && session.email) return true;
    return !!(state.profile.emailConfirmed && state.profile.pendingEmail);
  }

  // The best email currently known for this device — a confirmed session
  // if one exists, otherwise whatever the person already typed in and is
  // waiting to confirm. Used anywhere data gets synced, so the admin view
  // can see who this is even before that confirmation click happens.
  function currentAccountEmail() {
    var session = getAuthSession();
    return (session && session.email) || state.profile.pendingEmail || null;
  }

  // Shows the dedicated, minimal "confirm your email" step — used right
  // after Salva on first setup, and on its own (skipping the full
  // Benvenuto/Impostazioni sheet entirely) for anyone who already has a
  // saved profile from before this requirement existed.
  function openEmailRequiredModal() {
    renderEmailRequiredModal();
    emailModal.classList.add('open');
  }

  // While this modal is showing the "waiting to confirm" state, this asks
  // the SERVER directly whether the pending email has been confirmed yet
  // — not just local storage, since the confirmation click very often
  // happens in a completely separate browser storage context (installed
  // app vs. a regular Safari tab, on iOS in particular).
  var emailConfirmWatcher = null;
  function checkForConfirmationNow() {
    var session = getAuthSession();
    if (session && session.email) {
      stopWatchingForConfirmation();
      onEmailConfirmed();
      return;
    }
    var email = state.profile.pendingEmail;
    if (!email) return;
    fetch(SUPABASE_URL + '/functions/v1/check-email-confirmed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY },
      body: JSON.stringify({ email: email })
    }).then(function (res) { return res.json(); })
      .then(function (data) {
        if (data && data.confirmed) {
          stopWatchingForConfirmation();
          state.profile.emailConfirmed = true;
          saveProfile(state.profile);
          onEmailConfirmed();
        }
      })
      .catch(function () { /* offline or blocked — the next poll tick simply retries */ });
  }

  // Runs once, quietly, whenever the app opens and locally believes its
  // email is already confirmed — double-checks that belief against the
  // server, since a browser tab and the installed app never share local
  // storage on iOS, so "Esci" or "Elimina tutti i dati" done in ONE of
  // them leaves the OTHER with no way to know the account was just
  // freed up. A genuine mismatch resets local state and asks again,
  // instead of silently trusting a fact that may no longer be true.
  function revalidateEmailWithServer() {
    var email = currentAccountEmail();
    if (!email) return;
    fetch(SUPABASE_URL + '/functions/v1/check-email-confirmed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY },
      body: JSON.stringify({ email: email })
    }).then(function (res) { return res.json(); })
      .then(function (data) {
        if (data && data.confirmed === false) {
          logoutAccount();
          state.profile.pendingEmail = '';
          state.profile.emailConfirmed = false;
          saveProfile(state.profile);
          document.getElementById('settings-account-row').classList.add('hidden');
          openEmailRequiredModal();
        }
      })
      .catch(function () { /* offline or blocked — nothing to correct right now, try again next open */ });
    // Beyond that one-time check, also hold a live connection watching
    // for this account being deleted WHILE the app stays open — so if
    // that happens (e.g. "Esci" pressed in a browser tab elsewhere),
    // this device notices within about a second, not just next time it
    // happens to reopen.
    watchForAccountDeletion(email);
  }

  var accountDeletionChannel = null;
  function watchForAccountDeletion(email) {
    if (accountDeletionChannel) { supabaseClient.removeChannel(accountDeletionChannel); accountDeletionChannel = null; }
    if (!supabaseClient || !email) return;
    accountDeletionChannel = supabaseClient
      .channel('email-deletion-' + email)
      .on('postgres_changes', {
        event: 'DELETE', schema: 'public', table: 'email_confirmations',
        filter: 'email=eq.' + email
      }, function () { revalidateEmailWithServer(); })
      .subscribe();
  }

  var emailConfirmRealtimeChannel = null;
  function startWatchingForConfirmation() {
    stopWatchingForConfirmation();
    checkForConfirmationNow(); // check right away too, not just after the first tick

    // The live connection is the primary mechanism — near-instant,
    // regardless of which context (this one, a browser tab, another
    // device) actually triggered the confirmation. Polling underneath is
    // just a safety net, in case the live connection can't be
    // established for some reason (network quirks, etc.).
    var email = state.profile.pendingEmail;
    if (supabaseClient && email) {
      emailConfirmRealtimeChannel = supabaseClient
        .channel('email-confirm-' + email)
        .on('postgres_changes', {
          event: '*', schema: 'public', table: 'email_confirmations',
          filter: 'email=eq.' + email
        }, function (payload) {
          if (payload.eventType === 'DELETE') return; // a deletion here just means "not confirmed yet", not relevant mid-registration
          if (payload.new && payload.new.confirmed) checkForConfirmationNow();
        })
        .subscribe();
    }
    emailConfirmWatcher = setInterval(checkForConfirmationNow, 4000);
  }
  function stopWatchingForConfirmation() {
    if (emailConfirmWatcher) { clearInterval(emailConfirmWatcher); emailConfirmWatcher = null; }
    if (emailConfirmRealtimeChannel) { supabaseClient.removeChannel(emailConfirmRealtimeChannel); emailConfirmRealtimeChannel = null; }
  }
  function onEmailConfirmed() {
    toast('Email confermata!');
    emailModal.classList.remove('open');
    // Push the now-confirmed email (plus everything else) right away —
    // otherwise the admin view would keep showing this device with no
    // email until whatever the NEXT unrelated save/sync happened to be.
    if (state.profile.nome && state.profile.targa) reportActivity();
    startPresence();
    updatePresenceIfActive();
    // Keep watching, live, in case this same account gets deleted later
    // (e.g. from a browser tab) while this device stays open.
    watchForAccountDeletion(currentAccountEmail());
    render();
    reloadIfUpdatePending();
  }

  // A single, accurate error message for every "send the link" button —
  // Supabase enforces roughly one request per email per minute, and
  // hitting that is a completely normal, expected thing (not a real
  // connection problem), so it deserves its own clear message instead of
  // a generic, misleading "check your connection".
  function magicLinkErrorMessage(err) {
    if (err && err.rateLimited) return 'Hai già richiesto un link da poco — aspetta un minuto e riprova';
    return 'Invio non riuscito — controlla la connessione e riprova';
  }

  document.getElementById('account-send-btn').addEventListener('click', function () {
    var email = document.getElementById('in-account-email').value.trim();
    if (!email || email.indexOf('@') === -1) { toast('Inserisci un\'email valida'); return; }
    var btn = this;
    btn.disabled = true;
    // No longer blocks on "already confirmed elsewhere" — that check
    // was meant to stop two different people sharing one email, but it
    // also caught the far more common, entirely legitimate case: the
    // same driver confirming once in a browser tab, then again from the
    // installed app (which has its own separate local storage on iOS,
    // so it never "sees" the browser's earlier confirmation). Supabase
    // itself never creates a second account for one email regardless of
    // how many times it's confirmed, and the admin view already groups
    // by name+targa, not by device — so this was pure friction with no
    // real protective benefit.
    requestMagicLink(email)
      .then(function () {
        state.profile.pendingEmail = email;
        saveProfile(state.profile);
        toast('✓ Email inviata — controlla la tua posta');
        renderEmailRequiredModal();
      })
      .catch(function (err) { if (!err || !err.alreadyHandled) toast(magicLinkErrorMessage(err)); })
      .then(function () { btn.disabled = false; });
  });

  // Renders the two possible states of the dedicated email modal: still
  // needs an email typed in and sent, or already sent and waiting on
  // confirmation. (The "confirmed" case never renders here — the modal
  // closes itself the moment that happens, via onEmailConfirmed.)
  function renderEmailRequiredModal() {
    var loggedOut = document.getElementById('account-logged-out');
    var pending = document.getElementById('account-pending');
    if (state.profile.pendingEmail && !emailIsSatisfied()) {
      loggedOut.classList.add('hidden');
      pending.classList.remove('hidden');
      document.getElementById('account-pending-email-display').textContent = state.profile.pendingEmail;
      startWatchingForConfirmation();
    } else {
      stopWatchingForConfirmation();
      loggedOut.classList.remove('hidden');
      pending.classList.add('hidden');
      document.getElementById('in-account-email').value = '';
    }
  }

  document.getElementById('account-remind-pending-btn').addEventListener('click', function () {
    var email = state.profile.pendingEmail;
    if (!email) return;
    var btn = this;
    btn.disabled = true;
    requestMagicLink(email)
      .then(function () { toast('Link inviato di nuovo a: ' + email); })
      .catch(function (err) { toast(magicLinkErrorMessage(err)); })
      .then(function () { btn.disabled = false; });
  });

  document.getElementById('account-remind-btn').addEventListener('click', function () {
    var session = getAuthSession();
    if (!session || !session.email) return;
    var btn = this;
    btn.disabled = true;
    requestMagicLink(session.email)
      .then(function () { toast('Promemoria inviato a: ' + session.email); })
      .catch(function (err) { toast(magicLinkErrorMessage(err)); })
      .then(function () { btn.disabled = false; });
  });

  document.getElementById('account-logout-btn').addEventListener('click', function () {
    // Destructive-ish action (frees up the email, requires re-confirming
    // to use the app again) — asks twice before doing anything, same
    // pattern as "Elimina tutti i dati".
    showConfirm({
      title: 'Uscire dal tuo account?',
      message: 'Dovrai confermare di nuovo la tua email per continuare a usare l\'app.',
      danger: true,
      confirmLabel: 'Continua',
      onConfirm: function () {
        showConfirm({
          title: 'Sei sicuro?',
          message: 'Questa email tornerà disponibile per una nuova registrazione, e dovrai confermarla di nuovo su questo telefono.',
          danger: true,
          confirmLabel: 'Esci',
          onConfirm: function () {
            // Free up this email on the server too, not just locally —
            // otherwise it would stay "confirmed" forever there,
            // blocking anyone (including this same person, later) from
            // ever registering it again.
            var emailToFree = currentAccountEmail();
            if (emailToFree) {
              fetch(SUPABASE_URL + '/functions/v1/delete-auth-account', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY },
                body: JSON.stringify({ email: emailToFree })
              }).catch(function () { /* best-effort — local logout still proceeds either way */ });
            }
            logoutAccount();
            state.profile.pendingEmail = '';
            state.profile.emailConfirmed = false;
            saveProfile(state.profile);
            document.getElementById('settings-account-row').classList.add('hidden');
            toast('Disconnesso');
            openEmailRequiredModal();
          }
        });
      }
    });
  });
  document.getElementById('btn-settings').addEventListener('click', function () { openSettingsModal(null); });
  document.getElementById('btn-navigatore').addEventListener('click', function () { showScreen('navigatore'); });
  document.getElementById('settings-cancel').addEventListener('click', function () {
    if (!state.profile.nome && !settingsTargetSheet) return; // force first-run completion
    settingsModal.classList.remove('open');
    reloadIfUpdatePending();
  });
  document.getElementById('settings-close-x').addEventListener('click', function () {
    document.getElementById('settings-cancel').click();
  });
  settingsModal.addEventListener('click', function (e) {
    if (e.target === settingsModal) document.getElementById('settings-cancel').click();
  });
  // The email modal has no close/cancel control at all — by design, it
  // cannot be dismissed until the email is actually confirmed (that's the
  // whole point of it existing separately). A stray click on the
  // backdrop should not close it either.
  document.getElementById('settings-save').addEventListener('click', function () {
    var nome = document.getElementById('in-nome').value.trim();
    var targa = document.getElementById('in-targa').value.trim().toUpperCase();
    var conto = document.getElementById('in-conto').value.trim().toUpperCase() || 'BARCELLA';
    var da = (document.getElementById('in-da').value.trim() || 'Ponte San Nicolò').toUpperCase();
    var provDa = document.getElementById('in-prov-da').value.trim().toUpperCase() || 'PD';
    var dailyRateRaw = document.getElementById('in-daily-rate').value.trim();
    var dailyRate = dailyRateRaw === '' ? '' : Math.max(0, parseFloat(dailyRateRaw) || 0);

    if (!nome || !targa) { toast('Inserisci nome e targa'); return; }

    var wasFirstRun = !state.profile.nome;

    state.profile.nome = nome; state.profile.targa = targa; state.profile.perContoDi = conto;
    state.profile.da = da; state.profile.provDa = provDa;
    state.profile.dailyRate = dailyRate;
    saveProfile(state.profile);
    startPresence(); // profile is minimally ready now — no need to wait for anything else

    if (settingsTargetSheet) {
      settingsTargetSheet.nome = nome; settingsTargetSheet.targa = targa; settingsTargetSheet.perContoDi = conto;
      settingsTargetSheet.countsForDailyRate = document.getElementById('in-sheet-daily-rate').checked;
      saveSheets(state.sheets);
    }

    settingsModal.classList.remove('open');
    toast('Dati salvati');
    render();

    // First time ever completing the welcome screen — immediately follow
    // up with the dedicated email step, right after this one closes.
    // Existing profiles that still need email get sent here too, but
    // that path is normally reached directly from init(), never by
    // passing through this whole form again.
    if (wasFirstRun && !emailIsSatisfied()) {
      openEmailRequiredModal();
      return;
    }

    reportActivity();
    reloadIfUpdatePending();
  });

  /* ---------------------------------------------------------------- */
  /* Generic confirm modal                                             */
  /* ---------------------------------------------------------------- */
  var confirmModal = document.getElementById('modal-confirm');
  document.getElementById('confirm-close-x').addEventListener('click', function () {
    document.getElementById('confirm-cancel').click();
  });
  confirmModal.addEventListener('click', function (e) {
    if (e.target === confirmModal) document.getElementById('confirm-cancel').click();
  });
  function showConfirm(opts) {
    document.getElementById('confirm-title').textContent = opts.title;
    document.getElementById('confirm-sub').textContent = opts.message;
    var okBtn = document.getElementById('confirm-ok');
    okBtn.onclick = null; // defensively drop any stale handler a previous, different use of this shared dialog (e.g. the new-sheet flow) might have left attached directly
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
    var templateOptions = Object.keys(PDF_TEMPLATES).map(function (key) {
      var t = PDF_TEMPLATES[key];
      var selected = key === DEFAULT_PDF_TEMPLATE ? ' selected' : '';
      return '<option value="' + key + '"' + selected + '>' + t.code + ' — ' + t.name + '</option>';
    }).join('');
    var stepperHtml =
      '<div class="month-stepper"><button id="ms-prev">−</button><div class="mval" id="ms-val">' + MESI[m - 1] + ' ' + y + '</div><button id="ms-next">+</button></div>' +
      '<div class="field" style="margin-top:8px;"><label>Per conto di</label><input id="ms-client" type="text" value="' + escapeHtml(client) + '" style="text-transform:uppercase"></div>' +
      '<div class="settings-driver-note" style="margin-top:-4px;">Se lavori per piu\' clienti nello stesso mese, crea un foglio separato per ciascuno — come su carta, un foglio per cliente.</div>' +
      '<div class="field"><label>Modello PDF per questo cliente</label><select id="ms-template">' + templateOptions + '</select></div>' +
      '<div class="settings-driver-note" style="margin-top:-4px;" id="ms-template-desc">' + PDF_TEMPLATES[DEFAULT_PDF_TEMPLATE].desc + '</div>' +
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
    document.getElementById('ms-template').addEventListener('change', function () {
      document.getElementById('ms-template-desc').textContent = PDF_TEMPLATES[this.value].desc;
    });
    // re-bind confirm to use latest m/y/client via closure workaround
    var okBtn = document.getElementById('confirm-ok');
    okBtn.onclick = function () {
      var chosenClient = (document.getElementById('ms-client').value || 'BARCELLA').trim().toUpperCase();
      var chosenTemplate = document.getElementById('ms-template').value;
      var countsForRate = document.getElementById('ms-daily-rate').checked;
      confirmModal.classList.remove('open');
      var existing = sheetForMonth(m, y, chosenClient);
      if (existing) {
        state.currentSheetId = existing.id; setCurrentSheetId(existing.id);
        toast('Foglio ' + MESI[m - 1] + ' ' + y + ' (' + chosenClient + ') già esistente — aperto');
        showScreen('foglio');
        reloadIfUpdatePending();
        okBtn.onclick = null; // don't let this stick around for the next, unrelated use of the shared confirm dialog
        return;
      }
      createSheet(m, y, chosenClient, countsForRate, chosenTemplate);
      toast('Nuovo foglio creato: ' + MESI[m - 1] + ' ' + y + ' — ' + chosenClient);
      showScreen('foglio');
      reportActivity();
      reloadIfUpdatePending();
      okBtn.onclick = null; // don't let this stick around for the next, unrelated use of the shared confirm dialog
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

  // Fuel receipts used to store, per day, a single {data,w,h} object —
  // later changed to a LIST of them, so a day could hold more than one
  // receipt. Anyone who had already saved a receipt before that change
  // still has it on disk in the old, single-object shape; without this
  // migration, the new list-based code doesn't recognize it (a day like
  // that would wrongly show as empty, and trying to add a new photo to
  // it would fail outright, since .push() doesn't exist on a plain
  // object) — wrapping the old value into a one-item list fixes both at
  // once, for every day, without losing the photo that was already there.
  function migrateFuelToArrays() {
    var changed = false;
    Object.keys(state.fuel).forEach(function (monthKey) {
      var monthFuel = state.fuel[monthKey];
      Object.keys(monthFuel).forEach(function (day) {
        var entry = monthFuel[day];
        if (entry && !Array.isArray(entry) && entry.data) {
          monthFuel[day] = [entry];
          changed = true;
        }
      });
    });
    if (changed) saveFuel(state.fuel);
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

  // A live connection to Supabase (via the vendored supabase-js library) —
  // this is what actually lets a browser tab and the installed app "see"
  // the same reality instantly: both hold their own independent
  // connection to the server, and the moment the server-side confirmation
  // status changes (however it happened, wherever), it pushes the update
  // to every connected client within roughly a second. Neither context
  // ever talks to the other directly — they don't need to, since they're
  // both just watching the same live server state.
  var supabaseClient = (typeof supabase !== 'undefined' && supabase.createClient)
    ? supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;
  var LS_DEVICE_ID = 'pt_device_id_v1';

  // Optional account (email only, no password) — lets ION recognize the
  // same person reliably across devices/reinstalls, for anyone who
  // chooses to register. Nothing about this blocks normal, no-account use
  // of the app; it only affects what appears in the admin view.
  var LS_AUTH_SESSION = 'pt_auth_session_v1';

  function getAuthSession() {
    try {
      var raw = localStorage.getItem(LS_AUTH_SESSION);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function setAuthSession(session) {
    try {
      if (session) localStorage.setItem(LS_AUTH_SESSION, JSON.stringify(session));
      else localStorage.removeItem(LS_AUTH_SESSION);
    } catch (e) { /* storage unavailable — session just won't persist */ }
  }

  // Sends the "magic link" email — no password anywhere in this flow.
  // Clicking the link in that email brings the person right back here,
  // already signed in.
  function requestMagicLink(email) {
    // Send just the first name as user metadata (not the full "Nome
    // Cognome") — this becomes available in the confirmation email
    // template as {{ .Data.first_name }}, so each person is greeted by
    // their own first name. Read straight from the input field (not
    // state.profile.nome), since "Invia" can be pressed before "Salva"
    // has ever committed the typed name to the saved profile.
    var typedNome = document.getElementById('in-nome') ? document.getElementById('in-nome').value : '';
    var firstName = (typedNome || state.profile.nome || '').trim().split(/\s+/)[0] || '';
    // Force the name up to date FIRST, via the admin API — Supabase's own
    // /auth/v1/otp only seems to set metadata the very first time an
    // email is used; on later requests for an existing account it keeps
    // whatever was captured back then, silently ignoring a new name
    // (e.g. after a driver re-registers, or corrects a typo). Best-effort:
    // if this fails for any reason, the email still gets sent below —
    // worst case is a stale name in that one email, not a blocked signup.
    return fetch(SUPABASE_URL + '/functions/v1/update-user-name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY },
      body: JSON.stringify({ email: email, first_name: firstName })
    }).catch(function () { /* best-effort — proceed to send the email regardless */ })
      .then(function () {
        return fetch(SUPABASE_URL + '/auth/v1/otp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': 'Bearer ' + SUPABASE_ANON_KEY
          },
          body: JSON.stringify({
            email: email,
            create_user: true,
            data: { first_name: firstName },
            options: { email_redirect_to: window.location.origin + '/email-confirmed.html' }
          })
        });
      }).then(function (res) {
      if (res.status === 429) {
        var err = new Error('rate_limited');
        err.rateLimited = true;
        throw err;
      }
      if (!res.ok) throw new Error('richiesta fallita');
      return true;
    });
  }

  // Runs once, early, on every page load — catches the redirect back from
  // a clicked magic-link email (Supabase appends the session tokens as a
  // URL fragment: #access_token=...&refresh_token=...), stores them as
  // the active session, then cleans the address bar so the tokens don't
  // linger visibly or get bookmarked/shared by accident.
  function handleAuthCallback() {
    var hash = window.location.hash;
    if (!hash || hash.indexOf('access_token') === -1) return;
    var params = new URLSearchParams(hash.replace(/^#/, ''));
    // Supabase's own server-side redirect (Site URL / Redirect URLs
    // settings) has proven unreliable to depend on — confirmations kept
    // landing back here instead of the dedicated confirmation page, even
    // with those settings verified correct on their end. Since this code
    // runs regardless, catch it ourselves: if this is a fresh
    // confirmation link, send the person straight to the proper page,
    // carrying the same token along so nothing about the actual
    // confirmation changes, just where it visually lands.
    var type = params.get('type');
    if (type === 'signup' || type === 'magiclink' || type === 'email') {
      window.location.replace('email-confirmed.html' + window.location.hash);
      return;
    }
    var accessToken = params.get('access_token');
    var refreshToken = params.get('refresh_token');
    if (!accessToken) return;
    // Decode the JWT payload just enough to read the email — no
    // verification needed here, it's only used for display; every actual
    // request to Supabase still carries the real token, which Supabase
    // itself verifies server-side.
    var email = null;
    try {
      var payload = JSON.parse(atob(accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      email = payload.email || null;
    } catch (e) { /* leave email null — session still works, just can't display it yet */ }
    setAuthSession({ access_token: accessToken, refresh_token: refreshToken, email: email });
    history.replaceState(null, '', window.location.pathname + window.location.search);
    toast(email ? ('Accesso effettuato: ' + email) : 'Accesso effettuato');
  }
  handleAuthCallback();

  function logoutAccount() {
    setAuthSession(null);
  }

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
    syncSheetSummaries();
    var active = latestSheet();
    var month = active ? active.month : null;
    var year = active ? active.year : null;
    var earnings = (month && year) ? monthEarnings(month, year) : { workedDaysCount: 0 };
    var deviceId = getDeviceId();
    var payload = {
      device_id: deviceId,
      nome: state.profile.nome,
      targa: state.profile.targa || '',
      last_active: new Date().toISOString(),
      worked_days_this_month: earnings.workedDaysCount || 0,
      active_month: month,
      active_year: year,
      account_email: currentAccountEmail(),
      updated_at: new Date().toISOString()
    };
    // A genuine, native upsert — reliable now that anon has SELECT
    // permission on this table (PostgreSQL requires it for the UPDATE
    // path of INSERT ... ON CONFLICT DO UPDATE, even with INSERT/UPDATE
    // otherwise fully granted — without it, this silently failed to
    // find/update existing rows).
    fetch(SUPABASE_URL + '/rest/v1/driver_activity?on_conflict=device_id', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify(payload)
    }).catch(function () { /* offline or blocked — never blocks the app */ });
  }

  // High-frequency "live" signal, separate from reportActivity (which
  // only fires on meaningful save actions) — this is a lightweight ping,
  // sent often while the app is actually open and visible, so the admin
  // view can show a real live/offline status, not just "last saved
  // something a while ago".
  // "Live now" status, done the way large apps actually do it — genuine
  // WebSocket presence, not a periodic database write that something has
  // to interpret as "recent enough to count as online". The device joins
  // a shared Realtime channel while the app is open; the moment its
  // connection drops (tab closed, app closed, network lost), Supabase
  // itself removes it from presence automatically — no heartbeat timer,
  // no timestamp math, no possibility of a write silently not landing.
  var presenceChannel = null;
  function setPresenceDiagnostic(text) {
    var el = document.getElementById('presence-diagnostic');
    if (el) el.textContent = 'Live: ' + text;
  }
  function startPresence() {
    if (!supabaseClient) { setPresenceDiagnostic('client Supabase lipsa'); return; }
    if (!state.profile.nome) { setPresenceDiagnostic('profil incomplet'); return; }
    if (presenceChannel) return; // already connecting/connected
    setPresenceDiagnostic('conectare...');
    var deviceId = getDeviceId();
    presenceChannel = supabaseClient.channel('drivers-presence', { config: { presence: { key: deviceId } } });
    presenceChannel.subscribe(function (status, err) {
      if (status === 'SUBSCRIBED') {
        setPresenceDiagnostic('conectat, trimit prezenta...');
        presenceChannel.track({
          nome: state.profile.nome, targa: state.profile.targa || '',
          account_email: currentAccountEmail(), online_at: new Date().toISOString()
        }).then(function (trackStatus) {
          setPresenceDiagnostic('trimis (' + trackStatus + ') — email: ' + (currentAccountEmail() || 'NICIUNUL'));
        });
      } else if (status === 'CHANNEL_ERROR') {
        setPresenceDiagnostic('eroare conexiune: ' + (err ? err.message : '?'));
      } else if (status === 'TIMED_OUT') {
        setPresenceDiagnostic('timeout conexiune');
      } else if (status === 'CLOSED') {
        setPresenceDiagnostic('conexiune inchisa');
      }
    });
  }
  function updatePresenceIfActive() {
    if (presenceChannel) {
      presenceChannel.track({
        nome: state.profile.nome, targa: state.profile.targa || '',
        account_email: currentAccountEmail(), online_at: new Date().toISOString()
      });
    }
  }
  // Explicitly signals "no longer live" the moment the app is put away —
  // waiting for the WebSocket itself to notice a dropped connection can
  // take a while (it's designed to tolerate brief network hiccups without
  // flickering offline), which made the live indicator feel laggy on
  // exit. Marking presence gone immediately on hide, and re-joining
  // immediately on return, makes both directions feel instant instead of
  // relying purely on connection-level detection for going offline.
  function stopPresence() {
    if (presenceChannel) { presenceChannel.untrack(); }
  }


  // Pushes a lightweight summary (km + days worked, no photos or PDFs —
  // those never leave the phone) for every sheet this device has, so the
  // admin view can show real activity without needing to see receipts.
  function syncSheetSummaries() {
    if (!state.profile.nome) return;
    var deviceId = getDeviceId();
    var dailyRate = (state.profile.dailyRate === "" || state.profile.dailyRate === undefined) ? null : Number(state.profile.dailyRate);
    state.sheets.forEach(function (sheet) {
      var kt = sheetKmAndTrips(sheet);
      var client = (sheet.perContoDi || '').trim().toUpperCase() || '(nessuno)';
      var payload = {
        device_id: deviceId, sheet_id: sheet.id, month: sheet.month, year: sheet.year, client: client,
        total_km: kt.km || 0,
        giorni_count: kt.viaggi || 0,
        daily_rate: dailyRate,
        account_email: currentAccountEmail(),
        updated_at: new Date().toISOString()
      };
      // Matched on the sheet's own stable local id, NOT on the client
      // name — a client name is just data on the sheet, and can be
      // edited later (fixing a typo, or genuinely renaming it) without
      // that turning into a brand-new phantom row in admin alongside the
      // old one. The one real sheet stays the one real row, always.
      fetch(SUPABASE_URL + '/rest/v1/driver_sheets_summary?on_conflict=device_id,sheet_id', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
          'Prefer': 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify(payload)
      }).catch(function () { /* offline or blocked — silently skip */ });
    });
  }

  /* ---------------------------------------------------------------- */
  /* "Install app" banner — platform-aware, since the two mobile         */
  /* platforms genuinely need different things here:                    */
  /*  - Android/Chrome fires beforeinstallprompt when it considers the   */
  /*    site installable; capturing that event lets a button inside the  */
  /*    instructions modal trigger the native install dialog directly.   */
  /*  - iOS Safari doesn't support that API at all — there is no event   */
  /*    to listen for and no programmatic way to trigger "Add to Home    */
  /*    Screen"; it's always a manual step through the Share sheet.      */
  /* Both platforms open the SAME instructions modal (tabs let anyone    */
  /* check the other platform's steps too — useful when showing a       */
  /* colleague on a different phone what to do); Android's tab also      */
  /* shows a direct "Installa ora" button when the native prompt is      */
  /* actually available.                                                 */
  /* ---------------------------------------------------------------- */
  var LS_INSTALL_DISMISSED = 'pt_install_dismissed_v1';
  var deferredInstallPrompt = null;
  function isStandaloneMode() {
    return (window.navigator && window.navigator.standalone === true) ||
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  }
  function isIOSDevice() {
    var ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
  }
  function isAndroidDevice() {
    return /Android/.test(navigator.userAgent || '');
  }
  function updateInstallVisibility() {
    var dismissed = localStorage.getItem(LS_INSTALL_DISMISSED) === '1';
    var isMobile = isIOSDevice() || isAndroidDevice();
    var installable = isMobile && !isStandaloneMode();
    var banner = document.getElementById('install-banner');
    // Dismissing the top banner only hides THAT banner — it's an
    // unsolicited interruption, so closing it should stick. The option
    // inside the "Altre opzioni" menu is different: nobody sees it
    // unless they deliberately go looking for it, so it stays available
    // there regardless of whether the banner was ever dismissed (this
    // also means anyone who dismissed the OLD banner design, before
    // this option existed in its current form, doesn't lose access to
    // it permanently without realizing why).
    if (banner) banner.classList.toggle('hidden', !(installable && !dismissed));
    var moreOptInstall = document.getElementById('more-opt-install');
    if (moreOptInstall) moreOptInstall.classList.toggle('hidden', !installable);
  }
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault(); // stop Chrome's own mini-infobar; we show our own flow instead
    deferredInstallPrompt = e;
    updateInstallHelpTab(); // in case the modal happens to already be open
  });
  window.addEventListener('appinstalled', function () {
    deferredInstallPrompt = null;
    updateInstallVisibility();
  });
  document.getElementById('install-banner-close').addEventListener('click', function () {
    localStorage.setItem(LS_INSTALL_DISMISSED, '1');
    updateInstallVisibility();
  });
  updateInstallVisibility();

  var installHelpModal = document.getElementById('modal-install-help');
  var currentInstallTab = isAndroidDevice() ? 'android' : 'ios'; // default guess; iOS is the fallback for desktop testing too
  function updateInstallHelpTab() {
    document.getElementById('install-tab-ios').classList.toggle('active', currentInstallTab === 'ios');
    document.getElementById('install-tab-android').classList.toggle('active', currentInstallTab === 'android');
    document.getElementById('install-steps-ios').classList.toggle('hidden', currentInstallTab !== 'ios');
    document.getElementById('install-steps-android').classList.toggle('hidden', currentInstallTab !== 'android');
    var directBtn = document.getElementById('install-help-direct-btn');
    directBtn.classList.toggle('hidden', !(currentInstallTab === 'android' && deferredInstallPrompt));
  }
  function openInstallHelp() {
    currentInstallTab = isAndroidDevice() ? 'android' : 'ios';
    updateInstallHelpTab();
    installHelpModal.classList.add('open');
  }
  document.querySelectorAll('.install-tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      currentInstallTab = tab.getAttribute('data-platform');
      updateInstallHelpTab();
    });
  });
  document.getElementById('install-help-direct-btn').addEventListener('click', function () {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    deferredInstallPrompt.userChoice.then(function () {
      // Whether accepted or dismissed, this specific prompt instance is
      // spent — Chrome will fire a fresh beforeinstallprompt later if
      // still applicable.
      deferredInstallPrompt = null;
      updateInstallHelpTab();
    });
  });
  document.getElementById('install-cta-btn').addEventListener('click', openInstallHelp);

  function shareApp() {
    var shareUrl = window.location.origin + '/'; // clean root link, regardless of exact path the app happened to launch from (e.g. installed PWAs open at "/index.html" per the manifest's start_url)
    var shareText = 'ADB Smart — l\'app che uso per registrare i viaggi in modo semplice. Provala anche tu:';
    if (navigator.share) {
      navigator.share({ title: 'ADB Smart', text: shareText, url: shareUrl }).catch(function () { /* person cancelled the native share sheet — not an error */ });
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      // Desktop browsers mostly lack the Web Share API — copy the link
      // instead, so there's still a one-tap way to grab it.
      navigator.clipboard.writeText(shareText + ' ' + shareUrl)
        .then(function () { toast('Link copiato — incollalo dove preferisci'); })
        .catch(function () { toast('Link: ' + shareUrl); });
    } else {
      toast('Link: ' + shareUrl);
    }
  }

  function confirmDeleteAllData() {
    // A rare, deliberately destructive action, so it asks TWICE before
    // doing anything, and clears absolutely everything for this origin
    // (every sheet, every fuel receipt, the profile) in one go, then
    // reloads straight into a genuinely fresh first-run state — the
    // same thing a brand new install would look like.
    showConfirm({
      title: 'Eliminare tutti i dati?',
      message: 'Verranno cancellati definitivamente tutti i fogli, gli scontrini e il profilo salvati su questo telefono.',
      danger: true,
      confirmLabel: 'Continua',
      onConfirm: function () {
        showConfirm({
          title: 'Sei sicuro? Non si può annullare',
          message: 'Questa è l\'ultima conferma — una volta eliminati, questi dati non si possono più recuperare.',
          danger: true,
          confirmLabel: 'Elimina tutto',
          onConfirm: function () {
            // Free up the email on the server too, exactly like "Esci"
            // does — otherwise it would stay "confirmed" there forever,
            // even though every trace of it just got wiped locally,
            // blocking this same person from ever registering it again
            // if they decide to start over. Unlike "Esci" though, this
            // is a genuinely complete wipe — also asks the server to
            // remove this device's rows from the admin view entirely,
            // not just free the email.
            var emailToFree = currentAccountEmail();
            if (emailToFree) {
              fetch(SUPABASE_URL + '/functions/v1/delete-auth-account', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY },
                body: JSON.stringify({ email: emailToFree, wipe_activity_data: true, device_id: getDeviceId() })
              }).catch(function () { /* best-effort — local wipe still proceeds either way */ });
            }
            try { localStorage.clear(); } catch (e) { /* ignore */ }
            window.location.reload();
          }
        });
      }
    });
  }

  // "Altre opzioni" — a single small menu bundling three occasional,
  // non-everyday actions (share, install, delete-everything), instead of
  // three separate buttons cluttering the main Settings screen.
  var moreOptionsModal = document.getElementById('modal-more-options');
  document.getElementById('settings-more-btn').addEventListener('click', function () {
    updateInstallVisibility(); // refresh in case something changed since Settings opened
    moreOptionsModal.classList.add('open');
  });
  document.getElementById('more-options-close-x').addEventListener('click', function () {
    moreOptionsModal.classList.remove('open');
  });
  moreOptionsModal.addEventListener('click', function (e) {
    if (e.target === moreOptionsModal) moreOptionsModal.classList.remove('open');
  });
  // Manual "check for updates" — the app already checks automatically
  // (on open, when it comes back to the foreground, and every 60s while
  // open), but this gives an immediate, deliberate way to check right
  // now, with clear feedback either way, for anyone who wants that
  // reassurance rather than waiting.
  document.getElementById('more-opt-refresh').addEventListener('click', function () {
    moreOptionsModal.classList.remove('open');
    toast('Verifica aggiornamenti in corso…');
    fetch('version.json', { cache: 'no-store' })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data && data.v && data.v !== APP_VERSION) {
          toast('Nuova versione trovata — aggiornamento in corso…');
          setTimeout(function () { window.location.reload(); }, 600);
        } else {
          toast('Hai già la versione più recente ✓');
        }
      })
      .catch(function () {
        toast('Impossibile verificare — controlla la connessione');
      });
  });
  document.getElementById('more-opt-share').addEventListener('click', function () {
    moreOptionsModal.classList.remove('open');
    shareApp();
  });
  document.getElementById('more-opt-install').addEventListener('click', function () {
    moreOptionsModal.classList.remove('open');
    openInstallHelp();
  });
  // Backup / restore — a real safety net for anyone worried about
  // losing data (e.g. before removing and re-adding the home screen
  // icon, which is sometimes needed to pick up a new name/icon, though
  // the underlying data itself is tied to the website's storage, not the
  // shortcut, and normally survives that on its own). Exports every
  // piece of real data into one JSON file the person can keep anywhere.
  function exportBackup() {
    var backup = {
      exportedAt: new Date().toISOString(),
      appVersion: APP_VERSION,
      profile: JSON.parse(localStorage.getItem(LS_PROFILE) || 'null'),
      sheets: JSON.parse(localStorage.getItem(LS_SHEETS) || 'null'),
      currentSheetId: localStorage.getItem(LS_CURRENT),
      fuel: JSON.parse(localStorage.getItem(LS_FUEL) || 'null')
    };
    var blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    var dateStr = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = 'ADB-Smart-backup-' + dateStr + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast('Backup salvato — controlla i tuoi download');
  }
  function restoreBackup(file) {
    var reader = new FileReader();
    reader.onload = function (e) {
      var data;
      try { data = JSON.parse(e.target.result); } catch (err) { toast('File non valido'); return; }
      if (!data || (!data.sheets && !data.profile)) { toast('File di backup non riconosciuto'); return; }
      var dateLabel = data.exportedAt ? new Date(data.exportedAt).toLocaleDateString('it-IT') : 'data sconosciuta';
      showConfirm({
        title: 'Ripristinare questo backup?',
        message: 'I dati attuali su questo telefono (foglio, scontrini, profilo) verranno sostituiti con quelli del file (' + dateLabel + '). Questa azione non può essere annullata.',
        danger: true,
        confirmLabel: 'Ripristina',
        onConfirm: function () {
          if (data.profile) localStorage.setItem(LS_PROFILE, JSON.stringify(data.profile));
          if (data.sheets) localStorage.setItem(LS_SHEETS, JSON.stringify(data.sheets));
          if (data.currentSheetId) localStorage.setItem(LS_CURRENT, data.currentSheetId);
          if (data.fuel) localStorage.setItem(LS_FUEL, JSON.stringify(data.fuel));
          window.location.reload();
        }
      });
    };
    reader.readAsText(file);
  }
  document.getElementById('more-opt-backup').addEventListener('click', function () {
    moreOptionsModal.classList.remove('open');
    exportBackup();
  });
  document.getElementById('more-opt-restore').addEventListener('click', function () {
    moreOptionsModal.classList.remove('open');
    document.getElementById('in-restore-backup').click();
  });
  document.getElementById('in-restore-backup').addEventListener('change', function (e) {
    var file = e.target.files[0];
    if (file) restoreBackup(file);
    e.target.value = '';
  });

  document.getElementById('more-opt-delete').addEventListener('click', function () {
    moreOptionsModal.classList.remove('open');
    confirmDeleteAllData();
  });
  document.getElementById('install-help-close-x').addEventListener('click', function () {
    installHelpModal.classList.remove('open');
  });
  installHelpModal.addEventListener('click', function (e) {
    if (e.target === installHelpModal) installHelpModal.classList.remove('open');
  });

  function init() {
    migrateUppercaseLocalities();
    migrateFuelToArrays();
    reportActivity();
    syncBarHeights();
    window.addEventListener('resize', syncBarHeights);
    window.addEventListener('orientationchange', function () { setTimeout(syncBarHeights, 200); });

    // Tapping the dimmed backdrop (outside the sheet itself) closes
    // whichever modal is open — same convention as every native picker
    // and virtually every modal on the web. Wired once, globally, for
    // every ".modal-overlay" in the app, rather than per-modal, so new
    // modals get this for free. The one deliberate exception is the
    // mandatory email-confirmation modal, which by design can't be
    // dismissed until the email is actually confirmed.
    document.addEventListener('click', function (e) {
      if (!e.target.classList || !e.target.classList.contains('modal-overlay')) return;
      if (e.target.id === 'modal-email-required') return;
      e.target.classList.remove('open');
    });

    // iOS often "resumes" an installed app from a suspended state instead
    // of doing a real page load — the whole JS context (including the
    // topbar-height measurement taken at the very first load) is just
    // left as-is while the app was in the background. If that first
    // measurement was ever off (e.g. taken a frame too early, before
    // fonts/layout settled), or the page had drifted to a slightly
    // scrolled position before being backgrounded, the top card could
    // end up sitting partly behind the fixed top bar when the person
    // reopens the app, with no ordinary scroll gesture able to fix it
    // since it isn't a real scroll-position problem. Re-measuring and
    // resetting scroll every time the app becomes visible again makes
    // this self-correct automatically, at zero cost while the app is
    // actually in use.
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        syncBarHeights();
        if (currentScreen === 'home' && mainEl) mainEl.scrollTop = 0;
      }
    });

    // hidden logo image used for PDF embedding — the bundled Power Trasporti
    // logo.
    var img = new Image();
    img.id = 'pt-logo-img';
    img.src = 'vendor/logo.png';
    img.style.display = 'none';
    document.body.appendChild(img);

    if (!state.profile.nome || !state.profile.targa) {
      // Brand-new profile — the full Benvenuto flow (name/targa/etc.)
      // comes first; the dedicated email step follows automatically
      // right after Salva, from inside that handler.
      openSettingsModal(null);
    } else if (!emailIsSatisfied()) {
      // Existing profile from before this requirement existed (or email
      // was never finished) — skip straight to the small, dedicated
      // email step, without re-showing the whole profile form again.
      openEmailRequiredModal();
    } else {
      // Locally, this device believes its email is confirmed — but that
      // belief can go stale: a browser tab and the installed app are
      // separate storage contexts on iOS, so if the person logs out (or
      // deletes their account) from ONE of them, the OTHER has no way to
      // know that happened on its own. Rather than trusting local state
      // forever, quietly re-check with the server in the background; if
      // it turns out this email genuinely isn't confirmed anymore, reset
      // locally and ask again — keeping this device honest about its
      // actual state instead of showing a false "all good".
      revalidateEmailWithServer();
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
    //
    // Two independent mechanisms below (the service worker's own update
    // cycle, and a direct version-file check — the second exists because
    // iOS is known to delay or skip the first one for installed apps) can
    // both decide a reload is needed. Without coordination, that risked
    // exactly the instability a driver reported — the app reloading
    // itself repeatedly, in a rapid, flashing loop, especially right
    // after a fresh release goes out and different checks briefly see
    // slightly different states. A SINGLE shared gate, respected by both,
    // guarantees at most one reload actually happens, and a real minimum
    // gap (persisted in sessionStorage, so it survives the reload itself)
    // stops any chain of reloads from ever forming, not just duplicate
    // reloads within one page load.
    var RELOAD_COOLDOWN_MS = 20000;
    var reloadTriggeredThisLoad = false;
    function recentlyReloaded() {
      try {
        var last = sessionStorage.getItem('pt_last_auto_reload');
        return !!(last && (Date.now() - parseInt(last, 10)) < RELOAD_COOLDOWN_MS);
      } catch (e) { return false; } // sessionStorage unavailable — don't block updating over this
    }
    function triggerReload() {
      if (reloadTriggeredThisLoad || recentlyReloaded()) return;
      var modalOpen = document.querySelector('.modal-overlay.open');
      // Active turn-by-turn navigation is just as disruptive to
      // interrupt as an open modal — worse, actually: it's a driver
      // mid-trip. nav-active-overlay isn't a ".modal-overlay", so it
      // was never covered by the check above; a reload could otherwise
      // land in the middle of an active trip and silently discard it.
      var navOverlay = document.getElementById('nav-active-overlay');
      var navigatingActively = navOverlay && navOverlay.style.display !== 'none';
      if (modalOpen || navigatingActively) {
        pendingReloadAfterModalClose = true;
        if (!navigatingActively) toast('Nuova versione pronta — verrà applicata alla chiusura di questa finestra');
        return;
      }
      reloadTriggeredThisLoad = true;
      var doReload = function () {
        try { sessionStorage.setItem('pt_last_auto_reload', String(Date.now())); } catch (e) { /* ignore */ }
        window.location.reload();
      };
      // Same reasoning as the early version check at the very top of this
      // file: don't let a reload cut off the splash screen mid-animation
      // if one is still playing (only relevant for the first few seconds
      // right after opening the app).
      var elapsedSincePageLoad = (typeof pageLoadStart !== 'undefined') ? (Date.now() - pageLoadStart) : Infinity;
      var splashRemaining = (typeof SPLASH_DURATION_MS !== 'undefined' ? SPLASH_DURATION_MS : 2400) + 200 - elapsedSincePageLoad;
      if (splashRemaining > 0) { setTimeout(doReload, splashRemaining); } else { doReload(); }
    }

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

      navigator.serviceWorker.addEventListener('controllerchange', triggerReload);
    }

    // A SECOND, independent way of noticing a new version — iOS in
    // particular is known to sometimes delay or skip the service worker's
    // own update checks for installed home-screen apps (a platform
    // limitation, not something this app's code can force), which can
    // leave a phone showing an old version even with good internet and
    // the app opened normally. This check doesn't rely on the service
    // worker's update machinery at all: it just fetches a tiny version
    // marker file directly, with caching fully bypassed — a plain network
    // request behaves far more predictably than background service
    // worker scheduling. Any reload it decides to trigger goes through
    // the same shared gate above.
    function checkVersionDirectly() {
      fetch('version.json', { cache: 'no-store' })
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (data && data.v && data.v !== APP_VERSION) triggerReload();
        })
        .catch(function () { /* offline or blocked — silently skip, try again later */ });
    }
    checkVersionDirectly();
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') checkVersionDirectly();
    });
    setInterval(checkVersionDirectly, 60000);

    // Live status — a real presence channel, joined once the profile is
    // ready. Marked explicitly gone the moment the app is hidden/closed
    // (rather than waiting for the connection itself to time out), so
    // the indicator feels instant in both directions.
    startPresence();
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') { startPresence(); updatePresenceIfActive(); }
      else { stopPresence(); }
    });
    window.addEventListener('pagehide', stopPresence);
  }

  init();
})();
