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
      da: "Ponte San Nicolò", provDa: "PD", frequent: {}
    });
  }
  function saveProfile(p) { saveJSON(LS_PROFILE, p); }

  function loadSheets() { return loadJSON(LS_SHEETS, []); }
  function saveSheets(arr) { saveJSON(LS_SHEETS, arr); }

  function getCurrentSheetId() { return localStorage.getItem(LS_CURRENT) || null; }
  function setCurrentSheetId(id) { if (id) localStorage.setItem(LS_CURRENT, id); }

  var state = {
    profile: loadProfile(),
    sheets: loadSheets(),
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
  function latestSheet() {
    if (!state.sheets.length) return null;
    return state.sheets.slice().sort(function (a, b) {
      var k = sortKey(b) - sortKey(a);
      if (k !== 0) return k;
      // Same month+year (e.g. two different clients) — the more recently
      // created one counts as "latest".
      return (b.createdAt || '').localeCompare(a.createdAt || '');
    })[0];
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
    return { da: prefillDa || "", provDa: prefillProvDa || "", a: "", provA: "", ddt: "", kmInizio: "", kmFine: "" };
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

  function createSheet(month, year, perContoDi) {
    var client = (perContoDi || state.profile.perContoDi || 'BARCELLA').trim().toUpperCase();
    var existing = sheetForMonth(month, year, client);
    if (existing) return existing;
    var s = {
      id: uid(),
      month: month, year: year,
      nome: state.profile.nome, targa: state.profile.targa, perContoDi: client,
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
      route: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="5" cy="6" r="2"/><circle cx="19" cy="18" r="2"/><path d="M5 8v4a4 4 0 0 0 4 4h6" stroke-dasharray="3 3"/></svg>'
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
    var isLatest = isNewestSheet(sheet);
    var html = '';
    html += '<div class="card active-card"><div class="route-dashes"></div>';
    html += '<span class="badge ' + (isLatest ? '' : 'muted') + '">' + (isLatest ? 'Foglio attivo' : 'Foglio archiviato') + '</span>';
    html += '<h2>' + MESI[sheet.month - 1] + ' ' + sheet.year + '</h2>';
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

    if (!isLatest) {
      html += '<button class="link-btn" id="home-jump-latest" style="display:block;margin:14px auto 0;">Vai al foglio più recente →</button>';
    }

    html += '<div class="section-title"><h3>Riepilogo mese</h3></div>';
    var filled = Object.keys(sheet.giorni).filter(function (d) { return sheet.giorni[d] && (sheet.giorni[d].a || sheet.giorni[d].kmFine !== ""); });
    var totKm = 0;
    filled.forEach(function (d) {
      var g = sheet.giorni[d];
      if (g.kmInizio !== "" && g.kmFine !== "" && !isNaN(g.kmFine - g.kmInizio)) totKm += (Number(g.kmFine) - Number(g.kmInizio));
    });
    html += '<div class="card" style="display:flex;gap:0;">';
    html += '<div style="flex:1;text-align:center;"><div style="font-size:22px;font-weight:800;">' + filled.length + '</div><div class="eyebrow" style="margin-top:2px;">Viaggi registrati</div></div>';
    html += '<div style="width:1px;background:var(--line);"></div>';
    html += '<div style="flex:1;text-align:center;"><div style="font-size:22px;font-weight:800;">' + totKm.toLocaleString('it-IT') + '</div><div class="eyebrow" style="margin-top:2px;">KM totali mese</div></div>';
    html += '</div>';

    el.innerHTML = html;
    document.getElementById('home-continua').addEventListener('click', function () { showScreen('foglio'); });
    document.getElementById('home-pdf').addEventListener('click', function () { showScreen('pdf'); });
    var jumpBtn = document.getElementById('home-jump-latest');
    if (jumpBtn) jumpBtn.addEventListener('click', function () {
      var latest = latestSheet();
      state.currentSheetId = latest.id; setCurrentSheetId(latest.id); renderHome();
    });
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
    var html = '';
    sorted.forEach(function (s) {
      var isLatest = isNewestSheet(s);
      var filled = Object.keys(s.giorni).filter(function (d) { return s.giorni[d] && (s.giorni[d].a || s.giorni[d].kmFine !== ""); }).length;
      html += '<div class="card archive-card">';
      html += '<div class="archive-month"><div class="m">' + MESI[s.month - 1] + ' ' + s.year + '<span style="color:var(--ink-faint);font-weight:600;"> · ' + escapeHtml(s.perContoDi || '—') + '</span></div>';
      html += '<div class="d">' + escapeHtml(s.nome || '—') + ' · ' + escapeHtml(s.targa || '—') + ' · ' + filled + ' viaggi</div>';
      if (isLatest) html += '<div class="d" style="color:var(--accent);font-weight:800;margin-top:4px;">FOGLIO ATTIVO</div>';
      html += '</div>';
      html += '<div class="archive-actions">';
      html += '<button class="btn btn-ghost btn-sm" data-open="' + s.id + '">Apri</button>';
      html += '<button class="btn btn-outline btn-sm" data-pdf="' + s.id + '">PDF</button>';
      html += '</div></div>';
    });
    el.innerHTML = html;
    el.querySelectorAll('[data-open]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-open');
        state.currentSheetId = id; setCurrentSheetId(id);
        showScreen('foglio');
      });
    });
    el.querySelectorAll('[data-pdf]').forEach(function (b) {
      b.addEventListener('click', function () {
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
    var sorted = state.sheets.slice().sort(function (a, b) { return sortKey(b) - sortKey(a); });
    var html = '';
    html += '<div class="card">';
    html += '<label class="eyebrow" style="display:block;margin-bottom:8px;">Foglio da esportare</label>';
    html += '<select class="field-select" id="pdf-sheet-select">';
    sorted.forEach(function (s) {
      html += '<option value="' + s.id + '" ' + (s.id === sheet.id ? 'selected' : '') + '>' + MESI[s.month - 1] + ' ' + s.year + ' — ' + escapeHtml(s.perContoDi || '—') + '</option>';
    });
    html += '</select>';
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

    // Start loading what's needed right away, in the background, so that
    // by the time the person actually taps the button, everything is
    // already to hand and the tab can open in the very same instant as
    // the tap — phones only allow opening a new tab as a direct,
    // uninterrupted response to a touch, not after any waiting.
    loadPdfLibs().catch(function () { /* will retry on click if needed */ });

    document.getElementById('pdf-sheet-select').addEventListener('change', function (e) {
      state.currentSheetId = e.target.value; setCurrentSheetId(e.target.value);
    });
    document.getElementById('pdf-open-preview').addEventListener('click', openPdfFullScreen);
    document.getElementById('pdf-download-outline').addEventListener('click', downloadCurrentPdf);
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
      var sheet = findSheet(document.getElementById('pdf-sheet-select').value) || currentSheet();
      var doc = buildPdf(sheet);
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
      var sheet = findSheet(document.getElementById('pdf-sheet-select').value) || currentSheet();
      var doc = buildPdf(sheet);
      var filename = 'Foglio_Viaggi_' + MESI[sheet.month - 1] + '_' + sheet.year + '.pdf';
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

  function buildPdf(sheet) {
    var jsPDFCtor = window.jspdf.jsPDF;
    var doc = new jsPDFCtor({ orientation: 'landscape', unit: 'mm', format: 'a4' });
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

    return doc;
  }

  /* ---------------------------------------------------------------- */
  /* Day editor                                                         */
  /* ---------------------------------------------------------------- */
  var dayModal = document.getElementById('modal-day');
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

    var g = {
      da: daVal,
      provDa: document.getElementById('day-provda').value.trim().toUpperCase(),
      a: aVal,
      provA: provAVal,
      ddt: document.getElementById('day-ddt').value.trim(),
      kmInizio: document.getElementById('day-kminizio').value === '' ? '' : Number(document.getElementById('day-kminizio').value),
      kmFine: document.getElementById('day-kmfine').value === '' ? '' : Number(document.getElementById('day-kmfine').value)
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

    if (!nome || !targa) { toast('Inserisci nome e targa'); return; }

    state.profile.nome = nome; state.profile.targa = targa; state.profile.perContoDi = conto;
    state.profile.da = da; state.profile.provDa = provDa;
    saveProfile(state.profile);

    if (settingsTargetSheet) {
      settingsTargetSheet.nome = nome; settingsTargetSheet.targa = targa; settingsTargetSheet.perContoDi = conto;
      saveSheets(state.sheets);
    }
    settingsModal.classList.remove('open');
    toast('Dati salvati');
    render();
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
      '<div class="settings-driver-note" style="margin-top:-4px;">Se lavori per piu\' clienti nello stesso mese, crea un foglio separato per ciascuno — come su carta, un foglio per cliente.</div>';
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
      confirmModal.classList.remove('open');
      var existing = sheetForMonth(m, y, chosenClient);
      if (existing) {
        state.currentSheetId = existing.id; setCurrentSheetId(existing.id);
        toast('Foglio ' + MESI[m - 1] + ' ' + y + ' (' + chosenClient + ') già esistente — aperto');
        showScreen('foglio');
        reloadIfUpdatePending();
        return;
      }
      createSheet(m, y, chosenClient);
      toast('Nuovo foglio creato: ' + MESI[m - 1] + ' ' + y + ' — ' + chosenClient);
      showScreen('foglio');
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

  function init() {
    migrateUppercaseLocalities();
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
