const SPOTIFY_AUTHORIZE = "https://accounts.spotify.com/authorize";
const SPOTIFY_API = "https://api.spotify.com/v1";
const ANIME_THEMES_API = "https://api.animethemes.moe";
const CLIENT_ID_KEY = "opening.spotify.clientId";
const TOKEN_KEY = "opening.spotify.refreshToken";
const VERIFIER_KEY = "opening.spotify.codeVerifier";
const STATE_KEY = "opening.spotify.authState";
const VISUAL_CACHE_KEY = "opening.visualCache";
const SCOPES = [
  "user-read-playback-state",
  "user-modify-playback-state"
].join(" ");

const elements = Object.fromEntries([
  "stage", "opening-video", "cover-backdrop", "connection-pill", "connection-label",
  "story-eyebrow", "story-title", "story-copy", "match-credit", "match-title",
  "match-tag", "track-cover", "cover-placeholder", "track-name", "track-artist",
  "spotify-link", "brightness-slider", "previous-button", "play-button", "next-button",
  "seek-slider", "elapsed-time", "duration-time", "device-label", "device-indicator",
  "connect-button", "settings-button", "settings-dialog", "client-id-input",
  "redirect-uri", "copy-redirect", "save-and-connect", "toast", "wordmark", "help-dialog",
  "fullscreen-button", "apps-button", "apps-dialog", "timer-pill", "timer-fields", "timer-hours",
  "timer-minutes", "timer-seconds", "timer-readout", "timer-presets", "timer-reset", "timer-start",
  "timer-done-dialog", "timer-done-note", "timer-restart"
].map(id => [id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), document.getElementById(id)]));

let clientId = localStorage.getItem(CLIENT_ID_KEY) || "";
let accessToken = "";
let refreshToken = sessionStorage.getItem(TOKEN_KEY) || "";
let tokenExpiresAt = 0;
let currentTrack = null;
let playback = null;
let playbackUpdatedAt = 0;
let polling = false;
let playbackCommandPending = false;
let lastPlaybackCommandAt = 0;
let commandedPlaybackState = null;
let commandTrackId = "";
let pollTimer = null;
let burstTimer = null;
let trackEndTimer = null;
let trackEndingSoonTimer = null;
let upcomingQueue = [];
let reportedTrackId = "";
let skipsInFlight = 0;
const skippedFrom = new Map();
let clockTimer = null;
let toastTimer = null;
let matchRequestId = 0;
const visualCache = new Map();
const uncertainLookups = new Set();
let seekDebounce = null;

const redirectUri = `${location.origin}${location.pathname}`;
elements.redirectUri.value = redirectUri;
elements.clientIdInput.value = clientId;

function notify(message, duration = 5000) {
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove("visible"), duration);
}

// Right after connecting, the pill only says "connected" and the player only appears once the first song's
// animation (or cover) is on screen, so everything shows up together.
let firstVisualReady = false;
let firstVisualTimer = null;

function setConnected(connected, label = connected ? "Spotify connected" : "Spotify not connected") {
  const loading = connected && !firstVisualReady;
  elements.stage.classList.toggle("settling", loading);
  elements.connectionPill.classList.toggle("connected", connected && !loading);
  elements.connectionLabel.textContent = loading ? "Loading animation…" : label;
  elements.connectButton.textContent = connected ? "Disconnect" : "Connect Spotify";
  if (connected) {
    elements.connectButton.insertAdjacentHTML("beforeend", ' <span aria-hidden="true">↗</span>');
  }
}

function markFirstVisualReady() {
  if (firstVisualReady) return;
  firstVisualReady = true;
  clearTimeout(firstVisualTimer);
  if (refreshToken) setConnected(true);
}

function setPlaybackDevice(name, available) {
  elements.deviceLabel.textContent = available ? (name || "Spotify active") : "Open Spotify to listen";
  document.querySelector(".device-indicator").classList.toggle("connected", available);
}

function formatTime(milliseconds) {
  const totalSeconds = Math.floor(Math.max(0, milliseconds) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function playbackPosition() {
  if (!playback) return 0;
  if (!playback.is_playing || elements.seekSlider.matches(":active")) return playback.progress_ms || 0;
  return Math.min(playback.item?.duration_ms || 0, (playback.progress_ms || 0) + Date.now() - playbackUpdatedAt);
}

function renderClock() {
  if (!currentTrack) return;
  const progress = playbackPosition();
  elements.elapsedTime.textContent = formatTime(progress);
  elements.durationTime.textContent = formatTime(currentTrack.duration_ms || 0);
  if (!elements.seekSlider.matches(":active")) {
    const duration = currentTrack.duration_ms || 0;
    elements.seekSlider.value = duration ? String(Math.round(progress / duration * 1000)) : "0";
    setRangeFill(elements.seekSlider);
  }
}

function setRangeFill(input) {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const pct = (Number(input.value) - min) / (max - min) * 100;
  input.style.setProperty("--fill", `${Math.max(0, Math.min(100, pct))}%`);
}

function updateDimness() {
  // The slider is brightness (up = brighter); the dim is what's left of it.
  const dim = 1 - Number(elements.brightnessSlider.value) / 100;
  // Darken the video itself (like osu!'s background dim) and boost saturation so it reads black, not grey.
  for (const layer of [...videoLayers, elements.coverBackdrop]) layer.style.filter = `brightness(${1 - dim}) saturate(${1 + dim * 0.6})`;
  document.querySelector(".visual-shade").style.opacity = "0";
  setRangeFill(elements.brightnessSlider);
}

// A small pool of stacked video layers: the one on screen, the previous song's (so going back is instant)
// and the next queued song's. A new video loads hidden and only crossfades in once it's actually playing.
const videoLayers = [elements.openingVideo];
while (videoLayers.length < 3) {
  const layer = elements.openingVideo.cloneNode(false);
  layer.removeAttribute("id");
  // A clone copies the muted attribute but not the muted state, and unmuted videos can't autoplay until the
  // page is clicked, which left the first animation black until play/pause was toggled.
  layer.muted = true;
  videoLayers[videoLayers.length - 1].after(layer);
  videoLayers.push(layer);
}
let frontVideo = videoLayers[0];
let pendingVideo = null;
let pendingTimer = null;
let layerUses = 0;

function layerFor(url) {
  return videoLayers.find(video => video.dataset.url === url);
}

// The least recently used layer that isn't on screen or about to be.
function spareLayer() {
  return videoLayers
    .filter(video => video !== frontVideo && video !== pendingVideo)
    .sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0))[0];
}

function loadVideo(video, url) {
  video.lastUsed = ++layerUses;
  if (video.dataset.url === url) return;
  video.dataset.url = url;
  delete video.dataset.retries;
  video.src = url;
  video.load();
}

// Keeps the visible animation in step with Spotify: playing when the music plays, paused when it pauses.
function playOpeningVideo() {
  if (!frontVideo.classList.contains("visible") || !frontVideo.dataset.url) return;
  if (!playback?.is_playing) {
    frontVideo.pause();
    return;
  }
  if (!frontVideo.paused) return;
  frontVideo.play().catch(error => {
    if (error.name === "AbortError") return;
    console.error("Anime opening playback failed:", error);
    notify("The opening video could not autoplay. Try interacting with the page and then resume playback.");
  });
}

// Watchdog: while the music plays, the visible animation must be moving. A play request the browser cut short
// (it does when a video is reloaded or rewound at the wrong moment) or a stalled download can otherwise leave
// it frozen on its first frame.
let watchedTime = -1;
let frozenSince = 0;

function checkAnimationMoving() {
  const video = frontVideo;
  if (!playback?.is_playing || !video.classList.contains("visible") || !video.dataset.url || document.hidden) {
    frozenSince = 0;
    return;
  }
  if (video.paused) video.play().catch(() => {});
  if (video.currentTime !== watchedTime) {
    watchedTime = video.currentTime;
    frozenSince = 0;
    return;
  }
  if (!frozenSince) {
    frozenSince = Date.now();
    return;
  }
  if (Date.now() - frozenSince < 2500) return;
  frozenSince = Date.now();
  console.warn("Animation was frozen; restarting it.");
  if (video.readyState >= 3) {
    // Has the data but isn't advancing: nudge it.
    video.currentTime += 0.01;
  } else {
    // Waiting on data that isn't coming: reload it from where it was.
    const resumeAt = video.currentTime;
    video.load();
    if (resumeAt) video.currentTime = resumeAt;
  }
  video.play().catch(() => {});
}

setInterval(checkAnimationMoving, 500);

function cancelPendingVideo() {
  clearInterval(pendingTimer);
  if (pendingVideo && pendingVideo !== frontVideo) pendingVideo.pause();
  pendingVideo = null;
}

const VIDEO_FADE_MS = 200;

function revealVideo(video) {
  const previous = frontVideo;
  frontVideo = video;
  // Every song starts its animation from the beginning (a hidden load may have played a moment already).
  if (video.currentTime > 0) video.currentTime = 0;
  for (const layer of videoLayers) layer.style.zIndex = layer === video ? "0" : "-1";
  video.classList.add("visible");
  markFirstVisualReady();
  hideCover();
  playOpeningVideo();
  if (previous === video) return;
  // Fade the new animation in over the old one, then retire the old one, rewound for next time.
  previous.pause();
  setTimeout(() => {
    if (previous === frontVideo || previous === pendingVideo) return;
    previous.classList.remove("visible");
    previous.currentTime = 0;
  }, VIDEO_FADE_MS);
}

