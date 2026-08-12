# Foglio Viaggi — Power Trasporti

Aplicație PWA (instalabilă pe telefon, funcționează offline) pentru completarea automată a foii lunare de lucru „GIRO", cu generare PDF identică vizual cu documentul original.

## Ce conține arhiva

```
index.html          — aplicația (ecrane Home / Foglio / Archivio / PDF)
app.js               — toată logica (calcule KM, autocomplete, PDF, arhivă)
manifest.json        — pentru instalarea ca aplicație pe telefon
sw.js                 — service worker (funcționare offline)
icon-192.png, icon-512.png  — iconițele aplicației
vendor/logo.png       — logo-ul Power Trasporti, decupat din poza ta originală
vendor/comuni.js      — bază de date offline cu toate cele 7.904 comune italiene + provincii
vendor/jspdf...       — librăria folosită pentru generarea PDF-ului (funcționează 100% local, fără internet)
```

Nimic din aplicație nu trimite date către vreun server. Tot ce introduci rămâne pe telefonul tău, salvat local (`localStorage`).

## Cum o instalezi pe telefon (fără App Store / Google Play)

Ca la BizScan, cel mai simplu e să o publici pe **GitHub Pages**:

1. Creează un repository nou pe GitHub (poate fi privat), de exemplu `pt-foglio-viaggi`.
2. Încarcă toate fișierele din această arhivă (păstrează structura de foldere, inclusiv folderul `vendor/`).
3. În repository → **Settings → Pages** → Source: `main` branch, folder `/ (root)` → Save.
4. GitHub îți dă un link de tipul `https://numele-tau.github.io/pt-foglio-viaggi/`.
5. Deschide acel link **pe telefon**, în Chrome (Android) sau Safari (iPhone).
6. Apasă meniul browserului → **„Adaugă pe ecranul principal" / „Add to Home Screen"**.
7. Aplicația apare ca o iconiță normală, se deschide pe tot ecranul, fără bara browserului.

După prima deschidere (cât ai internet o dată), aplicația funcționează **complet offline** — inclusiv generarea PDF-ului, autocomplete-ul de localități și salvarea datelor.

Poți trimite exact același link oricărui coleg — fiecare telefon își are propriile date, complet separate (nimic nu se amestecă).

## Cum se folosește

- **Prima deschidere** → introduci nume, targă, „per conto di" (implicit BARCELLA) și localitatea de plecare (implicit Ponte San Nicolò / PD). Se salvează automat pentru lunile viitoare.
- **Home** → arată luna activă, ultimii KM și acces rapid.
- **Foglio** → lista celor 31 zile; atingi o zi ca s-o completezi. KM INIZIO se completează automat cu ultimul KM FINE introdus (chiar dacă au fost zile libere între ele). Provincia se completează automat când scrii localitatea (cu sugestii live).
- **Butonul + (centru, jos)** → creează un foglio nou pentru luna următoare, cu confirmare. Nu șterge și nu suprascrie niciodată luna precedentă.
- **Archivio** → toate lunile, în ordine cronologică, cu acces rapid la fiecare și la PDF-ul ei.
- **PDF** → previzualizare live + „Genera PDF" (descarcă sau trimite direct, ex. pe WhatsApp/email, prin butonul de distribuire al telefonului).

## Observație despre localități

Baza de date conține toate comunele oficiale italiene. Pentru localități mici care sunt de fapt „frazioni" (cătune) ale unui comun — cum e „Musano di Trevignano", cătun al comunei Trevignano — aplicația recunoaște automat numele comunei conținut în text și completează provincia corect (testat: TV). Dacă totuși apare o localitate needentificată, provincia rămâne editabilă manual.

## Fidelitatea documentului PDF

PDF-ul generat respectă întocmai structura originalului: același antet, aceleași câmpuri, același tabel GIRO cu coloanele Data / Da / Prov. / A / Prov. / DDT / KM INIZIO / KM FINE / KM TOT., toate cele 31 de rânduri pe o singură pagină A4 orizontală, cu logo-ul real Power Trasporti. Testat cu exact datele din poza pe care mi-ai trimis-o (Luglio 2026) — rezultatul se suprapune practic perfect peste original.

## Ce poți cere să modific în continuare

- Ajustări fine de aspect ale PDF-ului (dacă vrei coloane puțin mai late/înguste)
- Adăugarea unui logo mai clar (dacă ai fișierul original în format vectorial/PNG de calitate mai bună decât poza)
- Funcție de export/backup al datelor (ex. într-un fișier, pentru mutare pe alt telefon)
