(function(){
'use strict';
var SUPABASE_URL='https://chboalgzigdglygnnist.supabase.co';
var SUPABASE_ANON_KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNoYm9hbGd6aWdkZ2x5Z25uaXN0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY1NTc4MjMsImV4cCI6MjEwMjEzMzgyM30.vorEiww3SvVAadgnAqFH42M-MjbpXOojAlhNm-cIeMI';
var API=SUPABASE_URL+'/functions/v1/annunci';
var qs=new URLSearchParams(location.search);var mode=qs.get('mode')==='fleet'?'fleet':'driver';var fleetSlug=qs.get('fleet')||'';
var fleetPassword=fleetSlug?sessionStorage.getItem('adb_fleet_pw_'+fleetSlug)||'':'';
var state={tab:'job',view:'tab',items:[],mineItems:[],favItems:[],imageData:null,apiReady:true,editingId:null};
var E={};['tabs','cards','search','zone','category','sort','sectionTitle','resultCount','publishBtn','favBtn','mineBtn','toolbarRow','publishModal','publishForm','fType','fTitle','fCompany','fLocation','fContact','fDescription','fImage','imagePreview','imageStatus','fBadge','fVisibility','fPromotion','dynamicFields','detailModal','detailBody','statusBar','contextLabel','pageTitle','pageSub','sideNav'].forEach(function(id){E[id]=document.getElementById(id)});
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function icon(name){var p={job:'<path d="M9 6V4h6v2M4 8h16v11H4zM4 11h16"/>',client:'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>',marketplace:'<path d="M3 7h18l-2 12H5L3 7z"/><path d="M8 7a4 4 0 0 1 8 0"/>',service:'<path d="M14.7 6.3a4 4 0 0 0-5-5L7 4l3 3 2.7-2.7a4 4 0 0 0 2 2z"/><path d="M5 10 2 13l9 9 3-3M14 14l7-7"/>',pin:'<path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2"/>',heart:'<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8Z"/>',mine:'<path d="M9 12h6M9 16h4M8 4h8a2 2 0 0 1 2 2v13l-3-2-3 2-3-2-3 2V6a2 2 0 0 1 2-2Z"/>'};return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">'+(p[name]||p.job)+'</svg>'}
var tabs=mode==='fleet'?[['job','Trova lavoro'],['client','Trova clienti'],['marketplace','Marketplace'],['service','Servizi']]:[['job','Lavoro'],['marketplace','Marketplace'],['service','Servizi']];
function renderTabs(){E.tabs.className='tabs'+(mode==='driver'?' driver':'');E.tabs.innerHTML=tabs.map(function(t){return '<button class="tab '+(state.view==='tab'&&state.tab===t[0]?'active':'')+'" data-tab="'+t[0]+'">'+t[1]+'</button>'}).join('');E.tabs.querySelectorAll('[data-tab]').forEach(function(b){b.onclick=function(){state.view='tab';state.tab=b.dataset.tab;E.tabs.style.display='';E.toolbarRow.style.display='';renderTabs();renderSide();fillCategories();render()}})}
function renderSide(){if(mode!=='fleet'){E.sideNav.parentElement.style.display='none';return}var mineActive=state.view==='mine';E.sideNav.innerHTML='<div class="sideitem">'+icon('job')+' Panoramica annunci</div>'+tabs.map(function(t){return '<div class="sideitem '+(!mineActive&&state.tab===t[0]?'active':'')+'" data-stab="'+t[0]+'">'+icon(t[0])+' '+t[1]+'</div>'}).join('')+'<div class="sidecard-divider"></div><div class="sideitem '+(mineActive?'active':'')+'" data-mine="1">'+icon('mine')+' I miei annunci</div>';E.sideNav.querySelectorAll('[data-stab]').forEach(function(b){b.onclick=function(){state.view='tab';state.tab=b.dataset.stab;E.tabs.style.display='';E.toolbarRow.style.display='';renderTabs();renderSide();fillCategories();render()}});var mineBtn=E.sideNav.querySelector('[data-mine]');if(mineBtn)mineBtn.onclick=openMine}
var cats={job:['Furgone','Patente B','Patente C','C + CQC','CE + CQC','Linea nazionale','Consegne locali'],client:['Pallet','Merce varia','Refrigerato','Macchinari','Espresso'],marketplace:['Veicoli','Ricambi','Pneumatici','Attrezzatura','Elettronica','Altro'],service:['Assicurazioni','GPS e app','Officine','Gommisti','Consulenza','Formazione']};
function fillCategories(){var old=E.category.value;E.category.innerHTML='<option value="">Tutte le categorie</option>'+cats[state.tab].map(function(x){return '<option>'+esc(x)+'</option>'}).join('');if(cats[state.tab].indexOf(old)>=0)E.category.value=old;var titles={job:'Offerte di lavoro',client:'Opportunità di trasporto',marketplace:'Marketplace',service:'Servizi per autisti e flotte'};E.sectionTitle.textContent=titles[state.tab];
  // Cerut direct ("cand se schimba ele se schimba si sus titlul...
  // independent pe ce sectiune esti schimba si titlul principal sus
  // exact ca si cel secundar"): titlul mare de sus (pageTitle) se
  // schimba acum odata cu tab-ul curent, la fel ca eticheta mica a
  // tab-ului insusi (Lavoro/Marketplace/Servizi, sau Trova
  // lavoro/Trova clienti/Marketplace/Servizi pentru fleet) - nu mai
  // ramane fix pe "Trova lavoro"/"Annunci" indiferent unde esti.
  var currentTabDef=tabs.find(function(t){return t[0]===state.tab});
  if(currentTabDef)E.pageTitle.textContent=currentTabDef[1];
  renderSide()}
function apiCall(action,payload){payload=payload||{};payload.action=action;payload.mode=mode;payload.fleet_slug=fleetSlug;payload.fleet_password=fleetPassword;return fetch(API,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+SUPABASE_ANON_KEY},body:JSON.stringify(payload)}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()})}
// Cerut direct ("nu mai apara acele publicatii hardcodate... mereu sa
// apara doar publicarile facute de flote"): datele de test (5
// anunturi fictive), folosite doar cat timp backend-ul inca nu era
// distribuit, aparusera din greseala si DUPA aceea - de fiecare data
// cand cererea catre server esua dintr-un motiv oarecare (o
// intrerupere temporara de retea, de exemplu), pagina "cadea" tacut
// pe aceste date fictive, aratand-le ca si cum ar fi reale. Eliminate
// complet - la o eroare reala, un mesaj clar spune exact atat, cu un
// buton de reincercare, niciodata date inventate.
// Cerut direct ("anunturile trebuie sa se incarce mereu, fara nicio
// problema"): investigat cauza reala a esecurilor ocazionale - codul
// facea o SINGURA incercare, fara nicio reincercare automata; o
// simpla sincopa temporara de retea (foarte obisnuita pe mobil, de
// exemplu la trecerea de pe wifi pe date, sau chiar in primele
// clipe dupa ce ecranul se aprinde) era suficienta ca sa esueze o
// data, fara nicio a doua sansa. Acum reincearca automat, de doua ori
// in plus (trei incercari in total), cu o pauza scurta intre ele -
// majoritatea sincopelor trecatoare nu mai ajung sa fie vizibile
// deloc. Mesajul de eroare (cu buton de reincercare manuala) apare
// doar daca toate cele trei incercari esueaza la rand.
function load(retriesLeft){
  if(retriesLeft===undefined)retriesLeft=2;
  E.statusBar.classList.remove('show');
  E.cards.innerHTML='<div class="empty">Caricamento…</div>';
  return apiCall('list',{type:state.tab}).then(function(r){
    if(!r.ok)throw new Error(r.error||'api');
    state.items=r.items||[];state.apiReady=true;render()
  }).catch(function(){
    if(retriesLeft>0){
      return new Promise(function(resolve){setTimeout(resolve,900)}).then(function(){return load(retriesLeft-1)});
    }
    state.apiReady=false;state.items=[];
    E.resultCount.textContent='';
    E.cards.innerHTML='<div class="empty">Impossibile caricare gli annunci al momento.<br><button class="ghost" id="retryLoadBtn" style="margin-top:10px;">Riprova</button></div>';
    var retryBtn=document.getElementById('retryLoadBtn');
    if(retryBtn)retryBtn.onclick=function(){load()};
  })
}

