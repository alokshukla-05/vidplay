import { auth, db } from "./firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { ref, set, update, remove, onValue } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";
import { $, showNotice, validHttpUrl, formatNumber } from "./common.js";

const notice = $("#adminNotice");
let video = {}, playlist = {}, events = {}, stats = {}, started = false;

/* ---------- parsing / formatting ---------- */
const toClock = s => { s = Math.max(0, Math.floor(Number(s) || 0)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? `${h}:${String(m).padStart(2, "0")}` : m) + `:${String(x).padStart(2, "0")}`; };
const parseClock = s => s.split(":").map(Number).reduce((a, n) => a * 60 + n, 0);
const parseChapters = txt => txt.split("\n").map(l => l.trim()).filter(Boolean).map(l => { const m = l.match(/^(\d+(?::\d+){0,2})\s+(.+)$/); return m ? { t: parseClock(m[1]), title: m[2].slice(0, 80) } : null; }).filter(c => c && Number.isFinite(c.t));
const parseSubs = txt => txt.split("\n").map(l => l.split("|").map(s => s.trim())).filter(p => p.length >= 3 && validHttpUrl(p[2])).map(p => ({ label: p[0].slice(0, 30), lang: p[1].slice(0, 10), url: p[2] }));
const chaptersText = o => Object.values(o || {}).map(c => `${toClock(c.t)} ${c.title}`).join("\n");
const subsText = o => Object.values(o || {}).map(s => `${s.label} | ${s.lang} | ${s.url}`).join("\n");
const toLocalInput = ms => { if (!ms) return ""; const d = new Date(Number(ms)); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

/* ---------- access-code lock: the URL is stored encrypted, never in plain text ---------- */
const b64 = u8 => btoa(String.fromCharCode(...u8));
async function encryptUrl(url, code) {
  if (!window.crypto?.subtle) throw new Error("Access codes need https (or localhost).");
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const km = await crypto.subtle.importKey("raw", new TextEncoder().encode(code), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 150000, hash: "SHA-256" }, km, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const enc = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(url)));
  return { salt: b64(salt), iv: b64(iv), enc: b64(enc) };
}
async function extras(f, url) {
  const out = {
    subtitles: parseSubs($(f.subs).value), chapters: parseChapters($(f.chapters).value),
    scheduledAt: $(f.sched).value ? new Date($(f.sched).value).getTime() : null, gate: null
  };
  const code = $(f.code).value;
  if (code) { out.gate = await encryptUrl(url, code); out.url = ""; }
  return out;
}
const F_VIDEO = { subs: "#videoSubsInput", chapters: "#videoChaptersInput", sched: "#videoScheduleInput", code: "#videoCodeInput" };
const F_PL = { subs: "#plSubs", chapters: "#plChapters", sched: "#plSchedule", code: "#plCode" };

// Hooks used by admin.js when saving the main video / settings.
window.UVP_EXTRA = {
  video: () => extras(F_VIDEO, $("#videoUrlInput").value.trim()),
  settings: () => ({
    watermarkUrl: $("#wmUrlInput").value.trim(), watermarkPos: $("#wmPosInput").value,
    watermarkOpacity: Math.min(1, Math.max(.1, Number($("#wmOpacityInput").value) || .7)),
    miniPlayer: $("#miniPlayerInput").value === "true"
  })
};

/* ---------- populate extra fields ---------- */
function fillVideoExtras(v) {
  video = v;
  $("#videoSubsInput").value = subsText(v.subtitles);
  $("#videoChaptersInput").value = chaptersText(v.chapters);
  $("#videoScheduleInput").value = toLocalInput(v.scheduledAt);
  $("#videoCodeInput").value = "";
  $("#videoGateHint").textContent = v.gate ? "🔒 Currently locked. Re-enter the URL and the code to keep it locked (empty code = unlock)." : "The URL is encrypted with this code (needs https). Re-enter URL and code on every save.";
  if (v.gate) $("#videoUrlInput").placeholder = "Locked – enter the URL again to save";
}
function fillSettingsExtras(s) {
  $("#wmUrlInput").value = s.watermarkUrl || ""; $("#wmPosInput").value = s.watermarkPos || "tr";
  $("#wmOpacityInput").value = s.watermarkOpacity ?? .7; $("#miniPlayerInput").value = String(s.miniPlayer !== false);
}

