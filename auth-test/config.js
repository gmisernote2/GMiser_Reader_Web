// Public by design: a Google OAuth *web* client ID is not a secret — it only works from the
// JavaScript origins / redirect URIs registered for it in Google Cloud Console.
window.GM_CONFIG = {
  clientId: "",
  scopes: [
    "https://www.googleapis.com/auth/drive.appdata",
    "https://www.googleapis.com/auth/drive.file",
  ],
};
