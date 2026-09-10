import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FLEET_API = `${SUPABASE_URL}/functions/v1/fleet-data`;
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
    contact: cleanText(raw.contact,180) || null, description: cleanText(raw.description,1800),
    badge: allowedBadge.includes(raw.badge) && raw.badge ? raw.badge : null,
    promotion: allowedPromotion.includes(raw.promotion) ? raw.promotion : 'standard',
    visibility: allowedVisibility.includes(raw.visibility) ? raw.visibility : 'public'
  };
}

async function uploadImage(dataUri: string | null | undefined, id: string) {
  if (!dataUri) return { image_url:null, image_path:null };
  const m = dataUri.match(/^data:(image\/(?:webp|jpeg|png));base64,(.+)$/);
  if (!m) throw new Error('invalid_image');
  const bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
  if (bytes.byteLength > 10240) throw new Error('image_too_large');
  const ext = m[1] === 'image/jpeg' ? 'jpg' : m[1].split('/')[1];
  const path = `${new Date().getUTCFullYear()}/${id}.${ext}`;
  const { error } = await admin.storage.from('adb-annunci').upload(path, bytes, { contentType:m[1], upsert:true, cacheControl:'86400' });
  if (error) throw error;
  const { data } = admin.storage.from('adb-annunci').getPublicUrl(path);
  return { image_url:data.publicUrl, image_path:path };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers:cors });
  if (req.method !== 'POST') return json({ ok:false, error:'method_not_allowed' },405);
  try {
    const body = await req.json();
    const action = body.action || 'list';

    if (action === 'health') return json({ ok:true });

    if (action === 'list') {
      const type = ['job','client','marketplace','service'].includes(body.type) ? body.type : 'job';
      let q = admin.from('adb_annunci').select('id,type,title,company,location,category,price_label,work_mode,extra,contact,description,image_url,badge,promotion,visibility,author_fleet_slug,created_at,updated_at,expires_at').eq('type',type).eq('visibility','public').gt('expires_at',new Date().toISOString()).order('created_at',{ascending:false}).limit(100);
      const { data, error } = await q;
      if (error) throw error;
      return json({ ok:true, items:data || [] });
    }

    const fleetOk = await verifyFleet(body.fleet_slug, body.fleet_password);
    if (!fleetOk) return json({ ok:false, error:'fleet_auth_required' },401);

    if (action === 'mine') {
      const { data, error } = await admin.from('adb_annunci').select('*').eq('author_fleet_slug',body.fleet_slug).neq('visibility','archived').order('created_at',{ascending:false});
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
      const image = await uploadImage(body.item?.image_data || null,id);
      const { data, error } = await admin.from('adb_annunci').insert({ id, ...item, ...image, author_kind:'fleet', author_fleet_slug:body.fleet_slug }).select().single();
      if (error) throw error;
      return json({ ok:true, item:data });
    }

    if (action === 'update') {
      const id = cleanText(body.id,60); const item = normalizeItem(body.item || {});
      const { data: old, error: oldErr } = await admin.from('adb_annunci').select('id,image_path').eq('id',id).eq('author_fleet_slug',body.fleet_slug).single();
      if (oldErr || !old) return json({ok:false,error:'not_found'},404);
      let image:any = {};
      if (body.item?.image_data) image = await uploadImage(body.item.image_data,id);
      const { data, error } = await admin.from('adb_annunci').update({ ...item, ...image }).eq('id',id).eq('author_fleet_slug',body.fleet_slug).select().single();
      if (error) throw error;
      return json({ok:true,item:data});
    }

    if (action === 'delete') {
      const id = cleanText(body.id,60);
      const { data: old } = await admin.from('adb_annunci').select('image_path').eq('id',id).eq('author_fleet_slug',body.fleet_slug).maybeSingle();
      const { error } = await admin.from('adb_annunci').delete().eq('id',id).eq('author_fleet_slug',body.fleet_slug);
      if (error) throw error;
      if (old?.image_path) await admin.storage.from('adb-annunci').remove([old.image_path]);
      return json({ok:true});
    }

    return json({ok:false,error:'unknown_action'},400);
  } catch (e) {
    console.error(e);
    return json({ok:false,error:e instanceof Error ? e.message : 'internal_error'},500);
  }
});