// Cerut direct ("in fleet nu arata anunturile deja publicate sau care
// sunt in bozza cu posibilitatea de a aggiorna anuntul"): sectiune noua,
// separata de taburile normale (care arata doar anunturile PUBLICE, ale
// tuturor) - aici flota isi vede TOATE anunturile proprii, indiferent
// de tip sau stare (inclusiv ciornele, invizibile altfel oriunde),
// fiecare cu Modifica/Elimina direct disponibile (acelasi modal deja
// folosit pentru asta, nimic nou de invatat).
function openMine(){
  if(mode!=='fleet')return;
  state.view='mine';
  E.tabs.style.display='none';
  E.toolbarRow.style.display='none';
  E.sectionTitle.textContent='I miei annunci';
  E.resultCount.textContent='';
  E.cards.innerHTML='<div class="empty">Caricamento…</div>';
  renderSide();
  apiCall('mine',{}).then(function(r){
    if(!r.ok)throw new Error(r.error||'api');
    state.mineItems=r.items||[];
    renderMine();
  }).catch(function(){E.cards.innerHTML='<div class="empty">Impossibile caricare i tuoi annunci.</div>'});
}
function backFromMine(){state.view='tab';E.tabs.style.display='';E.toolbarRow.style.display='';renderTabs();renderSide();fillCategories();render()}
function renderMine(){
  var a=state.mineItems.slice().sort(function(x,y){return new Date(y.created_at)-new Date(x.created_at)});
  E.resultCount.textContent=a.length+' '+(a.length===1?'annuncio':'annunci');
  E.cards.innerHTML=a.length?a.map(function(it){
    var isPaused=it.visibility==='archived';
    var stateBadge=it.visibility==='draft'?'<span class="badge" style="background:var(--muted);color:#fff;">Bozza</span>':isPaused?'<span class="badge" style="background:var(--amber);color:#1a1200;">In pausa</span>':(it.badge?'<span class="badge '+esc(it.badge)+'">'+(it.badge==='urgent'?'Urgente':it.badge==='new'?'Nuovo':'Sponsorizzato')+'</span>':'');
    // Cerut direct ("cu posibilitatea de a le modifica... de a le
    // opri momentan din publicare... de a le publica, de a le
    // elimina"): trei actiuni directe pe fiecare card, fara sa fie
    // nevoie sa deschizi intai formularul complet - Pausa/Pubblica
    // comuta vizibilitatea cu un singur tap, Elimina cere confirmare
    // (ca oriunde altundeva in pagina), Modifica ramane pentru
    // schimbari mai mari.
    var toggleLabel=(it.visibility==='public')?'Pausa':'Pubblica';
    return '<article class="card">'+stateBadge+cardImage(it)+'<div class="cardbody"><div class="cardtop"><div style="min-width:0;flex:1"><div class="title">'+esc(it.title)+'</div><div class="company">'+esc(it.company)+'</div></div></div><div class="meta">'+icon('pin')+' '+esc(it.location)+'</div><div class="chips">'+(it.category?'<span class="chip">'+esc(it.category)+'</span>':'')+(it.price_label?'<span class="chip money">'+esc(it.price_label)+'</span>':'')+'</div><div class="cardactions"><span class="count">'+relativeTime(it.created_at)+'</span><div style="display:flex;gap:6px;"><button class="ghost" data-mine-toggle="'+esc(it.id)+'" style="padding:6px 10px;font-size:12px;">'+toggleLabel+'</button><button class="ghost" data-mine-edit="'+esc(it.id)+'" style="padding:6px 10px;font-size:12px;">Modifica</button><button class="ghost danger" data-mine-delete="'+esc(it.id)+'" style="padding:6px 10px;font-size:12px;">Elimina</button></div></div></div></article>'
  }).join(''):'<div class="empty">Non hai ancora pubblicato nessun annuncio.</div>';
  E.cards.querySelectorAll('[data-mine-edit]').forEach(function(b){b.onclick=function(){var it=state.mineItems.find(function(x){return x.id===b.dataset.mineEdit});if(it)openEdit(it)}});
  E.cards.querySelectorAll('[data-mine-toggle]').forEach(function(b){b.onclick=function(){
    var it=state.mineItems.find(function(x){return x.id===b.dataset.mineToggle});if(!it)return;
    var newVisibility=(it.visibility==='public')?'archived':'public';
    var payload={type:it.type,title:it.title,company:it.company,location:it.location,category:it.category,price_label:it.price_label,work_mode:it.work_mode,extra:it.extra,contact:it.contact,description:it.description,badge:it.badge,promotion:it.promotion,visibility:newVisibility};
    b.disabled=true;
    apiCall('update',{id:it.id,item:payload}).then(function(r){if(!r.ok)throw new Error(r.error||'Errore');openMine()}).catch(function(e){alert(e.message);b.disabled=false});
  }});
  E.cards.querySelectorAll('[data-mine-delete]').forEach(function(b){b.onclick=function(){
    if(!confirm('Eliminare questo annuncio?'))return;
    apiCall('delete',{id:b.dataset.mineDelete}).then(function(r){if(!r.ok)throw new Error(r.error||'Errore');openMine()}).catch(function(e){alert(e.message)});
  }});
}

