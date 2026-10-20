/*
 * REQUIRED CONFIGURATION
 * 1) Replace the Firebase values with your Firebase Web App config.
 * 2) Set jwPlayerLibraryUrl to your real JW Player library URL, or leave "" to use HTML5.
 * Do not put Firebase service-account keys or private secrets in this file.
 */
window.APP_CONFIG = {
  firebase: {
    apiKey: "AIzaSyDGpagCpskeOxzVO4C5qgdVUTeWO8rUZUU",
  authDomain: "electrician-830b2.firebaseapp.com",
  projectId: "electrician-830b2",
  storageBucket: "electrician-830b2.firebasestorage.app",
  messagingSenderId: "1053791458330",
  appId: "1:1053791458330:web:fdbf5befa79aef2376eda3"
  },
  jwPlayerLibraryUrl: "", // Example shape only: https://cdn.jwplayer.com/libraries/YOUR_LIBRARY_ID.js
  analytics: {
    enabled: true,
    sessionStorageKey: "uvp_session_id",
    eventThrottleMs: 5000
  },
  brandName: "Universal Video"
};