function showVideo(url) {
  cancelPendingVideo();
  const video = layerFor(url) || spareLayer();
  loadVideo(video, url);
  if (video === frontVideo || video.readyState >= 3) {
    revealVideo(video);
    return;
  }
  // Play it hidden so the browser keeps buffering, and check readiness directly instead of relying on
  // one-off media events that may already have fired (or never fire for a suspended preload).
  pendingVideo = video;
  video.play().catch(() => {});
  let waitingSince = Date.now();
  pendingTimer = setInterval(() => {
    if (pendingVideo !== video || video.dataset.url !== url) {
      clearInterval(pendingTimer);
      return;
    }
    // A download that stalls without an error: start it again rather than wait forever.
    if (video.readyState < 3 && Date.now() - waitingSince > 15000) {
      waitingSince = Date.now();
      video.load();
      video.play().catch(() => {});
      return;
    }
    if (video.readyState >= 3) {
      clearInterval(pendingTimer);
      pendingVideo = null;
      revealVideo(video);
    }
  }, 100);
}

function preloadVideo(url) {
  if (layerFor(url)) return;
  const video = spareLayer();
  if (video) loadVideo(video, url);
}

function hideVideo() {
  cancelPendingVideo();
  for (const video of videoLayers) video.classList.remove("visible");
  frontVideo.pause();
}

// Songs without an anime opening show their cover art as the background instead.
let coverToken = 0;

// Spotify's API only lists covers up to 640px, but its image server also has a large (~1500–2000px)
// version of album art under a different size code. Falls back to the listed image if it's missing.
function largeCoverUrl(url) {
  return url?.replace(/(\/image\/ab67616d0000)[0-9a-f]{4}/, "$1" + "82c1") || url;
}

function showCover(track) {
  const listedUrl = track?.album?.images?.[0]?.url;
  const url = largeCoverUrl(listedUrl);
  const cover = elements.coverBackdrop;
  const token = ++coverToken;
  if (!url) {
    hideVideo();
    cover.classList.remove("visible");
    markFirstVisualReady();
    return;
  }
  const reveal = () => {
    if (token !== coverToken) return;
    markFirstVisualReady();
    cover.style.zIndex = "1";
    cover.classList.add("visible");
    // Fade the cover in over the animation, then stop the animation underneath.
    setTimeout(() => {
      if (token === coverToken) hideVideo();
    }, VIDEO_FADE_MS);
  };
  if (cover.dataset.url === url && cover.complete && cover.naturalWidth) {
    reveal();
    return;
  }
  cover.dataset.url = url;
  cover.onload = reveal;
  cover.onerror = () => {
    if (token !== coverToken) return;
    if (cover.dataset.url !== listedUrl) {
      cover.dataset.url = listedUrl;
      cover.src = listedUrl;
      return;
    }
    hideVideo();
    markFirstVisualReady();
  };
  cover.src = url;
}

function hideCover() {
  const token = ++coverToken;
  const cover = elements.coverBackdrop;
  if (!cover.classList.contains("visible")) return;
  // Drop it beneath the animation so the animation fades in over it, then remove it.
  cover.style.zIndex = "-2";
  setTimeout(() => {
    if (token === coverToken) cover.classList.remove("visible");
  }, VIDEO_FADE_MS);
}

for (const video of videoLayers) {
  video.addEventListener("error", () => {
    const url = video.dataset.url;
    if (!url) return;
    console.error("Anime opening video failed to load:", video.error);
    const wasShowing = video === frontVideo || video === pendingVideo;
    const retries = Number(video.dataset.retries || 0);
    const retryDelays = [1500, 3000, 5000, 8000, 12000];
    // The video host is often briefly busy; keep trying (the previous animation or cover stays up meanwhile).
    if (wasShowing && retries < retryDelays.length) {
      video.dataset.retries = String(retries + 1);
      setTimeout(() => {
        if (video.dataset.url !== url) return;
        video.src = url;
        video.load();
        if (video === pendingVideo || playback?.is_playing) video.play().catch(() => {});
      }, retryDelays[retries]);
      return;
    }
    delete video.dataset.url;
    delete video.dataset.retries;
    video.removeAttribute("src");
    if (wasShowing && currentTrack) {
      showCover(currentTrack);
      // Still on this song: try the whole thing again a bit later.
      retryMatch(currentTrack, 2);
    }
  });
}

function normalise(value) {
  return String(value || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/\b(tv size|tv ver\.?|tv version|full version|full ver\.?|opening theme|ending theme|theme song|official audio|lyrics|remastered|remaster|from .*|feat\.?|featuring)\b/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Smooths over romanization differences, ignoring spaces: "Shinzou"/"Shinzō"/"Shinzo", "wo"/"o" (を),
// "du"/"zu", "di"/"ji", "shimbun"/"shinbun", "senchimeetoru"/"senchimetoru".
function romajiKey(value) {
  return normalise(value)
    .replace(/\s+/g, "")
    .replace(/([aeiou])\1+/g, "$1")
    .replace(/ou/g, "o")
    .replace(/wo/g, "o")
    .replace(/du/g, "zu")
    .replace(/di/g, "ji")
    .replace(/m(?=[bp])/g, "n");
}

function scoreTitle(trackTitle, themeTitle) {
  const a = normalise(trackTitle);
  const b = normalise(themeTitle);
  if (!a || !b) return 0;
  if (a === b || romajiKey(a) === romajiKey(b)) return 12;
  if (a.includes(b) || b.includes(a)) return 8 + Math.min(a.length, b.length) / Math.max(a.length, b.length);
  const wordsA = new Set(a.split(/\s+/).filter(word => word.length > 1));
  const wordsB = new Set(b.split(/\s+/).filter(word => word.length > 1));
  const shared = [...wordsA].filter(word => wordsB.has(word)).length;
  // Mostly the same words ("Zankoku na Tenshi no Teeze" / "...no Thesis"): a likely match, but only counted
  // where the artist also matches (see the callers).
  if (shared >= 3 && shared / Math.max(wordsA.size, wordsB.size) >= .75) return 8;
  return shared ? 4 * shared / Math.max(wordsA.size, wordsB.size) : 0;
}

function animeSearchCandidates(track) {
  const album = track.album?.name || "";
  const strippedAlbum = album
    .replace(/\s*[\[(][^\])]*(?:original soundtrack|soundtrack|ost|music collection|character song)[^\])]*[\])]/ig, "")
    .replace(/\s*[-–:|]\s*(?:original soundtrack|soundtrack|ost|music collection).*$/i, "")
    .replace(/\s+(?:original soundtrack|soundtrack|ost|music collection).*$/i, "")
    .trim();
  const parts = [
    strippedAlbum,
    album,
    track.name.split(/\s(?:-|–|—|\|)\s/)[0],
    track.name.split(":")[0]
  ];
  const seen = new Set();
  return parts
    .map(value => value.trim())
    .filter(value => value.length > 2)
    .filter(value => {
      const key = normalise(value);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 4);
}

// AnimeThemes' API limits how many requests come in quickly. A "too many requests" reply is retried after a
// pause, and any failure is noted so a lookup that hit one isn't remembered as "no animation for this song".
let lastLookupFailureAt = 0;
// Replies are remembered for the session, so songs by the same artist (or the same search twice) don't wait again.
const animeThemesReplies = new Map();

async function animeThemesFetch(url) {
  if (!animeThemesReplies.has(url)) {
    const reply = fetchAnimeThemes(url);
    animeThemesReplies.set(url, reply);
    reply.then(response => { if (!response.ok) animeThemesReplies.delete(url); }, () => animeThemesReplies.delete(url));
    if (animeThemesReplies.size > 400) animeThemesReplies.delete(animeThemesReplies.keys().next().value);
  }
  return (await animeThemesReplies.get(url)).clone();
}

async function fetchAnimeThemes(url) {
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetch(url);
    } catch (error) {
      lastLookupFailureAt = Date.now();
      throw error;
    }
    if (response.status !== 429 || attempt >= 3) {
      if (!response.ok) lastLookupFailureAt = Date.now();
      return response;
    }
    const retryAfter = Number(response.headers.get("Retry-After"));
    await new Promise(resolve => setTimeout(resolve, retryAfter > 0 ? Math.min(retryAfter, 10) * 1000 : 1500 * (attempt + 1)));
  }
}

async function animeThemeRequest(candidate) {
  const params = new URLSearchParams();
  params.set("filter[name]", candidate);
  params.set("include", "animethemes.song.artists,animethemes.animethemeentries.videos");
  params.set("limit", "10");
  const response = await animeThemesFetch(`${ANIME_THEMES_API}/anime?${params}`);
  if (!response.ok) throw new Error(`AnimeThemes returned ${response.status}.`);
  return response.json();
}

async function animeThemeSongRequest(title) {
  const params = new URLSearchParams();
  params.set("filter[title]", title);
  params.set("include", "artists,animethemes.anime");
  params.set("limit", "10");
  const response = await animeThemesFetch(`${ANIME_THEMES_API}/song?${params}`);
  if (!response.ok) throw new Error(`AnimeThemes song search returned ${response.status}.`);
  return response.json();
}