// Cerut direct ("preferitele la fel nu au sectiunea lor"): sectiune
// dedicata, accesibila din bara de sus — incarca TOATE tipurile in
// paralel (nu doar tab-ul curent), ca un anunt favorit din Marketplace
// sa apara aici chiar daca esti pe tab-ul Lavoro cand il deschizi.
function openFavorites(){
  state.view='favs';
  E.tabs.style.display='none';
  E.toolbarRow.style.display='none';
  E.sectionTitle.textContent='Preferiti';
  E.resultCount.textContent='';
  E.cards.innerHTML='<div class="empty">Caricamento…</div>';
  var favIds=favs();
  if(!favIds.length){state.favItems=[];renderFavorites();return}
  Promise.all(tabs.map(function(t){return apiCall('list',{type:t[0]}).then(function(r){return r.ok?(r.items||[]):[]}).catch(function(){return[]})})).then(function(lists){
    var all=[].concat.apply([],lists);
    state.favItems=all.filter(function(i){return favIds.indexOf(i.id)>=0});
    renderFavorites();
  });
}
function renderFavorites(){
  var a=state.favItems;
  E.resultCount.textContent=a.length+' '+(a.length===1?'preferito':'preferiti');
  var f=favs();
  function cardHtml(it){
    var badge=it.badge?'<span class="badge '+esc(it.badge)+'">'+(it.badge==='urgent'?'Urgente':it.badge==='new'?'Nuovo':'Sponsorizzato')+'</span>':'';
    return '<article class="card">'+badge+cardImage(it)+'<div class="cardbody"><div class="cardtop"><div style="min-width:0;flex:1"><div class="title">'+esc(it.title)+'</div><div class="company">'+esc(it.company)+'</div></div><button class="fav on" data-fav="'+esc(it.id)+'">'+icon('heart')+'</button></div><div class="meta">'+icon('pin')+' '+esc(it.location)+'</div><div class="chips">'+(it.category?'<span class="chip">'+esc(it.category)+'</span>':'')+(it.price_label?'<span class="chip money">'+esc(it.price_label)+'</span>':'')+'</div><div class="cardactions"><span class="count">'+relativeTime(it.created_at)+'</span><button class="details" data-detail="'+esc(it.id)+'">Dettagli →</button></div></div></article>';
  }
  // Cerut direct ("daca salveaza doar job-uri, apar mai intai job-
  // urile, daca a salvat si din marketplace, apare alaturi o sectiune
  // din marketplace..."): grupate acum pe sectiuni, cate una pentru
  // fiecare tip (in aceeasi ordine ca taburile de sus) - o sectiune
  // apare doar daca exista cel putin un anunt salvat de acel tip,
  // fiecare cu propriul titlu, ca "Lavoro" sau "Marketplace".
  if(!a.length){
    E.cards.innerHTML='<div class="empty">Nessun annuncio salvato tra i preferiti.</div>';
  } else {
    E.cards.innerHTML=tabs.map(function(t){
      var group=a.filter(function(it){return it.type===t[0]});
      if(!group.length)return'';
      return '<div class="sectionhead" style="margin-top:18px;grid-column:1/-1;"><h2>'+esc(t[1])+'</h2><span>'+group.length+'</span></div><div class="cards" style="margin:0;grid-column:1/-1;">'+group.map(cardHtml).join('')+'</div>';
    }).join('');
  }
  E.cards.querySelectorAll('[data-fav]').forEach(function(b){b.onclick=function(){toggleFav(b.dataset.fav);state.favItems=state.favItems.filter(function(x){return x.id!==b.dataset.fav||favs().indexOf(x.id)>=0});renderFavorites()}});
  E.cards.querySelectorAll('[data-detail]').forEach(function(b){b.onclick=function(){var it=a.find(function(x){return x.id===b.dataset.detail});if(it){state.items=[it].concat(state.items);openDetail(it.id)}}});
}
function backFromFavorites(){state.view='tab';E.tabs.style.display='';E.toolbarRow.style.display='';renderTabs();renderSide();fillCategories();render()}

