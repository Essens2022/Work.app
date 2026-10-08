// fleet-data — single action-routed endpoint, same pattern already
// used by chat-messages/admin-data/push-subscription in this project.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const ADMIN_PASSWORD = 'Essens2022';

const VAPID_PUBLIC = 'BE8wkq3SQmoE8L8x0pFVwYaLym1EYB14_NABB1qEiVOi0VvOpUDYAODObA5Lirh9Kfy6C97ExU5btOYLG7uHvgk';
const VAPID_PRIVATE = 'ugwrrcpzMepG4VJPCGPXpcErCbbVTrvDI7NBgyhqCzQ';
webpush.setVapidDetails('mailto:info@adbsmart.it', VAPID_PUBLIC, VAPID_PRIVATE);

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  });
}

function bufToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBuf(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, keyMaterial, 256);
  return bufToHex(salt) + ':' + bufToHex(bits);
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = hexToBuf(saltHex);
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, keyMaterial, 256);
  return bufToHex(bits) === hashHex;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

function generateTempPassword(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  for (let i = 0; i < 10; i++) out += chars[bytes[i] % chars.length];
  return out;
}

async function sendPushToDriverEmail(supabase: ReturnType<typeof createClient>, accountEmail: string, title: string, body: string) {
  const { data: driverRow } = await supabase.from('driver_activity').select('device_id').eq('account_email', accountEmail).limit(1);
  if (!driverRow || !driverRow.length) return;
  const { data: sub } = await supabase.from('push_subscriptions').select('subscription').eq('device_id', driverRow[0].device_id).maybeSingle();
  if (!sub) return;
  try {
    await webpush.sendNotification(sub.subscription, JSON.stringify({ title, body, type: 'novita' }));
  } catch (e) {
    const status = (e as { statusCode?: number })?.statusCode;
    if (status === 404 || status === 410) {
      await supabase.from('push_subscriptions').delete().eq('device_id', driverRow[0].device_id);
    }
  }
}