/* ---------- playlist manager ---------- */
const sortedPl = () => Object.entries(playlist).map(([id, v]) => ({ id, ...v })).sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
function clearPl() {
  $("#plForm").reset(); $("#plId").value = ""; $("#plPublished").checked = true;
}
$("#plClear").addEventListener("click", clearPl);
$("#plForm").addEventListener("submit", async e => {
  e.preventDefault();
  const url = $("#plUrl").value.trim(), thumb = $("#plThumb").value.trim();
  if (!validHttpUrl(url)) return showNotice(notice, "Enter a valid video URL.", "error");
  if (thumb && !validHttpUrl(thumb)) return showNotice(notice, "Thumbnail must be a valid http(s) URL.", "error");
  const id = $("#plId").value || `pl_${Date.now()}`;
  const maxOrder = Math.max(0, ...sortedPl().map(i => Number(i.order) || 0));
  const data = {
    title: $("#plTitle").value.trim(), url, sourceType: $("#plSource").value, thumbnailUrl: thumb,
    description: $("#plDesc").value.trim(), category: $("#plCategory").value.trim() || "Playlist",
    order: $("#plOrder").value !== "" ? Number($("#plOrder").value) : maxOrder + 10,
    published: $("#plPublished").checked, updatedAt: Date.now(), updatedBy: auth.currentUser?.uid || ""
  };
  try {
    Object.assign(data, await extras(F_PL, url));
    await set(ref(db, `public/playlist/${id}`), data);
    clearPl(); showNotice(notice, "Playlist item saved.", "success");
  } catch (err) { showNotice(notice, err?.message || "Could not save the playlist item.", "error"); }
});
async function move(id, dir) {
  const list = sortedPl(), i = list.findIndex(x => x.id === id), j = i + dir;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  const up = {}; list.forEach((x, n) => { up[`${x.id}/order`] = (n + 1) * 10; });
  try { await update(ref(db, "public/playlist"), up); } catch (err) { showNotice(notice, err?.message || "Could not reorder.", "error"); }
}
function renderPlaylistAdmin() {
  const list = sortedPl(), body = $("#plBody");
  $("#plCount").textContent = `${list.length} item${list.length === 1 ? "" : "s"}`;
  if (!list.length) { body.innerHTML = '<tr><td colspan="5" class="empty-cell">No playlist items yet.</td></tr>'; return; }
  body.replaceChildren();
  list.forEach((it, n) => {
    const tr = document.createElement("tr");
    const status = !it.published ? "Hidden" : it.scheduledAt && it.scheduledAt > Date.now() ? "Scheduled" : it.gate ? "Locked" : "Live";
    [String(n + 1), it.title || "Untitled", status, formatNumber(stats[it.id]?.views || 0)].forEach((v, i) => {
      const td = document.createElement("td"); td.textContent = v; if (i === 2) td.className = status === "Live" ? "cell-good" : "cell-muted"; tr.append(td);
    });
    const td = document.createElement("td");
    const btn = (label, fn, cls = "text-button") => { const b = document.createElement("button"); b.type = "button"; b.className = cls; b.textContent = label; b.onclick = fn; return b; };
    td.append(btn("↑", () => move(it.id, -1)), btn("↓", () => move(it.id, 1)), btn("Edit", () => {
      $("#plId").value = it.id; $("#plTitle").value = it.title || ""; $("#plUrl").value = it.url || ""; $("#plSource").value = it.sourceType || "auto";
      $("#plThumb").value = it.thumbnailUrl || ""; $("#plDesc").value = it.description || ""; $("#plCategory").value = it.category || "";
      $("#plOrder").value = it.order ?? ""; $("#plSubs").value = subsText(it.subtitles); $("#plChapters").value = chaptersText(it.chapters);
      $("#plSchedule").value = toLocalInput(it.scheduledAt); $("#plCode").value = ""; $("#plPublished").checked = Boolean(it.published);
      document.querySelector('[data-tab="playlist"]').click(); $("#plTitle").focus();
    }), btn("Delete", async () => {
      if (!confirm(`Delete "${it.title || it.id}"?`)) return;
      try { await remove(ref(db, `public/playlist/${it.id}`)); showNotice(notice, "Item deleted.", "success"); } catch (e) { showNotice(notice, e?.message || "Delete failed.", "error"); }
    }, "text-button danger-text"));
    tr.append(td); body.append(tr);
  });
}