function favs(){try{return JSON.parse(localStorage.getItem('adb_annunci_favs')||'[]')}catch(e){return[]}}function toggleFav(id){var f=favs(),i=f.indexOf(id);if(i>=0)f.splice(i,1);else f.push(id);localStorage.setItem('adb_annunci_favs',JSON.stringify(f));render()}
function relativeTime(x){var d=(Date.now()-new Date(x).getTime())/1000;if(d<3600)return Math.max(1,Math.floor(d/60))+' min fa';if(d<86400)return Math.floor(d/3600)+' ore fa';return Math.floor(d/86400)+' giorni fa'}
function cardImage(it){if(it.image_url)return '<img class="thumb" src="'+esc(it.image_url)+'" alt="">';return '<div class="thumb placeholder">'+icon(it.type)+'</div>'}
function filtered(){var q=E.search.value.trim().toLowerCase(),z=E.zone.value,c=E.category.value;var a=state.items.filter(function(i){if(i.type!==state.tab)return false;if(q&&([i.title,i.company,i.location,i.description].join(' ').toLowerCase().indexOf(q)<0))return false;if(z&&String(i.location||'').toLowerCase().indexOf(z.toLowerCase())<0)return false;if(c&&i.category!==c)return false;return i.visibility!=='draft'});if(E.sort.value==='featured')a.sort(function(a,b){return +(b.promotion==='featured'||b.promotion==='sponsored')-+(a.promotion==='featured'||a.promotion==='sponsored')});else a.sort(function(a,b){return new Date(b.created_at)-new Date(a.created_at)});return a}
function render(){var a=filtered();E.resultCount.textContent=a.length+' '+(a.length===1?'risultato':'risultati');var f=favs();E.cards.innerHTML=a.length?a.map(function(it){var badge=it.badge?'<span class="badge '+esc(it.badge)+'">'+(it.badge==='urgent'?'Urgente':it.badge==='new'?'Nuovo':'Sponsorizzato')+'</span>':'';return '<article class="card">'+badge+cardImage(it)+'<div class="cardbody"><div class="cardtop"><div style="min-width:0;flex:1"><div class="title">'+esc(it.title)+'</div><div class="company">'+esc(it.company)+'</div></div><button class="fav '+(f.indexOf(it.id)>=0?'on':'')+'" data-fav="'+esc(it.id)+'">'+icon('heart')+'</button></div><div class="meta">'+icon('pin')+' '+esc(it.location)+'</div><div class="chips">'+(it.category?'<span class="chip">'+esc(it.category)+'</span>':'')+(it.work_mode?'<span class="chip">'+esc(it.work_mode)+'</span>':'')+(it.price_label?'<span class="chip money">'+esc(it.price_label)+'</span>':'')+'</div><div class="cardactions"><span class="count">'+relativeTime(it.created_at)+'</span><button class="details" data-detail="'+esc(it.id)+'">Dettagli →</button></div></div></article>'}).join(''):'<div class="empty">Nessun annuncio trovato con questi filtri.</div>';E.cards.querySelectorAll('[data-fav]').forEach(function(b){b.onclick=function(){toggleFav(b.dataset.fav)}});E.cards.querySelectorAll('[data-detail]').forEach(function(b){b.onclick=function(){openDetail(b.dataset.detail)}})}
function dynamicForm(){var t=E.fType.value,html='';if(t==='job')html='<div class="grid2"><div><label>Categoria / patente</label><select class="field" id="fCategory">'+cats.job.map(o).join('')+'</select></div><div><label>Compenso *</label><input class="field" id="fPrice" required placeholder="Es. 1.800 – 2.200 €"></div><div><label>Impiego</label><input class="field" id="fWork" placeholder="Full time / Turni"></div><div><label>Veicolo</label><input class="field" id="fExtra" placeholder="Furgone / Bilico / Motrice"></div></div>';
if(t==='client')html='<div class="grid2"><div><label>Tipo merce</label><select class="field" id="fCategory">'+cats.client.map(o).join('')+'</select></div><div><label>Budget</label><input class="field" id="fPrice" placeholder="Es. 450 €"></div><div><label>Tratta</label><input class="field" id="fWork" placeholder="Padova → Vicenza"></div><div><label>Scadenza</label><input class="field" id="fExtra" placeholder="Entro 24h"></div></div>';
if(t==='marketplace')html='<div class="grid2"><div><label>Categoria</label><select class="field" id="fCategory">'+cats.marketplace.map(o).join('')+'</select></div><div><label>Prezzo</label><input class="field" id="fPrice" placeholder="Es. 1.200 €"></div><div><label>Condizione</label><input class="field" id="fWork" placeholder="Nuovo / Usato"></div><div><label>Marca / modello</label><input class="field" id="fExtra"></div></div>';
if(t==='service')html='<div class="grid2"><div><label>Categoria</label><select class="field" id="fCategory">'+cats.service.map(o).join('')+'</select></div><div><label>Prezzo / formula</label><input class="field" id="fPrice" placeholder="Preventivo / Da 99 €"></div><div><label>Copertura</label><input class="field" id="fWork" placeholder="Italia / Veneto"></div><div><label>Sito / riferimento</label><input class="field" id="fExtra"></div></div>';E.dynamicFields.innerHTML=html}
function o(x){return '<option>'+x+'</option>'}
async function compressSquare(file){var img=await createImageBitmap(file),size=Math.min(img.width,img.height),sx=(img.width-size)/2,sy=(img.height-size)/2;var dim=320,quality=.78,blob=null;while(dim>=72){var c=document.createElement('canvas');c.width=c.height=dim;c.getContext('2d').drawImage(img,sx,sy,size,size,0,0,dim,dim);for(var q=quality;q>=.28;q-=.08){blob=await new Promise(function(res){c.toBlob(res,'image/webp',q)});if(blob&&blob.size<=10000)break}if(blob&&blob.size<=10000)break;dim=Math.floor(dim*.84)}if(!blob||blob.size>10000)throw new Error('compression');var data=await new Promise(function(res){var r=new FileReader();r.onload=function(){res(r.result)};r.readAsDataURL(blob)});return{data:data,size:blob.size}}
E.fImage.onchange=async function(){var file=this.files&&this.files[0];if(!file){state.imageData=null;return}E.imageStatus.textContent='Ottimizzazione…';try{var r=await compressSquare(file);state.imageData=r.data;E.imagePreview.src=r.data;E.imageStatus.textContent='Immagine pronta: '+(r.size/1024).toFixed(1)+' KB · 1:1'}catch(e){state.imageData=null;E.imageStatus.textContent='Impossibile comprimere questa immagine sotto 10 KB. Prova un’altra foto.'}}
// REAL BUG, raportat direct ("cand vreau sa public un anunt scroland
// in general scroleaza si pagina dedesubt"): pagina din spatele
// modalului ramanea scrollabila cat timp modalul era deschis - pe
// mobil, un gest de scroll in interiorul formularului putea "scapa"
// si misca toata pagina de dedesubt in acelasi timp, o senzatie
// confuza, ca doua straturi se misca independent. Aceeasi tehnica
// deja dovedita in panoul de admin (blocheaza body-ul complet cat
// timp un modal e deschis, il elibereaza exact de unde a ramas la
// inchidere) - centralizata aici, ca sa acopere toate cele 6 locuri
// care deschideau/inchideau modale direct, fara sa rateze vreunul.
var openModalCount=0;
function lockPageScroll(){var y=window.scrollY||window.pageYOffset||0;document.body.style.position='fixed';document.body.style.top=(-y)+'px';document.body.style.left='0';document.body.style.right='0';document.body.dataset.lockedY=y}
function unlockPageScroll(){var y=parseInt(document.body.dataset.lockedY||'0',10);document.body.style.position='';document.body.style.top='';document.body.style.left='';document.body.style.right='';delete document.body.dataset.lockedY;window.scrollTo(0,y)}
function openModal(el){if(!el)return;if(openModalCount===0)lockPageScroll();openModalCount++;el.classList.add('open')}
function closeModal(el){if(!el)return;if(!el.classList.contains('open'))return;el.classList.remove('open');openModalCount=Math.max(0,openModalCount-1);if(openModalCount===0)unlockPageScroll()}
function openPublish(){if(mode!=='fleet')return;state.editingId=null;E.publishForm.reset();state.imageData=null;E.imagePreview.removeAttribute('src');E.publishModal.querySelector('.modalhead h3').textContent='Pubblica annuncio';E.publishForm.querySelector('[type=submit]').textContent='Pubblica';openModal(E.publishModal);dynamicForm()}
E.publishBtn.style.display=mode==='fleet'?'flex':'none';E.mineBtn.style.display=mode==='fleet'?'flex':'none';E.fType.onchange=dynamicForm;E.publishBtn.onclick=openPublish;E.favBtn.onclick=openFavorites;E.mineBtn.onclick=openMine;
E.publishForm.onsubmit=function(ev){ev.preventDefault();if(mode!=='fleet')return;var payload={type:E.fType.value,title:E.fTitle.value.trim(),company:E.fCompany.value.trim(),location:E.fLocation.value.trim(),contact:E.fContact.value.trim(),description:E.fDescription.value.trim(),badge:E.fBadge.value,visibility:E.fVisibility.value,promotion:E.fPromotion.value,category:(document.getElementById('fCategory')||{}).value||'',price_label:(document.getElementById('fPrice')||{}).value||'',work_mode:(document.getElementById('fWork')||{}).value||'',extra:(document.getElementById('fExtra')||{}).value||'',image_data:state.imageData};var btn=E.publishForm.querySelector('[type=submit]');btn.disabled=true;btn.textContent='Pubblicazione…';apiCall(state.editingId?'update':'create',state.editingId?{id:state.editingId,item:payload}:{item:payload}).then(function(r){if(!r.ok)throw new Error(r.error||'Errore');closeModal(E.publishModal);E.publishForm.reset();state.imageData=null;state.editingId=null;E.imagePreview.removeAttribute('src');load()}).catch(function(err){alert('Pubblicazione non riuscita: '+err.message)}).finally(function(){btn.disabled=false;btn.textContent='Pubblica'})}
function openEdit(it){if(mode!=='fleet')return;state.editingId=it.id;state.imageData=null;closeModal(E.detailModal);openModal(E.publishModal);E.publishModal.querySelector('.modalhead h3').textContent='Modifica annuncio';E.fType.value=it.type||'job';dynamicForm();E.fTitle.value=it.title||'';E.fCompany.value=it.company||'';E.fLocation.value=it.location||'';E.fContact.value=it.contact||'';E.fDescription.value=it.description||'';E.fBadge.value=it.badge||'';E.fVisibility.value=it.visibility||'public';E.fPromotion.value=it.promotion||'standard';var fc=document.getElementById('fCategory'),fp=document.getElementById('fPrice'),fw=document.getElementById('fWork'),fx=document.getElementById('fExtra');if(fc)fc.value=it.category||fc.value;if(fp)fp.value=it.price_label||'';if(fw)fw.value=it.work_mode||'';if(fx)fx.value=it.extra||'';if(it.image_url){E.imagePreview.src=it.image_url;E.imageStatus.textContent='Immagine attuale. Caricane una nuova solo se vuoi sostituirla.'}E.publishForm.querySelector('[type=submit]').textContent='Salva modifiche'}
function openDetail(id){var it=state.items.find(function(x){return x.id===id});if(!it)return;var img=it.image_url?'<img src="'+esc(it.image_url)+'" alt="">':'<div class="thumb placeholder" style="width:130px;height:130px">'+icon(it.type)+'</div>';E.detailBody.innerHTML='<div class="detailhero">'+img+'<div><div class="title" style="font-size:21px;white-space:normal">'+esc(it.title)+'</div><div class="company" style="font-size:14px">'+esc(it.company)+'</div><div class="meta">'+esc(it.location)+'</div><div class="chips">'+(it.category?'<span class="chip">'+esc(it.category)+'</span>':'')+(it.work_mode?'<span class="chip">'+esc(it.work_mode)+'</span>':'')+(it.price_label?'<span class="chip money">'+esc(it.price_label)+'</span>':'')+'</div></div></div><div class="sectionhead"><h2>Descrizione</h2></div><div class="detaildesc">'+esc(it.description||'')+'</div>'+(it.contact?'<div class="sectionhead"><h2>Contatto</h2></div><div class="detaildesc">'+esc(it.contact)+'</div>':'')+(mode==='fleet'&&!String(it.id).startsWith('demo')?'<div class="owner-tools"><button class="ghost" id="editAd">Modifica</button><button class="ghost danger" id="deleteAd">Elimina annuncio</button></div>':'');openModal(E.detailModal);var edit=document.getElementById('editAd');if(edit)edit.onclick=function(){openEdit(it)};var del=document.getElementById('deleteAd');if(del)del.onclick=function(){if(!confirm('Eliminare questo annuncio?'))return;apiCall('delete',{id:it.id}).then(function(r){if(!r.ok)throw new Error(r.error||'Errore');closeModal(E.detailModal);load()}).catch(function(e){alert(e.message)})}}
document.querySelectorAll('[data-close]').forEach(function(b){b.onclick=function(){closeModal(document.getElementById(b.dataset.close))}});document.querySelectorAll('.modalbg').forEach(function(m){m.onclick=function(e){if(e.target===m)closeModal(m)}});
[E.search,E.zone,E.category,E.sort].forEach(function(x){x.addEventListener(x.tagName==='INPUT'?'input':'change',render)});
document.getElementById('backBtn').onclick=function(){if(history.length>1)history.back();else location.href=mode==='fleet'&&fleetSlug?'/'+encodeURIComponent(fleetSlug):'/'};
document.getElementById('themeBtn').onclick=function(){var l=document.documentElement.getAttribute('data-theme')==='light';if(l){document.documentElement.removeAttribute('data-theme');localStorage.setItem('adb_annunci_theme','dark')}else{document.documentElement.setAttribute('data-theme','light');localStorage.setItem('adb_annunci_theme','light')}};
E.contextLabel.textContent=mode==='fleet'?'Fleet · Annunci':'App autista · Annunci';E.pageTitle.textContent=mode==='fleet'?'Annunci':'Trova lavoro';E.pageSub.textContent=mode==='fleet'?'Pubblica e gestisci opportunità, servizi e marketplace':'Offerte, marketplace e servizi per autisti';
document.getElementById('promoBtn').onclick=function(){alert('Modulo promozioni predisposto. Collega Stripe/prezzi prima di attivare gli addebiti reali.')};
renderTabs();renderSide();fillCategories();dynamicForm();load();

