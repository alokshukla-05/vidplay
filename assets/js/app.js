import { db } from "./firebase.js";
import { ref, onValue } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";
import { $, showNotice, recordEvent, validHttpUrl } from "./common.js";

document.addEventListener("contextmenu", e => e.preventDefault());

const HLS_URL = "https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.13/hls.min.js";
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const videoId = "featured";
const stage = $("#videoStage");
const els = Object.fromEntries([
  "siteName","footerSiteName","year","heroTitle","heroDescription","videoPlaceholder","placeholderTitle","placeholderText","retryBtn",
  "jwPlayerContainer","html5Player","ytHost","embedPlayer","shield","hintL","hintR","playerLoading","buffering","startPlaybackBtn","controls",
  "seek","playBtn","backBtn","fwdBtn","muteBtn","volume","timeLabel","qualityWrap","qualityBtn","qualityMenu","speedBtn","speedMenu",
  "pipBtn","theaterBtn","fullscreenBtn","playbackStatus","videoCategory","videoTitle","videoDescription","viewCount","videoUpdated",
  "shareBtn","resetBtn","themeBtn","grid","playerNotice","adOverlay","adCountdown","adCreativeImage","adCreativeVideo","adCreativeText",
  "adCreativeLink","skipAdBtn","closeAdBtn","bannerAd","bannerTitle","bannerDescription","bannerLink","bannerCreative","bannerCreativeImage","bannerCreativeVideo"
].map(id => [id, document.getElementById(id)]));

let cfg = null, settings = {}, ads = {};
let A = null, engine = null, resumeAt = 0;
let hasStarted = false, completed = false, adInProgress = false, adTimer = null, nextMidroll = 300;
let seeking = false, idleTimer = null, clickTimer = null, lastSave = 0, marks = {};

els.year.textContent = new Date().getFullYear();
els.siteName.textContent = window.APP_CONFIG?.brandName || "Universal Video";
els.footerSiteName.textContent = els.siteName.textContent;

/* ---------- helpers ---------- */
const fmt = s => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = Math.floor(s % 60);
  return (h ? `${h}:${String(m).padStart(2, "0")}` : m) + `:${String(sec).padStart(2, "0")}`;
};
const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} }
};
const loaded = {};
const loadScript = src => loaded[src] ??= new Promise((res, rej) => {
  const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = rej; document.head.append(s);
});
const ytId = url => (url.match(/(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/))([\w-]{11})/) || [])[1] || null;
const isHls = url => /\.m3u8($|\?)/i.test(url);
const posKey = () => `uvp_pos_${cfg?.url}`;
const setStatus = t => { els.playbackStatus.textContent = t; };
const setLoading = on => { els.playerLoading.hidden = !on; };
function setPlaceholder(show, title, msg, retry = false) {
  els.videoPlaceholder.hidden = !show;
  if (title) els.placeholderTitle.textContent = title;
  if (msg) els.placeholderText.textContent = msg;
  els.retryBtn.hidden = !retry;
}
const icon = (btn, cls) => { btn.querySelector("i").className = `fa-solid ${cls}`; };