async function sendPushToFleet(supabase: ReturnType<typeof createClient>, fleetId: string, fleetSlug: string, title: string, body: string) {
  const { data: subs } = await supabase.from('fleet_push_subscriptions').select('id, subscription').eq('fleet_id', fleetId);
  if (!subs || !subs.length) return;
  const payload = JSON.stringify({ title, body, type: 'fleet', slug: fleetSlug });
  await Promise.all(subs.map(async (row: any) => {
    try {
      await webpush.sendNotification(row.subscription, payload);
    } catch (e) {
      const status = (e as { statusCode?: number })?.statusCode;
      if (status === 404 || status === 410) {
        await supabase.from('fleet_push_subscriptions').delete().eq('id', row.id);
      }
    }
  }));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }

  const action = body?.action;

  const RATE_LIMIT_MAX_ATTEMPTS = 8;
  const RATE_LIMIT_WINDOW_MINUTES = 15;
  async function isRateLimited(identifier: string): Promise<boolean> {
    const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MINUTES * 60 * 1000).toISOString();
    const { count } = await supabase.from('login_attempts').select('id', { count: 'exact', head: true })
      .eq('identifier', identifier).gte('attempted_at', windowStart);
    return (count || 0) >= RATE_LIMIT_MAX_ATTEMPTS;
  }
  async function recordFailedAttempt(identifier: string) {
    await supabase.from('login_attempts').insert({ identifier });
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await supabase.from('login_attempts').delete().eq('identifier', identifier).lt('attempted_at', dayAgo);
  }

  try {
    if (action === 'admin_create_fleet') {
      if (await isRateLimited('admin')) return json({ error: 'Troppi tentativi — riprova tra qualche minuto.' }, 429);
      if (body.password !== ADMIN_PASSWORD) { await recordFailedAttempt('admin'); return json({ error: 'Password errata' }, 401); }

      const name = (body.name || '').trim();
      const ownerEmail = (body.owner_email || '').trim().toLowerCase();
      if (!name || !ownerEmail) return json({ error: 'name e owner_email sono obbligatori' }, 400);

      const baseSlug = slugify(name);
      if (!baseSlug) return json({ error: 'nome non valido' }, 400);

      let slug = baseSlug;
      let suffix = 2;
      while (true) {
        const { data: existing } = await supabase.from('fleets').select('id').eq('slug', slug).maybeSingle();
        if (!existing) break;
        slug = baseSlug + suffix;
        suffix++;
      }

      const tempPassword = generateTempPassword();
      const passwordHash = await hashPassword(tempPassword);

      const { data: fleet, error } = await supabase
        .from('fleets')
        .insert({ name, slug, owner_email: ownerEmail, password_hash: passwordHash })
        .select('id, name, slug')
        .single();
      if (error) return json({ error: error.message }, 500);

      return json({ ok: true, fleet, temp_password: tempPassword });
    }

    if (action === 'admin_list_fleets') {
      if (await isRateLimited('admin')) return json({ error: 'Troppi tentativi — riprova tra qualche minuto.' }, 429);
      if (body.password !== ADMIN_PASSWORD) { await recordFailedAttempt('admin'); return json({ error: 'Password errata' }, 401); }

      const { data: fleets, error } = await supabase.from('fleets').select('id, name, slug, owner_email, created_at, disabled_at').order('created_at', { ascending: false });
      if (error) return json({ error: error.message }, 500);

      const { data: links } = await supabase.from('fleet_drivers').select('fleet_id, account_email').is('left_at', null);
      const fleetIdByEmail: Record<string, string> = {};
      const countByFleet: Record<string, number> = {};
      (links || []).forEach((l: any) => {
        countByFleet[l.fleet_id] = (countByFleet[l.fleet_id] || 0) + 1;
        fleetIdByEmail[l.account_email] = l.fleet_id;
      });

      const { data: allMemberships } = await supabase.from('fleet_drivers').select('fleet_id, account_email, added_at, left_at');
      const periodsByEmail: Record<string, { fleetId: string; start: Date; end: Date }[]> = {};
      (allMemberships || []).forEach((m: any) => {
        if (!periodsByEmail[m.account_email]) periodsByEmail[m.account_email] = [];
        periodsByEmail[m.account_email].push({
          fleetId: m.fleet_id,
          start: new Date(m.added_at),
          end: m.left_at ? new Date(m.left_at) : new Date(8640000000000000),
        });
      });
      function fleetIdAtMoment(email: string, when: Date): string | null {
        const periods = periodsByEmail[email] || [];
        const match = periods.find((p) => when >= p.start && when < p.end);
        return match ? match.fleetId : null;
      }

      const todayStr = new Date().toISOString().slice(0, 10);
      const allEmails = Object.keys(periodsByEmail);
      const deliveriesTodayByFleet: Record<string, number> = {};
      if (allEmails.length) {
        const { data: todayDeliveries } = await supabase.from('driver_deliveries').select('account_email, completed_at').in('account_email', allEmails).eq('delivery_date', todayStr);
        (todayDeliveries || []).forEach((d: any) => {
          const fid = fleetIdAtMoment(d.account_email, new Date(d.completed_at));
          if (fid) deliveriesTodayByFleet[fid] = (deliveriesTodayByFleet[fid] || 0) + 1;
        });
      }

      const result = (fleets || []).map((f: any) => ({
        ...f,
        driver_count: countByFleet[f.id] || 0,
        consegne_oggi: deliveriesTodayByFleet[f.id] || 0,
        stato: f.disabled_at ? 'disattivata' : ((countByFleet[f.id] || 0) > 0 ? 'attiva' : 'in_attivazione'),
      }));
      return json({ ok: true, fleets: result });
    }

    if (action === 'admin_toggle_fleet_disabled') {
      if (await isRateLimited('admin')) return json({ error: 'Troppi tentativi — riprova tra qualche minuto.' }, 429);
      if (body.password !== ADMIN_PASSWORD) { await recordFailedAttempt('admin'); return json({ error: 'Password errata' }, 401); }
      const fleetId = body.fleet_id;
      if (!fleetId) return json({ error: 'fleet_id mancante' }, 400);
      const { data: fleet } = await supabase.from('fleets').select('disabled_at').eq('id', fleetId).maybeSingle();
      if (!fleet) return json({ ok: false, reason: 'not_found' });
      const nowDisabling = !fleet.disabled_at;
      const { error } = await supabase.from('fleets').update({ disabled_at: nowDisabling ? new Date().toISOString() : null }).eq('id', fleetId);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, disabled: nowDisabling });
    }

    if (action === 'admin_delete_fleet') {
      if (await isRateLimited('admin')) return json({ error: 'Troppi tentativi — riprova tra qualche minuto.' }, 429);
      if (body.password !== ADMIN_PASSWORD) { await recordFailedAttempt('admin'); return json({ error: 'Password errata' }, 401); }
      const fleetId = body.fleet_id;
      if (!fleetId) return json({ error: 'fleet_id mancante' }, 400);
      const { data: fleet } = await supabase.from('fleets').select('id, name').eq('id', fleetId).maybeSingle();
      if (!fleet) return json({ ok: false, reason: 'not_found' });

      const { data: docs } = await supabase.from('fleet_documents').select('storage_path').eq('fleet_id', fleetId);
      if (docs && docs.length) {
        await supabase.storage.from('fleet-documents').remove(docs.map((d: any) => d.storage_path));
      }

      const { error } = await supabase.from('fleets').delete().eq('id', fleetId);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, deleted_name: fleet.name });
    }

    if (action === 'fleet_get_public_info') {
      const slug = (body.slug || '').trim().toLowerCase();
      const { data: fleet } = await supabase.from('fleets').select('name, slug').eq('slug', slug).maybeSingle();
      if (!fleet) return json({ ok: false, reason: 'not_found' });
      return json({ ok: true, fleet });
    }

    async function resolveLogin(slug: string, password: string) {
      const normalizedSlug = (slug || '').trim().toLowerCase();
      if (normalizedSlug && await isRateLimited('fleet:' + normalizedSlug)) return { rateLimited: true } as any;
      const { data: fleet } = await supabase.from('fleets').select('id, name, slug, password_hash, driver_note, owner_email, last_backup_at, backup_reminder_snoozed_until, disabled_at').eq('slug', normalizedSlug).maybeSingle();
      if (!fleet) return null;
      if (fleet.disabled_at) return { disabled: true } as any;

      if (await verifyPassword(password || '', fleet.password_hash)) {
        return { fleet, role: 'owner' as const, authAccount: { type: 'fleet_owner' as const } };
      }

      const { data: members } = await supabase.from('fleet_team_members').select('id, password_hash, role').eq('fleet_id', fleet.id);
      for (const m of members || []) {
        if (await verifyPassword(password || '', m.password_hash)) {
          return { fleet, role: m.role as 'owner' | 'viewer', authAccount: { type: 'team_member' as const, memberId: m.id } };
        }
      }
      await recordFailedAttempt('fleet:' + normalizedSlug);
      return null;
    }

    if (action === 'fleet_login') {
      const resolved = await resolveLogin(body.slug, body.password || '');
      if (resolved && (resolved as any).rateLimited) return json({ ok: false, reason: 'rate_limited' }, 429);
      if (resolved && (resolved as any).disabled) return json({ ok: false, reason: 'disabled' }, 403);
      if (!resolved) return json({ ok: false, reason: 'wrong_password' });
      return json({ ok: true, fleet: { id: resolved.fleet.id, name: resolved.fleet.name, slug: resolved.fleet.slug }, role: resolved.role });
    }

    async function requireFleet(slug: string, password: string, requiredRole?: 'owner') {
      const resolved = await resolveLogin(slug, password || '');
      if (resolved && ((resolved as any).rateLimited || (resolved as any).disabled)) return null;
      if (!resolved) return null;
      if (requiredRole === 'owner' && resolved.role !== 'owner') return null;
      return resolved;
    }

    async function getActiveMemberships(fleetId: string) {
      const { data } = await supabase.from('fleet_drivers').select('account_email, added_at').eq('fleet_id', fleetId).is('left_at', null);
      return data || [];
    }

    async function getAllMembershipPeriods(fleetId: string) {
      const { data } = await supabase.from('fleet_drivers').select('account_email, added_at, left_at').eq('fleet_id', fleetId);
      const periodsByEmail: Record<string, { start: Date; end: Date }[]> = {};
      (data || []).forEach((m: any) => {
        const start = new Date(m.added_at);
        const end = m.left_at ? new Date(m.left_at) : new Date(8640000000000000);
        if (!periodsByEmail[m.account_email]) periodsByEmail[m.account_email] = [];
        periodsByEmail[m.account_email].push({ start, end });
      });
      return periodsByEmail;
    }
    function wasEverMemberDuring(periods: { start: Date; end: Date }[], rangeStart: Date, rangeEnd: Date) {
      return periods.some((p) => p.start < rangeEnd && p.end > rangeStart);
    }
    function fallsInAnyPeriod(periods: { start: Date; end: Date }[], when: Date) {
      return periods.some((p) => when >= p.start && when < p.end);
    }

    if (action === 'fleet_get_dashboard') {
      const resolved = await requireFleet(body.slug, body.password);
      if (!resolved) return json({ ok: false, reason: 'auth' }, 401);
      const fleet = resolved.fleet;

      const memberships = await getActiveMemberships(fleet.id);
      const emails = memberships.map((l: any) => l.account_email);
      const addedAtByEmail: Record<string, string> = {};
      memberships.forEach((l: any) => { addedAtByEmail[l.account_email] = l.added_at; });

      const now = new Date();
      const currentMonth = now.getUTCMonth() + 1;
      const currentYear = now.getUTCFullYear();

      const monthStartForReminder = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const lastBackupAt = fleet.last_backup_at ? new Date(fleet.last_backup_at) : null;
      const snoozedUntil = fleet.backup_reminder_snoozed_until ? new Date(fleet.backup_reminder_snoozed_until) : null;
      const backupReminderDue = (!lastBackupAt || lastBackupAt < monthStartForReminder) && (!snoozedUntil || snoozedUntil < now);

      if (!emails.length) {
        return json({ ok: true, fleet: { name: fleet.name, slug: fleet.slug }, role: resolved.role, driver_note: fleet.driver_note || '', drivers: [], period: { month: currentMonth, year: currentYear }, in_consegna_count: 0, backup_reminder_due: backupReminderDue, last_backup_at: fleet.last_backup_at || null });
      }

      const { data: activity } = await supabase.from('driver_activity').select('*').in('account_email', emails);
      const { data: sheets } = await supabase.from('driver_sheets_summary').select('*')
        .in('account_email', emails)
        .eq('month', currentMonth)
        .eq('year', currentYear);
      const { data: liveStatus } = await supabase.from('driver_live_status').select('account_email, in_consegna').in('account_email', emails);
      const inConsegnaByEmail: Record<string, boolean> = {};
      (liveStatus || []).forEach((s: any) => { inConsegnaByEmail[s.account_email] = !!s.in_consegna; });

      const drivers = emails.map((email: string) => {
        const joinedAt = new Date(addedAtByEmail[email]);
        const joinedYear = joinedAt.getUTCFullYear();
        const joinedMonth = joinedAt.getUTCMonth() + 1;
        const sheetsAllowed = (currentYear > joinedYear) || (currentYear === joinedYear && currentMonth >= joinedMonth);

        const myActivityRows = (activity || []).filter((a: any) => a.account_email === email);
        let act: any = null;
        let actBestTime = -1;
        myActivityRows.forEach((a: any) => {
          const aTime = Math.max(
            a.last_active ? new Date(a.last_active).getTime() : 0,
            a.last_heartbeat ? new Date(a.last_heartbeat).getTime() : 0
          );
          if (!act || aTime > actBestTime) { act = a; actBestTime = aTime; }
        });
        const mySheetsRaw = sheetsAllowed ? (sheets || []).filter((s: any) => s.account_email === email) : [];
        const latestBySheetId = new Map<string, any>();
        mySheetsRaw.forEach((s: any) => {
          const key = s.sheet_id || (s.client + '|' + s.month + '|' + s.year);
          const existing = latestBySheetId.get(key);
          if (!existing || new Date(s.updated_at) > new Date(existing.updated_at)) {
            latestBySheetId.set(key, s);
          }
        });
        const mySheets = Array.from(latestBySheetId.values());
        const totalKm = mySheets.reduce((sum: number, s: any) => sum + (Number(s.total_km) || 0), 0);
        const totalGiorni = mySheets.reduce((sum: number, s: any) => sum + (Number(s.giorni_count) || 0), 0);
        return {
          account_email: email,
          nome: act?.nome || null,
          targa: act?.targa || null,
          last_active: act?.last_active || null,
          last_heartbeat: act?.last_heartbeat || null,
          total_km: totalKm,
          total_giorni: totalGiorni,
          in_consegna: !!inConsegnaByEmail[email],
        };
      });

      const inConsegnaCount = drivers.filter((d: any) => d.in_consegna).length;

      const ALERT_WINDOW_DAYS = 5;
      const alertCutoff = new Date(Date.now() + ALERT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
      const { data: expiringDocs } = await supabase.from('fleet_documents').select('filename, expiry_date').eq('fleet_id', fleet.id).not('expiry_date', 'is', null).lte('expiry_date', alertCutoff.toISOString().slice(0, 10));
      const { data: expiringVehicles } = await supabase.from('fleet_vehicles').select('targa, insurance_expiry, revisione_expiry').eq('fleet_id', fleet.id);
      const vehicleAlerts: any[] = [];
      (expiringVehicles || []).forEach((v: any) => {
        if (v.insurance_expiry && v.insurance_expiry <= alertCutoff.toISOString().slice(0, 10)) vehicleAlerts.push({ targa: v.targa, type: 'assicurazione', date: v.insurance_expiry });
        if (v.revisione_expiry && v.revisione_expiry <= alertCutoff.toISOString().slice(0, 10)) vehicleAlerts.push({ targa: v.targa, type: 'revisione', date: v.revisione_expiry });
      });

      return json({ ok: true, fleet: { name: fleet.name, slug: fleet.slug }, role: resolved.role, driver_note: fleet.driver_note || '', drivers, period: { month: currentMonth, year: currentYear }, expiring_documents: expiringDocs || [], expiring_vehicles: vehicleAlerts, in_consegna_count: inConsegnaCount, backup_reminder_due: backupReminderDue, last_backup_at: fleet.last_backup_at || null });
    }

    if (action === 'fleet_get_deliveries') {
      const resolved = await requireFleet(body.slug, body.password);
      if (!resolved) return json({ ok: false, reason: 'auth' }, 401);

      const periodsByEmail = await getAllMembershipPeriods(resolved.fleet.id);
      const emails = Object.keys(periodsByEmail);
      if (!emails.length) return json({ ok: true, deliveries: [] });

      const filterEmail = (body.driver_email || '').trim().toLowerCase();
      const targetEmails = filterEmail && emails.includes(filterEmail) ? [filterEmail] : emails;

      let query = supabase.from('driver_deliveries').select('*').in('account_email', targetEmails).order('completed_at', { ascending: false }).limit(200);
      if (body.date_from) query = query.gte('delivery_date', body.date_from);
      if (body.date_to) query = query.lte('delivery_date', body.date_to);

      const { data: deliveriesRaw, error } = await query;
      if (error) return json({ error: error.message }, 500);

      const deliveries = (deliveriesRaw || []).filter((d: any) => fallsInAnyPeriod(periodsByEmail[d.account_email] || [], new Date(d.completed_at)));

      const { data: activity } = await supabase.from('driver_activity').select('account_email, nome').in('account_email', emails);
      const nameByEmail: Record<string, string> = {};
      (activity || []).forEach((a: any) => { nameByEmail[a.account_email] = a.nome; });

      const result = deliveries.map((d: any) => ({
        client_nome: d.client_nome,
        client_indirizzo: d.client_indirizzo,
        completed_at: d.completed_at,
        driver_nome: nameByEmail[d.account_email] || d.account_email,
        driver_email: d.account_email,
      }));

      return json({ ok: true, deliveries: result });
    }

    if (action === 'fleet_list_documents') {
      const resolved = await requireFleet(body.slug, body.password);
      if (!resolved) return json({ ok: false, reason: 'auth' }, 401);

      const { data: docs, error } = await supabase.from('fleet_documents').select('*').eq('fleet_id', resolved.fleet.id).order('uploaded_at', { ascending: false });
      if (error) return json({ error: error.message }, 500);

      const driverEmails = Array.from(new Set((docs || []).map((d: any) => d.driver_email).filter(Boolean)));
      const { data: activity } = driverEmails.length ? await supabase.from('driver_activity').select('account_email, nome').in('account_email', driverEmails) : { data: [] };
      const nameByEmail: Record<string, string> = {};
      (activity || []).forEach((a: any) => { nameByEmail[a.account_email] = a.nome; });

      const result = (docs || []).map((d: any) => ({
        id: d.id, filename: d.filename, scope: d.scope,
        driver_email: d.driver_email,
        driver_nome: d.driver_email ? (nameByEmail[d.driver_email] || d.driver_email) : null,
        uploaded_at: d.uploaded_at,
        expiry_date: d.expiry_date || null,
      }));
      return json({ ok: true, documents: result });
    }

    if (action === 'fleet_get_upload_url') {
      const resolved = await requireFleet(body.slug, body.password, 'owner');
      if (!resolved) return json({ ok: false, reason: 'auth' }, 401);

      const filename = (body.filename || '').trim();
      if (!filename) return json({ error: 'filename mancante' }, 400);

      const storagePath = resolved.fleet.id + '/' + Date.now() + '-' + filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const { data, error } = await supabase.storage.from('fleet-documents').createSignedUploadUrl(storagePath);
      if (error) return json({ error: error.message }, 500);

      return json({ ok: true, upload_url: data.signedUrl, storage_path: storagePath });
    }

    if (action === 'fleet_confirm_upload') {
      const resolved = await requireFleet(body.slug, body.password, 'owner');
      if (!resolved) return json({ ok: false, reason: 'auth' }, 401);

      const filename = (body.filename || '').trim();
      const storagePath = (body.storage_path || '').trim();
      const scope = body.scope === 'driver' ? 'driver' : 'fleet';
      const driverEmail = scope === 'driver' ? (body.driver_email || '').trim().toLowerCase() : null;
      const expiryDate = (body.expiry_date || '').trim() || null;
      if (!filename || !storagePath) return json({ error: 'dati mancanti' }, 400);
      if (scope === 'driver' && !driverEmail) return json({ error: 'driver_email obbligatorio per un documento specifico' }, 400);

      const { error } = await supabase.from('fleet_documents').insert({
        fleet_id: resolved.fleet.id, filename, storage_path: storagePath, scope, driver_email: driverEmail, expiry_date: expiryDate,
      });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === 'fleet_get_download_url') {
      const resolved = await requireFleet(body.slug, body.password);
      if (!resolved) return json({ ok: false, reason: 'auth' }, 401);

      const { data: doc } = await supabase.from('fleet_documents').select('storage_path').eq('id', body.document_id).eq('fleet_id', resolved.fleet.id).maybeSingle();
      if (!doc) return json({ ok: false, reason: 'not_found' });

      const { data, error } = await supabase.storage.from('fleet-documents').createSignedUrl(doc.storage_path, 300);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, url: data.signedUrl });
    }

    if (action === 'fleet_delete_document') {
      const resolved = await requireFleet(body.slug, body.password, 'owner');
      if (!resolved) return json({ ok: false, reason: 'auth' }, 401);

      const { data: doc } = await supabase.from('fleet_documents').select('storage_path').eq('id', body.document_id).eq('fleet_id', resolved.fleet.id).maybeSingle();
      if (!doc) return json({ ok: false, reason: 'not_found' });

      await supabase.storage.from('fleet-documents').remove([doc.storage_path]);
      const { error } = await supabase.from('fleet_documents').delete().eq('id', body.document_id).eq('fleet_id', resolved.fleet.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === 'fleet_get_positions') {
      const resolved = await requireFleet(body.slug, body.password);
      if (!resolved) return json({ ok: false, reason: 'auth' }, 401);

      const memberships = await getActiveMemberships(resolved.fleet.id);
      const emails = memberships.map((l: any) => l.account_email);
      if (!emails.length) return json({ ok: true, positions: [] });

      const { data: positions } = await supabase.from('driver_positions').select('*').in('account_email', emails);
      const { data: activity } = await supabase.from('driver_activity').select('account_email, nome, targa').in('account_email', emails);
      const nameByEmail: Record<string, any> = {};
      (activity || []).forEach((a: any) => { nameByEmail[a.account_email] = a; });

      const { data: liveStatus } = await supabase.from('driver_live_status').select('account_email, in_consegna').in('account_email', emails);
      const inConsegnaByEmail: Record<string, boolean> = {};
      (liveStatus || []).forEach((s: any) => { inConsegnaByEmail[s.account_email] = !!s.in_consegna; });

      const result = (positions || []).map((p: any) => {
        const act = nameByEmail[p.account_email] || {};
        return {
          account_email: p.account_email,
          nome: act.nome || p.account_email,
          targa: act.targa || null,
          lat: p.lat, lon: p.lon,
          updated_at: p.updated_at,
          stale: !inConsegnaByEmail[p.account_email],
        };
      });

      return json({ ok: true, positions: result });
    }

    if (action === 'check_driver_fleet_link') {
      const accountEmail = (body.account_email || '').trim().toLowerCase();
      if (!accountEmail) return json({ ok: false });

      const { data: link } = await supabase.from('fleet_drivers').select('fleet_id').eq('account_email', accountEmail).is('left_at', null).maybeSingle();
      if (!link) return json({ ok: true, linked: false });

      const { data: fleet } = await supabase.from('fleets').select('name').eq('id', link.fleet_id).maybeSingle();
      return json({ ok: true, linked: true, fleet_name: fleet ? fleet.name : null });
    }

    if (action === 'fleet_set_driver_note') {
      const resolved = await requireFleet(body.slug, body.password, 'owner');
      if (!resolved) return json({ ok: false, reason: 'auth' }, 401);
      const note = (body.note || '').toString().slice(0, 500);
      const { error } = await supabase.from('fleets').update({ driver_note: note, updated_at: new Date().toISOString() }).eq('id', resolved.fleet.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === 'fleet_export_backup') {
      const resolved = await requireFleet(body.slug, body.password, 'owner');
      if (!resolved) return json({ ok: false, reason: 'auth' }, 401);
      const fleet = resolved.fleet;

      const periodsByEmail = await getAllMembershipPeriods(fleet.id);
      const emails = Object.keys(periodsByEmail);

      const { data: activity } = emails.length ? await supabase.from('driver_activity').select('account_email, nome, targa').in('account_email', emails) : { data: [] };
      const nameByEmail: Record<string, any> = {};
      (activity || []).forEach((a: any) => { nameByEmail[a.account_email] = a; });

      const { data: sheets } = emails.length ? await supabase.from('driver_sheets_summary').select('*').in('account_email', emails) : { data: [] };
      const { data: deliveriesRaw } = emails.length ? await supabase.from('driver_deliveries').select('*').in('account_email', emails).order('completed_at', { ascending: false }) : { data: [] };

      const drivers = emails.map((email: string) => {
        const periods = periodsByEmail[email];
        const currentPeriod = periods.reduce((latest: any, p: any) => (p.start > latest.start ? p : latest), periods[0]);
        const isCurrentlyActive = currentPeriod.end.getTime() > Date.now();
        const driverNome = (nameByEmail[email] && nameByEmail[email].nome) || email;
        const mySheets = (sheets || []).filter((s: any) => s.account_email === email);
        const latestBySheetId = new Map<string, any>();
        mySheets.forEach((s: any) => {
          const key = s.sheet_id || (s.client + '|' + s.month + '|' + s.year);
          const existing = latestBySheetId.get(key);
          if (!existing || new Date(s.updated_at) > new Date(existing.updated_at)) latestBySheetId.set(key, s);
        });
        const finalSheets = Array.from(latestBySheetId.values()).filter((s: any) => {
          const sheetMonthStart = new Date(Date.UTC(s.year, s.month - 1, 1));
          const sheetMonthEnd = new Date(Date.UTC(s.year, s.month, 1));
          return wasEverMemberDuring([currentPeriod], sheetMonthStart, sheetMonthEnd);
        });
        const totalKm = finalSheets.reduce((sum: number, s: any) => sum + (Number(s.total_km) || 0), 0);
        const totalGiorni = finalSheets.reduce((sum: number, s: any) => sum + (Number(s.giorni_count) || 0), 0);
        const myDeliveries = (deliveriesRaw || [])
          .filter((d: any) => d.account_email === email && fallsInAnyPeriod([currentPeriod], new Date(d.completed_at)))
          .map((d: any) => ({
            client_nome: d.client_nome, client_indirizzo: d.client_indirizzo, delivery_date: d.delivery_date, completed_at: d.completed_at,
            driver_nome: driverNome,
          }));
        return {
          account_email: email,
          nome: driverNome,
          targa: (nameByEmail[email] && nameByEmail[email].targa) || null,
          currently_active: isCurrentlyActive,
          total_km: totalKm,
          total_giorni: totalGiorni,
          deliveries: myDeliveries,
        };
      });

      const { data: vehicles } = await supabase.from('fleet_vehicles').select('*').eq('fleet_id', fleet.id);
      const vehicleEmails = Array.from(new Set((vehicles || []).map((v: any) => v.assigned_driver_email).filter(Boolean)));
      const { data: vehicleDriverActivity } = vehicleEmails.length ? await supabase.from('driver_activity').select('account_email, nome').in('account_email', vehicleEmails) : { data: [] };
      const vehicleNameByEmail: Record<string, string> = {};
      (vehicleDriverActivity || []).forEach((a: any) => { vehicleNameByEmail[a.account_email] = a.nome; });
      const vehiclesOut = (vehicles || []).map((v: any) => ({
        targa: v.targa,
        assigned_driver_email: v.assigned_driver_email,
        assigned_driver_nome: v.assigned_driver_email ? (vehicleNameByEmail[v.assigned_driver_email] || v.assigned_driver_email) : null,
        insurance_expiry: v.insurance_expiry, revisione_expiry: v.revisione_expiry, note: v.note,
      }));

      const { data: docs } = await supabase.from('fleet_documents').select('*').eq('fleet_id', fleet.id).order('uploaded_at', { ascending: false });
      const docsOut = await Promise.all((docs || []).map(async (d: any) => {
        var signedUrl: string | null = null;
        try {
          signedUrl = await Promise.race([
            supabase.storage.from('fleet-documents').createSignedUrl(d.storage_path, 24 * 60 * 60).then((r: any) => r.data ? r.data.signedUrl : null),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 6000)),
          ]);
        } catch (e) { signedUrl = null; }
        return {
          filename: d.filename, scope: d.scope,
          driver_email: d.driver_email,
          driver_nome: d.driver_email ? (nameByEmail[d.driver_email] ? nameByEmail[d.driver_email].nome : d.driver_email) : null,
          uploaded_at: d.uploaded_at, expiry_date: d.expiry_date || null,
          download_url: signedUrl,
        };
      }));

      await supabase.from('fleets').update({ last_backup_at: new Date().toISOString() }).eq('id', fleet.id);

      return json({
        ok: true,
        fleet: { name: fleet.name, slug: fleet.slug },
        exported_at: new Date().toISOString(),
        drivers, vehicles: vehiclesOut, documents: docsOut,
      });
    }

    if (action === 'fleet_restore_backup') {
      const resolved = await requireFleet(body.slug, body.password, 'owner');
      if (!resolved) return json({ ok: false, reason: 'auth' }, 401);
      const fleet = resolved.fleet;
      const backup = body.backup_data;
      if (!backup || !Array.isArray(backup.drivers)) return json({ ok: false, reason: 'invalid_backup_file' });

      let deliveriesRestored = 0, deliveriesSkippedExisting = 0;
      for (const driver of backup.drivers) {
        const accountEmail = (driver.account_email || '').trim().toLowerCase();
        if (!accountEmail || !Array.isArray(driver.deliveries)) continue;
        for (const d of driver.deliveries) {
          if (!d.completed_at || !d.client_nome) continue;
          const { data: existing } = await supabase.from('driver_deliveries')
            .select('id').eq('account_email', accountEmail).eq('client_nome', d.client_nome).eq('completed_at', d.completed_at).maybeSingle();
          if (existing) { deliveriesSkippedExisting++; continue; }
          const { error: insertErr } = await supabase.from('driver_deliveries').insert({
            account_email: accountEmail, device_id: 'restore-backup', client_nome: d.client_nome,
            client_indirizzo: d.client_indirizzo || null, completed_at: d.completed_at,
            delivery_date: d.delivery_date || d.completed_at.slice(0, 10),
          });
          if (!insertErr) deliveriesRestored++;
        }
      }

      let vehiclesRestored = 0, vehiclesSkippedExisting = 0;
      if (Array.isArray(backup.vehicles)) {
        for (const v of backup.vehicles) {
          if (!v.targa) continue;
          const { data: existing } = await supabase.from('fleet_vehicles').select('id').eq('fleet_id', fleet.id).eq('targa', v.targa).maybeSingle();
          if (existing) { vehiclesSkippedExisting++; continue; }
          const { error: insertErr } = await supabase.from('fleet_vehicles').insert({
            fleet_id: fleet.id, targa: v.targa, assigned_driver_email: v.assigned_driver_email || null,
            insurance_expiry: v.insurance_expiry || null, revisione_expiry: v.revisione_expiry || null, note: v.note || null,
          });
          if (!insertErr) vehiclesRestored++;
        }
      }

      const documentsSkipped = Array.isArray(backup.documents) ? backup.documents.length : 0;

      return json({
        ok: true,
        deliveries_restored: deliveriesRestored, deliveries_already_existed: deliveriesSkippedExisting,
        vehicles_restored: vehiclesRestored, vehicles_already_existed: vehiclesSkippedExisting,
        documents_skipped: documentsSkipped,
      });
    }

    if (action === 'fleet_snooze_backup_reminder') {
      const resolved = await requireFleet(body.slug, body.password, 'owner');
      if (!resolved) return json({ ok: false, reason: 'auth' }, 401);
      const snoozeUntil = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
      const { error } = await supabase.from('fleets').update({ backup_reminder_snoozed_until: snoozeUntil.toISOString() }).eq('id', resolved.fleet.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === 'fleet_add_driver') {
      const resolved = await requireFleet(body.slug, body.password, 'owner');
      if (!resolved) return json({ ok: false, reason: 'auth' }, 401);

      const identifier = (body.identifier || '').trim();
      if (!identifier) return json({ error: 'identifier mancante' }, 400);

      var accountEmail: string | null = null;

      if (identifier.includes('@')) {
        accountEmail = identifier.toLowerCase();
      } else {
        const { data: byId } = await supabase.from('driver_ids').select('account_email').eq('driver_id', identifier.toUpperCase()).limit(1);
        if (byId && byId.length) {
          accountEmail = byId[0].account_email;
        } else {
          const { data: byName } = await supabase.from('driver_activity').select('account_email, nome').ilike('nome', '%' + identifier + '%');
          const uniqueByEmail = new Map<string, string>();
          (byName || []).forEach((r: any) => { if (r.account_email && r.nome) uniqueByEmail.set(r.account_email, r.nome); });
          if (uniqueByEmail.size === 1) {
            accountEmail = Array.from(uniqueByEmail.keys())[0];
          } else if (uniqueByEmail.size > 1) {
            const candidates = Array.from(uniqueByEmail.entries()).map(([email, nome]) => ({ account_email: email, nome }));
            return json({ ok: false, reason: 'multiple_matches', candidates });
          } else {
            return json({ ok: false, reason: 'driver_not_found' });
          }
        }
      }

      const { data: confirmedRows } = await supabase.from('email_confirmations').select('email, confirmed').eq('email', accountEmail).limit(1);
      if (!confirmedRows || !confirmedRows.length || !confirmedRows[0].confirmed) {
        return json({ ok: false, reason: 'driver_not_found' });
      }

      const { data: existingLink } = await supabase.from('fleet_drivers').select('fleet_id').eq('account_email', accountEmail).is('left_at', null).maybeSingle();
      if (existingLink) {
        if (existingLink.fleet_id === resolved.fleet.id) return json({ ok: false, reason: 'already_linked' });
        return json({ ok: false, reason: 'already_in_other_fleet' });
      }

      const { data: existingInvite } = await supabase.from('fleet_invitations').select('id').eq('fleet_id', resolved.fleet.id).eq('account_email', accountEmail).eq('status', 'pending').maybeSingle();
      if (existingInvite) return json({ ok: false, reason: 'invitation_already_pending' });

      const { error } = await supabase.from('fleet_invitations').insert({ fleet_id: resolved.fleet.id, account_email: accountEmail });
      if (error) return json({ error: error.message }, 500);

      await sendPushToDriverEmail(supabase, accountEmail, resolved.fleet.name, 'Ti ha invitato a unirti alla loro flotta su ADB Smart — apri Novità per accettare o rifiutare.');

      return json({ ok: true, invited: true });
    }

    if (action === 'fleet_remove_driver') {
      const resolved = await requireFleet(body.slug, body.password, 'owner');
      if (!resolved) return json({ ok: false, reason: 'auth' }, 401);

      const accountEmail = (body.account_email || '').trim().toLowerCase();
      const { error } = await supabase.from('fleet_drivers').update({ left_at: new Date().toISOString() }).eq('fleet_id', resolved.fleet.id).eq('account_email', accountEmail).is('left_at', null);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === 'fleet_list_vehicles') {
      const resolved = await requireFleet(body.slug, body.password);
      if (!resolved) return json({ ok: false, reason: 'auth' }, 401);
      const { data, error } = await supabase.from('fleet_vehicles').select('*').eq('fleet_id', resolved.fleet.id).order('created_at', { ascending: false });
      if (error) return json({ error: error.message }, 500);

      const emails = Array.from(new Set((data || []).map((v: any) => v.assigned_driver_email).filter(Boolean)));
      const { data: activity } = emails.length ? await supabase.from('driver_activity').select('account_email, nome').in('account_email', emails) : { data: [] };
      const nameByEmail: Record<string, string> = {};
      (activity || []).forEach((a: any) => { nameByEmail[a.account_email] = a.nome; });

      const vehicles = (data || []).map((v: any) => ({
        id: v.id, targa: v.targa, assigned_driver_email: v.assigned_driver_email,
        assigned_driver_nome: v.assigned_driver_email ? (nameByEmail[v.assigned_driver_email] || v.assigned_driver_email) : null,
        insurance_expiry: v.insurance_expiry, revisione_expiry: v.revisione_expiry, note: v.note,
      }));
      return json({ ok: true, vehicles });
    }

    if (action === 'fleet_add_vehicle') {
      const resolved = await requireFleet(body.slug, body.password, 'owner');
      if (!resolved) return json({ ok: false, reason: 'auth' }, 401);
      const targa = (body.targa || '').trim().toUpperCase();
      if (!targa) return json({ error: 'targa mancante' }, 400);
      const assignedDriverEmail = (body.assigned_driver_email || '').trim().toLowerCase() || null;
      const insuranceExpiry = (body.insurance_expiry || '').trim() || null;
      const revisioneExpiry = (body.revisione_expiry || '').trim() || null;
      const note = (body.note || '').toString().slice(0, 500) || null;
      const { error } = await supabase.from('fleet_vehicles').insert({
        fleet_id: resolved.fleet.id, targa, assigned_driver_email: assignedDriverEmail,
        insurance_expiry: insuranceExpiry, revisione_expiry: revisioneExpiry, note,
      });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === 'fleet_update_vehicle') {
      const resolved = await requireFleet(body.slug, body.password, 'owner');
      if (!resolved) return json({ ok: false, reason: 'auth' }, 401);
      const vehicleId = body.vehicle_id;
      if (!vehicleId) return json({ error: 'vehicle_id mancante' }, 400);
      const updates: Record<string, any> = {};
      if (body.targa !== undefined) updates.targa = (body.targa || '').trim().toUpperCase();
      if (body.assigned_driver_email !== undefined) updates.assigned_driver_email = (body.assigned_driver_email || '').trim().toLowerCase() || null;
      if (body.insurance_expiry !== undefined) updates.insurance_expiry = (body.insurance_expiry || '').trim() || null;
      if (body.revisione_expiry !== undefined) updates.revisione_expiry = (body.revisione_expiry || '').trim() || null;
      if (body.note !== undefined) updates.note = (body.note || '').toString().slice(0, 500) || null;
      const { error } = await supabase.from('fleet_vehicles').update(updates).eq('id', vehicleId).eq('fleet_id', resolved.fleet.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === 'fleet_delete_vehicle') {
      const resolved = await requireFleet(body.slug, body.password, 'owner');
      if (!resolved) return json({ ok: false, reason: 'auth' }, 401);
      const { error } = await supabase.from('fleet_vehicles').delete().eq('id', body.vehicle_id).eq('fleet_id', resolved.fleet.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    // Cerut direct ("cand apas pe un sofer... sa vad foile lui, fiecare
    // legata de un client... daca are multe, doar 3-4 vizibile,
    // restul scrollabile"): toate foile unui singur sofer, indiferent
    // de luna, ca soferul sa poata fi verificat direct din admin,
    // fara sa schimbe manual luna/anul pe Bilancio pentru fiecare
    // client in parte. Aceeasi deduplicare (dupa sheet_id, cel mai
    // recent updated_at) folosita deja pe Panoramica/Bilancio.
    if (action === 'fleet_get_driver_sheets') {
      const resolved = await requireFleet(body.slug, body.password);
      if (!resolved) return json({ ok: false, reason: 'auth' }, 401);
      const accountEmail = (body.account_email || '').trim().toLowerCase();
      if (!accountEmail) return json({ error: 'account_email mancante' }, 400);

      const memberships = await getActiveMemberships(resolved.fleet.id);
      if (!memberships.some((m: any) => m.account_email === accountEmail)) return json({ ok: false, reason: 'not_found' });

      const { data: sheetsRaw } = await supabase.from('driver_sheets_summary').select('*').eq('account_email', accountEmail);
      const latestBySheetId = new Map<string, any>();
      (sheetsRaw || []).forEach((s: any) => {
        const key = s.sheet_id || (s.client + '|' + s.month + '|' + s.year);
        const existing = latestBySheetId.get(key);
        if (!existing || new Date(s.updated_at) > new Date(existing.updated_at)) latestBySheetId.set(key, s);
      });
      const sheets = Array.from(latestBySheetId.values())
        .sort((a: any, b: any) => (b.year - a.year) || (b.month - a.month) || (a.client || '').localeCompare(b.client || ''))
        .map((s: any) => ({ client: s.client || 'Senza nome', month: s.month, year: s.year, total_km: Number(s.total_km) || 0, giorni_count: s.giorni_count || 0 }));

      return json({ ok: true, sheets });
    }

    if (action === 'fleet_get_report') {
      const resolved = await requireFleet(body.slug, body.password);
      if (!resolved) return json({ ok: false, reason: 'auth' }, 401);

      const now = new Date();
      const month = Number(body.month) || (now.getUTCMonth() + 1);
      const year = Number(body.year) || now.getUTCFullYear();

      const monthStartDate = new Date(Date.UTC(year, month - 1, 1));
      const nextMonth = month === 12 ? 1 : month + 1;
      const nextMonthYear = month === 12 ? year + 1 : year;
      const monthEndDate = new Date(Date.UTC(nextMonthYear, nextMonth - 1, 1));
      const monthStart = year + '-' + String(month).padStart(2, '0') + '-01';
      const monthEnd = nextMonthYear + '-' + String(nextMonth).padStart(2, '0') + '-01';

      const periodsByEmail = await getAllMembershipPeriods(resolved.fleet.id);
      const emails = Object.keys(periodsByEmail).filter((email) => wasEverMemberDuring(periodsByEmail[email], monthStartDate, monthEndDate));
      if (!emails.length) return json({ ok: true, drivers: [], period: { month, year } });

      const { data: sheets } = await supabase.from('driver_sheets_summary').select('*').in('account_email', emails).eq('month', month).eq('year', year);
      const { data: activity } = await supabase.from('driver_activity').select('account_email, nome').in('account_email', emails);
      const nameByEmail: Record<string, string> = {};
      (activity || []).forEach((a: any) => { nameByEmail[a.account_email] = a.nome; });

      const { data: deliveriesRaw } = await supabase.from('driver_deliveries').select('account_email, delivery_date, completed_at').in('account_email', emails).gte('delivery_date', monthStart).lt('delivery_date', monthEnd);

      const drivers = emails.map((email: string) => {
        const mySheetsRaw = (sheets || []).filter((s: any) => s.account_email === email);
        const latestBySheetId = new Map<string, any>();
        mySheetsRaw.forEach((s: any) => {
          const key = s.sheet_id || (s.client + '|' + s.month + '|' + s.year);
          const existing = latestBySheetId.get(key);
          if (!existing || new Date(s.updated_at) > new Date(existing.updated_at)) latestBySheetId.set(key, s);
        });
        const mySheets = Array.from(latestBySheetId.values());
        const totalKm = mySheets.reduce((sum: number, s: any) => sum + (Number(s.total_km) || 0), 0);
        const totalGiorni = mySheets.reduce((sum: number, s: any) => sum + (Number(s.giorni_count) || 0), 0);
        const myDeliveries = (deliveriesRaw || []).filter((d: any) => d.account_email === email && fallsInAnyPeriod(periodsByEmail[email], new Date(d.completed_at)));
        return {
          account_email: email, nome: nameByEmail[email] || email,
          total_km: totalKm, total_giorni: totalGiorni,
          consegne_dates: myDeliveries.map((d: any) => d.delivery_date),
        };
      });

      return json({ ok: true, drivers, period: { month, year } });
    }

    if (action === 'fleet_list_notifications') {
      const resolved = await requireFleet(body.slug, body.password);
      if (!resolved) return json({ ok: false, reason: 'auth' }, 401);
      const { data, error } = await supabase.from('fleet_notifications').select('*').eq('fleet_id', resolved.fleet.id).order('created_at', { ascending: false }).limit(100);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, notifications: data || [] });
    }

    if (action === 'fleet_mark_notifications_read') {
      const resolved = await requireFleet(body.slug, body.password);
      if (!resolved) return json({ ok: false, reason: 'auth' }, 401);
      const { error } = await supabase.from('fleet_notifications').update({ read: true }).eq('fleet_id', resolved.fleet.id).eq('read', false);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === 'fleet_subscribe_push') {
      const resolved = await requireFleet(body.slug, body.password);
      if (!resolved) return json({ ok: false, reason: 'auth' }, 401);
      const subscription = body.subscription;
      if (!subscription) return json({ error: 'subscription mancante' }, 400);
      const { error } = await supabase.from('fleet_push_subscriptions').insert({ fleet_id: resolved.fleet.id, subscription });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === 'fleet_unsubscribe_push') {
      const resolved = await requireFleet(body.slug, body.password);
      if (!resolved) return json({ ok: false, reason: 'auth' }, 401);
      const endpoint = body.endpoint;
      if (!endpoint) return json({ error: 'endpoint mancante' }, 400);
      const { data: subs } = await supabase.from('fleet_push_subscriptions').select('id, subscription').eq('fleet_id', resolved.fleet.id);
      const match = (subs || []).find((s: any) => s.subscription?.endpoint === endpoint);
      if (match) await supabase.from('fleet_push_subscriptions').delete().eq('id', match.id);
      return json({ ok: true });
    }

    if (action === 'fleet_push_status') {
      const resolved = await requireFleet(body.slug, body.password);
      if (!resolved) return json({ ok: false, reason: 'auth' }, 401);
      const endpoint = body.endpoint;
      const { data: subs } = await supabase.from('fleet_push_subscriptions').select('subscription').eq('fleet_id', resolved.fleet.id);
      const subscribed = !!endpoint && (subs || []).some((s: any) => s.subscription?.endpoint === endpoint);
      return json({ ok: true, subscribed });
    }

    if (action === 'fleet_list_team') {
      const resolved = await requireFleet(body.slug, body.password);
      if (!resolved) return json({ ok: false, reason: 'auth' }, 401);
      const { data: members, error } = await supabase.from('fleet_team_members').select('id, email, role, created_at').eq('fleet_id', resolved.fleet.id).order('created_at');
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, owner_email: resolved.fleet.owner_email, members: members || [] });
    }

    if (action === 'fleet_add_team_member') {
      const resolved = await requireFleet(body.slug, body.password, 'owner');
      if (!resolved) return json({ ok: false, reason: 'auth' }, 401);

      const email = (body.email || '').trim().toLowerCase();
      const role = body.role === 'owner' ? 'owner' : 'viewer';
      if (!email) return json({ error: 'email mancante' }, 400);

      const tempPassword = generateTempPassword();
      const passwordHash = await hashPassword(tempPassword);

      const { error } = await supabase.from('fleet_team_members').insert({ fleet_id: resolved.fleet.id, email, password_hash: passwordHash, role });
      if (error) {
        if (error.code === '23505') return json({ ok: false, reason: 'already_added' });
        return json({ error: error.message }, 500);
      }

      return json({ ok: true, temp_password: tempPassword });
    }

    if (action === 'fleet_remove_team_member') {
      const resolved = await requireFleet(body.slug, body.password, 'owner');
      if (!resolved) return json({ ok: false, reason: 'auth' }, 401);
      const { error } = await supabase.from('fleet_team_members').delete().eq('id', body.member_id).eq('fleet_id', resolved.fleet.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === 'fleet_change_password') {
      const resolved = await requireFleet(body.slug, body.password, 'owner');
      if (!resolved) return json({ ok: false, reason: 'auth' }, 401);

      const newPassword = (body.new_password || '').toString();
      if (newPassword.length < 6) return json({ ok: false, reason: 'password_too_short' });

      const newHash = await hashPassword(newPassword);

      if (resolved.authAccount.type === 'team_member') {
        const { error } = await supabase.from('fleet_team_members').update({ password_hash: newHash }).eq('id', resolved.authAccount.memberId);
        if (error) return json({ error: error.message }, 500);
      } else {
        const { error } = await supabase.from('fleets').update({ password_hash: newHash, updated_at: new Date().toISOString() }).eq('id', resolved.fleet.id);
        if (error) return json({ error: error.message }, 500);
      }
      return json({ ok: true });
    }

    if (action === 'driver_list_invitations') {
      const accountEmail = (body.account_email || '').trim().toLowerCase();
      if (!accountEmail) return json({ ok: false });
      const { data, error } = await supabase.from('fleet_invitations').select('id, fleet_id, created_at').eq('account_email', accountEmail).eq('status', 'pending').order('created_at', { ascending: false });
      if (error) return json({ error: error.message }, 500);
      const fleetIds = (data || []).map((i: any) => i.fleet_id);
      const { data: fleetsData } = fleetIds.length ? await supabase.from('fleets').select('id, name').in('id', fleetIds) : { data: [] };
      const nameById: Record<string, string> = {};
      (fleetsData || []).forEach((f: any) => { nameById[f.id] = f.name; });
      const invitations = (data || []).map((i: any) => ({ id: i.id, fleet_name: nameById[i.fleet_id] || 'Flotta', created_at: i.created_at }));
      return json({ ok: true, invitations });
    }

    if (action === 'driver_accept_invitation') {
      const accountEmail = (body.account_email || '').trim().toLowerCase();
      const invitationId = body.invitation_id;
      if (!accountEmail || !invitationId) return json({ ok: false });

      const { data: invite } = await supabase.from('fleet_invitations').select('id, fleet_id, account_email, status').eq('id', invitationId).maybeSingle();
      if (!invite || invite.account_email !== accountEmail || invite.status !== 'pending') return json({ ok: false, reason: 'not_found' });

      const { data: existingLink } = await supabase.from('fleet_drivers').select('fleet_id').eq('account_email', accountEmail).is('left_at', null).maybeSingle();
      if (existingLink) return json({ ok: false, reason: 'already_in_fleet' });

      const { error: insertErr } = await supabase.from('fleet_drivers').insert({ fleet_id: invite.fleet_id, account_email: accountEmail });
      if (insertErr) return json({ error: insertErr.message }, 500);

      await supabase.from('fleet_invitations').update({ status: 'accepted', responded_at: new Date().toISOString() }).eq('id', invitationId);
      await supabase.from('fleet_invitations').update({ status: 'declined', responded_at: new Date().toISOString() }).eq('account_email', accountEmail).eq('status', 'pending');

      const { data: driverRow } = await supabase.from('driver_activity').select('nome').eq('account_email', accountEmail).limit(1);
      const driverName = (driverRow && driverRow.length && driverRow[0].nome) || accountEmail;
      const notifMessage = driverName + ' ha accettato il tuo invito ed è entrato nella flotta';
      await supabase.from('fleet_notifications').insert({ fleet_id: invite.fleet_id, message: notifMessage });

      const { data: fleetRow } = await supabase.from('fleets').select('slug').eq('id', invite.fleet_id).maybeSingle();
      if (fleetRow) await sendPushToFleet(supabase, invite.fleet_id, fleetRow.slug, 'ADB Smart Fleet', notifMessage);

      return json({ ok: true });
    }

    if (action === 'driver_decline_invitation') {
      const accountEmail = (body.account_email || '').trim().toLowerCase();
      const invitationId = body.invitation_id;
      if (!accountEmail || !invitationId) return json({ ok: false });
      const { error } = await supabase.from('fleet_invitations').update({ status: 'declined', responded_at: new Date().toISOString() }).eq('id', invitationId).eq('account_email', accountEmail).eq('status', 'pending');
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === 'driver_get_fleet_status') {
      const accountEmail = (body.account_email || '').trim().toLowerCase();
      if (!accountEmail) return json({ ok: false });
      const { data: link } = await supabase.from('fleet_drivers').select('fleet_id').eq('account_email', accountEmail).is('left_at', null).maybeSingle();
      if (!link) return json({ ok: true, in_fleet: false });
      const { data: fleet } = await supabase.from('fleets').select('name').eq('id', link.fleet_id).maybeSingle();
      return json({ ok: true, in_fleet: true, fleet_name: fleet ? fleet.name : null });
    }

    if (action === 'driver_leave_fleet') {
      const accountEmail = (body.account_email || '').trim().toLowerCase();
      if (!accountEmail) return json({ ok: false });

      const { data: link } = await supabase.from('fleet_drivers').select('fleet_id').eq('account_email', accountEmail).is('left_at', null).maybeSingle();
      if (!link) return json({ ok: false, reason: 'not_in_fleet' });

      const { data: driverRow } = await supabase.from('driver_activity').select('nome').eq('account_email', accountEmail).limit(1);
      const driverName = (driverRow && driverRow.length && driverRow[0].nome) || accountEmail;

      const { error } = await supabase.from('fleet_drivers').update({ left_at: new Date().toISOString() }).eq('fleet_id', link.fleet_id).eq('account_email', accountEmail).is('left_at', null);
      if (error) return json({ error: error.message }, 500);

      const notifMessage = driverName + ' ha lasciato la tua flotta';
      await supabase.from('fleet_notifications').insert({ fleet_id: link.fleet_id, message: notifMessage });

      const { data: fleetRow } = await supabase.from('fleets').select('slug').eq('id', link.fleet_id).maybeSingle();
      if (fleetRow) await sendPushToFleet(supabase, link.fleet_id, fleetRow.slug, 'ADB Smart Fleet', notifMessage);

      return json({ ok: true });
    }

    if (action === 'driver_check_pending_imports') {
      const accountEmail = (body.account_email || '').trim().toLowerCase();
      if (!accountEmail) return json({ ok: true, pending: [] });

      const { data: driverLink } = await supabase.from('fleet_drivers').select('fleet_id').eq('account_email', accountEmail).is('left_at', null).maybeSingle();

      const { data: driverDocs } = await supabase.from('fleet_documents')
        .select('id, filename, storage_path')
        .eq('scope', 'driver')
        .eq('driver_email', accountEmail)
        .ilike('filename', '%.json')
        .is('processed_at', null)
        .limit(10);

      let fleetDocs: any[] = [];
      if (driverLink) {
        const { data } = await supabase.from('fleet_documents')
          .select('id, filename, storage_path, processed_by')
          .eq('scope', 'fleet')
          .eq('fleet_id', driverLink.fleet_id)
          .ilike('filename', '%.json')
          .limit(10);
        fleetDocs = (data || []).filter((d: any) => !(d.processed_by || []).includes(accountEmail));
      }

      const docs = [...(driverDocs || []), ...fleetDocs];
      if (!docs.length) return json({ ok: true, pending: [] });

      const pending = await Promise.all(docs.map(async (d: any) => {
        const { data } = await supabase.storage.from('fleet-documents').createSignedUrl(d.storage_path, 300);
        return { id: d.id, filename: d.filename, url: data ? data.signedUrl : null };
      }));

      return json({ ok: true, pending: pending.filter((p: any) => p.url) });
    }

    if (action === 'driver_mark_import_processed') {
      const documentId = body.document_id;
      const accountEmail = (body.account_email || '').trim().toLowerCase();
      if (!documentId) return json({ ok: false });
      const { data: doc } = await supabase.from('fleet_documents').select('scope, processed_by').eq('id', documentId).maybeSingle();
      if (!doc) return json({ ok: false });
      if (doc.scope === 'fleet' && accountEmail) {
        const nextProcessedBy = Array.from(new Set([...(doc.processed_by || []), accountEmail]));
        const { error } = await supabase.from('fleet_documents').update({ processed_by: nextProcessedBy }).eq('id', documentId);
        if (error) return json({ error: error.message }, 500);
      } else {
        const { error } = await supabase.from('fleet_documents').update({ processed_at: new Date().toISOString() }).eq('id', documentId);
        if (error) return json({ error: error.message }, 500);
      }
      return json({ ok: true });
    }

    // Cerut direct ("baza intreaga de clienti... adaugam pe mapa...
    // fiecare bola are numarul clientului"): anagrafica de clienti,
    // separata complet de tot ce exista deja (nu atinge niciun tabel
    // vechi). Trei surse de asignare posibile pentru un client:
    // 'comune' (sugestie automata, dupa regula de zona), 'manual'
    // (ales explicit de proprietarul flotei), 'pending' (client nou,
    // sugestie neconfirmata inca). O a patra sursa, 'history' (tinut
    // minte dupa prima livrare reala), va fi adaugata cand se
    // construieste si partea de bolle/consegne - nu inca aici.
    if (action === 'fleet_list_clients') {
      const resolved = await requireFleet(body.slug, body.password);
      if (!resolved) return json({ ok: false, reason: 'auth' }, 401);
      const { data, error } = await supabase.from('fleet_clients').select('*').eq('fleet_id', resolved.fleet.id).order('name');
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, clients: data || [] });
    }

    if (action === 'fleet_list_zone_rules') {
      const resolved = await requireFleet(body.slug, body.password);
      if (!resolved) return json({ ok: false, reason: 'auth' }, 401);
      const { data, error } = await supabase.from('fleet_zone_rules').select('*').eq('fleet_id', resolved.fleet.id).order('comune');
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, rules: data || [] });
    }

    if (action === 'fleet_save_zone_rule') {
      const resolved = await requireFleet(body.slug, body.password, 'owner');
      if (!resolved) return json({ ok: false, reason: 'auth' }, 401);
      const comune = (body.comune || '').trim();
      const driverEmail = (body.driver_email || '').trim().toLowerCase();
      if (!comune || !driverEmail) return json({ error: 'comune e driver_email obbligatori' }, 400);
      const { error } = await supabase.from('fleet_zone_rules').upsert(
        { fleet_id: resolved.fleet.id, comune, driver_email: driverEmail },
        { onConflict: 'fleet_id,comune' }
      );
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === 'fleet_delete_zone_rule') {
      const resolved = await requireFleet(body.slug, body.password, 'owner');
      if (!resolved) return json({ ok: false, reason: 'auth' }, 401);
      const { error } = await supabase.from('fleet_zone_rules').delete().eq('id', body.rule_id).eq('fleet_id', resolved.fleet.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    // Un singur client, adaugat manual - cauta o regula de zona
    // pentru comuna data si, daca gaseste una, sugereaza acel sofer
    // (assignment_source: 'pending', nu inca confirmat). Daca
    // proprietarul flotei a ales el insusi un sofer direct (nu a
    // asteptat sugestia), acel sofer e folosit ca atare, cu
    // assignment_source: 'manual' - sugestia de zona nu il mai
    // suprascrie niciodata pe cel ales manual.
    if (action === 'fleet_add_client') {
      const resolved = await requireFleet(body.slug, body.password, 'owner');
      if (!resolved) return json({ ok: false, reason: 'auth' }, 401);
      const name = (body.name || '').trim();
      if (!name) return json({ error: 'name obbligatorio' }, 400);
      const comune = (body.comune || '').trim() || null;
      const manualDriverEmail = (body.assigned_driver_email || '').trim().toLowerCase() || null;

      let assignedDriverEmail = manualDriverEmail;
      let assignmentSource = manualDriverEmail ? 'manual' : 'pending';
      if (!manualDriverEmail && comune) {
        const { data: rule } = await supabase.from('fleet_zone_rules').select('driver_email').eq('fleet_id', resolved.fleet.id).ilike('comune', comune).maybeSingle();
        if (rule) { assignedDriverEmail = rule.driver_email; assignmentSource = 'pending'; }
      }

      const { data, error } = await supabase.from('fleet_clients').insert({
        fleet_id: resolved.fleet.id, name,
        client_code: (body.client_code || '').trim() || null,
        address: (body.address || '').trim() || null,
        city: (body.city || '').trim() || null,
        comune, cap: (body.cap || '').trim() || null,
        province: (body.province || '').trim() || null,
        phone: (body.phone || '').trim() || null,
        note: (body.note || '').toString().slice(0, 500) || null,
        assigned_driver_email: assignedDriverEmail,
        assignment_source: assignmentSource,
      }).select().single();
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, client: data });
    }

    // Cerut direct ("importa Excel"): clientul trimite deja lista
    // parsata (fisierul Excel e citit in browser, nu pe server) - un
    // singur apel, insereaza tot dintr-o data. Aceeasi logica de
    // sugestie pe zona ca la adaugarea unui singur client. Randurile
    // fara "name" sunt sarite, fara sa opreasca restul importului.
    if (action === 'fleet_import_clients') {
      const resolved = await requireFleet(body.slug, body.password, 'owner');
      if (!resolved) return json({ ok: false, reason: 'auth' }, 401);
      const rows = Array.isArray(body.clients) ? body.clients : [];
      if (!rows.length) return json({ error: 'nessun cliente da importare' }, 400);

      const { data: rules } = await supabase.from('fleet_zone_rules').select('comune, driver_email').eq('fleet_id', resolved.fleet.id);
      const driverByComune: Record<string, string> = {};
      (rules || []).forEach((r: any) => { driverByComune[r.comune.trim().toLowerCase()] = r.driver_email; });

      const toInsert = rows.filter((r: any) => (r.name || '').trim()).map((r: any) => {
        const comune = (r.comune || '').trim() || null;
        const suggested = comune ? driverByComune[comune.toLowerCase()] : undefined;
        return {
          fleet_id: resolved.fleet.id, name: (r.name || '').trim(),
          client_code: (r.client_code || '').trim() || null,
          address: (r.address || '').trim() || null, city: (r.city || '').trim() || null,
          comune, cap: (r.cap || '').trim() || null, province: (r.province || '').trim() || null,
          phone: (r.phone || '').trim() || null,
          assigned_driver_email: suggested || null,
          assignment_source: suggested ? 'pending' : 'pending',
        };
      });
      if (!toInsert.length) return json({ error: 'nessuna riga valida (name obbligatorio)' }, 400);

      const { data, error } = await supabase.from('fleet_clients').insert(toInsert).select();
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, imported: data.length });
    }

    if (action === 'fleet_update_client') {
      const resolved = await requireFleet(body.slug, body.password, 'owner');
      if (!resolved) return json({ ok: false, reason: 'auth' }, 401);
      const clientId = body.client_id;
      if (!clientId) return json({ error: 'client_id mancante' }, 400);
      const updates: Record<string, any> = { updated_at: new Date().toISOString() };
      ['name', 'client_code', 'address', 'city', 'comune', 'cap', 'province', 'phone'].forEach((f) => {
        if (body[f] !== undefined) updates[f] = (body[f] || '').toString().trim() || null;
      });
      if (body.note !== undefined) updates.note = (body.note || '').toString().slice(0, 500) || null;
      // Confirmarea sau schimbarea manuala a soferului marcheaza
      // sursa ca 'manual' - de acum inainte, nicio regula de zona nu
      // mai suprascrie acest client automat.
      if (body.assigned_driver_email !== undefined) {
        updates.assigned_driver_email = (body.assigned_driver_email || '').trim().toLowerCase() || null;
        updates.assignment_source = updates.assigned_driver_email ? 'manual' : 'pending';
      }
      const { error } = await supabase.from('fleet_clients').update(updates).eq('id', clientId).eq('fleet_id', resolved.fleet.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === 'fleet_delete_client') {
      const resolved = await requireFleet(body.slug, body.password, 'owner');
      if (!resolved) return json({ ok: false, reason: 'auth' }, 401);
      const { error } = await supabase.from('fleet_clients').delete().eq('id', body.client_id).eq('fleet_id', resolved.fleet.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }


    // Cerut direct ("borderolul... ramane salvat in sistem doar pana
    // la urmatoarea incarcare... se salveaza doar datele"): fisierul
    // BRUT (Excel/CSV/PDF) e pastrat UNUL SINGUR per flota - la o
    // incarcare noua, cel vechi se sterge intai din storage, apoi
    // randul din fleet_current_manifest_file se suprascrie (upsert).
    // DATELE extrase insa (fleet_delivery_items) raman permanent,
    // indiferent de fisierul original.
    if (action === 'fleet_get_manifest_upload_url') {
      const resolved = await requireFleet(body.slug, body.password, 'owner');
      if (!resolved) return json({ ok: false, reason: 'auth' }, 401);
      const filename = (body.filename || '').trim();
      if (!filename) return json({ error: 'filename mancante' }, 400);

      const { data: existing } = await supabase.from('fleet_current_manifest_file').select('storage_path').eq('fleet_id', resolved.fleet.id).maybeSingle();
      if (existing) await supabase.storage.from('fleet-documents').remove([existing.storage_path]);

      const storagePath = resolved.fleet.id + '/manifest/' + Date.now() + '-' + filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const { data, error } = await supabase.storage.from('fleet-documents').createSignedUploadUrl(storagePath);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, upload_url: data.signedUrl, storage_path: storagePath });
    }

    if (action === 'fleet_confirm_manifest_upload') {
      const resolved = await requireFleet(body.slug, body.password, 'owner');
      if (!resolved) return json({ ok: false, reason: 'auth' }, 401);
      const filename = (body.filename || '').trim();
      const storagePath = (body.storage_path || '').trim();
      if (!filename || !storagePath) return json({ error: 'dati mancanti' }, 400);
      const { error } = await supabase.from('fleet_current_manifest_file').upsert(
        { fleet_id: resolved.fleet.id, filename, storage_path: storagePath, uploaded_at: new Date().toISOString() },
        { onConflict: 'fleet_id' }
      );
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === 'fleet_get_current_manifest') {
      const resolved = await requireFleet(body.slug, body.password);
      if (!resolved) return json({ ok: false, reason: 'auth' }, 401);
      const { data } = await supabase.from('fleet_current_manifest_file').select('filename, uploaded_at').eq('fleet_id', resolved.fleet.id).maybeSingle();
      return json({ ok: true, manifest_file: data || null });
    }

    // Randurile parsate (client_name, client_code, merchandise_note)
    // ajung deja citite din fisier (Excel/CSV/ODS), la fel ca la
    // fleet_import_clients. Fiecare rand se potriveste cu un client
    // existent dupa nume (fara sa tina cont de majuscule/minuscule) -
    // daca il gaseste, foloseste soferul deja asignat acelui client
    // (assigned_driver_email), exact logica "memoriei" discutata. Un
    // rand fara potrivire ramane fara sofer asignat (assigned_driver_
    // email null), vizibil separat, de rezolvat manual.
    if (action === 'fleet_import_delivery_items') {
      const resolved = await requireFleet(body.slug, body.password, 'owner');
      if (!resolved) return json({ ok: false, reason: 'auth' }, 401);
      const deliveryDate = (body.delivery_date || '').trim();
      const rows = Array.isArray(body.items) ? body.items : [];
      if (!deliveryDate) return json({ error: 'delivery_date mancante' }, 400);
      if (!rows.length) return json({ error: 'nessuna riga da importare' }, 400);

      const { data: clients } = await supabase.from('fleet_clients').select('id, name, client_code, assigned_driver_email').eq('fleet_id', resolved.fleet.id);
      const clientByName: Record<string, any> = {};
      const clientByCode: Record<string, any> = {};
      (clients || []).forEach((cl: any) => {
        clientByName[cl.name.trim().toLowerCase()] = cl;
        if (cl.client_code) clientByCode[cl.client_code.trim().toLowerCase()] = cl;
      });

      // Cerut direct ("de ce in baza de date a clientilor nu citeste
      // codice cliente, asa mai usor va face legatura borderol si
      // baza de clienti"): potrivire acum in doi pasi - intai dupa
      // COD (exact, mult mai sigur decat un nume care poate fi scris
      // usor diferit intre cele doua fisiere), si doar daca nu exista
      // cod sau nu se gaseste, cade inapoi pe potrivirea dupa nume,
      // ca inainte.
      const toInsert = rows.filter((r: any) => (r.client_name || '').trim()).map((r: any) => {
        const codeKey = (r.client_code || '').trim().toLowerCase();
        const nameKey = (r.client_name || '').trim().toLowerCase();
        const matched = (codeKey && clientByCode[codeKey]) || clientByName[nameKey];
        return {
          fleet_id: resolved.fleet.id,
          delivery_date: deliveryDate,
          client_id: matched ? matched.id : null,
          client_name: (r.client_name || '').trim(),
          client_code: (r.client_code || '').trim() || null,
          merchandise_note: (r.merchandise_note || '').trim() || null,
          bolle: Array.isArray(r.bolle) && r.bolle.length ? r.bolle : null,
          assigned_driver_email: matched ? matched.assigned_driver_email : null,
          status: 'pending',
          load_status: 'pending',
        };
      });
      if (!toInsert.length) return json({ error: 'nessuna riga valida (nome cliente obbligatorio)' }, 400);

      const { data, error } = await supabase.from('fleet_delivery_items').insert(toInsert).select();
      if (error) return json({ error: error.message }, 500);
      const unmatched = data.filter((d: any) => !d.client_id).length;
      return json({ ok: true, imported: data.length, unmatched });
    }

    if (action === 'fleet_list_delivery_items') {
      const resolved = await requireFleet(body.slug, body.password);
      if (!resolved) return json({ ok: false, reason: 'auth' }, 401);
      const deliveryDate = (body.delivery_date || '').trim();
      let query = supabase.from('fleet_delivery_items').select('*').eq('fleet_id', resolved.fleet.id).order('client_name');
      if (deliveryDate) query = query.eq('delivery_date', deliveryDate);
      const { data, error } = await query;
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, items: data || [] });
    }

    if (action === 'fleet_update_delivery_item') {
      const resolved = await requireFleet(body.slug, body.password, 'owner');
      if (!resolved) return json({ ok: false, reason: 'auth' }, 401);
      const itemId = body.item_id;
      if (!itemId) return json({ error: 'item_id mancante' }, 400);
      const updates: Record<string, any> = { updated_at: new Date().toISOString() };
      if (body.assigned_driver_email !== undefined) updates.assigned_driver_email = (body.assigned_driver_email || '').trim().toLowerCase() || null;
      if (body.status !== undefined && ['pending', 'delivered', 'not_delivered'].includes(body.status)) {
        updates.status = body.status;
        updates.status_reason = body.status === 'not_delivered' ? ((body.status_reason || '').toString().slice(0, 300) || null) : null;
        updates.delivered_at = body.status === 'delivered' ? new Date().toISOString() : null;
      }
      const { error } = await supabase.from('fleet_delivery_items').update(updates).eq('id', itemId).eq('fleet_id', resolved.fleet.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === 'fleet_delete_delivery_item') {
      const resolved = await requireFleet(body.slug, body.password, 'owner');
      if (!resolved) return json({ ok: false, reason: 'auth' }, 401);
      const { error } = await supabase.from('fleet_delivery_items').delete().eq('id', body.item_id).eq('fleet_id', resolved.fleet.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }


    // Cerut direct ("nu ar fi posibil de introdus Claude cumva ca el
    // sa citeasca orice va fi incarcat"): pentru bolele care sunt
    // POZE (nu Excel/CSV structurat), citirea se face prin Claude
    // (vision), nu prin SheetJS - Claude "intelege" pozitia campurilor
    // pe pagina, indiferent de layout-ul folosit de fiecare furnizor,
    // spre deosebire de un OCR clasic care doar citeste litere fara
    // context. Cheia API (ANTHROPIC_API_KEY) e o variabila secreta pe
    // server, la fel ca celelalte chei deja folosite aici - niciodata
    // vizibila in browser.
    if (action === 'fleet_extract_document_image') {
      const resolved = await requireFleet(body.slug, body.password, 'owner');
      if (!resolved) return json({ ok: false, reason: 'auth' }, 401);
      const imageBase64 = (body.image_base64 || '').trim();
      const mediaType = (body.media_type || 'image/jpeg').trim();
      if (!imageBase64) return json({ error: 'image_base64 mancante' }, 400);

      const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
      if (!anthropicKey) return json({ error: 'ANTHROPIC_API_KEY non configurata sul server' }, 500);

      const prompt = 'Questa e una foto, scansione o PDF di un documento di trasporto (DDT/bolla). ' +
        'Estrai i dati del cliente destinatario della merce, la descrizione generale della merce/colli, ' +
        'e la lista dettagliata dei prodotti (codice articolo, descrizione, quantita, numero di colli). ' +
        'Rispondi SOLO con un array JSON valido, senza testo prima o dopo, in questo formato esatto: ' +
        '[{"client_name": "...", "client_code": "..." o null, "merchandise_note": "...", ' +
        '"bolle": [{"numero": "..." o null, "prodotti": [{"codice": "..." o null, "descrizione": "...", "quantita": numero o null, "colli": numero o null}]}]}]. ' +
        'Se il documento elenca piu destinatari diversi, includi una riga per ciascuno. ' +
        'Se un campo non e leggibile o non e presente, usa null per quel campo (non inventare valori). ' +
        'Se non riesci a distinguere prodotti singoli, lascia "bolle" come array vuoto [].';

      // Cerut direct ("borderoul nu-l vede ca imagine... poate pdf"):
      // multe scanari reale ajung ca PDF, nu ca poza bruta - Claude
      // citeste PDF-uri nativ, prin blocul "document" (nu "image"),
      // fara nicio conversie facuta de noi in prealabil.
      const isPdf = mediaType === 'application/pdf';
      const contentBlock = isPdf
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: imageBase64 } }
        : { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } };

      let anthropicRes: Response;
      try {
        anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': anthropicKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-5',
            max_tokens: 1024,
            messages: [{
              role: 'user',
              content: [
                contentBlock,
                { type: 'text', text: prompt },
              ],
            }],
          }),
        });
      } catch (e) {
        return json({ error: 'Impossibile contattare il servizio di lettura documenti.' }, 500);
      }

      if (!anthropicRes.ok) {
        const errText = await anthropicRes.text();
        return json({ error: 'Errore dal servizio di lettura documenti: ' + errText.slice(0, 300) }, 500);
      }

      const anthropicData = await anthropicRes.json();
      const textBlock = (anthropicData.content || []).find((c: any) => c.type === 'text');
      if (!textBlock) return json({ error: 'Risposta inattesa dal servizio di lettura documenti.' }, 500);

      let items: any[];
      try {
        // Claude poate incadra raspunsul intre ```json ... ``` uneori,
        // desi i s-a cerut sa nu o faca - eliminate, ca sa fie sigur.
        const cleaned = textBlock.text.replace(/```json|```/g, '').trim();
        items = JSON.parse(cleaned);
        if (!Array.isArray(items)) items = [items];
      } catch (e) {
        return json({ error: 'Impossibile interpretare i dati letti dal documento.' }, 500);
      }

      return json({ ok: true, items });
    }


    // Cerut direct, de la inceput ("cursa zilnica se va incarca in
    // automat la fiecare sofer... fara niciun pas suplimentar"):
    // soferul vede AICI doar livrarile lui, pentru ziua ceruta (azi,
    // implicit) - filtrate automat dupa email, fara sa fie nevoie sa
    // ceara nimic sau sa astepte vreo trimitere manuala de la
    // proprietarul flotei. Verificat mai intai ca soferul chiar
    // apartine unei flote (fleet_drivers) - fara asta, nu exista
    // niciun rezultat posibil.
    if (action === 'driver_list_today_deliveries') {
      const accountEmail = (body.account_email || '').trim().toLowerCase();
      if (!accountEmail) return json({ ok: true, items: [] });
      const deliveryDate = (body.delivery_date || '').trim() || new Date().toISOString().slice(0, 10);

      const { data: link } = await supabase.from('fleet_drivers').select('fleet_id').eq('account_email', accountEmail).is('left_at', null).maybeSingle();
      if (!link) return json({ ok: true, items: [] });

      // REAL BUG, gasit si confirmat direct in date reale ("sunt in
      // asteza, dar doar doi s-au incarcat"): assigned_driver_email de
      // pe randul de livrare e o "poza" luata la momentul incarcarii
      // borderoului - daca proprietarul flotei asigneaza (sau
      // schimba) soferul unui client DUPA acel moment, randul ramas
      // din import nu se actualizeaza singur si soferul nou nu vede
      // niciodata acel client. Reparat: pentru randurile potrivite cu
      // un client (client_id existent), asignarea se citeste acum LIVE
      // din fleet_clients, nu din poza veche de pe fleet_delivery_items
      // - randurile nepotrivite (fara client_id) raman pe vechiul
      // camp, singurul disponibil pentru ele.
      const { data, error } = await supabase.from('fleet_delivery_items').select('*, fleet_clients(address, city, cap, province, assigned_driver_email, lat, lon)')
        .eq('fleet_id', link.fleet_id).eq('delivery_date', deliveryDate)
        .order('client_name');
      if (error) return json({ error: error.message }, 500);
      const itemsOut = (data || [])
        .filter((it: any) => {
          const liveAssigned = it.fleet_clients ? it.fleet_clients.assigned_driver_email : it.assigned_driver_email;
          return liveAssigned === accountEmail;
        })
        .map((it: any) => {
          const client = it.fleet_clients;
          delete it.fleet_clients;
          const addressParts = client ? [client.address, client.cap, client.city, client.province].filter(Boolean) : [];
          // Cerut direct ("ordinea inconsistenta... geocodarea care
          // esueaza la cereri multe simultane"): daca acest client
          // are deja coordonate memorate (dintr-o geocodare anterioara
          // reusita), le trimitem direct - aplicatia soferului le
          // foloseste pe loc, fara sa mai ceara nimic serviciului de
          // geocodare, eliminand riscul de limita depasita.
          return { ...it, address: addressParts.length ? addressParts.join(', ') : null, client_lat: client ? client.lat : null, client_lon: client ? client.lon : null };
        });
      return json({ ok: true, items: itemsOut });
    }

    // Cerut direct: odata ce telefonul soferului geocodeaza cu succes
    // adresa unui client (prima data, sau daca inca nu era memorata),
    // rezultatul se trimite aici o singura data si ramane memorat pe
    // fisa clientului pentru totdeauna - la urmatoarele incarcari ale
    // Percorso/Carico pentru acelasi client, coordonatele vin deja
    // gata, fara nicio cerere noua catre serviciul de geocodare.
    if (action === 'driver_save_client_coords') {
      const accountEmail = (body.account_email || '').trim().toLowerCase();
      const clientId = body.client_id;
      const lat = Number(body.lat);
      const lon = Number(body.lon);
      if (!accountEmail || !clientId || !isFinite(lat) || !isFinite(lon)) return json({ ok: false });
      const { data: link } = await supabase.from('fleet_drivers').select('fleet_id').eq('account_email', accountEmail).is('left_at', null).maybeSingle();
      if (!link) return json({ ok: false, reason: 'not_found' });
      const { error } = await supabase.from('fleet_clients').update({ lat, lon, geocoded_label: (body.label || '').toString().slice(0, 300) || null }).eq('id', clientId).eq('fleet_id', link.fleet_id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    // Un sofer poate schimba starea DOAR pe randurile deja asignate
    // lui - verificat explicit inainte de orice scriere, ca sa nu
    // poata modifica livrarile altui sofer din aceeasi flota.
    if (action === 'driver_update_delivery_status') {
      const accountEmail = (body.account_email || '').trim().toLowerCase();
      const itemId = body.item_id;
      if (!accountEmail || !itemId) return json({ ok: false });
      if (!['delivered', 'not_delivered'].includes(body.status)) return json({ error: 'status non valido' }, 400);

      const { data: item } = await supabase.from('fleet_delivery_items').select('id, assigned_driver_email').eq('id', itemId).maybeSingle();
      if (!item || item.assigned_driver_email !== accountEmail) return json({ ok: false, reason: 'not_found' });

      const updates: Record<string, any> = {
        status: body.status,
        status_reason: body.status === 'not_delivered' ? ((body.status_reason || '').toString().slice(0, 300) || null) : null,
        delivered_at: body.status === 'delivered' ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      };
      const { error } = await supabase.from('fleet_delivery_items').update(updates).eq('id', itemId);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }


    // Cerut direct ("la fiecare client sa fie posibilitatea de a
    // apasa salta... sa-i apara sa aleaga de ce salta"): stare
    // separata de INCARCARE (diferita de starea de LIVRARE, care
    // exista deja) - un client poate fi incarcat cu bine, sau sarit,
    // cu un motiv ales dintr-o lista sau scris de mana.
    if (action === 'driver_update_load_status') {
      const accountEmail = (body.account_email || '').trim().toLowerCase();
      const itemId = body.item_id;
      if (!accountEmail || !itemId) return json({ ok: false });
      // Cerut direct ("cum pot sa o reiau de la capat incarcatura"):
      // 'pending' e acum o valoare valida - permite resetarea reala,
      // pe server, cand soferul vrea sa reia complet verificarea, nu
      // doar local, in sesiunea curenta din Carico.
      if (!['loaded', 'skipped', 'pending'].includes(body.load_status)) return json({ error: 'load_status non valido' }, 400);

      const { data: item } = await supabase.from('fleet_delivery_items').select('id, assigned_driver_email').eq('id', itemId).maybeSingle();
      if (!item || item.assigned_driver_email !== accountEmail) return json({ ok: false, reason: 'not_found' });

      const updates: Record<string, any> = {
        load_status: body.load_status,
        load_skip_reason: body.load_status === 'skipped' ? ((body.load_skip_reason || '').toString().slice(0, 300) || null) : null,
        loaded_at: body.load_status === 'loaded' ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      };
      const { error } = await supabase.from('fleet_delivery_items').update(updates).eq('id', itemId);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    return json({ error: 'unknown action' }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
