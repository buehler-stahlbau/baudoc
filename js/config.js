/* =========================================================
   BauDoc – Einstellungen
   ---------------------------------------------------------
   clientId:  "Anwendungs-ID (Client ID)" aus der App-Registrierung
              in Microsoft Entra. Leer = App läuft nur lokal.
   tenantId:  "Verzeichnis-ID (Tenant ID)". "organizations" geht
              auch, die echte ID ist aber sauberer.
   driveBase: Wo die Daten liegen.
              "/me/drive"               = persönliches OneDrive (Testphase)
              "/sites/{site-id}/drive"  = SharePoint-Ablage (später, für alle)
========================================================= */
export const CONFIG = {
  clientId: "9710374b-0d37-4cc6-8e93-a05c17d16b57",   // BauDoc (App-Registrierung Bühler)
  tenantId: "0f5809d8-bfb7-440e-b308-f43d58bfb884",   // Verzeichnis Friedrich Bühler GmbH & Co. KG
  driveBase: "/me/drive",
  rootFolder: "BauDoc",
  archiveFolder: "_Archiv",
  dataFolder: "_daten",     // nur für die App: Inhalte je BV + Favoriten je Nutzer
  usersFolder: "nutzer",    // Unterordner in _daten: je Nutzer eine Datei mit seinen Favoriten
  legacyUsersFolder: "_Nutzer", // bis Version 2.8 (wird automatisch umgezogen)
  scopes: ["User.Read", "Files.ReadWrite"],
};

export const APP_VERSION = "3.1.0-beta";