/* ---------- engine adapters (one common interface) ---------- */
function html5Adapter(url, cb) {
  const v = els.html5Player, ac = new AbortController(), o = { signal: ac.signal };
  let hls = null;
  v.hidden = false; v.controls = false; v.muted = settings.defaultMuted !== false;
  if (cfg.thumbnailUrl && validHttpUrl(cfg.thumbnailUrl)) v.poster = cfg.thumbnailUrl;
  v.addEventListener("canplay", () => cb.ready(), { ...o, once: true });
  v.addEventListener("loadedmetadata", () => cb.ready(), { ...o, once: true });
  v.addEventListener("playing", () => cb.state("playing"), o);
  v.addEventListener("pause", () => cb.state("paused"), o);
  v.addEventListener("waiting", () => cb.state("buffering"), o);
  v.addEventListener("ended", () => cb.state("ended"), o);
  v.addEventListener("error", () => cb.error("This browser could not play the source. Check the URL, CORS settings and format."), o);
  (async () => {
    if (isHls(url) && !v.canPlayType("application/vnd.apple.mpegurl")) {
      try { await loadScript(HLS_URL); } catch { return cb.error("Could not load the HLS library."); }
      if (window.Hls?.isSupported()) {
        hls = new Hls();
        hls.loadSource(url); hls.attachMedia(v);
        hls.on(Hls.Events.MANIFEST_PARSED, () => cb.levels(hls.levels.map((l, i) => ({ id: i, label: l.height ? `${l.height}p` : `Level ${i + 1}` }))));
        hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) cb.error("The stream could not be loaded."); });
        return;
      }
    }
    v.src = url;
  })();
  return {
    play: () => v.play().catch(() => cb.state("paused")), pause: () => v.pause(),
    seek: t => { v.currentTime = t; }, time: () => v.currentTime, duration: () => v.duration,
    buffered: () => v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0,
    volume: () => v.volume, setVolume: x => { v.volume = x; v.muted = x === 0; },
    muted: () => v.muted, setMuted: m => { v.muted = m; },
    rate: () => v.playbackRate, setRate: r => { v.playbackRate = r; },
    setQuality: i => { if (hls) hls.currentLevel = i; },
    pip: document.pictureInPictureEnabled ? () => (document.pictureInPictureElement ? document.exitPictureInPicture() : v.requestPictureInPicture()).catch(() => {}) : null,
    destroy() { ac.abort(); hls?.destroy(); v.pause(); v.removeAttribute("src"); v.removeAttribute("poster"); v.load(); v.hidden = true; }
  };
}

let ytApi;
const loadYT = () => ytApi ??= new Promise(res => {
  if (window.YT?.Player) return res();
  window.onYouTubeIframeAPIReady = res;
  const s = document.createElement("script"); s.src = "https://www.youtube.com/iframe_api"; document.head.append(s);
});

async function youtubeAdapter(id, cb) {
  await loadYT();
  els.ytHost.hidden = false;
  els.ytHost.innerHTML = '<div id="ytMount"></div>';
  const p = await new Promise(res => {
    const pl = new YT.Player("ytMount", {
      videoId: id, host: "https://www.youtube-nocookie.com",
      // controls=0 hides YouTube's bar; disablekb=1 blocks its shortcuts; fs=0 removes its fullscreen button.
      playerVars: { controls: 0, disablekb: 1, fs: 0, modestbranding: 1, rel: 0, iv_load_policy: 3, playsinline: 1, cc_load_policy: 0, origin: location.origin },
      events: {
        onReady: () => { if (settings.defaultMuted !== false) pl.mute(); cb.ready(); res(pl); },
        onStateChange: e => {
          const S = YT.PlayerState;
          if (e.data === S.PLAYING) cb.state("playing");
          else if (e.data === S.PAUSED) cb.state("paused");
          else if (e.data === S.BUFFERING) cb.state("buffering");
          else if (e.data === S.ENDED) cb.state("ended");
        },
        onError: () => cb.error("This YouTube video is unavailable or its owner disabled embedding.")
      }
    });
  });
  return {
    play: () => p.playVideo(), pause: () => p.pauseVideo(), seek: t => p.seekTo(t, true),
    time: () => p.getCurrentTime(), duration: () => p.getDuration(),
    buffered: () => p.getVideoLoadedFraction() * p.getDuration(),
    volume: () => p.getVolume() / 100, setVolume: x => { p.setVolume(x * 100); x === 0 ? p.mute() : p.unMute(); },
    muted: () => p.isMuted(), setMuted: m => (m ? p.mute() : p.unMute()),
    rate: () => p.getPlaybackRate(), setRate: r => p.setPlaybackRate(r), setQuality: null, pip: null,
    destroy() { try { p.destroy(); } catch {} els.ytHost.innerHTML = ""; els.ytHost.hidden = true; }
  };
}