/* ---------- analytics: trends, funnel, top videos ---------- */
function renderAnalyticsExtra() {
  const list = Object.values(events), count = t => list.filter(e => e.type === t).length;
  // 14-day chart (inline SVG, no library)
  const days = 14, today = new Date(); today.setHours(0, 0, 0, 0);
  const b = Array.from({ length: days }, (_, i) => ({ t: today.getTime() - (days - 1 - i) * 864e5, s: 0, c: 0 }));
  list.forEach(e => {
    const i = Math.floor((Number(e.timestamp) - b[0].t) / 864e5);
    if (!(i >= 0 && i < days)) return;
    if (e.type === "video_start") b[i].s++; else if (e.type === "video_complete") b[i].c++;
  });
  const W = 700, H = 210, pad = 26, max = Math.max(1, ...b.map(x => x.s)), bw = (W - pad * 2) / days, ch = H - pad * 2;
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Starts and completions in the last 14 days"><line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" stroke="#253149"/><text x="${pad - 6}" y="${pad + 4}" text-anchor="end">${max}</text>`;
  b.forEach((x, i) => {
    const px = pad + i * bw, hs = x.s / max * ch, hc = x.c / max * ch, label = new Date(x.t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
    svg += `<rect x="${px + 4}" y="${H - pad - hs}" width="${bw / 2 - 5}" height="${hs}" rx="3" fill="#5b8cff"><title>${label}: ${x.s} starts</title></rect>`;
    svg += `<rect x="${px + bw / 2}" y="${H - pad - hc}" width="${bw / 2 - 5}" height="${hc}" rx="3" fill="#a06cff"><title>${label}: ${x.c} completions</title></rect>`;
    if (i % 2 === 0) svg += `<text x="${px + bw / 2}" y="${H - 8}" text-anchor="middle">${label}</text>`;
  });
  $("#trendChart").innerHTML = svg + "</svg>";

  // retention funnel
  const starts = count("video_start"), steps = [["Started", starts], ["Reached 25%", count("video_progress_25")], ["Reached 50%", count("video_progress_50")], ["Reached 75%", count("video_progress_75")], ["Completed", count("video_complete")]];
  $("#funnel").innerHTML = steps.map(([n, v]) => { const p = starts ? Math.round(v / starts * 100) : 0; return `<div class="row"><span><b>${n}</b><em>${formatNumber(v)} · ${p}%</em></span><div class="bar"><i style="width:${p}%"></i></div></div>`; }).join("");

  // top videos
  const titles = { featured: video.title || "Featured video" };
  Object.entries(playlist).forEach(([id, v]) => { titles[id] = v.title || id; });
  const by = {};
  list.forEach(e => { const id = e.videoId; if (!id) return; (by[id] ??= { s: 0, c: 0 }); if (e.type === "video_start") by[id].s++; else if (e.type === "video_complete") by[id].c++; });
  Object.keys(stats).forEach(id => { (by[id] ??= { s: 0, c: 0 }); });
  const rows = Object.entries(by).sort((a, c) => (stats[c[0]]?.views || 0) - (stats[a[0]]?.views || 0) || c[1].s - a[1].s);
  const total = Object.values(stats).reduce((n, v) => n + (Number(v?.views) || 0), 0);
  $("#publicViewsTotal").textContent = `Public views: ${formatNumber(total)}`;
  const body = $("#topVideosBody"); body.replaceChildren();
  if (!rows.length) { body.innerHTML = '<tr><td colspan="5" class="empty-cell">No data yet.</td></tr>'; return; }
  rows.forEach(([id, v]) => {
    const tr = document.createElement("tr");
    [titles[id] || id, formatNumber(stats[id]?.views || 0), formatNumber(v.s), formatNumber(v.c), v.s ? `${Math.round(v.c / v.s * 100)}%` : "—"].forEach(t => { const td = document.createElement("td"); td.textContent = t; tr.append(td); });
    body.append(tr);
  });
}

/* ---------- realtime listeners (start after sign-in) ---------- */
function start() {
  if (started) return; started = true;
  const fail = () => { started = false; };
  onValue(ref(db, "public/video"), s => { fillVideoExtras(s.val() || {}); renderAnalyticsExtra(); }, fail);
  onValue(ref(db, "public/settings"), s => fillSettingsExtras(s.val() || {}), fail);
  onValue(ref(db, "public/playlist"), s => { playlist = s.val() || {}; renderPlaylistAdmin(); renderAnalyticsExtra(); }, fail);
  onValue(ref(db, "public/stats"), s => { stats = s.val() || {}; renderPlaylistAdmin(); renderAnalyticsExtra(); }, fail);
  onValue(ref(db, "analytics/events"), s => { events = s.val() || {}; renderAnalyticsExtra(); }, fail);
}
onAuthStateChanged(auth, u => { if (u) start(); else started = false; });
