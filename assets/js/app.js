import { db } from "./firebase.js";
import { ref, onValue } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";
import { $, showNotice, recordEvent, validHttpUrl, formatNumber } from "./common.js";

// Disable the browser context menu (right-click) on the player page.
document.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});

const els = {
  siteName: $("#siteName"), footerSiteName: $("#footerSiteName"), year: $("#year"),
  heroTitle: $("#heroTitle"), heroDescription: $("#heroDescription"),
  placeholder: $("#videoPlaceholder"), placeholderTitle: $("#placeholderTitle"), placeholderText: $("#placeholderText"),
  retryBtn: $("#retryBtn"), jw: $("#jwPlayerContainer"), html5: $("#html5Player"), iframe: $("#embedPlayer"),
  loading: $("#playerLoading"), status: $("#playbackStatus"), category: $("#videoCategory"),
  title: $("#videoTitle"), description: $("#videoDescription"), views: $("#viewCount"), updated: $("#videoUpdated"),
  mute: $("#muteBtn"), fullscreen: $("#fullscreenBtn"), reset: $("#resetBtn"), share: $("#shareBtn"),
  notice: $("#playerNotice"), startPlaybackBtn: $("#startPlaybackBtn"), adOverlay: $("#adOverlay"), adCountdown: $("#adCountdown"),
  adImage: $("#adCreativeImage"), adVideo: $("#adCreativeVideo"), adText: $("#adCreativeText"),
  adLink: $("#adCreativeLink"), skipAd: $("#skipAdBtn"), closeAd: $("#closeAdBtn"),
  banner: $("#bannerAd"), bannerTitle: $("#bannerTitle"), bannerDescription: $("#bannerDescription"), bannerLink: $("#bannerLink")
};
let videoConfig = null, settings = {}, ads = {}, player = null, currentEngine = null;
let viewCount = 0, hasStarted = false, completed = false, adTimer = null, activeAd = null, adImpressionRecorded = false;
const videoId = "featured";
els.year.textContent = new Date().getFullYear();
els.siteName.textContent = window.APP_CONFIG?.brandName || "Universal Video";
els.footerSiteName.textContent = els.siteName.textContent;