function jwAdapter(url, cb) {
  els.jwPlayerContainer.hidden = false;
  const config = { file: url, title: cfg.title || "Featured video", width: "100%", aspectratio: "16:9", controls: false, autostart: false, mute: settings.defaultMuted !== false, displaytitle: false, stretching: "uniform" };
  if (cfg.vastTagUrl && validHttpUrl(cfg.vastTagUrl)) config.advertising = { client: "vast", tag: cfg.vastTagUrl };
  const p = window.jwplayer("jwPlayerContainer").setup(config);
  p.on("ready", () => cb.ready());
  p.on("play", () => cb.state("playing")); p.on("pause", () => cb.state("paused"));
  p.on("buffer", () => cb.state("buffering")); p.on("complete", () => cb.state("ended"));
  p.on("error", e => cb.error(e?.message || "JW Player could not play this source."));
  return {
    play: () => p.play(), pause: () => p.pause(), seek: t => p.seek(t),
    time: () => p.getPosition(), duration: () => p.getDuration(), buffered: () => p.getDuration() * (p.getBuffer() || 0) / 100,
    volume: () => p.getVolume() / 100, setVolume: x => { p.setVolume(x * 100); p.setMute(x === 0); },
    muted: () => p.getMute(), setMuted: m => p.setMute(m),
    rate: () => 1, setRate: null, setQuality: null, pip: null,
    destroy() { try { p.remove(); } catch {} els.jwPlayerContainer.hidden = true; }
  };
}

/* ---------- load / teardown ---------- */
function teardown() {
  A?.destroy(); A = null; engine = null;
  els.embedPlayer.src = "about:blank"; els.embedPlayer.hidden = true;
  [els.shield, els.controls, els.buffering, els.startPlaybackBtn].forEach(e => e.hidden = true);
  els.qualityWrap.hidden = true; els.pipBtn.hidden = true;
}
function playbackError(msg) {
  setLoading(false); teardown(); setStatus("ERROR");
  setPlaceholder(true, "Video unavailable", msg, true);
  recordEvent("video_error", { videoId }); showNotice(els.playerNotice, msg, "error");
}
function sourceKind(c) {
  if (ytId(c.url)) return "youtube";
  if (c.sourceType === "embed" || /vimeo\.com|dailymotion\.com/i.test(c.url)) return "embed";
  if (c.sourceType === "jwplayer") return window.jwplayer ? "jwplayer" : "direct";
  if (c.sourceType === "direct" || /\.(mp4|webm|ogg|m3u8)($|\?)/i.test(c.url)) return "direct";
  return window.jwplayer ? "jwplayer" : "direct";
}
async function loadPublishedVideo() {
  teardown(); setLoading(false); marks = {};
  if (!cfg || !cfg.published || !cfg.url || !validHttpUrl(cfg.url)) {
    setPlaceholder(true, "Your next watch starts here", "The administrator has not published a valid video yet.");
    els.videoTitle.textContent = "No video published"; els.videoDescription.textContent = "Check back soon for new content.";
    els.videoCategory.textContent = "Featured video"; setStatus("READY"); return;
  }
  setLoading(true); setPlaceholder(false); setStatus("LOADING");
  els.videoTitle.textContent = cfg.title || "Featured video";
  els.videoDescription.textContent = cfg.description || "";
  els.videoCategory.textContent = cfg.category || "Featured video";
  els.videoUpdated.textContent = cfg.updatedAt ? `Updated ${new Date(cfg.updatedAt).toLocaleDateString()}` : "Published video";
  document.title = `${cfg.title || "Video"} · ${els.siteName.textContent}`;
  hasStarted = false; completed = false; nextMidroll = 300; adInProgress = false;
  const saved = Number(store.get(posKey()));
  resumeAt = saved > 5 ? saved : 0;

  const cb = {
    ready() {
      setLoading(false); setStatus("READY"); els.startPlaybackBtn.hidden = hasStarted;
      els.shield.hidden = false; els.controls.hidden = false;
      els.pipBtn.hidden = !A?.pip; els.speedBtn.parentElement.hidden = !A?.setRate;
      if (A?.setVolume) els.volume.value = A.volume(); syncMute();
    },
    state(s) {
      els.buffering.hidden = s !== "buffering";
      icon(els.playBtn, s === "playing" ? "fa-pause" : "fa-play");
      if (s === "playing") onStart(), setStatus("PLAYING");
      else if (s === "paused") setStatus("PAUSED");
      else if (s === "ended") onEnd();
      kickIdle();
    },
    error: playbackError,
    levels(list) {
      els.qualityWrap.hidden = false;
      buildMenu(els.qualityMenu, [{ id: -1, label: "Auto" }, ...list.reverse()], -1, id => { A.setQuality(id); els.qualityBtn.textContent = id < 0 ? "Auto" : list.find(l => l.id === id).label; });
    }
  };
  try {
    const kind = sourceKind(cfg);
    engine = kind;
    if (kind === "embed") {
      // Third-party embeds (e.g. Vimeo) can't be controlled from outside: they keep their own controls.
      els.embedPlayer.hidden = false; els.embedPlayer.src = cfg.url;
      els.embedPlayer.addEventListener("load", () => { setLoading(false); setStatus("EMBED"); }, { once: true });
      showNotice(els.playerNotice, "This source is a third-party embed, so its own controls are used.", "info");
    } else if (kind === "youtube") A = await youtubeAdapter(ytId(cfg.url), cb);
    else if (kind === "jwplayer") A = jwAdapter(cfg.url, cb);
    else A = html5Adapter(cfg.url, cb);
    setTimeout(() => { if (A && els.playerLoading.hidden === false) { setLoading(false); els.startPlaybackBtn.hidden = false; els.shield.hidden = false; els.controls.hidden = false; } }, 8000);
  } catch (err) { playbackError(err?.message || "Unable to initialise the player."); }
}

