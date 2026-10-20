import { db } from "./firebase.js";
import { ref, get, onValue, set, push, update, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";

export const database = { ref, get, onValue, set, push, update, serverTimestamp };
export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
export const safeText = value => String(value ?? "");
export const formatNumber = value => new Intl.NumberFormat().format(Number(value || 0));
export const formatDate = value => value ? new Date(Number(value)).toLocaleString() : "—";
export const validHttpUrl = value => {
  try { const u = new URL(value); return u.protocol === "https:" || u.protocol === "http:"; }
  catch { return false; }
};
export function showNotice(el, message, kind = "info") {
  el.textContent = message;
  el.className = `notice ${kind}`;
  el.hidden = false;
  if (kind !== "error") setTimeout(() => { el.hidden = true; }, 5000);
}
export function getSessionId() {
  const key = window.APP_CONFIG?.analytics?.sessionStorageKey || "uvp_session_id";
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem(key, id);
  }
  return id;
}
export async function recordEvent(type, details = {}) {
  if (window.APP_CONFIG?.analytics?.enabled === false) return;
  // Public event writes are intentionally limited by database rules. These are analytics estimates,
  // not trusted billing events: a browser owner can forge requests.
  try {
    const eventRef = push(ref(db, "analytics/events"));
    await set(eventRef, {
      type: String(type).slice(0, 40),
      videoId: String(details.videoId || "").slice(0, 100),
      campaignId: String(details.campaignId || "").slice(0, 100),
      sessionId: getSessionId().slice(0, 100),
      timestamp: Date.now(),
      serverReceivedAt: serverTimestamp(),
      progress: Number.isFinite(details.progress) ? Math.max(0, Math.min(100, details.progress)) : null
    });
  } catch (err) {
    console.debug("Analytics event not recorded:", err?.code || err?.message);
  }
}
export const videoRef = () => ref(db, "public/video");
export const settingsRef = () => ref(db, "public/settings");
export const adsRef = () => ref(db, "public/ads");
