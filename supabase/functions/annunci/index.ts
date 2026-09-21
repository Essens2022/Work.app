import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FLEET_API = `${SUPABASE_URL}/functions/v1/fleet-data`;
const CHECK_EMAIL_API = `${SUPABASE_URL}/functions/v1/check-email-confirmed`;
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST,OPTIONS' };
const json = (data: unknown, status=200) => new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

async function verifyFleet(slug?: string, password?: string) {
  if (!slug || !password) return false;
  try {
    const r = await fetch(FLEET_API, { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify({ action:'fleet_login', slug, password }) });
    if (!r.ok) return false;
    const d = await r.json();
    return d && d.ok === true;
  } catch { return false; }
}

// Gasit real ("soferul e deja logat in propria aplicatie, nu ar trebui
// sa i se ceara Google din nou in Bacheca"): confirmarea de email a
// soferului NU trece prin sesiunea obisnuita Supabase Auth vazuta de
// aceasta pagina (magic link-ul se deschide adesea intr-un context de
// navigare COMPLET SEPARAT, vezi check-email-confirmed) - clientul nu
// poate trimite un access_token pe care nu-l are niciodata cu adevarat.
// In schimb, trimite direct emailul lui deja confirmat - verificat AICI,
// din nou, real, exact ca la Flota (verifyFleet), interogand aceeasi
// functie care deja stie sigur daca acel email e cu adevarat confirmat
// in Supabase Auth (nu doar crezut pe cuvant, ca sa nu poata cineva sa
// publice/salveze anunturi in numele oricarui email inventat).
async function verifyDriverEmail(email?: string) {
  if (!email) return false;
  try {
    const r = await fetch(CHECK_EMAIL_API, { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify({ email }) });
    if (!r.ok) return false;
    const d = await r.json();
    return d && d.confirmed === true;
  } catch { return false; }
}

function cleanText(v: unknown, max=1800) { return String(v ?? '').trim().slice(0,max); }
function normalizeItem(raw: any) {
  const allowedTypes = ['job','client','marketplace','service'];
  const allowedBadge = ['','new','urgent','sponsored'];
  const allowedPromotion = ['standard','featured','sponsored'];
  const allowedVisibility = ['public','draft','archived'];
  const type = allowedTypes.includes(raw.type) ? raw.type : 'job';
  return {
    type,
    title: cleanText(raw.title,80), company: cleanText(raw.company,80), location: cleanText(raw.location,120),
    category: cleanText(raw.category,80) || null, price_label: cleanText(raw.price_label,80) || null,
    work_mode: cleanText(raw.work_mode,80) || null, extra: cleanText(raw.extra,120) || null,
    // Cerut direct ("i dati di contatto devono essere il numero di
    // cellulare... un'altra riga deve essere per lo WhatsApp... il
    // numero di contatto potrebbe essere un numero di ufficio che non
    // ha WhatsApp"): doua campuri separate - contact (telefon, cerut)
    // si whatsapp (optional, autorul il completeaza doar daca vrea).
    // Email nu mai e nevoie in anunturi.
    contact: cleanText(raw.contact,180) || null, whatsapp: cleanText(raw.whatsapp,40) || null, description: cleanText(raw.description,1800),
    badge: allowedBadge.includes(raw.badge) && raw.badge ? raw.badge : null,
    promotion: allowedPromotion.includes(raw.promotion) ? raw.promotion : 'standard',
    visibility: allowedVisibility.includes(raw.visibility) ? raw.visibility : 'public'
  };
}