// AnimeThemes' fuzzy search, for titles that are close but not identical ("...Tenshi no Teeze" vs "...Tenshi no Thesis").
async function animeThemeSongSearch(query) {
  const params = new URLSearchParams();
  params.set("q", query);
  params.set("fields[search]", "songs");
  params.set("include[song]", "artists,animethemes");
  const response = await animeThemesFetch(`${ANIME_THEMES_API}/search?${params}`);
  if (!response.ok) throw new Error(`AnimeThemes search returned ${response.status}.`);
  const payload = await response.json();
  return { songs: payload.search?.songs || [] };
}

async function animeThemeDetailsRequest(id) {
  const params = new URLSearchParams({
    include: "anime,song.artists,animethemeentries.videos"
  });
  const response = await animeThemesFetch(`${ANIME_THEMES_API}/animetheme/${encodeURIComponent(id)}?${params}`);
  if (!response.ok) throw new Error(`AnimeThemes opening lookup returned ${response.status}.`);
  return response.json();
}

function resourcesForAnime(anime, included) {
  if (Array.isArray(anime.animethemes)) {
    return anime.animethemes.map(theme => ({
      theme,
      songTitle: theme.song?.title || "",
      artists: (theme.song?.artists || []).map(artist => artist.name).filter(Boolean),
      videos: (theme.animethemeentries || []).flatMap(entry => entry.videos || [])
    }));
  }
  const byId = new Map((included || []).map(resource => [`${resource.type}:${resource.id}`, resource]));
  const themeRefs = anime.relationships?.animethemes?.data || [];
  return themeRefs.map(ref => byId.get(`animethemes:${ref.id}`)).filter(Boolean).map(theme => {
    const songRef = theme.relationships?.song?.data;
    const song = songRef ? byId.get(`songs:${songRef.id}`) : null;
    const artistRefs = song?.relationships?.artists?.data || [];
    const artists = artistRefs.map(ref => byId.get(`artists:${ref.id}`)?.attributes?.name).filter(Boolean);
    const entryRefs = theme.relationships?.animethemeentries?.data || [];
    const videos = entryRefs
      .map(ref => byId.get(`animethemeentries:${ref.id}`))
      .filter(Boolean)
      .flatMap(entry => (entry.relationships?.videos?.data || [])
        .map(ref => byId.get(`videos:${ref.id}`))
        .filter(Boolean));
    const songTitle = song?.attributes?.title || theme.attributes?.song || theme.attributes?.title || "";
    return { theme, songTitle, artists, videos };
  });
}

function scoreArtists(trackArtists, themeArtists) {
  // Compared with romanization differences smoothed over ("Yoko Takahashi" / "Youko Takahashi") and in any
  // word order ("Tatsuya Kitani" / キタニタツヤ "kitanitatsuya").
  const names = trackArtists.flatMap(artist => artistKeys(artist.name));
  const candidates = themeArtists.flatMap(artist => artistKeys(artist));
  let best = 0;
  // A name that's partly English: its English words all appear in the other spelling
  // ("TK from 凛として時雨" / "TK from Ling tosite sigure").
  for (const artist of trackArtists) {
    if (!JAPANESE_TEXT.test(artist.name)) continue;
    const latinWords = (artist.name.toLowerCase().match(/[a-z0-9]+/g) || []);
    if (!latinWords.some(word => word.length >= 2)) continue;
    for (const themeArtist of themeArtists) {
      const words = new Set(normalise(themeArtist).split(/\s+/));
      if (latinWords.every(word => words.has(word))) best = Math.max(best, 2.5);
    }
  }
  for (const name of names) {
    for (const candidate of candidates) {
      if (name === candidate) best = Math.max(best, 4);
      else if (name.includes(candidate) || candidate.includes(name)) best = Math.max(best, 2.5);
    }
  }
  return best;
}

function artistKeys(name) {
  const words = normalise(name).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  if (words.length > 3) return [romajiKey(name)];
  const orders = words.length === 1 ? [words]
    : words.length === 2 ? [words, [words[1], words[0]]]
      : [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]].map(order => order.map(index => words[index]));
  return [...new Set(orders.map(order => romajiKey(order.join(" "))))];
}

function sameArtist(a, b) {
  const keys = new Set(artistKeys(a));
  return artistKeys(b).some(key => keys.has(key));
}

// An artist's songs, with each song's videos included so a match needs no further request.
async function animeThemeArtistRequest(name) {
  const params = new URLSearchParams();
  params.set("filter[name]", name);
  params.set("include", "songs.animethemes.animethemeentries.videos");
  const response = await animeThemesFetch(`${ANIME_THEMES_API}/artist?${params}`);
  if (!response.ok) throw new Error(`AnimeThemes artist search returned ${response.status}.`);
  return response.json();
}

// For when no spelling of the artist's name is listed exactly: the same name romanized differently ("Yoko" / "Youko").
async function animeThemeArtistSearch(name) {
  const params = new URLSearchParams();
  params.set("q", name);
  params.set("fields[search]", "artists");
  params.set("include[artist]", "songs.animethemes.animethemeentries.videos");
  const response = await animeThemesFetch(`${ANIME_THEMES_API}/search?${params}`);
  if (!response.ok) return { artists: [] };
  return { artists: ((await response.json()).search?.artists || []).filter(artist => sameArtist(artist.name, name)) };
}

// AnimeThemes uses romanized artist names, so also ask Spotify for each artist's English name (e.g. 米津玄師 → Kenshi Yonezu).
async function englishArtistNames(track) {
  const ids = (track.artists || []).map(artist => artist.id).filter(Boolean).slice(0, 3);
  const artists = await Promise.all(ids.map(id =>
    spotifyFetch(`/artists/${encodeURIComponent(id)}`, { headers: { "Accept-Language": "en" } }).catch(() => null)));
  return artists.map(artist => artist?.name).filter(Boolean);
}

const JAPANESE_TEXT = /[぀-ヿ㐀-鿿ｦ-ﾟ]/;

// Romanized readings of a Japanese title or name from the local server (カワキヲアメク → "kawaki wo ameku" etc).
async function romanizeText(text) {
  try {
    const response = await fetch(`/api/romanize?text=${encodeURIComponent(text)}`);
    if (!response.ok) throw new Error(`Romanization returned ${response.status}.`);
    const result = await response.json();
    return result.variants || (result.romaji ? [result.romaji] : []);
  } catch {
    lastLookupFailureAt = Date.now();
    return [];
  }
}

