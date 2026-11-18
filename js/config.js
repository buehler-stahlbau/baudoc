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
  clientId: "",
  tenantId: "organizations",
  driveBase: "/me/drive",
  rootFolder: "BauDoc",
  archiveFolder: "_Archiv",
  usersFolder: "_Nutzer",   // je Nutzer eine Datei mit seinen Favoriten
  scopes: ["User.Read", "Files.ReadWrite"],
};

export const APP_VERSION = "2.3.0-beta";