async function uploadImage(dataUri: string | null | undefined, id: string, suffix = '') {
  if (!dataUri) return { image_url:null, image_path:null };
  const m = dataUri.match(/^data:(image\/(?:webp|jpeg|png));base64,(.+)$/);
  if (!m) throw new Error('invalid_image');
  const bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
  if (bytes.byteLength > 204800) throw new Error('image_too_large');
  const ext = m[1] === 'image/jpeg' ? 'jpg' : m[1].split('/')[1];
  const path = `${new Date().getUTCFullYear()}/${id}${suffix}.${ext}`;
  const { error } = await admin.storage.from('adb-annunci').upload(path, bytes, { contentType:m[1], upsert:true, cacheControl:'86400' });
  if (error) throw error;
  const { data } = admin.storage.from('adb-annunci').getPublicUrl(path);
  // Gasit real (acelasi bug ca la partajarea WhatsApp, dar aici lovea
  // aplicatia principala): fisierul e mereu suprascris la ACEEASI
  // adresa (upsert, acelasi nume) si e cache-uit 24h (cacheControl).
  // Cand cineva schimba poza, telefonul care tocmai a incarcat-o vede
  // versiunea noua (nu avea nimic in cache), dar orice alt dispozitiv
  // (calculatorul) care vazuse deja poza veche o tine in cache si tot
  // aia continua sa arate. Adaugam un parametru de versiune chiar in
  // adresa STOCATA in baza de date, ca fiecare inlocuire de poza sa
  // primeasca o adresa noua peste tot, garantat, indiferent de cache.
  const versionedUrl = `${data.publicUrl}?v=${Date.now()}`;
  return { image_url:versionedUrl, image_path:path };
}

// Cerut direct ("la categoria marketplace fiecare anunt are
// posibilitate sa incarce pana la 3 poze, cu posibilitatea de a alege
// pe care sa o modifice care sa fie prima care a doua si care a
// treia"): clientul trimite o lista ordonata de pana la 3 "sloturi"
// (body.item.images) - prima devine imaginea principala (image_url/
// image_path, ca inainte), urmatoarele devin extra_images, in ordinea
// exacta trimisa. Fiecare slot e ORICE dintre:
//  - un data URI nou ("data:image/...") -> se incarca acum;
//  - "keep:<path>" -> o poza deja incarcata, ramasa neschimbata (sau
//    doar mutata pe alta pozitie/rol) - NU se reincarca, se refoloseste
//    direct adresa ei existenta, ca sa nu iroseasca incarcari inutile.
async function resolveImageSlot(entry: unknown, id: string, suffix: string, oldByPath: Map<string, { image_url: string; image_path: string }>) {
  if (typeof entry !== 'string' || !entry) return null;
  if (entry.startsWith('data:image/')) return await uploadImage(entry, id, suffix);
  if (entry.startsWith('keep:')) {
    const path = entry.slice(5);
    return oldByPath.get(path) || null;
  }
  return null;
}
async function resolveMarketplaceImages(images: unknown, id: string, oldByPath: Map<string, { image_url: string; image_path: string }>) {
  const slots = Array.isArray(images) ? images.slice(0, 3) : [];
  const resolved: { image_url: string; image_path: string }[] = [];
  for (let i = 0; i < slots.length; i++) {
    const r = await resolveImageSlot(slots[i], id, i === 0 ? '' : `-${i + 1}`, oldByPath);
    if (r && r.image_url && r.image_path) resolved.push(r);
  }
  return resolved;
}

