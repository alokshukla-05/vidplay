import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";

const config = window.APP_CONFIG?.firebase;
if (!config || Object.values(config).some(v => typeof v !== "string" || v.startsWith("REPLACE_WITH_"))) {
  console.warn("Firebase config is not complete. Update assets/js/config.js.");
}
export const firebaseApp = initializeApp(config);
export const auth = getAuth(firebaseApp);
export const db = getDatabase(firebaseApp);
