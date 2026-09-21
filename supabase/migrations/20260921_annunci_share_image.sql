-- Gasit real ("cand trimit linkul, nu apare nimic - doar text simplu"):
-- image_url (poza mica, sub 20kb, folosita pentru cardul din lista)
-- e adesea prea mica pentru pragul minim cerut de WhatsApp
-- (~300x200px), care refuza tacit sa arate un card pentru o poza sub
-- acel prag. O a doua poza, separata, mai mare, doar pentru
-- previzualizarea la partajare (vezi supabase/functions/annunci si
-- compressShareImage in bacheca/index.html) - lista/cardul din
-- aplicatie raman neschimbate, tot cu poza mica de 20kb.
alter table adb_annunci
  add column share_image_url text,
  add column share_image_path text;

comment on column adb_annunci.share_image_url is 'Poza mai mare, separata de image_url (cea mica, sub 20kb, pentru cardul din lista) - folosita DOAR pentru og:image la partajare (WhatsApp etc.), care refuza sa arate un card pentru imagini prea mici.';
comment on column adb_annunci.share_image_path is 'Calea in storage a share_image_url, pentru stergere la editare/eliminare.';