/* ---------- playback events ---------- */
function onStart() { if (!hasStarted) { hasStarted = true; recordEvent("video_start", { videoId }); } els.startPlaybackBtn.hidden = true; }
function onEnd() {
  setStatus("COMPLETE"); store.set(posKey(), "0");
  if (!completed) { completed = true; recordEvent("video_complete", { videoId }); }
}

/* ---------- control wiring ---------- */
const toggle = () => { if (!A) return; hasStarted ? (isPlaying() ? A.pause() : A.play()) : startPlayback(); };
const isPlaying = () => els.playBtn.querySelector("i").classList.contains("fa-pause");
const skip = d => { if (!A) return; const t = Math.max(0, Math.min((A.duration() || 1e9) - .1, A.time() + d)); A.seek(t); const h = d < 0 ? els.hintL : els.hintR; h.classList.add("show"); setTimeout(() => h.classList.remove("show"), 450); };
function syncMute() {
  if (!A) return; const m = A.muted();
  icon(els.muteBtn, m || A.volume() === 0 ? "fa-volume-xmark" : A.volume() < .5 ? "fa-volume-low" : "fa-volume-high");
}
const setVol = x => { x = Math.max(0, Math.min(1, x)); A.setVolume(x); els.volume.value = x; syncMute(); };
async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (stage.requestFullscreen) await stage.requestFullscreen();
    else if (els.html5Player.webkitEnterFullscreen) els.html5Player.webkitEnterFullscreen();
  } catch { showNotice(els.playerNotice, "Fullscreen is not supported in this browser.", "error"); }
}
document.addEventListener("fullscreenchange", () => icon(els.fullscreenBtn, document.fullscreenElement ? "fa-compress" : "fa-expand"));
function buildMenu(menu, items, current, onPick) {
  menu.innerHTML = "";
  items.forEach(it => {
    const b = document.createElement("button"); b.textContent = it.label; if (it.id === current) b.className = "on";
    b.onclick = () => { onPick(it.id); [...menu.children].forEach(c => c.className = ""); b.className = "on"; menu.hidden = true; };
    menu.append(b);
  });
}
buildMenu(els.speedMenu, SPEEDS.map(s => ({ id: s, label: s === 1 ? "Normal" : `${s}×` })), 1, r => { A?.setRate?.(r); els.speedBtn.textContent = `${r}×`; });
const stepSpeed = dir => { if (!A?.setRate) return; const i = Math.max(0, Math.min(SPEEDS.length - 1, SPEEDS.indexOf(A.rate()) + dir)); A.setRate(SPEEDS[i]); els.speedBtn.textContent = `${SPEEDS[i]}×`; };
[["speedBtn", "speedMenu"], ["qualityBtn", "qualityMenu"]].forEach(([b, m]) => els[b].addEventListener("click", e => { e.stopPropagation(); const o = els[m].hidden; els.speedMenu.hidden = els.qualityMenu.hidden = true; els[m].hidden = !o; }));
document.addEventListener("click", () => { els.speedMenu.hidden = els.qualityMenu.hidden = true; });