// Every name the song might go by: Spotify's title, Spotify's English and Japanese titles for it (some songs
// have official translations), and a romanized reading of any Japanese title (足跡 → "ashiato"), which is
// how AnimeThemes lists Japanese songs.
async function alternativeTitles(track) {
  const localized = track.id
    ? await Promise.all(["en", "ja"].map(language =>
      spotifyFetch(`/tracks/${encodeURIComponent(track.id)}`, { headers: { "Accept-Language": language } })
        .then(result => result?.name || "")
        .catch(() => "")))
    : [];
  const titles = [track.name, ...localized].filter(Boolean);
  const romanized = (await Promise.all(titles.filter(title => JAPANESE_TEXT.test(title)).map(romanizeText))).flat();
  const seen = new Set();
  return [...titles, ...romanized].filter(title => {
    const key = normalise(title);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Which of the romanized candidates a Japanese title could be read as, trying every reading of each kanji
// (done by the local server: 廻廻奇譚 → "Kaikai Kitan", 紅蓮華 → "Gurenge").
async function readingMatches(text, candidates) {
  try {
    const params = new URLSearchParams({ text });
    for (const candidate of candidates.slice(0, 60)) params.append("candidate", candidate);
    const response = await fetch(`/api/reads-as?${params}`);
    if (!response.ok) throw new Error(`Reading match returned ${response.status}.`);
    return (await response.json()).matches || [];
  } catch {
    lastLookupFailureAt = Date.now();
    return [];
  }
}

// How AnimeThemes spells artists whose Spotify name is (partly) Japanese: 米津玄師 → "Kenshi Yonezu",
// Official髭男dism → "Official HIGE DANdism". Searches AnimeThemes' artists by the romanized name and any
// English part of it, then keeps the ones the Japanese name can actually be read as (in either name order).
async function animeThemesArtistNames(japaneseNames, romanizedNames) {
  const found = [];
  for (const name of japaneseNames.slice(0, 2)) {
    const latinParts = name.match(/[A-Za-z][A-Za-z.' -]{2,}/g) || [];
    const queries = [...new Set([...romanizedNames, ...latinParts].map(query => query.trim()).filter(query => query.length >= 3))].slice(0, 4);
    const results = await Promise.all(queries.map(async query => {
      const params = new URLSearchParams({ q: query, "fields[search]": "artists" });
      try {
        const response = await animeThemesFetch(`${ANIME_THEMES_API}/search?${params}`);
        return response.ok ? (await response.json()).search?.artists || [] : [];
      } catch {
        return [];
      }
    }));
    const candidates = [...new Set(results.flat().map(artist => artist.name).filter(Boolean))];
    const variants = new Map();
    for (const candidate of candidates) {
      for (const variant of withSwappedNameOrder([candidate])) variants.set(variant, candidate);
    }
    const readable = await readingMatches(name, [...variants.keys()]);
    found.push(...readable.map(variant => variants.get(variant)));
    found.push(...candidates.filter(candidate => romanizedNames.some(romanized => sameArtist(candidate, romanized))));
  }
  return [...new Set(found)];
}

// Long enough that another song sharing it is unlikely ("Kawaki wo Ameku" yes, "Hello" no).
function distinctiveTitle(title) {
  const words = normalise(title).split(/\s+/).filter(Boolean);
  return words.length >= 2 && words.join("").length >= 10;
}

function bestTitleScore(titles, themeTitle) {
  return Math.max(0, ...titles.map(title => scoreTitle(title, themeTitle)));
}

// A rough "consonant sound" outline, so an English word and its katakana form compare alike:
// ファタール "fataaru" ≈ "Fatal", ブルーバード "buruubaado" ≈ "Blue Bird", アイドル "aidoru" ≈ "Idol".
function soundSkeleton(value, { keepR = false } = {}) {
  return normalise(value).replace(/[^a-z]/g, "")
    .replace(/ph/g, "f").replace(/ck/g, "k").replace(/q/g, "k").replace(/x/g, "ks")
    .replace(/c(?=[eiy])/g, "s").replace(/c(?!h)/g, "k")
    .replace(/th/g, "s").replace(/ch/g, "t").replace(/sh/g, "s").replace(/ts/g, "t")
    // An English R before a consonant is often silent in Japanese ("bird" → "baado"), but an L isn't ("idol" → "aidoru").
    .replace(/r(?![aeiouy])/g, keepR ? "r" : "")
    .replace(/l/g, "r").replace(/v/g, "b").replace(/j/g, "z").replace(/h/g, "")
    .replace(/[aeiouy]/g, "")
    .replace(/(.)\1+/g, "$1");
}

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}

// For titles written in katakana (usually English loanwords): does an artist's English title sound the same?
// Only used among one artist's own songs, where a loose comparison can't pick up an unrelated song.
function soundsAlike(titles, themeTitle) {
  // An English R before a consonant is sometimes dropped in katakana ("bird" → "baado") and sometimes kept
  // ("inferno" → "inferuno"), so the English title is tried both ways.
  const targets = [soundSkeleton(themeTitle), soundSkeleton(themeTitle, { keepR: true })].filter(target => target.length >= 2);
  return titles.some(title => {
    if (JAPANESE_TEXT.test(title)) return false;
    const skeleton = soundSkeleton(title, { keepR: true });
    if (skeleton.length < 2) return false;
    return targets.some(target => Math.min(skeleton.length, target.length) <= 3
      ? skeleton === target
      : 1 - editDistance(skeleton, target) / Math.max(skeleton.length, target.length) >= .7);
  });
}

// Japanese names are family name first; AnimeThemes often lists them given name first (Kitani Tatsuya / Tatsuya Kitani).
function withSwappedNameOrder(names) {
  return names.flatMap(name => {
    const words = name.split(/\s+/);
    return words.length === 2 ? [name, `${words[1]} ${words[0]}`] : [name];
  });
}

async function themeMatch(theme, song, score) {
  // Themes from an artist lookup already carry their videos; others need fetching.
  const included = (theme.animethemeentries || []).some(entry => (entry.videos || []).length);
  const fullTheme = included ? { ...theme, song: theme.song || song } : await animeThemeDetailsRequest(theme.id).then(detail => detail.animetheme || detail);
  const videos = (fullTheme.animethemeentries || [])
    .flatMap(entry => entry.videos || [])
    .filter(video => (video.attributes || video).link);
  if (!videos.length) return null;
  return {
    anime: fullTheme.anime || theme.anime,
    theme: fullTheme,
    songTitle: fullTheme.song?.title || song.title || song.attributes?.title || "",
    artists: (fullTheme.song?.artists || song.artists || [])
      .map(artist => artist.name || artist.attributes?.name)
      .filter(Boolean),
    videos,
    score
  };
}

// Openings first, then endings, earliest first.
function orderThemes(themes) {
  return [...themes].sort((a, b) =>
    Number(/^ED$/i.test(a.type)) - Number(/^ED$/i.test(b.type)) || Number(a.sequence || 0) - Number(b.sequence || 0));
}

function isSameRecording(track, candidate) {
  if (!candidate) return false;
  if (track.id && candidate.id === track.id) return true;
  const isrc = track.external_ids?.isrc;
  if (isrc && String(candidate.external_ids?.isrc || "").toUpperCase() === isrc.toUpperCase()) return true;
  const artistIds = new Set((track.artists || []).map(artist => artist.id));
  return normalise(candidate.name) === normalise(track.name) && (candidate.artists || []).some(artist => artistIds.has(artist.id));
}

// Handles titles that differ between Spotify and AnimeThemes (足跡 vs "Ashiato", センチメートル vs "Centimeter"):
// take the artist's songs from AnimeThemes, match them against every name the song goes by, and otherwise use
// Spotify search to check which one is the recording that's playing.
// All of the artists' anime songs on AnimeThemes (looked up for every spelling of their names at once).
async function artistSongs(artistNames) {
  let payloads = await Promise.all(artistNames.slice(0, 8).map(name => animeThemeArtistRequest(name).catch(() => ({}))));
  if (!payloads.some(payload => payload.artists?.length)) {
    payloads = await Promise.all(artistNames.slice(0, 2).map(name => animeThemeArtistSearch(name).catch(() => ({}))));
  }
  const songs = new Map();
  for (const payload of payloads) {
    for (const artist of payload.artists || []) {
      for (const song of artist.songs || []) {
        const themes = (song.animethemes || []).filter(theme => /^(OP|ED)$/i.test(theme.type || ""));
        if (song.title && themes.length) songs.set(song.id, { song, artistName: artist.name, themes });
      }
    }
  }
  return songs;
}

async function findOpeningByArtist(track, isStale, titles, songs) {
  const ordered = [...songs.values()]
    .map(entry => ({ ...entry, titleScore: bestTitleScore(titles, entry.song.title) }))
    .sort((a, b) => b.titleScore - a.titleScore)
    .slice(0, 40);
  const useHit = async hit => {
    for (const theme of orderThemes(hit.themes)) {
      if (isStale()) return null;
      const match = await themeMatch(theme, hit.song, 12);
      if (match) return match;
    }
    return null;
  };
  // A title match by the same artist is enough on its own, including a katakana title that sounds like it,
  // or a kanji title that can be read as it (炎 has several readings; the song may use any of them).
  let titleHit = ordered.find(entry => entry.titleScore >= 8)
    || (titles.some(title => /[゠-ヿ]/.test(title)) && ordered.find(entry => soundsAlike(titles, entry.song.title)));
  for (const title of titles.filter(value => JAPANESE_TEXT.test(value))) {
    if (titleHit || !ordered.length) break;
    const readable = await readingMatches(title, ordered.map(entry => entry.song.title));
    titleHit = ordered.find(entry => readable.includes(entry.song.title));
  }
  if (titleHit) {
    const match = await useHit(titleHit);
    if (match || isStale()) return match;
  }
  for (let index = 0; index < ordered.length; index += 5) {
    if (isStale()) return null;
    const batch = ordered.slice(index, index + 5);
    const results = await Promise.all(batch.map(({ song, artistName }) => {
      const params = new URLSearchParams({ q: `${song.title} ${artistName}`, type: "track", limit: "10" });
      return spotifyFetch(`/search?${params}`).catch(() => null);
    }));
    const hit = batch.find((_, position) => (results[position]?.tracks?.items || []).some(item => isSameRecording(track, item)));
    if (!hit) continue;
    const match = await useHit(hit);
    if (match || isStale()) return match;
  }
  return null;
}

async function findOpening(track, isStale) {
  // (May be empty for short titles like 足跡; the song and artist searches below still run.)
  const candidates = animeSearchCandidates(track);
  const matches = [];
  const albumFallbacks = [];
  const errors = [];
  // The steps below run side by side wherever one doesn't need another's result: the title searches start as
  // soon as the song's alternative names are known, while the artist's names and songs are worked out.
  const titlesReady = alternativeTitles(track).catch(() => [track.name]);
  const uniqueNames = names => [...new Set(names.map(name => String(name || "").trim()).filter(Boolean))];
  // The artist's names: Spotify's, plus (for Japanese names) their main romanized reading in either name order.
  // Artists too: AnimeThemes lists 美波 as "Minami", which Spotify doesn't always translate.
  const quickNamesReady = (async () => {
    const englishArtists = await englishArtistNames(track).catch(() => []);
    const spotifyArtists = [...(track.artists || []).map(artist => artist.name), ...englishArtists].filter(Boolean);
    const japaneseArtists = spotifyArtists.filter(name => JAPANESE_TEXT.test(name));
    const romanizedArtists = withSwappedNameOrder((await Promise.all(japaneseArtists.map(romanizeText))).map(readings => readings[0]).filter(Boolean));
    return { spotifyArtists, japaneseArtists, romanizedArtists };
  })();
  // ...and, slower, how AnimeThemes spells a Japanese name (米津玄師 → "Kenshi Yonezu"), found by searching.
  const listedNamesReady = quickNamesReady
    .then(({ japaneseArtists, romanizedArtists }) => animeThemesArtistNames(japaneseArtists, romanizedArtists))
    .catch(() => []);
  const artistNamesReady = Promise.all([quickNamesReady, listedNamesReady]).then(([quick, listed]) =>
    uniqueNames([...quick.spotifyArtists, ...quick.romanizedArtists, ...listed]));
  // The artist's songs are fetched as soon as the first names are known, and again for any spelling found later.
  const artistSongsReady = (async () => {
    const quick = await quickNamesReady;
    const quickNames = uniqueNames([...quick.spotifyArtists, ...quick.romanizedArtists]);
    const [quickSongs, listed] = await Promise.all([artistSongs(quickNames), listedNamesReady]);
    const extra = listed.filter(name => !quickNames.includes(name));
    if (!extra.length) return quickSongs;
    return new Map([...quickSongs, ...await artistSongs(extra)]);
  })().catch(() => new Map());
  const titles = await titlesReady;
  const songCandidates = [...new Set(titles.flatMap(title => [
    title,
    ...title.split(/\s(?:-|–|—|\|)\s/),
    ...title.split(":")
  ]).map(value => value.trim()).filter(value => value.length > 1))];
  // AnimeThemes only has romanized/English titles, so searching it with Japanese text is pointless.
  const searchableTitles = titles.filter(title => !JAPANESE_TEXT.test(title)).slice(0, 5);
  const songSearches = [
    ...songCandidates.filter(candidate => !JAPANESE_TEXT.test(candidate)).map(candidate => animeThemeSongRequest(candidate)),
    ...searchableTitles.map(title => animeThemeSongSearch(title))
  ];
  songSearches.forEach(search => search.catch(() => {}));
  const artistNames = await artistNamesReady;
  const trackArtists = artistNames.map(name => ({ name }));
  await Promise.all(songSearches.map(async search => {
    try {
      const payload = await search;
      const songs = (payload.songs || payload.data || [])
        .map(song => {
          const songTitle = song.title || song.attributes?.title || "";
          return {
            song,
            titleScore: bestTitleScore(titles, songTitle),
            exactTitle: scoreTitle(track.name, songTitle) >= 12,
            listedArtists: (song.artists || []).length,
            artistScore: scoreArtists(
              trackArtists,
              (song.artists || []).map(artist => artist.name || artist.attributes?.name).filter(Boolean)
            )
          };
        })
        // The artist must match too ("Hello" by Adele isn't the anime song "Hello"). Only a distinctive, identical
        // title whose AnimeThemes entry lists no artist at all (nothing to compare) is taken on the title alone.
        .filter(match => match.titleScore >= 8 && (match.artistScore >= 2.5
          || (match.exactTitle && !match.listedArtists && distinctiveTitle(track.name))))
        .sort((a, b) => (b.titleScore + b.artistScore) - (a.titleScore + a.artistScore));
      const lookups = songs.flatMap(({ song, titleScore, artistScore }) => (song.animethemes || [])
        .filter(theme => /^(OP|ED)$/i.test(theme.type || theme.attributes?.type || ""))
        .map(theme => ({ song, theme, score: titleScore + artistScore * 0.25 + (/^OP$/i.test(theme.type || "") ? 0.5 : 0) })))
        .slice(0, 6);
      const found = await Promise.all(lookups.map(({ song, theme, score }) => themeMatch(theme, song, score).catch(() => null)));
      matches.push(...found.filter(Boolean));
    } catch (error) {
      errors.push(error);
    }
  }));
  if (isStale()) return null;
  matches.sort((a, b) => b.score - a.score);
  if (matches.length) return matches[0];

  try {
    const artistMatch = await findOpeningByArtist(track, isStale, titles, await artistSongsReady);
    if (artistMatch || isStale()) return artistMatch;
  } catch (error) {
    errors.push(error);
  }

  const animeSearches = candidates.map(candidate => animeThemeRequest(candidate));
  animeSearches.forEach(search => search.catch(() => {}));
  for (const [candidateIndex, candidate] of candidates.entries()) {
    if (isStale()) return null;
    try {
      const payload = await animeSearches[candidateIndex];
      const included = payload.included || [];
      for (const anime of payload.anime || payload.data || []) {
        const animeName = anime.attributes?.name || anime.name || "";
        const items = resourcesForAnime(anime, included);
        // The album is named after this anime: only trusted when it's clearly a soundtrack, or the artist is one of
        // this anime's (an unrelated album that happens to share an anime's name shouldn't show its opening).
        const soundtrackAlbum = /soundtrack|\bost\b|music collection|character song|original/i.test(track.album?.name || "");
        const animeArtist = items.some(item => scoreArtists(trackArtists, item.artists) >= 2.5);
        if (candidateIndex === 0 && scoreTitle(candidate, animeName) >= 12 && (soundtrackAlbum || animeArtist)) {
          for (const item of items) {
            const theme = item.theme.attributes || item.theme;
            if (/^OP$/i.test(theme.type || "") && item.videos.some(video => (video.attributes || video).link)) {
              albumFallbacks.push({ anime, ...item, albumFallback: true });
            }
          }
        }
        for (const item of items) {
          const titleScore = bestTitleScore(titles, item.songTitle);
          const artistScore = scoreArtists(trackArtists, item.artists);
          const score = titleScore + artistScore * 0.25;
          if (!item.videos.some(video => (video.attributes || video).link)) continue;
          // Same rule as the song search: the title and the artist must both match.
          if (titleScore < 8 || !(artistScore >= 2.5 || (titleScore >= 12 && !item.artists.length && distinctiveTitle(track.name)))) continue;
          matches.push({ anime, ...item, score, candidate });
        }
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (isStale()) return null;
  matches.sort((a, b) => b.score - a.score);
  const match = matches[0];
  if (match && match.score >= 2) return match;
  if (albumFallbacks.length) {
    albumFallbacks.sort((a, b) => {
      const aTheme = a.theme.attributes || a.theme;
      const bTheme = b.theme.attributes || b.theme;
      return Number(aTheme.sequence || 0) - Number(bTheme.sequence || 0);
    });
    return albumFallbacks[0];
  }
  if (errors.length && errors.length === candidates.length) throw errors[0];
  return null;
}

async function readJsonResponse(response, source) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    if (response.ok) throw new Error(`${source} returned an invalid response (${response.status}).`);
    return null;
  }
}

// Turns a lookup result into what the page needs; this is also what gets remembered between sessions.
function visualFromMatch(match) {
  const videos = [...match.videos].sort((a, b) => {
    const aVideo = a.attributes || a;
    const bVideo = b.attributes || b;
    return Number(Boolean(bVideo.subbed)) - Number(Boolean(aVideo.subbed));
  });
  const video = videos.find(candidate => {
    const url = (candidate.attributes || candidate).link || "";
    const mimeType = /\.mp4(?:$|[?#])/i.test(url) ? "video/mp4"
      : /\.webm(?:$|[?#])/i.test(url) ? "video/webm"
        : "";
    return !mimeType || elements.openingVideo.canPlayType(mimeType) !== "";
  }) || videos[0];
  const link = (video?.attributes || video)?.link;
  if (!link) return null;
  const videoSource = new URL(link);
  return {
    videoUrl: videoSource.hostname === "v.animethemes.moe"
      ? `/anime-video/${encodeURIComponent(videoSource.pathname.split("/").pop())}`
      : link,
    animeName: match.anime?.attributes?.name || match.anime?.name || "Anime",
    songTitle: match.songTitle,
    themeType: match.theme.attributes?.type || match.theme.type || "OP",
    themeSequence: match.theme.attributes?.sequence || match.theme.sequence || null,
    albumFallback: Boolean(match.albumFallback)
  };
}

// Read from browser storage once, then kept in memory (it's checked on every song change).
let storedVisuals = null;

function readStoredVisuals() {
  if (!storedVisuals) {
    try {
      storedVisuals = JSON.parse(localStorage.getItem(VISUAL_CACHE_KEY)) || {};
    } catch {
      storedVisuals = {};
    }
  }
  return storedVisuals;
}

function storeVisual(trackId, visual) {
  try {
    const stored = readStoredVisuals();
    delete stored[trackId];
    stored[trackId] = visual;
    const ids = Object.keys(stored);
    for (const oldId of ids.slice(0, Math.max(0, ids.length - 500))) delete stored[oldId];
    setTimeout(() => {
      try {
        localStorage.setItem(VISUAL_CACHE_KEY, JSON.stringify(readStoredVisuals()));
      } catch {}
    }, 0);
  } catch (error) {
    console.warn("Could not remember anime match:", error);
  }
}

// One lookup per track: shared by the current song and the queue prefetch, and remembered across visits.
function resolveVisual(track) {
  const trackId = track.id || track.uri || "";
  if (visualCache.has(trackId)) return visualCache.get(trackId);
  const stored = readStoredVisuals()[trackId];
  const startedAt = Date.now();
  const lookup = stored
    ? Promise.resolve(stored)
    : findOpening(track, () => false).then(match => {
      const visual = match ? visualFromMatch(match) : null;
      if (visual && trackId) storeVisual(trackId, visual);
      // "No match" is only remembered if every request worked; otherwise it's uncertain and is looked up again.
      if (!visual && lastLookupFailureAt >= startedAt) {
        if (visualCache.get(trackId) === lookup) visualCache.delete(trackId);
        uncertainLookups.add(trackId);
      } else {
        uncertainLookups.delete(trackId);
      }
      return visual;
    });
  visualCache.set(trackId, lookup);
  lookup.catch(() => visualCache.delete(trackId));
  return lookup;
}

function isVisualKnown(track) {
  const trackId = trackKey(track);
  return visualCache.has(trackId) || Boolean(readStoredVisuals()[trackId]);
}

async function prefetchUpcoming() {
  try {
    const forId = trackKey(currentTrack);
    const data = await spotifyFetch("/me/player/queue");
    // Ignore an answer about a song we've already moved on from, or one Spotify hasn't caught up on yet.
    if (!forId || trackKey(data?.currently_playing) !== forId || trackKey(currentTrack) !== forId) return;
    upcomingQueue = (data.queue || []).filter(item => item?.type === "track").slice(0, 10);
    prepareAhead(upcomingQueue);
  } catch (error) {
    console.warn("Could not prepare the next anime visual:", error);
  }
}

// Gets the next few queued songs ready so skipping to any of them is instant: finds each one's anime (one at a
// time, so AnimeThemes isn't flooded), has the local server download its video ahead of time, and loads the
// very next one into a spare video layer. Starts over whenever Spotify reports a new queue.
const PREPARE_AHEAD = 6;
let prepareGeneration = 0;

async function prepareAhead(queue) {
  const generation = ++prepareGeneration;
  for (const [index, track] of queue.slice(0, PREPARE_AHEAD).entries()) {
    if (generation !== prepareGeneration) return;
    const cover = track.album?.images?.[0]?.url;
    if (cover) new Image().src = largeCoverUrl(cover);
    const alreadyKnown = isVisualKnown(track);
    const visual = await resolveVisual(track).catch(() => null);
    if (generation !== prepareGeneration) return;
    if (visual) {
      if (index === 0) preloadVideo(visual.videoUrl);
      else fetch(`${visual.videoUrl}?prefetch`).catch(() => {});
    }
    // Pace the lookups that actually went out to AnimeThemes.
    if (!alreadyKnown) await new Promise(resolve => setTimeout(resolve, 600));
  }
}

// After a lookup or video that failed for a passing reason (a service busy for a moment), try again while the
// song is still playing, with growing pauses. The cover (or the previous animation) stays up meanwhile.
const RETRY_DELAYS_MS = [2000, 4000, 8000, 15000, 25000];
let retryTimer = null;

function retryMatch(track, attempt) {
  clearTimeout(retryTimer);
  if (attempt >= RETRY_DELAYS_MS.length) return;
  retryTimer = setTimeout(() => {
    if (trackKey(currentTrack) === trackKey(track)) matchTrack(track, attempt + 1);
  }, RETRY_DELAYS_MS[attempt]);
}

async function matchTrack(track, attempt = 0) {
  const requestId = ++matchRequestId;
  clearTimeout(retryTimer);
  elements.matchCredit.hidden = true;
  if (!track) {
    hideVideo();
    hideCover();
    markFirstVisualReady();
    return;
  }
  try {
    // When skipping quickly, don't spend lookups on songs that are skipped past straight away
    // (not for the song playing when you connect: nothing's being skipped yet).
    if (!isVisualKnown(track) && !attempt && firstVisualReady) {
      await new Promise(resolve => setTimeout(resolve, 350));
      if (requestId !== matchRequestId) return;
    }
    const visual = await resolveVisual(track);
    if (requestId !== matchRequestId) return;
    if (!visual) {
      if (uncertainLookups.has(trackKey(track))) retryMatch(track, attempt);
      showCover(track);
      elements.storyEyebrow.textContent = "NOW PLAYING ON SPOTIFY";
      elements.storyTitle.innerHTML = "Every song<br>has a <em>story.</em>";
      elements.storyCopy.textContent = "No matching anime opening was found for this track.";
      prefetchUpcoming();
      return;
    }
    showVideo(visual.videoUrl);
    elements.storyEyebrow.textContent = "A MATCH FOR WHAT YOU'RE HEARING";
    elements.storyTitle.innerHTML = "Your song.<br><em>Your scene.</em>";
    elements.storyCopy.textContent = visual.albumFallback
      ? `${visual.animeName} is identified from the album; showing its first opening for this alternate version.`
      : `${visual.animeName} — looping until your track ends.`;
    elements.matchTitle.textContent = `${visual.animeName} · ${visual.songTitle}`;
    elements.matchTag.textContent = `${visual.themeType}${visual.themeSequence ? ` ${visual.themeSequence}` : ""}${visual.albumFallback ? " · ALBUM MATCH" : ""}`;
    elements.matchCredit.hidden = false;
    prefetchUpcoming();
  } catch (error) {
    console.error("AnimeThemes lookup failed:", error);
    if (requestId === matchRequestId) {
      showCover(track);
      elements.storyCopy.textContent = "The anime visual catalog is temporarily unavailable. Your Spotify playback is still connected.";
      retryMatch(track, attempt);
      if (attempt === RETRY_DELAYS_MS.length) notify("Couldn't reach AnimeThemes right now. Your music controls are still working.");
    }
  }
}

async function getToken() {
  if (accessToken && Date.now() < tokenExpiresAt - 30_000) return accessToken;
  if (!refreshToken || !clientId) return "";
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId })
  });
  if (!response.ok) {
    const detail = await readJsonResponse(response, "Spotify sign-in");
    const message = detail?.error_description || "Spotify sign-in expired. Please reconnect.";
    disconnectSpotify();
    throw new Error(message);
  }
  const data = await readJsonResponse(response, "Spotify sign-in");
  if (!data?.access_token || !data?.expires_in) {
    throw new Error("Spotify did not return a valid access token. Please reconnect.");
  }
  accessToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;
  if (data.refresh_token) {
    refreshToken = data.refresh_token;
    sessionStorage.setItem(TOKEN_KEY, refreshToken);
  }
  return accessToken;
}

async function spotifyFetch(path, options = {}, retry = true) {
  const token = await getToken();
  if (!token) throw new Error("Connect your Spotify account first.");
  let response;
  try {
    response = await fetch(`${SPOTIFY_API}${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers }
    });
  } catch (error) {
    lastLookupFailureAt = Date.now();
    throw error;
  }
  // A busy Spotify makes any anime lookup running now uncertain (see resolveVisual).
  if (response.status === 429 || response.status >= 500) lastLookupFailureAt = Date.now();
  if (response.status === 401 && retry) {
    accessToken = "";
    return spotifyFetch(path, options, false);
  }
  const expectsJson = !options.method || options.method === "GET";
  if (response.ok && (!expectsJson || response.status === 204)) return null;
  const data = await readJsonResponse(response, "Spotify");
  if (!response.ok && response.status !== 204) {
    if (response.status === 401) {
      disconnectSpotify();
      throw new Error("Spotify sign-in expired. Please reconnect.");
    }
    if (response.status === 403) throw new Error("Spotify couldn't control playback. Check that Spotify is open and your account supports playback control.");
    if (response.status === 404) throw new Error("No active Spotify device. Start playback in Spotify first.");
    if (response.status === 429) throw new Error(`Spotify rate limit reached. Try again in ${response.headers.get("Retry-After") || "a few"} seconds.`);
    throw new Error(data?.error?.message || `Spotify request failed (${response.status}).`);
  }
  return data;
}

function setTrack(track) {
  const trackId = track?.id || track?.uri || "";
  const previousId = currentTrack?.id || currentTrack?.uri || "";
  currentTrack = track || null;
  if (!track) {
    elements.trackName.textContent = "Nothing playing right now";
    elements.trackArtist.textContent = "Start a playlist in Spotify to begin";
    elements.trackCover.hidden = true;
    elements.coverPlaceholder.hidden = false;
    elements.elapsedTime.textContent = "0:00";
    elements.durationTime.textContent = "0:00";
    elements.seekSlider.value = "0";
    setRangeFill(elements.seekSlider);
    elements.spotifyLink.hidden = true;
    elements.playButton.disabled = true;
    elements.previousButton.disabled = true;
    elements.nextButton.disabled = true;
    elements.seekSlider.disabled = true;
    elements.matchCredit.hidden = true;
    elements.storyEyebrow.textContent = "READY WHEN YOU ARE";
    elements.storyTitle.innerHTML = "Every song<br>has a <em>story.</em>";
    elements.storyCopy.textContent = "Start playing on Spotify and we'll find its anime opening.";
    matchTrack(null);
    renderClock();
    return;
  }
  elements.trackName.textContent = track.name || "Unknown track";
  elements.trackArtist.textContent = (track.artists || []).map(artist => artist.name).join(", ") || track.album?.name || "Spotify";
  const cover = track.album?.images?.[0]?.url;
  elements.trackCover.hidden = !cover;
  elements.coverPlaceholder.hidden = Boolean(cover);
  if (cover) elements.trackCover.src = cover;
  elements.spotifyLink.hidden = !track.external_urls?.spotify;
  if (track.external_urls?.spotify) elements.spotifyLink.href = track.external_urls.spotify;
  elements.playButton.disabled = false;
  elements.previousButton.disabled = false;
  elements.nextButton.disabled = false;
  elements.seekSlider.disabled = !track.duration_ms;
  if (trackId !== previousId) matchTrack(track);
  renderClock();
}

function updatePlayback(data) {
  if (!data) {
    markFirstVisualReady();
    return;
  }
  if (!data.item || data.currently_playing_type !== "track") {
    markFirstVisualReady();
    if (data.device) setPlaybackDevice(data.device.name, true);
    return;
  }
  const nextTrackId = data.item.id || data.item.uri || "";
  const previousTrackId = currentTrack?.id || currentTrack?.uri || "";
  if (nextTrackId && nextTrackId === commandTrackId && Date.now() - lastPlaybackCommandAt < 4000
      && typeof commandedPlaybackState === "boolean" && data.is_playing !== commandedPlaybackState) {
    data = {
      ...data,
      is_playing: commandedPlaybackState,
      progress_ms: commandedPlaybackState
        ? Math.max(data.progress_ms || 0, playbackPosition())
        : playbackPosition()
    };
  } else if (nextTrackId && nextTrackId === previousTrackId && data.is_playing && playback?.is_playing) {
    data = { ...data, progress_ms: Math.max(data.progress_ms || 0, playbackPosition()) };
  }
  playback = data;
  playbackUpdatedAt = Date.now();
  setTrack(data.item);
  setPlaybackDevice(data.device?.name, Boolean(data.device));
  elements.playButton.classList.toggle("is-playing", Boolean(data.is_playing));
  elements.playButton.setAttribute("aria-label", data.is_playing ? "Pause" : "Play");
  playOpeningVideo();
  renderClock();
  // When the song is due to end, switch straight to the next queued song (already prepared) instead of waiting
  // the second or so Spotify takes to report it; Spotify's reports then confirm or correct it. A few seconds
  // before, make sure the next song's video is still loaded and ready.
  clearTimeout(trackEndTimer);
  clearTimeout(trackEndingSoonTimer);
  if (data.is_playing && data.item.duration_ms) {
    const remaining = Math.max(0, data.item.duration_ms - (data.progress_ms || 0));
    trackEndingSoonTimer = setTimeout(() => {
      const next = upcomingQueue[0];
      if (next && isVisualKnown(next)) resolveVisual(next).then(visual => visual && preloadVideo(visual.videoUrl)).catch(() => {});
    }, Math.max(0, remaining - 5000));
    trackEndTimer = setTimeout(() => {
      const next = upcomingQueue[0];
      const repeatingSong = playback?.repeat_state === "track";
      if (next && !repeatingSong && trackKey(currentTrack) === nextTrackId && playback?.is_playing) {
        skippedFrom.set(nextTrackId, Date.now() + 4000);
        upcomingQueue.shift();
        updatePlayback({ ...playback, item: next, progress_ms: 0, is_playing: true });
      }
      burstPoll(nextTrackId);
    }, remaining + 100);
  }
}

// Polls quickly for a few seconds until Spotify reports a new song (not `fromId` or one we skipped past).
function burstPoll(fromId) {
  clearInterval(burstTimer);
  let attempts = 0;
  const tick = () => {
    const settled = reportedTrackId && reportedTrackId !== fromId && !skippedFrom.has(reportedTrackId);
    if (++attempts > 15 || settled) {
      clearInterval(burstTimer);
      return;
    }
    pollPlayback();
  };
  tick();
  burstTimer = setInterval(tick, 250);
}

function trackKey(track) {
  return track?.id || track?.uri || "";
}

async function skipTrack(direction) {
  const fromId = trackKey(currentTrack);
  if (direction === "next") {
    // For a few seconds Spotify may still report songs we've skipped past; don't jump back to them.
    if (fromId) skippedFrom.set(fromId, Date.now() + 4000);
    // We usually know the queue, so switch straight away, one queued song per press, without waiting for Spotify.
    while (upcomingQueue.length && trackKey(upcomingQueue[0]) === fromId) upcomingQueue.shift();
    const target = upcomingQueue.shift();
    if (target && playback) updatePlayback({ ...playback, item: target, progress_ms: 0, is_playing: true });
  } else {
    // Going back changes the queue in ways we can't predict, so wait for Spotify to say where we are.
    skippedFrom.clear();
    upcomingQueue = [];
  }
  skipsInFlight++;
  const succeeded = await playbackCommand(`/me/player/${direction}`);
  skipsInFlight--;
  if (!succeeded) skippedFrom.clear();
  burstPoll(fromId);
}

async function pollPlayback() {
  if (polling || playbackCommandPending || !refreshToken) return;
  polling = true;
  try {
    const data = await spotifyFetch("/me/player");
    reportedTrackId = data?.item?.id || data?.item?.uri || "";
    const now = Date.now();
    for (const [trackId, until] of skippedFrom) if (until < now) skippedFrom.delete(trackId);
    // While skips are still being sent, or when Spotify reports a song we skipped past, its answer is out of date.
    const staleSkip = skipsInFlight > 0 || skippedFrom.has(reportedTrackId);
    if (!playbackCommandPending && !staleSkip) {
      updatePlayback(data);
      setConnected(true);
    }
  } catch (error) {
    console.error("Spotify playback update failed:", error);
    markFirstVisualReady();
    if (/expired|reconnect/i.test(error.message)) {
      setConnected(false);
      notify(error.message);
    } else if (!/No active Spotify device/i.test(error.message)) {
      notify(error.message);
    }
  } finally {
    polling = false;
  }
}

function startPolling() {
  clearInterval(pollTimer);
  clearInterval(clockTimer);
  // Never leave the pill stuck on "Loading animation…" if the video host is slow.
  clearTimeout(firstVisualTimer);
  if (!firstVisualReady) firstVisualTimer = setTimeout(markFirstVisualReady, 8000);
  setConnected(true);
  pollPlayback();
  pollTimer = setInterval(pollPlayback, 1000);
  clockTimer = setInterval(renderClock, 250);
}

function disconnectSpotify() {
  accessToken = "";
  refreshToken = "";
  tokenExpiresAt = 0;
  sessionStorage.removeItem(TOKEN_KEY);
  clearInterval(pollTimer);
  clearInterval(clockTimer);
  clearInterval(burstTimer);
  clearTimeout(trackEndTimer);
  clearTimeout(trackEndingSoonTimer);
  playback = null;
  firstVisualReady = false;
  clearTimeout(firstVisualTimer);
  setConnected(false);
  setPlaybackDevice("", false);
  setTrack(null);
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(length = 64) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

async function connectSpotify() {
  clientId = elements.clientIdInput.value.trim();
  if (!clientId) {
    openDialog(elements.settingsDialog, elements.connectButton);
    elements.clientIdInput.focus();
    notify("Add your Spotify client ID to connect.");
    return;
  }
  localStorage.setItem(CLIENT_ID_KEY, clientId);
  const verifier = randomString();
  const state = randomString(24);
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);
  const challenge = await sha256(verifier);
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPES,
    code_challenge_method: "S256",
    code_challenge: challenge,
    state
  });
  location.assign(`${SPOTIFY_AUTHORIZE}?${params}`);
}

async function handleCallback() {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  if (!code) {
    if (params.get("error")) {
      history.replaceState({}, "", redirectUri);
      notify("Spotify sign-in was cancelled.");
    }
    return;
  }
  const state = params.get("state");
  const savedState = sessionStorage.getItem(STATE_KEY);
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  history.replaceState({}, "", redirectUri);
  sessionStorage.removeItem(STATE_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  if (!state || state !== savedState || !verifier || !clientId) {
    notify("Spotify sign-in could not be verified. Please try connecting again.");
    return;
  }
  try {
    const response = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier
      })
    });
    const data = await readJsonResponse(response, "Spotify sign-in");
    if (!data) throw new Error("Spotify did not return a valid sign-in response.");
    if (!response.ok) throw new Error(data.error_description || "Spotify could not complete sign-in.");
    accessToken = data.access_token;
    tokenExpiresAt = Date.now() + data.expires_in * 1000;
    refreshToken = data.refresh_token || "";
    if (!refreshToken) throw new Error("Spotify did not return a refresh token. Please try connecting again.");
    sessionStorage.setItem(TOKEN_KEY, refreshToken);
    startPolling();
  } catch (error) {
    console.error("Spotify sign-in failed:", error);
    notify(error.message);
  }
}

async function playbackCommand(path, method = "POST", body) {
  try {
    await spotifyFetch(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
    setTimeout(pollPlayback, 700);
    return true;
  } catch (error) {
    console.error("Spotify playback control failed:", error);
    notify(error.message);
    return false;
  }
}

elements.connectButton.addEventListener("click", () => {
  if (refreshToken) {
    disconnectSpotify();
    notify("Spotify disconnected.");
  } else {
    connectSpotify().catch(error => {
      console.error("Spotify connection failed:", error);
      notify(error.message);
    });
  }
});

// Opens a menu so it grows out of the button that was pressed (and later shrinks back into it); see styles.css.
function openDialog(dialog, trigger) {
  dialog.showModal();
  if (!trigger) {
    dialog.style.removeProperty("--origin-x");
    dialog.style.removeProperty("--origin-y");
    return;
  }
  const button = trigger.getBoundingClientRect();
  const left = (innerWidth - dialog.offsetWidth) / 2;
  const top = (innerHeight - dialog.offsetHeight) / 2;
  dialog.style.setProperty("--origin-x", `${button.left + button.width / 2 - left}px`);
  dialog.style.setProperty("--origin-y", `${button.top + button.height / 2 - top}px`);
}

// Clicking the dimmed area outside a box closes it. A press that starts inside the
// box (e.g. selecting text in the client ID field) and ends outside doesn't count.
for (const dialog of [elements.settingsDialog, elements.helpDialog, elements.appsDialog, elements.timerDoneDialog]) {
  let pressedOutside = false;
  const isOutside = event => {
    const box = dialog.getBoundingClientRect();
    return event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom);
  };
  dialog.addEventListener("pointerdown", event => { pressedOutside = isOutside(event); });
  dialog.addEventListener("click", event => {
    if (pressedOutside && isOutside(event)) dialog.close();
    pressedOutside = false;
  });
}

elements.settingsButton.addEventListener("click", () => openDialog(elements.settingsDialog, elements.settingsButton));
elements.appsButton.addEventListener("click", () => openDialog(elements.appsDialog, elements.appsButton));
elements.timerPill.addEventListener("click", () => openDialog(elements.appsDialog, elements.timerPill));

// Timer app: counts down from a custom time, shows what's left in the top bar and chimes when it's up.
// While running only the end time is kept (so it stays accurate if the tab is throttled); while paused, the time left.
let timerEndsAt = 0;
let timerPausedLeft = 0;
let timerDuration = 0;
let timerTick = null;

const timerLeft = () => timerEndsAt ? Math.max(0, timerEndsAt - Date.now()) : timerPausedLeft;

function formatCountdown(ms) {
  const total = Math.ceil(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const seconds = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

function renderTimer() {
  const left = timerLeft();
  if (timerEndsAt && !left) return finishTimer();
  const active = Boolean(timerEndsAt || timerPausedLeft);
  const paused = !timerEndsAt && active;
  elements.timerPill.hidden = !active;
  elements.timerPill.textContent = `⏱ ${formatCountdown(left)}`;
  elements.timerPill.classList.toggle("paused", paused);
  elements.timerReadout.textContent = formatCountdown(left);
  elements.timerReadout.classList.toggle("paused", paused);
  elements.timerReadout.hidden = !active;
  elements.timerFields.hidden = active;
  elements.timerPresets.hidden = active;
  elements.timerReset.hidden = !active;
  elements.timerStart.textContent = timerEndsAt ? "Pause" : paused ? "Resume" : "Start";
}

function startTimer(ms) {
  if (!ms) return notify("Set a time for the timer first.");
  if (!timerPausedLeft) timerDuration = ms;
  timerEndsAt = Date.now() + ms;
  timerPausedLeft = 0;
  clearInterval(timerTick);
  timerTick = setInterval(renderTimer, 250);
  renderTimer();
}

function stopTimer() {
  clearInterval(timerTick);
  timerEndsAt = 0;
  timerPausedLeft = 0;
  renderTimer();
}

function finishTimer() {
  stopTimer();
  playChime();
  elements.timerDoneNote.textContent = `Your ${formatCountdown(timerDuration)} timer has finished.`;
  elements.appsDialog.close();
  if (!elements.timerDoneDialog.open) openDialog(elements.timerDoneDialog);
}

elements.timerRestart.addEventListener("click", () => {
  elements.timerDoneDialog.close();
  startTimer(timerDuration);
});

// Three soft rising notes (the video is muted and Spotify plays elsewhere, so this is the only sound the page makes),
// repeated until the "Time's up" box is dismissed in any way.
let chimeAudio = null;
let chimeRepeat = null;

function playChime() {
  stopChime();
  try {
    const audio = chimeAudio = new AudioContext();
    const ring = () => [880, 1175, 1568].forEach((frequency, index) => {
      const start = audio.currentTime + index * .32;
      const tone = audio.createOscillator();
      const gain = audio.createGain();
      tone.frequency.value = frequency;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(.25, start + .02);
      gain.gain.exponentialRampToValueAtTime(.001, start + 1.2);
      tone.connect(gain).connect(audio.destination);
      tone.start(start);
      tone.stop(start + 1.2);
    });
    ring();
    chimeRepeat = setInterval(ring, 2200);
  } catch (error) {
    console.error("Could not play the timer chime:", error);
  }
}

function stopChime() {
  clearInterval(chimeRepeat);
  chimeAudio?.close();
  chimeAudio = null;
}

elements.timerDoneDialog.addEventListener("close", stopChime);

elements.timerStart.addEventListener("click", () => {
  if (timerEndsAt) {
    timerPausedLeft = timerLeft();
    timerEndsAt = 0;
    clearInterval(timerTick);
    return renderTimer();
  }
  if (timerPausedLeft) return startTimer(timerPausedLeft);
  const field = input => Math.max(0, Math.floor(Number(input.value) || 0));
  startTimer(((field(elements.timerHours) * 60 + field(elements.timerMinutes)) * 60 + field(elements.timerSeconds)) * 1000);
});
elements.timerReset.addEventListener("click", stopTimer);
elements.timerPresets.addEventListener("click", event => {
  const minutes = Number(event.target.closest("[data-minutes]")?.dataset.minutes);
  if (!minutes) return;
  elements.timerHours.value = Math.floor(minutes / 60) || "";
  elements.timerMinutes.value = minutes % 60 || "";
  elements.timerSeconds.value = "";
  startTimer(minutes * 60000);
});
elements.timerFields.addEventListener("keydown", event => {
  if (event.key === "Enter") elements.timerStart.click();
});
elements.wordmark.addEventListener("click", event => {
  event.preventDefault();
  openDialog(elements.helpDialog, elements.wordmark);
});
elements.saveAndConnect.addEventListener("click", event => {
  event.preventDefault();
  elements.settingsDialog.close();
  connectSpotify().catch(error => {
    console.error("Spotify connection failed:", error);
    notify(error.message);
  });
});

elements.copyRedirect.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(redirectUri);
    elements.copyRedirect.textContent = "Copied";
    setTimeout(() => { elements.copyRedirect.textContent = "Copy"; }, 1500);
  } catch (error) {
    console.error("Could not copy redirect URI:", error);
    notify("Copy isn't available here. Select and copy the redirect address.");
  }
});

elements.playButton.addEventListener("click", () => {
  if (!playback || playbackCommandPending) return;
  const wasPlaying = playback.is_playing;
  playback.progress_ms = playbackPosition();
  playback.is_playing = !wasPlaying;
  playbackUpdatedAt = Date.now();
  playbackCommandPending = true;
  lastPlaybackCommandAt = playbackUpdatedAt;
  commandedPlaybackState = playback.is_playing;
  commandTrackId = currentTrack?.id || currentTrack?.uri || "";
  elements.playButton.classList.toggle("is-playing", playback.is_playing);
  elements.playButton.setAttribute("aria-label", playback.is_playing ? "Pause" : "Play");
  playOpeningVideo();
  playbackCommand(`/me/player/${wasPlaying ? "pause" : "play"}`, "PUT")
    .then(succeeded => {
      if (!succeeded && playback) {
        playback.is_playing = wasPlaying;
        playbackUpdatedAt = Date.now();
        commandedPlaybackState = null;
        elements.playButton.classList.toggle("is-playing", wasPlaying);
        elements.playButton.setAttribute("aria-label", wasPlaying ? "Pause" : "Play");
        playOpeningVideo();
      }
    })
    .finally(() => { playbackCommandPending = false; });
});
// Space toggles play/pause from anywhere on the page (except while typing or in the settings dialog).
document.addEventListener("keydown", event => {
  if (event.code !== "Space" || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.target.closest?.("input:not([type=range]), textarea, select, [contenteditable], dialog")) return;
  // Also stops Space from "clicking" whichever button was last focused.
  event.preventDefault();
  if (!elements.playButton.disabled) elements.playButton.click();
});

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(error => console.error("Could not enter full screen:", error));
}

elements.fullscreenButton.addEventListener("click", toggleFullscreen);
document.addEventListener("keydown", event => {
  if (event.code !== "KeyF" || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.target.closest?.("input:not([type=range]), textarea, select, [contenteditable], dialog")) return;
  toggleFullscreen();
});

elements.previousButton.addEventListener("click", () => skipTrack("previous"));
elements.nextButton.addEventListener("click", () => skipTrack("next"));

elements.seekSlider.addEventListener("input", () => {
  setRangeFill(elements.seekSlider);
  const duration = currentTrack?.duration_ms || 0;
  if (duration) elements.elapsedTime.textContent = formatTime(Number(elements.seekSlider.value) / 1000 * duration);
});

elements.seekSlider.addEventListener("change", () => {
  const duration = currentTrack?.duration_ms || 0;
  if (duration) {
    const position = Math.round(Number(elements.seekSlider.value) / 1000 * duration);
    if (playback) {
      playback.progress_ms = position;
      playbackUpdatedAt = Date.now();
      renderClock();
    }
    playbackCommand(`/me/player/seek?position_ms=${position}`, "PUT");
  }
});

elements.brightnessSlider.addEventListener("input", updateDimness);

async function initialise() {
  updateDimness();
  setRangeFill(elements.seekSlider);
  await handleCallback();
  if (!refreshToken) {
    setConnected(false);
    setPlaybackDevice("", false);
  } else {
    startPolling();
  }
}

initialise().catch(error => {
  console.error("App initialization failed:", error);
  notify(error.message);
});
