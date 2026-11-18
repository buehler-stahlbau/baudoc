# BauDoc

Baustellendokumentation als Web-App (PWA) – läuft im Browser und auf dem Handy,
auch offline. Optional werden alle Daten mit OneDrive abgeglichen.

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
vendor/               jsPDF 2.5.1, MSAL Browser 2.39.0
```

## Ablage in OneDrive

```
BauDoc/
  12345 Neubau Lagerhalle/
    baudoc.json                      Texte + Struktur
    18.11.2026 Rohbau/
      12345 18.11.2026 Rohbau.pdf
      Bilder/                        Fotos, je max. 1 MB
  _Archiv/                           archivierte Bauvorhaben
```

- **Favoriten** (★) werden komplett auf dem Gerät gehalten, inkl. Fotos.
- **Andere Bauvorhaben** erscheinen nur in der Liste. Der Inhalt wird beim Öffnen
  geladen, Fotos nur als Vorschau.
- Fotos: 1 MB in OneDrive, im PDF stärker komprimiert (PDF max. 15 MB).

## OneDrive einrichten (einmalig, M365-Admin)

1. https://entra.microsoft.com → **App-Registrierungen → Neue Registrierung**
   - Name: `BauDoc`
   - Kontotypen: *Nur Konten in diesem Organisationsverzeichnis*
   - Umleitungs-URI: Plattform **Single-Page-Anwendung (SPA)**,
     `https://buehler-stahlbau.github.io/baudoc/`
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