els.playBtn.onclick = toggle;
els.backBtn.onclick = () => skip(-10); els.fwdBtn.onclick = () => skip(10);
els.muteBtn.onclick = () => { if (!A) return; A.setMuted(!A.muted()); syncMute(); };
els.volume.oninput = () => A && setVol(Number(els.volume.value));
els.fullscreenBtn.onclick = toggleFullscreen;
els.pipBtn.onclick = () => A?.pip?.();
els.theaterBtn.onclick = () => els.grid.classList.toggle("theater");
els.startPlaybackBtn.onclick = startPlayback;
els.retryBtn.onclick = loadPublishedVideo;
els.resetBtn.onclick = () => { if (A) { A.seek(0); A.play(); } else loadPublishedVideo(); };
els.themeBtn.onclick = () => { const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark"; document.documentElement.dataset.theme = t; store.set("uvp_theme", t); };
els.shareBtn.onclick = async () => {
  try { if (navigator.share) await navigator.share({ title: cfg?.title || document.title, url: location.href }); else { await navigator.clipboard.writeText(location.href); showNotice(els.playerNotice, "Page link copied.", "success"); } } catch {}
};

els.seek.addEventListener("input", () => {
  seeking = true; const d = A?.duration() || 0;
  els.seek.style.setProperty("--p", els.seek.value / 10 + "%");
  els.timeLabel.textContent = `${fmt(els.seek.value / 1000 * d)} / ${fmt(d)}`;
});
els.seek.addEventListener("change", () => { if (A) A.seek(els.seek.value / 1000 * (A.duration() || 0)); seeking = false; });

// Shield click: single = play/pause, double = skip left/right (or fullscreen in the middle).
els.shield.addEventListener("click", e => {
  kickIdle();
  if (clickTimer) {
    clearTimeout(clickTimer); clickTimer = null;
    const x = (e.clientX - stage.getBoundingClientRect().left) / stage.clientWidth;
    x < .33 ? skip(-10) : x > .66 ? skip(10) : toggleFullscreen();
  } else clickTimer = setTimeout(() => { clickTimer = null; toggle(); }, 240);
});

function kickIdle() {
  stage.classList.remove("idle"); clearTimeout(idleTimer);
  if (isPlaying()) idleTimer = setTimeout(() => stage.classList.add("idle"), 2800);
}
["mousemove", "touchstart", "keydown"].forEach(ev => stage.addEventListener(ev, kickIdle, { passive: true }));

document.addEventListener("keydown", e => {
  if (!A || e.ctrlKey || e.metaKey || e.altKey || ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName) && e.target.type !== "range") return;
  const k = e.key.toLowerCase(); let used = true;
  if (k === " " || k === "k") toggle();
  else if (k === "arrowleft" || k === "j") skip(-10);
  else if (k === "arrowright" || k === "l") skip(10);
  else if (k === "arrowup") setVol(A.volume() + .1);
  else if (k === "arrowdown") setVol(A.volume() - .1);
  else if (k === "m") els.muteBtn.click();
  else if (k === "f") toggleFullscreen();
  else if (k === "t") els.theaterBtn.click();
  else if (k === ">" || k === ".") stepSpeed(1);
  else if (k === "<" || k === ",") stepSpeed(-1);
  else if (/^[0-9]$/.test(k)) A.seek((A.duration() || 0) * Number(k) / 10);
  else used = false;
  if (used) { e.preventDefault(); kickIdle(); }
});