function hideEngines() {
  if (player) { try { player.remove(); } catch {} player = null; }
  els.html5.pause(); els.html5.removeAttribute("src"); els.html5.load();
  els.iframe.src = "about:blank";
  [els.jw, els.html5, els.iframe].forEach(e => e.hidden = true);
  currentEngine = null;
}
function setLoading(on) { els.loading.hidden = !on; }
function setPlaceholder(show, title, message, retry = false) {
  els.placeholder.hidden = !show;
  if (title) els.placeholderTitle.textContent = title;
  if (message) els.placeholderText.textContent = message;
  els.retryBtn.hidden = !retry;
}
function setStatus(text) { els.status.textContent = text; }
function updateMuteButton(muted) {
  els.mute.innerHTML = muted ? '<i class="fa-solid fa-volume-xmark"></i> Muted' : '<i class="fa-solid fa-volume-high"></i> Unmute';
}
function isHls(url) { return /\.m3u8($|\?)/i.test(url); }
function sourceKind(config) {
  if (config.sourceType && config.sourceType !== "auto") return config.sourceType;
  if (/\.mp4($|\?)/i.test(config.url)) return "direct";
  if (isHls(config.url)) return "direct";
  if (/youtube\.com|youtu\.be|vimeo\.com/i.test(config.url)) return "embed";
  return window.jwplayer ? "jwplayer" : "direct";
}
async function loadPublishedVideo() {
  if (!videoConfig || !videoConfig.published || !videoConfig.url || !validHttpUrl(videoConfig.url)) {
    hideEngines(); setLoading(false); els.startPlaybackBtn.hidden = true; setPlaceholder(true, "Your next watch starts here", "The administrator has not published a valid video yet.");
    els.title.textContent = "No video published"; els.description.textContent = "Check back soon for new content.";
    els.category.textContent = "Featured video"; els.views.textContent = "—"; setStatus("READY"); return;
  }
  hideEngines(); setLoading(true); els.startPlaybackBtn.hidden = true; setPlaceholder(false); setStatus("LOADING");
  els.title.textContent = videoConfig.title || "Featured video";
  els.description.textContent = videoConfig.description || "";
  els.category.textContent = videoConfig.category || "Featured video";
  els.updated.textContent = videoConfig.updatedAt ? `Updated ${new Date(videoConfig.updatedAt).toLocaleDateString()}` : "Published video";
  if (videoConfig.thumbnailUrl && validHttpUrl(videoConfig.thumbnailUrl)) {
    els.placeholder.style.backgroundImage = `linear-gradient(#0b1220aa,#0b1220aa),url("${videoConfig.thumbnailUrl.replace(/["\\]/g, "")}")`;
    els.placeholder.style.backgroundSize = "cover"; els.placeholder.style.backgroundPosition = "center";
  } else els.placeholder.style.backgroundImage = "";
  hasStarted = false; completed = false;
  try {
    const kind = sourceKind(videoConfig);
    if (kind === "embed") {
      els.iframe.hidden = false; els.iframe.src = videoConfig.url; currentEngine = "embed";
      els.iframe.addEventListener("load", () => { setLoading(false); setStatus("EMBED"); }, { once: true });
      setTimeout(() => { setLoading(false); els.startPlaybackBtn.hidden = false; }, 3000);
    } else if (kind === "jwplayer" && typeof window.jwplayer === "function") {
      els.jw.hidden = false;
      const config = {
        file: videoConfig.url, title: videoConfig.title || "Featured video",
        width: "100%", aspectratio: "16:9", controls: false,
        autostart: false, mute: settings.defaultMuted !== false,
        displaytitle: false, stretching: "uniform"
      };
      if (videoConfig.vastTagUrl && validHttpUrl(videoConfig.vastTagUrl)) {
        config.advertising = { client: "vast", tag: videoConfig.vastTagUrl };
      }
      player = window.jwplayer("jwPlayerContainer").setup(config); currentEngine = "jw";
      player.on("ready", () => { setLoading(false); setStatus("READY"); els.startPlaybackBtn.hidden = false; });
      player.on("play", () => onVideoStart());
      player.on("complete", () => { if (!completed) { completed = true; recordEvent("video_complete", { videoId }); } setStatus("COMPLETE"); });
      player.on("error", e => playbackError(e?.message || "JW Player could not play this source."));
      player.on("time", e => recordProgress(e?.position, e?.duration));
      player.on("mute", e => updateMuteButton(Boolean(e.mute)));
    } else {
      els.html5.hidden = false;
      els.html5.controls = false;
      els.html5.setAttribute("playsinline", "");
      els.html5.setAttribute("controlsList", "nodownload noplaybackrate noremoteplayback");
      els.html5.disablePictureInPicture = true;
      els.html5.src = videoConfig.url;
      currentEngine = "html5";
      els.html5.muted = settings.defaultMuted !== false;
      els.html5.addEventListener("canplay", () => { setLoading(false); setStatus("READY"); els.startPlaybackBtn.hidden = false; }, { once: true });
      els.html5.addEventListener("error", () => playbackError("This browser could not play the source. Check the URL, CORS settings, and format."));
      els.html5.addEventListener("play", onVideoStart);
      els.html5.addEventListener("ended", () => { if (!completed) { completed = true; recordEvent("video_complete", { videoId }); } setStatus("COMPLETE"); });
      els.html5.addEventListener("timeupdate", () => recordProgress(els.html5.currentTime, els.html5.duration));
      updateMuteButton(els.html5.muted);
      setTimeout(() => { if (currentEngine === "html5" && els.html5.readyState < 2) { setLoading(false); els.startPlaybackBtn.hidden = false; } }, 7000);
    }
  } catch (err) { playbackError(err?.message || "Unable to initialize player."); }
}
function onVideoStart() {
  if (!hasStarted) { hasStarted = true; recordEvent("video_start", { videoId }); }
  setStatus("PLAYING");
}
let lastProgress = {};
function recordProgress(position, duration) {
  if (!duration || !Number.isFinite(position) || duration <= 0) return;
  const pct = Math.floor(position / duration * 100);
  for (const mark of [25, 50, 75]) {
    if (pct >= mark && !lastProgress[mark]) {
      lastProgress[mark] = true; recordEvent(`video_progress_${mark}`, { videoId, progress: mark });
    }
  }
}
function playbackError(message) {
  setLoading(false); els.startPlaybackBtn.hidden = true; setStatus("ERROR"); setPlaceholder(true, "Video unavailable", message, true);
  recordEvent("video_error", { videoId }); showNotice(els.notice, message, "error");
}
function resetPlayer() {
  hideEngines(); setLoading(false); els.startPlaybackBtn.hidden = true; setPlaceholder(true, videoConfig?.title || "Your next watch starts here", "Press Try again to reload the published video.", true);
  setStatus("READY");
}
function setBannerAd(ad) {
  if (!ad || !ad.active || ad.placement !== "banner") { els.banner.hidden = true; return; }
  els.banner.hidden = false; els.bannerTitle.textContent = ad.headline || ad.name || "Sponsored";
  els.bannerDescription.textContent = ad.body || "";
  els.bannerLink.href = ad.destinationUrl;
  els.bannerLink.onclick = () => recordEvent("ad_click", { campaignId: ad.id, videoId });
  recordAdImpression(ad);
}
function recordAdImpression(ad) {
  // One event per displayed campaign per page session; client-side events are not fraud-proof.
  const key = `uvp_ad_seen_${ad.id}`;
  if (sessionStorage.getItem(key)) return;
  sessionStorage.setItem(key, "1"); recordEvent("ad_impression", { campaignId: ad.id, videoId });
}
function showPreRoll(ad) {
  if (!ad || !ad.active || ad.placement !== "preroll") return Promise.resolve();
  return new Promise(resolve => {
    activeAd = ad; adImpressionRecorded = false;
    els.adOverlay.hidden = false; els.adLink.href = ad.destinationUrl;
    els.adImage.hidden = true; els.adVideo.hidden = true; els.adText.textContent = "";
    els.skipAd.hidden = true; els.closeAd.hidden = true;
    if (ad.creativeType === "image" && validHttpUrl(ad.creativeUrl)) { els.adImage.src = ad.creativeUrl; els.adImage.hidden = false; }
    else if (ad.creativeType === "video" && validHttpUrl(ad.creativeUrl)) { els.adVideo.src = ad.creativeUrl; els.adVideo.hidden = false; els.adVideo.muted = true; els.adVideo.play().catch(() => {}); }
    else { els.adText.textContent = `${ad.headline || ad.name || "Sponsored"}${ad.body ? "\n" + ad.body : ""}`; }
    els.adLink.onclick = () => recordEvent("ad_click", { campaignId: ad.id, videoId });
    recordAdImpression(ad); adImpressionRecorded = true;
    let remaining = Math.max(0, Math.min(60, Number(ad.durationSeconds || 5)));
    const skipAfter = Math.max(0, Math.min(60, Number(ad.skipAfterSeconds ?? 5)));
    const update = () => {
      els.adCountdown.textContent = remaining > 0 ? `Video starts in ${remaining}s` : "Sponsored";
      if (skipAfter > 0 && (Number(ad.durationSeconds || 5) - remaining) >= skipAfter) els.skipAd.hidden = false;
      if (remaining <= 0 && skipAfter === 0) els.closeAd.hidden = false;
      if (remaining <= 0 && skipAfter > 0) els.skipAd.hidden = false;
    };
    const finish = () => {
      clearInterval(adTimer); adTimer = null; els.adOverlay.hidden = true; els.adVideo.pause(); els.adVideo.removeAttribute("src"); els.adVideo.load(); resolve();
    };
    els.skipAd.onclick = finish; els.closeAd.onclick = finish;
    update();
    adTimer = setInterval(() => { remaining--; update(); if (remaining <= 0 && skipAfter === 0) finish(); }, 1000);
  });
}
async function startPlayback() {
  if (!videoConfig?.published || !currentEngine) return;
  els.startPlaybackBtn.hidden = true;
  const ad = Object.entries(ads || {}).map(([id, item]) => ({ ...item, id })).find(a => a && a.active && a.placement === "preroll");
  if (ad) await showPreRoll(ad);
  if (currentEngine === "html5") els.html5.play().catch(() => { els.startPlaybackBtn.hidden = false; showNotice(els.notice, "Tap play in the player to start playback.", "info"); });
  else if (currentEngine === "jw" && player) player.play();
  else if (currentEngine === "embed") showNotice(els.notice, "Use the embedded player's own play control. Ads are not injected into third-party embeds.", "info");
}
els.retryBtn.addEventListener("click", loadPublishedVideo);
els.reset.addEventListener("click", resetPlayer);
els.mute.addEventListener("click", () => {
  if (currentEngine === "jw" && player) { const m = !player.getMute(); player.setMute(m); updateMuteButton(m); }
  else if (currentEngine === "html5") { els.html5.muted = !els.html5.muted; updateMuteButton(els.html5.muted); }
});
els.fullscreen.addEventListener("click", async () => {
  try {
    if (currentEngine === "jw" && player) player.setFullscreen(!player.getFullscreen());
    else {
      const target = currentEngine === "html5" ? els.html5 : $("#videoStage");
      if (!document.fullscreenElement) await target.requestFullscreen(); else await document.exitFullscreen();
    }
  } catch { showNotice(els.notice, "Fullscreen is not supported in this browser.", "error"); }
});
els.share.addEventListener("click", async () => {
  try { if (navigator.share) await navigator.share({ title: videoConfig?.title || document.title, url: location.href }); else { await navigator.clipboard.writeText(location.href); showNotice(els.notice, "Page link copied.", "success"); } }
  catch {}
});

// The explicit start button reliably runs the first-party pre-roll before starting direct playback.
// Third-party embed players cannot be reliably intercepted; use a compatible VAST integration there.
els.startPlaybackBtn.addEventListener("click", startPlayback);
onValue(ref(db, "public/video"), snap => { videoConfig = snap.val(); loadPublishedVideo(); });
onValue(ref(db, "public/settings"), snap => {
  settings = snap.val() || {};
  const name = settings.siteName || "Universal Video";
  els.siteName.textContent = name; els.footerSiteName.textContent = name; document.title = `${name} · Video Player`;
  els.heroTitle.textContent = settings.heroTitle || "Your video, beautifully delivered.";
  els.heroDescription.textContent = settings.heroDescription || "A clean, responsive player for your published content.";
  if (settings.showViewCount === false) els.views.parentElement.hidden = true;
  else els.views.parentElement.hidden = false;
});
onValue(ref(db, "public/ads"), snap => {
  ads = snap.val() || {};
  setBannerAd(Object.entries(ads).map(([id, ad]) => ({ ...ad, id })).find(a => a.active && a.placement === "banner"));
});
// Detailed analytics are admin-only. Do not expose the private event log to public visitors.
els.views.textContent = "Tracked";