function escapeHtml(s: string) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c] as string));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers:cors });

  // Cerut direct ("cand trimiti pe WhatsApp... ar trebui sa se
  // trimita impreuna cu imaginea sa... exact ca la retelele de
  // socializare"): WhatsApp/Facebook/etc. NU executa JavaScript cand
  // citesc un link pentru previzualizare - au nevoie de etichete
  // og:image/og:title chiar in codul HTML brut, pe care un site pur
  // static (fara server) nu le poate genera diferit pentru fiecare
  // anunt. Solutia: un raspuns GET, servit chiar de aici (functia
  // ruleaza pe server, poate citi baza de date pe loc) - contine
  // etichetele corecte pentru ORICE anunt, apoi redirectioneaza
  // instant browserele reale (nu si robotii de previzualizare, care
  // nu urmaresc redirectarile JS) catre pagina interactiva reala.
  if (req.method === 'GET') {
    const url = new URL(req.url);
    const id = url.searchParams.get('id') || '';
    // Cerut direct ("sa unim la fletul la bacheca... o pagina cu trei
    // intrari"): pagina Annunci separata a fost retrasa - bacheca e
    // acum sursa unica (si stie deja sa deschida direct un anunt
    // primit prin ?ad=, vezi openSharedAdIfPresent in bacheca/index.html).
    const destination = `https://adbsmart.it/bacheca/?ad=${encodeURIComponent(id)}`;
    if (!id) return Response.redirect(destination, 302);
    try {
      const { data } = await admin.from('adb_annunci').select('title,company,location,description,image_url,updated_at').eq('id', id).eq('visibility','public').maybeSingle();
      const title = data ? escapeHtml(data.title) : 'ADB Smart — Annunci';
      const desc = data ? escapeHtml(`${data.company} · ${data.location}`) : 'Offerte di lavoro, marketplace e servizi per autisti.';
      // Cerut direct ("imaginea tot continua sa nu se primeasca"):
      // WhatsApp cacheaza si imaginea insasi, separat de pagina.
      // image_url are acum mereu propriul parametru de versiune bagat
      // direct la incarcare (vezi uploadImage), asa ca nu mai trebuie
      // adaugat unul aici - il folosim asa cum e, garantat proaspat.
      const image = data?.image_url ? escapeHtml(data.image_url) : 'https://adbsmart.it/icon-512.png';
      // Gasit real ("cand trimit linkul, nu apare nimic - doar text
      // simplu, fara card"): lipsea "og:url" - Facebook/WhatsApp cer
      // explicit aceasta eticheta (impreuna cu og:title/og:image/
      // og:type) ca sa accepte sa genereze o previzualizare deloc; fara
      // ea, unele crawlere renunta complet, fara card, fara eroare
      // vizibila - exact simptomul raportat. Trebuie sa fie chiar
      // adresa cerută de crawler (aceasta pagina), nu tinta finala.
      const shareUrl = escapeHtml(url.toString());
      const html = `<!doctype html><html><head><meta charset="utf-8">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:image" content="${image}">
<meta property="og:url" content="${shareUrl}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="ADB Smart">
<meta name="twitter:card" content="summary_large_image">
<meta http-equiv="refresh" content="0;url=${destination}">
<script>location.replace(${JSON.stringify(destination)});</script>
</head><body>Apri l'annuncio…</body></html>`;
      return new Response(html, { headers: { ...cors, 'Content-Type': 'text/html; charset=utf-8' } });
    } catch {
      return Response.redirect(destination, 302);
    }
  }

  if (req.method !== 'POST') return json({ ok:false, error:'method_not_allowed' },405);
  try {
    const body = await req.json();
    const action = body.action || 'list';

    if (action === 'health') return json({ ok:true });

    // Cerut direct ("sa aiba calculul de cate ori a fost vizualizata
    // acea postare... simpla vazuta sau chiar deschisa... doi
    // indicatori"): publice, fara autentificare - oricine rasfoieste
    // sau deschide un anunt conteaza, nu doar flotele autentificate.
    // O functie SQL dedicata (adb_annunci_increment_view/click) face
    // incrementarea atomic, direct in baza de date, ca doua persoane
    // care vizualizeaza simultan sa nu se piarda o vizualizare intre
    // ele (citeste-modifica-scrie separat ar fi vulnerabil la asta).
    if (action === 'track_view') {
      const id = cleanText(body.id,60);
      if (!id) return json({ ok:false, error:'missing_id' },400);
      const { error } = await admin.rpc('adb_annunci_increment_view', { p_id:id });
      if (error) throw error;
      return json({ ok:true });
    }
    if (action === 'track_click') {
      const id = cleanText(body.id,60);
      if (!id) return json({ ok:false, error:'missing_id' },400);
      const { error } = await admin.rpc('adb_annunci_increment_click', { p_id:id });
      if (error) throw error;
      return json({ ok:true });
    }
    // Cerut direct ("cate trimiteri a fost... cati au trimis
    // anuntul... cate inaintari au fost"): al treilea indicator,
    // separat de vizualizari si click-uri - cate ori a fost apasat
    // butonul de distribuire.
    if (action === 'track_share') {
      const id = cleanText(body.id,60);
      if (!id) return json({ ok:false, error:'missing_id' },400);
      const { error } = await admin.rpc('adb_annunci_increment_share', { p_id:id });
      if (error) throw error;
      return json({ ok:true });
    }
    // Cerut direct ("cati au pus la preferite, cati au salvat"): al
    // patrulea indicator - cate ori a fost adaugat la preferite
    // (inima apasata), separat de celelalte trei.
    if (action === 'track_save') {
      const id = cleanText(body.id,60);
      if (!id) return json({ ok:false, error:'missing_id' },400);
      const { error } = await admin.rpc('adb_annunci_increment_save', { p_id:id });
      if (error) throw error;
      return json({ ok:true });
    }

    if (action === 'list') {
      const type = ['job','client','marketplace','service'].includes(body.type) ? body.type : 'job';
      let q = admin.from('adb_annunci').select('id,type,title,company,location,category,price_label,work_mode,extra,contact,whatsapp,description,image_url,extra_images,badge,promotion,visibility,author_fleet_slug,created_at,updated_at,expires_at').eq('type',type).eq('visibility','public').gt('expires_at',new Date().toISOString()).order('created_at',{ascending:false}).limit(100);
      const { data, error } = await q;
      if (error) throw error;
      return json({ ok:true, items:data || [] });
    }

    // Cerut direct ("verifica la publicare... publicarea nu era doar
    // pentru flote"): oricine logat cu Google, prin Bacheca publica,
    // poate acum publica si gestiona propriile anunturi - nu doar
    // flotele. Verificam intai daca a fost trimis un token de sesiune
    // Supabase (contul Google); daca nu, cadem inapoi pe verificarea
    // de flota, ca inainte - niciuna dintre cele doua cai nu o
    // schimba pe cealalta.
    let authorFilter: { column: string; value: string } | null = null;
    if (body.access_token) {
      const { data: userData, error: userErr } = await admin.auth.getUser(body.access_token);
      if (!userErr && userData?.user?.email) {
        authorFilter = { column: 'author_user_email', value: userData.user.email.toLowerCase() };
      }
    }
    if (!authorFilter) {
      const fleetOk = await verifyFleet(body.fleet_slug, body.fleet_password);
      if (fleetOk) authorFilter = { column: 'author_fleet_slug', value: body.fleet_slug };
    }
    // A treia cale, pentru soferul deja logat in propria aplicatie
    // (vezi verifyDriverEmail mai sus) - acelasi author_user_email ca
    // la un cont Google obisnuit, deci favorite/anunturi publicate asa
    // se comporta identic cu cele publicate printr-un login Google real.
    if (!authorFilter && body.driver_email) {
      const driverOk = await verifyDriverEmail(body.driver_email);
      if (driverOk) authorFilter = { column: 'author_user_email', value: String(body.driver_email).toLowerCase() };
    }
    if (!authorFilter) return json({ ok:false, error:'auth_required' },401);

    // Cerut direct ("trebuie sa fie si sectiunea preferiti"): salvarea
    // ca preferat foloseste acelasi cont Google logat (authorFilter),
    // indiferent daca e author_user_email sau, teoretic, o flota.
    if (action === 'favorite') {
      const annuncioId = cleanText(body.annuncio_id,60);
      if (!annuncioId) return json({ ok:false, error:'missing_annuncio_id' },400);
      const { error } = await admin.from('adb_annunci_favorites').upsert(
        { user_email: authorFilter.value, annuncio_id: annuncioId },
        { onConflict: 'user_email,annuncio_id' }
      );
      if (error) throw error;
      try { await admin.rpc('adb_annunci_increment_save', { p_id: annuncioId }); } catch { /* contorul e doar informativ, nu blocheaza salvarea */ }
      return json({ ok:true });
    }
    if (action === 'unfavorite') {
      const annuncioId = cleanText(body.annuncio_id,60);
      const { error } = await admin.from('adb_annunci_favorites').delete().eq('user_email',authorFilter.value).eq('annuncio_id',annuncioId);
      if (error) throw error;
      return json({ ok:true });
    }
    if (action === 'list_favorites') {
      const { data: favRows, error: favErr } = await admin.from('adb_annunci_favorites').select('annuncio_id').eq('user_email',authorFilter.value).order('created_at',{ascending:false});
      if (favErr) throw favErr;
      const ids = (favRows || []).map((r: any) => r.annuncio_id);
      if (!ids.length) return json({ ok:true, items: [] });
      const { data, error } = await admin.from('adb_annunci').select('*').in('id', ids);
      if (error) throw error;
      // Pastram ordinea (cele mai recent salvate primele), nu ordinea arbitrara intoarsa de "in".
      const byId: Record<string, any> = {};
      (data || []).forEach((item: any) => { byId[item.id] = item; });
      return json({ ok:true, items: ids.map((id: string) => byId[id]).filter(Boolean) });
    }

    if (action === 'mine') {
      const { data, error } = await admin.from('adb_annunci').select('*').eq(authorFilter.column,authorFilter.value).neq('visibility','archived').order('created_at',{ascending:false});
      if (error) throw error;
      return json({ ok:true, items:data || [] });
    }

    if (action === 'create') {
      const item = normalizeItem(body.item || {});
      if (!item.title || !item.company || !item.location || !item.description) return json({ok:false,error:'missing_required_fields'},400);
      // Cerut direct ("Compenso, salariul la fel sa fie obligatoriu de
      // pus"): pentru anunturile de tip loc de munca, compensul e
      // acum obligatoriu si pe server, nu doar in formular - un
      // apel direct catre server (ocolind formularul) nu poate scapa
      // fara aceasta informatie.
      if (item.type === 'job' && !item.price_label) return json({ok:false,error:'missing_required_fields'},400);
      const id = crypto.randomUUID();
      let image: any = {};
      let extraImages: any[] = [];
      if (item.type === 'marketplace' && Array.isArray(body.item?.images)) {
        // Un anunt nou nu are poze vechi de pastrat - harta e goala,
        // deci orice "keep:" trimis (n-ar trebui sa se intample) e ignorat.
        const resolved = await resolveMarketplaceImages(body.item.images, id, new Map());
        image = resolved[0] ? { image_url: resolved[0].image_url, image_path: resolved[0].image_path } : {};
        extraImages = resolved.slice(1);
      } else {
        image = await uploadImage(body.item?.image_data || null,id);
      }
      const authorFields = authorFilter.column === 'author_user_email'
        ? { author_kind:'user', author_user_email: authorFilter.value }
        : { author_kind:'fleet', author_fleet_slug: authorFilter.value };
      const { data, error } = await admin.from('adb_annunci').insert({ id, ...item, ...image, extra_images: extraImages, ...authorFields }).select().single();
      if (error) throw error;
      return json({ ok:true, item:data });
    }

    if (action === 'update') {
      const id = cleanText(body.id,60); const item = normalizeItem(body.item || {});
      const { data: old, error: oldErr } = await admin.from('adb_annunci').select('id,image_url,image_path,extra_images').eq('id',id).eq(authorFilter.column,authorFilter.value).single();
      if (oldErr || !old) return json({ok:false,error:'not_found'},404);
      let image: any = {};
      let extraImagesUpdate: any = {};
      if (item.type === 'marketplace' && Array.isArray(body.item?.images)) {
        // Cerut direct: lista trimisa (body.item.images) e mereu
        // versiunea COMPLETA, finala, in ordinea dorita de autor - poate
        // amesteca poze noi ("data:...") cu poze vechi pastrate/mutate
        // ("keep:<path>"). Orice poza veche care nu mai apare deloc in
        // noua lista se sterge din depozit, nu ramane orfana.
        const oldByPath = new Map<string, { image_url: string; image_path: string }>();
        if (old.image_path) oldByPath.set(old.image_path, { image_url: (old as any).image_url, image_path: old.image_path });
        (old.extra_images || []).forEach((e: any) => { if (e?.image_path) oldByPath.set(e.image_path, { image_url: e.image_url, image_path: e.image_path }); });
        const resolved = await resolveMarketplaceImages(body.item.images, id, oldByPath);
        const keptPaths = new Set(resolved.map(r => r.image_path));
        const toRemove = Array.from(oldByPath.keys()).filter(p => !keptPaths.has(p));
        if (toRemove.length) await admin.storage.from('adb-annunci').remove(toRemove);
        image = resolved[0] ? { image_url: resolved[0].image_url, image_path: resolved[0].image_path } : { image_url: null, image_path: null };
        extraImagesUpdate = { extra_images: resolved.slice(1) };
      } else {
        if (body.item?.image_data) {
          image = await uploadImage(body.item.image_data,id);
          // Extensia poate diferi de cea veche (rar, dar posibil) - in
          // acel caz calea din depozit e alta, iar fisierul vechi ar
          // ramane orfan (nefolosit, dar tot ocupat) daca nu-l stergem.
          if (old.image_path && image.image_path && old.image_path !== image.image_path) {
            await admin.storage.from('adb-annunci').remove([old.image_path]);
          }
        }
        if (item.type !== 'marketplace' && old.extra_images && (old.extra_images as any[]).length) {
          // Categoria s-a schimbat din marketplace in alta - pozele
          // suplimentare nu mai au sens, le stergem din depozit si din baza.
          const oldPaths: string[] = (old.extra_images || []).map((e: any) => e.image_path).filter(Boolean);
          if (oldPaths.length) await admin.storage.from('adb-annunci').remove(oldPaths);
          extraImagesUpdate = { extra_images: [] };
        }
      }
      const { data, error } = await admin.from('adb_annunci').update({ ...item, ...image, ...extraImagesUpdate }).eq('id',id).eq(authorFilter.column,authorFilter.value).select().single();
      if (error) throw error;
      return json({ok:true,item:data});
    }

    if (action === 'delete') {
      const id = cleanText(body.id,60);
      const { data: old } = await admin.from('adb_annunci').select('image_path,extra_images').eq('id',id).eq(authorFilter.column,authorFilter.value).maybeSingle();
      const { error } = await admin.from('adb_annunci').delete().eq('id',id).eq(authorFilter.column,authorFilter.value);
      if (error) throw error;
      const paths: string[] = [];
      if (old?.image_path) paths.push(old.image_path);
      if (old?.extra_images) (old.extra_images as any[]).forEach((e: any) => { if (e?.image_path) paths.push(e.image_path); });
      if (paths.length) await admin.storage.from('adb-annunci').remove(paths);
      return json({ok:true});
    }

    return json({ok:false,error:'unknown_action'},400);
  } catch (e) {
    console.error(e);
    // Cerut direct ("Pubblicazione non riuscita: internal_error") -
    // gasit real: erorile venite de la Postgres/Supabase (ex. o
    // constrangere incalcata) NU sunt instante reale de Error in
    // JavaScript, sunt obiecte simple cu .message - verificarea de
    // dinainte (instanceof Error) le rata pe toate, aratand mereu
    // 'internal_error' in loc de motivul real, util pentru diagnostic.
    const message = (e && typeof e === 'object' && 'message' in e) ? String((e as any).message) : (e instanceof Error ? e.message : 'internal_error');
    return json({ok:false,error:message},500);
  }
});