// Cerut direct ("sa pot trage cu degetul in partea laterala a
// paginii si sa intre in cealalta pagina de anunturi... sa fie mai
// profesionala acea trecere"): gest de tragere stanga/dreapta intre
// sectiuni (Lavoro/Marketplace/Servizi, sau cele 4 pentru fleet) —
// scrie explicit distinctia fata de un simplu scroll vertical
// (deplasarea orizontala trebuie sa domine clar cea verticala,
// altfel nu se declanseaza nimic), plus o tranzitie scurta de
// alunecare, ca schimbarea sa se simta intentionata, nu brusca.
(function setupSwipe(){
  var startX=0,startY=0,tracking=false,swiped=false;
  var target=document.querySelector('.main')||document.body;
  target.addEventListener('touchstart',function(e){
    if(e.touches.length!==1)return;
    startX=e.touches[0].clientX;startY=e.touches[0].clientY;tracking=true;swiped=false;
  },{passive:true});
  target.addEventListener('touchmove',function(e){
    if(!tracking||swiped||e.touches.length!==1)return;
    var dx=e.touches[0].clientX-startX,dy=e.touches[0].clientY-startY;
    // Pragul (60px) si raportul (dublu fata de miscarea verticala)
    // evita declansarea accidentala la un scroll normal, usor piezis.
    if(Math.abs(dx)>60&&Math.abs(dx)>Math.abs(dy)*2){
      swiped=true;
      var idx=tabs.findIndex(function(t){return t[0]===state.tab});
      var nextIdx=dx<0?idx+1:idx-1;
      // Cerut direct ("posibilitatea de a trece din pagina home in
      // pagina de anunturi si invers"): la primul tab, o tragere spre
      // dreapta (ca si cum ai vrea sa mergi "inainte de primul")
      // intoarce acum la Home, in loc sa nu faca nimic - a doua
      // jumatate a aceleiasi functii, simetrica cu gestul de pe Home
      // care intra aici. Doar in modul sofer - fleet nu are o pagina
      // "Home" de forma asta catre care sa se intoarca in acelasi fel.
      if(nextIdx<0){if(mode==='driver'&&dx>0){window.location.href='/';}return}
      if(nextIdx>=tabs.length)return; // dupa ultima, nu exista "mai departe"
      var dir=dx<0?1:-1;
      E.cards.style.transition='transform .18s ease, opacity .18s ease';
      E.cards.style.transform='translateX('+(-dir*24)+'px)';E.cards.style.opacity='0';
      setTimeout(function(){
        state.tab=tabs[nextIdx][0];renderTabs();renderSide();fillCategories();render();
        E.cards.style.transition='none';
        E.cards.style.transform='translateX('+(dir*24)+'px)';
        requestAnimationFrame(function(){
          E.cards.style.transition='transform .18s ease, opacity .18s ease';
          E.cards.style.transform='translateX(0)';E.cards.style.opacity='1';
        });
      },140);
    }
  },{passive:true});
  target.addEventListener('touchend',function(){tracking=false},{passive:true});
})();
})();