/* ---------- ticker: UI sync, analytics, resume, mid-roll ---------- */
setInterval(() => {
  if (!A || els.controls.hidden) return;
  let t = 0, d = 0, b = 0;
  try { t = A.time() || 0; d = A.duration() || 0; b = A.buffered() || 0; } catch { return; }
  if (!seeking) {
    els.seek.value = d ? t / d * 1000 : 0;
    els.seek.style.setProperty("--p", d ? t / d * 100 + "%" : "0%");
    els.timeLabel.textContent = `${fmt(t)} / ${fmt(d)}`;
  }
  els.seek.style.setProperty("--b", d ? b / d * 100 + "%" : "0%");
  if (!hasStarted || !d) return;
  const pct = Math.floor(t / d * 100);
  for (const m of [25, 50, 75]) if (pct >= m && !marks[m]) { marks[m] = true; recordEvent(`video_progress_${m}`, { videoId, progress: m }); }
  if (Date.now() - lastSave > 5000 && isPlaying()) { lastSave = Date.now(); store.set(posKey(), String(Math.floor(t))); }
  maybeMidroll(t);
}, 250);

/* ---------- ads (pre-roll / mid-roll) ---------- */
const activeAd = () => Object.entries(ads || {}).map(([id, a]) => ({ ...a, id })).find(a => a && a.active && a.placement === "preroll");
function recordAdImpression(ad) {
  const key = `uvp_ad_seen_${ad.id}`;
  try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, "1"); } catch {}
  recordEvent("ad_impression", { campaignId: ad.id, videoId });
}
function showPreRoll(ad) {
  return new Promise(resolve => {
    if (adTimer) clearInterval(adTimer);
    adInProgress = true; els.adOverlay.hidden = false;
    els.adCreativeLink.href = validHttpUrl(ad.destinationUrl) ? ad.destinationUrl : "#";
    els.adCreativeImage.hidden = els.adCreativeVideo.hidden = true; els.adCreativeText.textContent = "";
    els.skipAdBtn.hidden = els.closeAdBtn.hidden = true;
    els.adCreativeVideo.pause(); els.adCreativeVideo.removeAttribute("src"); els.adCreativeVideo.load();
    if (ad.creativeType === "image" && validHttpUrl(ad.creativeUrl)) { els.adCreativeImage.src = ad.creativeUrl; els.adCreativeImage.hidden = false; }
    else if (ad.creativeType === "video" && validHttpUrl(ad.creativeUrl)) { els.adCreativeVideo.src = ad.creativeUrl; els.adCreativeVideo.hidden = false; els.adCreativeVideo.muted = true; els.adCreativeVideo.play().catch(() => {}); }
    else els.adCreativeText.textContent = `${ad.headline || ad.name || "Sponsored"}${ad.body ? "\n" + ad.body : ""}`;
    els.adCreativeLink.onclick = () => recordEvent("ad_click", { campaignId: ad.id, videoId });
    recordAdImpression(ad);
    const duration = Math.max(0, Math.min(60, Number(ad.durationSeconds ?? 5)));
    const skipAfter = Math.max(0, Math.min(60, Number(ad.skipAfterSeconds ?? 5)));
    let elapsed = 0, done = false;
    const finish = () => {
      if (done) return; done = true; clearInterval(adTimer); adTimer = null;
      els.adOverlay.hidden = true; els.adCreativeVideo.pause(); els.adCreativeVideo.removeAttribute("src"); els.adCreativeVideo.load();
      adInProgress = false; resolve();
    };
    const update = () => {
      const left = Math.max(0, duration - elapsed);
      els.adCountdown.textContent = left > 0 ? `Video starts in ${left}s` : "Sponsored";
      els.skipAdBtn.hidden = !(skipAfter > 0 && elapsed >= skipAfter && elapsed >= duration);
      els.closeAdBtn.hidden = !(skipAfter === 0 && elapsed >= duration);
    };
    els.skipAdBtn.onclick = els.closeAdBtn.onclick = finish;
    update();
    if (duration === 0) { skipAfter === 0 ? finish() : (els.skipAdBtn.hidden = false); }
    else adTimer = setInterval(() => { elapsed++; update(); if (elapsed >= duration && skipAfter === 0) finish(); }, 1000);
  });
}
async function maybeMidroll(t) {
  if (adInProgress || t < nextMidroll) return;
  const ad = activeAd(); nextMidroll += 300;
  if (!ad) return;
  A.pause(); await showPreRoll(ad); A?.play();
}
async function startPlayback() {
  if (!A) return;
  els.startPlaybackBtn.hidden = true;
  const ad = activeAd();
  if (ad) await showPreRoll(ad);
  if (resumeAt) { A.seek(resumeAt); showNotice(els.playerNotice, `Resumed from ${fmt(resumeAt)}`, "info"); resumeAt = 0; }
  A.play();
}

