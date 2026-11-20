# BauDoc

Baustellendokumentation als App (Home-Bildschirm auf iPhone/Android) und als
Browser-Anwendung am PC – auch offline. Mit Microsoft-Anmeldung werden die Daten
über OneDrive abgeglichen, je Nutzer auf allen seinen Geräten.

Bauvorhaben (BV) = 5-stellige Nummer + Bauherr/Auftraggeber + Bauort.

## Aufbau

```
index.html            Oberfläche + Design
sw.js                 Service Worker (Offline-Betrieb)
js/config.js          Einstellungen (OneDrive-Zugang)
js/app.js             Bedienung / Anzeige
js/store.js           Datenverwaltung (+ Übernahme alter Daten)
js/sync.js            Abgleich mit OneDrive
js/onedrive.js        Microsoft-Anmeldung + Dateizugriff
js/pdf.js             PDF-Export
js/images.js          Bildverarbeitung
js/backup.js          Sicherung speichern / laden
vendor/               jsPDF 2.5.1, MSAL Browser 2.39.0, pdf.js 3.11, Leaflet 1.9.4
```

## Ablage in OneDrive

```
BauDoc/
  _daten/                            nur für die App – nicht anfassen
    bv-<Ordner-ID>.json              Texte + Struktur je BV
    nutzer/<anmeldename>.json        Favoriten je Nutzer
  _Archiv/                           archivierte Bauvorhaben
  12345 Müller GmbH, Altensteig/
    2026-11-18 Rohbau EG/
      12345 2026-11-18 Rohbau EG.pdf
      Bilder/                        Fotos, je max. 1 MB
```

- **Favoriten** (★) gehören zum Nutzer (auf all seinen Geräten gleich) und werden
  komplett auf dem Gerät gehalten, inkl. Fotos.
- **Andere Bauvorhaben** erscheinen nur in der Liste. Der Inhalt wird beim Öffnen
  geladen, Fotos nur als Vorschau.
- **Karte**: Position = Ortsmitte des Bauorts (Auswahl aus den Ortsvorschlägen).
  Ortssuche und Kartenbilder kommen von OpenStreetMap (nur Ortsnamen werden gesendet).
  `_daten/karte.json` hält die Positionen aller BV.
- Fotos: 1 MB in OneDrive, im PDF stärker komprimiert (PDF max. 15 MB).

## OneDrive einrichten (einmalig, M365-Admin)

1. https://entra.microsoft.com → **App-Registrierungen → Neue Registrierung**
   - Name: `BauDoc`
   - Kontotypen: *Nur Konten in diesem Organisationsverzeichnis*
   - Umleitungs-URI: Plattform **Single-Page-Anwendung (SPA)**,
     `https://buehler-stahlbau.github.io/stahlwork/`
2. **API-Berechtigungen** (delegiert): `User.Read`, `Files.ReadWrite`
   → ggf. *Administratorzustimmung erteilen*
3. Von der Übersichtsseite **Anwendungs-ID (Client ID)** und
   **Verzeichnis-ID (Tenant ID)** in `js/config.js` eintragen.

Testphase: `driveBase: "/me/drive"` = persönliches OneDrive des angemeldeten Nutzers.
Später für alle: `driveBase: "/sites/{site-id}/drive"` (SharePoint) und
Berechtigung `Files.ReadWrite.All`.

## Neue Version veröffentlichen

In `sw.js` die Konstante `CACHE` hochzählen, damit installierte Apps
die neuen Dateien laden.
