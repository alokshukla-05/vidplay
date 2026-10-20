import { auth, db } from "./firebase.js";
import { signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { ref, get, set, update, remove, onValue } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";
import { $, $$, showNotice, validHttpUrl, formatNumber, formatDate } from "./common.js";

const notice = $("#adminNotice"), loginCard = $("#loginCard"), workspace = $("#adminWorkspace");
let currentUser = null, campaigns = {}, eventData = {}, currentVideo = {};
function errorMessage(error) {
  const code = error?.code || "";
  if (code.includes("PERMISSION_DENIED") || code.includes("permission-denied")) return "Permission denied. This account's UID must be authorized in your Realtime Database rules.";
  if (code.includes("auth/invalid-credential") || code.includes("auth/wrong-password") || code.includes("auth/user-not-found")) return "Sign-in failed. Check the email and password.";
  return error?.message || "Something went wrong.";
}
function setBusy(button, busy, label) { button.disabled = busy; if (busy) button.dataset.originalText = button.innerHTML; button.innerHTML = busy ? `<i class="fa-solid fa-spinner fa-spin"></i> ${label || "Please wait…"}` : (button.dataset.originalText || button.innerHTML); }
function activateTab(name) {
  $$(".admin-tab").forEach(b => { const active = b.dataset.tab === name; b.classList.toggle("active", active); b.setAttribute("aria-selected", String(active)); });
  $$(".admin-panel-section").forEach(s => s.classList.toggle("active", s.id === `tab-${name}`));
}
$$(".admin-tab").forEach(btn => btn.addEventListener("click", () => activateTab(btn.dataset.tab)));

$("#loginForm").addEventListener("submit", async e => {
  e.preventDefault(); const btn = $("#loginBtn"); setBusy(btn, true, "Signing in…");
  try { await signInWithEmailAndPassword(auth, $("#email").value.trim(), $("#password").value); showNotice(notice, "Signed in. Checking admin access…", "success"); }
  catch (err) { showNotice(notice, errorMessage(err), "error"); }
  finally { setBusy(btn, false); }
});
$("#logoutBtn").addEventListener("click", async () => { try { await signOut(auth); } catch (e) { showNotice(notice, errorMessage(e), "error"); } });
onAuthStateChanged(auth, async user => {
  currentUser = user;
  loginCard.hidden = Boolean(user); workspace.hidden = !user; $("#logoutBtn").hidden = !user;
  if (!user) return;
  try {
    // Reads a rule-protected admin-only path. Successful access proves the rules authorize this UID.
    await get(ref(db, `adminAccess/${user.uid}`));
    startAdminData();
  } catch (e) {
    await signOut(auth).catch(() => {});
    showNotice(notice, "This account is authenticated but not authorized as an administrator. Add its UID to adminAccess in Realtime Database and ensure the rules allow it.", "error");
  }
});
function startAdminData() {
  onValue(ref(db, "public/video"), snap => populateVideoForm(snap.val() || {}), e => showNotice(notice, errorMessage(e), "error"));
  onValue(ref(db, "public/settings"), snap => populateSettings(snap.val() || {}), e => showNotice(notice, errorMessage(e), "error"));
  onValue(ref(db, "public/ads"), snap => { campaigns = snap.val() || {}; renderCampaigns(); }, e => showNotice(notice, errorMessage(e), "error"));
  onValue(ref(db, "analytics/events"), snap => { eventData = snap.val() || {}; renderAnalytics(); }, e => showNotice(notice, errorMessage(e), "error"));
}
function populateVideoForm(v) {
  currentVideo = v;
  $("#videoTitleInput").value = v.title || "";
  $("#videoUrlInput").value = v.url || "";
  $("#videoSourceInput").value = v.sourceType || "auto";
  $("#videoThumbnailInput").value = v.thumbnailUrl || "";
  $("#videoDescriptionInput").value = v.description || "";
  $("#videoCategoryInput").value = v.category || "";
  $("#vastTagInput").value = v.vastTagUrl || "";
  $("#videoPublishedInput").checked = Boolean(v.published);
  $("#publishStatus").textContent = v.published ? "PUBLISHED" : "NOT PUBLISHED";
  $("#publishStatus").className = `status-pill ${v.published ? "status-good" : ""}`;
}
$("#videoForm").addEventListener("submit", async e => {
  e.preventDefault();
  const url = $("#videoUrlInput").value.trim(), thumbnailUrl = $("#videoThumbnailInput").value.trim(), vastTagUrl = $("#vastTagInput").value.trim();
  if (!validHttpUrl(url)) return showNotice(notice, "Enter a valid http:// or https:// video URL.", "error");
  if (thumbnailUrl && !validHttpUrl(thumbnailUrl)) return showNotice(notice, "Thumbnail URL must be a valid http(s) URL.", "error");
  if (vastTagUrl && !validHttpUrl(vastTagUrl)) return showNotice(notice, "VAST tag URL must be a valid http(s) URL.", "error");
  const data = {
    title: $("#videoTitleInput").value.trim(), url, sourceType: $("#videoSourceInput").value,
    thumbnailUrl, description: $("#videoDescriptionInput").value.trim(),
    category: $("#videoCategoryInput").value.trim() || "Featured video",
    vastTagUrl, published: $("#videoPublishedInput").checked,
    updatedAt: Date.now(), updatedBy: currentUser.uid
  };
  try { await set(ref(db, "public/video"), data); showNotice(notice, "Video settings saved. Public viewers will receive the latest published configuration.", "success"); }
  catch (err) { showNotice(notice, errorMessage(err), "error"); }
});
function populateSettings(s) {
  $("#siteNameInput").value = s.siteName || "Universal Video";
  $("#heroTitleInput").value = s.heroTitle || "Your video, beautifully delivered.";
  $("#heroDescriptionInput").value = s.heroDescription || "A clean, responsive player for your published content.";
  $("#defaultMutedInput").value = String(s.defaultMuted !== false);
  $("#showViewCountInput").value = String(s.showViewCount !== false);
}
$("#settingsForm").addEventListener("submit", async e => {
  e.preventDefault();
  const data = { siteName: $("#siteNameInput").value.trim() || "Universal Video", heroTitle: $("#heroTitleInput").value.trim(), heroDescription: $("#heroDescriptionInput").value.trim(), defaultMuted: $("#defaultMutedInput").value === "true", showViewCount: $("#showViewCountInput").value === "true", updatedAt: Date.now() };
  try { await set(ref(db, "public/settings"), data); showNotice(notice, "Site settings saved.", "success"); }
  catch (err) { showNotice(notice, errorMessage(err), "error"); }
});
$("#adForm").addEventListener("submit", async e => {
  e.preventDefault();
  const id = $("#adIdInput").value || `campaign_${Date.now()}`;
  const creativeType = $("#adCreativeTypeInput").value, creativeUrl = $("#adCreativeUrlInput").value.trim(), destinationUrl = $("#adDestinationInput").value.trim();
  if (!validHttpUrl(destinationUrl)) return showNotice(notice, "Destination URL must be a valid http(s) URL.", "error");
  if (creativeType !== "text" && !validHttpUrl(creativeUrl)) return showNotice(notice, "Image/video creative URL must be a valid http(s) URL.", "error");
  const data = {
    id, name: $("#adNameInput").value.trim(), placement: $("#adPlacementInput").value,
    headline: $("#adHeadlineInput").value.trim(), body: $("#adBodyInput").value.trim(),
    creativeType, creativeUrl, destinationUrl,
    durationSeconds: Math.max(0, Math.min(60, Number($("#adDurationInput").value || 5))),
    skipAfterSeconds: Math.max(0, Math.min(60, Number($("#adSkipInput").value || 5))),
    active: $("#adActiveInput").checked, updatedAt: Date.now(), updatedBy: currentUser.uid
  };
  try { await set(ref(db, `public/ads/${id}`), data); clearAdForm(); showNotice(notice, "Campaign saved and synced to visitors.", "success"); }
  catch (err) { showNotice(notice, errorMessage(err), "error"); }
});
function clearAdForm() {
  $("#adForm").reset(); $("#adIdInput").value = ""; $("#adDurationInput").value = "5"; $("#adSkipInput").value = "5"; $("#adActiveInput").checked = true;
}
$("#clearAdBtn").addEventListener("click", clearAdForm);
function renderCampaigns() {
  const rows = Object.entries(campaigns);
  $("#campaignCount").textContent = `${rows.length} campaign${rows.length === 1 ? "" : "s"}`;
  const body = $("#campaignTableBody");
  if (!rows.length) { body.innerHTML = '<tr><td colspan="6" class="empty-cell">No campaigns yet.</td></tr>'; return; }
  body.replaceChildren();
  rows.forEach(([id, ad]) => {
    const tr = document.createElement("tr");
    const cells = [
      `${ad.name || "Untitled"}\n${ad.headline || ""}`,
      ad.placement || "—",
      ad.active ? "Active" : "Paused",
      formatNumber(countEvents("ad_impression", id)),
      formatNumber(countEvents("ad_click", id))
    ];
    cells.forEach((val, i) => { const td = document.createElement("td"); td.textContent = val; if (i === 2) td.className = ad.active ? "cell-good" : "cell-muted"; tr.append(td); });
    const actions = document.createElement("td"), edit = document.createElement("button"), del = document.createElement("button");
    edit.className = "text-button"; edit.textContent = "Edit"; edit.onclick = () => {
      $("#adIdInput").value = id; $("#adNameInput").value = ad.name || ""; $("#adPlacementInput").value = ad.placement || "preroll";
      $("#adHeadlineInput").value = ad.headline || ""; $("#adBodyInput").value = ad.body || ""; $("#adCreativeTypeInput").value = ad.creativeType || "text";
      $("#adCreativeUrlInput").value = ad.creativeUrl || ""; $("#adDestinationInput").value = ad.destinationUrl || "";
      $("#adDurationInput").value = ad.durationSeconds ?? 5; $("#adSkipInput").value = ad.skipAfterSeconds ?? 5; $("#adActiveInput").checked = Boolean(ad.active);
      activateTab("ads"); $("#adNameInput").focus();
    };
    del.className = "text-button danger-text"; del.textContent = "Delete"; del.onclick = async () => {
      if (!confirm(`Delete campaign "${ad.name || id}"?`)) return;
      try { await remove(ref(db, `public/ads/${id}`)); showNotice(notice, "Campaign deleted.", "success"); }
      catch (e) { showNotice(notice, errorMessage(e), "error"); }
    };
    actions.append(edit, document.createTextNode(" · "), del); tr.append(actions); body.append(tr);
  });
}
function countEvents(type, campaignId) { return Object.values(eventData).filter(e => e.type === type && (!campaignId || e.campaignId === campaignId)).length; }
function renderAnalytics() {
  const types = ["video_start", "video_progress_25", "video_progress_50", "video_progress_75", "video_complete", "video_error", "ad_impression", "ad_click"];
  const counts = Object.fromEntries(types.map(t => [t, countEvents(t)]));
  $("#metricStarts").textContent = formatNumber(counts.video_start);
  $("#metricCompletions").textContent = formatNumber(counts.video_complete);
  $("#metricImpressions").textContent = formatNumber(counts.ad_impression);
  $("#metricClicks").textContent = formatNumber(counts.ad_click);
  $("#analyticsStarts").textContent = formatNumber(counts.video_start);
  $("#analytics25").textContent = formatNumber(counts.video_progress_25);
  $("#analytics50").textContent = formatNumber(counts.video_progress_50);
  $("#analytics75").textContent = formatNumber(counts.video_progress_75);
  $("#analyticsComplete").textContent = formatNumber(counts.video_complete);
  $("#analyticsErrors").textContent = formatNumber(counts.video_error);
  $("#analyticsImpressions").textContent = formatNumber(counts.ad_impression);
  $("#analyticsClicks").textContent = formatNumber(counts.ad_click);
  $("#analyticsCtr").textContent = counts.ad_impression ? `${(counts.ad_click / counts.ad_impression * 100).toFixed(2)}%` : "0%";
  const rows = Object.entries(eventData).map(([id, e]) => ({ id, ...e })).sort((a,b) => Number(b.timestamp || 0) - Number(a.timestamp || 0)).slice(0,50);
  const body = $("#eventsTableBody"); body.replaceChildren();
  if (!rows.length) { body.innerHTML = '<tr><td colspan="4" class="empty-cell">No events recorded.</td></tr>'; return; }
  rows.forEach(e => {
    const tr = document.createElement("tr");
    [formatDate(e.timestamp), e.type || "unknown", e.campaignId || e.videoId || "—", String(e.sessionId || "—").slice(0,12)].forEach(val => { const td = document.createElement("td"); td.textContent = val; tr.append(td); });
    body.append(tr);
  });
}
$("#refreshAnalyticsBtn").addEventListener("click", async () => {
  try { const snap = await get(ref(db, "analytics/events")); eventData = snap.val() || {}; renderAnalytics(); showNotice(notice, "Analytics refreshed.", "success"); }
  catch (e) { showNotice(notice, errorMessage(e), "error"); }
});