/* ---------- Firebase subscriptions ---------- */
function setBannerAd(ad) {
  const b = els;
  b.bannerVideo = b.bannerCreativeVideo; b.bannerImage = b.bannerCreativeImage;
  b.bannerCreativeVideo.pause(); b.bannerCreativeVideo.removeAttribute("src");
  b.bannerCreativeImage.hidden = b.bannerCreativeVideo.hidden = b.bannerCreative.hidden = true;
  if (!ad) { b.bannerAd.hidden = true; return; }
  b.bannerAd.hidden = false;
  b.bannerTitle.textContent = ad.headline || ad.name || "Sponsored";
  b.bannerDescription.textContent = ad.body || "";
  b.bannerLink.href = validHttpUrl(ad.destinationUrl) ? ad.destinationUrl : "#";
  b.bannerLink.onclick = () => recordEvent("ad_click", { campaignId: ad.id, videoId });
  if (validHttpUrl(ad.creativeUrl) && ad.creativeType === "image") { b.bannerCreativeImage.src = ad.creativeUrl; b.bannerCreativeImage.hidden = b.bannerCreative.hidden = false; }
  else if (validHttpUrl(ad.creativeUrl) && ad.creativeType === "video") { b.bannerCreativeVideo.src = ad.creativeUrl; b.bannerCreativeVideo.hidden = b.bannerCreative.hidden = false; b.bannerCreativeVideo.play().catch(() => {}); }
  recordAdImpression(ad);
}
onValue(ref(db, "public/video"), s => { cfg = s.val(); loadPublishedVideo(); });
onValue(ref(db, "public/settings"), s => {
  settings = s.val() || {};
  const name = settings.siteName || "Universal Video";
  els.siteName.textContent = els.footerSiteName.textContent = name;
  els.heroTitle.textContent = settings.heroTitle || "Your video, beautifully delivered.";
  els.heroDescription.textContent = settings.heroDescription || "A clean, responsive player for your published content.";
  els.viewCount.parentElement.hidden = settings.showViewCount === false;
});
onValue(ref(db, "public/ads"), s => {
  ads = s.val() || {};
  setBannerAd(Object.entries(ads).map(([id, a]) => ({ ...a, id })).find(a => a.active && a.placement === "banner"));
});
// Detailed analytics stay admin-only; public visitors never see the private event log.
els.viewCount.textContent = "Tracked";
