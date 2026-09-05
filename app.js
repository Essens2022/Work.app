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
    function checkVersionAndReload(waitForSplash) {
      var lastAutoReload = sessionStorage.getItem('pt_last_auto_reload');
      var reloadedRecently = !!(lastAutoReload && (Date.now() - parseInt(lastAutoReload, 10)) < EARLY_RELOAD_COOLDOWN_MS);
      if (reloadedRecently) return;
      // Never auto-reload while a driver is actively mid-navigation —
      // that would silently kill live GPS tracking, the calculated
      // route, and turn-by-turn guidance without warning, exactly while
      // it matters most. window.__navActiveNavigationRunning is set/
      // cleared by startActiveNavigation()/stopActiveNavigation()
      // further down in this file. Simply skipping here is enough — the
      // next visibilitychange check (once navigation ends and the
      // driver eventually backgrounds/returns to the tab) catches it.
      if (window.__navActiveNavigationRunning) return;
      fetch('version.json', { cache: 'no-store' })
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (data && data.v && data.v !== APP_VERSION) {
            var doReload = function () {
              try { sessionStorage.setItem('pt_last_auto_reload', String(Date.now())); } catch (e) { /* ignore */ }
              window.location.reload();
            };
            if (waitForSplash) {
              var elapsed = Date.now() - pageLoadStart;
              var remaining = SPLASH_DURATION_MS + 200 - elapsed; // small buffer past the splash's own hide timer
              if (remaining > 0) { setTimeout(doReload, remaining); } else { doReload(); }
            } else {
              doReload(); // no splash to protect — this is a later, already-in-use session
            }
          }
        })
        .catch(function () { /* offline or blocked — silently skip, try again later */ });
    }
    checkVersionAndReload(true);
    // The check above only ever runs ONCE, at the very first page load —
    // if the tab is just left open and switched back to later (backgrounded
    // while driving, checking another app, then returning), rather than
    // being fully closed and reopened, that one-time check never fires
    // again, so a stale cached copy of this file could keep running
    // indefinitely with no way to notice a newer version exists. This
    // re-checks every time the page becomes visible again, catching
    // exactly that case.
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') checkVersionAndReload(false);
    });
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
  var APP_VERSION = "pt-foglio-v524"; // bumped alongside sw.js CACHE_VERSION and version.json, every release
  var LS_PROFILE = "pt_profile_v1";
  // Requested directly: a small, discreet way to see how much of the
  // shared ORS daily quota remains — no label, just a bare
  // "remaining/total" number in Impostazioni, meant to be recognized
  // by ION specifically, not explained to every driver. Read directly
  // from the REAL rate-limit headers ORS itself returns on every
  // actual optimization/geocoding call THIS phone makes — reflects
  // the true, shared, global count at that moment, but only refreshes
  // when this specific device happens to make a request.
  var LS_ORS_QUOTA = "pt_ors_quota_v1";
  var LS_SHEETS = "pt_sheets_v1";
  var LS_CURRENT = "pt_current_sheet_v1";
  var LS_FUEL = "pt_fuel_v1"; // fuel receipts, keyed by month — independent of any client sheet
  var LS_VEHICLE = "pt_vehicle_v1"; // commercial-vehicle dimensions/weight, used by the Navigatore for restriction-aware routing
  var LS_NAV_FREQUENT = "pt_nav_frequent_v1"; // addresses actually used in a calculated route, remembered and suggested again — like Chrome's own address bar history
  var LS_NAV_HOMEWORK = "pt_nav_homework_v1"; // Casa/Lavoro shortcuts, set once by the driver — same idea as Google Maps' own Home/Work shortcuts, stored locally only (no sync, per ION's decision)
  // Delivery Planner (replaces the old turn-by-turn Navigatore) — two
  // separate, deliberately independent stores:
  // - LS_DELIVERY_CLIENTS: the reusable address book. A client saved
  //   once here shows up in autocomplete for every future delivery run,
  //   forever, until explicitly edited/removed.
  // - LS_DELIVERY_RUN: today's/the CURRENT active list — which clients
  //   are in it, their status (pending/completed), and the
  //   most-recently-prepared Google Maps batch. Persists across app
  //   closes/reopens on purpose (ION's requirement: progress must
  //   survive leaving for Google Maps and coming back) — cleared only
  //   by explicit driver action, never automatically by date/time.
  var LS_DELIVERY_CLIENTS = "pt_delivery_clients_v1";
  var LS_DELIVERY_RUN = "pt_delivery_run_v1";
  var LS_DELIVERY_HISTORY = "pt_delivery_history_v1"; // archived past days' runs — {date: 'YYYY-MM-DD', clients: [...]}[]

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
    // REAL BUG, reported directly: this used to default to ION's own
    // real company ("BARCELLA") and real starting point ("Ponte San
    // Nicolò", province "PD") — meaning EVERY new driver who ever
    // installed this app got ION's personal business data silently
    // saved into their own profile, not just shown as an example.
    // Genuinely empty now — the placeholder text on each field shows
    // a neutral example instead, never saved unless the driver
    // actually types their own.
    return loadJSON(LS_PROFILE, {
      nome: "", targa: "", perContoDi: "",
      da: "", provDa: "", frequent: {},
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

  // Delivery Planner — the reusable client address book. Each entry:
  // { id, nome, indirizzo, cap, citta, provincia, lat, lon, createdAt }
  function loadDeliveryClients() { return loadJSON(LS_DELIVERY_CLIENTS, []); }
  function saveDeliveryClients(list) { saveJSON(LS_DELIVERY_CLIENTS, list); }

  // The CURRENT active run — separate from the address book above. A
  // "run" holds only the subset of clients the driver is actually
  // delivering to today, in whatever order they were added, plus
  // status. Order within run.clients IS the visiting order (single
  // source of truth) — both drag-reordering and Reordina's
  // optimization write directly into this array's order, and Apri in
  // Google Maps reads directly from it too. There used to be a
  // SEPARATE preparedBatch field (a frozen snapshot of IDs from
  // whenever Reordina last ran) — removed entirely: it could drift
  // out of sync with the actual list (confirmed directly — dragging
  // clients to reorder them had NO effect on what Google Maps
  // actually opened, since that read from the stale snapshot, not the
  // live list).
  // { clients: [{ id, clientId, nome, indirizzo, lat, lon, status }] }
  function loadDeliveryRun() { return loadJSON(LS_DELIVERY_RUN, { clients: [], date: null }); }
  function saveDeliveryRun(run) { saveJSON(LS_DELIVERY_RUN, run); }
  function loadDeliveryHistory() { return loadJSON(LS_DELIVERY_HISTORY, []); }
  function saveDeliveryHistory(h) { saveJSON(LS_DELIVERY_HISTORY, h); }
  function todayDateStr() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

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
    'adb-standard': { code: 'ADB', name: 'Rapporto Standard', desc: 'Modello generico ADB Smart, senza dati aziendali fissi' },
    'classic': { code: 'STD', name: 'Foglio PT Viaggi', desc: 'Un giro al giorno' },
    'due-giri': { code: '2G', name: 'Due Giri/Giorno PT', desc: 'Due destinazioni e DDT separati nello stesso giorno' }
  };
  var DEFAULT_PDF_TEMPLATE = 'adb-standard';
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
    acResults: [],
    deliveryClients: loadDeliveryClients(),
    deliveryRun: loadDeliveryRun()
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
  // Requested directly: targa should always read like "HB-123NE" —
  // 2 letters, a dash, then 3 digits + 2 letters — inserted
  // automatically as the driver types, and applied to already-saved
  // plates too whenever they're shown in this field again (whatever
  // format they were originally saved in, like "GN 542 NM" with
  // spaces). Positional, not letter/digit-strict — simpler, more
  // forgiving of exactly how someone types it, and the dash lands in
  // the same place either way.
  function formatTarga(raw) {
    var clean = (raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 7);
    if (clean.length <= 2) return clean;
    return clean.slice(0, 2) + '-' + clean.slice(2);
  }

  // Requested directly: auto-fill the province from whatever city is
  // typed for Partenza predefinita, if the driver doesn't type one
  // explicitly. Covers every provincial capital plus a good spread of
  // other well-known cities/comuni — genuinely exhaustive coverage
  // would need a full comuni database (8000+ entries), out of scope
  // here; anything not recognized is simply left blank, exactly like
  // before this existed, for the driver to fill in by hand.
  var CITY_TO_PROVINCE = {
    'AGRIGENTO':'AG','ALESSANDRIA':'AL','ANCONA':'AN','AOSTA':'AO','AREZZO':'AR','ASCOLI PICENO':'AP',
    'ASTI':'AT','AVELLINO':'AV','BARI':'BA','BARLETTA':'BT','BELLUNO':'BL','BENEVENTO':'BN','BERGAMO':'BG',
    'BIELLA':'BI','BOLOGNA':'BO','BOLZANO':'BZ','BRESCIA':'BS','BRINDISI':'BR','CAGLIARI':'CA',
    'CALTANISSETTA':'CL','CAMPOBASSO':'CB','CASERTA':'CE','CATANIA':'CT','CATANZARO':'CZ','CHIETI':'CH',
    'COMO':'CO','COSENZA':'CS','CREMONA':'CR','CROTONE':'KR','CUNEO':'CN','ENNA':'EN','FERMO':'FM',
    'FERRARA':'FE','FIRENZE':'FI','FOGGIA':'FG','FORLI':'FC',"FORLÌ":'FC','FROSINONE':'FR','GENOVA':'GE',
    'GORIZIA':'GO','GROSSETO':'GR','IMPERIA':'IM','ISERNIA':'IS','LA SPEZIA':'SP',"L'AQUILA":'AQ',
    'LATINA':'LT','LECCE':'LE','LECCO':'LC','LIVORNO':'LI','LODI':'LO','LUCCA':'LU','MACERATA':'MC',
    'MANTOVA':'MN','MASSA':'MS','MATERA':'MT','MESSINA':'ME','MILANO':'MI','MODENA':'MO','MONZA':'MB',
    'NAPOLI':'NA','NOVARA':'NO','NUORO':'NU','ORISTANO':'OR','PADOVA':'PD','PALERMO':'PA','PARMA':'PR',
    'PAVIA':'PV','PERUGIA':'PG','PESARO':'PU','PESCARA':'PE','PIACENZA':'PC','PISA':'PI','PISTOIA':'PT',
    'PORDENONE':'PN','POTENZA':'PZ','PRATO':'PO','RAGUSA':'RG','RAVENNA':'RA','REGGIO CALABRIA':'RC',
    'REGGIO EMILIA':'RE','RIETI':'RI','RIMINI':'RN','ROMA':'RM','ROVIGO':'RO','SALERNO':'SA','SASSARI':'SS',
    'SAVONA':'SV','SIENA':'SI','SIRACUSA':'SR','SONDRIO':'SO','TARANTO':'TA','TERAMO':'TE','TERNI':'TR',
    'TORINO':'TO','TRAPANI':'TP','TRENTO':'TN','TREVISO':'TV','TRIESTE':'TS','UDINE':'UD','VARESE':'VA',
    'VENEZIA':'VE','VERBANIA':'VB','VERCELLI':'VC','VERONA':'VR','VIBO VALENTIA':'VV','VICENZA':'VI',
    'VITERBO':'VT',
    // A few well-known, frequently-typed comuni beyond the provincial capitals themselves
    'PONTE SAN NICOLO':'PD','SELVAZZANO DENTRO':'PD','ABANO TERME':'PD','CITTADELLA':'PD',
    'MESTRE':'VE','MARGHERA':'VE','CONEGLIANO':'TV','CASTELFRANCO VENETO':'TV','MONTEBELLUNA':'TV',
    'BASSANO DEL GRAPPA':'VI','SCHIO':'VI','LEGNAGO':'VR','BUSSOLENGO':'VR'
  };
  function lookupProvinceForCity(cityRaw) {
    var normalized = (cityRaw || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    return CITY_TO_PROVINCE[normalized] || null;
  }

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
  // Shared by sheetKmAndTrips (whole-month totals) and todayStats
  // (today's own card) — a single giorno can genuinely be TWO
  // separate trips (the "due giri" PDF template gives Giro 2 its own
  // a2/ddt2/kmInizio2/kmFine2, entirely independent of Giro 1's own
  // fields), so each is checked and counted on its own, never folded
  // together into a single yes/no for the whole day.
  function giornoTripsAndKm(g) {
    var viaggi = 0, km = 0;
    if (!g) return { viaggi: viaggi, km: km };
    if (g.a || g.ddt || g.kmFine !== "") {
      viaggi++;
      if (g.kmInizio !== "" && g.kmFine !== "" && !isNaN(g.kmFine - g.kmInizio)) km += (Number(g.kmFine) - Number(g.kmInizio));
    }
    // REAL BUG, reported directly (wrong "Viaggi totali"/"Viaggi
    // oggi", right after this very function was introduced): the
    // "due giri" fields (a2/ddt2/kmInizio2/kmFine2) only exist on
    // giorni created after that feature was added — any OLDER giorno
    // never has them at all, so g.kmFine2 there is genuinely
    // undefined, not "". The trigger check compared it only against
    // "" (`g.kmFine2 !== ""`), and undefined !== "" is TRUE in
    // JavaScript — so every single pre-existing day in a driver's
    // whole history silently counted a phantom second trip that
    // never happened, inflating both the monthly and today's trip
    // counts. Now requires the field to actually be a genuine,
    // non-empty value (matching the already-correct check used for
    // the km calculation just below), not merely "not exactly an
    // empty string".
    if (g.a2 || g.ddt2 || (g.kmFine2 !== "" && g.kmFine2 !== undefined && g.kmFine2 !== null)) {
      viaggi++;
      if (g.kmInizio2 !== "" && g.kmInizio2 !== undefined && g.kmFine2 !== "" && g.kmFine2 !== undefined && !isNaN(g.kmFine2 - g.kmInizio2)) km += (Number(g.kmFine2) - Number(g.kmInizio2));
    }
    return { viaggi: viaggi, km: km };
  }

  function sheetKmAndTrips(sheet) {
    var viaggi = 0, km = 0, workedDays = 0;
    Object.keys(sheet.giorni).forEach(function (d) {
      var t = giornoTripsAndKm(sheet.giorni[d]);
      viaggi += t.viaggi; km += t.km;
      // REAL BUG, reported directly (a driver's admin-shown earnings
      // came out to 3850 at a €110 daily rate — 35, not the driver's
      // real number of worked days): "viaggi" genuinely counts each
      // giro separately (a due-giri day correctly shows 2, matching
      // the app's own "X giri" label) — but pay is owed per WORKED
      // DAY, not per trip, so a day with two giri should still only
      // ever add ONE day toward the daily rate. workedDays counts
      // that instead — per calendar day on THIS sheet, at most 1,
      // regardless of how many giri (1 or 2) it had.
      if (t.viaggi > 0) workedDays++;
    });
    return { viaggi: viaggi, km: km, workedDays: workedDays };
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
      var t = giornoTripsAndKm(s.giorni[day]);
      viaggi += t.viaggi; km += t.km;
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

  function toast(msg, durationMs) {
    var t = document.getElementById('toast');
    document.getElementById('toast-text').textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove('show'); }, durationMs || 3000);
  }

  // Same idea as toast(), positioned instead — see the comment on
  // #nav-toast in renderNavigatore for why. Only meaningful while the
  // active-navigation overlay actually exists in the DOM (checks for
  // the element rather than assuming it does).
  function navToast(msg) {
    var t = document.getElementById('nav-toast');
    if (!t) return;
    document.getElementById('nav-toast-text').textContent = msg;
    t.classList.add('show');
    clearTimeout(navToast._t);
    navToast._t = setTimeout(function () { t.classList.remove('show'); }, 3000);
  }

  // Requested directly: shown once, each time AUTO (auto-riordina) is
  // switched ON — explains briefly that each client needs coordinates,
  // not just an address, for reliable results (addresses can
  // sometimes fail to geocode; coordinates always work), and where to
  // get them (Google Maps — find the client there, copy the
  // coordinates). Built fresh each time rather than a static element
  // already in the page, since it's only ever needed at this one
  // moment. Dismissed either by the X or by tapping the backdrop
  // outside the card — never blocks the rest of the screen.
  function showAutoRiordinaInfoNotice() {
    var backdrop = document.createElement('div');
    backdrop.className = 'auto-info-backdrop';
    backdrop.innerHTML =
      '<div class="auto-info-card">' +
      '<div class="close-x">✕</div>' +
      '<div class="title-row"><span class="dot"></span><strong>Per un risultato migliore</strong></div>' +
      '<p>Con AUTO attivo, il percorso viene organizzato automaticamente. Per un funzionamento più preciso, è consigliato aggiungere le coordinate a ogni cliente: sono più affidabili del solo indirizzo e puoi copiarle facilmente da Google Maps.</p>' +
      '</div>';
    document.body.appendChild(backdrop);
    requestAnimationFrame(function () { backdrop.classList.add('show'); });
    function close() {
      backdrop.classList.remove('show');
      setTimeout(function () { backdrop.remove(); }, 200);
    }
    backdrop.addEventListener('click', function (e) { if (e.target === backdrop) close(); });
    backdrop.querySelector('.close-x').addEventListener('click', close);
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
      // Requested directly, following real driver feedback on this
      // template: Giro 2 needed its OWN complete "Da" (departure) —
      // pre-filled the same way Giro 1's own da/provDa already are,
      // since it's typically the same base departure point (e.g.
      // "Ponte San Nicolò") for both trips that day, but kept
      // editable/independent since the two trips could genuinely
      // start from different places.
      da2: prefillDa || "", provDa2: prefillProvDa || "",
      // Requested directly: the amount of money the driver physically
      // collects from the client on delivery (not "Bonus" below, which
      // is the driver's own internal pay, never printed) — one per
      // giro, since a 'due-giri' day genuinely has two separate
      // deliveries, each with its own amount. Printed directly on the
      // PDF itself. Present on every giorno regardless, same reasoning
      // as a2/provA2/ddt2 above.
      riscosso1: "", riscosso2: "",
      // Requested directly, same follow-up feedback: kmInizio/kmFine
      // below now belong to Giro 1 specifically (unchanged field
      // names, for full backward compatibility with existing due-giri
      // data and the single-giro templates) — Giro 2 gets its own,
      // separate kmInizio2/kmFine2, since each trip is really its own
      // mini-journey with its own odometer range, not one shared
      // range for the whole day.
      kmInizio: "", kmFine: "", kmInizio2: "", kmFine2: "",
      // Requested directly: the driver could genuinely be driving a
      // DIFFERENT vehicle for Giro 2 than Giro 1 (e.g. swapping vans
      // partway through the day) — optional, per-day overrides; left
      // empty, the sheet's own targa (set once, for the whole month)
      // is what's used, same as before this existed.
      targa1: "", targa2: "",
      bonus: ""
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
  // Requested directly: on a "due giri" (two-round) day, ION types
  // km fine for Giro 1 and it correctly carries into Giro 2's own km
  // inizio, live, the same day. But the NEXT day's own km inizio was
  // always pulling from that day's kmFine (Giro 1 specifically) —
  // never kmFine2 — so a day that actually ended with a second round
  // silently lost those extra kilometers, restarting the next day's
  // count from wherever Giro 1 had left off instead of where the
  // vehicle really was. Checked here in the correct real-world
  // order: whichever giro was genuinely LAST for that day (kmFine2 if
  // it exists — a second round happened — falling back to kmFine
  // only when there wasn't one).
  function findLastKmFine(sheet, beforeDay) {
    for (var d = beforeDay - 1; d >= 1; d--) {
      var g = sheet.giorni[d];
      if (!g) continue;
      if (g.kmFine2 !== "" && g.kmFine2 !== null && g.kmFine2 !== undefined) {
        return { value: g.kmFine2, source: 'same' };
      }
      if (g.kmFine !== "" && g.kmFine !== null && g.kmFine !== undefined) {
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
        if (!g2) continue;
        if (g2.kmFine2 !== "" && g2.kmFine2 !== null && g2.kmFine2 !== undefined) {
          return { value: g2.kmFine2, source: 'prev' };
        }
        if (g2.kmFine !== "" && g2.kmFine !== null && g2.kmFine !== undefined) {
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
    var client = (perContoDi || state.profile.perContoDi || '').trim().toUpperCase();
    var existing = sheetForMonth(month, year, client);
    if (existing) return existing;
    var s = {
      id: uid(),
      month: month, year: year,
      nome: state.profile.nome, targa: state.profile.targa, perContoDi: client,
      veicoloInterno: state.profile.veicoloInterno || '',
      da: state.profile.da, provDa: state.profile.provDa,
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
    // The old turn-by-turn navigator wanted to feel edge-to-edge, like
    // opening Google Maps directly — that's why this existed. The
    // Delivery Planner replacing it is a normal scrollable list screen
    // (client list, buttons), not a full-screen map, so it uses the
    // app's regular top bar and padding like every other screen now.
    document.body.classList.toggle('nav-fullbleed', false);
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
    else if (currentScreen === 'navigatore') renderDeliveryPlanner();
  }

  function svgIcon(name) {
    var icons = {
      truck: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="6" width="14" height="11"/><path d="M15 10h4l3 3v4h-7z"/><circle cx="6" cy="19" r="1.6"/><circle cx="17.5" cy="19" r="1.6"/></svg>',
      // Front-view heavy-truck cab — commissioned separately, drawn to
      // ION's own detailed spec after two review rounds (a rounder
      // first draft was rejected as "not even close, needs to be a
      // modern cab" — European trucks like the Actros/Volvo FH/Scania
      // have flat-topped, angular fronts, not a domed van-style roof).
      // Same stroke width/size/style as every other topbar icon here.
      'truck-cab': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 21 L6.5 6.5 Q6.5 4.5 8.5 4.5 L15.5 4.5 Q17.5 4.5 17.5 6.5 L17.5 21" /><path d="M7.7 6 L16.3 6 L16.3 11.5 Q16.3 12.5 15.3 12.5 L8.7 12.5 Q7.7 12.5 7.7 11.5 Z" stroke-width="1.5"/><path d="M6.5 9.5 L5 9.5" stroke-width="1.3"/><path d="M5 8.3 L5 10.7 L4 10.7 L4 8.3 Z" stroke-width="1.3"/><path d="M17.5 9.5 L19 9.5" stroke-width="1.3"/><path d="M19 8.3 L19 10.7 L20 10.7 L20 8.3 Z" stroke-width="1.3"/><path d="M9 15 L15 15" stroke-width="1.3"/><path d="M9 16.4 L15 16.4" stroke-width="1.3"/><path d="M9 17.8 L15 17.8" stroke-width="1.3"/><path d="M7.3 19 L9.3 19 L9.3 20.5 L7.6 20.5 Z" stroke-width="1.3"/><path d="M16.7 19 L14.7 19 L14.7 20.5 L16.4 20.5 Z" stroke-width="1.3"/></svg>',
      // Archive box — requested directly: a button next to Storico for
      // the full saved-client address book (view/edit/delete any
      // saved client, plus export/import as a file to share with a
      // colleague) — icon only, no text, same stroke style as every
      // other icon here.
      archive: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M4 8v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 13h4"/></svg>',
      // Requested directly: quick access to edit the saved Casa/Deposito
      // addresses from within Archivio clienti's own top bar — home
      // gets a plain pointed roof + single narrow door, deposito gets
      // a wider roof line and a two-panel roll-up-style door, so the
      // two read as clearly different buildings even at 18px, not
      // just a home icon twice. Same stroke style/weight as every
      // other icon here — no emoji, per direct request.
      home: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11.5 12 4l8 7.5"/><path d="M6 10v9a1 1 0 0 0 1 1h3v-6h4v6h3a1 1 0 0 0 1-1v-9"/></svg>',
      warehouse: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 20V9.5l9-5 9 5V20"/><path d="M3 20h18"/><rect x="8" y="13" width="8" height="7"/><path d="M11 13v7M13 13v7"/></svg>',
      // Requested directly: "Reordina" didn't read clearly as a
      // button — added this icon (two opposite-direction arrows,
      // the standard sort/reorder symbol) alongside a filled
      // background, so it reads unmistakably as a pressable action.
      sort: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4v16"/><path d="M4 7l3-3 3 3"/><path d="M17 20V4"/><path d="M20 17l-3 3-3-3"/></svg>',
      camera: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8a2 2 0 0 1 2-2h1.5l1-1.5h7l1 1.5H18a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/><circle cx="12" cy="12.5" r="3.4"/></svg>',
      route: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="5" cy="6" r="2"/><circle cx="19" cy="18" r="2"/><path d="M5 8v4a4 4 0 0 0 4 4h6" stroke-dasharray="3 3"/></svg>',
      fuel: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="9" height="18" rx="1"/><rect x="6.3" y="5.5" width="4.4" height="4" rx="0.5"/><path d="M13 9h2.5l3 2.5v6.5a1.5 1.5 0 0 1-3 0v-3.5a1 1 0 0 0-1-1h-1.5"/></svg>',
      share: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><path d="M16 6l-4-4-4 4"/><path d="M12 2v13"/></svg>',
      calendar: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M8 3v4"/><path d="M16 3v4"/></svg>',
      // Requested directly: Impostazioni redesign — small section-header
      // icons, so "Profilo autista" / "Compenso" / "Account" each read
      // as a distinct, deliberate group rather than one long
      // undifferentiated list of fields.
      user: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-3.5 3-6 7-6s7 2.5 7 6"/></svg>',
      coin: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v10M9.5 9.2c0-1.2 1.1-2 2.5-2s2.5.9 2.5 2c0 2.6-5 1.7-5 4.3 0 1.1 1.1 2 2.5 2s2.5-.8 2.5-2"/></svg>',
      idbadge: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="2.5"/><circle cx="12" cy="10" r="2.6"/><path d="M8 17c0-2 1.8-3.2 4-3.2s4 1.2 4 3.2"/></svg>',
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
    // Requested directly: rather than hooking this to each individual
    // sign-in path separately (email confirmation's "Continua" button,
    // Google's own callback redirect — two different code paths that
    // don't always stay in sync), trigger it right here instead, the
    // moment the actual home screen — month, targa, driver name, the
    // real destination after ANY successful sign-in — first renders.
    // This fires on every renderHome() call, but the guard inside
    // offerPushNotificationsIfSensible() itself (the LS_PUSH_OFFERED
    // flag) makes every call after the very first one an immediate,
    // cheap no-op — so this works identically and automatically no
    // matter which door someone came in through.
    offerPushNotificationsIfSensible();
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
    if (isNewestSheet(sheet)) {
      html += '<div class="trash-icon" id="foglio-delete" aria-label="Elimina foglio"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg></div>';
    }
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
      // REAL BUG, reported directly: this per-day km figure (shown
      // right in the day list, not just the monthly total) only ever
      // counted Giro 1 — same underlying gap as sheetKmAndTrips above,
      // fixed the same way, adding Giro 2's own km whenever it's
      // genuinely filled in.
      var kmtot = null;
      if (g && g.kmInizio !== "" && g.kmFine !== "" && !isNaN(g.kmFine - g.kmInizio)) {
        kmtot = (Number(g.kmFine) - Number(g.kmInizio));
      }
      if (g && g.kmInizio2 !== "" && g.kmInizio2 !== undefined && g.kmFine2 !== "" && g.kmFine2 !== undefined && !isNaN(g.kmFine2 - g.kmInizio2)) {
        kmtot = (kmtot || 0) + (Number(g.kmFine2) - Number(g.kmInizio2));
      }
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

    el.innerHTML = html;
    el.querySelectorAll('.day-row[data-day]').forEach(function (row) {
      row.addEventListener('click', function () { openDayEditor(sheet, parseInt(row.getAttribute('data-day'), 10)); });
    });
    document.getElementById('foglio-edit').addEventListener('click', function () { openSettingsModal(sheet); });
    var deleteBtn = document.getElementById('foglio-delete');
    if (deleteBtn) deleteBtn.addEventListener('click', function () { confirmUndoSheet(sheet); });

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
      .then(function () { return loadScript('vendor/jspdf.plugin.autotable.min.js'); })
      // Requested directly: accented characters (Ò, À, È, Ù, Ì — common
      // in Italian place names) came out corrupted in every generated
      // PDF — the standard 'helvetica' font jsPDF ships with only
      // supports ASCII/WinAnsi, not full UTF-8. Loading a real font
      // with those glyphs alongside the existing PDF libraries, the
      // same lazy way, so it's ready by the time any PDF actually
      // gets built.
      .then(function () { return loadScript('vendor/pdf-font-roboto.js'); });
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
    { v: 'auto', l: 'Auto' },
    { v: 'furgone', l: 'Furgone' },
    { v: 'cassonato', l: 'Cassonato' },
    { v: 'camion', l: 'Camion' },
    { v: 'autoarticolato', l: 'Autoarticolato' }
  ];

  var navMap = null, navRouteLayer = null;

  // Continuous smoothing for the marker + camera during active
  // navigation — real GPS fixes only arrive every 1-2 real seconds no
  // matter what, but this runs every animation frame (~60/sec),
  // gliding the DISPLAYED position toward each new fix using
  // exponential smoothing, rather than only moving when a real fix
  // lands. Genuinely closer to Google/Waze-level fluidity than
  // periodic eased jumps ever can be. Upgraded to real dead-reckoning
  // — navSmooth.fixLat/fixLon/fixHeading/fixSpeedMps are the last
  // REAL GPS fix's own data, extrapolated continuously every frame
  // (not just interpolated toward a static point that goes stale
  // between real fixes); navSmooth.lat/lon/bearing are what's
  // actually drawn on screen each frame.
  var navLastAppliedBearing = null, navLastBearingApplyTime = null; // throttles how often the (expensive to render) map rotation actually changes — see navSmoothCameraFrame for why
  var navSmooth = {
    lat: null, lon: null, bearing: null,
    // Dead-reckoning baseline — the last REAL GPS fix's own data, used
    // to continuously EXTRAPOLATE a moving position estimate every
    // single frame, instead of just interpolating toward a static
    // point that goes stale between real fixes. This is what was
    // actually causing the reported "moves, then sits still, then
    // jumps" pattern on the camera, marker, AND line all at once, in
    // real driving: a real GPS fix only arrives every 1-2 real
    // seconds — interpolating toward a FIXED target inevitably means
    // arriving early and then sitting nearly motionless for most of
    // that real gap, no matter how the interpolation rate is tuned.
    // Extrapolating continued movement from the last known speed +
    // heading instead means the position is ALWAYS advancing, every
    // frame, the same way a real car keeps moving between a
    // navigation app's own GPS reads.
    fixLat: null, fixLon: null, fixHeading: 0, fixSpeedMps: 0, fixTimestamp: 0,
    // The PREVIOUS real fix (one before fixLat/fixLon above) — used
    // only to compute a fallback speed (distance/time between the two
    // most recent real fixes) when the device's own
    // position.coords.speed isn't available, which happens often
    // enough on some Android GPS chips to matter.
    prevFixLat: null, prevFixLon: null, prevFixTimestamp: 0,
    rafId: null, lastFrameTime: 0, paused: false, lastTrimTime: 0
  };

  // Standard "destination point given start, bearing, distance"
  // formula (haversine-based) — the actual math behind the
  // extrapolation above.
  function navDestPointFromBearing(lat, lon, bearingDeg, distanceM) {
    var R = 6371000;
    var brng = bearingDeg * Math.PI / 180;
    var lat1 = lat * Math.PI / 180, lon1 = lon * Math.PI / 180;
    var lat2 = Math.asin(Math.sin(lat1) * Math.cos(distanceM / R) + Math.cos(lat1) * Math.sin(distanceM / R) * Math.cos(brng));
    var lon2 = lon1 + Math.atan2(Math.sin(brng) * Math.sin(distanceM / R) * Math.cos(lat1), Math.cos(distanceM / R) - Math.sin(lat1) * Math.sin(lat2));
    return { lat: lat2 * 180 / Math.PI, lon: ((lon2 * 180 / Math.PI + 540) % 360) - 180 };
  }

  function navSmoothCameraFrame(timestamp) {
    navSmooth.rafId = requestAnimationFrame(navSmoothCameraFrame);
    if (navSmooth.fixLat == null || !navMap || !navMap._maplibre) return;
    var dt = navSmooth.lastFrameTime ? Math.min((timestamp - navSmooth.lastFrameTime) / 1000, 0.25) : 0.016; // capped, in case the tab was backgrounded a moment
    navSmooth.lastFrameTime = timestamp;

    // Continuously extrapolated from the last real fix — ALWAYS
    // advancing, every frame, rather than a value that only changes
    // when a new real GPS fix happens to land.
    var elapsedSinceFix = (timestamp - navSmooth.fixTimestamp) / 1000;
    var extrapolatedDistance = navSmooth.fixSpeedMps * elapsedSinceFix;
    var extrapolated = navDestPointFromBearing(navSmooth.fixLat, navSmooth.fixLon, navSmooth.fixHeading, extrapolatedDistance);

    if (navSmooth.lat == null) { navSmooth.lat = extrapolated.lat; navSmooth.lon = extrapolated.lon; navSmooth.bearing = navSmooth.fixHeading; }
    // Light smoothing toward the continuously-moving extrapolated
    // point (not a static target anymore) — this only softens small
    // jitter/corrections, since the extrapolated point is already
    // advancing smoothly on its own every frame.
    var rate = 8;
    var t = 1 - Math.exp(-rate * dt);
    navSmooth.lat += (extrapolated.lat - navSmooth.lat) * t;
    navSmooth.lon += (extrapolated.lon - navSmooth.lon) * t;
    var diff = ((navSmooth.fixHeading - navSmooth.bearing + 540) % 360) - 180; // shortest signed angle, so it never spins the "long way round" through 0/360
    navSmooth.bearing = (navSmooth.bearing + diff * t + 360) % 360;

    if (navPositionMarker) navPositionMarker.setLatLng([navSmooth.lat, navSmooth.lon]);

    if (navFollowingUser && !navSmooth.paused) {
      // Position (center) updates every frame — the visually important
      // one to keep perfectly smooth. Bearing (rotating the whole map)
      // is genuinely expensive to render for a vector style — every
      // visible label needs re-placement, line geometry needs
      // re-tessellating — so it's throttled to roughly 5 times a
      // second instead of every frame, still smooth enough to read as
      // continuous rotation.
      if (navLastBearingApplyTime == null || timestamp - navLastBearingApplyTime > 200) {
        navLastAppliedBearing = navSmooth.bearing;
        navLastBearingApplyTime = timestamp;
      }
      // jumpTo, not easeTo — this loop IS the animation now, running
      // every frame; layering MapLibre's own eased transition on top
      // of a value that's already being smoothly interpolated here
      // would just be double-smoothing against a moving target.
      // padding pushes the driver's position down toward the lower
      // portion of the screen instead of dead-center.
      navMap._maplibre.jumpTo({
        center: [navSmooth.lon, navSmooth.lat],
        bearing: navLastAppliedBearing,
        padding: { top: 260, bottom: 0, left: 0, right: 0 }
      });
    }
    // The already-driven part of the route line updates every frame
    // too, from this exact same navSmooth.lat/lon, using a windowed
    // (not full-route) search — see navNearestCoordIndexWindowed.
    if (typeof updateCurrentLegTrim === 'function') updateCurrentLegTrim(navSmooth.lat, navSmooth.lon);
    var needle = document.getElementById('nav-compass-needle');
    if (needle) needle.textContent = headingToCompassLabel(navSmooth.bearing);
  }

  function navStartSmoothCamera() {
    if (navSmooth.rafId) return; // already running
    navSmooth.lat = navSmooth.lon = navSmooth.bearing = null; // re-seed from the next real fix, not wherever a previous session left off
    navSmooth.lastFrameTime = 0;
    navSmooth.paused = false;
    navLastAppliedBearing = navLastBearingApplyTime = null;
    navSmooth.rafId = requestAnimationFrame(navSmoothCameraFrame);
  }

  function navStopSmoothCamera() {
    if (navSmooth.rafId) cancelAnimationFrame(navSmooth.rafId);
    navSmooth.rafId = null;
    navSmooth.fixLat = navSmooth.fixLon = null;
    navSmooth.prevFixLat = navSmooth.prevFixLon = null; // don't let a stale reading from a previous, unrelated session feed a bogus fallback-speed calculation on the next one
  }

  // ==================================================================
  // DELIVERY PLANNER — replaces the old turn-by-turn Navigatore.
  // ==================================================================
  // ADB Smart no longer tries to be a navigator. It manages the
  // client list, prepares an optimized order for the next batch, and
  // hands off to Google Maps for the actual driving/navigation —
  // Google Maps does what it does best (live traffic, ETA, turn-by-
  // turn), ADB Smart does what IT does best (organizing the day).
  //
  // PHASE 1 of the redesign (client list + local autocomplete +
  // ORS-Optimization-based reordering + Google Maps hand-off). Bolla
  // OCR and ZTL warnings are separate, later phases per the agreed
  // build order.

  var TIPO_VEICOLO_LABELS = { auto: 'Auto', furgone: 'Furgone', cassonato: 'Cassonato', camion: 'Camion', autoarticolato: 'Autoarticolato' };
  function dpVehicleSummary() {
    var v = state.vehicle;
    var label = TIPO_VEICOLO_LABELS[v.tipo] || v.tipo;
    if (v.tipo === 'auto') return escapeHtml(label);
    var bits = [label];
    if (v.massa) bits.push(v.massa + ' t');
    if (v.altezza) bits.push('H ' + v.altezza + ' m');
    return escapeHtml(bits.join(' · '));
  }

  function dpStats(run) {
    var total = run.clients.length;
    var completed = run.clients.filter(function (c) { return c.status === 'completed'; }).length;
    return { total: total, completed: completed, remaining: total - completed };
  }

  // REAL BUG, reported directly, then clarified with a concrete
  // example after an earlier attempt sorted the wrong direction:
  // the FIRST delivery done (this morning) must end up LAST in the
  // whole list; the most recently completed one rises toward the
  // TOP of the completed section (right after the pending items) —
  // each new completion "climbs" there as it happens, pushing older
  // completions further down toward the very end. That's DESCENDING
  // completedAt within the group, not ascending — the exact opposite
  // of "as they were done" read literally as sorted-oldest-first;
  // ION's own worked example (mark A first, then C, then B → wants
  // B, C, A, not A, C, B) confirmed this reading directly. Clients
  // with no completedAt at all (shouldn't normally happen once
  // actually completed, but never trust that) sort last within the
  // group rather than crashing or landing in an arbitrary spot.
  // Shared by every place that builds the completed tail of the
  // list — dpConfirmReordina's own immediate reorder,
  // dpRunAutoOptimization, and applyOrder — so all three always agree
  // on the same order.
  function dpSortByCompletionOrder(completedClients) {
    return completedClients.slice().sort(function (a, b) {
      return (b.completedAt || -Infinity) - (a.completedAt || -Infinity);
    });
  }

  function dpFormatTime(ts) {
    var d = new Date(ts);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  // Reads the REAL rate-limit headers ORS returns on every response
  // (x-ratelimit-remaining, x-ratelimit-limit) and stores the latest
  // reading — called right after every actual fetch to ORS, success
  // or failure alike (ORS includes these headers even on a 429/403
  // rate-limited response, arguably the most useful moment to catch
  // them). Silently does nothing if the headers aren't present (fetch
  // failed before a real response, or ORS changes its header names)
  // — never throws, never surfaces anything to the driver.
  //
  // REAL FINDING, reported directly: the limit isn't one shared
  // number across every ORS service, as the (third-party, not
  // official) documentation suggested — geocoding alone showed
  // 500/day, a real, live number straight from ORS itself, not
  // whatever a 2500/day figure found elsewhere implied. Tracked
  // separately now, per actual endpoint kind, since each one can (and
  // does) carry its own distinct limit.
  function dpTrackOrsQuota(response, kind) {
    try {
      if (!response || !response.headers) return;
      var remaining = response.headers.get('x-ratelimit-remaining');
      var limit = response.headers.get('x-ratelimit-limit');
      if (remaining == null) return;
      var all = JSON.parse(localStorage.getItem(LS_ORS_QUOTA) || '{}');
      all[kind] = { remaining: remaining, limit: limit, at: Date.now() };
      localStorage.setItem(LS_ORS_QUOTA, JSON.stringify(all));
    } catch (e) { /* best-effort only */ }
  }

  // REAL BUG, found and confirmed directly: the "⚠ non verificato"
  // warning below used to check c.nonVerificato — a flag that was
  // never actually SET anywhere in this file. The badge never showed
  // for ANY client, ever, regardless of whether their address genuinely
  // had no coordinates. A driver reported a client ("Elettropadana",
  // Via Fratta, Borgoricco) that just silently stayed stuck, never
  // included in auto-riordina's ordering, with no warning shown at
  // all — this explains exactly that: it very plausibly had no
  // coordinates yet (freshly added, background geocode not finished
  // or failed), was correctly excluded from the ordering as
  // "unverified" behind the scenes, but the UI gave zero indication
  // why. Now checks the client's REAL coordinate state directly
  // (c.lat == null || c.lon == null) instead of the dead flag — the
  // exact same condition ordering itself already used to decide
  // "unverified" (see the unverified/geolocatable split in
  // dpRunAutoOptimization and dpConfirmReordina).
  function dpClientRowHtml(c, idx, readOnly) {
    var isDone = c.status === 'completed';
    var badge = isDone ? '✓' : String(idx + 1);
    // Requested directly: a client with a delivery deadline
    // ("Consegna entro") gets its numbered badge colored amber —
    // urgent, do this soon — while one that can't be delivered before
    // a given time ("Non prima delle") gets blue instead — the
    // OPPOSITE signal, wait rather than hurry. Once actually
    // completed, neither applies any more — the existing teal "done"
    // color already communicates that clearly on its own, so a
    // finished delivery doesn't need to keep flagging as "urgent" or
    // "wait" after the fact.
    var badgeTimeClass = isDone ? '' : (c.scadenza ? ' dp-client-badge-scadenza' : (c.nonPrimaDi ? ' dp-client-badge-nonprima' : ''));
    // Requested directly: moved to its OWN line, between the name and
    // the address, instead of sitting inline right after the name —
    // with a longer client name, the time used to get squeezed
    // awkwardly right up against it (or wrap unpredictably); on its
    // own line, it stays exactly as readable regardless of how long
    // or short the name happens to be. Hidden the moment the delivery
    // is actually marked done — a finished stop no longer needs its
    // time constraint called out.
    var timeNote = '';
    if (!isDone) {
      if (c.scadenza) timeNote = '<div style="color:#B45309;font-weight:700;font-size:12.5px;margin-top:2px;">⏱ entro ' + escapeHtml(c.scadenza) + '</div>';
      else if (c.nonPrimaDi) timeNote = '<div style="color:#1D4ED8;font-weight:700;font-size:12.5px;margin-top:2px;">⏱ non prima delle ' + escapeHtml(c.nonPrimaDi) + '</div>';
    }
    if (readOnly) {
      // Storico's own read-only rows — no drag, no swipe, no click.
      return '' +
        '<div class="card dp-client-row' + (isDone ? ' dp-client-done' : '') + '">' +
        '<div class="dp-client-badge' + (isDone ? ' dp-client-badge-done' : badgeTimeClass) + '">' + badge + '</div>' +
        '<div class="dp-client-info">' +
        '<div class="dp-client-name">' + escapeHtml(c.nome) + '</div>' +
        timeNote +
        '<div class="dp-client-addr">' + escapeHtml(c.indirizzo || '') + ((c.lat == null || c.lon == null) ? ' <span style="color:var(--accent);">⚠ non verificato</span>' : '') + (c.orsUnreachable ? ' <span style="color:var(--accent);">⚠ non ottimizzato</span>' : '') + '</div>' +
        (c.completedAt ? '<div style="color:var(--teal);font-size:13px;font-weight:700;margin-top:3px;">✓ Consegnato ~' + dpFormatTime(c.completedAt) + '</div>' : '') +
        '</div>' +
        '</div>';
    }
    // Today's own rows — wrapped for swipe-to-delete (same iOS Mail-
    // style pattern already used for saved-client suggestions: the
    // red Elimina button sits behind, revealed by dragging the row
    // itself left). The drag handle (⠿) lives INSIDE the swipeable
    // row, but starts a completely separate, vertical-only reordering
    // gesture — the two never conflict since one is triggered from the
    // handle specifically and the other from the row body, and one
    // reads horizontal movement while the other reads vertical.
    return '' +
      '<div class="dp-swipe-wrap" data-client-id="' + c.id + '">' +
      '<button type="button" class="dp-swipe-delete-btn" data-client-id="' + c.id + '">Elimina</button>' +
      '<div class="card dp-client-row dp-swipe-row' + (isDone ? ' dp-client-done' : '') + '" data-client-id="' + c.id + '">' +
      '<div class="dp-drag-handle" data-client-id="' + c.id + '">⠿</div>' +
      '<div class="dp-client-badge' + (isDone ? ' dp-client-badge-done' : badgeTimeClass) + '">' + badge + '</div>' +
      '<div class="dp-client-info">' +
      '<div class="dp-client-name">' + escapeHtml(c.nome) + '</div>' +
      timeNote +
      '<div class="dp-client-addr">' + escapeHtml(c.indirizzo || '') + ((c.lat == null || c.lon == null) ? ' <span style="color:var(--accent);">⚠ non verificato</span>' : '') + (c.orsUnreachable ? ' <span style="color:var(--accent);">⚠ non ottimizzato</span>' : '') + '</div>' +
      (c.completedAt ? '<div style="color:var(--teal);font-size:13px;font-weight:700;margin-top:3px;">✓ Consegnato ~' + dpFormatTime(c.completedAt) + '</div>' : '') +
      '</div>' +
      // Requested directly: once a client is marked consegnato, a
      // camera icon appears on its row — in case the driver closed
      // the auto-opened camera by mistake, or just wants another
      // photo later, tapping this reopens it for exactly this one
      // client (not the rest of the queue).
      (isDone ? '<button type="button" class="dp-camera-retake-icon-btn" data-client-id="' + c.id + '" aria-label="Fai foto">' + svgIcon('camera') + '</button>' : '') +
      '<div class="dp-client-chevron">›</div>' +
      '</div>' +
      '</div>';
  }

  // RESTORED — these two declarations were accidentally deleted when
  // the Delivery Planner code was first inserted in place of the old
  // renderNavigatore() (a str_replace that matched and consumed these
  // lines without preserving them in the replacement). Confirmed as
  // the real cause of "ReferenceError: navSearchFocusPoint is not
  // defined" — assigning to a genuinely undeclared name throws in
  // strict mode (which this whole file runs in), rather than quietly
  // creating an accidental global the way it would in non-strict code.
  // Both are still used — by the old, now-dead renderNavigatore/active-
  // navigation code (harmless, unreached) AND by the NEW Delivery
  // Planner's own geocoding bias fix, which is what actually broke.
  var navLocateMarker = null; // "you are here" marker dropped by the standalone locate button, kept separate from the active-navigation position marker
  var navSearchFocusPoint = null; // driver's GPS position, used to bias/rank geocoding results toward nearby places first
  // REAL BUG, reported directly and confirmed: this used to be a
  // plain boolean, set once on a genuine PERMISSION_DENIED and never
  // reset except by a full page reload — meaning a single denial
  // (including a transient one, e.g. iOS briefly refusing a location
  // request for its own internal reasons even with permission
  // actually granted) silently disabled AUTO, manual Reordina, AND
  // the nearby-search bias for the ENTIRE rest of the session, with
  // zero visible feedback on AUTO's own silent-failure path — exactly
  // matching a report of "AUTO does nothing at all, no message,
  // nothing changes". Changed to a timestamp instead: still skips
  // repeating a GPS prompt for a short cooldown right after a real
  // denial (avoiding hammering the browser with rapid repeat prompts
  // during that immediate moment), but automatically expires and
  // tries again fresh after 60 seconds — a genuinely permanent denial
  // (from the device's own Settings) will simply get re-flagged
  // again quickly, at negligible cost; a transient one recovers on
  // its own instead of bricking these features until reload.
  var dpGeoDeniedAt = null;
  function dpGeoRecentlyDenied() { return dpGeoDeniedAt !== null && (Date.now() - dpGeoDeniedAt) < 60000; }
  var dpLastAutoOptimizedSignature = null; // exact ORDER of pending client ids last successfully applied by auto-riordina — see the auto-riordina check at the top of renderDeliveryPlanner
  var dpAutoOptimizationInFlight = false; // guards against a second auto-riordina call firing while one is still waiting on a network response
  // REAL BUG, found through a deliberate stress test (15 clients,
  // checking several off within one Riordina session): completedAt
  // was only ever stamped inside dpConfirmReordina's own
  // checkboxes.forEach loop, which runs ONCE, all at once, only when
  // "Ricalcola percorso" is actually pressed. Checking three boxes in
  // one sitting and THEN confirming gave all three nearly-identical
  // timestamps (or worse, ties), so the completed-order sort added
  // earlier could never actually reflect which one the driver
  // genuinely tapped first, second, third — it was really just
  // replaying checkboxes.forEach's own DOM order, not real check
  // order, defeating the whole point of that sort. Tracked here
  // instead, the moment each checkbox is actually toggled ON in the
  // UI (a real 'change' event, not deferred to confirm time) — an
  // ever-increasing counter, reset fresh every time this modal opens,
  // used at confirm time as the real completedAt instead of a
  // same-instant Date.now() for the whole batch.
  var dpReordinaCheckOrder = {};
  var dpReordinaCheckCounter = 0;
  var dpAutoOptimizationSafetyTimer = null; // independent 20s safety net — force-clears dpAutoOptimizationInFlight no matter what, so a single failure can never permanently disable auto-riordina for the rest of the session

  // Auto-archives the previous day's run the moment a new calendar day
  // is detected — no manual "end of day" action needed, matching what
  // ION actually asked for: clients don't need re-adding daily, and
  // each day's deliveries land in a history section automatically,
  // without extra taps. Only archives runs that actually have
  // clients — an empty run (nothing ever added) isn't meaningful
  // history, just noise.
  // Shared archiving core — appends the given run's clients to
  // history (bounded to 90 days) and returns a fresh, empty run
  // stamped with today's date. Used by both the automatic
  // end-of-calendar-day archiving and the manual "archive now" action.
  function dpArchiveRunToHistory(run) {
    if (run.date && run.clients && run.clients.length) {
      syncDeliveriesToServer(run.clients);
      var history = loadDeliveryHistory();
      // REAL BUG, reported directly, with a concrete example: archiving
      // more than once on the SAME calendar day (e.g. manually starting
      // a fresh route mid-day after finishing an earlier batch) used to
      // just unshift a brand new, separate entry every time — "Mercoledì
      // 19 ago" ended up appearing three separate times in Storico,
      // fragmented (9 clienti, then 6, then 2), instead of reading as
      // one coherent day. Now merges into the most recent entry when it
      // already has TODAY'S same date, appending the newly-archived
      // clients onto it, rather than creating another separate row.
      if (history.length && history[0].date === run.date) {
        history[0].clients = history[0].clients.concat(run.clients);
      } else {
        history.unshift({ date: run.date, clients: run.clients });
      }
      // Requested directly: needs to be able to scroll back and find
      // real days from months ago (explicitly: "jumatate de an in
      // urma" — half a year back), to check what was delivered and at
      // what time. 90 days was too short a cutoff for that. Raised to
      // a full year (365) — comfortably covers his stated need with
      // margin, while still keeping a sane upper bound so this can
      // never grow completely unbounded (a real, if distant, concern
      // for localStorage's own size limits over many years of daily
      // use).
      if (history.length > 365) history = history.slice(0, 365);
      saveDeliveryHistory(history);
    }
    return { clients: [], date: todayDateStr() };
  }

  function dpArchiveIfNewDay() {
    var today = todayDateStr();
    var run = state.deliveryRun;
    if (run.date === today) return; // already on today, nothing to do
    // MIGRATION SAFETY, critical: a run saved before this feature
    // existed has no "date" field at all — treating a missing date
    // the same as "belongs to some other, past day" would have
    // archived-then-WIPED any real, currently-active client list the
    // very first time this code ran after the update, purely because
    // the date field happened to be new. A run with real clients but
    // no date is today's own current list, not history — claimed as
    // today in place, never archived, never emptied.
    if (!run.date && run.clients && run.clients.length) {
      run.date = today;
      saveDeliveryRun(run);
      return;
    }
    state.deliveryRun = dpArchiveRunToHistory(run);
    saveDeliveryRun(state.deliveryRun);
  }

  // Manual archive — ION's own real case: all of today's clients
  // done, wants to start a fresh list right away rather than waiting
  // for the calendar day to actually change at midnight.
  function dpArchiveNowAndStartFresh() {
    if (!window.confirm('Archiviare la lista di oggi e iniziarne una nuova?')) return;
    state.deliveryRun = dpArchiveRunToHistory(state.deliveryRun);
    saveDeliveryRun(state.deliveryRun);
    renderDeliveryPlanner();
  }

  function dpFormatDateIt(dateStr) {
    var parts = dateStr.split('-');
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    var giorni = ['Domenica', 'Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato'];
    var mesi = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
    return giorni[d.getDay()] + ' ' + d.getDate() + ' ' + mesi[d.getMonth()];
  }

  // Requested directly, specifically for the nav row between Giorno
  // prec./succ.: the weekday name on its own line, day+month below —
  // deliberate two-line HTML (not just left to wrap wherever it
  // happens to break), same underlying date pieces as
  // dpFormatDateIt() above, just laid out explicitly.
  function dpFormatDateItTwoLines(dateStr) {
    var parts = dateStr.split('-');
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    var giorni = ['Domenica', 'Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato'];
    var mesi = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
    return '<div>' + giorni[d.getDay()] + '</div><div>' + d.getDate() + ' ' + mesi[d.getMonth()] + '</div>';
  }

  function dpOpenHistoryModal() {
    var history = loadDeliveryHistory();
    var listEl = document.getElementById('dp-history-list');
    if (!history.length) {
      listEl.innerHTML = '<div style="color:var(--ink-soft);text-align:center;padding:20px 0;">Nessuno storico ancora.</div>';
    } else {
      var html = '';
      history.forEach(function (day, idx) {
        var completed = day.clients.filter(function (c) { return c.status === 'completed'; }).length;
        html += '<div class="card dp-history-row" data-history-idx="' + idx + '" style="margin-bottom:10px;">' +
          '<div style="font-weight:700;">' + dpFormatDateIt(day.date) + '</div>' +
          '<div style="color:var(--ink-soft);font-size:13px;margin-top:2px;">' + day.clients.length + ' clienti · ' + completed + ' completati</div>' +
          '</div>';
      });
      listEl.innerHTML = html;
      listEl.querySelectorAll('.dp-history-row').forEach(function (row) {
        row.addEventListener('click', function () { dpOpenHistoryDayDetail(Number(row.getAttribute('data-history-idx'))); });
      });
    }
    document.getElementById('dp-history-close-x').onclick = function () { dpCloseModal('modal-dp-history'); };
    document.getElementById('modal-dp-history').classList.add('open');
  }

  function dpOpenHistoryDayDetail(idx) {
    var history = loadDeliveryHistory();
    var day = history[idx];
    if (!day) return;
    var navEl = document.getElementById('dp-history-detail-nav');
    var detailEl = document.getElementById('dp-history-detail');
    var hasPrev = idx < history.length - 1; // history is stored newest-first, so "previous day" (further back) is the NEXT array index
    var hasNext = idx > 0;
    // Nav row (prev/next + date) goes into the FIXED top section now,
    // separate from the scrolling client list — requested directly,
    // same pattern as everywhere else in the app now: the page title
    // stays put, only the content scrolls.
    navEl.innerHTML = '<div class="dp-history-nav-row">' +
      '<button type="button" class="dp-history-nav-btn" id="dp-history-prev-day"' + (hasPrev ? '' : ' disabled') + '>‹ Giorno prec.</button>' +
      '<div class="dp-history-nav-date">' + dpFormatDateItTwoLines(day.date) + '</div>' +
      '<button type="button" class="dp-history-nav-btn" id="dp-history-next-day"' + (hasNext ? '' : ' disabled') + '>Giorno succ. ›</button>' +
      '</div>';
    var html = '';
    day.clients.forEach(function (c, i) { html += dpClientRowHtml(c, i, true); });
    detailEl.innerHTML = html;
    document.getElementById('dp-history-detail-close-x').onclick = function () { dpCloseModal('modal-dp-history-detail'); };
    document.getElementById('modal-dp-history-detail').classList.add('open');
    if (hasPrev) document.getElementById('dp-history-prev-day').addEventListener('click', function () { dpOpenHistoryDayDetail(idx + 1); });
    if (hasNext) document.getElementById('dp-history-next-day').addEventListener('click', function () { dpOpenHistoryDayDetail(idx - 1); });
    detailEl.scrollTop = 0; // jumping to a different day should always start at the top, not wherever the previous day happened to be scrolled to
  }

  function renderDeliveryPlanner() {
    dpArchiveIfNewDay();

    // REAL BUG, found and confirmed: navSearchFocusPoint (the driver's
    // position, used to bias geocoding results toward nearby matches
    // first) was only ever set from the OLD turn-by-turn Navigatore's
    // own render function — which stopped running the moment this
    // screen replaced it. Every address search since has been running
    // with ZERO geographic bias, ranking results from anywhere in
    // Italy with no sense of which one is actually near the driver —
    // very plausibly why a real, existing address wasn't turning up.
    // Fetched here instead, once per visit to this screen, silently
    // (no permission-prompt banner needed — this is a soft ranking
    // input, not a hard requirement the way active navigation was).
    if (navigator.geolocation && !dpGeoRecentlyDenied()) {
      // REAL BUG, found and confirmed while diagnosing a reported bad
      // auto-riordina ordering: this used the browser's raw
      // getCurrentPosition directly, relying only on its own internal
      // `timeout` option. On the affected iOS standalone-PWA bug, that
      // internal timeout can be silently ignored — neither callback
      // ever fires. Since this runs on every single visit/re-render of
      // this screen (not just once), a hang here doesn't just fail
      // once — it means navSearchFocusPoint stays FROZEN at whatever
      // its last successful value was (which could be from early in
      // the day, even from home) for the rest of the session, since
      // dpGeoDeniedAt never gets set either (no error
      // callback fires to set it). Every later auto-riordina fallback
      // to this stale point would then compute a route relative to a
      // WRONG starting location — exactly matching the report that
      // stops which should logically come first were ending up last.
      // Wrapped in the same independent safety-net timeout used
      // elsewhere now, so a hang here reliably clears within a few
      // seconds instead of freezing this position for the rest of the
      // session.
      currentPositionSafe(8000, { enableHighAccuracy: false, maximumAge: 300000 }).then(function (pos) {
        navSearchFocusPoint = { lat: pos.lat, lon: pos.lon };
      }).catch(function (err) {
        // no GPS fix available — searches still work, just without the nearby-bias.
        // A DENIED result specifically also pauses re-attempts from
        // this screen for a short cooldown (dpGeoRecentlyDenied) —
        // same reasoning as dpConfirmReordina below. Checked as the
        // literal code 1 (not err.PERMISSION_DENIED) on purpose — a
        // plain Error (from currentPositionSafe's own timeout) has
        // neither .code nor .PERMISSION_DENIED, so comparing against
        // .PERMISSION_DENIED would silently compare undefined===
        // undefined and misclassify a mere timeout as a permanent
        // denial, wrongly disabling every later GPS attempt this
        // session over what might have been a one-off hang.
        if (err && err.code === 1) dpGeoDeniedAt = Date.now();
      });
    }

    var el = document.getElementById('screen-navigatore');
    var run = state.deliveryRun;
    var stats = dpStats(run);
    var html = '';

    // ---- Auto-riordina: run the same optimization Reordina does
    // manually, automatically, whenever the pending clients (or their
    // ORDER) have actually changed since the last time it ran — not
    // on every render, since re-renders happen constantly for
    // unrelated reasons (e.g. just checking off a delivery).
    //
    // REAL GAP, reported directly: this used to compare a SORTED set
    // of ids, meaning it only reacted to a client being added or
    // removed — dragging clients into a different manual order left
    // the set identical, so AUTO never noticed and never corrected
    // it back. ION was explicit: "orice modificare eu o fac manual,
    // el trebuie sa o refaca asa cum crede el" — ANY manual change,
    // including pure reordering, should be overridden the next time
    // AUTO runs, not just additions/removals. Signature is now the
    // exact ORDER of pending ids (no more .sort()), so a manual drag
    // is detected as a real change too.
    //
    // dpLastAutoOptimizedSignature is deliberately NOT updated here
    // at trigger time anymore — only once dpRunAutoOptimization
    // actually finishes applying a result (see there), matching the
    // REAL final order rather than the pre-optimization one. Setting
    // it here (to the order-sensitive pre-optimization signature)
    // would otherwise immediately mismatch the post-optimization
    // order on the very next render and re-trigger forever.
    // dpAutoOptimizationInFlight guards against firing a second,
    // overlapping call while one is still waiting on a network
    // response.
    if (dpAutoRiordinaEnabled() && !dpAutoOptimizationInFlight) {
      var pendingForAuto = run.clients.filter(function (c) { return c.status !== 'completed'; });
      var autoSig = pendingForAuto.map(function (c) { return c.id; }).join(',');
      if (pendingForAuto.length > 1 && autoSig !== dpLastAutoOptimizedSignature) {
        dpAutoOptimizationInFlight = true;
        // REAL BUG, reported directly: "deja nu mai functioneaza nici
        // cum functiona" — worse than before this change. Root cause:
        // dpAutoOptimizationInFlight had no recovery path. If
        // dpRunAutoOptimization() ever threw synchronously, or its
        // promise chain somehow never settled, this flag stayed stuck
        // at true FOREVER — the guard above then silently blocked
        // every future attempt for the rest of the session, no
        // visible error, no recovery short of reloading. A single
        // failure anywhere permanently bricked the feature — strictly
        // worse than having no guard at all. Fixed two ways: wrapped
        // in try/catch (a synchronous throw resets the flag right
        // away), AND an independent safety-net timeout
        // (dpAutoOptimizationSafetyTimer, force-cleared inside
        // dpRunAutoOptimization on every real exit path) force-clears
        // the flag after 20s no matter what — same "never trust a
        // single flag with no way out" principle already used for
        // currentPositionSafe() elsewhere in this file.
        dpAutoOptimizationSafetyTimer = setTimeout(function () { dpAutoOptimizationInFlight = false; }, 20000);
        try {
          dpRunAutoOptimization();
        } catch (err) {
          dpAutoOptimizationInFlight = false;
          clearTimeout(dpAutoOptimizationSafetyTimer);
        }
      }
    }

    // Everything from here down to the closing </div> below (title,
    // vehicle, stats, the three action buttons, and the Casa/Deposito
    // card when it's showing) is wrapped as one sticky block — it
    // stays pinned to the top of the SAME scrolling area main already
    // uses everywhere else in the app, rather than disabling main's
    // own scroll and building a separate flex/overflow chain for it
    // (an earlier attempt at that broke scrolling outright — this
    // sticky approach doesn't touch main's proven-working scroll
    // mechanism at all, just pins this block visually within it).
    html += '<div class="dp-sticky-header">';
    html += '<div class="dp-header-row"><h2 class="dp-title">Percorso di oggi</h2>' +
      '<div class="dp-header-actions">' +
      '<button type="button" class="btn-icon-text" id="dp-history-btn">📋 Storico</button>' +
      '<button type="button" class="btn-icon-text" id="dp-archive-btn" aria-label="Archivio clienti">' + svgIcon('archive') + '</button>' +
      '</div></div>';
    html += '<div class="dp-stats-row">' +
      '<div class="dp-stat"><div class="dp-stat-num">' + stats.total + '</div><div class="dp-stat-label">clienti</div></div>' +
      '<div class="dp-stat"><div class="dp-stat-num" style="color:var(--teal)">' + stats.completed + '</div><div class="dp-stat-label">completati</div></div>' +
      '<div class="dp-stat"><div class="dp-stat-num" style="color:var(--accent)">' + stats.remaining + '</div><div class="dp-stat-label">rimanenti</div></div>' +
      '</div>';

    html += '<button type="button" class="btn btn-accent btn-block" id="dp-add-client-btn" style="margin:14px 0 10px;">+ Aggiungi cliente</button>';
    html += '<div class="dp-auto-row"><span class="dp-auto-label">Auto</span><button type="button" class="dp-auto-toggle' + (dpAutoRiordinaEnabled() ? ' on' : '') + '" id="dp-auto-riordina-toggle" role="switch" aria-checked="' + (dpAutoRiordinaEnabled() ? 'true' : 'false') + '" aria-label="Riordino automatico"></button></div>';
    html += '<button type="button" class="btn btn-block dp-reordina-btn" id="dp-reordina-btn"' + (stats.remaining === 0 ? ' disabled' : '') + ' style="margin-bottom:6px;">' + svgIcon('sort') + ' Reordina</button>';
    // Always available whenever there's at least one pending client —
    // reads run.clients directly, in whatever order it's CURRENTLY
    // in (drag-reordered, Reordina-optimized, or just insertion
    // order) — no separate "must run Reordina first" gate, and no
    // separate snapshot that could ever drift out of sync with what's
    // actually shown in the list above it.
    var pendingCount = run.clients.filter(function (c) { return c.status !== 'completed'; }).length;
    if (pendingCount > 0) {
      html += '<button type="button" class="btn btn-dark btn-block" id="dp-open-gmaps-btn" style="margin-bottom:0;">Apri in Google Maps (' + Math.min(pendingCount, 9) + ' tappe)</button>';
    }

    // Section 15 of the spec: after the last client, offer Casa/
    // Deposito — reusing the EXISTING home/work shortcuts storage
    // (pt_nav_homework_v1, already built for the old Navigatore's own
    // Casa/Lavoro shortcuts) rather than building a separate store for
    // essentially the same two saved locations. "Lavoro" doubles as
    // "Deposito" here — the same real-world place for a truck driver.
    if (stats.total > 0 && stats.remaining === 0) {
      var hw = loadNavHomeWork();
      // Tighter top padding than the card's own default (20px) —
      // ION's own request, less empty space between the buttons above
      // and this card, without letting anything actually overlap
      // (bottom/side padding stay at the normal 20px, only the top is
      // reduced).
      html += '<div class="card" style="text-align:center;padding-top:12px;">';
      html += '<div style="font-weight:800;font-size:16px;margin-bottom:10px;">✓ Tutte le consegne completate</div>';
      if (hw.home) html += '<button type="button" class="btn btn-dark btn-block" id="dp-nav-home-btn" style="margin-top:8px;">Naviga a casa</button>';
      if (hw.work) html += '<button type="button" class="btn btn-dark btn-block" id="dp-nav-work-btn" style="margin-top:8px;">Naviga al deposito</button>';
      if (!hw.home && !hw.work) {
        html += '<div style="color:var(--ink-soft);font-size:13px;margin-bottom:8px;">Imposta un indirizzo di casa o deposito per un rientro rapido.</div>';
        html += '<button type="button" class="btn btn-outline btn-block" id="dp-setup-homework-btn">Imposta indirizzi</button>';
      }
      // Manual archive, not just the automatic end-of-calendar-day
      // one — ION's own case: all 4 done, same day, wants to start a
      // fresh list right away rather than waiting until midnight for
      // today's completed run to move into Storico.
      html += '<button type="button" class="btn btn-outline btn-block" id="dp-archive-now-btn" style="margin-top:8px;">Archivia e inizia nuova lista</button>';
      html += '</div>';
    }
    html += '</div>'; // closes dp-sticky-header

    if (run.clients.length === 0) {
      html += '<div class="card" style="text-align:center;color:var(--ink-soft);">Nessun cliente ancora. Aggiungi il primo per iniziare.</div>';
    } else {
      // No height cap needed anymore — main's own scroll (the same
      // proven mechanism every other screen already uses) handles
      // however tall this gets; the sticky header above just stays
      // pinned to the top of that same scroll as the list moves
      // underneath it.
      html += '<div class="dp-list">';
      run.clients.forEach(function (c, idx) { html += dpClientRowHtml(c, idx); });
      html += '</div>';
    }

    el.innerHTML = html;
    dpSyncStickyHeaderHeight(); // real, rendered height of the just-inserted header — must run AFTER innerHTML, not before

    el.querySelectorAll('.dp-camera-retake-icon-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation(); // must never also trigger the row's own click (which opens Modifica cliente)
        dpOpenCameraForOneClient(btn.getAttribute('data-client-id'));
      });
    });

    document.getElementById('dp-add-client-btn').addEventListener('click', dpOpenAddClientModal);
    var reordinaBtn = document.getElementById('dp-reordina-btn');
    if (reordinaBtn) reordinaBtn.addEventListener('click', dpOpenReordinaModal);
    var autoToggle = document.getElementById('dp-auto-riordina-toggle');
    if (autoToggle) autoToggle.addEventListener('click', function () {
      var turningOn = !dpAutoRiordinaEnabled();
      dpSetAutoRiordinaEnabled(turningOn);
      // REAL BUG, reported directly ("nu se intampla nimic vizibil,
      // fara mesaj"): turning AUTO on silently does nothing at all in
      // two genuine, common cases — only 1 delivery left pending
      // (nothing to reorder), or the list already matches AUTO's own
      // last-optimized order (e.g. right after using manual
      // "Ricalcola percorso" on the same, unchanged list) — the
      // trigger check inside renderDeliveryPlanner below stays quiet
      // in both, by design, since it also runs on every unrelated
      // re-render and can't toast every single time. Checked here
      // instead, ONLY at the moment of turning it on, where a message
      // is actually warranted — and shown INSTEAD OF the coordinates
      // info card below, not alongside it, so the driver isn't hit
      // with two separate messages at once.
      var alreadyExplained = false;
      if (turningOn) {
        var pendingNow = state.deliveryRun.clients.filter(function (c) { return c.status !== 'completed'; });
        var sigNow = pendingNow.map(function (c) { return c.id; }).join(',');
        if (pendingNow.length <= 1) {
          toast(pendingNow.length === 1 ? 'Auto attivo — nulla da riordinare, resta solo una consegna.' : 'Auto attivo — tutte le consegne sono già completate.', 3500);
          alreadyExplained = true;
        } else if (sigNow === dpLastAutoOptimizedSignature) {
          toast('Auto attivo — il percorso è già nell\'ordine ottimale.', 3000);
          alreadyExplained = true;
        }
      }
      renderDeliveryPlanner(); // re-render flips the visual state immediately, and (via the auto-run check at the top of this function) triggers an optimization right away if it was just switched on
      // Requested directly: explain, briefly, each time this is
      // switched ON specifically (not when switching it off) — why
      // coordinates matter for this feature to work reliably.
      if (turningOn && !alreadyExplained) showAutoRiordinaInfoNotice();
    });
    var gmapsBtn = document.getElementById('dp-open-gmaps-btn');
    if (gmapsBtn) gmapsBtn.addEventListener('click', dpOpenInGoogleMaps);
    var homeBtn = document.getElementById('dp-nav-home-btn');
    if (homeBtn) homeBtn.addEventListener('click', function () { dpNavigateToSaved('home'); });
    var workBtn = document.getElementById('dp-nav-work-btn');
    if (workBtn) workBtn.addEventListener('click', function () { dpNavigateToSaved('work'); });
    var setupHwBtn = document.getElementById('dp-setup-homework-btn');
    if (setupHwBtn) setupHwBtn.addEventListener('click', openNavHomeWorkModal); // pre-existing modal/flow, unchanged — just opened from here now too
    document.getElementById('dp-history-btn').addEventListener('click', dpOpenHistoryModal);
    document.getElementById('dp-archive-btn').addEventListener('click', dpOpenArchiveModal);
    var archiveNowBtn = document.getElementById('dp-archive-now-btn');
    if (archiveNowBtn) archiveNowBtn.addEventListener('click', dpArchiveNowAndStartFresh);
    document.querySelectorAll('.dp-client-row').forEach(function (row) {
      row.addEventListener('click', function () {
        // A row left swiped open (Elimina button revealed) just closes
        // back up on tap, same as the saved-client suggestions — an
        // open delete button is a clear enough state that tapping
        // elsewhere should back out of it, not also open Modifica.
        if (row._dpSwipeBaseOffset) {
          row._dpSwipeBaseOffset = 0;
          row.style.transition = 'transform .18s ease';
          row.style.transform = 'translateX(0)';
          return;
        }
        dpOpenEditClientModal(row.getAttribute('data-client-id'));
      });
    });
    dpWireClientListSwipeToDelete();
    dpWireDragReorder();
  }

  // Same swipe-to-reveal-delete mechanic already used for saved-client
  // suggestions in Aggiungi cliente, adapted here for TODAY'S list —
  // removes from the current run (same effect as the existing
  // "Rimuovi dalla lista di oggi" button in Modifica cliente), just
  // reachable directly from the list without opening that modal first.
  // Shared, single implementation of the swipe-to-reveal-delete
  // mechanic — replaces two near-identical copies (this list, and the
  // saved-client suggestions in Aggiungi cliente) that had drifted
  // into having the exact same gaps independently. One correct
  // version now, used by both.
  //
  // Tracks which row (if any) is CURRENTLY left open, globally — so
  // starting a new swipe on a DIFFERENT row, or tapping anywhere else
  // in the app, closes whatever was previously open automatically.
  // Per ION's own explicit request: swiping one client open, then
  // moving on to a different one, should snap the first one back —
  // not leave it sitting open indefinitely.
  var dpOpenSwipeRow = null;

  function dpCloseOpenSwipeRow() {
    if (!dpOpenSwipeRow) return;
    dpOpenSwipeRow._dpSwipeBaseOffset = 0;
    dpOpenSwipeRow.style.transition = 'transform .18s ease';
    dpOpenSwipeRow.style.transform = 'translateX(0)';
    dpOpenSwipeRow = null;
  }

  // Closes an open swipe on any tap that lands OUTSIDE that row and
  // its own delete button (both live inside the same .dp-swipe-wrap)
  // — covers every other case at once (tapping a different row, a
  // button, the drag handle, opening a modal) via one listener rather
  // than needing this handled at every call site.
  document.addEventListener('touchstart', function (e) {
    if (!dpOpenSwipeRow) return;
    var wrap = dpOpenSwipeRow.closest('.dp-swipe-wrap');
    if (!wrap || !wrap.contains(e.target)) dpCloseOpenSwipeRow();
  }, { passive: true, capture: true });

  function dpWireSwipeRow(row) {
    var REVEAL = 84; // px — matches the delete button's own width, see CSS
    var startX = null, dragging = false;
    row._dpSwipeBaseOffset = 0;

    row.addEventListener('touchstart', function (e) {
      if (dpOpenSwipeRow && dpOpenSwipeRow !== row) dpCloseOpenSwipeRow();
      startX = e.touches[0].clientX;
      dragging = true;
      row.style.transition = 'none';
    }, { passive: true });

    row.addEventListener('touchmove', function (e) {
      if (!dragging || startX == null) return;
      var dx = startX - e.touches[0].clientX; // positive while dragging left
      var next = Math.max(0, Math.min(REVEAL, dx + row._dpSwipeBaseOffset));
      row.style.transform = 'translateX(' + (-next) + 'px)';
    }, { passive: true });

    function finishTouch(e) {
      if (!dragging) return;
      dragging = false;
      var endX = (e.changedTouches && e.changedTouches[0]) ? e.changedTouches[0].clientX : startX;
      var dx = startX != null ? (startX - endX) : 0;
      var finalOffset = Math.max(0, Math.min(REVEAL, dx + row._dpSwipeBaseOffset));
      row._dpSwipeBaseOffset = finalOffset > REVEAL / 2 ? REVEAL : 0;
      row.style.transition = 'transform .18s ease';
      row.style.transform = 'translateX(' + (-row._dpSwipeBaseOffset) + 'px)';
      dpOpenSwipeRow = row._dpSwipeBaseOffset ? row : null;
      startX = null;
    }
    row.addEventListener('touchend', finishTouch);
    // REAL BUG, found on review: touchcancel — the OS interrupting a
    // gesture mid-drag (an incoming call, a notification banner,
    // switching apps) — had NO handler at all. dragging stayed true
    // and startX stayed stale, which could corrupt the NEXT,
    // unrelated touch on this same row. Treated the same as a normal
    // release now — whatever position it's at just settles in place.
    row.addEventListener('touchcancel', finishTouch);

    // Tapping the row itself while it's swiped open just closes it
    // again, rather than also triggering its normal tap action.
    row.addEventListener('click', function (e) {
      if (row._dpSwipeBaseOffset) {
        e.stopPropagation(); e.preventDefault();
        dpCloseOpenSwipeRow();
      }
    }, true);
  }

  function dpWireClientListSwipeToDelete() {
    document.querySelectorAll('.dp-list .dp-swipe-wrap').forEach(function (wrap) {
      dpWireSwipeRow(wrap.querySelector('.dp-swipe-row'));
    });
    document.querySelectorAll('.dp-list .dp-swipe-delete-btn').forEach(function (btn) {
      btn.addEventListener('click', function () { dpConfirmRemoveClient(btn.getAttribute('data-client-id')); });
    });
  }

  // Touch-drag reordering — ION's own explicit request: "trag fluid
  // mai jos mai sus" (drag fluidly up/down). Only the dedicated handle
  // (⠿, not the whole row) starts a drag, so it never conflicts with
  // the row's own existing tap-to-edit or swipe-to-delete behavior.
  //
  // Approach: while dragging, the picked-up row visually follows the
  // finger (transform: translateY, relative to its own resting
  // position) and every OTHER row smoothly shifts out of the way as
  // the finger crosses their vertical midpoint — a live preview of
  // the new order, not just a static drop target. The underlying
  // array is only actually reordered once, on release, from the
  // final visual position — not on every frame — keeping the data
  // model simple even though the visuals update continuously.
  function dpWireDragReorder() {
    var container = document.querySelector('.dp-list');
    if (!container) return;
    // The actual SCROLLING ancestor is main now (the list itself has
    // no scroll of its own anymore, see the sticky-header rework) —
    // this is what needs its scroll suspended during a drag, not the
    // list div itself.
    var scrollAncestor = document.querySelector('main');
    var wraps = Array.prototype.slice.call(container.querySelectorAll('.dp-swipe-wrap'));
    if (wraps.length < 2) return; // nothing to reorder with 0 or 1 clients

    wraps.forEach(function (wrap) {
      var handle = wrap.querySelector('.dp-drag-handle');
      if (!handle) return;
      var startY = null, wrapHeight = wrap.offsetHeight + 10; // +10 for the .dp-list gap between rows
      var startIndex = null, currentOffsetIndex = 0;
      var draggingWrap = null;

      // ---- Auto-scroll while dragging near the top/bottom edge ----
      // Requested directly: when dragging a client past the visible
      // rows, the list should start scrolling itself once the finger
      // nears the screen edge, rather than forcing a manual lift-and-
      // reposition. Refined after first feedback: too insensitive —
      // had to drag too close to the edge and then wait for it to
      // kick in. Reworked to a single continuous speed that eases
      // toward a target every frame, tied directly to how deep the
      // finger sits in the edge zone rather than to how long it's
      // been held — this makes it trigger immediately on entering the
      // zone (already moving at a felt starting speed, not zero),
      // keep gaining speed smoothly the deeper the finger pushes
      // toward the true edge, and ease back down just as smoothly the
      // moment it leaves the zone, instead of an abrupt cutoff.
      // Feedback after the last change: starting LATER than before,
      // not earlier — the zone got bigger (120px) but the speed right
      // at that outer boundary was barely above zero, so scrolling
      // wasn't actually FELT until the finger was already deep inside
      // it, near the true edge. Direct request: smaller trigger zone.
      // Fixed by shrinking the zone back down AND raising the speed
      // felt the instant it's entered, so crossing into the (smaller,
      // closer-to-the-edge) zone is immediately, unmistakably felt as
      // "scrolling now", not a slow fade-in from near-zero.
      // Confirmed working now that the boundary was fixed. Refined
      // further per direct feedback: should trigger right after
      // passing the first client (zone widened so it reaches that
      // point), and both the start and the stop should feel smooth/
      // fluid rather than snappy — eased down a bit for a gentler feel
      // while still starting promptly.
      // Small final tuning pass, direct feedback: works well, but
      // speed a touch too high, and start/stop should be a bit more
      // fluid still. Modest reductions across the board — not a
      // redesign, just gentler numbers.
      // Another small tuning pass, same direction as the last: still
      // a bit more speed and smoothness to take off.
      // Feedback after the earlier tuning passes: now the opposite
      // problem — starts too fast, overshoots past where the client
      // actually needs to go before there's time to react and stop.
      // Priority shifted from "responsive" to "controllable": lower
      // speeds at every stage, so there's room to react and settle
      // the drop exactly where intended, not just wherever it happens
      // to be once the auto-scroll is noticed and released.
      // Third tuning pass, still too aggressive per direct feedback:
      // cut roughly in half again.
      var EDGE_ZONE = 100; // px from the real visible edge — wide enough to catch it about one row in
      var MIN_TARGET_SPEED = 2.5; // px/frame felt as soon as the zone is entered
      var MAX_SPEED = 6; // px/frame at the very edge
      var EASE = 0.07; // how fast currentSpeed chases the target each frame — lower = smoother, more fluid start/stop
      var currentSpeed = 0; // signed px/frame, eases toward target both accelerating and decelerating
      var autoScrollRAF = null;
      var scrollAccum = 0; // net px the container has been auto-scrolled since drag start
      var lastTouchY = null;

      function updateDragPosition(touchY) {
        // dy is adjusted by scrollAccum so the dragged row keeps
        // visually following the finger even as the content shifts
        // underneath it from auto-scrolling -- without this the row
        // would appear to slip out from under the touch point every
        // time the list auto-scrolled.
        var dy = (touchY - startY) + scrollAccum;
        draggingWrap.style.transform = 'translateY(' + dy + 'px)';

        // Requested directly: "trebuie sa inteleaga cand se afla intre
        // doua" — this used a plain Math.round, switching slots the
        // instant the drag crossed the exact midpoint between two
        // rows, with no buffer at all. Ordinary finger tremor while
        // hovering right around that midpoint made it flicker back
        // and forth between two target slots rather than settling
        // predictably. HYSTERESIS added: once past a point, the drag
        // must cross a full 65% of a row's height (not just 50%)
        // before committing to a NEW slot — a small "sticky" dead zone
        // around each boundary so it clearly registers being between
        // two rows and holds there steadily, instead of visually
        // flip-flopping on tiny, involuntary movement.
        var rawOffset = dy / wrapHeight;
        var wantedOffset = currentOffsetIndex;
        if (rawOffset > currentOffsetIndex + 0.65) wantedOffset = Math.round(rawOffset);
        else if (rawOffset < currentOffsetIndex - 0.65) wantedOffset = Math.round(rawOffset);

        if (wantedOffset !== currentOffsetIndex) {
          var newIndex = startIndex + wantedOffset;
          if (newIndex < 0) newIndex = 0;
          if (newIndex > wraps.length - 1) newIndex = wraps.length - 1;
          var actualOffset = newIndex - startIndex;
          if (actualOffset !== currentOffsetIndex) {
            wraps.forEach(function (w, i) {
              if (w === draggingWrap) return;
              var shifted = (actualOffset > 0)
                ? (i > startIndex && i <= startIndex + actualOffset)
                : (i < startIndex && i >= startIndex + actualOffset);
              w.style.transition = 'transform .15s ease';
              w.style.transform = shifted ? 'translateY(' + (actualOffset > 0 ? -wrapHeight : wrapHeight) + 'px)' : '';
            });
            currentOffsetIndex = actualOffset;
          }
        }
      }

      function targetSpeedFor(touchY) {
        if (!scrollAncestor) return 0;
        // REAL BUG, found on review: this used scrollAncestor's own
        // (main's) bounding rect for the edge zone — but main spans
        // the FULL physical screen top-to-bottom, just padded
        // internally to leave room for the fixed topbar/sticky-header
        // above and the fixed bottomnav below. So rect.top/rect.bottom
        // were the true screen edges, not the visible list boundary —
        // meaning the finger had to get within EDGE_ZONE px of the
        // physical top/bottom of the phone (practically under the
        // topbar or bottomnav) before anything triggered. Reported
        // directly: in a small visible window like this one, it
        // should trigger the moment the drag reaches the edge of what
        // is actually VISIBLE (the last visible row), not the edge of
        // the screen itself. Fixed by measuring from the real visible
        // boundary instead — the sticky header's own bottom edge, and
        // the bottomnav's own top edge — which is exactly where the
        // driver's eyes (and thumb) actually judge "the edge" to be.
        var stickyHeaderEl = document.querySelector('.dp-sticky-header');
        var bottomNavEl = document.querySelector('.bottomnav');
        var visibleTop = stickyHeaderEl ? stickyHeaderEl.getBoundingClientRect().bottom : scrollAncestor.getBoundingClientRect().top;
        var visibleBottom = bottomNavEl ? bottomNavEl.getBoundingClientRect().top : scrollAncestor.getBoundingClientRect().bottom;

        if (touchY < visibleTop + EDGE_ZONE && scrollAncestor.scrollTop > 0) {
          var depthUp = Math.min(1, (visibleTop + EDGE_ZONE - touchY) / EDGE_ZONE);
          return -(MIN_TARGET_SPEED + (MAX_SPEED - MIN_TARGET_SPEED) * depthUp);
        }
        if (touchY > visibleBottom - EDGE_ZONE && scrollAncestor.scrollTop < scrollAncestor.scrollHeight - scrollAncestor.clientHeight) {
          var depthDown = Math.min(1, (touchY - (visibleBottom - EDGE_ZONE)) / EDGE_ZONE);
          return MIN_TARGET_SPEED + (MAX_SPEED - MIN_TARGET_SPEED) * depthDown;
        }
        return 0;
      }

      function autoScrollStep() {
        if (!draggingWrap) { autoScrollRAF = null; return; }
        var target = lastTouchY != null ? targetSpeedFor(lastTouchY) : 0;
        currentSpeed += (target - currentSpeed) * EASE; // eases toward target every frame — accelerates AND decelerates smoothly, no separate "stop" logic needed
        if (Math.abs(currentSpeed) < 0.4) currentSpeed = 0;

        if (currentSpeed !== 0 && scrollAncestor) {
          var before = scrollAncestor.scrollTop;
          scrollAncestor.scrollTop += currentSpeed;
          var actualDelta = scrollAncestor.scrollTop - before; // 0 once it hits the top/bottom of the page
          scrollAccum += actualDelta;
          if (actualDelta !== 0 && lastTouchY != null) updateDragPosition(lastTouchY);
        }
        autoScrollRAF = requestAnimationFrame(autoScrollStep);
      }

      function stopAutoScroll() {
        currentSpeed = 0;
        if (autoScrollRAF != null) { cancelAnimationFrame(autoScrollRAF); autoScrollRAF = null; }
      }

      handle.addEventListener('touchstart', function (e) {
        e.preventDefault(); // stops the LIST's own scroll from also engaging while dragging a row
        startY = e.touches[0].clientY;
        lastTouchY = startY;
        startIndex = wraps.indexOf(wrap);
        currentOffsetIndex = 0;
        scrollAccum = 0;
        currentSpeed = 0;
        draggingWrap = wrap;
        wrap.classList.add('dp-dragging');
        wrap.style.zIndex = '10';
        wrap.style.transition = 'none';
        if (scrollAncestor) scrollAncestor.style.overflowY = 'hidden'; // no competing scroll mid-drag
        if (autoScrollRAF == null) autoScrollRAF = requestAnimationFrame(autoScrollStep); // runs continuously for the whole drag — handles both accel and decel by itself, frame to frame
      }, { passive: false });

      handle.addEventListener('touchmove', function (e) {
        if (!draggingWrap || startY == null) return;
        lastTouchY = e.touches[0].clientY;
        updateDragPosition(lastTouchY);
      }, { passive: true });

      handle.addEventListener('touchend', function () {
        if (!draggingWrap) return;

        stopAutoScroll();
        wraps.forEach(function (w) { w.style.transition = ''; w.style.transform = ''; w.style.zIndex = ''; });
        draggingWrap.classList.remove('dp-dragging');
        if (scrollAncestor) scrollAncestor.style.overflowY = '';

        var finalIndex = startIndex + currentOffsetIndex;
        if (finalIndex !== startIndex) {
          var clientId = wrap.getAttribute('data-client-id');
          var clients = state.deliveryRun.clients;
          var fromIdx = clients.findIndex(function (c) { return c.id === clientId; });
          if (fromIdx !== -1) {
            var moved = clients.splice(fromIdx, 1)[0];
            clients.splice(finalIndex, 0, moved);
            saveDeliveryRun(state.deliveryRun);
          }
        }
        draggingWrap = null;
        startY = null;
        renderDeliveryPlanner(); // clean re-render from the actual new order, replacing the transform-based preview
      });

      // REAL BUG, found on review: no touchcancel handler existed at
      // all — if the OS interrupted a drag mid-gesture (an incoming
      // call, a notification, switching apps), scrollAncestor.overflowY
      // stayed stuck at 'hidden' FOREVER, since only touchend ever
      // reset it back. This is very plausibly why scrolling the list
      // stopped working entirely after some point — one interrupted
      // drag anywhere would silently break scrolling for the rest of
      // the session. Cleans up the same visual/overflow state as a
      // normal release, but deliberately does NOT commit any
      // reordering — an interrupted gesture isn't a clear "drop it
      // here" from the driver, so nothing changes in the data, only
      // the stuck visual/scroll state is fixed.
      handle.addEventListener('touchcancel', function () {
        if (!draggingWrap) return;
        stopAutoScroll();
        wraps.forEach(function (w) { w.style.transition = ''; w.style.transform = ''; w.style.zIndex = ''; });
        draggingWrap.classList.remove('dp-dragging');
        if (scrollAncestor) scrollAncestor.style.overflowY = '';
        draggingWrap = null;
        startY = null;
      });
    });
  }


  // ---- Aggiungi cliente: cerca salvato, oppure nuovo ----

  function dpCloseModal(id) { document.getElementById(id).classList.remove('open'); }

  // Requested directly: rather than saving "06:50" as an actual
  // default VALUE the moment a client is created (which would give
  // every single client a deadline whether the driver wanted one or
  // not), this only pre-fills the native time picker's own starting
  // point — the field itself stays genuinely empty (still saves as
  // "no deadline set") right up until the driver actually taps into
  // it, at which point 06:50 is filled in as a sensible starting
  // point to scroll from, rather than the device's own default
  // (usually the current time, rarely useful here). Wired once per
  // field, guarded so a second focus never overwrites whatever the
  // driver already chose.
  // Requested directly: the pre-filled starting point in the native
  // time picker differs by field — "Consegna entro" (a deadline,
  // typically an early-morning cutoff) defaults to 06:50, while "Non
  // prima delle" (can't be delivered before this time — typically a
  // shop's own opening hour, later in the morning) defaults to 07:50
  // instead — each field's own caller passes its own sensible
  // default in.
  function dpWireTimeDefault(inputEl, defaultTime) {
    if (!inputEl || inputEl.dataset.timeDefaultWired) return;
    inputEl.dataset.timeDefaultWired = '1';
    inputEl.addEventListener('focus', function () {
      if (!inputEl.value) inputEl.value = defaultTime;
    });
  }

  function dpOpenAddClientModal() {
    document.getElementById('dp-add-search-input').value = '';
    dpRenderAddClientResults('');
    document.getElementById('modal-dp-add-client').classList.add('open');
    document.getElementById('dp-add-close-x').onclick = function () { dpCloseModal('modal-dp-add-client'); };
    document.getElementById('dp-add-search-input').oninput = function (e) { dpRenderAddClientResults(e.target.value); };
    setTimeout(function () { document.getElementById('dp-add-search-input').focus(); }, 50);
  }

  function dpRenderAddClientResults(query) {
    var container = document.getElementById('dp-add-results');
    var q = (query || '').trim().toLowerCase();

    // REAL BUG, confirmed with ION directly: this used to exclude any
    // saved client already present in today's run — meaning typing a
    // letter or two for a client already added (even one already
    // marked completed) found nothing at all, making it look like
    // that client was never actually saved, and forcing a full
    // re-type of name+address as if brand new. Removed entirely — a
    // driver may genuinely want a second delivery to the same client
    // the same day, and even when they don't, seeing the match (and
    // simply not tapping it) is far less confusing than the search
    // silently pretending a real, saved client doesn't exist.
    // Matches on address too now, not just company name — ION's own
    // explicit request: he often remembers a client by street ("via
    // Goito") rather than by name, and typing a fragment of the
    // address (no need for "via" itself, just "goito") should surface
    // it just as readily as typing part of the name would.
    var matches = q.length >= 2
      ? state.deliveryClients.filter(function (c) {
          return c.nome.toLowerCase().indexOf(q) !== -1 || (c.indirizzo || '').toLowerCase().indexOf(q) !== -1;
        }).slice(0, 8)
      : [];

    var html = '';
    matches.forEach(function (c) {
      // Swipe-to-delete, iOS Mail-style: the actual row sits INSIDE a
      // wrapper, on top of a red "Elimina" button positioned behind
      // it. Dragging the row left reveals the button; releasing past
      // a threshold snaps it fully open, otherwise it springs back
      // closed. Wired up in dpWireSwipeToDelete below, after the HTML
      // is in the DOM.
      html += '<div class="dp-swipe-wrap" data-saved-id="' + c.id + '">' +
        '<button type="button" class="dp-swipe-delete-btn" data-saved-id="' + c.id + '">Elimina</button>' +
        '<div class="dp-search-result-row dp-swipe-row" data-saved-id="' + c.id + '">' +
        '<div class="dp-search-result-name">' + escapeHtml(c.nome) + '</div>' +
        '<div class="dp-search-result-addr">' + escapeHtml(c.indirizzo || '') + '</div>' +
        '</div>' +
        '</div>';
    });
    // Always offered — a genuinely new client, or one already saved
    // under a slightly different spelling the search didn't catch.
    if (q.length >= 2) {
      html += '<div class="dp-new-client-cta" id="dp-add-new-cta">+ Nuovo cliente' + (query ? ': "' + escapeHtml(query) + '"' : '') + '</div>';
    }
    container.innerHTML = html;
    dpWireSwipeToDelete(container);

    container.querySelectorAll('.dp-search-result-row').forEach(function (row) {
      row.addEventListener('click', function () { dpAddSavedClientToRun(row.getAttribute('data-saved-id')); });
    });
    var newCta = document.getElementById('dp-add-new-cta');
    if (newCta) newCta.addEventListener('click', function () { dpOpenNewClientModal(query); });
  }

  // Swipe-to-delete, iOS Mail-style — drag a saved-client suggestion
  // left to reveal a red "Elimina" underneath, release to snap it
  // open or springs back. Real permanent deletion of a SAVED client
  // (the address book, not just today's run) — for cleaning up
  // duplicate/wrong versions of the same client saved by mistake, per
  // ION's own explicit request.
  function dpWireSwipeToDelete(container, onDeleted) {
    container.querySelectorAll('.dp-swipe-wrap').forEach(function (wrap) {
      dpWireSwipeRow(wrap.querySelector('.dp-swipe-row'));
    });

    container.querySelectorAll('.dp-swipe-delete-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var savedId = btn.getAttribute('data-saved-id');
        var client = state.deliveryClients.find(function (c) { return c.id === savedId; });
        if (!client) return;
        // Requested directly: deleting a client from the saved archive
        // should also remove it from today's active run, if it's
        // there — before this, deleting from the archive left an
        // "orphaned" entry sitting in Percorso di oggi, still pointing
        // at a clientId that no longer existed anywhere. The
        // confirmation message says so explicitly whenever this would
        // actually happen, so it's never a silent surprise.
        var inTodayRun = state.deliveryRun.clients.filter(function (c) { return c.clientId === savedId; });
        var confirmMsg = 'Eliminare definitivamente "' + client.nome + '" dai clienti salvati?';
        if (inTodayRun.length) confirmMsg += ' Verrà rimosso anche dal percorso di oggi.';
        if (!window.confirm(confirmMsg)) return;
        state.deliveryClients = state.deliveryClients.filter(function (c) { return c.id !== savedId; });
        saveDeliveryClients(state.deliveryClients);
        if (inTodayRun.length) {
          state.deliveryRun.clients = state.deliveryRun.clients.filter(function (c) { return c.clientId !== savedId; });
          saveDeliveryRun(state.deliveryRun);
          if (currentScreen === 'navigatore') renderDeliveryPlanner(); // reflects the removal immediately if that screen happens to be showing right now, not just after navigating away and back
        }
        if (onDeleted) {
          onDeleted();
        } else {
          var input = document.getElementById('dp-add-search-input');
          dpRenderAddClientResults(input ? input.value : ''); // re-render with the same query — the deleted one simply won't be there anymore
        }
      });
    });
  }

  // ---- Archivio clienti: full saved address book (view/edit/delete
  // any saved client, independent of today's run), plus export/import
  // as a shareable file — requested directly: "as putea da file poate
  // unui coleg care sa faca acesti clienti el ii incarca si deja ii
  // are si el in app". Reuses the exact same swipe-to-delete row
  // markup/pattern already built for the "Aggiungi cliente" search
  // results, just pointed at the FULL list instead of a filtered one.

  // Requested directly: adding the same client to today's run twice
  // creates real confusion downstream (duplicate rows, doubled
  // distances/times in Reordina's calculation) — checked here, in ONE
  // shared place, and used by both spots a saved client can be added
  // to today's run (the archive's own "+" button and "Aggiungi
  // cliente"'s search results). A brand new client being saved for
  // the very first time never needs this check — it always gets a
  // freshly generated id, so it can't already be in today's run.
  function dpClientAlreadyInTodayRun(savedClientId) {
    return state.deliveryRun.clients.some(function (c) { return c.clientId === savedClientId; });
  }

  // "+" button in Archivio clienti — adds a saved client straight to
  // today's run, staying on the archive screen the whole time (no
  // navigation, no modal closing) so the driver can keep scrolling
  // and adding several more in a row. Same core effect as
  // dpAddSavedClientToRun (used by "Aggiungi cliente"'s own search),
  // just without closing that OTHER modal (which isn't even open
  // here) and with its own toast confirmation instead, since nothing
  // else visually signals success in this context.
  function dpArchiveAddToTodayRun(savedClientId) {
    var saved = state.deliveryClients.find(function (c) { return c.id === savedClientId; });
    if (!saved) return;
    if (dpClientAlreadyInTodayRun(savedClientId)) {
      toast(saved.nome + ' è già nel percorso di oggi', 2200);
      return;
    }
    state.deliveryRun.clients.push({
      id: uid(), clientId: saved.id, nome: saved.nome, indirizzo: saved.indirizzo,
      lat: saved.lat, lon: saved.lon, status: 'pending', scadenza: saved.scadenza || '', nonPrimaDi: saved.nonPrimaDi || ''
    });
    saveDeliveryRun(state.deliveryRun);
    if (currentScreen === 'navigatore') renderDeliveryPlanner(); // reflects immediately underneath if that screen happens to be showing right now
    toast(saved.nome + ' aggiunto al percorso di oggi ✓', 2000);
  }

  function dpOpenArchiveModal() {
    var searchInput = document.getElementById('dp-archive-search-input');
    searchInput.value = '';
    dpRenderArchiveList();
    searchInput.oninput = function (e) { dpRenderArchiveList(e.target.value); };
    wireNavClearButton(
      searchInput,
      document.getElementById('dp-archive-search-clear'),
      function () { dpRenderArchiveList(); } // clearing the field also clears the filter, back to the full list
    );
    // Requested directly: quick, always-available way to edit the
    // saved Casa/Deposito addresses from here — icons filled in via JS
    // (svgIcon) rather than duplicated as raw markup in index.html, so
    // there's exactly one definition of what these icons look like.
    // Opens the SAME existing modal used for the very first setup —
    // it already correctly pre-fills whatever is currently saved, so
    // this doubles as "set" and "edit" with no separate code path.
    var depositoBtn = document.getElementById('dp-archive-deposito-btn');
    depositoBtn.innerHTML = svgIcon('warehouse');
    depositoBtn.onclick = openNavHomeWorkModal;
    var casaBtn = document.getElementById('dp-archive-casa-btn');
    casaBtn.innerHTML = svgIcon('home');
    casaBtn.onclick = openNavHomeWorkModal;
    document.getElementById('modal-dp-archive').classList.add('open');
  }

  // Reuses the same "Nuovo cliente" modal/fields as adding a client
  // for today's run, but binds a DIFFERENT save handler — a client
  // added from the archive is meant to just be saved for future use,
  // NOT also pushed into today's active delivery run (which is what
  // the normal add-client flow does).
  function dpArchiveOpenNewClientModal() {
    // Requested directly: opening "Nuovo cliente" from the archive
    // should visually keep the archive list showing behind it, not
    // jump back to whatever screen was underneath (Percorso di oggi).
    // The archive modal is left open the whole time now — the z-index
    // rule on #modal-dp-new-client above is what makes this safe
    // (guarantees this form still receives clicks correctly, layered
    // on top, instead of the earlier close/reopen dance that was only
    // needed to work around the stacking bug).
    document.getElementById('dp-new-nome').value = '';
    document.getElementById('dp-new-indirizzo').value = '';
    document.getElementById('dp-new-scadenza').value = '';
    document.getElementById('dp-new-nonprima').value = '';
    document.getElementById('dp-new-save-result').innerHTML = '';
    // Requested directly: now that a deadline lives permanently on
    // the client itself (not just for one day's run), it makes just
    // as much sense to set it here too, at the moment a brand new
    // client is first saved into the archive — no longer hidden.
    document.getElementById('dp-new-scadenza-wrap').style.display = '';
    document.getElementById('dp-new-close-x').onclick = function () { dpCloseModal('modal-dp-new-client'); };
    document.getElementById('dp-new-save-btn').onclick = dpArchiveSaveNewClient;
    wireNavClearButton(document.getElementById('dp-new-nome'), document.getElementById('dp-new-nome-clear'), function () {});
    wireNavClearButton(document.getElementById('dp-new-indirizzo'), document.getElementById('dp-new-indirizzo-clear'), function () {});
    dpWireTimeDefault(document.getElementById('dp-new-scadenza'), '06:50');
    dpWireTimeDefault(document.getElementById('dp-new-nonprima'), '07:50');
    document.getElementById('modal-dp-new-client').classList.add('open');
  }

  function dpArchiveSaveNewClient() {
    var nome = document.getElementById('dp-new-nome').value.trim();
    var indirizzo = document.getElementById('dp-new-indirizzo').value.trim();
    var resultEl = document.getElementById('dp-new-save-result');
    if (!nome || !indirizzo) {
      resultEl.innerHTML = '<div style="color:var(--danger);font-size:13px;">Inserisci nome e indirizzo.</div>';
      return;
    }
    var saved = { id: uid(), nome: nome, indirizzo: indirizzo, lat: null, lon: null, createdAt: Date.now(), scadenza: document.getElementById('dp-new-scadenza').value || '', nonPrimaDi: document.getElementById('dp-new-nonprima').value || '' };
    state.deliveryClients.push(saved);
    saveDeliveryClients(state.deliveryClients);
    dpCloseModal('modal-dp-new-client');
    dpRenderArchiveList(document.getElementById('dp-archive-search-input') ? document.getElementById('dp-archive-search-input').value : ''); // the archive list underneath was never closed — just refreshes what's now visible again, keeping any active search filter
    dpBackgroundGeocodeForOrdering(saved.id, indirizzo); // same silent, best-effort background geocode as the normal add-client flow — for Reordina's ordering later, never for the address shown/sent to Google Maps
  }

  function dpRenderArchiveList(query) {
    var container = document.getElementById('dp-archive-list');
    var all = state.deliveryClients.slice().sort(function (a, b) { return a.nome.localeCompare(b.nome); });
    document.getElementById('dp-archive-count').textContent = all.length;

    // Same 2-letter threshold and name-OR-address matching already
    // used for "Aggiungi cliente" — requested directly, so the archive
    // behaves the same way once there are enough clients that
    // scrolling through all of them isn't practical anymore.
    var q = (query || '').trim().toLowerCase();
    var clients = q.length >= 2
      ? all.filter(function (c) { return c.nome.toLowerCase().indexOf(q) !== -1 || (c.indirizzo || '').toLowerCase().indexOf(q) !== -1; })
      : all;

    if (!all.length) {
      container.innerHTML = '<div class="card" style="text-align:center;color:var(--ink-soft);">Nessun cliente salvato ancora.</div>';
      return;
    }
    if (!clients.length) {
      container.innerHTML = '<div class="card" style="text-align:center;color:var(--ink-soft);">Nessun cliente trovato per "' + escapeHtml(query) + '".</div>';
      return;
    }

    var html = '';
    clients.forEach(function (c) {
      // Requested directly: showing which clients lack precise
      // coordinates directly from the archive itself, not only once
      // they're already added to today's run — same condition
      // dpClientRowHtml already uses elsewhere (c.lat == null ||
      // c.lon == null), so it's the exact same meaning everywhere in
      // the app. "⚠ non ottimizzato" isn't shown here on purpose —
      // that one reflects the outcome of the LAST optimization
      // attempt for a specific day's route, not a fixed property of
      // the saved client, so it wouldn't mean anything reliable
      // outside that context.
      var unverifiedBadge = (c.lat == null || c.lon == null)
        ? ' <span style="color:var(--accent);">⚠ non verificato</span>' : '';
      // Requested directly: the archive should show a client's own
      // saved schedule too, in the same amber/blue used everywhere
      // else this shows up (today's numbered list) — same reasoning,
      // same colors, just without a numbered position badge to color
      // here (the archive isn't an ordered route), so it's shown as
      // its own small line instead, right under the name.
      var scheduleNote = '';
      if (c.scadenza) scheduleNote = '<div style="color:#B45309;font-weight:700;font-size:12.5px;margin-top:2px;">⏱ entro ' + escapeHtml(c.scadenza) + '</div>';
      else if (c.nonPrimaDi) scheduleNote = '<div style="color:#1D4ED8;font-weight:700;font-size:12.5px;margin-top:2px;">⏱ non prima delle ' + escapeHtml(c.nonPrimaDi) + '</div>';
      // Requested directly: a standalone "+" button, independent from
      // tapping the row itself (which opens Modifica cliente) — since
      // the archive is already sorted alphabetically, scrolling to
      // find a client and adding it straight to today's run from
      // here, without detouring through the separate "Aggiungi
      // cliente" search, is a real, faster path for a driver who
      // already knows exactly who they need. Only in Archivio clienti
      // — .dp-search-result-row itself stays completely untouched, so
      // "Aggiungi cliente"'s own search results (where tapping the
      // row IS already the add-action) are unaffected.
      html += '<div class="dp-swipe-wrap" data-saved-id="' + c.id + '" data-letter="' + escapeHtml((c.nome || '?').trim().charAt(0).toUpperCase()) + '">' +
        '<button type="button" class="dp-swipe-delete-btn" data-saved-id="' + c.id + '">Elimina</button>' +
        '<div class="dp-search-result-row dp-archive-row dp-swipe-row" data-saved-id="' + c.id + '">' +
        '<div class="dp-search-result-name">' + escapeHtml(c.nome) + '</div>' +
        scheduleNote +
        '<div class="dp-search-result-addr">' + escapeHtml(c.indirizzo || '') + unverifiedBadge + '</div>' +
        '<button type="button" class="dp-archive-add-today-btn" data-saved-id="' + c.id + '" aria-label="Aggiungi al percorso di oggi">+</button>' +
        '</div>' +
        '</div>';
    });
    container.innerHTML = html;
    container.querySelectorAll('.dp-archive-add-today-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation(); // must never also trigger the row's own click (which opens Modifica cliente)
        dpArchiveAddToTodayRun(btn.getAttribute('data-saved-id'));
      });
    });
    dpWireSwipeToDelete(container, function () {
      var searchInput = document.getElementById('dp-archive-search-input');
      dpRenderArchiveList(searchInput ? searchInput.value : '');
    });

    container.querySelectorAll('.dp-search-result-row').forEach(function (row) {
      row.addEventListener('click', function () { dpArchiveOpenEdit(row.getAttribute('data-saved-id')); });
    });

    dpBuildAlphabetIndex(container);
  }

  // A-Z index in the left margin — requested directly. Shows the
  // whole alphabet, small, running top to bottom; whichever letter
  // the list is CURRENTLY scrolled to gets shown bigger, in the app's
  // own orange accent, so it's obvious at a glance which part of the
  // alphabetically-sorted list is on screen. Tapping a letter also
  // jumps straight to it, a natural extra given the same lookup
  // already has to exist for the highlighting itself.
  function dpBuildAlphabetIndex(listContainer) {
    var indexEl = document.getElementById('dp-alphabet-index');
    var letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    indexEl.innerHTML = letters.map(function (l) { return '<span data-letter="' + l + '">' + l + '</span>'; }).join('');

    var letterSpans = {};
    indexEl.querySelectorAll('span').forEach(function (s) { letterSpans[s.getAttribute('data-letter')] = s; });

    var rows = Array.prototype.slice.call(listContainer.querySelectorAll('.dp-swipe-wrap[data-letter]'));

    function updateCurrentLetter() {
      if (!rows.length) return;
      var containerTop = listContainer.getBoundingClientRect().top;
      // The row whose top edge is closest to (but not below) the
      // list's own top edge is the one currently "at the top" of
      // what's visible — same idea as a sticky section header would
      // track, without needing to build one.
      var current = rows[0];
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].getBoundingClientRect().top - containerTop <= 4) current = rows[i];
        else break;
      }
      var letter = current.getAttribute('data-letter');
      Object.keys(letterSpans).forEach(function (l) {
        letterSpans[l].classList.toggle('dp-letter-current', l === letter);
      });
    }
    listContainer.addEventListener('scroll', updateCurrentLetter);
    updateCurrentLetter();

    indexEl.querySelectorAll('span').forEach(function (s) {
      s.addEventListener('click', function () {
        var letter = s.getAttribute('data-letter');
        var target = rows.filter(function (r) { return r.getAttribute('data-letter') === letter; })[0];
        if (target) target.scrollIntoView({ block: 'start' });
      });
    });
  }

  function dpArchiveOpenEdit(savedId) {
    var c = state.deliveryClients.find(function (x) { return x.id === savedId; });
    if (!c) return;
    document.getElementById('dp-archive-edit-nome').value = c.nome;
    document.getElementById('dp-archive-edit-indirizzo').value = c.indirizzo || '';
    document.getElementById('dp-archive-edit-scadenza').value = c.scadenza || '';
    document.getElementById('dp-archive-edit-nonprima').value = c.nonPrimaDi || '';
    wireNavClearButton(document.getElementById('dp-archive-edit-nome'), document.getElementById('dp-archive-edit-nome-clear'), function () {});
    wireNavClearButton(document.getElementById('dp-archive-edit-indirizzo'), document.getElementById('dp-archive-edit-indirizzo-clear'), function () {});
    dpWireTimeDefault(document.getElementById('dp-archive-edit-scadenza'), '06:50');
    dpWireTimeDefault(document.getElementById('dp-archive-edit-nonprima'), '07:50');
    document.getElementById('dp-archive-edit-result').innerHTML = '';
    document.getElementById('dp-archive-edit-close-x').onclick = function () { dpCloseModal('modal-dp-archive-edit'); };
    document.getElementById('dp-archive-edit-remove-btn').onclick = function () {
      // Same cascade as the swipe-to-delete path — see the matching
      // comment there.
      var inTodayRun = state.deliveryRun.clients.filter(function (rc) { return rc.clientId === savedId; });
      var confirmMsg = 'Eliminare definitivamente "' + c.nome + '" dai clienti salvati?';
      if (inTodayRun.length) confirmMsg += ' Verrà rimosso anche dal percorso di oggi.';
      if (!window.confirm(confirmMsg)) return;
      state.deliveryClients = state.deliveryClients.filter(function (x) { return x.id !== savedId; });
      saveDeliveryClients(state.deliveryClients);
      if (inTodayRun.length) {
        state.deliveryRun.clients = state.deliveryRun.clients.filter(function (rc) { return rc.clientId !== savedId; });
        saveDeliveryRun(state.deliveryRun);
        if (currentScreen === 'navigatore') renderDeliveryPlanner();
      }
      dpCloseModal('modal-dp-archive-edit');
      dpRenderArchiveList(document.getElementById('dp-archive-search-input') ? document.getElementById('dp-archive-search-input').value : '');
    };
    document.getElementById('dp-archive-edit-save-btn').onclick = function () {
      var nome = document.getElementById('dp-archive-edit-nome').value.trim();
      var indirizzo = document.getElementById('dp-archive-edit-indirizzo').value.trim();
      var resultEl = document.getElementById('dp-archive-edit-result');
      if (!nome || !indirizzo) {
        resultEl.innerHTML = '<div style="color:var(--danger);font-size:13px;">Inserisci nome e indirizzo.</div>';
        return;
      }
      var addressChanged = indirizzo !== c.indirizzo;
      c.nome = nome;
      c.indirizzo = indirizzo;
      c.scadenza = document.getElementById('dp-archive-edit-scadenza').value || '';
      c.nonPrimaDi = document.getElementById('dp-archive-edit-nonprima').value || '';
      if (addressChanged) { c.lat = null; c.lon = null; } // stale coordinates from the OLD address would silently mislead Reordina's ordering later — cleared until re-geocoded (or set directly below, if the new text is itself coordinates)
      saveDeliveryClients(state.deliveryClients);
      // Requested directly: a client that's ALREADY in today's run
      // gets its scadenza kept in sync with this edit too — otherwise
      // changing it here would silently do nothing for a client
      // already added, until removed and re-added.
      state.deliveryRun.clients.forEach(function (rc) {
        if (rc.clientId === c.id) { rc.scadenza = c.scadenza; rc.nonPrimaDi = c.nonPrimaDi; }
      });
      saveDeliveryRun(state.deliveryRun);
      dpCloseModal('modal-dp-archive-edit');
      dpRenderArchiveList(document.getElementById('dp-archive-search-input') ? document.getElementById('dp-archive-search-input').value : '');
      if (currentScreen === 'navigatore') renderDeliveryPlanner();
      if (addressChanged) dpBackgroundGeocodeForOrdering(c.id, indirizzo); // re-geocodes silently in the background — or, if the text is itself a coordinate pair, uses it directly with no network call at all; see dpParseCoordinatesFromText
    };
    document.getElementById('modal-dp-archive-edit').classList.add('open');
  }

  // Downloads every saved client as one JSON file — meant to be handed
  // to a colleague (Bluetooth/email/USB/whatever), who then uses
  // Importa below to load them straight into their own app. Deliberately
  // scoped to ONLY the client list (not the full app backup), so
  // sharing a client base doesn't also hand over the other driver's
  // own foglio/fuel/profile data by mistake.
  function dpExportClientsArchive() {
    var payload = {
      exportedAt: new Date().toISOString(),
      appVersion: APP_VERSION,
      clients: state.deliveryClients
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'ADB-Smart-clienti-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast('Elenco clienti esportato');
  }

  // Imports a client-list file (from dpExportClientsArchive, on this
  // or another driver's phone) and MERGES it into the current saved
  // clients — never replaces/wipes the existing list outright, since
  // a colleague loading a shared base almost certainly wants to ADD
  // to whatever they already have, not risk losing their own clients.
  // Duplicates (matched by name+address, since imported entries won't
  // share the same random ids as anything already saved here) are
  // skipped silently rather than creating repeats.
  function dpImportClientsArchive(file) {
    var reader = new FileReader();
    reader.onload = function (e) {
      var data;
      try { data = JSON.parse(e.target.result); } catch (err) { toast('File non valido'); return; }
      if (!data || !Array.isArray(data.clients)) { toast('File non riconosciuto — deve essere un export di clienti ADB Smart'); return; }

      // Requested directly: importing should recognize a client that
      // ALREADY exists and update it with whatever's in the imported
      // file (address, coordinates) — not skip it untouched, and
      // definitely not create a duplicate. Matched by NOME alone (not
      // nome+indirizzo as before) — an address correction is exactly
      // the kind of update this needs to actually apply, and matching
      // on the OLD address too would make a corrected address always
      // look like a "different" client instead of an update to the
      // same one. Anyone already in the archive but NOT present in
      // the imported file is left completely untouched — this is a
      // merge/update, never a replace/sync.
      var byName = {};
      state.deliveryClients.forEach(function (c) {
        byName[(c.nome || '').trim().toLowerCase()] = c;
      });

      // Requested directly: ION was explicit that an exported/imported
      // client must come through EXACTLY as saved, including its own
      // schedule (scadenza/nonPrimaDi) — since a colleague loading a
      // shared client list, or restoring after moving to a new phone,
      // expects the full client, not just name/address/coordinates.
      var added = 0, updated = 0;
      data.clients.forEach(function (c) {
        if (!c || !c.nome) return;
        var key = (c.nome || '').trim().toLowerCase();
        var existing = byName[key];
        if (existing) {
          var changed = existing.indirizzo !== (c.indirizzo || '') || existing.lat !== (c.lat != null ? c.lat : null) || existing.lon !== (c.lon != null ? c.lon : null)
            || existing.scadenza !== (c.scadenza || '') || existing.nonPrimaDi !== (c.nonPrimaDi || '');
          if (changed) {
            existing.indirizzo = c.indirizzo || '';
            existing.lat = c.lat != null ? c.lat : null;
            existing.lon = c.lon != null ? c.lon : null;
            existing.scadenza = c.scadenza || '';
            existing.nonPrimaDi = c.nonPrimaDi || '';
            updated++;
          }
          return;
        }
        var fresh = {
          id: 'imp' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
          nome: c.nome,
          indirizzo: c.indirizzo || '',
          lat: c.lat != null ? c.lat : null,
          lon: c.lon != null ? c.lon : null,
          scadenza: c.scadenza || '',
          nonPrimaDi: c.nonPrimaDi || ''
        };
        state.deliveryClients.push(fresh);
        byName[key] = fresh; // guards against two entries with the same nome inside the SAME imported file colliding with each other
        added++;
      });

      saveDeliveryClients(state.deliveryClients);
      dpRenderArchiveList();
      var parts = [];
      if (added > 0) parts.push(added + ' aggiunt' + (added === 1 ? 'o' : 'i'));
      if (updated > 0) parts.push(updated + ' aggiornat' + (updated === 1 ? 'o' : 'i'));
      toast(parts.length ? parts.join(', ') + ' ✓' : 'Nessuna modifica (già tutto aggiornato)');
    };
    reader.readAsText(file);
  }

  function dpAddSavedClientToRun(savedClientId) {
    var saved = state.deliveryClients.find(function (c) { return c.id === savedClientId; });
    if (!saved) return;
    dpCloseModal('modal-dp-add-client');
    if (dpClientAlreadyInTodayRun(savedClientId)) {
      toast(saved.nome + ' è già nel percorso di oggi', 2200);
      return;
    }
    state.deliveryRun.clients.push({
      id: uid(), clientId: saved.id, nome: saved.nome, indirizzo: saved.indirizzo,
      lat: saved.lat, lon: saved.lon, status: 'pending', scadenza: saved.scadenza || '', nonPrimaDi: saved.nonPrimaDi || ''
    });
    saveDeliveryRun(state.deliveryRun);
    renderDeliveryPlanner();
  }

  function dpOpenNewClientModal(prefillName) {
    dpCloseModal('modal-dp-add-client');
    document.getElementById('dp-new-nome').value = prefillName || '';
    document.getElementById('dp-new-indirizzo').value = '';
    document.getElementById('dp-new-scadenza').value = '';
    document.getElementById('dp-new-nonprima').value = '';
    document.getElementById('dp-new-scadenza-wrap').style.display = '';
    document.getElementById('dp-new-save-result').innerHTML = '';
    document.getElementById('dp-new-close-x').onclick = function () { dpCloseModal('modal-dp-new-client'); };
    document.getElementById('dp-new-save-btn').onclick = dpSaveNewClientTrusted;
    dpWireTimeDefault(document.getElementById('dp-new-scadenza'), '06:50');
    dpWireTimeDefault(document.getElementById('dp-new-nonprima'), '07:50');
    // Reuses the same clear-button helper already built for the
    // Casa/Lavoro fields — one tap empties the field completely,
    // per ION's explicit request, rather than holding backspace.
    wireNavClearButton(document.getElementById('dp-new-nome'), document.getElementById('dp-new-nome-clear'), function () {});
    wireNavClearButton(document.getElementById('dp-new-indirizzo'), document.getElementById('dp-new-indirizzo-clear'), function () {});
    document.getElementById('modal-dp-new-client').classList.add('open');
  }

  var dpPendingNewClient = null;

  // REDESIGNED, per ION's own explicit clarification: he copies the
  // exact address TEXT from the Google Maps app (e.g. "Via Fratta, 16,
  // 35010 Borgoricco PD") — not a link, not coordinates. Trying to
  // parse a URL or lat/lon out of that (the previous version of this)
  // was solving the wrong problem entirely; a plain address string
  // never matched any of those patterns, so it just failed.
  //
  // The address is now trusted AS TYPED, stored exactly as given, and
  // handed to Google Maps as PLAIN TEXT at open time — Google does its
  // own geocoding of that text when the link actually opens, using
  // its own (reliable) data, instead of ADB Smart attempting it ahead
  // of time with a worse data source. This is also why a short
  // maps.app.goo.gl link never needs special handling anymore: it's
  // simply not what gets pasted here in this design — if one WAS
  // pasted anyway (typed as the "address"), it would just be treated
  // as literal text and very likely fail to resolve when Google Maps
  // tries to use it as a destination — worth a plain, honest note
  // rather than silently accepting it.
  function dpSaveNewClientTrusted() {
    var nome = document.getElementById('dp-new-nome').value.trim();
    var indirizzo = document.getElementById('dp-new-indirizzo').value.trim();
    var resultEl = document.getElementById('dp-new-save-result');
    if (!nome || !indirizzo) {
      resultEl.innerHTML = '<div style="color:var(--danger);font-size:13px;">Inserisci nome e indirizzo.</div>';
      return;
    }
    // Accepts BOTH a plain address ("Via Fratta, 16, 35010 Borgoricco
    // PD") AND a maps.app.goo.gl share link in this same field — per
    // ION's explicit request. Both are trusted as-typed and passed
    // through UNCHANGED to Google Maps at open time; whether it's
    // text or a link, ADB Smart never tries to interpret it itself.
    // For a short link specifically: reading where it redirects to is
    // blocked client-side by CORS (a real browser restriction, not
    // something to work around here) — but that limitation only
    // applies to OUR OWN JavaScript trying to read it. Handing the
    // exact same link straight to Google Maps' own systems is a
    // different thing entirely — Google resolving its own share link
    // has no such restriction. UNVERIFIED by me whether Google Maps'
    // destination/waypoints parameters correctly resolve a nested
    // share link this way — worth testing directly rather than
    // rejecting it outright as the previous version of this did.
    var saved = {
      id: uid(), nome: nome, indirizzo: indirizzo, lat: null, lon: null, createdAt: Date.now(),
      scadenza: document.getElementById('dp-new-scadenza').value || '',
      nonPrimaDi: document.getElementById('dp-new-nonprima').value || ''
    };
    state.deliveryClients.push(saved);
    saveDeliveryClients(state.deliveryClients);
    state.deliveryRun.clients.push({
      id: uid(), clientId: saved.id, nome: nome, indirizzo: indirizzo, lat: null, lon: null, status: 'pending', scadenza: saved.scadenza, nonPrimaDi: saved.nonPrimaDi
    });
    saveDeliveryRun(state.deliveryRun);
    dpCloseModal('modal-dp-new-client');
    renderDeliveryPlanner();
    // Silent, best-effort background geocode — NOT for the address
    // shown or used for Google Maps (that stays exactly what was
    // typed, always), only to get approximate coordinates for
    // Reordina's own sequencing later. An approximate position is
    // good enough to decide a sensible VISITING ORDER; it doesn't
    // need to be exact the way the actual navigation destination
    // does. Never shown to the driver, never blocks saving, no error
    // message if it fails — this entire step is invisible.
    dpBackgroundGeocodeForOrdering(saved.id, indirizzo);
  }

  // Fills in lat/lon on a saved client purely for Reordina's distance
  // calculations — completely separate from, and never overriding,
  // the trusted address text itself.
  // Recognizes when the "address" text a driver typed is actually
  // coordinates, not a street address — requested directly, in these
  // exact words: "era deja bara unde scrii adresa, puteai sa scrii
  // sau adresa sau coordinatele, exact in aceeasi bara, nu am nevoie
  // 30 de bare". No separate fields anywhere — the SAME address bar
  // already used everywhere (new client, edit, Google Maps hand-off)
  // just also recognizes coordinates when that's what's actually
  // typed there, and uses them directly with no geocoding call at
  // all needed. Handles both plain decimal ("45.6041275,
  // 11.9425809") and the DMS format Google Maps itself shows when you
  // copy a pin's coordinates (45°42'45.1"N 12°12'57.1"E) — ION has
  // used both forms already in this same conversation.
  function dpParseCoordinatesFromText(text) {
    if (!text) return null;
    // REAL BUG, reported directly and confirmed: coordinates copied
    // straight from Google Maps often come wrapped in parentheses —
    // "(45.6145663, 12.3834851)" — which the regexes below, anchored
    // to match the ENTIRE trimmed string exactly (^...$), rejected
    // outright, even though the actual numbers inside were perfectly
    // valid. ION found that manually deleting the parentheses (and,
    // he thought, the space after the comma — that part was already
    // handled by [,\s]+ below) made it work. Stripped here, once,
    // before either pattern is tried, rather than complicating both
    // regexes with optional-parenthesis handling twice over.
    var t = text.trim().replace(/^\(|\)$/g, '').trim();
    // Requested directly, following ION's own explicit preference:
    // since he plans to rely on pasting raw coordinates specifically
    // (rather than fighting address-geocoding gaps one street at a
    // time), this must work with every realistic way Google Maps
    // itself actually hands out coordinates, not just the format
    // already fixed above:
    //   "45.6145663, 12.3834851"   (the share-sheet / long-press card)
    //   "(45.6145663, 12.3834851)" (already handled above)
    //   "@45.6145663,12.3834851,15z" (copied straight from the
    //     browser's own address bar, which prefixes an "@" and always
    //     appends a trailing zoom level like ",15z" or ",17.5z")
    // Rather than three near-duplicate regexes, one leading "@" is
    // stripped if present, then the decimal match itself no longer
    // anchors to the END of the string ($) — just requires the two
    // numbers to be immediately followed by either nothing, or a
    // comma/semicolon and then anything else (the zoom level,
    // ignored). Still anchored at the START (^) so this can't
    // accidentally match two random numbers buried in the middle of
    // an actual street address — a real address is never going to
    // start with a bare decimal number followed immediately by a
    // comma-separated second decimal.
    var t2 = t.replace(/^@/, '');
    var decimalMatch = t2.match(/^(-?\d{1,3}(?:\.\d+)?)[,\s]+(-?\d{1,3}(?:\.\d+)?)(?:\s*[,;].*)?$/);
    if (decimalMatch) {
      var lat = parseFloat(decimalMatch[1]);
      var lon = parseFloat(decimalMatch[2]);
      if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat: lat, lon: lon };
    }
    var dmsMatch = t.match(/(\d+)\s*°\s*(\d+)\s*['′]\s*([\d.]+)\s*["″]\s*([NS])[,\s]+(\d+)\s*°\s*(\d+)\s*['′]\s*([\d.]+)\s*["″]\s*([EW])/i);
    if (dmsMatch) {
      var latVal = parseInt(dmsMatch[1], 10) + parseInt(dmsMatch[2], 10) / 60 + parseFloat(dmsMatch[3]) / 3600;
      if (dmsMatch[4].toUpperCase() === 'S') latVal = -latVal;
      var lonVal = parseInt(dmsMatch[5], 10) + parseInt(dmsMatch[6], 10) / 60 + parseFloat(dmsMatch[7]) / 3600;
      if (dmsMatch[8].toUpperCase() === 'W') lonVal = -lonVal;
      return { lat: latVal, lon: lonVal };
    }
    return null;
  }

  function dpBackgroundGeocodeForOrdering(savedClientId, indirizzo) {
    // REAL BUG, found through the same deliberate stress test: once
    // this background geocode actually succeeds (either instantly,
    // for pasted coordinates, or after the real network round trip
    // below), the client gets real lat/lon — but nothing here ever
    // told the screen, or AUTO, that anything had changed. A newly
    // added client sat as "unverified" (pushed to the very end,
    // unplaced) forever, even minutes after it genuinely had valid
    // coordinates, until the driver happened to open Riordina again
    // by hand. Re-rendering here (only if this screen is actually the
    // one showing) both refreshes the visible position note AND, via
    // the AUTO check built into every render, lets AUTO immediately
    // re-optimize the client into its real geographic place the
    // moment coordinates genuinely become available — exactly what
    // ION asked for directly ("cand se adauga un nou client, in
    // automat se pune la locul care el trebuie sa fie in lista").
    var directCoords = dpParseCoordinatesFromText(indirizzo);
    if (directCoords) {
      var savedDirect = state.deliveryClients.find(function (c) { return c.id === savedClientId; });
      if (savedDirect) { savedDirect.lat = directCoords.lat; savedDirect.lon = directCoords.lon; saveDeliveryClients(state.deliveryClients); }
      state.deliveryRun.clients.forEach(function (c) {
        if (c.clientId === savedClientId && c.lat == null) { c.lat = directCoords.lat; c.lon = directCoords.lon; }
      });
      saveDeliveryRun(state.deliveryRun);
      if (currentScreen === 'navigatore') renderDeliveryPlanner();
      return;
    }
    geocodeAddress(indirizzo).then(function (result) {
      if (!result) return;
      var saved = state.deliveryClients.find(function (c) { return c.id === savedClientId; });
      if (saved) { saved.lat = result.lat; saved.lon = result.lon; saveDeliveryClients(state.deliveryClients); }
      state.deliveryRun.clients.forEach(function (c) {
        if (c.clientId === savedClientId && c.lat == null) { c.lat = result.lat; c.lon = result.lon; }
      });
      saveDeliveryRun(state.deliveryRun);
      if (currentScreen === 'navigatore') renderDeliveryPlanner();
    }).catch(function () { /* silent, best-effort only — Reordina simply treats this one as non-geolocatable if it fails, see dpConfirmReordina */ });
  }

  function dpOpenEditClientModal(clientId) {
    var client = state.deliveryRun.clients.find(function (c) { return c.id === clientId; });
    if (!client) return;
    document.getElementById('dp-edit-nome').value = client.nome;
    document.getElementById('dp-edit-indirizzo').value = client.indirizzo || '';
    document.getElementById('dp-edit-scadenza').value = client.scadenza || '';
    document.getElementById('dp-edit-nonprima').value = client.nonPrimaDi || '';
    document.getElementById('dp-edit-save-result').innerHTML = '';
    document.getElementById('dp-edit-close-x').onclick = function () { dpCloseModal('modal-dp-edit-client'); };
    document.getElementById('dp-edit-remove-btn').onclick = function () { dpConfirmRemoveClient(clientId); };
    document.getElementById('dp-edit-save-btn').onclick = function () { dpSaveEditedClientTrusted(clientId); };
    wireNavClearButton(document.getElementById('dp-edit-nome'), document.getElementById('dp-edit-nome-clear'), function () {});
    wireNavClearButton(document.getElementById('dp-edit-indirizzo'), document.getElementById('dp-edit-indirizzo-clear'), function () {});
    dpWireTimeDefault(document.getElementById('dp-edit-scadenza'), '06:50');
    dpWireTimeDefault(document.getElementById('dp-edit-nonprima'), '07:50');
    document.getElementById('modal-dp-edit-client').classList.add('open');
  }

  // Same trust-the-text-as-typed principle as dpSaveNewClientTrusted —
  // this is specifically the flow ION was actually using to fix wrong
  // addresses, so getting this one right matters most.
  function dpSaveEditedClientTrusted(clientId) {
    var client = state.deliveryRun.clients.find(function (c) { return c.id === clientId; });
    if (!client) return;
    var nome = document.getElementById('dp-edit-nome').value.trim();
    var indirizzo = document.getElementById('dp-edit-indirizzo').value.trim();
    var resultEl = document.getElementById('dp-edit-save-result');
    if (!nome || !indirizzo) {
      resultEl.innerHTML = '<div style="color:var(--danger);font-size:13px;">Inserisci nome e indirizzo.</div>';
      return;
    }
    // Same as dpSaveNewClientTrusted — plain address text AND a
    // maps.app.goo.gl link are both accepted here, unchanged, passed
    // straight to Google Maps at open time.
    var addressChanged = indirizzo !== client.indirizzo;
    client.nome = nome;
    client.indirizzo = indirizzo;
    client.scadenza = document.getElementById('dp-edit-scadenza').value || '';
    client.nonPrimaDi = document.getElementById('dp-edit-nonprima').value || '';
    if (addressChanged) { client.lat = null; client.lon = null; client.orsUnreachable = false; } // stale coordinates from the OLD address would silently mislead Reordina's ordering — cleared until the new address is (silently) re-geocoded below; orsUnreachable cleared too since that verdict was about the OLD address's position, not this new one
    if (client.clientId) {
      var saved = state.deliveryClients.find(function (s) { return s.id === client.clientId; });
      if (saved) {
        saved.nome = nome; saved.indirizzo = indirizzo; saved.scadenza = client.scadenza; saved.nonPrimaDi = client.nonPrimaDi;
        if (addressChanged) { saved.lat = null; saved.lon = null; }
        saveDeliveryClients(state.deliveryClients);
      }
    }
    saveDeliveryRun(state.deliveryRun);
    dpCloseModal('modal-dp-edit-client');
    renderDeliveryPlanner();
    if (addressChanged && client.clientId) dpBackgroundGeocodeForOrdering(client.clientId, indirizzo);
  }

  function dpConfirmRemoveClient(clientId) {
    var client = state.deliveryRun.clients.find(function (c) { return c.id === clientId; });
    if (!client) return;
    if (!window.confirm('Rimuovere "' + client.nome + '" dalla lista di oggi?')) return; // a real, native confirm — matches ION's own explicit "must be hard to break the list by accident" requirement
    state.deliveryRun.clients = state.deliveryRun.clients.filter(function (c) { return c.id !== clientId; });
    saveDeliveryRun(state.deliveryRun);
    dpCloseModal('modal-dp-edit-client');
    renderDeliveryPlanner();
  }

  // ---- Auto-riordina: on/off state + the automatic re-optimization itself ----

  var DP_AUTO_RIORDINA_KEY = 'pt_dp_auto_riordina_v1';

  function dpAutoRiordinaEnabled() {
    return localStorage.getItem(DP_AUTO_RIORDINA_KEY) === '1';
  }

  function dpSetAutoRiordinaEnabled(on) {
    localStorage.setItem(DP_AUTO_RIORDINA_KEY, on ? '1' : '0');
  }

  // Same ORS-optimization logic as dpConfirmReordina below (geolocatable
  // vs. unverified split, GPS/navSearchFocusPoint fallback, ORS's own
  // silently-dropped-job handling), just without the confirmation modal
  // and without touching completion status — auto mode only ever
  // reorders, it never marks anything done. Silent on failure by
  // design, same reasoning as manual Reordina's permission-denied case:
  // this runs unattended in the background, so a toast on every offline
  // moment or GPS hiccup would just be noise; it leaves the current
  // order untouched instead.
  // FLIP-style reorder animation (capture old positions, apply the
  // change, animate from old to new) — requested directly: pressing
  // AUTO changed the list instantly with no visible motion, felt like
  // nothing happened even though it had. Now every row that actually
  // moves visibly slides — smoothly, not a jump — from where it WAS
  // to where it ends up: one lower in the list slides up past ones
  // that moved down, exactly like the manual drag-reorder already
  // looks, so the reordering itself is seen, not just its end result.
  function dpAnimateListReorder(applyFn) {
    var oldWraps = Array.prototype.slice.call(document.querySelectorAll('.dp-swipe-wrap[data-client-id]'));
    var oldTops = {};
    oldWraps.forEach(function (el) { oldTops[el.getAttribute('data-client-id')] = el.getBoundingClientRect().top; });

    applyFn(); // mutates state + re-renders — the DOM below is the NEW order

    var newWraps = Array.prototype.slice.call(document.querySelectorAll('.dp-swipe-wrap[data-client-id]'));
    newWraps.forEach(function (el) {
      var id = el.getAttribute('data-client-id');
      var oldTop = oldTops[id];
      if (oldTop == null) return; // a newly-added row — nothing to animate FROM, just appears
      var deltaY = oldTop - el.getBoundingClientRect().top;
      if (Math.abs(deltaY) < 1) return; // didn't actually move — skip, no pointless animation
      el.style.transition = 'none';
      el.style.transform = 'translateY(' + deltaY + 'px)';
      void el.offsetHeight; // forces a reflow so the browser registers the offset starting point BEFORE the transition below kicks in — without this it would just jump straight to the end position with no visible motion at all
      el.style.transition = 'transform .35s ease';
      el.style.transform = '';
      setTimeout(function () { el.style.transition = ''; }, 380); // cleans up the inline transition afterward so it doesn't linger and accidentally ease later, unrelated transform changes (e.g. manual dragging this same row)
    });
  }

  function dpRunAutoOptimization() {
    var completed = state.deliveryRun.clients.filter(function (c) { return c.status === 'completed'; });
    var remaining = state.deliveryRun.clients.filter(function (c) { return c.status !== 'completed'; });
    if (remaining.length < 2) { dpAutoOptimizationInFlight = false; clearTimeout(dpAutoOptimizationSafetyTimer); return; }

    var geolocatable = remaining.filter(function (c) { return c.lat != null && c.lon != null; });
    var unverified = remaining.filter(function (c) { return c.lat == null || c.lon == null; });

    // Visual feedback while it works — raised directly: pressing the
    // toggle (or it triggering after a list change) gave no sign
    // anything was actually happening, calculating, or done. The
    // toggle itself pulses while a calculation is in flight (a real
    // ORS network call, not instant), and a brief toast confirms once
    // the new order is actually applied — same toast() mechanism
    // already used elsewhere in this screen (e.g. manual Reordina's
    // own failure message), so it matches the app's existing pattern.
    var toggleEl = document.getElementById('dp-auto-riordina-toggle');
    if (toggleEl) toggleEl.classList.add('calculating');

    var optimizePromise = geolocatable.length
      // REAL BUG, reported directly: on Android specifically,
      // Reordina/AUTO could take several real seconds to respond,
      // while the exact same action was instant on iPhone. Root
      // cause: currentPositionSafe() with no arguments here defaults
      // to enableHighAccuracy:true and a 5-second maximumAge — a
      // fresh, full-precision GPS hardware fix, on every single
      // press. Android's real-world high-accuracy GPS acquisition is
      // well documented to often take meaningfully longer than
      // iOS's in practice (weaker signal, OEM power-saving
      // throttling, a "cold" GPS chip). This starting point only
      // needs to be roughly right for route optimization to still
      // pick a sensible order — being off by even 100m essentially
      // never changes which stop is genuinely nearest — so a much
      // cheaper, faster fix (network/WiFi-based, a full minute of
      // caching) is the right tradeoff here specifically, even
      // though other real uses of GPS elsewhere in this app (e.g.
      // live turn-by-turn) still correctly want full precision.
      ? (dpGeoRecentlyDenied() ? Promise.reject(new Error('User denied Geolocation')) : currentPositionSafe(12000, { enableHighAccuracy: false, maximumAge: 60000 }))
          .then(function (pos) { return dpCallOrsOptimizationWithDeadlines(pos, geolocatable); })
          .catch(function (err) {
            // REAL BUG, reported directly: "nu poate merge un sofer cu
            // adresa din alt loc, pornirea lui trebuie mereu sa fie
            // din pozitia sa" — the route's starting point must ALWAYS
            // be the driver's real position at that exact moment,
            // never a remembered one. This used to fall back to
            // navSearchFocusPoint (a position read at some earlier
            // point, possibly hours old by now, possibly from
            // somewhere completely different) the moment a fresh GPS
            // read failed — silently computing a route from a place
            // the driver may not even be near anymore. Now a failed
            // live GPS read just fails the optimization outright (see
            // the .catch below) — no stand-in position is ever
            // substituted for "where I actually am right now".
            if (err && err.code === 1) dpGeoDeniedAt = Date.now(); // 1 === GeolocationPositionError.PERMISSION_DENIED
            throw err;
          })
      : Promise.resolve([]);

    optimizePromise.then(function (optimized) {
      // REAL BUG, reported directly: turning the toggle OFF while a
      // calculation was already in flight from being ON a moment ago
      // (a real network call, takes a few seconds) still applied the
      // result unconditionally once it finished — as if it had stayed
      // on the whole time. Re-checks the CURRENT state right before
      // applying anything: if the driver switched it off in the
      // meantime, the now-stale result is simply discarded, and the
      // list is left exactly as it is — matching what "off" actually
      // means, regardless of what was already running when it was
      // switched.
      if (!dpAutoRiordinaEnabled()) {
        if (toggleEl) toggleEl.classList.remove('calculating');
        dpAutoOptimizationInFlight = false;
        clearTimeout(dpAutoOptimizationSafetyTimer);
        return;
      }
      var optimizedIds = {};
      optimized.forEach(function (c) { optimizedIds[c.id] = true; });
      var droppedByOrs = geolocatable.filter(function (c) { return !optimizedIds[c.id]; });
      // Requested directly: ION found ERREM IMPIANTI SRL "never moved"
      // during auto-riordina — no error, valid coordinates, no
      // "non verificato" warning either, just silently stuck in the
      // same spot no matter what changed elsewhere. This is exactly
      // ORS/VROOM's own silent job-dropping behavior, already handled
      // functionally (droppedByOrs gets appended, never lost) — but
      // with NOTHING visible telling the driver this specific client
      // is why. Marked here now, distinctly from "non verificato" (a
      // geocoding problem) since this is a DIFFERENT, real issue —
      // valid coordinates that VROOM's own road-network routing
      // considers unreachable from the rest of the route. Cleared for
      // anything that succeeds this time, in case a later attempt
      // (different start position, different set of stops) manages to
      // include it after all.
      optimized.forEach(function (c) { c.orsUnreachable = false; });
      droppedByOrs.forEach(function (c) { c.orsUnreachable = true; });
      // REAL BUG, reported directly and confirmed via ION's own exact
      // reproduction steps: "completed" above was captured ONCE, as a
      // snapshot, before the network call even started — a real round
      // trip (now sometimes two, with the added retry) that can
      // easily take several real seconds. Marking MORE clients done
      // WHILE that old snapshot was still mid-flight meant those
      // brand-new completions existed only in the live state, not in
      // this closure's stale "completed" — so the instant this old
      // result finally landed and overwrote state.deliveryRun.clients
      // wholesale, it silently REVERTED those newer completions right
      // back to pending, exactly matching "mark a few done, mark a
      // few more, redo the route — the problem shows itself". Fixed
      // by re-reading what's ACTUALLY completed right now, instead of
      // trusting the old snapshot — and dropping anything this old
      // result thought was still "remaining" but has since actually
      // been completed for real, so a newly-finished client is never
      // silently un-finished by a stale result landing late.
      var completedNowIds = {};
      state.deliveryRun.clients.forEach(function (c) { if (c.status === 'completed') completedNowIds[c.id] = true; });
      var completedNow = state.deliveryRun.clients.filter(function (c) { return c.status === 'completed'; });
      // REAL BUG, reported directly ("mi-a eliminat dei clienti dal
      // percorso di oggi"): the exact same stale-snapshot issue as
      // "completed" above, just for the opposite direction — a client
      // added WHILE this optimization's own network round trip was
      // still in flight (a real request, can genuinely take a few
      // seconds) exists only in the live state, never in
      // optimized/unverified/droppedByOrs (all captured from the OLD
      // list, before this request even started) — so it was silently
      // erased the instant this stale result overwrote
      // state.deliveryRun.clients wholesale. Found here the same way
      // completed-since is found above: anything in the CURRENT list
      // that isn't completed and wasn't part of what this result
      // already accounts for is a genuinely new addition, appended
      // rather than lost.
      var knownIds = {};
      optimized.concat(unverified).concat(droppedByOrs).forEach(function (c) { knownIds[c.id] = true; });
      var addedDuringRun = state.deliveryRun.clients.filter(function (c) { return c.status !== 'completed' && !knownIds[c.id]; });
      var finalOrder = optimized.concat(unverified).concat(droppedByOrs).concat(addedDuringRun)
        .filter(function (c) { return !completedNowIds[c.id]; })
        .concat(dpSortByCompletionOrder(completedNow));
      dpAnimateListReorder(function () {
        state.deliveryRun.clients = finalOrder;
        saveDeliveryRun(state.deliveryRun);
        renderDeliveryPlanner(); // rebuilds the toggle fresh too, so the .calculating class from above is gone the instant this replaces it — no separate cleanup needed on the success path
      });
      dpLastAutoOptimizedSignature = finalOrder.filter(function (c) { return c.status !== 'completed'; }).map(function (c) { return c.id; }).join(',');
      dpAutoOptimizationInFlight = false;
      clearTimeout(dpAutoOptimizationSafetyTimer);
      toast('Percorso riordinato automaticamente ✓', 2500);
    }).catch(function (err) {
      // REAL BUG, reported repeatedly and confirmed: AUTO staying
      // fully silent on failure — by original design, to avoid
      // nagging about routine, expected cases like permission denied
      // or AUTO itself being off — made it genuinely impossible to
      // tell WHY it wasn't reordering, across several real attempts
      // to diagnose this. ION was explicit the app worked fine before
      // and broke after a specific change, ruling out environment
      // guesses — the only way to find the actual remaining cause is
      // to actually SEE what error is happening, instead of guessing
      // blind. Still stays quiet for the two genuinely routine,
      // expected cases (permission denied, AUTO deliberately off) —
      // any OTHER failure now shows the same toast manual Reordina
      // already uses, with the real error text in it.
      var isPermissionDenied = (err && err.code === 1) || dpGeoRecentlyDenied();
      var isAutoDeliberatelyOff = false; // AUTO's own optimizePromise never uses AUTO_OFF_SENTINEL — that's only dpConfirmReordina's manual path
      if (!isPermissionDenied && !isAutoDeliberatelyOff) {
        toast('Auto non riuscito (' + (err && err.message ? escapeHtml(err.message) : 'errore') + ')', 6000);
      }
      if (toggleEl) toggleEl.classList.remove('calculating');
      dpAutoOptimizationInFlight = false;
      clearTimeout(dpAutoOptimizationSafetyTimer);
    });
  }


  // ---- Reordina: conferma completati, poi ricalcola con ORS Optimization ----

  function dpOpenReordinaModal() {
    var listEl = document.getElementById('dp-reordina-list');
    var pinnedEl = document.getElementById('dp-reordina-pinned');
    var html = '';
    var pinnedHtml = '';
    // Requested directly: the very NEXT client to deliver (the first
    // still-pending one — run.clients already keeps completed ones
    // pushed to the end, so this is simply the first non-done entry
    // in order) gets its own distinct orange highlight AND stays
    // pinned, fixed, at the top — even once the rest of the list
    // below it scrolls out of view under "Ricalcola percorso". Real
    // problem it solves: scrolling past several already-checked rows
    // and then tapping the WRONG one right after them, purely from
    // visual momentum — an unmistakable, always-visible box on the
    // true next one removes that ambiguity entirely. Rendered ONCE,
    // only in the pinned slot — deliberately skipped in the scrolling
    // list below so there's never two checkboxes for the same client
    // that could fall out of sync with each other. The underlying
    // logic is untouched: checking any OTHER row still marks THAT
    // client done exactly as before, regardless of which one is
    // currently pinned.
    var nextFound = false;
    state.deliveryRun.clients.forEach(function (c) {
      var isDone = c.status === 'completed';
      var isNext = !isDone && !nextFound;
      if (isNext) nextFound = true;
      var rowHtml = '<label class="dp-reordina-row' + (isNext ? ' dp-reordina-next' : '') + '"><input type="checkbox" data-client-id="' + c.id + '"' + (isDone ? ' checked' : '') + '>' +
        '<span>' + escapeHtml(c.nome) + (isDone ? ' — FATTO' : (isNext ? ' — PROSSIMO' : '')) + '</span></label>';
      if (isNext) pinnedHtml = rowHtml; else html += rowHtml;
    });
    pinnedEl.innerHTML = pinnedHtml;
    listEl.innerHTML = html || '<div style="color:var(--ink-soft);">Nessun cliente in elenco.</div>';
    // Requested directly, as the other half of the fix above: reset
    // the real check-order tracker fresh each time this modal opens,
    // and wire a 'change' listener onto every checkbox (both the
    // pinned "next" one and the scrolling list) so the moment each is
    // actually toggled ON gets recorded — genuinely, individually —
    // rather than everything being stamped at once, later, when
    // "Ricalcola percorso" is pressed.
    dpReordinaCheckOrder = {};
    dpReordinaCheckCounter = 0;
    document.querySelectorAll('#modal-dp-reordina input[type=checkbox]').forEach(function (cb) {
      // Real Date.now(), not just an abstract counter — completedAt
      // still needs to be a genuine timestamp elsewhere (the "~18:45"
      // shown on a delivered client, and the ISO string sent to the
      // server) — the tiny counter fraction added on top only breaks
      // ties between two checks landing in the exact same
      // millisecond, invisible at the minute-level precision anything
      // else actually displays or sends.
      if (cb.checked) dpReordinaCheckOrder[cb.dataset.clientId] = Date.now() + (++dpReordinaCheckCounter / 1e6);
      cb.addEventListener('change', function () {
        if (cb.checked) dpReordinaCheckOrder[cb.dataset.clientId] = Date.now() + (++dpReordinaCheckCounter / 1e6);
      });
    });
    document.getElementById('dp-reordina-close-x').onclick = function () { dpCloseModal('modal-dp-reordina'); };
    document.getElementById('dp-reordina-confirm-btn').onclick = dpConfirmReordina;
    document.getElementById('dp-reordina-confirm-btn').disabled = false;
    document.getElementById('dp-reordina-confirm-btn').textContent = 'Ricalcola percorso';
    document.getElementById('modal-dp-reordina').classList.add('open');
  }

  // ---- Delivery photo camera ----
  // Requested directly, in detail: right after marking one or more
  // clients "consegnato" and confirming Reordina, the camera opens
  // automatically, one client at a time, with a live preview of that
  // delivery's info (name, address, time) held over the bottom half
  // of the frame — burned directly into the photo the moment it's
  // captured, so the info travels WITH the picture even after it
  // leaves this app. Never saved to the phone's own gallery — the
  // only way out is the OS share sheet (WhatsApp, etc.), same as
  // tapping the small camera icon on an already-completed client's
  // row at any later point, just for one client instead of a queue.

  var dpCameraQueue = [];
  var dpCameraStream = null;
  var dpCameraCurrentClient = null;
  var dpCameraTrack = null;
  var dpCameraZoomLevel = 1;
  var dpCameraZoomCaps = null; // {min,max,step} if the device's own hardware zoom is controllable; null falls back to a CSS-based digital zoom that works on any device
  var dpCameraFlashOn = false;

  function dpStartCameraSequence(clients) {
    dpCameraQueue = clients.slice();
    dpCameraAdvanceQueue();
  }

  function dpCameraAdvanceQueue() {
    if (!dpCameraQueue.length) { dpCloseCameraModal(); return; }
    var next = dpCameraQueue.shift();
    dpOpenCameraForClient(next);
  }

  // Also the entry point for the standalone camera-icon button on an
  // already-completed row — a queue of exactly one.
  function dpOpenCameraForOneClient(clientId) {
    var client = state.deliveryRun.clients.find(function (c) { return c.id === clientId; });
    if (!client) return;
    dpCameraQueue = [];
    dpOpenCameraForClient(client);
  }

  // Requested directly, part of ION's watermark idea: the app's own
  // logo (loading here, once, well before the actual photo capture,
  // since Image loading is asynchronous — the capture itself draws
  // synchronously and can't wait on a network request mid-shot).
  // REAL BUG, reported directly: icon-96.png (only 96x96 source
  // pixels) looked visibly blurry once drawn at watermark size on a
  // high-resolution photo — that's upscaling a small source image,
  // not downscaling a large one. icon-512.png is large enough to
  // stay sharp even scaled up somewhat, and only ever gets scaled
  // DOWN to the small watermark size, never up.
  var dpWatermarkLogoImg = null;
  function dpOpenCameraForClient(client) {
    dpCameraCurrentClient = client;
    if (!dpWatermarkLogoImg) {
      var logoImg = new Image();
      logoImg.onload = function () { dpWatermarkLogoImg = logoImg; };
      logoImg.src = 'icon-512.png';
    }
    document.getElementById('dp-camera-info-time').textContent = client.completedAt ? dpFormatTime(client.completedAt) : '';
    document.getElementById('dp-camera-info-name').textContent = client.nome || '';
    document.getElementById('dp-camera-info-addr').textContent = client.indirizzo || '';

    var video = document.getElementById('dp-camera-video');
    var errEl = document.getElementById('dp-camera-error');
    errEl.style.display = 'none';
    video.style.display = '';
    document.getElementById('dp-camera-preview-img').style.display = 'none';
    document.getElementById('dp-camera-capture-btn').style.display = '';
    document.getElementById('dp-camera-preview-actions').style.display = 'none';
    document.getElementById('dp-camera-info-overlay').style.display = '';

    document.getElementById('modal-dp-camera').classList.add('open');

    // Real device camera, back-facing by default (a driver photographing
    // what they're delivering/leaving needs the REAR camera, not a
    // selfie view) — HONEST UNCERTAINTY: getUserMedia requires a
    // secure context (https) and explicit permission; if either is
    // missing, or no camera exists at all, this rejects and the error
    // path below handles it instead of leaving a frozen black screen.
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      errEl.textContent = 'Fotocamera non disponibile su questo browser.';
      errEl.style.display = 'block';
      return;
    }
    // REAL BUG, reported directly and confirmed: the delivery photo
    // itself, watermark included, came out visibly poor quality —
    // root cause found here: no resolution was ever requested from
    // the camera at all, so the browser defaulted to a low one (often
    // well under what the phone's actual camera sensor can do),
    // regardless of how good the hardware itself is. "ideal" values
    // ask for the highest resolution available without ever failing
    // if the device can't reach it — a phone's back camera can
    // typically do 4K (3840x2160) or more today.
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false })
      .then(function (stream) {
        dpCameraStream = stream;
        video.srcObject = stream;
        dpSetupCameraControls(stream);
      })
      .catch(function () {
        errEl.textContent = 'Impossibile accedere alla fotocamera — controlla i permessi.';
        errEl.style.display = 'block';
      });
  }

  // Requested directly: zoom and flash for night deliveries. Both are
  // feature-detected against the REAL camera track's own capabilities
  // (getCapabilities()), never assumed — a device/browser that
  // doesn't support one just never shows that control, rather than
  // showing a dead button. Hardware zoom (sharper, when available) is
  // preferred; a CSS-transform digital zoom is the universal fallback
  // for devices that report no zoom capability at all. Flash/torch
  // has no software equivalent — if the device doesn't expose it,
  // there's genuinely nothing to fall back to, so the button simply
  // doesn't appear.
  function dpSetupCameraControls(stream) {
    var track = stream.getVideoTracks()[0];
    dpCameraTrack = track;
    dpCameraZoomLevel = 1;
    dpCameraFlashOn = false;
    document.getElementById('dp-camera-video').style.transform = 'scale(1)';
    document.getElementById('dp-camera-zoom-label').textContent = '1×';
    document.getElementById('dp-camera-flash-btn').classList.remove('dp-flash-on');

    var caps = (track.getCapabilities && track.getCapabilities()) || {};
    dpCameraZoomCaps = (caps.zoom && caps.zoom.max > caps.zoom.min) ? caps.zoom : null;
    document.getElementById('dp-camera-zoom-controls').style.display = 'flex'; // always offered — CSS zoom works everywhere even without hardware support
    document.getElementById('dp-camera-flash-btn').style.display = caps.torch ? 'flex' : 'none';
  }

  function dpCameraApplyZoom(delta) {
    if (!dpCameraTrack) return;
    var step = (dpCameraZoomCaps && dpCameraZoomCaps.step) ? dpCameraZoomCaps.step : 0.5;
    var max = dpCameraZoomCaps ? dpCameraZoomCaps.max : 4;
    var min = dpCameraZoomCaps ? dpCameraZoomCaps.min : 1;
    dpCameraZoomLevel = Math.max(min, Math.min(max, dpCameraZoomLevel + delta * step));
    document.getElementById('dp-camera-zoom-label').textContent = (Math.round(dpCameraZoomLevel * 10) / 10) + '×';
    if (dpCameraZoomCaps) {
      dpCameraTrack.applyConstraints({ advanced: [{ zoom: dpCameraZoomLevel }] }).catch(function () {});
    } else {
      document.getElementById('dp-camera-video').style.transform = 'scale(' + dpCameraZoomLevel + ')';
    }
  }

  function dpCameraToggleFlash() {
    if (!dpCameraTrack) return;
    var turnOn = !dpCameraFlashOn;
    dpCameraTrack.applyConstraints({ advanced: [{ torch: turnOn }] })
      .then(function () {
        dpCameraFlashOn = turnOn;
        document.getElementById('dp-camera-flash-btn').classList.toggle('dp-flash-on', dpCameraFlashOn);
      })
      .catch(function () { /* device claimed torch support but the actual toggle failed — silently stays off, no dead visual state */ });
  }

  function dpStopCameraStream() {
    if (dpCameraStream) {
      dpCameraStream.getTracks().forEach(function (t) { t.stop(); });
      dpCameraStream = null;
    }
    dpCameraTrack = null;
    dpCameraZoomCaps = null;
    dpCameraFlashOn = false;
  }

  function dpCloseCameraModal() {
    dpStopCameraStream();
    dpCameraQueue = [];
    dpCameraCurrentClient = null;
    dpCloseModal('modal-dp-camera');
  }

  // Captures the CURRENT video frame at its real, native resolution
  // (not the on-screen display size, which can differ) and draws the
  // same info card straight onto that same canvas, proportioned to
  // match — so what ends up in the final image matches the live
  // preview the driver just saw, just permanently part of the pixels
  // now rather than a separate CSS layer.
  function dpCaptureCameraPhoto() {
    var video = document.getElementById('dp-camera-video');
    var canvas = document.getElementById('dp-camera-canvas');
    var w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) return; // camera not actually ready yet — nothing to capture
    canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext('2d');
    // Hardware zoom (dpCameraZoomCaps set) already changes what the
    // SENSOR itself sends — the raw video frame is already zoomed,
    // drawn as-is. Digital zoom (no hardware capability) is a purely
    // visual CSS transform on the <video> element on screen — the
    // underlying frame data is always the FULL, unzoomed view, so the
    // capture has to crop to the same centered region the driver was
    // actually looking at and scale it back up, or the photo would
    // show much more than what was framed on screen.
    if (!dpCameraZoomCaps && dpCameraZoomLevel > 1) {
      var cropW = w / dpCameraZoomLevel, cropH = h / dpCameraZoomLevel;
      var cropX = (w - cropW) / 2, cropY = (h - cropH) / 2;
      ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, w, h);
    } else {
      ctx.drawImage(video, 0, 0, w, h);
    }

    // Matches .dp-camera-info-card's own CSS exactly (height:42%,
    // gradient stops at 15%/55%) — requested directly: less of the
    // frame taken up by green, and the color itself less transparent,
    // clearer near the top edge close to "Consegnato" rather than a
    // slow fade starting right from the card's own top edge.
    var cardTop = h * 0.58;
    var grad = ctx.createLinearGradient(0, cardTop, 0, h);
    grad.addColorStop(0, 'rgba(20,180,120,0)');
    grad.addColorStop(0.15, 'rgba(20,150,100,.96)');
    grad.addColorStop(0.55, 'rgba(15,120,80,.99)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, cardTop, w, h - cardTop);

    // Content anchored toward the BOTTOM of the frame (matches
    // justify-content:flex-end in the live CSS preview), not centered
    // in the middle of the green area — badge stays the topmost line,
    // address the bottom-most, working up from the photo's own bottom
    // edge.
    var client = dpCameraCurrentClient || {};
    var centerX = w / 2;
    // REAL BUG, reported directly and confirmed: on the actual
    // captured photo (not the live CSS preview, which already looked
    // fine and stayed untouched — see .dp-camera-info-card's own tight
    // gap:6px), these Y positions used to be spaced by large, fixed
    // fractions of the full image height (0.075, 0.065) — reasonable-
    // looking at the camera's old, much lower default resolution, but
    // once a previous fix forced 4K capture for sharper photos, that
    // SAME proportional spacing produced genuinely large gaps in
    // absolute pixels, since it was never actually tied to the size
    // of the text itself. Tightened here to track much closer to the
    // live preview's own compact look.
    //
    // REAL BUG, reported directly right after that fix, and
    // confirmed by ION actually sending a photo through WhatsApp:
    // once the text sat this tight against the true bottom edge,
    // WhatsApp's own preview cropping cut it off — only "Consegnato"
    // stayed visible; the time, name, and address were all sitting in
    // the zone WhatsApp actually trims for its own thumbnail/preview
    // rendering. Raised well clear of that zone here — same tight
    // internal spacing between the four lines as just fixed above,
    // just anchored higher up as a group, comfortably inside the
    // portion WhatsApp keeps intact.
    var bottomPad = h * 0.16;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff';

    var addrY = h - bottomPad;
    var nameY = addrY - h * 0.042;
    var timeY = nameY - h * 0.042;
    var badgeY = timeY - h * 0.042;

    ctx.font = '700 ' + Math.round(w * 0.045) + 'px sans-serif';
    ctx.fillText('✓ Consegnato', centerX, badgeY);

    var timeText = client.completedAt ? dpFormatTime(client.completedAt) : '';
    if (timeText) {
      ctx.font = '600 ' + Math.round(w * 0.038) + 'px sans-serif';
      ctx.fillText(timeText, centerX, timeY);
    }

    ctx.font = '800 ' + Math.round(w * 0.062) + 'px sans-serif';
    ctx.fillText(client.nome || '', centerX, nameY);

    ctx.font = '600 ' + Math.round(w * 0.042) + 'px sans-serif';
    ctx.fillText(client.indirizzo || '', centerX, addrY);

    // Requested directly, ION's own marketing idea: a small, tasteful
    // watermark on every delivery photo — since these get shared
    // straight to WhatsApp/clients, each one becomes a tiny bit of
    // free advertising for the app itself. Moved to the top-right
    // (ION's own follow-up: clearer up there, away from the green
    // card's own text) with a small translucent dark backing behind
    // it, so it stays readable regardless of what's actually in the
    // photo at that corner — a plain sky or light-colored background
    // would otherwise wash out white text with nothing behind it. The
    // app's own logo sits just to the left of the text, both drawn at
    // FULL opacity now (ION found the previous semi-transparent
    // version too soft) for a cleaner, sharper look, even though it
    // reads slightly smaller than the first attempt. "Smart" in the
    // brand accent orange, "ADB " in white, right up against it —
    // canvas fillText can't mix colors in one call, so it's drawn as
    // two adjoining pieces, right-aligned, with "Smart"'s own width
    // measured first to place "ADB " flush against its left edge.
    var wmPad = w * 0.035;
    var wmFontSize = Math.round(w * 0.023);
    ctx.font = '800 ' + wmFontSize + 'px sans-serif';
    ctx.textAlign = 'right';
    var smartWidth = ctx.measureText('Smart').width;
    var adbWidth = ctx.measureText('ADB ').width;
    var textWidth = smartWidth + adbWidth;
    var logoSize = wmFontSize * 1.6;
    var logoGap = wmFontSize * 0.35;
    var groupRight = w - wmPad;
    var groupTop = cardTop + wmPad + h * 0.063;
    var groupWidth = logoSize + logoGap + textWidth;
    var groupHeight = logoSize;

    // Backing plate, rounded corners, behind both the logo and text.
    var bgPad = wmFontSize * 0.3;
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = '#000';
    var bx = groupRight - groupWidth - bgPad, by = groupTop - bgPad, bw = groupWidth + bgPad * 2, bh = groupHeight + bgPad * 2, br = bh * 0.25;
    ctx.beginPath();
    ctx.moveTo(bx + br, by);
    ctx.arcTo(bx + bw, by, bx + bw, by + bh, br);
    ctx.arcTo(bx + bw, by + bh, bx, by + bh, br);
    ctx.arcTo(bx, by + bh, bx, by, br);
    ctx.arcTo(bx, by, bx + bw, by, br);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;

    if (dpWatermarkLogoImg) {
      var logoX = groupRight - textWidth - logoGap - logoSize;
      var logoR = logoSize * 0.22;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(logoX + logoR, groupTop);
      ctx.arcTo(logoX + logoSize, groupTop, logoX + logoSize, groupTop + logoSize, logoR);
      ctx.arcTo(logoX + logoSize, groupTop + logoSize, logoX, groupTop + logoSize, logoR);
      ctx.arcTo(logoX, groupTop + logoSize, logoX, groupTop, logoR);
      ctx.arcTo(logoX, groupTop, logoX + logoSize, groupTop, logoR);
      ctx.closePath();
      ctx.clip();
      // Requested directly: at this small size the logo's own photo
      // (already somewhat dark/moody by design) read as muted — a
      // punch of extra saturation and brightness, applied only here,
      // makes it pop clearly at watermark scale without touching the
      // source image file itself or its look anywhere else in the app.
      ctx.filter = 'saturate(1.6) brightness(1.2) contrast(1.1)';
      ctx.drawImage(dpWatermarkLogoImg, logoX, groupTop, logoSize, logoSize);
      ctx.filter = 'none';
      ctx.restore();
    }

    var wmY = groupTop + logoSize / 2 + wmFontSize * 0.35;
    // Requested directly: a brighter, more saturated orange than the
    // app's own brand accent (#E8542B) specifically for this
    // watermark — at this small size, the standard brand color read
    // as a little dull; a punchier tone pops more clearly.
    ctx.fillStyle = '#FF6A2E';
    ctx.fillText('Smart', groupRight, wmY);
    ctx.fillStyle = '#fff';
    ctx.fillText('ADB ', groupRight - smartWidth, wmY);
    ctx.textAlign = 'center'; // restored — other drawing code after this point may rely on the default

    dpStopCameraStream(); // frame is captured — no need to keep the live feed running while previewing
    // Requested directly: quality raised for a sharper final photo,
    // matching the higher camera resolution now requested above.
    var dataUrl = canvas.toDataURL('image/jpeg', 0.97);
    var img = document.getElementById('dp-camera-preview-img');
    img.src = dataUrl;
    // REAL BUG, reported directly and confirmed: setting style.display
    // to an empty string only clears the INLINE style — it does NOT
    // override the base CSS rule (#dp-camera-preview-img{display:none;...}),
    // which stays in effect regardless. The captured photo was really
    // there (confirmed separately, at the pixel level) but stayed
    // invisible the whole time, showing as a plain black screen with
    // just the two buttons floating over it. Needs an explicit
    // display value that actually overrides the hidden default.
    img.style.display = 'block';
    video.style.display = 'none';
    document.getElementById('dp-camera-info-overlay').style.display = 'none'; // already baked into the image now — the separate CSS overlay would just double it up
    document.getElementById('dp-camera-capture-btn').style.display = 'none';
    document.getElementById('dp-camera-preview-actions').style.display = 'flex';
  }

  function dpRetakeCameraPhoto() {
    if (dpCameraCurrentClient) dpOpenCameraForClient(dpCameraCurrentClient);
  }

  // Deliberately never touches the phone's own photo library — the
  // whole point, per ION's explicit request, is that this photo only
  // ever leaves through a real send action, not a silent save. Web
  // Share API (with an actual file attached) is exactly the standard,
  // OS-level way to hand an image to WhatsApp or anywhere else from a
  // web app — UNVERIFIED whether every browser/OS combination ADB
  // Smart runs on supports sharing FILES specifically (broad but not
  // universal support); the fallback opens the image in a new tab so
  // it's never a dead end even where it isn't supported.
  function dpSendCameraPhoto() {
    var canvas = document.getElementById('dp-camera-canvas');
    canvas.toBlob(function (blob) {
      if (!blob) return;
      var client = dpCameraCurrentClient || {};
      var fileName = 'consegna-' + (client.nome || 'cliente').replace(/[^a-z0-9]+/gi, '-') + '.jpg';
      var file = new File([blob], fileName, { type: 'image/jpeg' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: 'Consegna ' + (client.nome || '') })
          .then(function () { dpCameraAdvanceQueue(); })
          .catch(function () { /* share cancelled by the driver — stay on the preview, don't force-advance */ });
      } else {
        // Fallback for browsers without file-sharing support — opens
        // the photo in a new tab, where a long-press/share icon still
        // lets the driver hand it off manually.
        var url = URL.createObjectURL(blob);
        window.open(url, '_blank');
        dpCameraAdvanceQueue();
      }
    }, 'image/jpeg', 0.97);
  }

  function dpConfirmReordina() {
    // Scoped to the whole modal, not just #dp-reordina-list — the
    // currently-pinned "next" client's checkbox now lives in a
    // separate, fixed container (#dp-reordina-pinned) above the
    // scrolling list, so reading only the list would silently miss
    // it.
    var checkboxes = document.querySelectorAll('#modal-dp-reordina input[type=checkbox]');
    // Tracked so the camera sequence (below) knows exactly which
    // clients were JUST checked off in THIS confirmation — requested
    // directly: the camera should open automatically, one after
    // another, for however many were marked done together, not for
    // ones that were already completed before this action.
    var newlyCompleted = [];
    // Requested directly ("de ce nu arata consegnele de azi?"): also
    // track the opposite transition — a client un-checked back to
    // pending after having been marked completed. Its OLD completedAt
    // is captured here, before the line right below resets it to
    // null, so the matching server row (identified by that exact
    // timestamp) can be deleted — otherwise a mistaken tap that gets
    // corrected would leave a "ghost" delivery behind on the fleet's
    // own Consegne screen forever.
    var newlyUncompleted = [];
    checkboxes.forEach(function (cb) {
      var client = state.deliveryRun.clients.find(function (c) { return c.id === cb.getAttribute('data-client-id'); });
      if (!client) return;
      var wasCompleted = client.status === 'completed';
      if (wasCompleted && !cb.checked) newlyUncompleted.push({ nome: client.nome, completedAt: client.completedAt });
      client.status = cb.checked ? 'completed' : 'pending';
      // Approximate delivery time — ION's own explicit request, for
      // the history detail view. Genuinely approximate, not a precise
      // GPS-triggered timestamp (this only gets set whenever the
      // driver happens to open Reordina and check the box, which
      // could be minutes after the actual delivery) — stamped once,
      // the first time a client transitions TO completed, and never
      // overwritten if it's already set (so re-opening Reordina
      // later doesn't keep bumping the time forward). Uses
      // dpReordinaCheckOrder's own real-check-time record (see the
      // 'change' listener wired in dpOpenReordinaModal) instead of a
      // fresh Date.now() here — this whole loop runs all at once, at
      // confirm time, so a plain Date.now() here would give every box
      // checked in this same sitting a near-identical stamp,
      // regardless of which was actually tapped first.
      if (client.status === 'completed' && !wasCompleted && !client.completedAt) client.completedAt = dpReordinaCheckOrder[client.id] || Date.now();
      if (client.status !== 'completed') client.completedAt = null; // unchecking a mistaken mark clears the stale timestamp too
      if (client.status === 'completed' && !wasCompleted) newlyCompleted.push(client);
    });
    // REAL BUG, reported directly ("consegnele facute nu pleaca la
    // sfarsitul listei"): a client checked off here only actually
    // moved to the end of the list once the async optimization below
    // (ORS call, or its own AUTO-off/failure fallback) finished and
    // called applyOrder — which reorders correctly, but only as a
    // side effect of that whole round trip. Until then (and if that
    // round trip is ever slow, or the driver navigates away before it
    // settles), the just-completed client stayed exactly where it
    // was, checkmark and all, mid-list — matching a comment further
    // below in this very file that already assumed, incorrectly, that
    // "run.clients already keeps completed ones pushed to the end".
    // Made genuinely, immediately true here instead: reordered the
    // instant a status actually changes, before anything else runs —
    // the optimization below still reorders the REMAINING (pending)
    // ones by route afterward, exactly as before; this only fixes
    // where the completed ones sit relative to them, immediately.
    state.deliveryRun.clients = state.deliveryRun.clients.filter(function (c) { return c.status !== 'completed'; })
      .concat(dpSortByCompletionOrder(state.deliveryRun.clients.filter(function (c) { return c.status === 'completed'; })));
    saveDeliveryRun(state.deliveryRun);
    // REAL BUG, reported directly ("functioneaza cu intarzieri, nu
    // este instant"): the reorder right above already happens in
    // memory instantly, but nothing on screen reflected it until the
    // ENTIRE async route optimization below (a real network round
    // trip to ORS, which can take a genuinely noticeable couple of
    // seconds) finished and called applyOrder/closed this modal — so
    // the driver saw the modal just sit there, unchanged, for that
    // whole stretch, looking exactly like nothing had happened yet.
    // Closing the modal and re-rendering right here instead means the
    // completed/pending split is visible the instant it actually
    // happens; the optimization below still runs the same as before,
    // refining the PENDING section's own route order a little later
    // once ORS actually replies, and re-renders again then.
    dpCloseModal('modal-dp-reordina');
    renderDeliveryPlanner();
    // REAL BUG, reported directly: a fleet owner looking at "Consegne"
    // during the day saw nothing from today, because deliveries were
    // only ever pushed to the server when the whole day got archived —
    // which normally only happens the NEXT day (or manually). Sent
    // here instead, the moment each delivery is actually confirmed —
    // same lightweight push already used at archive time
    // (syncDeliveriesToServer), just triggered live instead of a day
    // later. Uncompleted ones are removed from the server the same way.
    if (newlyCompleted.length) syncDeliveriesToServer(newlyCompleted);
    if (newlyUncompleted.length) deleteDeliveriesFromServer(newlyUncompleted);

    var completed = state.deliveryRun.clients.filter(function (c) { return c.status === 'completed'; });
    var remaining = state.deliveryRun.clients.filter(function (c) { return c.status !== 'completed'; });
    if (!remaining.length) {
      dpCloseModal('modal-dp-reordina');
      renderDeliveryPlanner();
      if (newlyCompleted.length) dpStartCameraSequence(newlyCompleted);
      return;
    }

    // Clients saved without verified coordinates (the "salva comunque"
    // fallback, for when the free geocoder genuinely couldn't find an
    // address) can't be distance/time-sequenced by ORS — there's
    // nothing to compute against. Optimized separately: the real,
    // located clients go through ORS as normal; unverified ones are
    // appended at the end of whatever batch results, by plain
    // insertion order, rather than silently dropped or crashing the
    // optimization call.
    var geolocatable = remaining.filter(function (c) { return c.lat != null && c.lon != null; });
    var unverified = remaining.filter(function (c) { return c.lat == null || c.lon == null; });

    var confirmBtn = document.getElementById('dp-reordina-confirm-btn');
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Calcolo in corso...';

    // REAL BUG, reported directly and confirmed: pressing "Reordina"
    // manually — just to check off an already-completed client, with
    // AUTO deliberately turned OFF — silently ran the full ORS
    // optimization anyway, reshuffling clients ION had placed by hand
    // in a specific order. AUTO off means exactly that: nothing here
    // should ever reorder anything on its own, whether the trigger is
    // automatic OR this manual confirm button — only marking who's
    // done should happen, keeping the remaining clients in the exact
    // order they were already in. AUTO on keeps today's existing
    // behavior (Reordina's own button doubling as a manual "run the
    // optimization now" trigger too). Reuses the SAME fallback path
    // already built below for a failed/denied optimization attempt
    // (which already correctly falls back to the current order) —
    // rather than a separate branch, deliberately skipping straight
    // to it with its own distinct error, so the toast further down
    // can tell this apart from a genuine failure and stay silent.
    var AUTO_OFF_SENTINEL = 'ADB_AUTO_RIORDINA_OFF';

    // Once geolocation has been denied THIS session, skip straight
    // past a fresh GPS attempt on every later Reordina press — ION
    // explained this is a deliberate, standing choice (location stays
    // off for ADB Smart specifically), not something to keep asking
    // about. In-memory only (dpGeoDeniedAt, not persisted), and self-
    // expiring after 60s (see dpGeoRecentlyDenied) rather than
    // sticking for the entire session — see that function's own
    // comment for the real bug this fixed.
    var optimizePromise = !dpAutoRiordinaEnabled() ? Promise.reject(new Error(AUTO_OFF_SENTINEL)) : geolocatable.length
      // REAL BUG, reported directly: on Android specifically,
      // Reordina/AUTO could take several real seconds to respond,
      // while the exact same action was instant on iPhone. Root
      // cause: currentPositionSafe() with no arguments here defaults
      // to enableHighAccuracy:true and a 5-second maximumAge — a
      // fresh, full-precision GPS hardware fix, on every single
      // press. Android's real-world high-accuracy GPS acquisition is
      // well documented to often take meaningfully longer than
      // iOS's in practice (weaker signal, OEM power-saving
      // throttling, a "cold" GPS chip). This starting point only
      // needs to be roughly right for route optimization to still
      // pick a sensible order — being off by even 100m essentially
      // never changes which stop is genuinely nearest — so a much
      // cheaper, faster fix (network/WiFi-based, a full minute of
      // caching) is the right tradeoff here specifically, even
      // though other real uses of GPS elsewhere in this app (e.g.
      // live turn-by-turn) still correctly want full precision.
      ? (dpGeoRecentlyDenied() ? Promise.reject(new Error('User denied Geolocation')) : currentPositionSafe(12000, { enableHighAccuracy: false, maximumAge: 60000 }))
          .then(function (pos) { return dpCallOrsOptimizationWithDeadlines(pos, geolocatable); })
          .catch(function (err) {
            // REAL BUG, reported directly: the route's starting point
            // must ALWAYS be the driver's real position at that exact
            // moment, never a remembered one. This used to fall back
            // to navSearchFocusPoint (a position read earlier,
            // possibly hours old, possibly from somewhere completely
            // different) the moment a fresh GPS read failed — see the
            // matching fix in dpRunAutoOptimization above for the
            // full reasoning. A failed live GPS read now just fails
            // the optimization outright (handled by the .catch below,
            // which already falls back to the current, unoptimized
            // order — a real, always-usable list, just not
            // reordered).
            if (err && err.code === 1) dpGeoDeniedAt = Date.now(); // 1 === GeolocationPositionError.PERMISSION_DENIED, the standard constant — more reliable than matching the message text, which can vary by browser
            throw err;
          })
      : Promise.resolve([]);

    // REAL BUG, found and confirmed directly: this used to only set a
    // SEPARATE preparedBatch snapshot, leaving run.clients' own order
    // (what the numbered list and drag-reordering both actually work
    // with) completely untouched. The optimized order was invisible
    // in the list itself, AND manual dragging after this had no way
    // to ever reach Google Maps (it changed run.clients, but Apri in
    // Google Maps read from the untouched preparedBatch instead).
    // Reordina now writes its result DIRECTLY into run.clients' own
    // order — the single source of truth both the visible list and
    // Apri in Google Maps both read from. Completed clients are kept,
    // moved to the end (they just show a checkmark regardless of
    // position, but keeping them out of the numbered sequence avoids
    // interleaving done items between upcoming ones).
    function applyOrder(orderedRemaining, wasActuallyOptimized) {
      // REAL BUG, reported directly and confirmed via ION's own exact
      // reproduction steps (see the identical fix in
      // dpRunAutoOptimization, right above this function, for the
      // full explanation): "completed" here is captured once, near
      // the top of dpConfirmReordina, before the network round trip
      // even starts. Re-read fresh here instead of trusting that old
      // snapshot, and anything orderedRemaining still thinks is
      // pending but has ACTUALLY been completed since is dropped from
      // it — so a completion that happens while this request is still
      // in flight can never be silently reverted by this result
      // landing late.
      var completedNowIds = {};
      state.deliveryRun.clients.forEach(function (c) { if (c.status === 'completed') completedNowIds[c.id] = true; });
      var completedNow = state.deliveryRun.clients.filter(function (c) { return c.status === 'completed'; });
      // REAL BUG, reported directly ("mi-a eliminat dei clienti dal
      // percorso di oggi"): same stale-snapshot issue as "completed"
      // just above, in the opposite direction — see the identical fix
      // and full explanation in dpRunAutoOptimization's own applyOrder
      // equivalent, right above this function.
      var knownIds = {};
      orderedRemaining.forEach(function (c) { knownIds[c.id] = true; });
      var addedDuringRun = state.deliveryRun.clients.filter(function (c) { return c.status !== 'completed' && !knownIds[c.id]; });
      state.deliveryRun.clients = orderedRemaining.concat(addedDuringRun).filter(function (c) { return !completedNowIds[c.id]; }).concat(dpSortByCompletionOrder(completedNow));
      saveDeliveryRun(state.deliveryRun);
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Ricalcola percorso';
      // REAL BUG, reported directly and confirmed with a live test:
      // pressing "Ricalcola percorso" while AUTO is also on used to
      // burn TWO ORS optimization calls instead of one — confirmed at
      // exactly 2x with 3 clients (2 remaining after marking one
      // done). Cause: this manual path never updated
      // dpLastAutoOptimizedSignature, so the very next
      // renderDeliveryPlanner() call below (which AUTO's own check
      // runs inside of) always saw a "stale" signature not matching
      // the order just applied, and fired ITS OWN redundant re-
      // optimization immediately after — on an order that was already
      // correct. Only updated on a genuine SUCCESS (matching how
      // dpRunAutoOptimization treats its own signature) — a failed/
      // fallback attempt deliberately leaves it untouched, so AUTO
      // still gets its own independent shot at optimizing if the
      // manual attempt itself failed for some transient reason.
      if (wasActuallyOptimized) {
        dpLastAutoOptimizedSignature = orderedRemaining.map(function (c) { return c.id; }).join(',');
      }
      dpCloseModal('modal-dp-reordina');
      renderDeliveryPlanner();
      if (newlyCompleted.length) dpStartCameraSequence(newlyCompleted);
    }

    optimizePromise.then(function (optimized) {
      // REAL BUG, very plausibly what ION hit: ORS/VROOM can decide
      // internally that a job is "unreachable" (routing constraints,
      // a coordinate that ended up wildly off from a background
      // geocode) and simply OMIT it from the solution's own steps —
      // with no error at all, just a quietly shorter result. Any
      // geolocatable client missing from what ORS actually returned
      // is found and appended too — same treatment as the already-
      // unverified ones: no smart distance-based placement for it,
      // but never silently lost either.
      var optimizedIds = {};
      optimized.forEach(function (c) { optimizedIds[c.id] = true; });
      var droppedByOrs = geolocatable.filter(function (c) { return !optimizedIds[c.id]; });
      optimized.forEach(function (c) { c.orsUnreachable = false; }); // see the matching comment in dpRunAutoOptimization above — same real, visible-now issue
      droppedByOrs.forEach(function (c) { c.orsUnreachable = true; });
      applyOrder(optimized.concat(unverified).concat(droppedByOrs), true);
    }).catch(function (err) {
      // Honest fallback, not a silent failure — if the optimization
      // call itself fails (offline, ORS quota, GPS unavailable), the
      // driver still gets a usable, correctly-ordered list: the
      // remaining clients in their current order, rather than being
      // stuck with no route at all. Not optimized, but not broken —
      // and, critically, this now ALSO closes the modal and
      // re-renders (a REAL BUG found and confirmed directly: this
      // branch used to leave the modal open forever after showing its
      // message, with no way to tell the batch had actually been
      // prepared behind the scenes — looked exactly like "won't let
      // me proceed").
      //
      // A DENIED geolocation permission is now handled completely
      // silently — no toast at all. ION explained directly: he
      // deliberately keeps location off for ADB Smart specifically
      // (only grants it to the actual Google Maps app), and has
      // manual drag-reordering as a real, always-available
      // alternative that needs no location at all. Given that, this
      // isn't an unexpected problem worth surfacing every time — it's
      // his own standing, intentional setting, and a notification
      // about it every single Reordina press is just unwanted noise,
      // per his own explicit request. Falls back to the current order
      // exactly the same as before, just without announcing it.
      //
      // Any OTHER, genuinely unexpected failure (network issue, ORS
      // quota, a real error) still gets a toast — that IS worth
      // knowing about, unlike the routine, expected permission case.
      var isPermissionDenied = (err && err.code === 1) || dpGeoRecentlyDenied();
      // AUTO deliberately off is a second, equally silent, expected
      // case, same reasoning as permission-denied above — this isn't
      // a failure at all, just this manual confirm respecting ION's
      // own standing choice to leave his manually-placed order alone.
      var isAutoDeliberatelyOff = err && err.message === AUTO_OFF_SENTINEL;
      if (!isPermissionDenied && !isAutoDeliberatelyOff) {
        toast('Impossibile ottimizzare (' + (err && err.message ? escapeHtml(err.message) : 'errore') + ') — uso l\'ordine attuale.', 6000);
      }
      applyOrder(remaining);
    });
  }

  // Requested directly: clients with a delivery deadline set (see the
  // "Consegna entro" field) need to be visited FIRST — before the
  // rest of the route — since they may genuinely need to happen early
  // regardless of distance.
  //
  // REAL BUG, reported directly and confirmed: the original version
  // of this ran the deadline group through its OWN, fully separate
  // optimization call — blind to every other client on the route.
  // With two deadline clients and a third, later, non-deadline one,
  // this produced real, visible backtracking: the isolated group
  // solve picked an order between the two deadline clients based
  // purely on distance from the starting position, with zero
  // awareness that going the OTHER way between them would set up a
  // far more direct continuation toward client 3 afterward — ION
  // watched the driver double back down the same street twice because
  // of it. Setting one deadline a minute earlier than the other did
  // NOT fix this either, and by design — ION had already asked,
  // earlier, for every deadline client to be treated as one single,
  // undifferentiated group (optimized together, not strictly ordered
  // by exact time), so a one-minute difference was never meant to
  // force an order between them in the first place.
  //
  // Fixed by running ONE single, fully combined optimization across
  // EVERY client at once (deadline and non-deadline together) — this
  // lets the solver see the whole picture, including what comes
  // after the deadline group, when deciding the most efficient real
  // path. The result is then simply re-partitioned: every deadline
  // client, in whatever relative order the full, globally-aware
  // solve already put them in, comes first; everyone else follows,
  // also keeping their own relative order from that same solve. This
  // still guarantees deadline clients are always visited before the
  // rest, but the ordering WITHIN each group is now informed by the
  // complete route, not decided in isolation — resolving exactly the
  // backtracking ION described, since the solver can now correctly
  // recognize when visiting the "further" deadline client first
  // actually sets up a shorter overall path.
  //
  // If there simply are no deadline clients at all, the partitioning
  // step is a no-op — the single combined call's own order is used
  // directly, unchanged, same as before this whole feature existed.
  //
  // Requested directly, separately: clients with a "Non prima delle"
  // constraint instead (can't be delivered before a given time — a
  // shop that opens late, for instance) are the OPPOSITE of urgent,
  // so they're deliberately treated as perfectly ordinary clients
  // here — never pulled into the priority group, regardless of this
  // change. HONEST LIMITATION, unchanged from before: this does NOT
  // enforce an actual real time-window constraint in the route math
  // itself (VROOM/ORS does support that, but it's a materially bigger
  // change — sending a real time window per job, not just a starting
  // position — and this sandbox has no network access to
  // openrouteservice.org to verify such a change against the real
  // API).
  // REAL BUG, reported directly and reproduced exactly with ION's own
  // 7-client test list: "entro" (scadenza) clients were already
  // correctly pulled to the front — but "non prima delle" (nonPrimaDi)
  // was never looked at anywhere in this function, so those clients
  // just stayed wherever the pure-geography optimization happened to
  // place them. Reproduced precisely: MARBET (07:30) ended up LAST,
  // behind CAME (08:00) and ESSEGI (08:50) — both genuinely meant to
  // be visited LATER — purely because MARBET was geographically
  // farther from the rest of the group, with its actual time
  // completely ignored.
  //
  // Fixed the same way scadenza already works — a real per-client
  // time window sent to VROOM itself would be the more thorough fix,
  // but this matches the existing, already-working pattern exactly:
  // after the geography-only optimization comes back, the
  // non-deadline group is re-sorted by nonPrimaDi ascending (earliest
  // allowed time first) — clients with neither scadenza nor
  // nonPrimaDi (no time constraint at all) keep their relative
  // geographic order at the end of that group, since sort() is stable
  // and Infinity always sorts after every real time.
  function dpCallOrsOptimizationWithDeadlines(startPos, clients) {
    var hasTimingClient = clients.some(function (c) { return c.scadenza || c.nonPrimaDi; });
    if (!hasTimingClient) return dpCallOrsOptimization(startPos, clients);

    return dpCallOrsOptimization(startPos, clients).then(function (fullyOptimized) {
      var withDeadline = fullyOptimized.filter(function (c) { return c.scadenza; });
      var withoutDeadline = fullyOptimized.filter(function (c) { return !c.scadenza; });
      function toMinutes(hhmm) {
        if (!hhmm) return Infinity;
        var parts = hhmm.split(':');
        return Number(parts[0]) * 60 + Number(parts[1]);
      }
      withoutDeadline.sort(function (a, b) { return toMinutes(a.nonPrimaDi) - toMinutes(b.nonPrimaDi); });
      return withDeadline.concat(withoutDeadline);
    });
  }

  // ORS Optimization (VROOM-based, free on the same ORS account/quota
  // as everything else already in use — confirmed via
  // openrouteservice.org/services and the free-tier restrictions page,
  // no separate cost). Returns the given clients re-ordered by the
  // solver, resolved from the response's job-id sequence back to the
  // actual client objects (the API itself only returns coordinates/ids,
  // not the original objects).
  //
  // REAL BUG, reported directly and confirmed, with the exact error
  // text: "Impossibile ottimizzare (Load failed)" — Safari's own
  // generic message for a fetch() call that fails at the NETWORK
  // level itself (before any HTTP response ever comes back — distinct
  // from an HTTP error like "ORS 429", which already has its own
  // clear message). This app already has a documented history of
  // iOS-specific standalone-PWA network quirks (see the geolocation
  // fixes elsewhere in this file) — a transient network-level fetch
  // failure, retried immediately, succeeds the overwhelming majority
  // of the time on a real connection. One silent retry, after a short
  // pause, before ever surfacing the error to the driver — genuine,
  // repeated failures (bad connectivity, a real ORS outage) still
  // correctly fail and fall back to the current order, same as
  // before, just no longer on the very FIRST transient blip.
  function dpFetchOrsOptimization(body) {
    function attempt() {
      return fetch('https://api.openrouteservice.org/optimization', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': ORS_API_KEY },
        body: JSON.stringify(body)
      });
    }
    return attempt().catch(function (err) {
      // Only retries a genuine NETWORK-level failure (fetch itself
      // rejecting — a TypeError, with no HTTP response at all) — an
      // actual HTTP error response (rate limit, bad request, etc.)
      // already resolves normally instead of rejecting here, so it's
      // never retried this way; that's handled separately, below,
      // exactly as before.
      if (!(err instanceof TypeError)) throw err;
      return new Promise(function (resolve) { setTimeout(resolve, 1200); }).then(attempt);
    });
  }

  function dpCallOrsOptimization(startPos, clients) {
    var v = state.vehicle;
    var profile = v.tipo === 'auto' ? 'driving-car' : 'driving-hgv';
    var body = {
      jobs: clients.map(function (c, i) { return { id: i + 1, location: [c.lon, c.lat] }; }),
      vehicles: [{ id: 1, profile: profile, start: [startPos.lon, startPos.lat] }]
    };
    return dpFetchOrsOptimization(body).then(function (r) {
      dpTrackOrsQuota(r, 'optimization');
      if (!r.ok) throw new Error('ORS ' + r.status);
      return r.json();
    }).then(function (data) {
      if (!data.routes || !data.routes[0] || !data.routes[0].steps) throw new Error('risposta non valida');
      var orderedIds = data.routes[0].steps
        .filter(function (s) { return s.type === 'job'; })
        .map(function (s) { return s.id; });
      return orderedIds.map(function (jobId) { return clients[jobId - 1]; }).filter(Boolean);
    });
  }

  // ---- Apri in Google Maps ----

  // Builds the Google Maps directions URL for the prepared batch —
  // pulled out on its own so both the visible button (a real <a> tap,
  // below) and anything else needing the URL can share one source of
  // truth.
  //
  // Deliberately still the universal https://www.google.com/maps/dir/
  // URL, not the comgooglemaps:// iOS custom scheme — checked Google's
  // own current documentation for that scheme directly: it documents
  // saddr/daddr/directionsmode (a single start and end point), with NO
  // confirmed support for multiple waypoints the way the universal URL
  // has. Since ION personally verified the universal URL genuinely
  // opens the installed Google Maps app directly with all 9 stops
  // intact, switching to the custom scheme risks trading a confirmed
  // working multi-stop link for an unconfirmed single-stop one — not
  // a safe trade without testing the scheme's real waypoint behavior
  // first, which needs a real iPhone, not something verifiable here.
  // Google Maps accepts either "lat,lon" or a plain text address for
  // destination/waypoints — used here so a client saved without
  // verified coordinates (the "salva comunque" fallback) still works
  // for the actual Google Maps hand-off, even though it can't be
  // distance-sequenced by ORS.
  // ALWAYS the trusted address text now, never coordinates — the
  // whole point of this redesign. Google Maps does its own (reliable)
  // geocoding of this text when the link opens; ADB Smart's own
  // coordinates (when present at all) exist purely for Reordina's
  // internal ordering, never for what's actually sent to Google Maps.
  function dpLocationParam(c) {
    return c.indirizzo;
  }

  function dpBuildGoogleMapsUrl(batchClients, originPos) {
    var destination = batchClients[batchClients.length - 1];
    var waypoints = batchClients.slice(0, -1);
    var url = 'https://www.google.com/maps/dir/?api=1' +
      '&destination=' + encodeURIComponent(dpLocationParam(destination)) +
      '&travelmode=driving';
    // Origin left BLANK on purpose (not set explicitly), so Google
    // Maps uses its own live "current location" detection when it
    // opens — reported directly: passing an explicit lat,lon here
    // made Maps show it as a generic dropped pin ("Un segnaposto")
    // instead of recognizing it as "La tua posizione" (your position).
    // Google Maps doesn't know an arbitrary coordinate is meant to
    // represent the driver — it just plots it as a point. Confirmed
    // separately that Google Maps' own location detection already
    // works reliably here, so there's no real upside left to passing
    // ADB Smart's own (older, less certain) GPS read instead — this
    // also means the start point Maps actually shows is always the
    // freshest possible, read at the moment Maps itself opens, not
    // whatever ADB Smart happened to capture earlier.
    if (waypoints.length) {
      url += '&waypoints=' + waypoints.map(function (c) { return encodeURIComponent(dpLocationParam(c)); }).join('%7C');
    }
    return url;
  }

  // Shared real-<a>-tap launch mechanism — used by both the main
  // batch hand-off and the single-destination Casa/Deposito buttons,
  // so there's exactly one place implementing "open Google Maps",
  // not two independent copies that could drift apart.
  //
  // UNVERIFIED, IMPORTANT: whether this reliably opens the installed
  // Google Maps app directly (versus occasionally falling to a
  // browser tab) specifically from inside the ADB Smart PWA needs to
  // be confirmed on a real iPhone and a real Android phone — that's
  // genuinely different from a link opened from within a chat app or
  // a plain browser tab, and not something verifiable here.
  function dpLaunchGoogleMaps(batchClients, originPos) {
    var url = dpBuildGoogleMapsUrl(batchClients, originPos);
    // REAL BUG, reported directly by ION: this was opening in a
    // browser tab, not the installed Google Maps app. target="_blank"
    // is the likely cause specifically inside an installed PWA
    // (running in its own standalone WKWebView on iOS, not regular
    // Safari) — "_blank" there very plausibly opens a new IN-APP web
    // view still inside the PWA's own context, rather than handing
    // the URL off to the OS's own external-link routing (which is
    // what actually decides to launch an installed native app).
    // Navigating the CURRENT window instead (no new tab/context at
    // all) is much more likely to trigger genuine OS-level handling —
    // this IS a full navigation away from ADB Smart, same as tapping
    // any external link normally would, which is exactly the intended
    // behavior here (the driver is handing off to Google Maps, not
    // meant to come back to this exact screen state anyway — ION's
    // own persistence requirements already keep the list saved
    // regardless of how they get back in).
    window.location.href = url;
  }

  function dpNavigateToSaved(kind) {
    var hw = loadNavHomeWork();
    var entry = kind === 'home' ? hw.home : hw.work;
    if (!entry) return;
    // Same fix as dpOpenInGoogleMaps — navigates immediately,
    // synchronously, using the already-fresh background position
    // instead of awaiting a new async GPS read first.
    dpLaunchGoogleMaps([{ lat: entry.lat, lon: entry.lon, indirizzo: entry.text }], navSearchFocusPoint);
  }

  function dpOpenInGoogleMaps() {
    var run = state.deliveryRun;
    // Reads directly from run.clients' own CURRENT order now, not a
    // separate preparedBatch snapshot — the REAL fix for drag-
    // reordering having no effect on what actually opened: dragging
    // changes run.clients' order directly, and this now reads that
    // same order directly too, so there's no second, staler copy to
    // ever fall out of sync with it again.
    var batchClients = run.clients.filter(function (c) { return c.status !== 'completed'; }).slice(0, 9);
    if (!batchClients.length) return;

    // REAL BUG, found on closer look: this used to wait on a FRESH,
    // async currentPosition() GPS read before navigating at all —
    // meaning the actual navigation only happened well AFTER the
    // click handler itself had already returned. Browsers only treat
    // a navigation as stemming from a "trusted user gesture" (which
    // is specifically what iOS Universal Links / Android App Links
    // require to hand off to an installed native app instead of
    // falling back to a browser) for a short, synchronous window right
    // after the actual tap — waiting on an async GPS fix, which can
    // easily take a second or more, reliably burns through that
    // window. This is very likely the real reason the app was opening
    // in a browser every time, independent of the earlier
    // target="_blank" vs window.location.href change, which never
    // addressed the actual timing problem.
    //
    // Fixed by navigating IMMEDIATELY, synchronously, inside this
    // click handler — using navSearchFocusPoint, a position ALREADY
    // kept fresh in the background (updated silently every time this
    // screen renders, see renderDeliveryPlanner) rather than
    // requesting a brand new GPS fix and waiting on it here. Slightly
    // less precise (could be a little stale) but genuinely available
    // synchronously, which matters far more for actually reaching the
    // native app at all.
    dpLaunchGoogleMaps(batchClients, navSearchFocusPoint);
  }


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
    // Fixed header — Casa/Lavoro shortcuts and the Partenza field never
    // scroll away, regardless of how many tappe get added below.
    html += '<div class="nav-search-panel-top">';
    html += '<div class="nav-shortcuts-row" id="nav-shortcuts-row"></div>';
    html += '<div id="nav-origin-field"></div>';
    html += '</div>';
    // Only THIS grows/scrolls as tappe are added — previously the
    // whole panel (shortcuts, Partenza, every tappa, Aggiungi tappa,
    // Calcola percorso, all of it) scrolled as one block, which meant
    // adding several tappe pushed Calcola percorso itself out of view,
    // needing a scroll down just to reach it. Now that button (and
    // Aggiungi tappa, and the shortcuts/Partenza above) stay exactly
    // where they are; only the tappa rows themselves move.
    html += '<div class="nav-search-panel-scroll" id="nav-waypoints-list"></div>';
    // Fixed footer — same reasoning as the header above.
    html += '<div class="nav-search-panel-bottom">';
    html += '<button type="button" class="nav-add-stop-btn" id="nav-add-stop">+ Aggiungi tappa</button>';
    html += '<button type="button" class="btn btn-accent btn-block" id="nav-calc-btn" style="margin-top:12px;">Calcola percorso</button>';
    html += '</div>';
    html += '</div>';

    // Floating controls, bottom-right — same spot Google Maps puts its
    // own layers toggle and "my location" button.
    html += '<div class="nav-float-controls" id="nav-float-controls">';
    html += '<button type="button" class="nav-float-btn" id="nav-layers-btn" aria-label="Vista satellite">' + svgIcon('nav-layers') + '</button>';
    html += '<button type="button" class="nav-float-btn" id="nav-locate-btn" aria-label="La mia posizione"><svg viewBox="0 0 60 60" width="22" height="22"><circle cx="30" cy="30" r="27" fill="#ffffff" stroke="#e4e8ef" stroke-width="2"/><circle cx="30" cy="30" r="10" fill="#6fa3ff"/><circle cx="30" cy="30" r="18" fill="#6fa3ff" fill-opacity="0.18"/></svg></button>';
    html += '</div>';

    html += '<div id="nav-result" class="nav-result" style="display:none;"></div>';

    html += '<div id="nav-active-overlay" class="nav-active-overlay" style="display:none;">';
    // Grouped together in one wrapper — .nav-active-overlay itself uses
    // justify-content:space-between across its direct children (to pin
    // the banner at the top and the stats bar at the bottom), so
    // without this wrapper, adding the toast as a second direct child
    // would land it in the vertical MIDDLE of the screen instead of
    // right under the banner where it belongs. Grouping them means
    // space-between only ever sees ONE thing at the top (this whole
    // group) and the stats bar at the bottom, while the banner and
    // toast stack normally against each other inside it.
    html += '<div class="nav-top-stack">';
    html += '<div class="nav-instruction-banner">' +
      '<button type="button" class="nav-exit-x" id="nav-exit-x" aria-label="Esci dalla navigazione">✕</button>' +
      '<div class="nav-instruction-icon-wrap"><span id="nav-instr-icon">' + svgIcon('nav-straight') + '</span></div>' +
      '<div class="nav-instruction-copy"><div class="nav-instruction-dist" id="nav-instr-dist">—</div><div class="nav-instruction-text" id="nav-instr-text"></div></div>' +
      '</div>';
    // A dedicated notification, positioned right under the green
    // instruction banner — used for status messages that matter WHILE
    // actively navigating (currently: reroute status). The app's
    // regular toast() is fixed near the bottom of the screen, which
    // during active navigation sits right on top of the arrivo/tempo/
    // distanza stats bar — confusing, easy to miss, and visually
    // clashing with that bar's own text. This one is scoped to exactly
    // where a driver's eyes already are (right below the instruction
    // they're reading), and never competes with the bottom stats.
    html += '<div class="nav-toast" id="nav-toast"><span class="dot"></span><span id="nav-toast-text"></span></div>';
    html += '</div>';
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
    renderNavOriginField();
    renderNavWaypointsList();
    renderNavShortcuts();
    populateNavVehicleForm();

    document.getElementById('nav-search-bar').addEventListener('click', function () {
      var panel = document.getElementById('nav-search-panel');
      var opening = panel.style.display === 'none';
      panel.style.display = opening ? 'block' : 'none';
      // Re-opening the trip-planning panel to make further changes
      // (e.g. add another tappa) needs to hide any already-calculated
      // result card underneath it — otherwise both end up visible at
      // once, stacked messily on top of each other (confirmed exactly
      // this in real testing: Percorso 1/2 and Avvia navigazione still
      // showing behind the reopened panel).
      if (opening) {
        var resultEl = document.getElementById('nav-result');
        if (resultEl) resultEl.style.display = 'none';
      }
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
    document.getElementById('nav-recenter-btn').addEventListener('click', function () { navRecenterOnDriver(true); });

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
    // A plain car has no meaningful height/width/length/weight
    // restrictions to configure at all — requiring those fields before
    // considering it "configured" would keep popping the vehicle setup
    // modal open for 'auto' users who have nothing left to fill in.
    if (v.tipo === 'auto') return true;
    return !!(v.altezza && v.larghezza && v.lunghezza && v.massa);
  }

  // ------------------------------------------------------------------
  // MapLibre GL compatibility shim
  // ------------------------------------------------------------------
  // The Navigator was originally built on Leaflet + raster tiles
  // (CARTO for streets, Esri for satellite). Migrated here to MapLibre
  // GL JS + OpenFreeMap vector tiles — both genuinely free, no API key,
  // no card, same as before — specifically to get real map tilt/pitch
  // (a proper 3D driving camera) and native bearing rotation, neither
  // of which is achievable with flat pre-rendered raster tiles no
  // matter what CSS tricks are applied (confirmed broken, twice,
  // earlier in this app's history).
  //
  // Rather than rewrite every single call site that used Leaflet's API
  // throughout this file, this shim defines an `L` object (Leaflet's
  // own global is no longer loaded at all) and a navMap wrapper that
  // expose the SAME method names/shapes the existing code already
  // calls (L.marker, L.divIcon, L.geoJSON, L.featureGroup,
  // L.latLngBounds, navMap.setView, .removeLayer, .fitBounds, etc.) —
  // internally driving MapLibre instead. This keeps the (very large)
  // amount of existing, already-tested application logic untouched,
  // and confines all of the actual engine-swap risk to this one
  // section.
  var navShimLayerCounter = 0;

  // Runs fn once the map's style has genuinely finished loading — fully
  // self-tracked (realMap._navStyleReady / ._navPendingQueue, set up in
  // initNavMap's realMlMap.on('load', …)) rather than relying on
  // MapLibre's own isStyleLoaded()/once('load', …). That combination
  // has a real, known gotcha: once('load', …) only fires on the NEXT
  // occurrence of the event — if 'load' already fired earlier (which
  // it normally has, by the time a route actually gets drawn, well
  // after the map was first created), registering AFTER that point
  // means the callback never runs at all. This was very likely why
  // the very first leg of a multi-stop trip's route sometimes didn't
  // draw at all: several legs' addTo() calls can land in the exact
  // same synchronous pass, and if the timing happened to fall on
  // exactly the wrong side of that gotcha for any one of them, that
  // one leg would simply never appear, with no error to point to why.
  // A queue this file owns and drains itself removes that ambiguity
  // entirely, regardless of exactly when 'load' happens to fire.
  function navRunWhenStyleReady(realMap, fn) {
    if (realMap._navStyleReady) { fn(); return; }
    if (!realMap._navPendingQueue) realMap._navPendingQueue = [];
    realMap._navPendingQueue.push(fn);
  }

  // The id of the base style's own first road-line or label layer —
  // where satellite imagery gets inserted BELOW, so those stay drawn
  // over the imagery (matches Google's own hybrid satellite view)
  // instead of the imagery covering everything including labels.
  // Meant to be called only once the style has actually loaded (see
  // navTileLayerShim's beforeId, which accepts this as a deferred
  // function for exactly that reason).
  function navSatelliteBeforeLayerId(realMap) {
    var layers = realMap.getStyle().layers;
    var found = layers.filter(function (l) { return l.type === 'line' || l.type === 'symbol'; })[0];
    return found ? found.id : undefined;
  }

  // Colored "shield" badges for motorway/trunk route numbers (A4, A13,
  // SR308…) — matching the real Italian road-sign convention Google
  // Maps also follows: green for autostrade, blue for statali/
  // regionali. The base OpenFreeMap style already draws these route
  // numbers (confirmed directly by ION: the "A13" text and its box
  // outline were already showing), but as a plain white box with no
  // color-coding — this hides JUST that plain version for
  // motorway/trunk specifically and draws a colored replacement using
  // the same underlying data. An earlier attempt at road styling here
  // colored the ROAD LINES themselves green/blue, which turned out not
  // to be wanted (reverted) — this is deliberately narrower: only the
  // route-number badge itself changes, the road line stays whatever
  // color it already was.
  function navSetupHighwayShields(realMap) {
    var style = realMap.getStyle();
    var vectorSourceId = Object.keys(style.sources).filter(function (id) { return style.sources[id].type === 'vector'; })[0];
    if (!vectorSourceId) return;

    // OpenMapTiles' standard schema keeps route-number labels in their
    // own source-layer, separate from the road lines themselves —
    // "transportation_name" is the universal name for it across
    // OpenMapTiles-based styles, same as "transportation" already was
    // for the lines.
    var shieldLayerIds = style.layers
      .filter(function (l) {
        return l.type === 'symbol' && l['source-layer'] === 'transportation_name' &&
          l.filter && (JSON.stringify(l.filter).indexOf('"motorway"') !== -1 || JSON.stringify(l.filter).indexOf('"trunk"') !== -1);
      })
      .map(function (l) { return l.id; });
    shieldLayerIds.forEach(function (id) { realMap.setLayoutProperty(id, 'visibility', 'none'); });

    ['motorway', 'trunk'].forEach(function (roadClass) {
      realMap.addLayer({
        id: 'nav-shield-' + roadClass,
        type: 'symbol',
        source: vectorSourceId,
        'source-layer': 'transportation_name',
        filter: ['==', ['get', 'class'], roadClass],
        layout: {
          'text-field': ['get', 'ref'],
          'text-font': ['Noto Sans Bold'],
          'text-size': 11,
          'symbol-placement': 'line',
          'symbol-spacing': 350
        },
        paint: {
          'text-color': '#ffffff',
          // The halo is what reads as a solid colored "badge" behind
          // the text at this size, without needing a custom sprite
          // image — green for autostrade, blue for statali/regionali,
          // matching real Italian road signage.
          'text-halo-color': roadClass === 'motorway' ? '#1B8A3C' : '#1565C0',
          'text-halo-width': 3
        }
      });
    });
  }

  // Tracks which of the base style's own road-line layers are minor
  // roads (secondary/tertiary/residential/service/etc, as opposed to
  // motorway/trunk/primary) — populated once by navSetupRoadHighlights,
  // used by toggleNavSatelliteView to hide them specifically in
  // satellite mode (a satellite view crowded with every little side
  // street is much harder to read than one showing just the roads that
  // actually matter for a HGV driver: autostrade, tangenziali/
  // superstrade, strade statali/principali).
  var navMinorRoadLayerIds = [];

  // Finds and remembers the base style's own MINOR road layers (see
  // navMinorRoadLayerIds above), for satellite decluttering.
  function navSetupRoadHighlights(realMap) {
    var style = realMap.getStyle();

    // Every LINE layer the base style itself draws from the
    // "transportation" source-layer, that ISN'T motorway/trunk/primary
    // — i.e. the minor-road rendering already built into the style —
    // remembered here so satellite mode can hide just these, while the
    // style's own motorway/trunk/primary-road layers (and their
    // route-number labels) stay visible and untouched.
    navMinorRoadLayerIds = style.layers
      .filter(function (l) {
        return l.type === 'line' && l['source-layer'] === 'transportation' &&
          !(l.filter && JSON.stringify(l.filter).indexOf('"primary"') !== -1) &&
          !(l.filter && JSON.stringify(l.filter).indexOf('"motorway"') !== -1) &&
          !(l.filter && JSON.stringify(l.filter).indexOf('"trunk"') !== -1);
      })
      .map(function (l) { return l.id; });

    // 3D building extrusions disabled entirely — genuinely expensive
    // to render (thousands of extruded polygons, recomputed every
    // single frame while panning or driving) compared to a flat map,
    // and a real, likely candidate for exactly what was reported:
    // even plain manual dragging (handled entirely by MapLibre's own
    // native panning, never touching any of this app's own JS camera
    // code at all) not feeling fluid — if raw map rendering itself
    // can't keep up on a given device, no amount of tuning the JS-side
    // camera logic driving WHERE the map points can fix that, since
    // the bottleneck is in drawing the pixels themselves, not in how
    // often a new frame is requested. Buildings add visual richness
    // but nothing functionally necessary for turn-by-turn guidance,
    // unlike the map's own pitch/tilt (kept) — a reasonable trade
    // given the real fluidity cost.
    style.layers
      .filter(function (l) { return l.type === 'fill-extrusion'; })
      .forEach(function (l) { realMap.setLayoutProperty(l.id, 'visibility', 'none'); });
  }

  function navShimBoundsFromGeoJSON(feature) {
    var coords = feature.geometry.coordinates;
    var minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    coords.forEach(function (c) {
      if (c[1] < minLat) minLat = c[1]; if (c[1] > maxLat) maxLat = c[1];
      if (c[0] < minLon) minLon = c[0]; if (c[0] > maxLon) maxLon = c[0];
    });
    return { sw: [minLat, minLon], ne: [maxLat, maxLon] };
  }
  function navShimUnionBounds(a, b) {
    return { sw: [Math.min(a.sw[0], b.sw[0]), Math.min(a.sw[1], b.sw[1])], ne: [Math.max(a.ne[0], b.ne[0]), Math.max(a.ne[1], b.ne[1])] };
  }

  // A marker — wraps maplibregl.Marker. latlng is [lat, lon], matching
  // every existing call site (unchanged from the Leaflet convention).
  function navMarkerShim(latlng, opts) {
    opts = opts || {};
    var el = document.createElement('div');
    if (opts.icon) {
      el.className = opts.icon.className || '';
      el.innerHTML = opts.icon.html || '';
    }
    var markerOpts = { element: el };
    if (opts.icon && opts.icon.iconAnchor && opts.icon.iconSize) {
      // Leaflet's iconAnchor is the point WITHIN the icon that sits on
      // the coordinate; MapLibre's offset is a pixel shift away from
      // its own default anchor (icon center). Converting one into the
      // other keeps every existing icon definition's iconAnchor value
      // meaning the same thing it always did.
      var iw = opts.icon.iconSize[0], ih = opts.icon.iconSize[1];
      var ax = opts.icon.iconAnchor[0], ay = opts.icon.iconAnchor[1];
      markerOpts.anchor = 'center';
      markerOpts.offset = [iw / 2 - ax, ih / 2 - ay];
    }
    var mlMarker = new maplibregl.Marker(markerOpts).setLngLat([latlng[1], latlng[0]]);
    var popup = null;
    var wrapper = {
      addTo: function (target) {
        var realMap = (target && target._maplibre) ? target._maplibre : target;
        mlMarker.addTo(realMap);
        return wrapper;
      },
      bindPopup: function (html) {
        popup = new maplibregl.Popup({ offset: 14, closeButton: false }).setHTML(html);
        mlMarker.setPopup(popup);
        return wrapper;
      },
      openPopup: function () { if (popup && !popup.isOpen()) mlMarker.togglePopup(); return wrapper; },
      setLatLng: function (ll) { mlMarker.setLngLat([ll[1], ll[0]]); return wrapper; },
      getElement: function () { return el; },
      remove: function () { mlMarker.remove(); }
    };
    return wrapper;
  }

  // A styled line from a GeoJSON LineString feature — wraps a MapLibre
  // GeoJSON source + line layer pair. Deferred until the style has
  // actually finished loading if it hasn't yet (addSource/addLayer
  // throw otherwise) — matters right at initial map creation, never
  // again after that.
  function navGeoJSONShim(feature, opts) {
    opts = opts || {};
    var style = opts.style || {};
    var id = 'navlyr-' + (navShimLayerCounter++);
    var clickHandler = null;
    var addedToMap = null;
    var mouseEnterHandler = null, mouseLeaveHandler = null;
    var wrapper = {
      addTo: function (target) {
        if (target && target._isFeatureGroup) { target._children.push(wrapper); return wrapper; }
        var realMap = (target && target._maplibre) ? target._maplibre : target;
        var doAdd = function () {
          addedToMap = realMap;
          if (realMap.getSource(id)) return; // already added (e.g. re-entrant during a fast toggle)
          realMap.addSource(id, { type: 'geojson', data: feature });
          realMap.addLayer({
            id: id, type: 'line', source: id,
            layout: { 'line-cap': style.lineCap === 'round' ? 'round' : 'butt', 'line-join': style.lineJoin === 'round' ? 'round' : 'miter' },
            paint: {
              'line-color': style.color || '#1A73E8',
              'line-width': style.weight || 6,
              'line-opacity': style.opacity != null ? style.opacity : 1
            }
          });
          if (style.dashArray) realMap.setPaintProperty(id, 'line-dasharray', style.dashArray.split(' ').map(Number));
          // Named handler references (not anonymous functions) so
          // remove() below can properly un-register them — this layer
          // gets destroyed and recreated with a brand new id on every
          // single GPS position update while actively navigating
          // (drawActiveNavLegs), so leaving stale listeners behind
          // uncleaned would grow without bound over a long drive.
          mouseEnterHandler = function () { realMap.getCanvas().style.cursor = 'pointer'; };
          mouseLeaveHandler = function () { realMap.getCanvas().style.cursor = ''; };
          realMap.on('mouseenter', id, mouseEnterHandler);
          realMap.on('mouseleave', id, mouseLeaveHandler);
          if (clickHandler) realMap.on('click', id, clickHandler);
        };
        navRunWhenStyleReady(realMap, doAdd);
        return wrapper;
      },
      on: function (evt, fn) {
        if (evt === 'click') {
          clickHandler = fn;
          if (addedToMap) addedToMap.on('click', id, fn);
        }
        return wrapper;
      },
      remove: function () {
        if (!addedToMap) return;
        if (mouseEnterHandler) addedToMap.off('mouseenter', id, mouseEnterHandler);
        if (mouseLeaveHandler) addedToMap.off('mouseleave', id, mouseLeaveHandler);
        if (clickHandler) addedToMap.off('click', id, clickHandler);
        if (addedToMap.getLayer(id)) addedToMap.removeLayer(id);
        if (addedToMap.getSource(id)) addedToMap.removeSource(id);
      },
      getBounds: function () { return navShimBoundsFromGeoJSON(feature); },
      // Updates this layer's geometry in place — MUCH cheaper than
      // remove() + a fresh addTo(), which tears down and rebuilds the
      // GL buffers from scratch. Used for the current leg's progressive
      // trim (drawActiveNavLegs), which used to fully recreate every
      // route layer on EVERY single GPS tick during active navigation
      // — real, avoidable overhead on every update, a real contributor
      // to sluggish-feeling camera/map response after the MapLibre
      // migration.
      setData: function (newFeature) {
        feature = newFeature; // keep getBounds() correct against the current geometry too
        if (addedToMap && addedToMap.getSource(id)) addedToMap.getSource(id).setData(newFeature);
      }
    };
    return wrapper;
  }

  // A group of the above (markers are never grouped in this codebase,
  // only geoJSON line layers) — deferred addTo() until the group
  // itself is added to the real map, so children added to a group
  // before the group is on the map don't try to touch MapLibre too
  // early. getBounds() unions every child's bounds, same as Leaflet's
  // featureGroup.
  function navFeatureGroupShim() {
    var children = [];
    var addedTarget = null;
    var wrapper = {
      _isFeatureGroup: true,
      _children: children,
      addTo: function (target) {
        addedTarget = target;
        children.forEach(function (child) { child.addTo(target); });
        return wrapper;
      },
      remove: function () { children.forEach(function (child) { child.remove(); }); },
      getBounds: function () {
        var b = null;
        children.forEach(function (child) {
          var cb = child.getBounds ? child.getBounds() : null;
          if (cb) b = b ? navShimUnionBounds(b, cb) : cb;
        });
        return b;
      },
      // THE REAL BUG, finally confirmed via a live error report:
      // drawColorCodedRoute (PR #225, the Google-style two-tone route
      // line) started returning a featureGroup of TWO layers (casing +
      // fill) instead of a single geoJSON layer — but
      // updateCurrentLegTrim (PR #217's performance optimization)
      // still called .setData() directly on that return value every
      // single GPS tick, expecting the OLD single-layer shape.
      // featureGroups never had a setData() method at all — every
      // single position update threw "navCurrentLegLayer.setData is
      // not a function", ending onActiveNavPosition right there,
      // before it ever got as far as the position-marker code that
      // came after it in the function. This is what the arrow being
      // missing actually was the whole time — not a rendering bug, not
      // a caching issue, a plain crash. Fixed here at the shim level:
      // forwards setData to every child that has one (both the casing
      // and fill layers), keeping them in sync together.
      setData: function (newFeature) {
        children.forEach(function (child) {
          if (child.setData) child.setData(newFeature);
        });
      }
    };
    return wrapper;
  }

  // A raster tile layer (used for the Esri satellite imagery only now
  // — the street basemap itself comes from the OpenFreeMap vector
  // style directly, not a separate raster layer, which is the whole
  // point of this migration). urlTemplate can contain {s} for
  // subdomain rotation, matching how it was already written.
  function navTileLayerShim(urlTemplate, opts) {
    opts = opts || {};
    var id = 'navtiles-' + (navShimLayerCounter++);
    var tiles = opts.subdomains
      ? opts.subdomains.split('').map(function (s) { return urlTemplate.replace('{s}', s); })
      : [urlTemplate];
    var addedToMap = null;
    var wrapper = {
      // beforeId (optional): inserts this raster layer BELOW an
      // existing layer instead of appending it at the very top —
      // used for satellite imagery specifically, so it sits under the
      // base vector style's own road lines and labels rather than
      // covering them. Without this, satellite mode was completely
      // bare imagery with no streets drawn over it at all, unlike
      // Google's own hybrid satellite view. Accepts either a plain
      // layer id, or a FUNCTION that returns one — needed because
      // finding "the base style's first line/label layer" requires
      // the style to have already loaded, which often isn't true yet
      // at the exact moment addTo() is first called (right at map
      // creation); a function defers that lookup to when it's
      // actually safe to run, same as navRunWhenStyleReady already
      // does for the add itself.
      addTo: function (target, beforeId) {
        var realMap = (target && target._maplibre) ? target._maplibre : target;
        var doAdd = function () {
          addedToMap = realMap;
          var resolvedBeforeId = typeof beforeId === 'function' ? beforeId(realMap) : beforeId;
          // REAL BUG, confirmed: opts.maxZoom was accepted as a
          // parameter but never actually passed through to the real
          // MapLibre source — addSource had no maxzoom at all, so
          // MapLibre used its own default (22) instead of the actual
          // limit of what Esri's imagery serves in a given area.
          // Without an explicit maxzoom, MapLibre doesn't know to
          // "overzoom" (keep showing the last available zoom level's
          // tile, scaled up, once past it) — it just keeps requesting
          // brand new tiles at every zoom level the user reaches, and
          // once those requests come back empty for a zoom Esri
          // doesn't actually have data at, the map shows exactly the
          // "Map data not yet available" placeholder that was
          // reported. Setting maxzoom here is what tells MapLibre
          // "stop requesting new tiles past this point, reuse what
          // you already have" — genuine overzoom, not a blank gap.
          if (!realMap.getSource(id)) realMap.addSource(id, { type: 'raster', tiles: tiles, tileSize: 256, attribution: opts.attribution || '', maxzoom: opts.maxZoom || 19 });
          if (!realMap.getLayer(id)) realMap.addLayer({ id: id, type: 'raster', source: id }, resolvedBeforeId);
        };
        navRunWhenStyleReady(realMap, doAdd);
        return wrapper;
      },
      remove: function () {
        if (!addedToMap) return;
        if (addedToMap.getLayer(id)) addedToMap.removeLayer(id);
        if (addedToMap.getSource(id)) addedToMap.removeSource(id);
      }
    };
    return wrapper;
  }

  function navLatLngBoundsShim(points) {
    var minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    points.forEach(function (p) {
      var lat = Array.isArray(p) ? p[0] : p.lat, lon = Array.isArray(p) ? p[1] : p.lon;
      if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon;
    });
    return { sw: [minLat, minLon], ne: [maxLat, maxLon] };
  }

  // A simple round dot marker (used only for the brief "permission
  // confirmed" flash before active navigation actually starts) —
  // implemented the same way as navMarkerShim (a styled DOM element),
  // just with the circle drawn via CSS instead of an SVG icon string.
  function navCircleMarkerShim(latlng, opts) {
    opts = opts || {};
    var el = document.createElement('div');
    var d = (opts.radius || 8) * 2;
    el.style.width = d + 'px';
    el.style.height = d + 'px';
    el.style.borderRadius = '50%';
    el.style.background = opts.fillColor || '#4285F4';
    el.style.opacity = opts.fillOpacity != null ? opts.fillOpacity : 1;
    el.style.border = (opts.weight || 3) + 'px solid ' + (opts.color || '#fff');
    el.style.boxSizing = 'border-box';
    var mlMarker = new maplibregl.Marker({ element: el }).setLngLat([latlng[1], latlng[0]]);
    return {
      addTo: function (target) { mlMarker.addTo((target && target._maplibre) ? target._maplibre : target); return this; },
      remove: function () { mlMarker.remove(); }
    };
  }

  var L = {
    marker: navMarkerShim,
    circleMarker: navCircleMarkerShim,
    divIcon: function (opts) { return opts; }, // just a descriptor consumed by navMarkerShim — MapLibre markers take a real DOM element, not a Leaflet Icon instance
    geoJSON: navGeoJSONShim,
    featureGroup: navFeatureGroupShim,
    latLngBounds: navLatLngBoundsShim,
    tileLayer: navTileLayerShim
  };

  // Wraps a real maplibregl.Map so every existing navMap.* call
  // elsewhere in this file keeps working unchanged.
  function navMapShim(realMap) {
    return {
      _maplibre: realMap,
      setView: function (latlng, zoom, opts) {
        var center = [latlng[1], latlng[0]];
        if (opts && opts.animate === false) realMap.jumpTo({ center: center, zoom: zoom });
        else realMap.easeTo({ center: center, zoom: zoom, duration: 300 });
      },
      // Superseded by the continuous per-frame smoothing loop
      // (navSmoothCameraFrame) — that runs every animation frame
      // rather than only reacting to each discrete GPS tick, which
      // turned out to be genuinely more fluid than any fixed-duration
      // eased transition could be (tried both a short 180ms and a
      // longer 900ms version of this before replacing it entirely).
      // Kept removed rather than left as dead code so there's no
      // confusion about which mechanism is actually driving the
      // camera during active navigation.
      removeLayer: function (layer) { if (layer && layer.remove) layer.remove(); },
      fitBounds: function (bounds, opts) {
        if (!bounds) return;
        var pad = (opts && opts.padding) ? opts.padding[0] : 24;
        realMap.fitBounds([[bounds.sw[1], bounds.sw[0]], [bounds.ne[1], bounds.ne[0]]], { padding: pad, duration: 300 });
      },
      invalidateSize: function () { realMap.resize(); },
      on: function (evt, fn) { realMap.on(evt, fn); },
      off: function (evt, fn) { realMap.off(evt, fn); },
      // Native in MapLibre — no shimming needed, but exposed here so
      // rotateNavMapToHeading's existing `navMap.setBearing` call (and
      // the new setPitch for the 3D driving tilt) keep working the
      // same way every other navMap.* method does.
      setBearing: function (deg) { realMap.setBearing(deg); },
      // Eased (not an instant jump) — this only ever fires twice per
      // trip (tilting in at Avvia, flattening back out at Termina),
      // so there's no continuous-loop cost concern here the way there
      // would be for something called every frame; a smooth, brief
      // transition instead of a hard snap into/out of the 3D driving
      // angle is a clear, easy win with no real downside.
      setPitch: function (deg) { realMap.easeTo({ pitch: deg, duration: 800 }); },
      remove: function () { realMap.remove(); }
    };
  }

  var navSatelliteLayer = null; // no separate street layer anymore — the base MapLibre style itself IS the street map now
  function initNavMap() {
    var mapEl = document.getElementById('nav-map');
    // maplibregl is the real external dependency now (L is this file's
    // own shim, always defined) — this guards against the vendored
    // script somehow failing to load, same intent as the original
    // check had for Leaflet.
    if (!mapEl || typeof maplibregl === 'undefined') return;
    if (navMap) { navMap.remove(); navMap = null; }
    navWaypointMarkers = {}; // the old map instance (and any markers on it) is gone
    navRouteLayer = null;
    navLocateMarker = null;
    // REAL BUG, confirmed: this was the one marker NOT reset here,
    // unlike every other one on this screen. Whenever the map gets
    // rebuilt from scratch (e.g. navigating away from Navigatore and
    // back while a trip was already active) navPositionMarker kept
    // pointing at the OLD marker object, now orphaned on a map
    // instance that no longer exists — invisible, but still truthy.
    // The very next GPS update's `if (!navPositionMarker) { …create a
    // fresh one… }` check then saw something already "there" and
    // never created a real replacement on the NEW map at all — the
    // actual root cause of the arrow never showing, confirmed after
    // ruling out caching (retested fresh via browser, still missing)
    // and the SVG rendering itself (verified correct on main).
    navPositionMarker = null;
    // REVERTED, THEN RE-ENABLED — real map rotation was tried three
    // times before this migration (two CSS-transform hacks, then the
    // leaflet-rotate plugin) and confirmed broken on real devices each
    // time — the car icon pointing sideways, the recenter button dying,
    // the camera losing the car entirely. All three of those were
    // trying to fake rotation on top of flat, pre-rendered raster
    // tiles, which is fundamentally the wrong tool for it. MapLibre's
    // bearing/pitch are native, first-class map properties — not a
    // visual hack — which is the actual reason this is being tried
    // again, on a genuinely different foundation, rather than a fourth
    // attempt at the same broken approach. Still genuinely NOT verified
    // live by me in this environment (no browser here) — needs real,
    // careful on-device testing before being trusted, same as
    // everything rotation-related always has in this app's history.
    var realMlMap = new maplibregl.Map({
      container: mapEl,
      // OpenFreeMap's "liberty" style — free, no API key, no account,
      // no card, no request limits (openfreemap.org) — the vector-tile
      // equivalent of the CARTO Voyager raster tiles used before:
      // light background, clear roads and labels.
      style: 'https://tiles.openfreemap.org/styles/liberty',
      center: [9.19, 45.4642], // MapLibre uses [lon, lat] — note the reversed order from every navMap.* call in this file, which all keep the [lat, lon] convention Leaflet used
      zoom: 6,
      pitch: 0,
      bearing: 0,
      attributionControl: { compact: true },
      // Explicit inertial/kinetic panning tuning — MapLibre has this
      // NATIVE and on by default (never disabled here), but the
      // default feel is fairly subtle. Nudged toward a more
      // pronounced, Google-Maps-like momentum. Property names
      // confirmed against MapLibre's own DragPanHandler docs
      // (linearity/easing/maxSpeed/deceleration); exact exchange rate
      // between the numbers and how far a flick carries is genuinely
      // best tuned by feel on a real device, not something to claim
      // false precision about here. This governs MANUAL dragging
      // only — entirely separate from, and doesn't affect, the
      // GPS-driven camera during active navigation (that's its own
      // continuous dead-reckoning loop, not this).
      dragPan: {
        deceleration: 3400,
        maxSpeed: 3200,
        linearity: 0.15
      }
    });
    navMap = navMapShim(realMlMap);
    // Drives navRunWhenStyleReady above — a real, always-fires 'load'
    // listener (not once, though it only matters once in practice: the
    // flag makes every call after the first a no-op anyway), draining
    // whatever queued up before the style finished loading.
    realMlMap._navStyleReady = false;
    realMlMap._navPendingQueue = [];
    realMlMap.on('load', function () {
      realMlMap._navStyleReady = true;
      var queue = realMlMap._navPendingQueue;
      realMlMap._navPendingQueue = [];
      queue.forEach(function (fn) { fn(); });
      navSetupRoadHighlights(realMlMap);
      navSetupHighwayShields(realMlMap);
    });
    // Esri's free World Imagery — real satellite/aerial photography,
    // added as a raster layer ON TOP of the vector street style when
    // satellite mode is toggled on, rather than switching the whole
    // style out — switching styles would wipe every route line/marker
    // layer added afterward, needing them all rebuilt; layering
    // satellite on top avoids that entirely.
    navSatelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles © Esri',
      maxZoom: 19
    });
    if (navShowingSatellite) navSatelliteLayer.addTo(navMap, navSatelliteBeforeLayerId);
    navMap.on('click', function (e) {
      if (navPickingWaypointId) handleNavMapPick(e.lngLat);
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
    if (!navMap || !navSatelliteLayer) return;
    navShowingSatellite = !navShowingSatellite;
    if (navShowingSatellite) {
      // Inserted BELOW the vector style's own road lines and labels —
      // not appended on top of everything — so those stay visible
      // drawn over the imagery, matching how Google's own satellite
      // view works (real aerial photography, with streets and place
      // names still legible over it), instead of bare, unlabeled
      // imagery. Because of this, satellite now sits UNDER our own
      // route lines/markers automatically too (they're always added
      // afterward, at the true top) — no longer needs the extra
      // "bring the route back above it" step this used to require
      // when satellite was simply appended on top of everything.
      navSatelliteLayer.addTo(navMap, navSatelliteBeforeLayerId);
      // Minor roads hidden specifically in satellite mode — a
      // satellite view crowded with every side street is harder to
      // read than one showing just autostrade/tangenziali/statali,
      // matching what was asked for directly: secondary roads only
      // reappear when zoomed in further (the base style's own normal
      // zoom-based behavior takes back over once these are visible
      // again, e.g. when satellite is turned back off).
      navMinorRoadLayerIds.forEach(function (id) {
        if (navMap._maplibre.getLayer(id)) navMap._maplibre.setLayoutProperty(id, 'visibility', 'none');
      });
    } else {
      navMap.removeLayer(navSatelliteLayer);
      navMinorRoadLayerIds.forEach(function (id) {
        if (navMap._maplibre.getLayer(id)) navMap._maplibre.setLayoutProperty(id, 'visibility', 'visible');
      });
    }
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
    // Same defensive guard as the search-bar toggle — the panel was
    // already open before picking started in every normal case (the
    // pin button that triggers this only exists inside an open panel),
    // so the result card should already be hidden by then, but this
    // costs nothing and keeps the two mutually exclusive regardless.
    var resultElAfterPick = document.getElementById('nav-result');
    if (resultElAfterPick) resultElAfterPick.style.display = 'none';
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
      .then(function (r) { dpTrackOrsQuota(r, 'geocode'); return r.json(); })
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

  // Builds one waypoint row's HTML — shared between the origin field
  // (rendered once, alone, into the FIXED header) and the scrollable
  // stop/destination list, so both stay visually and behaviorally
  // identical without duplicating this markup twice.
  function navWaypointRowHtml(wp, displayIdx) {
    var label = navWaypointLabel(wp, displayIdx);
    var placeholder = wp.role === 'origin' ? 'Indirizzo, CAP, civico — o lascia vuoto per la posizione attuale' : 'Indirizzo, CAP o numero civico';
    // The X to remove a row shows on any real stop, AND on the
    // destination itself as long as there's at least one stop before
    // it to fall back to — this is exactly "undo Aggiungi tappa":
    // removing the just-added (still empty) destination slot un-does
    // adding it, and the stop right before it quietly becomes the
    // destination again (see removeNavWaypoint). Origin never gets a
    // remove button, and neither does the destination when it's the
    // only real point left (Partenza + Destinazione) — there always
    // has to be a destination.
    var canRemove = wp.role === 'stop' || (wp.role === 'dest' && navWaypoints.length > 2);
    var removeBtn = canRemove ? '<button type="button" class="nav-wp-remove" data-remove="' + wp.id + '">✕</button>' : '';
    // Reordering: any stop OR the destination itself can be dragged —
    // only origin (always first, rendered separately above) stays
    // fixed. A real drag handle (⠿) instead of small tap-to-move
    // arrows — matches how Google Maps itself lets you reorder stops,
    // by grabbing and dragging a row, rather than tapping tiny
    // buttons.
    var reorderBtns = wp.role !== 'origin'
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
  }

  // Wires up everything a row needs (autocomplete, clear button, drag
  // handle, remove, pin-on-map) for whichever waypoints are inside the
  // given container — shared between the origin field and the
  // scrollable stop/destination list.
  function wireNavWaypointRows(container, waypoints) {
    waypoints.forEach(function (wp) {
      wireNavAddressAutocomplete(wp.id);
      wireNavClearButton(
        document.getElementById('wpinput-' + wp.id),
        document.getElementById('wpclear-' + wp.id),
        function () { clearNavWaypointField(wp.id); }
      );
      // Scrolls the field being typed into up into clear view once the
      // on-screen keyboard opens and eats a big chunk of the visible
      // area — otherwise, a field near the bottom (or its own
      // suggestion list right underneath it) can end up hidden behind
      // the keyboard with barely anything visible above it. A short
      // delay lets the keyboard's own resize actually happen first —
      // scrolling immediately on focus would still be measuring
      // against the OLD (taller) viewport, before the keyboard shrank
      // it.
      var inputEl = document.getElementById('wpinput-' + wp.id);
      if (inputEl) {
        inputEl.addEventListener('focus', function () {
          setTimeout(function () {
            inputEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
          }, 300);
        });
      }
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

  // Origin only — rendered once into the FIXED header (#nav-origin-field),
  // never scrolls away regardless of how many tappe get added below.
  // Only needs re-rendering when the origin itself changes (a fresh
  // pick, Casa/Lavoro applied to it, etc.) — NOT on every reorder/add/
  // remove of a stop, unlike renderNavWaypointsList below.
  function renderNavOriginField() {
    var container = document.getElementById('nav-origin-field');
    if (!container) return;
    var origin = navWaypoints.filter(function (w) { return w.role === 'origin'; })[0];
    if (!origin) return;
    container.innerHTML = navWaypointRowHtml(origin, 0);
    wireNavWaypointRows(container, [origin]);
  }

  function renderNavWaypointsList() {
    var container = document.getElementById('nav-waypoints-list');
    if (!container) return;
    var stopNumber = 0;
    var rest = navWaypoints.filter(function (w) { return w.role !== 'origin'; });
    var html = rest.map(function (wp) {
      if (wp.role === 'stop') stopNumber++;
      var displayIdx = wp.role === 'dest' ? stopNumber + 1 : stopNumber;
      return navWaypointRowHtml(wp, displayIdx);
    }).join('');
    container.innerHTML = html;
    wireNavWaypointRows(container, rest);
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
      // REAL BUG, found and confirmed directly ("cand adaug adresa sau
      // coordinatele... nu raman salvate, raman doar cele alese din
      // cele propuse"): pickedHome/pickedWork are ONLY ever set by
      // actually selecting an autocomplete suggestion — typing a full
      // address and clicking Save without picking anything left
      // pickedHome/pickedWork completely untouched (still whatever
      // they were before, often null), silently discarding whatever
      // was typed. Fixed properly below: text that wasn't picked from
      // a suggestion is now resolved before saving — either parsed
      // directly as coordinates, or geocoded — instead of being
      // dropped.
      var saveBtn = this;
      saveBtn.disabled = true;
      var originalLabel = saveBtn.textContent;
      saveBtn.textContent = 'Salvataggio...';

      // Requested directly, second part: typing raw coordinates
      // (e.g. "45.1234, 9.5678", copied straight from Google Maps)
      // into the SAME field should work too, not just a normal
      // address — coordinates are always exact, an address can
      // sometimes fail to geocode.
      // Requested directly, with the real, exact copied text as proof
      // ("(45.3848713, 11.9604032) iata un exemplu de coordinate pe
      // care le copii direct din google"): Google Maps' own copy
      // format wraps the pair in parentheses — the earlier version of
      // this pattern required the string to START/END with the number
      // itself, so real Google Maps coordinates never matched at all
      // and fell through to the geocoding path instead of being
      // applied directly. Parentheses are now optional on both sides.
      var COORD_RE = /^\s*\(?\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*\)?\s*$/;

      function resolveField(input, picked) {
        var typed = input.value.trim();
        if (!typed) return Promise.resolve(null);
        if (picked && picked.text === typed) return Promise.resolve(picked); // unchanged since it was picked — use as-is, no need to re-resolve
        var coordMatch = typed.match(COORD_RE);
        if (coordMatch) {
          var lat = parseFloat(coordMatch[1]), lon = parseFloat(coordMatch[2]);
          return Promise.resolve({ text: typed, lat: lat, lon: lon });
        }
        // Free-typed address, never picked from the suggestion list —
        // geocode it now rather than discarding it. Same geocoder
        // (and same precise-address-layer preference) already used
        // for regular delivery clients, for consistent results.
        return geocodeAddress(typed).then(function (result) {
          if (!result) return null; // genuinely not found — treated as cleared, rather than silently keeping a stale prior value
          return { text: typed, lat: result.lat, lon: result.lon };
        });
      }

      Promise.all([
        resolveField(homeInput, pickedHome),
        resolveField(workInput, pickedWork)
      ]).then(function (results) {
        var resolvedHome = results[0], resolvedWork = results[1];
        saveNavHomeWork({ home: resolvedHome, work: resolvedWork });
        renderNavShortcuts(); // no-ops harmlessly now (its own DOM row no longer exists) — kept in case anything else still calls it
        if (currentScreen === 'navigatore') renderDeliveryPlanner(); // refreshes the Casa/Deposito buttons on THIS screen, which renderNavShortcuts no longer reaches
        document.getElementById('modal-nav-homework').classList.remove('open');
        var anyTypedButNotFound = (homeInput.value.trim() && !resolvedHome) || (workInput.value.trim() && !resolvedWork);
        toast(anyTypedButNotFound ? '⚠ Indirizzo non trovato per uno dei due campi' : '✓ Indirizzi salvati');
      }).finally(function () {
        saveBtn.disabled = false;
        saveBtn.textContent = originalLabel;
      });
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
    // Scrolls the freshly-added (still empty) tappa into view WITHIN
    // the scroll area itself — not the whole page/panel jumping, just
    // this one list gently scrolling down to reveal the new row, same
    // idea as Google Maps' own "add stop" behavior. Deferred one frame
    // so the just-rendered row actually exists in the DOM to scroll to.
    requestAnimationFrame(function () {
      var newRow = document.querySelector('[data-wp-row="' + newId + '"]');
      if (newRow) newRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
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
        // Swaps with any other stop OR the destination itself now —
        // only origin (rendered in its own separate, fixed field, never
        // even reaches this list) stays untouched by dragging.
        if (!overWp || overWp.role === 'origin') return;
        var fromIdx = navWaypoints.findIndex(function (w) { return w.id === waypointId; });
        var toIdx = navWaypoints.findIndex(function (w) { return w.id === overId; });
        if (fromIdx === -1 || toIdx === -1) return;
        var moved = navWaypoints.splice(fromIdx, 1)[0];
        navWaypoints.splice(toIdx, 0, moved);
        // Whichever item is now LAST becomes the destination, and every
        // other non-origin item becomes a plain stop — dragging the
        // destination itself into an earlier position, or dragging a
        // stop all the way to the end, both need this to keep exactly
        // one "dest" and have it always be the final point, same rule
        // used everywhere else a waypoint's position can change
        // (removeNavWaypoint, addNavWaypointBeforeDest).
        navWaypoints.forEach(function (w, i) {
          if (w.role === 'origin') return;
          w.role = (i === navWaypoints.length - 1) ? 'dest' : 'stop';
        });
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
        // marker's correct number AND pin style (numbered circle vs.
        // the destination's red pin) from the CURRENT navWaypoints
        // order, without recentring the map or opening a popup for
        // each one — just the icon itself, so this stays smooth
        // mid-drag.
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
  // fetch() itself has NO built-in timeout — a hung/stalled request
  // (poor connectivity, a server that accepts the connection but never
  // responds) just leaves the returned promise pending forever. This
  // is what was actually happening — confirmed by ION's screenshot,
  // stuck indefinitely on "Verifica in corso..." rather than either
  // succeeding or showing a real failure message. AbortController is
  // the standard way to give any fetch() a hard ceiling.
  // REAL BUG, found on second look: AbortController-based timeout can
  // throw synchronously, immediately, in some PWA/WKWebView contexts
  // where it's not fully available the same way it is in regular
  // Safari — an uncaught exception right at the top of this function,
  // OUTSIDE any promise chain, would silently kill everything with no
  // success and no failure message at all. That matches exactly what
  // was reported the second time: no "not found" message ever
  // appeared, not even after waiting. Rewritten with Promise.race
  // instead — doesn't depend on AbortController existing at all, just
  // plain Promises and setTimeout, universally available anywhere
  // fetch() itself already works. Doesn't cancel the underlying
  // network request (a real, accepted trade-off — the response is
  // just ignored once the race is lost), but that's a fine trade for
  // something this much safer.
  function fetchWithTimeout(url, opts, timeoutMs) {
    var ms = timeoutMs || 10000;
    var timeoutPromise = new Promise(function (resolve, reject) {
      setTimeout(function () { reject(new Error('timeout')); }, ms);
    });
    return Promise.race([fetch(url, opts), timeoutPromise]);
  }

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
  // Requested directly, following two real, confirmed cases: an
  // address failing to geocode not because of a typo or a missing
  // street in OpenStreetMap, but because the CITY name typed (from
  // Google Maps, which often shows the local "frazione" — a
  // sub-locality — rather than the actual comune/municipality it
  // officially belongs to) doesn't match what OpenStreetMap has on
  // record for that street. Real confirmed example: "Bidasio" is a
  // frazione of "Nervesa della Battaglia" — Google Maps shows
  // "Bidasio", but the street is only findable searching for the
  // actual comune name. Rather than needing a lookup table mapping
  // every Italian frazione to its comune (a huge, ongoing
  // maintenance burden), this drops the locality word entirely,
  // keeping just the postal code + province — the postal code alone
  // is specific enough to correctly place the search, regardless of
  // which local name was used for the town in between.
  function dpStripLocalityKeepingPostalCode(text) {
    var m = text.match(/^(.*?\d{5})\s+\S+\s+([A-Z]{2})\s*$/);
    if (!m) return null;
    return m[1] + ' ' + m[2];
  }

  function navGeocodeFetch(endpoint, text) {
    var attempts = [{}, { noLayers: true }];
    var strippedText = dpStripLocalityKeepingPostalCode(text);
    if (strippedText && strippedText !== text) attempts.push({ overrideText: strippedText });
    if (navSearchFocusPoint) attempts.push({ venueOnly: true }); // last resort: business-name-only, still softly biased nearby

    function tryNext(i) {
      if (i >= attempts.length) return Promise.resolve({ features: [] });
      var opts = attempts[i];
      return fetchWithTimeout(navGeocodeUrl(endpoint, opts.overrideText || text, opts), null, 6000)
        .then(function (r) { dpTrackOrsQuota(r, 'geocode'); return r.json(); })
        .then(function (data) {
          if (data.features && data.features.length) return data;
          return tryNext(i + 1);
        })
        .catch(function () { return tryNext(i + 1); }); // this attempt failed outright (offline, timeout, etc.) — still worth trying the next, less strict one
    }
    return tryNext(0);
  }

  function geocodeAddress(text) {
    if (!text || !text.trim()) return Promise.resolve(null);
    return navGeocodeFetch('search', text)
      .then(function (data) {
        if (!data.features || !data.features.length) return null;
        // REAL BUG, confirmed with ION directly: a full street address
        // typed in ("Via Dell'Artigianato, 21, 35010 Loreggia PD")
        // came back saved as just "Loreggia, PD, Italia" — the CITY,
        // with the street, civic number, and postal code all silently
        // lost. This used to take features[0] unconditionally — if
        // Pelias's own top-ranked result is a degraded, city-only
        // fallback (a real, known coverage gap for smaller streets in
        // Italy), that got accepted as-is with no check on how
        // precise it actually was.
        //
        // Pelias's own results carry a "layer" property identifying
        // what KIND of match each one is (address/street/venue vs.
        // locality/region/country). Now searches ALL returned results
        // (up to 8) for the first one that's actually precise enough
        // — not just the top-ranked one — since a lower-ranked result
        // can genuinely be the better geographic match even when
        // Pelias's own text-relevance score preferred a vaguer one.
        // Only truly gives up (returns null, triggering the honest
        // "indirizzo non trovato" + manual-save fallback already in
        // place) if NONE of the results are address/street/venue
        // level.
        var PRECISE_LAYERS = { address: true, street: true, venue: true };
        var f = data.features.find(function (feat) { return !feat.properties.layer || PRECISE_LAYERS[feat.properties.layer]; });
        if (!f) return null;
        var coords = f.geometry.coordinates; // [lon, lat]
        var p = f.properties || {};
        // Structured fields, additive — Pelias (the geocoder behind
        // ORS's free-tier search) already returns these broken out,
        // previously discarded in favor of just the flat label. Kept
        // separate now per the explicit requirement to store CAP/
        // città/provincia as their own fields, not just folded into
        // one address string.
        // HONEST UNCERTAINTY: Pelias's exact property naming for the
        // Italian "provincia" specifically (as opposed to "regione")
        // isn't something I can verify without a live response to
        // inspect — no network access to openrouteservice.org from
        // this environment. Tried the most plausible candidates
        // (county, then region_a) with a fallback chain rather than
        // asserting one name confidently; if the saved provincia
        // field comes out empty or wrong in practice, that's the
        // first place to check against a real response.
        return {
          lon: coords[0], lat: coords[1], label: p.label,
          cap: p.postalcode || '', citta: p.locality || '', provincia: p.county || p.region_a || ''
        };
      });
  }

  function currentPosition(geoOpts) {
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
        // most likely why "la mia posizione" felt broken. A caller can
        // still override any of these (e.g. a soft background bias
        // fetch that doesn't need pinpoint accuracy and is fine with
        // an older cached fix) via geoOpts.
        Object.assign({ enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }, geoOpts || {})
      );
    });
  }

  // Independent, JS-level safety net around currentPosition() — added
  // specifically because there's a documented, longstanding iOS bug
  // where getCurrentPosition() inside an installed (standalone)
  // PWA can fail to ever call EITHER callback at all: no success, no
  // error, indefinitely — the browser's own `timeout` option above is
  // supposed to guarantee an error callback, but on the affected iOS
  // versions the permission prompt itself gets misdirected/lost, so
  // even that safeguard doesn't reliably fire. This wraps the call in
  // a plain race against an independent timer that this code fully
  // controls, so a driver on an affected iPhone gets a clean,
  // predictable failure (falling through to whatever fallback the
  // caller has) instead of auto-riordina silently hanging forever.
  // On Android and on iPhone via Safari — where this bug doesn't
  // apply — the real GPS position simply wins the race normally,
  // well under this ceiling.
  function currentPositionSafe(timeoutMs, geoOpts) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error('currentPositionSafe: timed out waiting for a GPS fix'));
      }, timeoutMs || 16000);
      currentPosition(geoOpts).then(function (pos) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(pos);
      }).catch(function (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
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
        // Guards against a real race condition: this whole callback is
        // async (waiting on a real GPS fix), and if the driver presses
        // Avvia quickly — before it resolves — active navigation can
        // already be running by the time this finally fires. The brief
        // confirmation dot would then get created DURING active
        // navigation, with nothing left to clean it up (the "remove
        // navLocateMarker" step in startActiveNavigation already ran
        // and found nothing yet, since this hadn't created it yet) —
        // it would just sit there for its own 4s timer, showing
        // alongside the real position arrow, at a single frozen GPS
        // reading rather than the arrow's continuously updated one
        // (confirmed exactly this in real testing — both visible
        // together, the frozen dot looking more "stable" simply
        // because it wasn't moving at all). Skipping entirely once
        // navigation has already started — the real arrow is already
        // doing this job by then, a second confirmation is meaningless.
        if (navMap && !window.__navActiveNavigationRunning) {
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
    // REAL BUG, found directly from ION's own device: modern iOS
    // Safari can report a desktop-style, "Macintosh"-containing user
    // agent (confirmed via a temporary on-screen diagnostic — his
    // showed no "iPhone"/"iPad" substring at all), so this regex-based
    // check silently failed, misidentifying a real iPhone as some
    // other platform. `navigator.standalone` is far more reliable for
    // this specific question — it's a real, defined property (true or
    // false) on any iOS Safari context, and simply doesn't exist
    // anywhere else (Android, desktop Chrome, desktop Safari on an
    // actual Mac) — so its mere PRESENCE, regardless of value, is
    // itself the iOS signal, unaffected by whatever the UA string
    // claims.
    var isIOS = typeof navigator.standalone !== 'undefined';
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
    // REAL BUG, confirmed: this always queried ORS's driving-hgv
    // (truck) profile, for EVERY vehicle type, even a plain car with
    // no height/width/weight restrictions actually set. ORS's HGV
    // profile assumes meaningfully slower baseline speeds than its
    // car profile — a real, separate thing from the specific
    // restrictions object below, which only affects which ROADS are
    // usable, not how fast the profile assumes travel is on the roads
    // that remain. Confirmed directly: same exact road, same distance
    // (11.7-12km either way), but 19 min here vs Google's 12 min for
    // the identical path — a real ~35% speed underestimate, not a
    // routing/road-choice difference. driving-car for 'auto', the
    // truck-specific profile only for the actual commercial vehicle
    // types this app is otherwise built for.
    var orsProfile = v.tipo === 'auto' ? 'driving-car' : 'driving-hgv';
    var restrictions = {
      height: Number(v.altezza) || undefined,
      width: Number(v.larghezza) || undefined,
      length: Number(v.lunghezza) || undefined,
      weight: Number(v.massa) || undefined
    };
    if (v.massaAssi) restrictions.axleload = Number(v.massaAssi);
    var body = {
      coordinates: [[origin.lon, origin.lat], [dest.lon, dest.lat]],
      // "recommended" (not "fastest") — confirmed directly by an ORS
      // team member (ask.openrouteservice.org, "Recommended routing
      // not taking direct route", Nov 2020): "The recommended route is
      // based on a heuristic which prioritizes main roads and
      // highways." This is exactly the lever for avoiding small local
      // streets at the start/end of a trip when a tangenziale/statale
      // gets there just as fast or nearly so — "fastest" purely
      // minimizes computed time with no such preference, which is
      // genuinely why it was picking minor roads even when a main road
      // was right there and barely slower (confirmed real-world:
      // ION's own trip started on small streets before reaching the
      // highway, when a tangenziale entry was available). The earlier
      // comment here claimed the opposite relationship — that was
      // simply wrong; this is now verified against ORS's own team,
      // not assumed.
      preference: 'recommended',
      language: 'it',
      options: { profile_params: { restrictions: restrictions } }
    };
    // The restrictions object is only meaningful for driving-hgv —
    // ORS's driving-car profile doesn't accept vehicle dimension
    // restrictions at all (there's nothing to restrict a car's access
    // by), so it's omitted entirely for that profile rather than sent
    // as a set of undefined-valued fields it wouldn't understand.
    if (orsProfile === 'driving-car') delete body.options;
    // Alternatives only requested for a short (single-segment) trip —
    // combining them with the multi-leg chain for long trips would
    // multiply requests and complicate stitching, for little real
    // benefit over a long haul. target_count: 3 is ORS's own documented
    // maximum on the free tier (openrouteservice.org/restrictions) —
    // asking for more would simply be rejected.
    if (requestAlternatives) {
      body.alternative_routes = { target_count: 3, weight_factor: 1.6, share_factor: 0.6 };
    }
    return fetch('https://api.openrouteservice.org/v2/directions/' + orsProfile + '/geojson', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': ORS_API_KEY },
      body: JSON.stringify(body)
    }).then(function (r) {
      dpTrackOrsQuota(r, 'directions');
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
  // Two layers per route line now — a wider, darker "casing" UNDER a
  // narrower, brighter fill on top — instead of one flat-colored line.
  // This is what actually gives Google Maps' own route line its
  // familiar "tube with a border" look; a single flat color (what this
  // used to be) reads as visibly thinner and flatter by comparison,
  // even at the same pixel width. Returns a featureGroup of the two
  // layers together, acting as one cohesive route line for every
  // existing caller (.addTo(), .remove(), .getBounds() all still work
  // the same as a single-layer return used to).
  function drawColorCodedRoute(feature, lighter) {
    var group = L.featureGroup();
    if (lighter) {
      L.geoJSON(feature, { style: { color: '#5B8DD6', weight: 10, opacity: 0.6, lineCap: 'round', lineJoin: 'round' } }).addTo(group);
      L.geoJSON(feature, { style: { color: '#8FB3E8', weight: 7, opacity: 0.75, lineCap: 'round', lineJoin: 'round' } }).addTo(group);
    } else {
      // ADJUSTED with a precise visual reference from ION (an actual
      // screenshot of Google's own active-navigation route line, not
      // a verbal description this time) — the previous attempt here
      // (navy #0B3D91/#1557B0) overshot how dark "darker" meant;
      // Google's real turn-by-turn blue reads as a moderately
      // saturated, medium-bright blue, not true navy. Matched much
      // closer to that reference now, keeping the earlier thickness
      // increase (that part was correct — the color was the miss).
      // Thickened again — reported still too thin even after the
      // previous increase (13/8) while actually driving. Bumped up
      // more substantially this time (18/12) rather than another
      // small step, given this is the second report of the same
      // issue.
      L.geoJSON(feature, { style: { color: '#1A56DB', weight: 18, lineCap: 'round', lineJoin: 'round' } }).addTo(group);
      L.geoJSON(feature, { style: { color: '#3B7DEE', weight: 12, lineCap: 'round', lineJoin: 'round' } }).addTo(group);
    }
    return group;
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
  // turn-by-turn segments into the simple
  // {instruction, type, lat, lon, distance, duration} list the
  // instruction banner reads from. distance/duration (ORS provides
  // both per step) are what make a genuinely LIVE eta/remaining-distance
  // possible — see updateActiveInstructionBanner.
  function buildNavActiveSteps(feature) {
    var coords = feature.geometry.coordinates; // [lon, lat] pairs along the whole route
    var segments = feature.properties.segments || [];
    var steps = [];
    segments.forEach(function (seg) {
      (seg.steps || []).forEach(function (step) {
        var wp = step.way_points[0];
        var c = coords[wp];
        if (c) steps.push({ instruction: step.instruction, type: step.type, lat: c[1], lon: c[0], distance: step.distance || 0, duration: step.duration || 0 });
      });
    });
    return steps;
  }

  function startActiveNavigation(feature, legs, points) {
    // Tells the early version-check (top of this file) not to
    // auto-reload while a driver is actively mid-navigation — see the
    // comment there for why.
    window.__navActiveNavigationRunning = true;
    navFinalArrivalShown = false;
    // The "la mia posizione" button's own marker (a plain dot) was
    // never being removed here — if it had been tapped while still
    // planning the trip, it just stayed on the map, showing alongside
    // the NEW navigation arrow once active navigation actually starts,
    // looking like two separate position indicators instead of one.
    if (navLocateMarker) { navMap.removeLayer(navLocateMarker); navLocateMarker = null; }
    // The origin marker (where the trip started) is useful while still
    // planning — seeing "you're going from here" alongside the stops
    // and destination — but once actively navigating, Google Maps
    // itself doesn't keep a distinct "you started here" marker visible
    // at all; only the live position (the arrow) and the route ahead
    // matter once you're already moving. Removed here specifically —
    // stop/destination markers stay, since seeing "tappa 2 is right
    // there" IS still meaningful mid-trip, unlike the origin.
    var originWp = navWaypoints.filter(function (w) { return w.role === 'origin'; })[0];
    if (originWp && navWaypointMarkers[originWp.id]) {
      navMap.removeLayer(navWaypointMarkers[originWp.id]);
      delete navWaypointMarkers[originWp.id];
    }

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
    // The 3D driving tilt — a genuine angled camera, not a flat
    // top-down view, matching Google Maps' own look while actively
    // navigating. Only during active navigation; the trip-planning map
    // stays flat (pitch 0), same as Google Maps itself only tilts once
    // you actually start driving, not while still picking a route.
    if (navMap) navMap.setPitch(55);
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
      if (navMap) navMap.setView([p.lat, p.lon], 18.5, { animate: true });
    }).catch(function () { /* watchPosition below will catch up with a real fix shortly */ });

    // Starts the continuous per-frame smoothing loop for the marker +
    // camera — see navSmoothCameraFrame above for why this is what
    // actually makes movement feel fluid, not just periodic eased
    // jumps on each GPS tick.
    navStartSmoothCamera();

    updateActiveInstructionBanner();

    // Auto-follow starts on — the map re-centers on the driver as they
    // move. Dragging the map manually (checking to the side, looking
    // ahead at an upcoming junction) turns it off, same as Google Maps
    // — a "recenter" button then appears to turn it back on.
    navFollowingUser = true;
    document.getElementById('nav-recenter-btn').style.display = 'none';
    // 'dragstart' alone isn't fired the instant a finger touches the
    // map — MapLibre waits until the movement clearly reads as a real
    // pan (past a small pixel threshold) before deciding that's what's
    // happening, not a tap. During that short window, the continuous
    // ~60fps camera-follow loop (navSmoothCameraFrame) was STILL
    // actively calling jumpTo() every frame, since navFollowingUser
    // hadn't flipped to false yet — meaning the very touch/drag a
    // driver started was being fought and reset by the loop itself,
    // several times a second, making the whole map feel completely
    // frozen no matter how hard they dragged. This was a real,
    // confirmed regression from the smooth-camera work — genuinely
    // dangerous if a driver can't manually look around the map while
    // actively navigating. touchstart/mousedown fire IMMEDIATELY on
    // contact, before any drag-vs-tap determination — but only PAUSE
    // the camera loop now, they don't disable following outright. Only
    // dragstart (a real, sustained pointer move MapLibre itself
    // confirmed) actually turns auto-follow off. touchend/mouseup
    // resume the paused loop if dragstart never fired — see the three
    // handlers themselves for the full reasoning.
    navMap.on('touchstart', navOnTouchStartPauseCamera);
    navMap.on('mousedown', navOnTouchStartPauseCamera);
    navMap.on('dragstart', navOnDragStartDisableFollow);
    navMap.on('touchend', navOnTouchEndResumeCamera);
    navMap.on('mouseup', navOnTouchEndResumeCamera);

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
  // Now genuinely native (MapLibre's own setBearing/setPitch), not a
  // hack — the map itself rotates to match the direction of travel
  // (heading always points "up" on screen), same as Google Maps. This
  // is exactly what three earlier attempts (two CSS transforms, then
  // the leaflet-rotate plugin) tried and failed at on flat raster
  // tiles; MapLibre supports this as a first-class, core map property,
  // which is the entire reason for this migration. The position marker
  // no longer needs its own rotation — it stays visually "facing up"
  // on screen by default, which is now correct since the MAP is what
  // turns underneath it.
  var navLastHeading = 0;
  // Only called once now, at the very start of active navigation
  // (setting bearing to 0 before the first real fix arrives) — the
  // continuous per-frame smoothing loop (navSmoothCameraFrame) owns
  // bearing updates for the rest of the trip.
  function rotateNavMapToHeading(heading) {
    if (heading != null && !isNaN(heading)) navLastHeading = heading;
    if (navMap) navMap.setBearing(navLastHeading);
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
  // Small hysteresis gap between the two snap thresholds (20m to snap
  // ON, 26m to snap back OFF) — without it, hovering right around a
  // single 20m line let the display position visibly flip back and
  // forth between the snapped (on-road) and raw GPS point on
  // consecutive ticks whenever ordinary GPS noise crossed that exact
  // boundary, reading as a small camera jolt each time it flipped.
  // Once snapped, staying snapped until CLEARLY off (26m) — and once
  // off, staying off until CLEARLY back close (20m) — means ordinary
  // noise near the boundary can't flip it every tick.
  var navWasSnapped = false;
  // Split into three separate handlers now — a single touch/tap that
  // never turns into an actual drag was disabling auto-follow
  // entirely (confirmed in real driving: the phone mount vibrating, a
  // stray finger graze, anything touching the screen at all turned
  // camera-follow off, sending the arrow drifting off-screen while
  // driving — a real safety concern, not just an annoyance). The
  // touchstart/mousedown handlers were added specifically to stop the
  // ~60fps camera loop from fighting the very START of a genuine drag
  // gesture (a real, separate bug, fixed correctly at the time) — but
  // "stop fighting a possible drag" and "the driver deliberately
  // wants manual control now" are two different things, and treating
  // every touch as the second one was too aggressive.
  //
  // Now: touchstart/mousedown only PAUSES the camera loop's own jumpTo
  // (navSmooth.paused) — following stays logically ON, so if the
  // touch never becomes a real drag, nothing about the driving
  // experience changes at all. Only dragstart — which only fires once
  // MapLibre itself has confirmed real, sustained pointer movement —
  // actually turns auto-follow off and shows the recenter button.
  function navOnTouchStartPauseCamera() {
    navSmooth.paused = true;
  }
  var navAutoRecenterTimer = null;
  function navOnDragStartDisableFollow() {
    if (navFollowingUser) {
      navFollowingUser = false;
      document.getElementById('nav-recenter-btn').style.display = 'flex';
    }
    // Auto-resumes on its own after a few seconds of no further
    // dragging — a driver glancing sideways at the map for a moment
    // shouldn't have to remember to tap "recenter" afterward, and
    // real road vibration jostling a dashboard-mounted phone can
    // register as small drag gestures on its own, with no deliberate
    // touch at all — those shouldn't leave the camera permanently
    // stuck off-target either. Each new dragstart re-arms this same
    // timer, so genuinely continuous dragging keeps pushing the
    // countdown out rather than snapping back mid-interaction.
    clearTimeout(navAutoRecenterTimer);
    navAutoRecenterTimer = setTimeout(function () { navRecenterOnDriver(false); }, 5000);
  }
  function navOnTouchEndResumeCamera() {
    navSmooth.paused = false; // harmless even if navFollowingUser is already false by now (dragstart fired) — the loop's own "if (navFollowingUser && ...)" gate still won't move the camera either way
  }

  // Snaps the camera back onto the driver's live position and turns
  // auto-follow back on — shared by the recenter button's own tap
  // handler and the auto-resume timer above, so both do exactly the
  // same thing.
  // instant (default true): the manual recenter BUTTON wants immediate
  // visual feedback the moment it's tapped — no reason to ease into
  // it when the driver explicitly just asked for it right now. The
  // auto-resume timer (after a drag/vibration goes quiet) calls this
  // with instant=false instead — snapping the camera back with no
  // warning after 5 quiet seconds would read as its own small jolt;
  // easing into it via the same continuous smoothing loop that
  // already drives normal camera movement feels like the camera
  // gently finding the driver again, not jumping to them.
  function navRecenterOnDriver(instant) {
    if (instant == null) instant = true;
    navFollowingUser = true;
    var btn = document.getElementById('nav-recenter-btn');
    if (btn) btn.style.display = 'none';
    if (navLastPosition && navMap) {
      if (instant) {
        navMap.setView([navLastPosition.lat, navLastPosition.lon], 18.5, { animate: false });
        navSmooth.lat = navLastPosition.lat;
        navSmooth.lon = navLastPosition.lon;
      }
      navSmooth.fixLat = navLastPosition.lat;
      navSmooth.fixLon = navLastPosition.lon;
      navSmooth.fixTimestamp = performance.now();
    }
    currentPosition().then(function (p) {
      navLastPosition = { lat: p.lat, lon: p.lon };
      if (navFollowingUser && navMap) {
        if (instant) {
          navMap.setView([p.lat, p.lon], 18.5, { animate: false });
          navSmooth.lat = p.lat;
          navSmooth.lon = p.lon;
        }
        navSmooth.fixLat = p.lat;
        navSmooth.fixLon = p.lon;
        navSmooth.fixTimestamp = performance.now();
      }
    }).catch(function () { /* the instant jump above already used the best position available — nothing more to do if a fresh read fails */ });
  }

  // The active-navigation position marker — a simple directional arrow
  // (provided directly, replacing the earlier top-down vehicle
  // silhouettes) rather than a shape trying to look like the
  // configured vehicle from above. Same classic "chevron" language
  // Google Maps itself uses as its own simpler position indicator.
  // Deliberately NO SVG <filter>/<feDropShadow> here anymore — Safari
  // (especially iOS) has real, documented history of SVG filter
  // primitives failing to render at all in some contexts, which would
  // make the ENTIRE filtered element (the whole arrow, per SVG's own
  // spec for unresolved filter references) disappear rather than just
  // losing its shadow — consistent with what was actually reported: no
  // arrow shape at all, just... something else showing in its place.
  // A plain CSS box-shadow on the marker's own wrapping element (set in
  // index.html) achieves the same visual drop-shadow without touching
  // SVG filters at all, universally supported.
  function navPositionMarkerSvg() {
    return '<svg viewBox="0 0 128 128" width="46" height="46">' +
      '<path d="M64 12 L102 108 L64 88 L26 108 Z" fill="#0B4DFF" stroke="#FFFFFF" stroke-width="5" stroke-linejoin="round"/>' +
      '</svg>';
  }

  var navFinalArrivalShown = false;
  function onActiveNavPosition(position) {
    var lat = position.coords.latitude, lon = position.coords.longitude;
    var heading = position.coords.heading;
    navLastPosition = { lat: lat, lon: lon };

    // REAL GAP, confirmed missing entirely: there was no explicit
    // "you've reached the final destination" check anywhere at all —
    // just an assumption that it "already has its own arrival
    // instruction" (see the old comment near navArrivalPromptShown,
    // which only ever covered INTERMEDIATE stops). Once actually past
    // the destination with nothing stopping navigation, any further
    // movement reads as off-route relative to a route that ends
    // there — triggering the normal reroute logic to try to route
    // back TO the destination, over and over, exactly what was
    // reported ("trece si cauta o alta strada pentru a te intoarce
    // inapoi la destinatie"). Checked first, before any reroute logic
    // below even runs, so arrival is always recognized before it can
    // be mistaken for going off-route.
    if (navLegPoints && navLegPoints.length && !navFinalArrivalShown) {
      var finalDest = navLegPoints[navLegPoints.length - 1];
      if (finalDest && finalDest.lat != null) {
        var distToFinal = haversineKm({ lat: lat, lon: lon }, { lat: finalDest.lat, lon: finalDest.lon }) * 1000;
        if (distToFinal < 40) {
          navFinalArrivalShown = true;
          showNavFinalArrivalPrompt();
          return; // nothing else this tick — no point evaluating reroute/off-route logic against a route that's already been completed
        }
      }
    }

    // Off-route detection — was completely missing before: if the
    // driver missed a turn or otherwise left the calculated street,
    // the app just kept showing the original route and instructions
    // regardless, with no way back to a correct route short of
    // stopping and recalculating by hand.
    //
    // Computed here UNCONDITIONALLY (not just when checking whether to
    // reroute) because the same distance/nearest-point result is also
    // what map matching (below) needs — no point computing it twice.
    var deviation = (navLegs && navLegs[navCurrentLegIndex])
      ? routeDeviation(navLegs[navCurrentLegIndex].geometry.coordinates, lat, lon)
      : null;

    // Two ways to trigger a reroute, matching the two real-world cases:
    // 1) SUSTAINED distance — off the line by more than 30m for 2
    //    consecutive fixes (was 3 — tightened after real driving
    //    showed this path taking too long to confirm a genuine missed
    //    turn; 2 consecutive readings over a real threshold is still
    //    enough to reject a single noisy GPS blip, just faster to
    //    react to a real deviation).
    // 2) FAST heading-based trigger — off the line by more than 20m
    //    AND heading a clearly different direction than the route
    //    itself goes there (>55°, was 70° — loosened for the same
    //    reason: right after missing a turn, the heading mismatch
    //    often isn't dramatic yet, since you're still pointed roughly
    //    the way the road WAS going just before the missed turn; a
    //    lower threshold catches real wrong turns sooner, before
    //    falling back to the slower sustained-distance path) AND
    //    actually moving at a meaningful speed (>10 km/h, so this
    //    never fires while stopped or crawling, where heading is
    //    unreliable anyway). This one doesn't wait for consecutive
    //    fixes at all — heading mismatch this large while genuinely
    //    moving is already a strong, fast signal of a real wrong
    //    turn, not GPS noise.
    //
    // Cooldown: even once triggered, won't fire again within 15s (was
    // 30s — halved for the same "make it react faster" reasoning,
    // while still leaving enough of a gap that recalculating
    // repeatedly in a tight loop, e.g. while a fresh route is still
    // catching up to a slightly-still-off position right after a
    // reroute, doesn't happen) of the last reroute.
    var REROUTE_COOLDOWN_MS = 15000;
    if (deviation && !navRerouting &&
        (!navLastRerouteTime || Date.now() - navLastRerouteTime > REROUTE_COOLDOWN_MS)) {
      var speedKmh = (position.coords.speed != null && !isNaN(position.coords.speed)) ? position.coords.speed * 3.6 : 0;
      var headingMismatch = (heading != null && !isNaN(heading) && deviation.routeBearing != null)
        ? angleDifference(heading, deviation.routeBearing) : 0;
      var fastTrigger = deviation.distance > 20 && headingMismatch > 55 && speedKmh > 10;
      if (fastTrigger) {
        navOffRouteCount = 0;
        rerouteFromCurrentPosition(lat, lon);
      } else if (deviation.distance > 30) {
        navOffRouteCount++;
        if (navOffRouteCount >= 2) {
          navOffRouteCount = 0;
          rerouteFromCurrentPosition(lat, lon);
        }
      } else {
        navOffRouteCount = 0;
      }
    }

    // Map matching — the position shown on screen (marker + camera) is
    // snapped to the nearest point ON THE ROUTE ITSELF, rather than
    // raw GPS, whenever there's real confidence it belongs there
    // (within 20m of the route). Ordinary phone GPS drifts a few
    // meters side to side even standing still, which without this
    // makes the vehicle icon visibly wobble next to the road instead
    // of sitting on it — exactly what Google/Waze avoid by always
    // snapping to the road network. Every DECISION in this function
    // (off-route detection above, arrival checks and step-advancement
    // below) deliberately keeps using the RAW position, never this
    // snapped one — snapping is a display-only correction; feeding a
    // snapped position back into off-route detection would be
    // circular (a snapped point is always "on" the route by
    // definition) and would mask a real deviation instead of catching
    // it. If genuinely off-route (or before any route/leg exists yet),
    // this just falls back to the raw position, unchanged.
    var displayLat = lat, displayLon = lon;
    var snapThreshold = navWasSnapped ? 26 : 20; // hysteresis — see navWasSnapped's own comment above for why two different thresholds
    if (deviation && deviation.distance < snapThreshold && deviation.nearestLat != null) {
      displayLat = deviation.nearestLat;
      displayLon = deviation.nearestLon;
      navWasSnapped = true;
    } else {
      navWasSnapped = false;
    }

    // Trims the already-driven part of the CURRENT leg off the map on
    // every real position update — not just when a full stop is
    // reached. Needs navLegs to exist yet (it's set at the very start
    // of startActiveNavigation, so this is safe from the first fix
    // onward). Uses the raw position — trimming is measured against
    // the true GPS point, same reasoning as off-route detection.
    // Tries the cheap path first (update the current leg's geometry in
    // place) — only falls back to a full rebuild of every leg layer if
    // there's no persistent layer yet to update (the very first tick
    // after starting navigation or a reroute).
    if (navLegs && !updateCurrentLegTrim(lat, lon)) drawActiveNavLegs(lat, lon);

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

    // Marker + camera no longer moved directly here — instead, this
    // feeds the dead-reckoning baseline (navSmooth.fixLat/fixLon/
    // fixHeading/fixSpeedMps/fixTimestamp) that the continuous
    // smoothing loop (navSmoothCameraFrame) extrapolates FROM, every
    // single animation frame, rather than just interpolating toward a
    // static target that goes stale between real GPS fixes. Uses
    // displayLat/displayLon (map-matched when confidently on the
    // route, raw GPS otherwise) — not the raw lat/lon — so the icon
    // and camera track the road instead of wobbling with raw GPS
    // noise.
    navSmooth.fixLat = displayLat;
    navSmooth.fixLon = displayLon;
    navSmooth.fixTimestamp = performance.now();
    if (heading != null && !isNaN(heading)) navSmooth.fixHeading = heading;
    // A real, valid speed reading is IDEAL for the extrapolation above
    // to work — but position.coords.speed is genuinely unreliable on
    // many Android devices/GPS chips specifically, frequently coming
    // back null even while the vehicle is clearly moving (confirmed:
    // this was very likely THE actual reason dead-reckoning didn't
    // visibly fix anything when tested — falling back to 0 whenever
    // the device didn't report a speed silently disabled the whole
    // feature for exactly those ticks, reproducing the original
    // "frozen until the next real fix" pattern despite the new code
    // being genuinely in place and running). Computed as a fallback
    // now from the distance and time between the last TWO real fixes
    // — a real, independent velocity estimate that doesn't depend on
    // the device's own speed field being populated at all.
    var reportedSpeed = (position.coords.speed != null && !isNaN(position.coords.speed) && position.coords.speed > 0) ? position.coords.speed : null;
    var fallbackSpeed = 0;
    if (navSmooth.prevFixLat != null && navSmooth.fixTimestamp) {
      var elapsedSincePrev = (navSmooth.fixTimestamp - navSmooth.prevFixTimestamp) / 1000;
      if (elapsedSincePrev > 0.2) { // ignores implausibly-tiny gaps between fixes, which would wildly exaggerate a speed estimate
        var distKm = haversineKm({ lat: navSmooth.prevFixLat, lon: navSmooth.prevFixLon }, { lat: displayLat, lon: displayLon });
        fallbackSpeed = (distKm * 1000) / elapsedSincePrev;
        // Sanity clamp — ordinary GPS jitter between two closely-spaced
        // real fixes could otherwise compute an absurd speed spike
        // (a few meters of noise over a very short gap looks like
        // hundreds of km/h), which would send the extrapolation
        // shooting the marker far past where it should actually be.
        // 55 m/s (~200 km/h) is comfortably above any real driving
        // speed this app needs to handle, while still rejecting
        // clearly bogus noise-driven spikes.
        if (fallbackSpeed > 55) fallbackSpeed = 55;
      }
    }
    navSmooth.fixSpeedMps = reportedSpeed != null ? reportedSpeed : fallbackSpeed;
    navSmooth.prevFixLat = displayLat;
    navSmooth.prevFixLon = displayLon;
    navSmooth.prevFixTimestamp = navSmooth.fixTimestamp;
    if (!navPositionMarker) {
      // A directional arrow marking the driver's live position — the
      // map itself rotates to match heading (see rotateNavMapToHeading
      // / the smoothing loop), so this stays visually "pointing up" on
      // screen at all times, same as Google Maps' own convention.
      navPositionMarker = L.marker([displayLat, displayLon], {
        icon: L.divIcon({
          className: 'nav-heading-arrow',
          html: '<div>' + navPositionMarkerSvg() + '</div>',
          iconSize: [46, 46], iconAnchor: [23, 23]
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

    // Camera + bearing are handled continuously by navSmoothCameraFrame
    // now (see navSmooth.fixLat/fixLon/fixHeading set above) — nothing
    // else to do here on this tick.

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
    navToast('Fuori percorso — ricalcolo del percorso…');
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
        navToast('Percorso ricalcolato');
      })
      .catch(function () {
        // Couldn't get a fresh route (offline, out of quota, weak
        // signal) — the old route and instructions just stay as they
        // were rather than leaving the screen in a broken state; the
        // off-route counter will simply try again on the next fixes.
        navToast('Impossibile ricalcolare — riprovo al prossimo segnale');
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
    // LIVE remaining eta/distance — sum of the distance+duration of
    // every step from here to the end, not the fixed full-trip total
    // from when the route was first calculated. Previously "tempo" and
    // "distanza" never actually decreased during a trip — they showed
    // the same number the whole way, even five minutes from arrival.
    // This is a real-world approximation, not perfectly to the meter:
    // it counts the CURRENT step's full remaining length even though
    // some of it may already be behind the driver (progress WITHIN a
    // single step, before the next maneuver point, isn't tracked) — but
    // that's a small, steadily-shrinking-anyway margin, and an
    // approximate live countdown is a large improvement over one that
    // never moves at all.
    var remainingDistance = 0, remainingDuration = 0;
    for (var i = navActiveStepIndex; i < navActiveSteps.length; i++) {
      remainingDistance += navActiveSteps[i].distance;
      remainingDuration += navActiveSteps[i].duration;
    }
    var minutes = Math.round(remainingDuration / 60);
    var hours = Math.floor(minutes / 60), mins = minutes % 60;
    document.getElementById('nav-active-eta').textContent = (hours > 0 ? hours + ' h ' : '') + mins + ' min';
    document.getElementById('nav-active-remaining').textContent = (remainingDistance / 1000).toFixed(1) + ' km';
    // Estimated clock time of arrival — "arrivo" column, same idea as
    // Google Maps' own nav bar always showing a real clock time
    // alongside the remaining minutes, not just a countdown. Now based
    // on the same live remaining duration, so it also shifts forward
    // or back as the trip actually progresses, rather than staying
    // fixed at the original estimate from before setting off.
    var arrival = new Date(Date.now() + remainingDuration * 1000);
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
  // REAL BUG, found while investigating "the arrow drifts off the
  // street" reported during actual driving: this compared distances
  // using raw DEGREE differences (dx, dy), never converted to real
  // meters. At Italy's latitude (~45°N), one degree of longitude is
  // physically ~30% SHORTER than one degree of latitude (lines of
  // longitude converge toward the poles) — comparing them as if
  // equal systematically distorts which point looks "nearest",
  // especially on routes with tight turns or nearby parallel road
  // segments, exactly the kind of place this was reported going
  // wrong. Scaling the longitude difference by cos(latitude) corrects
  // for this, matching real-world physical distance instead of raw
  // degree-space distance. This function is what BOTH map-matching
  // (routeDeviation, snapping the marker to the road) and progressive
  // trimming (trimmedLegFeature) are built on — a real, meaningful
  // fix for both at once, not a guess.
  // A windowed variant of nearestCoordIndex, used ONLY for the
  // per-frame trim search below — NOT for off-route detection
  // (routeDeviation), which still needs the full, correct search
  // every time (a driver going genuinely off-route could end up
  // anywhere, not just near wherever the last search happened to
  // land). REAL PERFORMANCE BUG, found after a fresh look: once the
  // per-frame line-trim sync landed, this ran a full linear scan
  // through EVERY coordinate of the current leg — 60 TO 120 TIMES A
  // SECOND on a ProMotion iPhone — enough by itself to bottleneck the
  // main thread and cause exactly the "constant jolts, even on
  // powerful hardware" reported, despite setData() itself genuinely
  // being cheap (the earlier assumption that made this seem safe to
  // do every frame). Since the vehicle only ever advances gradually
  // along the route (never teleports), searching a small window
  // around the LAST match found is enough — falls back to the full
  // scan only when there's no established window yet (leg just
  // started) or the windowed search comes up empty.
  var navLastTrimIndex = -1;
  function navNearestCoordIndexWindowed(coords, lat, lon) {
    if (navLastTrimIndex < 0 || navLastTrimIndex >= coords.length) {
      navLastTrimIndex = nearestCoordIndex(coords, lat, lon);
      return navLastTrimIndex;
    }
    var lonScale = Math.cos(lat * Math.PI / 180);
    var windowStart = Math.max(0, navLastTrimIndex - 5);
    var windowEnd = Math.min(coords.length, navLastTrimIndex + 60);
    var bestIdx = -1, bestDist = Infinity;
    for (var i = windowStart; i < windowEnd; i++) {
      var dx = (coords[i][0] - lon) * lonScale, dy = coords[i][1] - lat;
      var d = dx * dx + dy * dy;
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    navLastTrimIndex = bestIdx;
    return bestIdx;
  }

  function nearestCoordIndex(coords, lat, lon) {
    var lonScale = Math.cos(lat * Math.PI / 180);
    var bestIdx = 0, bestDist = Infinity;
    for (var i = 0; i < coords.length; i++) {
      var dx = (coords[i][0] - lon) * lonScale, dy = coords[i][1] - lat;
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
  // that point to the next one along the geometry), PLUS the nearest
  // point's own coordinates — used for off-route detection (distance +
  // bearing) AND for map matching (nearestLat/nearestLon, the point to
  // visually snap the marker to when confidently on the route).
  function routeDeviation(coords, lat, lon) {
    var idx = nearestCoordIndex(coords, lat, lon);
    var c = coords[idx];
    var distance = haversineKm({ lat: lat, lon: lon }, { lat: c[1], lon: c[0] }) * 1000;
    var nextC = coords[idx + 1] || coords[idx - 1]; // fall back to the previous point at the very end of the line
    var routeBearing = nextC ? bearingBetween({ lat: c[1], lon: c[0] }, { lat: nextC[1], lon: nextC[0] }) : null;
    return { distance: distance, routeBearing: routeBearing, nearestLat: c[1], nearestLon: c[0] };
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
    var idx = navNearestCoordIndexWindowed(coords, lat, lon);
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
  //
  // This is the FULL rebuild — every leg layer torn down and recreated
  // — used only when the actual set of legs changes (starting
  // navigation, arriving at a stop, a reroute). For the FREQUENT case
  // (a plain GPS tick during an unchanged leg, just trimming the
  // current one a little further), use updateCurrentLegTrim below
  // instead — much cheaper, since it updates one existing layer's data
  // in place rather than rebuilding every layer on the screen.
  var navCurrentLegLayer = null; // persists across ticks, only replaced by a real full rebuild
  function drawActiveNavLegs(lat, lon) {
    navLastTrimIndex = -1; // a full rebuild means the leg (and its coordinate array) may have changed — the old windowed search position is meaningless against a different array
    if (navRouteLayer) navMap.removeLayer(navRouteLayer);
    navRouteLayer = L.featureGroup();
    navCurrentLegLayer = null;
    for (var i = navLegs.length - 1; i >= navCurrentLegIndex; i--) {
      var isCurrent = i === navCurrentLegIndex;
      var legFeature = navLegs[i];
      if (isCurrent && lat != null && lon != null) legFeature = trimmedLegFeature(legFeature, lat, lon);
      var legLayer = drawColorCodedRoute(legFeature, !isCurrent);
      legLayer.addTo(navRouteLayer);
      if (isCurrent) navCurrentLegLayer = legLayer;
    }
    navRouteLayer.addTo(navMap);
  }

  // The cheap, frequent path — called on every GPS tick while the leg
  // set itself hasn't changed. Just refreshes the current leg's own
  // trimmed geometry via setData (no layer/source recreation at all);
  // everything else on the map (future legs, markers) is untouched,
  // since none of it needed to change. Returns false (meaning: do a
  // real drawActiveNavLegs instead) if there's no persistent current-leg
  // layer yet to update — e.g. the very first tick right after
  // starting navigation or a reroute.
  function updateCurrentLegTrim(lat, lon) {
    if (!navCurrentLegLayer || !navLegs || !navLegs[navCurrentLegIndex]) return false;
    navCurrentLegLayer.setData(trimmedLegFeature(navLegs[navCurrentLegIndex], lat, lon));
    return true;
  }

  // The final destination — distinct from showNavArrivalPrompt above
  // (which is only for INTERMEDIATE stops on a multi-tappa trip and
  // lets the driver keep going afterward). Reaching the actual end of
  // the trip stops active navigation outright — there's nothing left
  // to navigate toward, so continuing to track position/reroute
  // against a route that's already finished doesn't make sense.
  function showNavFinalArrivalPrompt() {
    var banner = document.createElement('div');
    banner.id = 'nav-arrival-prompt';
    banner.className = 'nav-arrival-prompt';
    banner.innerHTML = '<span>Sei arrivato a destinazione!</span>' +
      '<button type="button" id="nav-final-arrival-ok">✓ Termina</button>';
    document.querySelector('.nav-map-wrap').appendChild(banner);
    document.getElementById('nav-final-arrival-ok').addEventListener('click', function () {
      banner.remove();
      stopActiveNavigation();
    });
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
    navStopSmoothCamera();
    clearTimeout(navAutoRecenterTimer);
    window.__navActiveNavigationRunning = false;
    if (navWatchId != null) { navigator.geolocation.clearWatch(navWatchId); navWatchId = null; }
    if (navPositionMarker) { navMap.removeLayer(navPositionMarker); navPositionMarker = null; }
    navMap.off('touchstart', navOnTouchStartPauseCamera);
    navMap.off('mousedown', navOnTouchStartPauseCamera);
    navMap.off('dragstart', navOnDragStartDisableFollow);
    navMap.off('touchend', navOnTouchEndResumeCamera);
    navMap.off('mouseup', navOnTouchEndResumeCamera);
    if (navMap.setBearing) navMap.setBearing(0); // back to plain north-up once navigation ends
    if (navMap.setPitch) navMap.setPitch(0); // and back to flat, top-down — the tilt is only for actively driving
    document.getElementById('nav-recenter-btn').style.display = 'none';
    var arrivalPrompt = document.getElementById('nav-arrival-prompt');
    if (arrivalPrompt) arrivalPrompt.remove();
    navLegs = null; navLegPoints = null; navCurrentLegIndex = 0; navArrivalPromptShown = false; navFinalArrivalShown = false;
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
    // REAL BUG, reported directly: on a genuinely fresh page load,
    // tapping "Anteprima PDF" right away did nothing useful the first
    // time — jsPDF loads lazily (see loadPdfLibs above), and this used
    // to just show a toast and give up entirely, leaving the person to
    // manually keep re-tapping until the library happened to already
    // be loaded by then (usually 3-4 seconds later). Now it actually
    // waits for the SAME loading it just kicked off, then finishes the
    // job automatically — the first tap always eventually opens the
    // preview, once, without the person needing to notice or retry.
    if (!libsReady) {
      toast('Preparazione in corso…');
      loadPdfLibs().then(function () {
        actuallyOpenPdfFullScreen();
      }).catch(function () { toast('Impossibile preparare il PDF — verifica la connessione'); });
      return;
    }
    actuallyOpenPdfFullScreen();
  }

  function actuallyOpenPdfFullScreen() {
    try {
      var mo = selectedPdfMonth();
      var doc = buildPdfForMonth(mo.month, mo.year);
      if (!doc) { toast('Nessun foglio per questo mese'); return; }
      var filename = 'Foglio_Viaggi_' + MESI[mo.month - 1] + '_' + mo.year + '.pdf';
      // REAL MISTAKE, found after ION reported the app installed to
      // the home screen (standalone mode — no Safari chrome at all,
      // confirmed directly, not assumed) started showing this app's
      // own custom viewer on iPhone instead of the native one, and
      // opened nothing at all on Android.
      //
      // The ORIGINAL, proven-working discovery was: cancelling
      // "Condividi PDF"'s share sheet fell back to jsPDF's own
      // .save() — a plain <a> link with href set to the PDF blob AND
      // a `download` attribute, clicked programmatically. That exact
      // mechanism is what gave the beautiful native-viewer result,
      // ALREADY inside standalone PWA mode (that's how ION found it
      // in the first place). The mistake was assuming window.open()
      // to the same blob would behave the same way — it does not,
      // especially in standalone mode, where there's no real "new
      // tab" concept for it to open into. Restored the exact original
      // mechanism for iOS specifically — not window.open, not a
      // same-tab location.href reassignment — a genuine link click,
      // matching jsPDF's own .save().
      //
      // Android is kept SEPARATE deliberately: the same link-click
      // mechanism is confirmed (by ION, directly) to trigger an
      // actual file download there (into Downloads), not an inline
      // view — a real platform difference, not something to paper
      // over by forcing the SAME mechanism everywhere. Rather than
      // accept that friction (leaving the app, hunting a
      // notification, opening a separate Files/Downloads screen) OR
      // keep guessing at more untested blob-URL tricks, Android uses
      // this app's OWN viewer instead — solid by now, after several
      // rounds of real fixes above (anchored-point pinch zoom,
      // correct scaling, no more native-zoom crashes).
      //
      // REAL BUG, found directly (a temporary on-screen diagnostic
      // showed ION's actual user agent): this exact check used to
      // look for "iPhone"/"iPad"/"iPod" in navigator.userAgent, but
      // his iPhone's Safari reported a desktop-style, "Macintosh"
      // user agent instead — silently failing this check and sending
      // a real iPhone down the Android/other path, which is exactly
      // the regression he reported. navigator.standalone doesn't
      // exist anywhere except iOS Safari (any value, even false,
      // means iOS) — checking for its mere presence instead of
      // parsing the UA string entirely sidesteps this.
      var isIOS = typeof navigator.standalone !== 'undefined';
      if (isIOS) {
        var blobUrl = URL.createObjectURL(doc.output('blob'));
        var link = document.createElement('a');
        link.href = blobUrl;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(function () { URL.revokeObjectURL(blobUrl); }, 30000);
      } else {
        openPdfViewerModal(doc.output('arraybuffer'), filename);
      }
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
  // App-controlled pinch-zoom and pan for the PDF preview — built to
  // replace native browser pinch-zoom entirely, after several
  // attempts at fixing native zoom's crashes on this screen (reported
  // directly, repeatedly, including the app getting stuck zoomed in
  // even after a forced restart). This version never touches the
  // viewport meta tag and never relies on the browser's own gesture
  // recognition at all — every finger movement is read directly via
  // Pointer Events, and the result is applied as a plain CSS
  // transform on a wrapper div. Both "scrolling between pages" and
  // "panning while zoomed" go through this SAME mechanism (dragging),
  // rather than mixing native scroll with app-driven zoom — one
  // consistent code path, nothing for the browser to misinterpret.
  var pdfZoomState = null;
  function initPdfViewerZoomPan() {
    var scrollEl = document.getElementById('pdfviewer-scroll');
    var wrapEl = document.getElementById('pdfviewer-zoom-wrap');
    var scale = 1, panX = 0, panY = 0;
    var pointers = {}; // pointerId -> {x, y}
    var pinchStart = null; // {dist, midX, midY, scale, panX, panY}
    var dragStart = null; // {x, y, panX, panY}
    var contentH = 0; // measured once pages finish rendering, used to keep panning within sane bounds

    function applyTransform() {
      wrapEl.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + scale + ')';
    }

    function clampPan(generous) {
      // Keeps the content from being dragged/zoomed entirely off-screen.
      // REAL BUG, reported directly: an earlier, tight version of this
      // (a flat 80px slack) fought the anchor-point pinch math above,
      // visibly pulling zoom away from wherever the fingers actually
      // were, especially on shorter content. The margin is now
      // proportional to the CURRENT scaled size instead of a fixed
      // number — generous enough that a normal, gradual pinch is never
      // constrained, while still catching a genuinely extreme jump
      // that would otherwise push all the content off-screen entirely.
      var scrollRect = scrollEl.getBoundingClientRect();
      var scaledW = scrollRect.width * scale;
      var scaledH = (contentH || scrollRect.height) * scale;
      var slackX = generous ? scaledW * 0.6 : 80;
      var slackY = generous ? scaledH * 0.6 : 80;
      var minX = Math.min(0, scrollRect.width - scaledW);
      var minY = Math.min(0, scrollRect.height - scaledH);
      panX = Math.max(minX - slackX, Math.min(slackX, panX));
      panY = Math.max(minY - slackY, Math.min(slackY, panY));
    }

    function dist(p1, p2) { return Math.hypot(p1.x - p2.x, p1.y - p2.y); }
    function mid(p1, p2) { return { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }; }

    function onPointerDown(e) {
      try { scrollEl.setPointerCapture(e.pointerId); } catch (err) { /* some environments (or synthetic events) don't support this — pointermove still fires via the regular listener regardless */ }
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      var ids = Object.keys(pointers);
      if (ids.length === 2) {
        var p1 = pointers[ids[0]], p2 = pointers[ids[1]];
        var m = mid(p1, p2);
        // REAL BUG, reported directly: zooming always pulled the page
        // toward the top-left corner instead of the actual pinch point
        // — because transform-origin is fixed at (0,0), simply adding
        // the midpoint's own on-screen movement to pan (the previous
        // math) completely ignored that CHANGING SCALE ALONE already
        // shifts everything away from that corner. Fixed the proper
        // way: remember which CONTENT coordinate sits under the
        // fingers right now, then on every move, solve for whatever
        // pan keeps that SAME content point under the CURRENT
        // (moving) midpoint at the CURRENT scale — the standard
        // "zoom toward a point" formula, not just "follow the
        // average finger position".
        pinchStart = { dist: dist(p1, p2), mid: m, scale: scale, panX: panX, panY: panY,
          anchorX: (m.x - panX) / scale, anchorY: (m.y - panY) / scale };
        dragStart = null;
      } else if (ids.length === 1) {
        dragStart = { x: e.clientX, y: e.clientY, panX: panX, panY: panY };
      }
    }

    function onPointerMove(e) {
      if (!pointers[e.pointerId]) return;
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      var ids = Object.keys(pointers);
      if (ids.length === 2 && pinchStart) {
        var p1 = pointers[ids[0]], p2 = pointers[ids[1]];
        var newDist = dist(p1, p2);
        var newMid = mid(p1, p2);
        var ratio = newDist / (pinchStart.dist || 1);
        scale = Math.max(1, Math.min(4, pinchStart.scale * ratio));
        panX = newMid.x - pinchStart.anchorX * scale;
        panY = newMid.y - pinchStart.anchorY * scale;
        // A generous version of the SAME clamp now runs during the
        // pinch too — wide enough to never interfere with the anchor
        // math for any normal gesture, but still catching the
        // extreme case where content could otherwise vanish entirely
        // off-screen.
        clampPan(true);
        applyTransform();
      } else if (ids.length === 1 && dragStart) {
        panX = dragStart.panX + (e.clientX - dragStart.x);
        panY = dragStart.panY + (e.clientY - dragStart.y);
        clampPan();
        applyTransform();
      }
    }

    function onPointerUp(e) {
      delete pointers[e.pointerId];
      var ids = Object.keys(pointers);
      if (ids.length === 1) {
        // Dropped from two fingers to one mid-gesture — restart the
        // drag reference from here, instead of jumping using stale
        // two-finger math.
        dragStart = { x: pointers[ids[0]].x, y: pointers[ids[0]].y, panX: panX, panY: panY };
        pinchStart = null;
      } else if (ids.length === 0) {
        dragStart = null; pinchStart = null;
        // Settling back to scale 1 also resets pan — avoids ever
        // getting stuck slightly offset at the "unzoomed" level.
        if (scale <= 1.02) { scale = 1; panX = 0; panY = 0; applyTransform(); }
      }
    }

    scrollEl.addEventListener('pointerdown', onPointerDown);
    scrollEl.addEventListener('pointermove', onPointerMove);
    scrollEl.addEventListener('pointerup', onPointerUp);
    scrollEl.addEventListener('pointercancel', onPointerUp);

    pdfZoomState = {
      reset: function () { scale = 1; panX = 0; panY = 0; applyTransform(); },
      measure: function () { contentH = document.getElementById('pdfviewer-pages').getBoundingClientRect().height; },
      teardown: function () {
        scrollEl.removeEventListener('pointerdown', onPointerDown);
        scrollEl.removeEventListener('pointermove', onPointerMove);
        scrollEl.removeEventListener('pointerup', onPointerUp);
        scrollEl.removeEventListener('pointercancel', onPointerUp);
      }
    };
    applyTransform();
  }

  function teardownPdfViewerZoomPan() {
    if (pdfZoomState) { pdfZoomState.teardown(); pdfZoomState = null; }
  }

  function openPdfViewerModal(pdfArrayBuffer, title) {
    // REAL BUG history, preserved carefully: this exact screen is the
    // one already documented (see the comment right below) to crash
    // the renderer via native pinch-zoom, chased at length. The
    // touch-action:none on .pdfviewer-scroll below is the primary
    // fix, but a global viewport now allows zoom EVERYWHERE ELSE
    // (requested directly, separately — auto-zoom on input focus
    // should never happen, but manual pinch-zoom should still work
    // app-wide). Rather than trust touch-action alone to cover every
    // possible gesture start point on a screen already proven to
    // crash, the global viewport is explicitly pinned back to
    // no-zoom for the exact duration this modal is open — restored
    // the instant it closes, in closePdfViewerModal below.
    var vp = document.getElementById('viewport-meta');
    if (vp) vp.dataset.prevContent = vp.getAttribute('content');
    if (vp) vp.setAttribute('content', 'width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1, user-scalable=no');
    document.getElementById('pdfviewer-title').textContent = title || 'Anteprima';
    document.getElementById('pdfviewer-pages').innerHTML = '';
    document.getElementById('pdfviewer-loading').style.display = '';
    document.getElementById('modal-pdfviewer').classList.add('open');
    initPdfViewerZoomPan();

    // REAL BUG, reported directly: zooming into the preview could kick
    // the person out of the app entirely (a renderer crash, same
    // family as the one chased at length on /official/). Root cause
    // here is different but the same SHAPE — every page was rendered
    // to its own full-size <canvas> immediately on open, all at once,
    // regardless of whether the person was even looking at it yet. A
    // sheet with several logged fuel receipts (scontrini) can easily
    // run to multiple extra "gallery" pages beyond the trip sheet
    // itself — each one, at this viewer's scale (2.2x on retina-class
    // screens), is a genuinely large canvas; several of them held in
    // GPU memory simultaneously, then all needing to be recomposited
    // together the instant a native pinch-zoom starts, is a plausible
    // way to tip a phone into exactly this crash — independent of how
    // powerful the device is, since it's proportional to page COUNT,
    // which keeps growing as receipts accumulate across a month.
    // Fixed by rendering lazily: only the first page (what's actually
    // visible right after opening) renders immediately; every other
    // page is a lightweight placeholder, sized correctly so the
    // layout never jumps, and only becomes a real canvas once it
    // actually scrolls into view.
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
    // REAL BUG, reported directly: opening the preview felt "juddery"
    // — not smooth, a slight shake right as it appears. The modal's
    // own fade-in is a CSS transition (180ms), running on the SAME
    // main thread that PDF.js needs to synchronously rasterize the
    // first page onto canvas — if that rendering work starts the
    // INSTANT this function runs, it can compete with (and visibly
    // stutter) the fade-in animation. A short delay lets the fade-in
    // actually finish smoothly first, before the heavier work begins.
    setTimeout(function () {
    pdfjsLib.getDocument({ data: pdfArrayBuffer }).promise.then(function (pdf) {
      var container = document.getElementById('pdfviewer-pages');
      // REAL BUG, reported directly: zooming into the PDF preview
      // (especially a month with several fuel-receipt photo pages, on
      // top of the main GIRO table page(s)) could crash/kick the
      // person out of the app entirely. Every page becomes its own
      // full-resolution <canvas> element, all held in memory
      // simultaneously — a native pinch-zoom then asks the browser's
      // own compositor to handle all of them at a larger effective
      // size at once. The render scale here was higher than a static
      // preview actually needs (since real pinch-zoom is exactly how
      // someone reads fine detail anyway) — lowered to cut each
      // canvas's memory footprint roughly in half, while staying
      // sharp enough for the un-zoomed view.
      // REAL BUG, reported directly: after moving to app-controlled
      // zoom/pan (touch-action:none, no more native browser zoom at
      // all), the ORIGINAL reason this scale was lowered — native
      // pinch forcing the whole page to recomposite every rendered
      // canvas simultaneously — no longer applies. A CSS transform on
      // an already-rendered canvas just stretches its EXISTING pixels,
      // so zooming in now (up to 4x, see pdfZoomState) needs a
      // genuinely sharp base render to still look good, not just
      // "sharp enough before any zoom happens". Raised well above even
      // the original value — lazy-loading (only the visible page(s)
      // are ever real canvases at once) is what actually keeps memory
      // in check now, not a low base resolution.
      var scale = (window.devicePixelRatio > 1.5) ? 3 : 2.2;

      function renderPageIntoCanvas(page, canvas) {
        var viewport = page.getViewport({ scale: scale });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        return page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport }).promise;
      }

      var lazyObserver = window.IntersectionObserver ? new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          var placeholder = entry.target;
          lazyObserver.unobserve(placeholder);
          pdf.getPage(placeholder._pageNum).then(function (page) {
            var canvas = document.createElement('canvas');
            // No inline style copied over deliberately — the canvas
            // already gets correctly, responsively sized by its own
            // CSS rule (.pdfviewer-pages canvas{max-width:100%;
            // height:auto}), the same rule page 1's canvas has always
            // relied on. Copying the placeholder's own sizing here
            // was exactly the source of the distortion bug above.
            renderPageIntoCanvas(page, canvas).then(function () {
              placeholder.replaceWith(canvas);
            });
          });
        });
      }, { rootMargin: '600px 0px' }) : null; // generous margin — renders just BEFORE it's actually reached, so scrolling never visibly outpaces it

      return pdf.getPage(1).then(function (firstPage) {
        var firstCanvas = document.createElement('canvas');
        container.appendChild(firstCanvas);
        return renderPageIntoCanvas(firstPage, firstCanvas);
      }).then(function () {
        var restChain = Promise.resolve();
        var _loop = function (n) {
          restChain = restChain.then(function () { return pdf.getPage(n); }).then(function (page) {
            var viewport = page.getViewport({ scale: scale });
            if (!lazyObserver) {
              // No IntersectionObserver support at all (very old browser) — fall back to the previous eager behavior rather than never showing the page.
              var canvas = document.createElement('canvas');
              container.appendChild(canvas);
              return renderPageIntoCanvas(page, canvas);
            }
            var placeholder = document.createElement('div');
            placeholder._pageNum = n;
            // REAL BUG, found on direct review, reported by ION as
            // pages (especially the fuel-receipts page, since it's
            // rarely page 1) looking stretched/distorted before they
            // finish loading: this used to set the placeholder's pixel
            // size to viewport.width/height divided by the SAME scale
            // that built them — which just cancels back out to the
            // page's raw, UNSCALED point dimensions (e.g. ~841×595 for
            // A4 landscape), completely ignoring how wide the phone
            // screen actually is. The real <canvas>, once rendered,
            // is corrected by its own CSS rule (max-width:100%;
            // height:auto) — but that rule never applied to this
            // placeholder <div>, so it kept its true, oversized shape
            // the whole time it was waiting to be replaced. Sized by
            // aspect-ratio instead — the exact same proportion the
            // canvas will end up with, correctly constrained to the
            // container's real width from the very first frame.
            placeholder.style.width = '100%';
            placeholder.style.aspectRatio = (viewport.width / viewport.height).toFixed(4);
            placeholder.style.background = '#f4f2ee';
            container.appendChild(placeholder);
            lazyObserver.observe(placeholder);
          });
        };
        for (var n = 2; n <= pdf.numPages; n++) _loop(n);
        return restChain;
      });
    }).then(function () {
      document.getElementById('pdfviewer-loading').style.display = 'none';
      if (pdfZoomState) pdfZoomState.measure();
    }).catch(function (err) {
      console.error(err);
      document.getElementById('pdfviewer-loading').textContent = 'Impossibile generare l\'anteprima.';
    });
    }, 200);
  }
  function closePdfViewerModal() {
    document.getElementById('modal-pdfviewer').classList.remove('open');
    teardownPdfViewerZoomPan();
    var vp = document.getElementById('viewport-meta');
    if (vp && vp.dataset.prevContent) { vp.setAttribute('content', vp.dataset.prevContent); delete vp.dataset.prevContent; }
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
  // New generic template requested directly — no company logo, no
  // CF/P.IVA block, meant to work for any driver/company using the
  // app, matching the layout ION provided as a mockup. The GIRO
  // table itself uses the exact same column shape as "classic".
  function buildAdbStandardPage(doc, sheet, pageW, pageH, margin, contentW) {
    doc.setDrawColor(20, 20, 20);
    doc.setLineWidth(0.4);
    doc.rect(margin, margin, contentW, pageH - margin * 2);

    // Header: ADB Smart branding block (left, dark fill) | big
    // centered title | MESE/ANNO (right) — no company info at all.
    var headerH = 15;
    var brandW = contentW * 0.22;
    doc.setFillColor(20, 20, 20);
    doc.rect(margin, margin, brandW, headerH, 'F');
    doc.setFont('Roboto', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(232, 84, 43); // brand accent orange
    doc.text('ADB', margin + 3, margin + 6.5);
    doc.setTextColor(255, 255, 255);
    doc.text(' Smart', margin + 3 + doc.getTextWidth('ADB'), margin + 6.5);
    doc.setFont('Roboto', 'normal');
    doc.setFontSize(6.5);
    doc.text('Il tuo viaggio digitale', margin + 3, margin + 10.5);

    doc.line(margin + brandW, margin, margin + brandW, margin + headerH);
    doc.setTextColor(20, 20, 20);
    doc.setFont('Roboto', 'bold');
    doc.setFontSize(13.5);
    doc.text('RAPPORTO VIAGGI MENSILE', margin + brandW + (contentW * 0.56) / 2, margin + 7, { align: 'center' });
    doc.setFont('Roboto', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(90, 90, 90);
    doc.text('Registro giornaliero autista', margin + brandW + (contentW * 0.56) / 2, margin + 11.5, { align: 'center' });
    doc.setTextColor(20, 20, 20);

    var meseX = margin + brandW + contentW * 0.56;
    doc.line(meseX, margin, meseX, margin + headerH);
    doc.setFont('Roboto', 'normal');
    doc.setFontSize(7.5);
    doc.text('MESE / ANNO:', meseX + 2.5, margin + 6);
    doc.setFont('Roboto', 'bold');
    doc.setFontSize(9);
    doc.text(MESI[sheet.month - 1] + ' ' + sheet.year, meseX + 2.5, margin + 11);

    doc.line(margin, margin + headerH, margin + contentW, margin + headerH);

    // Fields, two rows of three, matching the mockup exactly
    var fieldsH = 8.5;
    var fy1 = margin + headerH;
    var fy2 = fy1 + fieldsH;
    var fcol = contentW / 3;
    [1, 2].forEach(function (i) {
      doc.line(margin + fcol * i, fy1, margin + fcol * i, fy2 + fieldsH);
    });
    doc.line(margin, fy2, margin + contentW, fy2);
    doc.line(margin, fy2 + fieldsH, margin + contentW, fy2 + fieldsH);

    function field(label, value, x, y) {
      doc.setFont('Roboto', 'normal');
      doc.setFontSize(7);
      doc.text(label, x + 2, y + 3.3);
      doc.setFont('Roboto', 'bold');
      doc.setFontSize(8.6);
      doc.text(value || '—', x + 2, y + 7);
    }
    field('NOME AUTISTA:', sheet.nome, margin, fy1);
    field('TARGA VEICOLO:', sheet.targa, margin + fcol, fy1);
    field('PER CONTO DI / AZIENDA:', sheet.perContoDi, margin + fcol * 2, fy1);
    field('PARTENZA ABITUALE:', sheet.da, margin, fy2);
    field('PROV.:', sheet.provDa, margin + fcol, fy2);
    field('VEICOLO / N. INTERNO:', sheet.veicoloInterno, margin + fcol * 2, fy2);

    // GIRO title bar
    var giroH = 6;
    var gy = fy2 + fieldsH;
    doc.setFillColor(230, 230, 228);
    doc.rect(margin, gy, contentW, giroH, 'F');
    doc.rect(margin, gy, contentW, giroH);
    doc.setFont('Roboto', 'bold');
    doc.setFontSize(10);
    doc.text('GIRO / VIAGGI EFFETTUATI', margin + contentW / 2, gy + 4.2, { align: 'center' });

    // Table — identical column shape to "classic"
    var tableY = gy + giroH;
    var colWidths = {
      data: contentW * 0.035, da: contentW * 0.145, provDa: contentW * 0.045,
      a: contentW * 0.165, provA: contentW * 0.045, ddt: contentW * 0.125,
      kmI: contentW * 0.125, kmF: contentW * 0.125, kmT: contentW * 0.14
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
      // REAL BUG, same family as above (see buildPdfPage's own
      // classic template, right below, for the fuller explanation):
      // safety net for a sheet that started as "due giri" and was
      // later switched to this template — its saved kmFine2 would
      // otherwise silently vanish from this printed total while the
      // app's own on-screen total (sheetKmAndTrips) still includes it.
      if (g.kmInizio2 !== "" && g.kmInizio2 !== undefined && g.kmFine2 !== "" && g.kmFine2 !== undefined && !isNaN(g.kmFine2 - g.kmInizio2)) {
        kmTot = (kmTot === '' ? 0 : kmTot) + (Number(g.kmFine2) - Number(g.kmInizio2));
      }
      body.push([d, g.da || '', g.provDa || '', g.a || '', g.provA || '', g.ddt || '', g.kmInizio !== "" ? g.kmInizio : '', g.kmFine !== "" ? g.kmFine : '', kmTot !== '' ? kmTot : '']);
    }
    doc.autoTable({
      startY: tableY,
      margin: { left: margin, right: margin },
      tableWidth: contentW,
      theme: 'grid',
      head: head,
      body: body,
      styles: { font: 'Roboto', fontSize: 7.4, cellPadding: { top: 0.7, bottom: 0.7, left: 1.1, right: 1.1 }, lineColor: [20, 20, 20], lineWidth: 0.25, textColor: [20, 20, 20], valign: 'middle' },
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

  function buildPdfPage(doc, sheet) {
    var pageW = 297, pageH = 210;
    var margin = 8;
    var contentW = pageW - margin * 2;

    // Requested directly: a third template, generic, with NO fixed
    // company branding baked in (no logo, no CF/P.IVA block) — meant
    // for ANY driver/company using the app, not specifically Power
    // Trasporti. Header and fields section are entirely different
    // from the other two; the actual GIRO table itself reuses the
    // exact same column layout as "classic" (Data/Da/Prov/A/Prov/
    // DDT/KM), since ION's own mockup used that same shape.
    if (sheet.pdfTemplate === 'adb-standard') {
      return buildAdbStandardPage(doc, sheet, pageW, pageH, margin, contentW);
    }

    // REAL BUG, reported directly and confirmed: due-giri's own two
    // pages (see buildDueGiriPage) were being drawn ON TOP of this
    // function's OWN generic single-giro header — this check used to
    // sit much further down, AFTER already drawing the entire old
    // header (logo, company info, driver/targa fields, GIRO bar) onto
    // page 1. Moved up here, right alongside the adb-standard check
    // above, so due-giri returns immediately, before any of that old
    // header ever gets drawn on top of buildDueGiriPage's own.
    if (sheet.pdfTemplate === 'due-giri') {
      buildDueGiriPage(doc, sheet, margin, contentW, 1);
      doc.addPage();
      buildDueGiriPage(doc, sheet, margin, contentW, 2);
      return;
    }

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

    doc.setFont('Roboto', 'bold');
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

    doc.setFont('Roboto', 'normal');
    doc.setFontSize(7.8);
    doc.text('Viaggi effettuati nel mese di:', margin + 2.5, fy + 4.8);
    doc.setFont('Roboto', 'bold');
    doc.setFontSize(9);
    doc.text(MESI[sheet.month - 1] + '   ' + sheet.year, margin + 2.5, fy + 9.8);

    doc.setFont('Roboto', 'normal');
    doc.setFontSize(7.8);
    doc.text('Nome autista:', margin + col1 + 2.5, fy + 4.8);
    doc.setFont('Roboto', 'bold');
    doc.setFontSize(9.2);
    doc.text(sheet.nome || '—', margin + col1 + 2.5, fy + 10.2);

    doc.setFont('Roboto', 'normal');
    doc.setFontSize(7.8);
    doc.text('Targa Veicolo:', margin + col1 + col2 + 2.5, fy + 4.8);
    doc.setFont('Roboto', 'bold');
    doc.setFontSize(9.2);
    doc.text(sheet.targa || '—', margin + col1 + col2 + 2.5, fy + 10.2);

    doc.setFont('Roboto', 'bold');
    doc.setFontSize(9);
    doc.text('Per conto di: ' + (sheet.perContoDi || '—'), margin + col1 + col2 + col3 + 2.5, fy + 7.5);

    // GIRO title bar
    var giroH = 6;
    var gy = fy + fieldsH;
    doc.setFillColor(230, 230, 228);
    doc.rect(margin, gy, contentW, giroH, 'F');
    doc.rect(margin, gy, contentW, giroH);
    doc.setFont('Roboto', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(20, 20, 20);
    doc.text('GIRO', margin + contentW / 2, gy + 4.2, { align: 'center' });

    // Table
    var tableY = gy + giroH;

    var colWidths, head, body;

    {
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
        // REAL BUG, same family as the two already fixed elsewhere
        // (home screen totals, foglio day list): this table normally
        // only ever shows Giro 1 fields — this template's own day
        // form has no second-giro inputs at all, so kmFine2 should
        // stay empty here in ordinary use. But it's NOT actually
        // impossible: if a sheet started as "due giri" (where those
        // fields are entered), then got switched to this template
        // afterward, the already-saved kmFine2 data would otherwise
        // go completely missing from this printed total — while the
        // app's own on-screen "KM totali" (sheetKmAndTrips, fixed
        // separately) would still correctly include it, silently
        // disagreeing with what's printed on paper. Added here purely
        // as a safety net for that edge case, not a normal-use path.
        if (g.kmInizio2 !== "" && g.kmInizio2 !== undefined && g.kmFine2 !== "" && g.kmFine2 !== undefined && !isNaN(g.kmFine2 - g.kmInizio2)) {
          kmTot = (kmTot === '' ? 0 : kmTot) + (Number(g.kmFine2) - Number(g.kmInizio2));
        }
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

    var columnStyles = {
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
      styles: { font: 'Roboto', fontSize: 7.4, cellPadding: { top: 0.7, bottom: 0.7, left: 1.1, right: 1.1 }, lineColor: [20, 20, 20], lineWidth: 0.25, textColor: [20, 20, 20], valign: 'middle' },
      headStyles: { fillColor: [255, 255, 255], textColor: [20, 20, 20], fontStyle: 'bold', fontSize: 7.2, cellPadding: { top: 1, bottom: 1, left: 1.1, right: 1.1 }, lineColor: [20, 20, 20], lineWidth: 0.25 },
      bodyStyles: { minCellHeight: 4.1 },
      columnStyles: columnStyles
    });
  }

  // Requested directly, following real driver feedback: each giro on
  // a due-giri sheet now gets its own COMPLETE page — same shape as a
  // normal single-giro monthly sheet (company header, driver/targa
  // fields, GIRO title bar, then the table), just fed that giro's own
  // specific fields. giroNum is 1 or 2, selecting which of the
  // giorno's parallel field sets (da/a/ddt/riscosso1/kmInizio/kmFine
  // vs da2/a2/ddt2/riscosso2/kmInizio2/kmFine2) this page draws from.
  function buildDueGiriPage(doc, sheet, margin, contentW, giroNum) {
    var pageH = 210;

    // Outer border
    doc.setDrawColor(20, 20, 20);
    doc.setLineWidth(0.4);
    doc.rect(margin, margin, contentW, pageH - margin * 2);

    // Header block: logo (left) | company info (right) — identical to
    // the standard due-giri header used before this change.
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

    doc.setFont('Roboto', 'bold');
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

    doc.setFont('Roboto', 'normal');
    doc.setFontSize(7.8);
    doc.text('Viaggi effettuati nel mese di:', margin + 2.5, fy + 4.8);
    doc.setFont('Roboto', 'bold');
    doc.setFontSize(9);
    doc.text(MESI[sheet.month - 1] + '   ' + sheet.year, margin + 2.5, fy + 9.8);

    doc.setFont('Roboto', 'normal');
    doc.setFontSize(7.8);
    doc.text('Nome autista:', margin + col1 + 2.5, fy + 4.8);
    doc.setFont('Roboto', 'bold');
    doc.setFontSize(9.2);
    doc.text(sheet.nome || '—', margin + col1 + 2.5, fy + 10.2);

    doc.setFont('Roboto', 'normal');
    doc.setFontSize(7.8);
    // Requested directly: labeled "abituale" (usual/default) - a
    // per-day override (new Targa column below) can differ per giro.
    doc.text('Targa Veicolo (abituale):', margin + col1 + col2 + 2.5, fy + 4.8);
    doc.setFont('Roboto', 'bold');
    doc.setFontSize(9.2);
    doc.text(sheet.targa || '—', margin + col1 + col2 + 2.5, fy + 10.2);

    doc.setFont('Roboto', 'bold');
    doc.setFontSize(9);
    doc.text('Per conto di: ' + (sheet.perContoDi || '—'), margin + col1 + col2 + col3 + 2.5, fy + 7.5);

    // GIRO title bar — shows which of the two giri this page is,
    // making it immediately obvious at a glance.
    var giroH = 6;
    var gy = fy + fieldsH;
    doc.setFillColor(230, 230, 228);
    doc.rect(margin, gy, contentW, giroH, 'F');
    doc.rect(margin, gy, contentW, giroH);
    doc.setFont('Roboto', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(20, 20, 20);
    doc.text('GIRO ' + giroNum, margin + contentW / 2, gy + 4.2, { align: 'center' });

    // Table — same shape as a normal single-giro sheet, plus a
    // "Riscosso" column (money collected from the client) and a
    // "Targa" column (per-day/per-giro vehicle override, when the
    // driver used a different vehicle than the sheet's own default
    // that day — otherwise shows the sheet's usual targa), reading
    // from whichever field set (1 or 2) this page is for.
    var tableY = gy + giroH;
    var colWidths = {
      data: contentW * 0.032, da: contentW * 0.136, provDa: contentW * 0.04,
      a: contentW * 0.151, provA: contentW * 0.04, ddt: contentW * 0.106, targa: contentW * 0.062, ric: contentW * 0.075,
      kmI: contentW * 0.114, kmF: contentW * 0.114, kmT: contentW * 0.129
    };
    var head = [
      [
        { content: 'Data', rowSpan: 2, styles: { valign: 'middle', halign: 'center' } },
        { content: 'Località di destinazione:', colSpan: 4, styles: { halign: 'center' } },
        { content: 'DDT', rowSpan: 2, styles: { valign: 'middle', halign: 'center' } },
        { content: 'Targa', rowSpan: 2, styles: { valign: 'middle', halign: 'center' } },
        { content: 'Riscosso', rowSpan: 2, styles: { valign: 'middle', halign: 'center' } },
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
    var fDa = giroNum === 1 ? 'da' : 'da2', fProvDa = giroNum === 1 ? 'provDa' : 'provDa2';
    var fA = giroNum === 1 ? 'a' : 'a2', fProvA = giroNum === 1 ? 'provA' : 'provA2';
    var fDdt = giroNum === 1 ? 'ddt' : 'ddt2', fRisc = giroNum === 1 ? 'riscosso1' : 'riscosso2';
    var fTarga = giroNum === 1 ? 'targa1' : 'targa2';
    var fKmI = giroNum === 1 ? 'kmInizio' : 'kmInizio2', fKmF = giroNum === 1 ? 'kmFine' : 'kmFine2';
    for (var d = 1; d <= 31; d++) {
      var g = d <= n ? sheet.giorni[d] : null;
      if (!g) { body.push([d <= n ? d : '', '', '', '', '', '', '', '', '', '', '']); continue; }
      var ki = g[fKmI], kf = g[fKmF];
      var kmTot = (ki !== "" && ki !== undefined && kf !== "" && kf !== undefined && !isNaN(kf - ki)) ? (Number(kf) - Number(ki)) : '';
      var risc = g[fRisc];
      body.push([
        d,
        g[fDa] || '', g[fProvDa] || '',
        g[fA] || '', g[fProvA] || '',
        g[fDdt] || '',
        g[fTarga] || sheet.targa || '',
        (risc !== "" && risc !== undefined) ? Number(risc).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '',
        (ki !== "" && ki !== undefined) ? ki : '',
        (kf !== "" && kf !== undefined) ? kf : '',
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
      styles: { font: 'Roboto', fontSize: 7.4, cellPadding: { top: 0.7, bottom: 0.7, left: 1.1, right: 1.1 }, lineColor: [20, 20, 20], lineWidth: 0.25, textColor: [20, 20, 20], valign: 'middle' },
      headStyles: { fillColor: [255, 255, 255], textColor: [20, 20, 20], fontStyle: 'bold', fontSize: 7.2, cellPadding: { top: 1, bottom: 1, left: 1.1, right: 1.1 }, lineColor: [20, 20, 20], lineWidth: 0.25 },
      bodyStyles: { minCellHeight: 4.1 },
      columnStyles: {
        0: { cellWidth: colWidths.data, halign: 'center', fontStyle: 'bold' },
        1: { cellWidth: colWidths.da, halign: 'center' },
        2: { cellWidth: colWidths.provDa, halign: 'center' },
        3: { cellWidth: colWidths.a, halign: 'center' },
        4: { cellWidth: colWidths.provA, halign: 'center' },
        5: { cellWidth: colWidths.ddt, halign: 'center' },
        6: { cellWidth: colWidths.targa, halign: 'center' },
        7: { cellWidth: colWidths.ric, halign: 'center' },
        8: { cellWidth: colWidths.kmI, halign: 'center' },
        9: { cellWidth: colWidths.kmF, halign: 'center' },
        10: { cellWidth: colWidths.kmT, halign: 'center', fontStyle: 'bold' }
      }
    });
  }

  // Requested directly: accented characters (Ò, À, È, Ù, Ì, and the
  // euro sign) came out corrupted in generated PDFs — jsPDF's own
  // built-in 'helvetica' font is limited to ASCII/WinAnsi, the
  // standard fix for this is loading a real font with those glyphs
  // (here: Roboto, subsetted to Western European Latin, kept loaded
  // alongside jsPDF itself — see ensurePdfLibsLoaded above) and using
  // it in place of 'helvetica' everywhere a PDF gets built.
  function createPdfDoc() {
    var jsPDFCtor = window.jspdf.jsPDF;
    var doc = new jsPDFCtor({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    doc.addFileToVFS('Roboto-Regular.ttf', PDF_FONT_ROBOTO_REGULAR_B64);
    doc.addFont('Roboto-Regular.ttf', 'Roboto', 'normal');
    doc.addFileToVFS('Roboto-Bold.ttf', PDF_FONT_ROBOTO_BOLD_B64);
    doc.addFont('Roboto-Bold.ttf', 'Roboto', 'bold');
    doc.setFont('Roboto', 'normal');
    return doc;
  }

  function buildPdf(sheet) {
    var doc = createPdfDoc();
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
    var doc = createPdfDoc();
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
      doc.setFont('Roboto', 'bold');
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

      doc.setFont('Roboto', 'bold');
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
    document.getElementById('day-riscosso1-wrap').classList.toggle('hidden', !isDueGiri);
    document.getElementById('day-a-label').textContent = isDueGiri ? 'Località di destinazione (A: 1)' : 'Località di destinazione (A)';
    document.getElementById('day-ddt-label').textContent = isDueGiri ? 'DDT - 1' : 'DDT';
    // Requested directly: relabeled to make clear these now belong to
    // Giro 1 specifically, once a second giro (with its OWN separate
    // km fields, below) exists on the same day.
    document.getElementById('day-kminizio-label').textContent = isDueGiri ? 'KM inizio (Giro 1)' : 'KM inizio';
    document.getElementById('day-kmfine-label').textContent = isDueGiri ? 'KM fine (Giro 1)' : 'KM fine';
    document.getElementById('day-kmtot-label').textContent = isDueGiri ? 'KM totali (Giro 1)' : 'KM totali';
    document.getElementById('day-a2').value = g.a2 || '';
    document.getElementById('day-prova2').value = g.provA2 || '';
    document.getElementById('day-ddt2').value = g.ddt2 || '';
    document.getElementById('day-riscosso1').value = g.riscosso1 || '';
    document.getElementById('day-riscosso2').value = g.riscosso2 || '';
    document.getElementById('day-targa1').value = g.targa1 || '';
    document.getElementById('day-targa2').value = g.targa2 || '';
    document.getElementById('day-da2').value = g.da2 || '';
    document.getElementById('day-provda2').value = g.provDa2 || '';
    document.getElementById('day-kminizio2').value = g.kmInizio2 !== undefined && g.kmInizio2 !== '' ? g.kmInizio2 : '';
    document.getElementById('day-kmfine2').value = g.kmFine2 || '';
    updateKmTot2();
    // Requested directly: re-arms the auto-fill for THIS day's own
    // modal session — a day that already has its own kmInizio2 saved
    // (from a previous edit) keeps that value protected from being
    // silently overwritten if Km fine (Giro 1) gets touched again;
    // a genuinely new, still-empty day allows the live auto-fill.
    dpKmInizio2ManuallyEdited = (g.kmInizio2 !== undefined && g.kmInizio2 !== '');

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

  // Requested directly, following real driver feedback: Giro 2 gets
  // its own, separate KM total, calculated the same way as Giro 1's.
  function updateKmTot2() {
    var ki2 = document.getElementById('day-kminizio2').value;
    var kf2 = document.getElementById('day-kmfine2').value;
    var warn2 = document.getElementById('day-warn2');
    var totField2 = document.getElementById('day-kmtot2');
    if (ki2 !== '' && kf2 !== '' && !isNaN(ki2) && !isNaN(kf2)) {
      var tot2 = Number(kf2) - Number(ki2);
      if (tot2 < 0) { if (warn2) warn2.classList.add('show'); totField2.value = tot2.toLocaleString('it-IT') + ' (verifica)'; }
      else { if (warn2) warn2.classList.remove('show'); totField2.value = tot2.toLocaleString('it-IT') + ' km'; }
    } else {
      if (warn2) warn2.classList.remove('show');
      totField2.value = '';
    }
  }
  document.getElementById('day-kminizio2').addEventListener('input', updateKmTot2);
  document.getElementById('day-kmfine2').addEventListener('input', updateKmTot2);
  // REAL BUG, reported directly and confirmed: typing "2500" digit by
  // digit into Km fine (Giro 1) only copied over the very FIRST digit
  // ("2") into Km inizio (Giro 2), then got stuck there — because the
  // old check ("only fill if empty") passed on that very first
  // keystroke, filling the field with just "2"; from that point on,
  // the field was no longer empty, so every subsequent keystroke
  // ("25", "250", "2500") got silently ignored. Fixed with an
  // explicit flag instead: keeps copying the CURRENT, full value on
  // every keystroke, live, right up until the driver manually types
  // into Giro 2's own field themselves — at which point their
  // deliberate edit is respected and live-copying stops for this day.
  var dpKmInizio2ManuallyEdited = false;
  document.getElementById('day-kminizio2').addEventListener('input', function () {
    dpKmInizio2ManuallyEdited = true;
  });
  document.getElementById('day-kmfine').addEventListener('input', function () {
    if (!dpKmInizio2ManuallyEdited) {
      document.getElementById('day-kminizio2').value = this.value;
      updateKmTot2();
    }
  });

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
      da2: document.getElementById('day-da2').value.trim(),
      provDa2: document.getElementById('day-provda2').value.trim().toUpperCase(),
      riscosso1: document.getElementById('day-riscosso1').value === '' ? '' : Math.max(0, Number(document.getElementById('day-riscosso1').value)),
      riscosso2: document.getElementById('day-riscosso2').value === '' ? '' : Math.max(0, Number(document.getElementById('day-riscosso2').value)),
      kmInizio: document.getElementById('day-kminizio').value === '' ? '' : Number(document.getElementById('day-kminizio').value),
      kmFine: document.getElementById('day-kmfine').value === '' ? '' : Number(document.getElementById('day-kmfine').value),
      kmInizio2: document.getElementById('day-kminizio2').value === '' ? '' : Number(document.getElementById('day-kminizio2').value),
      kmFine2: document.getElementById('day-kmfine2').value === '' ? '' : Number(document.getElementById('day-kmfine2').value),
      targa1: document.getElementById('day-targa1').value.trim().toUpperCase(),
      targa2: document.getElementById('day-targa2').value.trim().toUpperCase(),
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
  // Tracks the "← Modifica nome/targa" back-link on the email step —
  // set right before opening Settings from there, so Salva knows to
  // return to the email screen afterward instead of falling through to
  // the normal "wasFirstRun" logic, which would be false here (nome
  // already exists from before) and so wouldn't reopen it on its own.
  var cameFromEmailStepToEditName = false;

  function openSettingsModal(sheetOverride) {
    settingsTargetSheet = sheetOverride || null;
    // Redesign — requested directly: fields regrouped into clear
    // sections with small icon headers, the account area given real
    // visual weight (avatar + plan badge, placeholder for now — "e
    // toti free la moment, dar pe parcurs se vor schimba lucrurile").
    // Icons are JS-driven (svgIcon), so populated here, once, every
    // time this modal opens.
    var iconUser = document.getElementById('settings-icon-user');
    if (iconUser) iconUser.innerHTML = svgIcon('user');
    var iconCoin = document.getElementById('settings-icon-coin');
    if (iconCoin) iconCoin.innerHTML = svgIcon('coin');
    var iconIdBadge = document.getElementById('settings-icon-idbadge');
    if (iconIdBadge) iconIdBadge.innerHTML = svgIcon('idbadge');
    renderDriverIdRow();

    var infoToggle = document.getElementById('settings-info-toggle');
    var infoPanel = document.getElementById('settings-info-panel');
    if (infoToggle && infoPanel) {
      infoPanel.classList.add('hidden'); // always starts collapsed — a fresh open shouldn't carry over whatever state it was left in
      infoToggle.onclick = function () { infoPanel.classList.toggle('hidden'); };
    }

    var versionEl = document.getElementById('settings-version-display');
    // Requested directly: "pt-foglio-v364" read as an ugly, internal-
    // looking string — the number itself matters (still needed to
    // confirm a fresh build reached the phone), the "pt-foglio-"
    // prefix doesn't. Shown as "ADB Smart · v335" instead — same
    // underlying APP_VERSION value, just formatted for a person
    // rather than for cache-busting.
    if (versionEl) versionEl.textContent = 'ADB Smart · v' + APP_VERSION.replace(/^pt-foglio-v/, '');
    // Deliberately bare — no label, no explanation, just
    // "remaining/limit" — requested directly, meant to be recognized
    // by ION specifically, not something every driver needs to
    // understand.
    var quotaEl = document.getElementById('settings-ors-quota-display');
    if (quotaEl) {
      try {
        // Tracked separately per real ORS endpoint kind now — each
        // one can (and, confirmed directly, does) carry its own
        // distinct daily limit, not one shared number as third-party
        // documentation had suggested. Shown together, compact, still
        // with no label — g/o/d for geocode/optimization/directions,
        // only whichever ones this phone has actually seen a real
        // reading for.
        var q = JSON.parse(localStorage.getItem(LS_ORS_QUOTA) || '{}');
        var parts = [];
        if (q.geocode) parts.push('g ' + q.geocode.remaining + '/' + (q.geocode.limit || '?'));
        if (q.optimization) parts.push('o ' + q.optimization.remaining + '/' + (q.optimization.limit || '?'));
        if (q.directions) parts.push('d ' + q.directions.remaining + '/' + (q.directions.limit || '?'));
        quotaEl.textContent = parts.join('  ');
      } catch (e) { quotaEl.textContent = ''; }
    }
    var src = settingsTargetSheet ? {
      nome: settingsTargetSheet.nome, targa: settingsTargetSheet.targa, perContoDi: settingsTargetSheet.perContoDi,
      veicoloInterno: settingsTargetSheet.veicoloInterno,
      da: settingsTargetSheet.da, provDa: settingsTargetSheet.provDa
    } : state.profile;
    document.getElementById('settings-title').textContent = settingsTargetSheet ? 'Dati foglio' : (state.profile.nome ? 'Impostazioni' : 'Benvenuto');
    // Requested directly: this consent checkbox only ever appears on
    // the very first Benvenuto run — once a profile already exists
    // (Impostazioni, or editing a specific sheet's data), it's gone
    // for good, never shown again anywhere.
    var pushConsentRow = document.getElementById('push-consent-row');
    if (pushConsentRow) pushConsentRow.style.display = (!settingsTargetSheet && !state.profile.nome) ? 'flex' : 'none';
    document.getElementById('settings-sub').textContent = settingsTargetSheet
      ? 'Modifica i dati per il foglio di ' + MESI[settingsTargetSheet.month - 1] + ' ' + settingsTargetSheet.year + '. I nuovi fogli useranno comunque questi valori come predefiniti.'
      : 'Inserisci i dati autista per iniziare a compilare il foglio viaggi.';
    document.getElementById('in-nome').value = src.nome || '';
    // Requested directly: once this device's email has been confirmed
    // as belonging to a specific, already-known name (either the
    // first-ever confirmation, or an explicit "yes, that's me" on a
    // shared email), the name field stays locked here too — not just
    // right at the moment of confirmation — so it can never quietly
    // drift apart from the one real person this account is tied to.
    document.getElementById('in-nome').disabled = !!(state.profile.nomeLocked && !settingsTargetSheet);
    document.getElementById('in-nome-locked-note').classList.toggle('hidden', !(state.profile.nomeLocked && !settingsTargetSheet));
    document.getElementById('in-targa').value = formatTarga(src.targa || '');
    document.getElementById('in-conto').value = src.perContoDi || '';
    document.getElementById('in-da').value = src.da || '';
    document.getElementById('in-prov-da').value = src.provDa || '';
    document.getElementById('in-veicolo-interno').value = src.veicoloInterno || '';
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
      var email = currentAccountEmail();
      document.getElementById('account-email-display').textContent = email;
      var avatarEl = document.getElementById('settings-avatar');
      if (avatarEl) avatarEl.textContent = (email || '?').charAt(0).toUpperCase();
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
    // REAL SECURITY GAP, found and fixed directly: this used to check
    // data.confirmed — a PERMANENT flag, true forever once an email is
    // EVER confirmed, by anyone, on any device. Typing in any email
    // that had been confirmed before granted access almost immediately,
    // with no actual click required this time. Now sends the baseline
    // captured right before THIS specific magic link was sent (see the
    // account-send-btn handler), and only trusts justSignedIn — true
    // only once a genuinely NEW sign-in happened after that exact
    // baseline, proving THIS request's link (not some unrelated,
    // earlier login) was the one actually clicked.
    fetch(SUPABASE_URL + '/functions/v1/check-email-confirmed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY },
      body: JSON.stringify({ email: email, since: state.profile.pendingEmailBaseline || null })
    }).then(function (res) { return res.json(); })
      .then(function (data) {
        if (data && data.justSignedIn) {
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
    assignDriverIdIfNeeded(); // covers accounts confirmed before this feature existed — assigned on next app open, not just at the moment of confirmation
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
    // Requested directly: an automatic, silent close used to happen
    // right here — easy to miss, especially returning to the app from
    // a separate mail app ("m-am intors in app insa nu se intampla
    // nimic"). Now shows a deliberate "Grazie!" screen with its own
    // "Continua" button instead — the modal only actually closes once
    // that's tapped, in dismissEmailConfirmedScreen() below.
    document.getElementById('account-logged-out').classList.add('hidden');
    document.getElementById('account-pending').classList.add('hidden');
    document.getElementById('account-just-confirmed').classList.remove('hidden');
    stopWatchingForConfirmation();
    // Requested directly: the very first person to ever genuinely
    // confirm a given email becomes its "owner" for naming purposes —
    // claimed here, right after a REAL confirmation (never on just
    // sending), using whatever nome this device has right now. A
    // best-effort call — if it fails, the worst case is simply no
    // canonical name gets set yet, tried again next time someone else
    // confirms this same email, never a security downgrade.
    //
    // Requested directly, as a follow-up clarification: locking applies
    // to EVERY confirmed email, not only the "someone else already
    // owns this name" conflict path — a brand new, first-ever
    // registration also has its name locked the moment confirmation is
    // genuine, for the same consistency reason (every PDF this device
    // ever produces should keep showing the one real person tied to
    // this email, permanently, not something that could quietly drift
    // later).
    var emailForClaim = currentAccountEmail();
    if (emailForClaim && state.profile.nome) {
      // Requested directly: the name only actually gets set/applied
      // here, at the moment of a GENUINE confirmation — if the
      // identity-conflict flow ("Sì, sono io") happened earlier for
      // THIS specific request, its proposed name is applied for real
      // right now, overriding whatever's currently typed; otherwise
      // this is just a normal, brand-new registration, and whatever
      // name is already there simply gets locked as-is.
      if (state.profile.pendingCanonicalName) {
        state.profile.nome = state.profile.pendingCanonicalName;
        var nomeInputEl = document.getElementById('in-nome');
        if (nomeInputEl) nomeInputEl.value = state.profile.nome;
      }
      state.profile.nomeLocked = true;
      state.profile.pendingCanonicalName = null;
      saveProfile(state.profile);
      fetch(SUPABASE_URL + '/functions/v1/email-identity-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY },
        body: JSON.stringify({ action: 'claim', email: emailForClaim, nome: state.profile.nome })
      }).catch(function () { /* best-effort only */ });
    }
    // Push the now-confirmed email (plus everything else) right away —
    // otherwise the admin view would keep showing this device with no
    // email until whatever the NEXT unrelated save/sync happened to be.
    if (state.profile.nome && state.profile.targa) reportActivity();
    startPresence();
    updatePresenceIfActive();
    // Keep watching, live, in case this same account gets deleted later
    // (e.g. from a browser tab) while this device stays open.
    watchForAccountDeletion(currentAccountEmail());
    assignDriverIdIfNeeded();
  }

  // Shows the driver's permanent ID in Impostazioni, once assigned —
  // stays hidden entirely until then, rather than showing an empty or
  // "pending" row. Tapping it copies the ID, since the whole point of
  // having one is to hand it to someone else (support, or eventually
  // an office/dispatcher) without having to type it out by hand.
  function renderDriverIdRow() {
    var row = document.getElementById('settings-driver-id-row');
    if (!row) return;
    if (!state.profile.driverId) { row.style.display = 'none'; return; }
    row.style.display = 'flex';
    document.getElementById('settings-driver-id-value').textContent = state.profile.driverId;
    if (row.dataset.wired) return; // listener attached once, ever — the row's own content updates independently on future opens
    row.dataset.wired = '1';
    row.addEventListener('click', function () {
      var id = state.profile.driverId;
      if (!id) return;
      var copyPromise = (navigator.clipboard && navigator.clipboard.writeText)
        ? navigator.clipboard.writeText(id)
        : Promise.reject();
      copyPromise.then(function () { toast('ID copiato: ' + id); })
        .catch(function () {
          // Clipboard API unavailable (older iOS webview, non-secure
          // context) — fall back to the classic selection+execCommand
          // trick rather than leaving the tap silently do nothing.
          var tmp = document.createElement('textarea');
          tmp.value = id; tmp.style.position = 'fixed'; tmp.style.opacity = '0';
          document.body.appendChild(tmp); tmp.focus(); tmp.select();
          try { document.execCommand('copy'); toast('ID copiato: ' + id); } catch (e) { /* nothing more to try */ }
          document.body.removeChild(tmp);
        });
    });
  }

  // A permanent, unique identity number for this account — like a
  // codice fiscale for the app itself. Two initials from the driver's
  // name, plus a number that only ever goes up, globally, across every
  // driver who has ever confirmed an account — assigned once, the
  // first time a genuine confirmation happens, and never reassigned
  // or reused afterward. Safe to call more than once: the database
  // function itself returns the SAME id on every later call for the
  // same email, it never generates a second one.
  function assignDriverIdIfNeeded() {
    var email = currentAccountEmail();
    if (!email || !state.profile.nome) return;
    if (state.profile.driverId) return; // already have one, cached locally — no need to ask again
    fetch(SUPABASE_URL + '/rest/v1/rpc/assign_driver_id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY },
      body: JSON.stringify({ p_email: email, p_full_name: state.profile.nome })
    }).then(function (res) { return res.json(); })
      .then(function (driverId) {
        if (driverId && typeof driverId === 'string') {
          state.profile.driverId = driverId;
          saveProfile(state.profile);
          renderDriverIdRow();
        }
      })
      .catch(function () { /* offline or blocked — tried again next time this same confirmation path runs */ });
  }

  // Tapping "Continua" on the just-confirmed screen — the actual close,
  // moved out of onEmailConfirmed() itself so the driver has a real,
  // deliberate moment to notice confirmation succeeded before access
  // opens up, instead of it happening silently underneath them.
  function dismissEmailConfirmedScreen() {
    emailModal.classList.remove('open');
    render();
    reloadIfUpdatePending();
  }
  document.getElementById('account-confirmed-continue-btn').addEventListener('click', dismissEmailConfirmedScreen);

  // A single, accurate error message for every "send the link" button —
  // Supabase enforces roughly one request per email per minute, and
  // hitting that is a completely normal, expected thing (not a real
  // connection problem), so it deserves its own clear message instead of
  // a generic, misleading "check your connection".
  function magicLinkErrorMessage(err) {
    if (err && err.rateLimited) return 'Hai già richiesto un link da poco — aspetta un minuto e riprova';
    return 'Invio non riuscito — controlla la connessione e riprova';
  }

  document.getElementById('email-step-back-to-name-btn').addEventListener('click', function () {
    cameFromEmailStepToEditName = true;
    emailModal.classList.remove('open');
    openSettingsModal(null);
  });

  document.getElementById('account-send-btn').addEventListener('click', function () {
    // REAL BUG, found and confirmed directly: only .trim() here, never
    // .toLowerCase() — typing the same email with even one different
    // capital letter than however it's already stored made the
    // identity-conflict check (and the confirmation-baseline lookup)
    // silently fail to find the existing record at all, since the
    // exact-match comparison server-side is case-sensitive. Reported
    // directly ("nu ma intreaba daca sunt eu persoana inregistrata") —
    // normalized here now, matching how email addresses are actually
    // treated everywhere in practice (case-insensitive).
    var email = document.getElementById('in-account-email').value.trim().toLowerCase();
    if (!email || email.indexOf('@') === -1) { toast('Inserisci un\'email valida'); return; }
    var btn = this;
    btn.disabled = true;

    // Requested directly ("cineva isi face contul si il va putea da la
    // mai multe persoane, care vor intra practic in conturile lor cu
    // acel email"): before doing anything else with this email, check
    // whether it already "belongs" (by its first-ever confirmed nome)
    // to a DIFFERENT person than whoever is sitting at THIS device
    // right now. A same person's own multi-device use (phone, PC,
    // tablet) keeps the SAME nome everywhere, so this never fires for
    // that legitimate case — only when the typed nome genuinely
    // doesn't match.
    var typedNomeForCheck = (document.getElementById('in-nome') ? document.getElementById('in-nome').value : state.profile.nome || '').trim();
    fetch(SUPABASE_URL + '/functions/v1/email-identity-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY },
      body: JSON.stringify({ email: email, nome: typedNomeForCheck })
    }).then(function (r) { return r.json(); })
      .catch(function () { return {}; }) // best-effort — a failed check here just means proceeding as if it were a fresh email, same as before this feature existed; never a HARDER block than before
      .then(function (identityData) {
        if (identityData && identityData.needsConfirmPrompt) {
          btn.disabled = false;
          showConfirm({
            title: 'Questo indirizzo è già registrato',
            message: 'Risulta già usato da "' + identityData.canonicalName + '". Sei tu, su un altro dispositivo?',
            confirmLabel: 'Sì, sono io',
            cancelLabel: 'No, non sono io',
            onConfirm: function () {
              // Requested directly: the name must only actually change
              // once the email is GENUINELY confirmed — not the moment
              // "Sì, sono io" is tapped. The field stays exactly as it
              // was, still editable, while this pending request is in
              // flight; only pendingCanonicalName is recorded here, as
              // a note for onEmailConfirmed() to apply for real if (and
              // only if) a genuine confirmation actually happens. If
              // the driver instead gets stuck on the pending screen
              // (an email they don't have access to) and taps "Cambia
              // email", this note is simply discarded — nothing to
              // undo, since nothing was ever changed in the first
              // place.
              state.profile.pendingCanonicalName = identityData.canonicalName;
              saveProfile(state.profile);
              proceedWithSend();
            },
            onCancel: function () {
              toast('Usa il tuo indirizzo email personale per registrarti');
            }
          });
          return;
        }
        proceedWithSend();
      });

    function proceedWithSend() {
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
      //
      // REAL SECURITY GAP, found and fixed directly ("acest email este
      // deja in baza de date, si vine recunoscut fara sa astepte
      // confirmarea"): a baseline last_sign_in_at is captured HERE, from
      // the server, BEFORE the magic link is actually sent — the later
      // polling (checkForConfirmationNow) only grants access once a
      // genuinely NEW sign-in happens AFTER this exact baseline, never
      // just because the email was confirmed by its real owner at some
      // earlier, unrelated point. Without this, typing in any email that
      // had EVER been confirmed before (by anyone, on any device) granted
      // access almost immediately, with no actual click required.
      fetch(SUPABASE_URL + '/functions/v1/check-email-confirmed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY },
        body: JSON.stringify({ email: email })
      }).then(function (r) { return r.json(); })
        .catch(function () { return {}; }) // best-effort baseline — a failed read here just means the very first poll after sending might need one extra tick to confirm, never a security downgrade
        .then(function (baselineData) {
          state.profile.pendingEmailBaseline = (baselineData && baselineData.lastSignInAt) || null;
          return requestMagicLink(email);
        })
        .then(function () {
          state.profile.pendingEmail = email;
          saveProfile(state.profile);
          toast('✓ Email inviata — controlla la tua posta');
          renderEmailRequiredModal();
        })
        .catch(function (err) { if (!err || !err.alreadyHandled) toast(magicLinkErrorMessage(err)); })
        .then(function () { btn.disabled = false; });
    }
  });

  // "Continua con Google" — requested directly, as an addition
  // alongside the existing email link, not a replacement. Uses the
  // exact same Supabase client and redirects back to the app's own
  // root, same as a confirmed magic link does, so it lands somewhere
  // the app already knows how to pick up a fresh session from.
  var googleBtn = document.getElementById('account-google-btn');
  if (googleBtn) {
    googleBtn.addEventListener('click', function () {
      if (!supabaseClient) { toast('Servizio non disponibile — verifica la connessione'); return; }
      supabaseClient.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.origin + '/' }
      }).then(function (result) {
        if (result.error) toast('Impossibile avviare l\'accesso con Google');
      });
    });
  }

  // Renders the two possible states of the dedicated email modal: still
  // needs an email typed in and sent, or already sent and waiting on
  // confirmation. (The "confirmed" case never renders here — the modal
  // closes itself the moment that happens, via onEmailConfirmed.)
  function renderEmailRequiredModal() {
    var loggedOut = document.getElementById('account-logged-out');
    var pending = document.getElementById('account-pending');
    document.getElementById('account-just-confirmed').classList.add('hidden'); // always starts hidden on a fresh render — only onEmailConfirmed() itself reveals it
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
    var originalLabel = btn.textContent;
    btn.disabled = true;
    requestMagicLink(email)
      .then(function () {
        toast('✓ Email inviata di nuovo a: ' + email);
        startResendCooldown(btn, originalLabel);
      })
      .catch(function (err) {
        toast(magicLinkErrorMessage(err));
        btn.disabled = false; // failed to send at all — no cooldown needed, let them retry right away
      });
  });

  // Requested directly: no way back existed from the "waiting for
  // confirmation" screen — only re-sending the SAME email over and
  // over. Real scenario: someone taps "Sì, sono io" on the identity-
  // conflict prompt out of curiosity or by mistake, ends up stuck
  // waiting on an email they don't actually have access to, with no
  // way to try their own, correct one instead.
  document.getElementById('account-change-email-btn').addEventListener('click', function () {
    state.profile.pendingEmail = '';
    state.profile.pendingEmailBaseline = null;
    // Simply discarded — the nome/nomeLocked fields were never actually
    // touched by the "Sì, sono io" identity-conflict confirmation (that
    // change only happens for real inside onEmailConfirmed(), once a
    // genuine confirmation actually goes through), so there's nothing
    // to restore here, just the pending note itself.
    state.profile.pendingCanonicalName = null;
    saveProfile(state.profile);
    renderEmailRequiredModal();
  });

  document.getElementById('account-remind-btn').addEventListener('click', function () {
    var session = getAuthSession();
    if (!session || !session.email) return;
    var btn = this;
    var originalLabel = btn.textContent;
    btn.disabled = true;
    requestMagicLink(session.email)
      .then(function () {
        toast('✓ Promemoria inviato a: ' + session.email);
        startResendCooldown(btn, originalLabel);
      })
      .catch(function (err) {
        toast(magicLinkErrorMessage(err));
        btn.disabled = false;
      });
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
            //
            // Same real race-condition risk as "Elimina tutti i dati"
            // (found and fixed there first) — even without an explicit
            // reload here, proceeding immediately without waiting means
            // a driver who closes the app, backgrounds it, or
            // navigates away right after tapping "Esci" could still cut
            // the request off mid-flight, leaving the account stuck on
            // the server exactly like before. Waited for properly now,
            // with the same safety timeout so a slow/unreachable
            // network never blocks the local logout itself.
            var emailToFree = currentAccountEmail();
            var deletionRequest = emailToFree
              ? fetchWithTimeout(SUPABASE_URL + '/functions/v1/delete-auth-account', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY },
                  body: JSON.stringify({ email: emailToFree })
                }, 8000).catch(function () { /* best-effort — local logout still proceeds either way */ })
              : Promise.resolve();
            deletionRequest.then(function () {
              logoutAccount();
              state.profile.pendingEmail = '';
              state.profile.emailConfirmed = false;
              saveProfile(state.profile);
              document.getElementById('settings-account-row').classList.add('hidden');
              toast('Disconnesso');
              openEmailRequiredModal();
            });
          }
        });
      }
    });
  });
  document.getElementById('btn-settings').addEventListener('click', function () { openSettingsModal(null); });
  document.getElementById('btn-navigatore').addEventListener('click', function () { showScreen('navigatore'); });
  document.getElementById('btn-novita').addEventListener('click', openNovitaModal);

  document.getElementById('btn-chat').addEventListener('click', openChatModal);
  document.getElementById('chat-close').addEventListener('click', function () {
    document.getElementById('modal-chat').classList.remove('open');
  });
  document.getElementById('chat-send').addEventListener('click', sendChatMessage);
  var chatInputEl = document.getElementById('chat-input');
  chatInputEl.addEventListener('input', function () {
    chatInputEl.style.height = 'auto';
    chatInputEl.style.height = Math.min(chatInputEl.scrollHeight, 100) + 'px';
  });
  // Requested directly: Enter/Invio on a real keyboard should only
  // ever add a new line — the textarea's own normal, default
  // behavior — never send. Sending only ever happens from a genuine
  // tap on the dedicated send button, nothing else. Removed the
  // keydown handler entirely rather than leaving an empty one behind.
  // Requested directly: tapping anywhere ABOVE the input bar (the
  // messages themselves) should dismiss the keyboard, matching how
  // WhatsApp and most real chat apps behave — blur() is what actually
  // closes an on-screen keyboard; there's no other way to trigger it
  // from JS.
  document.getElementById('chat-scroll').addEventListener('click', function () {
    chatInputEl.blur();
  });
  document.getElementById('novita-close-x').addEventListener('click', function () {
    document.getElementById('modal-novita').classList.remove('open');
  });
  document.getElementById('settings-cancel').addEventListener('click', function () {
    if (!state.profile.nome && !settingsTargetSheet) return; // force first-run completion
    settingsModal.classList.remove('open');
    // Requested directly: cancelling out of the "← Modifica nome/targa"
    // detour must still return to the mandatory email step — email
    // confirmation itself is untouched by backing out of an edit, so
    // it's still required either way.
    if (cameFromEmailStepToEditName) {
      cameFromEmailStepToEditName = false;
      openEmailRequiredModal();
      return;
    }
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
  // Live formatting as the driver types — attached once here (not
  // inside openSettingsModal, which runs every time the modal opens
  // and would otherwise stack duplicate listeners).
  document.getElementById('in-targa').addEventListener('input', function () {
    var cursorWasAtEnd = this.selectionStart === this.value.length;
    this.value = formatTarga(this.value);
    if (cursorWasAtEnd) this.setSelectionRange(this.value.length, this.value.length);
  });

  // Live province auto-fill — fires as the driver finishes typing the
  // city (on blur, not every keystroke, since a partial city name
  // mid-type would never match anyway). Only fills if Prov. is
  // currently empty — never overwrites something the driver already
  // typed themselves.
  document.getElementById('in-da').addEventListener('blur', function () {
    var provField = document.getElementById('in-prov-da');
    if (provField.value.trim()) return;
    var match = lookupProvinceForCity(this.value);
    if (match) provField.value = match;
  });

  document.getElementById('settings-save').addEventListener('click', function () {
    var nome = document.getElementById('in-nome').value.trim();
    var targa = document.getElementById('in-targa').value.trim().toUpperCase();
    var conto = document.getElementById('in-conto').value.trim().toUpperCase();
    var da = document.getElementById('in-da').value.trim().toUpperCase();
    var provDaTyped = document.getElementById('in-prov-da').value.trim().toUpperCase();
    // Requested directly: auto-detect the province from whatever
    // city was typed for Partenza predefinita, if the driver didn't
    // type one explicitly — covers the major Italian cities/provincial
    // capitals; anything not recognized is simply left for the driver
    // to fill in by hand, same as before this existed.
    var provDa = provDaTyped || lookupProvinceForCity(da) || '';
    var veicoloInterno = document.getElementById('in-veicolo-interno').value.trim();
    var dailyRateRaw = document.getElementById('in-daily-rate').value.trim();
    var dailyRate = dailyRateRaw === '' ? '' : Math.max(0, parseFloat(dailyRateRaw) || 0);

    if (!nome || !targa) { toast('Inserisci nome e targa'); return; }

    var wasFirstRun = !state.profile.nome;
    // Requested directly: mandatory consent checkbox, first-run only —
    // "Salva" itself is blocked without it, nothing gets saved at all
    // until it's checked.
    if (wasFirstRun) {
      var pushConsentBox = document.getElementById('in-push-consent');
      if (pushConsentBox && !pushConsentBox.checked) {
        toast('Devi accettare le notifiche push per continuare.');
        var consentRow = pushConsentBox.closest('#push-consent-row');
        consentRow.style.outline = '2px solid var(--accent)';
        consentRow.style.borderRadius = '10px';
        // Requested directly: the highlight alone wasn't enough if the
        // checkbox itself was scrolled out of view on a longer form —
        // the person had to go hunting for it themselves. Bringing it
        // into view automatically means it's right there, immediately,
        // no searching needed.
        consentRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
    }

    state.profile.nome = nome; state.profile.targa = targa; state.profile.perContoDi = conto;
    state.profile.da = da; state.profile.provDa = provDa;
    state.profile.veicoloInterno = veicoloInterno;
    state.profile.dailyRate = dailyRate;
    saveProfile(state.profile);
    startPresence(); // profile is minimally ready now — no need to wait for anything else
    // Requested directly: this exact tap on "Salva" (with the consent
    // box checked, already validated above) IS the direct user gesture
    // iOS requires — firing the real request right here, rather than
    // waiting for some later, unrelated tap on the home screen.
    if (wasFirstRun && pushSupported() && (!isIOSDevice() || isStandaloneApp)) {
      enablePushNotifications(function (ok) {
        if (ok || Notification.permission !== 'default') localStorage.setItem(LS_PUSH_OFFERED, '1');
      });
    }

    if (settingsTargetSheet) {
      settingsTargetSheet.nome = nome; settingsTargetSheet.targa = targa; settingsTargetSheet.perContoDi = conto;
      settingsTargetSheet.veicoloInterno = veicoloInterno;
      settingsTargetSheet.da = da; settingsTargetSheet.provDa = provDa;
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
    //
    // Requested directly: a "← Modifica nome/targa" link on the email
    // step itself, in case someone changes their mind before
    // confirming (the name isn't locked yet at that point, so nothing
    // is lost). wasFirstRun would be false here (nome already existed
    // from before going back), so it wouldn't reopen the email step on
    // its own — this flag makes sure it still does.
    if (cameFromEmailStepToEditName) {
      cameFromEmailStepToEditName = false;
      openEmailRequiredModal();
      return;
    }
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
    var defaultClient = (base ? base.perContoDi : state.profile.perContoDi) || '';
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
      var chosenClient = (document.getElementById('ms-client').value || '').trim().toUpperCase();
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

  // One-time re-verification of every SAVED client's stored
  // coordinates, using the precision check already added to
  // geocodeAddress() above (PRECISE_LAYERS) — that fix only guards
  // NEW geocodes going forward; any client saved BEFORE it existed
  // could still be sitting on an old, low-precision (city-level-only)
  // coordinate. Confirmed directly, concretely: ION's own real client
  // "ERREM IMPIANTI SRL" (Via Dell'Artigianato, Loreggia PD) — a
  // longtime, already-saved client — was exactly this case, and
  // auto-riordina's ordering fell apart specifically once it entered
  // the mix. Re-geocodes every already-saved client with existing
  // coordinates through the SAME (now-fixed) geocodeAddress(), and
  // corrects or clears the stored position wherever the fresh,
  // precision-checked result meaningfully disagrees with what was
  // saved. Runs once (a flag guards repeats), fully in the
  // background, rate-limited so it doesn't hammer the free-tier API
  // or the driver's data connection all at once.
  var LS_GEOCODE_PRECISION_MIGRATION_DONE = 'pt_geocode_precision_migration_v1_done';
  function migrateReverifyClientPrecision() {
    if (localStorage.getItem(LS_GEOCODE_PRECISION_MIGRATION_DONE) === '1') return;
    var toCheck = state.deliveryClients.filter(function (c) { return c.lat != null && c.lon != null && c.indirizzo; });
    if (!toCheck.length) { localStorage.setItem(LS_GEOCODE_PRECISION_MIGRATION_DONE, '1'); return; }

    var idx = 0;
    var changedCount = 0;
    function processNext() {
      if (idx >= toCheck.length) {
        localStorage.setItem(LS_GEOCODE_PRECISION_MIGRATION_DONE, '1');
        if (changedCount > 0) {
          saveDeliveryClients(state.deliveryClients);
          saveDeliveryRun(state.deliveryRun); // any today's-run entries updated below get persisted here too
        }
        return;
      }
      var c = toCheck[idx];
      idx++;
      geocodeAddress(c.indirizzo).then(function (result) {
        var oldLat = c.lat, oldLon = c.lon;
        if (!result) {
          // Nothing precise found at all now — clear rather than keep
          // a known-bad position; the client falls back to
          // "unverified" (queued at the end during Reordina) instead
          // of silently corrupting the route the way a wrong
          // coordinate does.
          c.lat = null; c.lon = null;
        } else if (Math.abs(result.lat - oldLat) > 0.01 || Math.abs(result.lon - oldLon) > 0.01) {
          // ~1km+ difference from the old saved position — far more
          // than normal geocoding precision variance for the SAME
          // real address, a strong sign the old value was a
          // different, less precise match (e.g. city-center instead
          // of the actual street).
          c.lat = result.lat; c.lon = result.lon;
        } else {
          return; // close enough to what was already saved — no real change, don't count it
        }
        changedCount++;
        state.deliveryRun.clients.forEach(function (rc) {
          if (rc.clientId === c.id) { rc.lat = c.lat; rc.lon = c.lon; }
        });
      }).catch(function () {
        // Network hiccup or similar — leave this one exactly as it
        // was, no worse than before. It'll simply be picked up again
        // whenever it's next re-geocoded for an unrelated reason
        // (e.g. the driver edits its address).
      }).then(function () {
        setTimeout(processNext, 350); // gentle pacing, not a burst of simultaneous requests
      });
    }
    processNext();
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

  // REAL BUG, reported directly, on Chrome for Android specifically
  // (not Safari — ruling out an earlier vh/dvh-specific diagnosis):
  // sheet modals stopped scrolling on a real device despite testing
  // correctly in every simulated environment, and different modals
  // opened at visibly inconsistent heights from each other.
  // window.innerHeight is the browser's own direct, live measurement
  // of the ACTUAL current viewport — not a CSS unit subject to any
  // engine-specific interpretation differences. Measured here, once,
  // written into --real-vh as a plain pixel value every .sheet-panel
  // rule now derives its height from — same value, same formula,
  // every modal, so they're always exactly the same size as each
  // other and never depend on any CSS viewport-unit's own quirks.
  function syncRealViewportHeight() {
    document.documentElement.style.setProperty('--real-vh', window.innerHeight + 'px');
  }

  // Same pattern as syncBarHeights above, for the Delivery Planner's
  // own fixed header block (title/stats/buttons) — its content
  // changes (stats update, the Casa/Deposito card appears or
  // disappears), so its real height needs re-measuring every time
  // renderDeliveryPlanner() actually renders it, not just once.
  function dpSyncStickyHeaderHeight() {
    var header = document.querySelector('.dp-sticky-header');
    document.documentElement.style.setProperty('--dp-header-h', header ? header.offsetHeight + 'px' : '0px');
  }

  /* ---------------------------------------------------------------- */
  /* Private usage reporting — lets ION (the app's creator) see, on a    */
  /* password-only page only he has, which drivers have installed the   */
  /* app and how active they are. The app can only SEND this data, never*/
  /* read anything back — no driver's phone can ever see this list.     */
  /* ---------------------------------------------------------------- */
  var SUPABASE_URL = 'https://chboalgzigdglygnnist.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNoYm9hbGd6aWdkZ2x5Z25uaXN0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY1NTc4MjMsImV4cCI6MjEwMjEzMzgyM30.vorEiww3SvVAadgnAqFH42M-MjbpXOojAlhNm-cIeMI';

  // Novità — a "what's new" feed (video tutorials, text updates,
  // announcements) that ION posts from the admin panel. The app only
  // ever reads PUBLISHED items directly, via the anon key — RLS on
  // the table itself already refuses anything not published, so this
  // fetch can't accidentally leak a draft even if the code here had a
  // bug, which is a nice extra layer of safety for free.
  var LS_NOVITA_LAST_SEEN = 'pt_novita_last_seen_v1';
  var CHAT_EDGE_URL = SUPABASE_URL + '/functions/v1/chat-messages';
  var NOVITA_TYPE_LABELS_APP = { video: 'Video', text: 'Novità', announcement: 'Annuncio' };

  // Real phone push notifications — entirely separate opt-in, on top
  // of the unconditional in-app red dot above. Off by default for
  // everyone; a driver turns it on (or back off) explicitly, only
  // from Impostazioni → Altre opzioni.
  var VAPID_PUBLIC_KEY = 'BE8wkq3SQmoE8L8x0pFVwYaLym1EYB14_NABB1qEiVOi0VvOpUDYAODObA5Lirh9Kfy6C97ExU5btOYLG7uHvgk';

  function urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var rawData = atob(base64);
    var outputArray = new Uint8Array(rawData.length);
    for (var i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
    return outputArray;
  }

  function pushSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }

  // Requested directly: ION wants to distinguish, in admin, someone
  // who explicitly declined the native prompt from someone who simply
  // hasn't been asked yet — the browser itself never reports a
  // "denied" decision back to any server on its own, so the app has
  // to send it, at the one moment this information genuinely exists:
  // right when the native dialog itself resolves to "denied".
  function markPushDenied() {
    fetch(SUPABASE_URL + '/functions/v1/push-subscription', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'mark_denied', device_id: getDeviceId() })
    }).catch(function () { /* best-effort — admin's view just won't reflect this one denial if it fails */ });
  }

  // Requested directly: the visible push-notifications toggle (and
  // this function that kept it in sync) was removed from Impostazioni
  // entirely — seeing "once accepted, this stays on for good" risked
  // giving someone the idea to uninstall/reinstall just to get around
  // it. The underlying request itself is unaffected, still automatic
  // on first launch of the installed app.

  // Requested directly: rather than waiting for someone to find the
  // toggle themselves in Impostazioni, ask once, automatically, right
  // after they've genuinely finished onboarding (email confirmed,
  // "Continua" tapped) — the natural "welcome, you're all set"
  // moment. Browsers still show their own native permission prompt
  // regardless (no site can silently turn this on — that's a
  // platform rule, not something this app controls).
  //
  // REAL BUG, found directly while investigating the exact same class
  // of issue already found and fixed once in admin: this used to mark
  // itself "already offered" the INSTANT it ran, before knowing
  // whether a subscription actually succeeded — a genuine failure
  // along the way (permission prompt dismissed without answering, a
  // transient service-worker hiccup, the subscribe() call itself
  // failing) meant this single, real shot could be silently lost to a
  // technical glitch, with no way to retry automatically afterward —
  // only ever leaving the manual toggle in Impostazioni, which most
  // people would never think to go find. Only marks "offered" now
  // once truly subscribed, so a first attempt lost to a genuine
  // hiccup (not an explicit decline) gets a real second chance next
  // time the app opens, instead of being gone for good after one bad
  // roll.
  var LS_PUSH_OFFERED = 'pt_push_offered_v1';
  // Requested directly, after two real-device tests: the very first
  // attempt showed nothing at all (iOS silently drops the request
  // unless it's tied to a direct tap); a follow-up attempt with a
  // custom "Attiva notifiche" screen worked, but ION wanted the
  // custom screen gone entirely — only the phone's own native dialog
  // should ever appear, riding on whatever the person taps first
  // anyway, not a dedicated app screen for this. This arms a
  // one-time, global tap listener instead of calling anything
  // immediately: the very next genuine tap anywhere in the app (the
  // gesture iOS actually requires) fires the real request in the
  // background, with nothing extra shown beforehand.
  var pushArmedListener = null;
  function offerPushNotificationsIfSensible() {
    if (!pushSupported()) return;
    if (localStorage.getItem(LS_PUSH_OFFERED)) return;
    // On iOS specifically, web push only exists at all for an
    // installed (Home Screen) app — a plain browser tab there can
    // never request or receive push, no matter what code runs. This
    // check is iOS-specific; Android has no such restriction.
    if (isIOSDevice() && !isStandaloneApp) return;
    // REAL BUG, found directly from ION's own real-device test: an
    // account that had previously granted the browser's OWN
    // permission (Chrome's site settings remember that decision per
    // ORIGIN — deleting the app's own local data, or even the
    // account, does NOT reset it) landed back on Notification.
    // permission === 'granted' immediately, with no fresh decision
    // needed or possible — but a genuinely NEW subscription (tied to
    // THIS install's own device_id) had never been created for the
    // server side to actually reach. The old code only ever handled
    // 'default', silently doing nothing for an already-granted origin
    // that still needed subscribing. Now: 'granted' subscribes right
    // away, with no tap needed at all (there's nothing left to ask —
    // the browser already decided); 'default' still waits for a
    // genuine first tap, since only that state can show a fresh
    // native prompt at all.
    if (Notification.permission === 'granted') {
      navigator.serviceWorker.ready.then(function (reg) {
        reg.pushManager.getSubscription().then(function (existingSub) {
          if (existingSub) { localStorage.setItem(LS_PUSH_OFFERED, '1'); return; }
          subscribeToPush(function (ok) {
            if (ok) localStorage.setItem(LS_PUSH_OFFERED, '1');
          });
        });
      });
      return;
    }
    if (Notification.permission !== 'default') {
      // 'denied' — a deliberate past choice, respected as final; no
      // need to keep re-checking this on every future render. Also
      // reported to admin here too — covers someone who denied it a
      // long time ago, before admin's own denied-tracking existed.
      if (Notification.permission === 'denied') { localStorage.setItem(LS_PUSH_OFFERED, '1'); markPushDenied(); }
      return;
    }
    if (pushArmedListener) return; // already armed, waiting for that first tap
    pushArmedListener = function () {
      document.removeEventListener('click', pushArmedListener, true);
      pushArmedListener = null;
      // Re-check right before firing — something could have changed
      // in the moments between arming this and the actual tap (e.g.
      // permission already decided some other way).
      if (localStorage.getItem(LS_PUSH_OFFERED)) return;
      if (Notification.permission !== 'default') return;
      enablePushNotifications(function (ok) {
        if (ok) localStorage.setItem(LS_PUSH_OFFERED, '1');
      });
    };
    // Capture phase, so this fires before the tapped element's own
    // handler — the permission prompt and whatever the person meant
    // to do can genuinely happen together, not one blocking the other.
    document.addEventListener('click', pushArmedListener, true);
  }

  // Requested directly: separated from enablePushNotifications below,
  // since that function always called requestPermission() first — but
  // when permission is ALREADY 'granted' from earlier browser history
  // (ION's real-device test: Chrome remembers this decision per
  // ORIGIN, surviving both an account deletion and a full reinstall),
  // there's nothing left to ask — calling requestPermission() again
  // in that case, outside of any direct tap, was itself failing
  // silently. This does just the subscribe-and-save part alone.
  function subscribeToPush(onDone) {
    var toggle = document.getElementById('push-notif-toggle');
    navigator.serviceWorker.ready.then(function (reg) {
      reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
      }).then(function (sub) {
        fetch(SUPABASE_URL + '/functions/v1/push-subscription', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'subscribe', device_id: getDeviceId(), subscription: sub.toJSON() })
        }).then(function () {
          if (toggle) toggle.classList.add('on');
          toast('Notifiche attivate');
          if (onDone) onDone(true);
        }).catch(function () { if (onDone) onDone(false); });
      }).catch(function () {
        toast('Non è stato possibile attivare le notifiche su questo dispositivo.');
        if (onDone) onDone(false);
      });
    }).catch(function () { if (onDone) onDone(false); });
  }

  function enablePushNotifications(onDone) {
    Notification.requestPermission().then(function (perm) {
      if (perm !== 'granted') {
        toast('Permesso negato — puoi riattivarlo dalle impostazioni del telefono in qualsiasi momento.');
        // An explicit "denied" is the person's own deliberate choice —
        // that counts as a completed offer, not a glitch to retry.
        // Anything else (prompt dismissed without answering) leaves
        // the door open for a genuine retry next time.
        if (perm === 'denied') markPushDenied();
        if (onDone) onDone(perm === 'denied');
        return;
      }
      subscribeToPush(onDone);
    }).catch(function () { if (onDone) onDone(false); });
  }

  // Requested directly: notifications, once accepted, should never be
  // turned back off from inside the app — removed the disable path
  // entirely (this function used to live here, wired to the toggle's
  // "on" state) rather than leaving unreachable dead code behind.

  function checkNovitaUnread() {
    fetch(SUPABASE_URL + '/rest/v1/app_novita?select=created_at&published=eq.true&order=created_at.desc&limit=1', {
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY }
    }).then(function (r) { return r.json(); })
      .then(function (rows) {
        if (!rows || !rows.length) return;
        var lastSeen = localStorage.getItem(LS_NOVITA_LAST_SEEN);
        var dot = document.getElementById('novita-unread-dot');
        if (dot) dot.style.display = (rows[0].created_at !== lastSeen) ? 'block' : 'none';
      })
      .catch(function () { /* offline — dot simply doesn't update this time, not worth surfacing */ });
  }

  // Support chat with ION — requested directly, one continuous thread
  // per driver, WhatsApp-style. checkChatUnread() is the lightweight,
  // badge-only check (called on load and periodically); openChatModal
  // loads and renders the full thread, and marks everything read.
  function chatCall(payload) {
    return fetch(CHAT_EDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json(); }).then(function (data) { return { ok: !data.error, data: data }; })
      .catch(function () { return { ok: false, data: null }; });
  }

  function checkChatUnread() {
    chatCall({ action: 'driver_list', device_id: getDeviceId() }).then(function (res) {
      var badge = document.getElementById('chat-unread-badge');
      if (!badge || !res.ok || !res.data.items) return;
      var unreadCount = res.data.items.filter(function (m) { return m.sender === 'admin' && !m.read_by_driver; }).length;
      if (unreadCount > 0) {
        badge.textContent = unreadCount > 9 ? '9+' : String(unreadCount);
        badge.style.display = 'flex';
      } else {
        badge.style.display = 'none';
      }
    });
  }

  function chatBubbleTime(iso) {
    var d = new Date(iso);
    return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
  }

  function chatDayLabel(iso) {
    var d = new Date(iso);
    var today = new Date();
    var isToday = d.toDateString() === today.toDateString();
    var yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
    var isYesterday = d.toDateString() === yesterday.toDateString();
    if (isToday) return 'Oggi';
    if (isYesterday) return 'Ieri';
    return d.toLocaleDateString('it-IT', { day: 'numeric', month: 'long' });
  }

  function renderChatMessages(items) {
    var container = document.getElementById('chat-messages');
    var emptyEl = document.getElementById('chat-empty');
    if (!items || !items.length) {
      container.innerHTML = '';
      emptyEl.style.display = 'block';
      return;
    }
    emptyEl.style.display = 'none';
    var html = '';
    var lastDay = null;
    var nowMs = Date.now();
    items.forEach(function (m) {
      var day = chatDayLabel(m.created_at);
      if (day !== lastDay) {
        html += '<div class="chat-day-divider">' + day + '</div>';
        lastDay = day;
      }
      // Requested directly: a message can be corrected for one minute
      // after sending, in case it went out with a typo — the actual
      // 60s cutoff is enforced server-side regardless, this is just
      // when the pencil icon itself is offered.
      var canEdit = m.sender === 'driver' && (nowMs - new Date(m.created_at).getTime()) < 180000;
      var editBtn = canEdit ? '<button class="chat-edit-btn" data-edit-id="' + m.id + '" data-edit-text="' + escapeHtml(m.message) + '">✎ Modifica</button>' : '';
      var editedTag = m.edited ? ' <span style="opacity:.6;">(modificato)</span>' : '';
      html += '<div class="chat-bubble ' + (m.sender === 'driver' ? 'driver' : 'admin') + '">' +
        escapeHtml(m.message).replace(/\n/g, '<br>') + editedTag +
        '<span class="chat-bubble-time">' + chatBubbleTime(m.created_at) + editBtn + '</span></div>';
    });
    container.innerHTML = html;
    container.querySelectorAll('.chat-edit-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        chatEditingMessageId = btn.getAttribute('data-edit-id');
        var input = document.getElementById('chat-input');
        input.value = btn.getAttribute('data-edit-text');
        input.focus();
        document.getElementById('chat-send').classList.add('editing');
      });
    });
    var scrollEl = document.getElementById('chat-scroll');
    scrollEl.scrollTop = scrollEl.scrollHeight;
  }

  // REAL BUG, found directly, on careful re-inspection of the app's own
  // base architecture: <body> here is ALREADY position:fixed;inset:0;
  // overflow:hidden, permanently, by design (built to feel native, with
  // no page-level scrolling ever). A previous attempt at this exact
  // keyboard issue added a JS-based "lock the body" mechanism on top of
  // this — completely redundant (the body could never scroll in the
  // first place), and worse, it actively SET document.body.style.top to
  // values that had never needed to change before, likely the real
  // source of the very glitch it was meant to fix. Removed entirely.

  // Requested directly, confirmed specifically as an Android issue
  // (the input row itself already correctly rises above the keyboard
  // there — only the scroll position doesn't follow, leaving the
  // latest message hidden until scrolled to by hand). Re-scrolling to
  // the bottom whenever the visual viewport resizes (which is exactly
  // when the keyboard opens or closes) keeps the latest message in
  // view automatically, matching what already happens right after
  // sending or receiving a message.
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', function () {
      if (!document.getElementById('modal-chat').classList.contains('open')) return;
      var scrollEl = document.getElementById('chat-scroll');
      scrollEl.scrollTop = scrollEl.scrollHeight;
    });
  }

  function openChatModal() {
    document.getElementById('modal-chat').classList.add('open');
    chatCall({ action: 'driver_list', device_id: getDeviceId() }).then(function (res) {
      if (res.ok) renderChatMessages(res.data.items);
      chatCall({ action: 'driver_mark_read', device_id: getDeviceId() }).then(function () {
        var badge = document.getElementById('chat-unread-badge');
        if (badge) badge.style.display = 'none';
      });
    });
  }

  var chatEditingMessageId = null;

  function sendChatMessage() {
    var input = document.getElementById('chat-input');
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.style.height = 'auto';
    var editingId = chatEditingMessageId;
    chatEditingMessageId = null;
    document.getElementById('chat-send').classList.remove('editing');
    var call = editingId
      ? chatCall({ action: 'driver_edit', device_id: getDeviceId(), id: editingId, message: text })
      : chatCall({ action: 'driver_send', device_id: getDeviceId(), account_email: currentAccountEmail(), message: text });
    call.then(function (res) {
      if (res.ok) {
        chatCall({ action: 'driver_list', device_id: getDeviceId() }).then(function (r2) {
          if (r2.ok) renderChatMessages(r2.data.items);
        });
      } else {
        toast(editingId ? 'Tempo scaduto per la modifica' : 'Impossibile inviare — verifica la connessione');
        if (!editingId) input.value = text; // give the message back so nothing typed is lost
      }
    });
  }

  function renderNovitaItem(item) {
    var html = '<div class="novita-item-card">';
    html += '<div class="novita-item-type">' + (NOVITA_TYPE_LABELS_APP[item.type] || item.type) + '</div>';
    html += '<div class="novita-item-title">' + escapeHtml(item.title) + '</div>';
    if (item.description) html += '<div class="novita-item-desc">' + escapeHtml(item.description) + '</div>';
    if (item.type === 'video' && item.youtube_id) {
      html += '<div class="novita-item-video"><iframe src="https://www.youtube.com/embed/' + encodeURIComponent(item.youtube_id) + '" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen loading="lazy"></iframe></div>';
    }
    html += '</div>';
    return html;
  }

  function openNovitaModal() {
    var modal = document.getElementById('modal-novita');
    var listEl = document.getElementById('novita-app-list');
    modal.classList.add('open');
    listEl.innerHTML = '<div class="novita-empty">Caricamento…</div>';

    fetch(SUPABASE_URL + '/rest/v1/app_novita?select=*&published=eq.true&order=created_at.desc', {
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY }
    }).then(function (r) { return r.json(); })
      .then(function (items) {
        if (!items || !items.length) {
          listEl.innerHTML = '<div class="novita-empty">Nessuna novità al momento — torna a trovarci presto.</div>';
          return;
        }
        listEl.innerHTML = items.map(renderNovitaItem).join('');
        // Mark as seen using the newest item's own timestamp — simple,
        // and self-correcting: if ION later back-dates or edits an
        // older item, that alone won't wrongly re-flag it as new.
        localStorage.setItem(LS_NOVITA_LAST_SEEN, items[0].created_at);
        var dot = document.getElementById('novita-unread-dot');
        if (dot) dot.style.display = 'none';
      })
      .catch(function () {
        listEl.innerHTML = '<div class="novita-empty">Impossibile caricare le novità — controlla la connessione.</div>';
      });
  }

  // A live connection to Supabase (via the vendored supabase-js library) —
  // this is what actually lets a browser tab and the installed app "see"
  // the same reality instantly: both hold their own independent
  // connection to the server, and the moment the server-side confirmation
  // status changes (however it happened, wherever), it pushes the update
  // to every connected client within roughly a second. Neither context
  // ever talks to the other directly — they don't need to, since they're
  // both just watching the same live server state.
  // Requested directly, after confirming the exact scenario (a FORCED,
  // full app close from the recent-apps list, not just backgrounding
  // it): the explicit "gone" signal on hide/pagehide only fires if the
  // OS gives JS time to run it — a genuine force-quit can terminate
  // the process before that has a chance to happen, leaving detection
  // to fall back on Supabase's own connection-timeout mechanism
  // instead, tied to how often the client "checks in" (its heartbeat).
  // The default is roughly 25-30 seconds — reduced here to make that
  // fallback path itself faster too, so even the force-quit case
  // clears within a shorter, bounded window instead of the longer
  // default one. This can't ever be truly instant for a genuinely
  // killed process (nothing can run JS after the OS has already ended
  // it) — this only shortens the WORST-CASE wait once it does fall
  // back to timeout-based detection.
  var supabaseClient = (typeof supabase !== 'undefined' && supabase.createClient)
    ? supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { realtime: { heartbeatIntervalMs: 10000 } })
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
  // Requested directly, real scenario reported: pressing "resend" more
  // than once in a short window invalidates the PREVIOUS email's link
  // (Supabase issues a fresh one-time token on every request) — someone
  // who clicks resend, doesn't see it arrive instantly, and clicks
  // again "just in case" silently kills their first email's link. The
  // buttons already disabled themselves WHILE the request was in
  // flight, but re-enabled immediately after — nowhere near long
  // enough to stop this. This enforces a real, visible cooldown
  // (60s, matching Supabase's own OTP rate-limit window) after a
  // successful send, on whichever button triggered it, with a visible
  // countdown so it's clear why — not just a silently-disabled button.
  function startResendCooldown(btn, originalLabel) {
    var seconds = 60;
    btn.disabled = true;
    var tick = function () {
      if (seconds <= 0) {
        btn.disabled = false;
        btn.textContent = originalLabel;
        return;
      }
      btn.textContent = 'Attendi ' + seconds + 's...';
      seconds -= 1;
      setTimeout(tick, 1000);
    };
    tick();
  }

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
    // REAL BUG, reported directly: registering by email locks the name
    // after confirmation (a real anti-abuse protection — the same
    // account/identity can't quietly become a different person later),
    // but signing in with Google skipped this entirely, since that
    // flow never runs onEmailConfirmed() at all — it lands back here
    // instead, through this exact same-shaped redirect. Applying the
    // identical lock here too, so both paths behave consistently, not
    // just the email one.
    if (!state.profile.nomeLocked) {
      state.profile.nomeLocked = true;
      saveProfile(state.profile);
    }
    history.replaceState(null, '', window.location.pathname + window.location.search);
    toast(email ? ('Accesso effettuato: ' + email) : 'Accesso effettuato');
  }
  handleAuthCallback();

  // REAL BUG, found directly: the "opened as installed app" signal
  // (display-mode:standalone / navigator.standalone) reported directly
  // in admin turned out to be WRONG for at least one real, confirmed
  // case — researched rather than guessed at, and found a genuinely
  // well-known, years-old, still-unfixed bug specifically in Samsung
  // Internet (extremely common on Samsung phones): it reports "browser"
  // even while genuinely running standalone, from the home screen icon.
  // Neither existing check can ever catch this, since the browser
  // itself is answering wrong. A THIRD, independent signal instead:
  // the manifest's start_url now carries a marker (?src=pwa) that can
  // only ever be present when actually launched via the home screen
  // icon (typing the URL, a bookmark, or a shared link never includes
  // it) — captured once, right at launch, into localStorage, so it
  // stays available for every later reportActivity() call in this
  // session, regardless of any in-app navigation since.
  if (window.location.search.indexOf('src=pwa') !== -1) {
    try { localStorage.setItem('pt_launched_as_pwa_v1', '1'); } catch (e) { /* storage unavailable — falls back to the other two signals */ }
  }

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
    if (!state.profile.nome) return Promise.resolve(); // nothing meaningful to report yet — still a promise, so callers chaining off this (e.g. reportDailyOpen, which needs this row to exist first) never break
    syncSheetSummaries();
    var active = latestSheet();
    var month = active ? active.month : null;
    var year = active ? active.year : null;
    var earnings = (month && year) ? monthEarnings(month, year) : { workedDaysCount: 0 };
    var deviceId = getDeviceId();
    // Requested directly: an indicator in admin, per driver, showing
    // whether they actually installed the app (added to home screen)
    // or are just using it through the browser. display-mode:standalone
    // is the modern, cross-platform way to detect this (works on
    // Android); navigator.standalone is the older, iOS-only signal —
    // checking both together covers every device, since neither alone
    // is universal (learned the hard way, with navigator.standalone's
    // own detection bug just fixed above). A THIRD signal added after
    // a real, confirmed case neither of the above caught: Samsung
    // Internet has a long-standing, well-documented bug reporting
    // "browser" even while genuinely running standalone — the
    // start_url's own ?src=pwa marker (captured once, near launch,
    // into localStorage — see above) sidesteps that entirely, since
    // it can only ever be present when actually opened via the home
    // screen icon, regardless of what the browser itself claims.
    var launchedAsPwaMarker = false;
    try { launchedAsPwaMarker = localStorage.getItem('pt_launched_as_pwa_v1') === '1'; } catch (e) { /* storage unavailable — falls back to the other two signals */ }
    var isInstalled = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true || launchedAsPwaMarker;
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
    // REAL BUG, reported directly: the SAME device sometimes opens
    // through the browser (no install detected that particular time —
    // maybe a genuinely different launch, maybe one of the several
    // real detection quirks already found and researched, like Samsung
    // Internet's own long-standing bug misreporting standalone mode)
    // and this column simply got overwritten with FALSE every single
    // time that happened, discarding a real, previously-confirmed
    // "yes, this person has it installed" — visible in admin as the
    // badge flipping back and forth on every open, exactly as reported.
    // Fixed at the source: only ever SEND this field when it's
    // genuinely detected true THIS time — otherwise it's left out of
    // the payload entirely, so the update simply never touches this
    // column, and whatever was already stored (true, from some earlier,
    // correctly-detected installed session) stays exactly as it was.
    // Once true, always true — never written back to false by a later,
    // ordinary browser visit.
    if (isInstalled) payload.is_installed = true;
    // A genuine, native upsert — reliable now that anon has SELECT
    // permission on this table (PostgreSQL requires it for the UPDATE
    // path of INSERT ... ON CONFLICT DO UPDATE, even with INSERT/UPDATE
    // otherwise fully granted — without it, this silently failed to
    // find/update existing rows).
    // Returned (not just fired) so reportDailyOpen can chain safely
    // after this specific row is confirmed to exist — its own update
    // otherwise has nothing to find on a driver's very first-ever open.
    return fetch(SUPABASE_URL + '/rest/v1/driver_activity?on_conflict=device_id', {
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

  // Counts one genuine app open for today, for the admin view — called
  // once here in init(), never on every subsequent save/sync, so it
  // reflects how many separate TIMES the driver actually opened the
  // app today, not how many times something happened to get saved.
  // Fire-and-forget, same as reportActivity right above it — a missed
  // count on a flaky connection is a minor cosmetic gap, never worth
  // blocking or retrying against the app's real purpose.
  function reportDailyOpen() {
    if (!state.profile.nome) return;
    fetch(SUPABASE_URL + '/rest/v1/rpc/increment_daily_open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY },
      body: JSON.stringify({ p_device_id: getDeviceId() })
    }).catch(function () { /* offline or blocked — never blocks the app, simply not counted this time */ });
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


  // Requested directly, part of the fleet system's "Storico consegne"
  // screen: pushes each ACTUALLY-completed delivery (name, address,
  // when) the moment a day's clients get archived — same lightweight-
  // summary spirit as syncSheetSummaries right below (no photos, those
  // stay on-device), just per-delivery instead of per-sheet. Only
  // ever called with the exact clients dpArchiveRunToHistory is about
  // to archive, so this naturally fires once per real archiving event,
  // never re-sending days already sent before.
  function syncDeliveriesToServer(clients) {
    if (!state.profile.nome || !clients || !clients.length) return;
    var deviceId = getDeviceId();
    var accountEmail = currentAccountEmail();
    var rows = clients
      .filter(function (c) { return c.status === 'completed' && c.completedAt; })
      .map(function (c) {
        var completedIso = new Date(c.completedAt).toISOString();
        return {
          account_email: accountEmail, device_id: deviceId,
          client_nome: c.nome || '', client_indirizzo: c.indirizzo || '',
          completed_at: completedIso, delivery_date: completedIso.slice(0, 10)
        };
      });
    if (!rows.length) return;
    fetch(SUPABASE_URL + '/rest/v1/driver_deliveries?on_conflict=device_id,client_nome,completed_at', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify(rows)
    }).catch(function () { /* offline or blocked — silently skip, same as syncSheetSummaries */ });
  }

  // Requested directly, as the other half of the fix above: removes a
  // delivery from the server the moment it's un-checked back to
  // pending — otherwise a corrected mistake would leave a stale
  // "ghost" entry visible forever on the fleet's own Consegne screen.
  // Identified by the same natural key already used for the insert
  // (device_id, client_nome, completed_at) — one DELETE call per item,
  // since this only ever fires for the handful a driver just unchecked.
  function deleteDeliveriesFromServer(items) {
    if (!items || !items.length) return;
    var deviceId = getDeviceId();
    items.forEach(function (item) {
      if (!item.completedAt) return; // nothing was ever sent for this one — no matching server row to remove
      var completedIso = new Date(item.completedAt).toISOString();
      var url = SUPABASE_URL + '/rest/v1/driver_deliveries'
        + '?device_id=eq.' + encodeURIComponent(deviceId)
        + '&client_nome=eq.' + encodeURIComponent(item.nome || '')
        + '&completed_at=eq.' + encodeURIComponent(completedIso);
      fetch(url, {
        method: 'DELETE',
        headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY }
      }).catch(function () { /* offline or blocked — silently skip */ });
    });
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
        worked_days_count: kt.workedDays || 0,
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
    // Requested directly: point friends being invited at the
    // marketing/presentation page (with the tutorial video, gallery,
    // FAQ) rather than straight at the app's own root — someone who
    // doesn't have it yet benefits from seeing what it does first,
    // not landing straight on the onboarding screen.
    var shareUrl = window.location.origin + '/official/';
    // Requested directly: this only mentioned the trip-log document —
    // outdated, given how much the app covers now. A follow-up request
    // specifically called out the route-ordering feature (Reordina/
    // Auto) as important enough to name explicitly, not just imply
    // through "organizzare le consegne".
    // Requested directly, follow-up: too many connecting words ("prea
    // multa apa") — punchy standalone keywords instead of full
    // sentences. Also fixed "itinerario", which doesn't match the
    // app's own language at all (the screen itself is called
    // "Percorso di oggi") — replaced with "percorso", consistent and
    // instantly clear to anyone who's actually used the app.
    // Requested directly, complete list of real benefits given
    // explicitly ("cuvinte care vand... beneficii pure concrete fara
    // apa") — pure keyword-benefits, zero connecting words, zero
    // explanation. Covers: foglio viaggi automatico, percorso
    // ottimizzato, km/stipendio calcolati da soli, scontrini
    // digitali, documenti auto-compilati a fine mese, archivio
    // clienti+consegne, meno carta/burocrazia (capo contento).
    // Requested directly, shortened: the fuller version felt too
    // long — cut the closing pairing line and the "A fine mese"
    // sentence, keeping the core title, the single feature paragraph,
    // and the punchy three-line close.
    var shareText = 'ADB Smart — tutto il lavoro dell\'autista, semplificato\n' +
      'Auto-compilazione del foglio viaggio digitale, ottimizzazione automatica del percorso, calcolo di km e stipendio, gestione di scontrini e documenti, archivio completo di clienti e consegne\n' +
      'Meno carta. Meno tempo perso. Più controllo';
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
            // REAL BUG, found and confirmed directly, tracing exactly
            // this scenario in the live database: the local wipe
            // (Benvenuto shown again) succeeded every time, but the
            // account kept surviving on the server. Root cause — a
            // genuine race condition: the request to actually delete
            // the account was fire-and-forget (no await at all), and
            // window.location.reload() ran IMMEDIATELY afterward,
            // destroying the whole page/JS context before the request
            // had any real chance to even reach the server, let alone
            // finish — browsers abort in-flight fetch() calls the
            // moment a page unloads. Free up the email on the server
            // too, exactly like "Esci" does — otherwise it would stay
            // "confirmed" there forever, even though every trace of it
            // just got wiped locally, blocking this same person from
            // ever registering it again if they decide to start over.
            // Unlike "Esci" though, this is a genuinely complete wipe
            // — also asks the server to remove this device's rows from
            // the admin view entirely, not just free the email.
            //
            // Fixed by actually WAITING for that request now (with a
            // safety timeout, so a slow or unreachable network can
            // never block the local wipe from happening at all — the
            // driver's own data on their own phone is never held
            // hostage by a flaky connection) — the reload only fires
            // once the request has genuinely either finished or
            // definitively given up.
            var emailToFree = currentAccountEmail();
            var deletionRequest = emailToFree
              ? fetchWithTimeout(SUPABASE_URL + '/functions/v1/delete-auth-account', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY },
                  body: JSON.stringify({ email: emailToFree, wipe_activity_data: true, device_id: getDeviceId() })
                }, 8000).catch(function () { /* best-effort — local wipe still proceeds either way, even if this genuinely failed or timed out */ })
              : Promise.resolve();
            deletionRequest.then(function () {
              try { localStorage.clear(); } catch (e) { /* ignore */ }
              window.location.reload();
            });
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
          // REAL BUG, reported directly, TWICE — the first fix
          // (waiting for a 'controllerchange' before reloading) still
          // didn't help, and reasoning through WHY revealed the
          // actual, deeper problem: the service worker is registered
          // at a URL that has THIS PAGE's OWN (old) version baked
          // into it — 'sw.js?v=' + APP_VERSION. registration.update()
          // can only ever check THAT SAME URL for changes — it has no
          // way to discover a service worker living at a DIFFERENT,
          // newer versioned URL. A genuinely new service worker only
          // gets registered once a page has ALREADY reloaded with
          // fresh HTML containing the new version number — meaning
          // 'controllerchange' could never fire from update() here in
          // the first place. The wait added by the first fix was
          // real, but waiting for something that structurally cannot
          // happen just meant it silently fell through to its 4s
          // safety-net reload every time — functionally identical to
          // the original bug, just slower.
          //
          // Fixed properly this time: unregister the current service
          // worker and clear every cache this origin owns BEFORE
          // reloading. With nothing old left to intercept anything,
          // the reload is guaranteed to be a genuinely clean, direct
          // network load — no stale registration, no stale cache, no
          // version-URL mismatch left to get stuck on.
          Promise.all([
            navigator.serviceWorker.getRegistrations().then(function (regs) {
              return Promise.all(regs.map(function (r) { return r.unregister(); }));
            }),
            (window.caches ? caches.keys().then(function (keys) {
              return Promise.all(keys.map(function (k) { return caches.delete(k); }));
            }) : Promise.resolve())
          ]).catch(function () { /* best-effort — reload below regardless, even if a step here failed */ })
            .then(function () { window.location.reload(); });
        } else {
          toast('Hai già la versione più recente ✓');
        }
      })
      .catch(function () {
        toast('Impossibile verificare — controlla la connessione');
      });
  });
  // Requested directly: the vehicle profile was only reachable through
  // a small text link on the Delivery Planner screen itself ("Profilo
  // veicolo: Furgone ›") — easy to miss entirely if the driver never
  // happened to notice it, meaning some drivers may never have
  // discovered they could switch off the default HGV-restricted
  // routing profile (which meaningfully changes how routes get
  // calculated — see dpCallOrsOptimization) even when their real
  // vehicle doesn't need those restrictions. Added here too, in
  // Impostazioni's own "Altre opzioni" menu — a place any driver
  // already knows to check for settings, independent of whether
  // they've ever opened the Delivery Planner screen at all.
  document.getElementById('more-opt-vehicle').addEventListener('click', function () {
    moreOptionsModal.classList.remove('open');
    populateNavVehicleForm();
    document.getElementById('modal-nav-vehicle').classList.add('open');
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
    // REAL BUG, found and confirmed directly by ION: this only ever
    // exported profile/sheets/currentSheetId/fuel — everything built
    // SINCE then (vehicle config, and the entire Delivery Planner:
    // saved clients, today's run, archived history, remembered
    // addresses, Casa/Deposito shortcuts) was silently left out. A
    // driver restoring this backup after reinstalling would get their
    // foglio viaggi back but lose every delivery client and the whole
    // route history — exactly the gap ION described ("imi salveaza
    // totul inafara de ultimile schimbari, clientii nu-i salveaza").
    // Every real piece of local data is included now, so a restore is
    // genuinely a full return to where the driver left off.
    var backup = {
      exportedAt: new Date().toISOString(),
      appVersion: APP_VERSION,
      profile: JSON.parse(localStorage.getItem(LS_PROFILE) || 'null'),
      sheets: JSON.parse(localStorage.getItem(LS_SHEETS) || 'null'),
      currentSheetId: localStorage.getItem(LS_CURRENT),
      fuel: JSON.parse(localStorage.getItem(LS_FUEL) || 'null'),
      vehicle: JSON.parse(localStorage.getItem(LS_VEHICLE) || 'null'),
      deliveryClients: JSON.parse(localStorage.getItem(LS_DELIVERY_CLIENTS) || 'null'),
      deliveryRun: JSON.parse(localStorage.getItem(LS_DELIVERY_RUN) || 'null'),
      deliveryHistory: JSON.parse(localStorage.getItem(LS_DELIVERY_HISTORY) || 'null'),
      navFrequent: JSON.parse(localStorage.getItem(LS_NAV_FREQUENT) || 'null'),
      navHomework: JSON.parse(localStorage.getItem(LS_NAV_HOMEWORK) || 'null'),
      // REAL GAP, found and confirmed directly, testing the full
      // round-trip: every other category restored perfectly, but the
      // AUTO toggle (auto-riordina) was silently missing — a restore
      // would leave it back at OFF even if the driver had deliberately
      // turned it on, with no indication anything was lost.
      autoRiordina: localStorage.getItem(DP_AUTO_RIORDINA_KEY)
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
      if (!data || (!data.sheets && !data.profile && !data.deliveryClients && !data.deliveryRun)) { toast('File di backup non riconosciuto'); return; }
      var dateLabel = data.exportedAt ? new Date(data.exportedAt).toLocaleDateString('it-IT') : 'data sconosciuta';
      showConfirm({
        title: 'Ripristinare questo backup?',
        message: 'Tutti i dati attuali su questo telefono (foglio, scontrini, profilo, veicolo, clienti e percorso di consegna) verranno sostituiti con quelli del file (' + dateLabel + '). Questa azione non può essere annullata.',
        danger: true,
        confirmLabel: 'Ripristina',
        onConfirm: function () {
          if (data.profile) localStorage.setItem(LS_PROFILE, JSON.stringify(data.profile));
          if (data.sheets) localStorage.setItem(LS_SHEETS, JSON.stringify(data.sheets));
          if (data.currentSheetId) localStorage.setItem(LS_CURRENT, data.currentSheetId);
          if (data.fuel) localStorage.setItem(LS_FUEL, JSON.stringify(data.fuel));
          if (data.vehicle) localStorage.setItem(LS_VEHICLE, JSON.stringify(data.vehicle));
          if (data.deliveryClients) localStorage.setItem(LS_DELIVERY_CLIENTS, JSON.stringify(data.deliveryClients));
          if (data.deliveryRun) localStorage.setItem(LS_DELIVERY_RUN, JSON.stringify(data.deliveryRun));
          if (data.deliveryHistory) localStorage.setItem(LS_DELIVERY_HISTORY, JSON.stringify(data.deliveryHistory));
          if (data.navFrequent) localStorage.setItem(LS_NAV_FREQUENT, JSON.stringify(data.navFrequent));
          if (data.navHomework) localStorage.setItem(LS_NAV_HOMEWORK, JSON.stringify(data.navHomework));
          if (data.autoRiordina != null) localStorage.setItem(DP_AUTO_RIORDINA_KEY, data.autoRiordina); // only set when the backup actually has it — older backups from before this fix simply leave whatever's already on this phone untouched
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

  // Requested directly: routes to the right place based on what a
  // tapped push notification was actually about. Handles every
  // notification type ION named — chat (a new driver message) and
  // novita (a news/update post) — with an unrecognized/missing type
  // falling back to just opening the app itself (today's exact old
  // behavior), never anything broken or a dead end.
  //
  // HONEST DEPENDENCY: this can only route correctly if the actual
  // push payload — built and sent by the Edge Function running
  // separately in Supabase, whose code isn't in this repo — includes
  // a "type" field identifying which kind of notification this is
  // ("chat" or "novita"). Confirmed directly: right now, chat is the
  // ONLY one of these that's ever actually sent as a real push at all
  // (Novita currently only updates an in-app badge via a plain fetch,
  // checkNovitaUnread() — see sw.js's own comment on the fallback
  // default for the fuller explanation) — so if a real Novita push
  // gets added on the backend side, that Edge Function needs to set
  // this same "type": "novita" field for this to work for it too.
  function dpHandleNotificationNavigation(notificationType) {
    if (notificationType === 'chat') {
      setTimeout(openChatModal, 300); // small delay — gives the rest of init() a moment to finish setting up the screen underneath first, so the chat modal doesn't open onto a half-built page
    } else if (notificationType === 'novita') {
      setTimeout(openNovitaModal, 300);
    }
  }

  // REAL BUG, reported directly and confirmed: worked correctly on
  // Android, but on iOS, tapping a notification always just opened
  // the app generically — a well-documented WebKit/iOS limitation
  // (see sw.js's own fuller comment on this): iOS ignores the actual
  // URL passed to clients.openWindow(), so the ?notif=... param this
  // function's own caller reads above never even arrives on that
  // platform. This is the matching read side of the Cache Storage
  // handoff sw.js writes to right before attempting either
  // navigation — checked in ADDITION to the URL param (which still
  // works fine on Chrome/Android, so both are checked rather than
  // picking one), and cleared immediately after reading so a normal,
  // un-notification-triggered app launch later never re-triggers it.
  function dpCheckNotificationCacheHandoff() {
    if (!window.caches) return;
    caches.open('adb-notif-handoff').then(function (cache) {
      cache.match('/pending-notification').then(function (res) {
        if (!res) return;
        cache.delete('/pending-notification');
        res.json().then(function (data) {
          if (data && data.type) dpHandleNotificationNavigation(data.type);
        });
      });
    });
  }

  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('message', function (event) {
      if (event.data && event.data.type === 'notification-click') {
        dpHandleNotificationNavigation(event.data.notificationType);
      }
    });
  }

  // Requested directly, same iOS investigation as above: the
  // "app was already open" postMessage path (right above) is ALSO
  // documented as unreliable on iOS specifically (a background PWA
  // brought back to the foreground by a notification tap doesn't
  // always actually fire the notificationclick→postMessage chain
  // correctly there). Re-checking the same Cache Storage handoff
  // every time the app becomes visible again — not just once, at
  // startup — catches this case too, on any platform, regardless of
  // whether postMessage itself got through.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') dpCheckNotificationCacheHandoff();
  });

  function init() {
    // Requested directly: tapping a push notification used to just
    // open (or focus) the app generically — the driver then had to
    // go find whatever it was actually about themselves. This
    // handles the "app wasn't open yet" case — a fresh load, reading
    // the ?notif= param the service worker's own notificationclick
    // handler attaches to the URL it opens. The "app was ALREADY
    // open" case is handled separately, by the postMessage listener
    // further down in this same function — that one can't rely on
    // this URL check since the page never actually reloads then.
    dpHandleNotificationNavigation(new URLSearchParams(window.location.search).get('notif'));
    dpCheckNotificationCacheHandoff();

    // Requested directly: AUTO (auto-riordina) was persisting across
    // full app closes/reopens via localStorage — if left on from a
    // previous session and forgotten, it keeps calling the paid
    // route-optimization API on its own, silently spending tokens the
    // driver may not even need that day. init() only runs once per
    // genuine fresh launch of the app (a real page load — reopening
    // from the home screen icon after the app was fully closed, not
    // just switching screens within it), so resetting it right here,
    // unconditionally, means AUTO always starts OFF on a new session
    // and has to be deliberately turned on again when actually
    // wanted — never left silently running from days ago.
    dpSetAutoRiordinaEnabled(false);
    migrateUppercaseLocalities();
    migrateFuelToArrays();
    migrateReverifyClientPrecision(); // async, rate-limited, runs fully in the background — never blocks anything else in init()
    reportActivity().then(reportDailyOpen); // chained deliberately — the row reportActivity just wrote/confirmed must exist before this tries to update it
    checkNovitaUnread();
    checkChatUnread();
    syncBarHeights();
    syncRealViewportHeight();
    // REAL BUG, reported directly: the home screen's top card sometimes
    // rendered partly hidden behind the fixed top bar right at launch —
    // an existing fix already re-measures on visibilitychange (resuming
    // from background), but that never fires on a genuine cold start,
    // which is exactly when ION saw it. Root cause either way is the
    // same: syncBarHeights() above only measures the topbar at whatever
    // instant it happens to be called, so if the topbar's real size
    // settles a frame or two later for any reason, that one-time
    // snapshot is already stale. A ResizeObserver watches the topbar's
    // ACTUAL rendered size directly and re-syncs automatically the
    // moment it changes, for any reason, at any time — removing the
    // race entirely instead of chasing each specific moment it could
    // occur at. Set up here (not at top-level script scope) since the
    // topbar element is guaranteed to actually exist in the DOM by now.
    // Kept in a real, named variable (not chained inline) deliberately
    // — an Observer with no surviving reference anywhere is fair game
    // for garbage collection in some engines, which would silently
    // undo this exact fix.
    if (window.ResizeObserver) {
      var topbarElForObserver = document.querySelector('.topbar');
      if (topbarElForObserver) {
        window.__topbarResizeObserver = new ResizeObserver(syncBarHeights);
        window.__topbarResizeObserver.observe(topbarElForObserver);
      }
    }
    window.addEventListener('resize', syncBarHeights);
    window.addEventListener('resize', syncRealViewportHeight);
    window.addEventListener('orientationchange', function () { setTimeout(syncBarHeights, 200); setTimeout(syncRealViewportHeight, 200); });
    // Same reasoning as syncBarHeights just above — the Delivery
    // Planner's own fixed header needs the same re-measuring on
    // resize/orientation change. Safe to call even when that screen
    // isn't the current one (dpSyncStickyHeaderHeight no-ops to 0px
    // if .dp-sticky-header doesn't exist in the DOM right now).
    window.addEventListener('resize', dpSyncStickyHeaderHeight);
    window.addEventListener('orientationchange', function () { setTimeout(dpSyncStickyHeaderHeight, 200); });

    // Delivery photo camera — static modal elements, wired once here.
    document.getElementById('dp-camera-close-btn').addEventListener('click', dpCloseCameraModal);
    document.getElementById('dp-camera-capture-btn').addEventListener('click', dpCaptureCameraPhoto);
    document.getElementById('dp-camera-retake-btn').addEventListener('click', dpRetakeCameraPhoto);
    document.getElementById('dp-camera-send-btn').addEventListener('click', dpSendCameraPhoto);
    document.getElementById('dp-camera-zoom-in-btn').addEventListener('click', function () { dpCameraApplyZoom(1); });
    document.getElementById('dp-camera-zoom-out-btn').addEventListener('click', function () { dpCameraApplyZoom(-1); });
    document.getElementById('dp-camera-flash-btn').addEventListener('click', dpCameraToggleFlash);

    // Archivio clienti — static modal elements, wired once here.
    document.getElementById('dp-archive-close-x').addEventListener('click', function () {
      document.getElementById('modal-dp-archive').classList.remove('open');
    });
    document.getElementById('dp-archive-export-btn').addEventListener('click', dpExportClientsArchive);
    document.getElementById('dp-archive-add-btn').addEventListener('click', dpArchiveOpenNewClientModal);
    document.getElementById('dp-archive-import-btn').addEventListener('click', function () {
      document.getElementById('dp-archive-import-input').click();
    });
    document.getElementById('dp-archive-import-input').addEventListener('change', function (e) {
      var file = e.target.files[0];
      if (file) dpImportClientsArchive(file);
      e.target.value = '';
    });

    // REAL BUG, found and confirmed while diagnosing a reported "Salva
    // veicolo does nothing": these two listeners were only ever wired
    // inside renderNavigatore() — a function that isn't called ANYWHERE
    // in the app anymore (the old turn-by-turn Navigator screen this
    // belonged to was fully replaced by the Delivery Planner). The
    // #modal-nav-vehicle form itself (opened from the Delivery
    // Planner's own vehicle button, and from Impostazioni) is very
    // much alive and used — but its Save button's click listener, and
    // its × close button's listener, were dead code that never
    // actually attached to anything. Both are static elements already
    // present in index.html (not rebuilt per-screen), so wiring them
    // once here, at real app init, is all that's needed — no per-
    // render re-wiring required.
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
      toast('Veicolo salvato ✓');
      document.getElementById('modal-nav-vehicle').classList.remove('open');
      if (currentScreen === 'navigatore') renderDeliveryPlanner(); // refreshes the vehicle-summary text on the header button immediately, so the new type/dimensions are visibly reflected right away, not just on the next unrelated re-render
    });

    // Tapping the dimmed backdrop (outside the sheet itself) closes
    // whichever modal is open — same convention as every native picker
    // and virtually every modal on the web. Wired once, globally, for
    // every ".modal-overlay" in the app, rather than per-modal, so new
    // modals get this for free. Two deliberate exceptions: the
    // mandatory email-confirmation modal, and the mandatory first-run
    // Benvenuto/Impostazioni modal (before a profile exists at all) —
    // neither can be dismissed this way, by design.
    //
    // REAL BUG, reported directly, TWICE now (the first fix for this
    // was built but never actually shipped — lost track of it while
    // investigating a different issue in parallel): right after
    // "Elimina tutti i dati", the X close button was correctly blocked
    // on Benvenuto, but tapping the darkened area OUTSIDE the sheet
    // fell straight into this same generic handler and closed it
    // anyway — the one path this exception forgot to also cover. A
    // driver could get straight into the app with no profile and no
    // confirmed email at all, exactly contradicting the whole point of
    // requiring either step in the first place.
    document.addEventListener('click', function (e) {
      if (!e.target.classList || !e.target.classList.contains('modal-overlay')) return;
      if (e.target.id === 'modal-email-required') return;
      if (e.target.id === 'modal-settings' && !state.profile.nome) return;
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
        dpSyncStickyHeaderHeight();
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
        // sw.js itself tied to APP_VERSION as a query string — a real,
        // confirmed case where a driver kept seeing genuinely old
        // behavior (an old marker icon) even after force-stopping the
        // installed app AND clearing its cache from Android's own
        // Settings screen. That "clear cache" action clears the
        // installed shortcut's OWN minimal storage, but NOT Chrome's
        // separate, underlying Cache Storage for the site itself
        // (where the actual cached sw.js/app.js live) — a real,
        // documented Android/Chrome WebAPK quirk, not something a
        // driver using the app normally would know to work around.
        // registration.update() (below) checks whether sw.js's BYTES
        // changed, but that check can still be defeated by an
        // intermediate cache (GitHub Pages' own CDN, an ISP or
        // corporate proxy, anything sitting between the phone and the
        // origin server) serving a stale copy of sw.js itself with
        // caching headers that make it look unchanged. Registering
        // with a version-tagged URL instead means an actual version
        // bump always requests a genuinely DIFFERENT URL, which no
        // cache anywhere can satisfy from a stale entry — it has to
        // hit the real origin.
        navigator.serviceWorker.register('sw.js?v=' + APP_VERSION).then(function (registration) {
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
