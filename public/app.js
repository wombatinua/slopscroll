(() => {
  const state = {
    items: [],
    nextCursor: null,
    loadingFeed: false,
    authValid: false,
    activeIndex: -1,
    prefetchDepth: 3,
    prefetchSent: new Set(),
    failedVideoIds: new Set(),
    statsIntervalId: null,
    statsRequestInFlight: false,
    fullscreenActive: false,
    pseudoFullscreenActive: false,
    settingsPanelOpen: false,
    isIosLike: false,
    autoAdvanceEnabled: false,
    autoAdvanceSeconds: 5,
    autoAdvanceTimerId: null,
    autoAdvanceTransitionInFlight: false,
    audioEnabled: false,
    audioMinSwitchSec: 15,
    audioMaxSwitchSec: 45,
    audioCrossfadeSec: 2,
    audioSwitchOnFeedAdvance: false,
    audioLibrary: [],
    audioCurrentTrack: null,
    audioTimerId: null,
    audioPlayers: null,
    audioActivePlayerIndex: -1,
    audioFadeTimerId: null,
    audioFadeResolver: null,
    audioSwitchInFlight: false,
    audioAutoplayBlocked: false,
    selectedAuthor: null,
    selectedAuthorTotal: null,
    selectedAuthorTotalLoading: false,
    selectedAuthorTotalComplete: true
  };

  const refs = {
    feed: document.getElementById("feed"),
    toast: document.getElementById("toast"),
    overlayAuth: document.getElementById("overlay-auth"),
    authState: document.getElementById("auth-state"),
    cookieInput: document.getElementById("cookie-input"),
    prefetchDepth: document.getElementById("prefetch-depth"),
    audioEnabled: document.getElementById("audio-enabled"),
    audioMinSwitchSec: document.getElementById("audio-min-switch-sec"),
    audioMaxSwitchSec: document.getElementById("audio-max-switch-sec"),
    audioCrossfadeSec: document.getElementById("audio-crossfade-sec"),
    audioSwitchOnFeedAdvance: document.getElementById("audio-switch-on-advance"),
    audioLibraryStatus: document.getElementById("audio-library-status"),
    btnRefreshAudioLibrary: document.getElementById("btn-refresh-audio-library"),
    btnToggleAudio: document.getElementById("btn-toggle-audio"),
    autoAdvanceEnabled: document.getElementById("auto-advance-enabled"),
    autoAdvanceSeconds: document.getElementById("auto-advance-seconds"),
    btnToggleAutoAdvance: document.getElementById("btn-toggle-autoadvance"),
    btnFlushCache: document.getElementById("btn-flush-cache"),
    diskWarn: document.getElementById("disk-warn"),
    stats: document.getElementById("stats-output"),
    tpl: document.getElementById("video-card-template"),
    navVideos: document.getElementById("nav-videos"),
    navAuthor: document.getElementById("nav-author"),
    navSeparator: document.getElementById("nav-separator"),
    btnToggleFullscreen: document.getElementById("btn-toggle-fullscreen"),
    btnToggleSettings: document.getElementById("btn-toggle-settings"),
    btnCloseSettings: document.getElementById("btn-close-settings"),
    settingsPanel: document.getElementById("settings-panel"),
    settingsBackdrop: document.getElementById("settings-backdrop"),
    autoAdvanceOverlay: document.getElementById("auto-advance-overlay"),
    autoAdvanceFrom: document.getElementById("auto-advance-from"),
    autoAdvanceTo: document.getElementById("auto-advance-to")
  };

  const observer = new IntersectionObserver(onIntersect, {
    threshold: [0.65]
  });

  async function api(path, options) {
    const method = (options?.method || "GET").toUpperCase();
    const headers = method === "GET" ? {} : { "Content-Type": "application/json" };
    const res = await fetch(path, {
      headers,
      cache: "no-store",
      ...options
    });

    const text = await res.text();
    const data = text ? JSON.parse(text) : {};

    if (!res.ok) {
      const msg = data?.error || data?.auth?.failureReason || `${res.status} ${res.statusText}`;
      throw new Error(msg);
    }

    return data;
  }

  function showToast(message, isError = false) {
    refs.toast.textContent = message;
    refs.toast.classList.remove("hidden");
    refs.toast.style.borderColor = isError ? "rgba(255, 162, 136, 0.5)" : "rgba(126, 224, 187, 0.5)";
    refs.toast.style.background = isError ? "rgba(35, 14, 14, 0.9)" : "rgba(8, 25, 24, 0.9)";
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => refs.toast.classList.add("hidden"), 2200);
  }

  function setAuthPill(isValid, reason) {
    refs.authState.textContent = isValid ? "valid" : `invalid${reason ? `: ${reason}` : ""}`;
    refs.authState.classList.toggle("ok", isValid);
    refs.authState.classList.toggle("bad", !isValid);
    refs.overlayAuth.classList.toggle("hidden", isValid);
    state.authValid = isValid;

    if (!isValid) {
      stopAutoAdvanceTimer();
    } else {
      scheduleAutoAdvance();
    }
  }

  function formatInt(value) {
    const num = Number(value) || 0;
    return new Intl.NumberFormat().format(Math.max(0, num));
  }

  function formatPercent(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) {
      return "0%";
    }
    return `${(Math.max(0, num) * 100).toFixed(1)}%`;
  }

  function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return "0 B";
    }
    const units = ["B", "KB", "MB", "GB", "TB"];
    let v = bytes;
    let idx = 0;
    while (v >= 1024 && idx < units.length - 1) {
      v /= 1024;
      idx += 1;
    }
    const precision = idx === 0 ? 0 : v >= 100 ? 0 : v >= 10 ? 1 : 2;
    return `${v.toFixed(precision)} ${units[idx]}`;
  }

  function buildStatsCard(label, value, note) {
    const card = document.createElement("div");
    card.className = "stats-card";

    const labelNode = document.createElement("div");
    labelNode.className = "stats-label";
    labelNode.textContent = label;
    card.appendChild(labelNode);

    const valueNode = document.createElement("div");
    valueNode.className = "stats-value";
    valueNode.textContent = value;
    card.appendChild(valueNode);

    if (note) {
      const noteNode = document.createElement("div");
      noteNode.className = "stats-note";
      noteNode.textContent = note;
      card.appendChild(noteNode);
    }

    return card;
  }

  function renderStats(statsResponse) {
    refs.stats.innerHTML = "";

    if (!statsResponse || statsResponse.ok !== true) {
      const failed = document.createElement("div");
      failed.className = "stats-error";
      failed.textContent = "Failed to load cache stats";
      refs.stats.appendChild(failed);
      return;
    }

    const stats = statsResponse.stats ?? {};
    const disk = statsResponse.disk ?? {};
    const updatedAt = new Date().toLocaleTimeString();

    const grid = document.createElement("div");
    grid.className = "stats-grid";
    grid.appendChild(buildStatsCard("Videos Ready", formatInt(stats.readyVideos), `of ${formatInt(stats.totalVideos)}`));
    grid.appendChild(buildStatsCard("Downloading", formatInt(stats.downloadingVideos), `${formatInt(stats.failedVideos)} failed`));
    grid.appendChild(buildStatsCard("Cache Size", formatBytes(stats.totalBytes), `${formatInt(stats.cacheHits)} hits`));
    grid.appendChild(buildStatsCard("Hit Rate", formatPercent(stats.hitRate), `${formatInt(stats.cacheMisses)} misses`));
    grid.appendChild(buildStatsCard("Download Failures", formatInt(stats.downloadFailures), null));
    grid.appendChild(buildStatsCard("Free Disk", formatBytes(disk.freeBytes), disk.lowDisk ? "Low disk warning" : "Disk OK"));
    refs.stats.appendChild(grid);

    const meta = document.createElement("div");
    meta.className = "stats-meta";

    const rows = [
      ["Cache Directory", statsResponse.cacheDir || "-"],
      ["Spec Loaded", statsResponse.specConfigured ? "Yes" : "No"],
      ["Updated", updatedAt]
    ];

    for (const [label, value] of rows) {
      const row = document.createElement("div");
      row.className = "stats-meta-row";
      const left = document.createElement("span");
      left.textContent = label;
      const right = document.createElement("span");
      right.textContent = value;
      row.appendChild(left);
      row.appendChild(right);
      meta.appendChild(row);
    }

    refs.stats.appendChild(meta);
  }

  async function checkAuth() {
    try {
      const status = await api("/api/auth/status");
      setAuthPill(status.isValid, status.failureReason);
      return status.isValid;
    } catch (err) {
      setAuthPill(false, err.message);
      return false;
    }
  }

  async function saveCookies() {
    const cookies = refs.cookieInput.value.trim();
    if (!cookies) {
      showToast("Paste cookies first", true);
      return;
    }

    try {
      const result = await api("/api/auth/cookies", {
        method: "POST",
        body: JSON.stringify({ cookies })
      });
      setAuthPill(result.auth.isValid, result.auth.failureReason);
      if (result.auth.isValid) {
        showToast("Cookies saved and validated");
      } else {
        showToast(`Cookies saved, validation failed: ${result.auth.failureReason || "unknown reason"}`, true);
      }

      if (result.auth.isValid && state.items.length === 0) {
        await loadMore();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setAuthPill(false, message);
      showToast(`Cookie error: ${message}`, true);
    }
  }

  function renderItem(item, index) {
    const node = refs.tpl.content.firstElementChild.cloneNode(true);
    node.dataset.videoId = item.id;
    node.dataset.idx = String(index);

    const video = node.querySelector("video");
    video.src = `/api/video/${encodeURIComponent(item.id)}`;
    video.loop = true;
    video.muted = true;

    const main = node.querySelector(".meta-main");
    const sub = node.querySelector(".meta-sub");
    main.innerHTML = "";
    if (item.author) {
      const authorBtn = document.createElement("button");
      authorBtn.type = "button";
      authorBtn.className = "author-link";
      authorBtn.textContent = `@${item.author}`;
      authorBtn.title = `Show only @${item.author}`;
      authorBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void switchToAuthor(item.author);
      });
      main.appendChild(authorBtn);
    } else {
      main.textContent = `Video ${item.id.slice(0, 8)}`;
    }
    sub.textContent = item.pageUrl || item.mediaUrl;

    video.addEventListener("error", () => {
      const err = node.querySelector(".error");
      err.classList.remove("hidden");
      err.textContent = "Playback failed. Check auth and source URL.";
      if (state.failedVideoIds.has(item.id)) {
        return;
      }
      state.failedVideoIds.add(item.id);
      const idx = Number.parseInt(node.dataset.idx || "-1", 10);
      if (idx === state.activeIndex) {
        void skipBrokenActiveVideo(idx, item.id);
      }
    });

    refs.feed.appendChild(node);
    observer.observe(node);
  }

  async function loadMore() {
    if (!state.authValid || state.loadingFeed) {
      return;
    }

    state.loadingFeed = true;
    try {
      const cursorQuery = state.nextCursor ? `&cursor=${encodeURIComponent(state.nextCursor)}` : "";
      const authorQuery = state.selectedAuthor ? `&author=${encodeURIComponent(state.selectedAuthor)}` : "";
      const result = await api(`/api/feed/next?limit=8${cursorQuery}${authorQuery}`);
      const start = state.items.length;
      state.items.push(...result.items);

      result.items.forEach((item, idx) => {
        renderItem(item, start + idx);
      });

      state.nextCursor = result.nextCursor;
      if (result.items.length === 0) {
        if (state.selectedAuthor) {
          showToast(`No additional videos for @${state.selectedAuthor}`);
        } else {
          showToast("No additional feed items");
        }
      }
    } catch (err) {
      const msg = err.message || "Feed load failed";
      const authLike = /auth|cookie|unauthorized/i.test(msg);
      if (authLike) {
        setAuthPill(false, "cookies expired or invalid");
      }
      showToast(msg, true);
    } finally {
      state.loadingFeed = false;
    }
  }

  async function loadSettings() {
    try {
      const result = await api("/api/settings");
      state.prefetchDepth = result.settings.prefetchDepth;
      state.audioEnabled = Boolean(result.settings.audioEnabled);
      state.audioMinSwitchSec = normalizeAudioSwitchSec(result.settings.audioMinSwitchSec, 15);
      state.audioMaxSwitchSec = normalizeAudioSwitchSec(result.settings.audioMaxSwitchSec, 45);
      state.audioCrossfadeSec = normalizeAudioCrossfadeSec(result.settings.audioCrossfadeSec, 2);
      if (state.audioMaxSwitchSec < state.audioMinSwitchSec) {
        const tmp = state.audioMinSwitchSec;
        state.audioMinSwitchSec = state.audioMaxSwitchSec;
        state.audioMaxSwitchSec = tmp;
      }
      state.audioSwitchOnFeedAdvance = Boolean(result.settings.audioSwitchOnFeedAdvance);
      refs.prefetchDepth.value = String(result.settings.prefetchDepth);
      refs.diskWarn.value = String(result.settings.lowDiskWarnGb);
      refs.audioMinSwitchSec.value = String(state.audioMinSwitchSec);
      refs.audioMaxSwitchSec.value = String(state.audioMaxSwitchSec);
      refs.audioCrossfadeSec.value = String(state.audioCrossfadeSec);
      refs.audioSwitchOnFeedAdvance.checked = state.audioSwitchOnFeedAdvance;
      syncAudioControls();
    } catch (err) {
      showToast(`Settings load failed: ${err.message}`, true);
    }
  }

  async function saveSettings() {
    const prefetchDepth = Number.parseInt(refs.prefetchDepth.value, 10);
    const lowDiskWarnGb = Number.parseFloat(refs.diskWarn.value);
    const audioMinSwitchSec = normalizeAudioSwitchSec(refs.audioMinSwitchSec.value, state.audioMinSwitchSec);
    const audioMaxSwitchSec = normalizeAudioSwitchSec(refs.audioMaxSwitchSec.value, state.audioMaxSwitchSec);
    const audioCrossfadeSec = normalizeAudioCrossfadeSec(refs.audioCrossfadeSec.value, state.audioCrossfadeSec);
    const normalizedAudioMin = Math.min(audioMinSwitchSec, audioMaxSwitchSec);
    const normalizedAudioMax = Math.max(audioMinSwitchSec, audioMaxSwitchSec);
    const audioEnabled = refs.audioEnabled.checked;
    const audioSwitchOnFeedAdvance = refs.audioSwitchOnFeedAdvance.checked;

    try {
      const result = await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          prefetchDepth,
          lowDiskWarnGb,
          audioEnabled,
          audioMinSwitchSec: normalizedAudioMin,
          audioMaxSwitchSec: normalizedAudioMax,
          audioCrossfadeSec,
          audioSwitchOnFeedAdvance
        })
      });

      state.prefetchDepth = result.settings.prefetchDepth;
      state.audioEnabled = Boolean(result.settings.audioEnabled);
      state.audioMinSwitchSec = normalizeAudioSwitchSec(result.settings.audioMinSwitchSec, normalizedAudioMin);
      state.audioMaxSwitchSec = normalizeAudioSwitchSec(result.settings.audioMaxSwitchSec, normalizedAudioMax);
      state.audioCrossfadeSec = normalizeAudioCrossfadeSec(result.settings.audioCrossfadeSec, audioCrossfadeSec);
      state.audioSwitchOnFeedAdvance = Boolean(result.settings.audioSwitchOnFeedAdvance);
      refs.prefetchDepth.value = String(result.settings.prefetchDepth);
      refs.audioMinSwitchSec.value = String(state.audioMinSwitchSec);
      refs.audioMaxSwitchSec.value = String(state.audioMaxSwitchSec);
      refs.audioCrossfadeSec.value = String(state.audioCrossfadeSec);
      refs.audioSwitchOnFeedAdvance.checked = state.audioSwitchOnFeedAdvance;
      syncAudioControls();
      if (state.audioEnabled) {
        void switchAudioTrack("settings-save", false);
      } else {
        stopAudioPlayback();
      }
      showToast("Settings saved");
    } catch (err) {
      showToast(`Settings error: ${err.message}`, true);
    }
  }

  async function refreshStats() {
    if (state.statsRequestInFlight) {
      return;
    }

    state.statsRequestInFlight = true;
    try {
      const result = await api(`/api/cache/stats?_ts=${Date.now()}`);
      renderStats(result);
    } catch (err) {
      refs.stats.innerHTML = "";
      const failed = document.createElement("div");
      failed.className = "stats-error";
      failed.textContent = `Failed: ${err.message}`;
      refs.stats.appendChild(failed);
    } finally {
      state.statsRequestInFlight = false;
    }
  }

  function startStatsAutoRefresh() {
    if (state.statsIntervalId) {
      clearInterval(state.statsIntervalId);
    }

    state.statsIntervalId = setInterval(() => void refreshStats(), 2000);
  }

  async function reloadSpec() {
    try {
      const result = await api("/api/spec/reload", { method: "POST" });
      if (!result.ok) {
        showToast("Request spec not found", true);
      } else {
        showToast("Request spec loaded");
      }
      await checkAuth();
    } catch (err) {
      showToast(`Spec reload error: ${err.message}`, true);
    }
  }

  async function prefetchFrom(index) {
    const start = index + 1;
    const end = start + state.prefetchDepth;
    const ids = state.items.slice(start, end).map((item) => item.id).filter((id) => !state.prefetchSent.has(id));

    if (ids.length === 0) {
      return;
    }

    ids.forEach((id) => state.prefetchSent.add(id));

    try {
      await api("/api/prefetch", {
        method: "POST",
        body: JSON.stringify({ videoIds: ids })
      });
    } catch (err) {
      showToast(`Prefetch error: ${err.message}`, true);
    }
  }

  function stopAutoAdvanceTimer() {
    if (state.autoAdvanceTimerId !== null) {
      clearTimeout(state.autoAdvanceTimerId);
      state.autoAdvanceTimerId = null;
    }
    if (state.autoAdvanceTransitionInFlight) {
      state.autoAdvanceTransitionInFlight = false;
      stopAutoAdvanceOverlay();
    }
  }

  function populateAutoAdvanceOptions() {
    refs.autoAdvanceSeconds.innerHTML = "";
    for (let sec = 1; sec <= 20; sec += 1) {
      const option = document.createElement("option");
      option.value = String(sec);
      option.textContent = `${sec} second${sec === 1 ? "" : "s"}`;
      option.selected = sec === 5;
      refs.autoAdvanceSeconds.appendChild(option);
    }
  }

  function normalizeAutoAdvanceSeconds(value) {
    const parsed = Number.parseInt(String(value), 10);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 20) {
      return parsed;
    }
    return 5;
  }

  function syncAutoAdvanceControls() {
    refs.autoAdvanceEnabled.checked = state.autoAdvanceEnabled;
    refs.autoAdvanceSeconds.value = String(state.autoAdvanceSeconds);
    refs.autoAdvanceSeconds.disabled = !state.autoAdvanceEnabled;
    refs.btnToggleAutoAdvance.classList.toggle("active", state.autoAdvanceEnabled);
    refs.btnToggleAutoAdvance.setAttribute("aria-pressed", state.autoAdvanceEnabled ? "true" : "false");
    refs.btnToggleAutoAdvance.title = state.autoAdvanceEnabled
      ? `Disable auto-advance (${state.autoAdvanceSeconds}s)`
      : "Enable auto-advance";
  }

  function normalizeAudioSwitchSec(value, fallback) {
    const parsed = Number.parseInt(String(value), 10);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 3600) {
      return parsed;
    }
    return fallback;
  }

  function normalizeAudioCrossfadeSec(value, fallback) {
    const parsed = Number.parseFloat(String(value));
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 30) {
      return Math.round(parsed * 10) / 10;
    }
    return fallback;
  }

  function syncAudioControls() {
    refs.audioEnabled.checked = state.audioEnabled;
    refs.audioMinSwitchSec.value = String(state.audioMinSwitchSec);
    refs.audioMaxSwitchSec.value = String(state.audioMaxSwitchSec);
    refs.audioCrossfadeSec.value = String(state.audioCrossfadeSec);
    refs.audioSwitchOnFeedAdvance.checked = state.audioSwitchOnFeedAdvance;
    refs.btnToggleAudio.classList.toggle("active", state.audioEnabled);
    refs.btnToggleAudio.setAttribute("aria-pressed", state.audioEnabled ? "true" : "false");
    refs.btnToggleAudio.title = state.audioEnabled ? "Disable background loops" : "Enable background loops";
  }

  function updateAudioLibraryStatus() {
    const count = state.audioLibrary.length;
    if (count === 0) {
      refs.audioLibraryStatus.textContent = "Audio library: no supported files in ./media";
      return;
    }
    const names = state.audioLibrary.slice(0, 3).map((item) => item.name);
    const suffix = count > 3 ? ` +${count - 3} more` : "";
    refs.audioLibraryStatus.textContent = `Audio library: ${count} file${count === 1 ? "" : "s"} (${names.join(", ")}${suffix})`;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getVideoApiUrl(videoId) {
    return `/api/video/${encodeURIComponent(videoId)}`;
  }

  function getCardByIndex(index) {
    return refs.feed.querySelector(`.video-card[data-idx="${index}"]`);
  }

  function jumpFeedToIndexNoAnimation(index) {
    const target = getCardByIndex(index);
    if (!target) {
      return false;
    }

    const previousBehavior = refs.feed.style.scrollBehavior;
    refs.feed.style.scrollBehavior = "auto";
    refs.feed.scrollTop = target.offsetTop;
    refs.feed.style.scrollBehavior = previousBehavior;
    return true;
  }

  async function refreshAudioLibrary(showResultToast = false) {
    try {
      const result = await api(`/api/audio/library?_ts=${Date.now()}`);
      state.audioLibrary = Array.isArray(result.files) ? result.files : [];
      updateAudioLibraryStatus();
      if (showResultToast) {
        showToast(`Audio library loaded (${state.audioLibrary.length})`);
      }
      return state.audioLibrary;
    } catch (err) {
      state.audioLibrary = [];
      updateAudioLibraryStatus();
      if (showResultToast) {
        showToast(`Audio library error: ${err.message}`, true);
      }
      return [];
    }
  }

  function ensureAudioPlayers() {
    if (state.audioPlayers) {
      return state.audioPlayers;
    }

    const createPlayer = () => {
      const audio = new Audio();
      audio.preload = "auto";
      audio.loop = true;
      audio.volume = 1;
      audio.addEventListener("error", () => {
        if (!state.audioEnabled) {
          return;
        }
        void switchAudioTrack("error", true);
      });
      return audio;
    };

    state.audioPlayers = [createPlayer(), createPlayer()];
    return state.audioPlayers;
  }

  function clearAudioSwitchTimer() {
    if (state.audioTimerId !== null) {
      clearTimeout(state.audioTimerId);
      state.audioTimerId = null;
    }
  }

  function clearAudioFadeTimer(resolvePending = false) {
    if (state.audioFadeTimerId !== null) {
      clearInterval(state.audioFadeTimerId);
      state.audioFadeTimerId = null;
    }
    if (resolvePending && typeof state.audioFadeResolver === "function") {
      const resolver = state.audioFadeResolver;
      state.audioFadeResolver = null;
      resolver();
    }
  }

  function stopAndResetAudioPlayer(audio) {
    audio.pause();
    audio.currentTime = 0;
    audio.volume = 1;
    audio.removeAttribute("src");
    audio.load();
  }

  async function crossfadePlayers(fromAudio, toAudio) {
    clearAudioFadeTimer(true);

    const crossfadeMs = Math.max(0, Math.round(state.audioCrossfadeSec * 1000));
    if (!fromAudio || crossfadeMs <= 0 || fromAudio.paused) {
      toAudio.volume = 1;
      if (fromAudio && fromAudio !== toAudio) {
        stopAndResetAudioPlayer(fromAudio);
      }
      return;
    }

    fromAudio.volume = Math.max(0, Math.min(1, Number(fromAudio.volume) || 1));
    toAudio.volume = Math.max(0, Math.min(1, Number(toAudio.volume) || 0));

    await new Promise((resolve) => {
      const startedAt = Date.now();
      const startFromVolume = fromAudio.volume;
      const startToVolume = toAudio.volume;
      state.audioFadeResolver = () => resolve();
      const step = () => {
        const elapsed = Date.now() - startedAt;
        const progress = Math.max(0, Math.min(1, elapsed / crossfadeMs));
        fromAudio.volume = Math.max(0, startFromVolume * (1 - progress));
        toAudio.volume = Math.min(1, startToVolume + (1 - startToVolume) * progress);

        if (progress >= 1) {
          state.audioFadeResolver = null;
          clearAudioFadeTimer(false);
          stopAndResetAudioPlayer(fromAudio);
          toAudio.volume = 1;
          resolve();
        }
      };

      step();
      state.audioFadeTimerId = setInterval(step, 40);
    });
  }

  function stopAudioPlayback() {
    clearAudioSwitchTimer();
    clearAudioFadeTimer(true);
    state.audioAutoplayBlocked = false;
    const players = ensureAudioPlayers();
    if (!players) {
      return;
    }
    for (const player of players) {
      stopAndResetAudioPlayer(player);
    }
    state.audioActivePlayerIndex = -1;
    state.audioCurrentTrack = null;
    state.audioSwitchInFlight = false;
  }

  function randomAudioSwitchMs() {
    const min = Math.max(1, Math.min(state.audioMinSwitchSec, state.audioMaxSwitchSec));
    const max = Math.max(min, Math.max(state.audioMinSwitchSec, state.audioMaxSwitchSec));
    const nextSec = Math.floor(Math.random() * (max - min + 1)) + min;
    return nextSec * 1000;
  }

  function scheduleAudioSwitch() {
    clearAudioSwitchTimer();
    if (!state.audioEnabled) {
      return;
    }

    state.audioTimerId = setTimeout(() => {
      void switchAudioTrack("timer", true);
    }, randomAudioSwitchMs());
  }

  function pickRandomTrack(preferDifferent) {
    const tracks = state.audioLibrary;
    if (tracks.length === 0) {
      return null;
    }

    const currentName = state.audioCurrentTrack?.name ?? null;
    if (preferDifferent && currentName && tracks.length > 1) {
      const pool = tracks.filter((track) => track.name !== currentName);
      if (pool.length > 0) {
        return pool[Math.floor(Math.random() * pool.length)];
      }
    }

    return tracks[Math.floor(Math.random() * tracks.length)];
  }

  async function switchAudioTrack(reason, preferDifferent) {
    if (!state.audioEnabled || state.audioSwitchInFlight) {
      return false;
    }

    state.audioSwitchInFlight = true;
    try {
      if (state.audioLibrary.length === 0) {
        await refreshAudioLibrary(false);
      }

      if (state.audioLibrary.length === 0) {
        showToast("No audio loops found in ./media", true);
        return false;
      }

      const players = ensureAudioPlayers();
      const currentIndex = state.audioActivePlayerIndex;
      const currentAudio = currentIndex >= 0 ? players[currentIndex] : null;
      const nextIndex = currentIndex >= 0 ? (currentIndex === 0 ? 1 : 0) : 0;
      const nextAudio = players[nextIndex];
      const attempts = Math.max(1, state.audioLibrary.length);
      const triedNames = new Set();
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const nextTrack = pickRandomTrack(preferDifferent);
        if (!nextTrack || triedNames.has(nextTrack.name)) {
          continue;
        }
        triedNames.add(nextTrack.name);

        const targetUrl = `${nextTrack.url}?_ts=${encodeURIComponent(nextTrack.updatedAt ?? "")}`;
        nextAudio.src = targetUrl;
        nextAudio.volume = currentAudio ? 0 : 1;
        try {
          await nextAudio.play();
          await crossfadePlayers(currentAudio, nextAudio);
          state.audioAutoplayBlocked = false;
          state.audioActivePlayerIndex = nextIndex;
          state.audioCurrentTrack = nextTrack;
          scheduleAudioSwitch();
          return true;
        } catch {
          // continue to another candidate
        }
      }

      state.audioAutoplayBlocked = true;
      if (reason === "button") {
        showToast("Unable to start audio playback. Check media files or browser audio permissions.", true);
      }
      return false;
    } finally {
      state.audioSwitchInFlight = false;
    }
  }

  async function setAudioEnabled(enabled, reason) {
    state.audioEnabled = Boolean(enabled);
    syncAudioControls();

    if (!state.audioEnabled) {
      stopAudioPlayback();
      return;
    }

    const started = await switchAudioTrack(reason, false);
    if (!started) {
      if (reason === "init") {
        showToast("Background audio is enabled. Tap the audio button to start playback.", true);
        return;
      }
      stopAudioPlayback();
      state.audioEnabled = false;
      syncAudioControls();
    }
  }

  function stopAutoAdvanceOverlay() {
    if (!refs.autoAdvanceOverlay || !refs.autoAdvanceFrom || !refs.autoAdvanceTo) {
      return;
    }

    refs.autoAdvanceOverlay.classList.remove("active");
    refs.autoAdvanceOverlay.classList.add("hidden");

    for (const video of [refs.autoAdvanceFrom, refs.autoAdvanceTo]) {
      video.pause();
      video.removeAttribute("src");
      video.load();
      video.style.opacity = "0";
    }
  }

  async function crossfadeAutoAdvanceTo(next) {
    const currentIndex = state.activeIndex;
    const currentItem = state.items[currentIndex];
    const nextItem = state.items[next];
    if (!currentItem || !nextItem || !refs.autoAdvanceOverlay || !refs.autoAdvanceFrom || !refs.autoAdvanceTo) {
      jumpFeedToIndexNoAnimation(next);
      return;
    }

    state.autoAdvanceTransitionInFlight = true;
    const from = refs.autoAdvanceFrom;
    const to = refs.autoAdvanceTo;

    try {
      from.src = getVideoApiUrl(currentItem.id);
      to.src = getVideoApiUrl(nextItem.id);
      from.style.opacity = "1";
      to.style.opacity = "0";
      refs.autoAdvanceOverlay.classList.remove("hidden");

      await Promise.all([from.play().catch(() => {}), to.play().catch(() => {})]);
      await sleep(20);
      jumpFeedToIndexNoAnimation(next);
      await sleep(20);

      refs.autoAdvanceOverlay.classList.add("active");
      from.style.opacity = "0";
      to.style.opacity = "1";
      await sleep(1000);
    } finally {
      state.autoAdvanceTransitionInFlight = false;
      stopAutoAdvanceOverlay();
    }
  }

  function scheduleAutoAdvance() {
    stopAutoAdvanceTimer();

    if (!state.autoAdvanceEnabled || !state.authValid || state.activeIndex < 0 || state.autoAdvanceTransitionInFlight) {
      return;
    }

    state.autoAdvanceTimerId = setTimeout(async () => {
      if (!state.autoAdvanceEnabled || !state.authValid || state.autoAdvanceTransitionInFlight) {
        return;
      }

      if (document.hidden) {
        scheduleAutoAdvance();
        return;
      }

      let next = state.activeIndex + 1;
      if (next >= state.items.length) {
        await loadMore();
        next = state.activeIndex + 1;
      }

      if (next < state.items.length) {
        await crossfadeAutoAdvanceTo(next);
      }

      scheduleAutoAdvance();
    }, state.autoAdvanceSeconds * 1000);
  }

  function setSettingsPanelOpen(open) {
    const next = Boolean(open);
    state.settingsPanelOpen = next;
    refs.settingsPanel.classList.toggle("open", next);
    refs.settingsPanel.setAttribute("aria-hidden", next ? "false" : "true");
    refs.settingsBackdrop.classList.toggle("hidden", !next);
    refs.btnToggleSettings.setAttribute("aria-expanded", next ? "true" : "false");
  }

  function toggleSettingsPanel() {
    setSettingsPanelOpen(!state.settingsPanelOpen);
  }

  function detectIosLike() {
    const ua = navigator.userAgent || "";
    const platform = navigator.platform || "";
    const maxTouchPoints = Number(navigator.maxTouchPoints || 0);
    const iosByUa = /iPhone|iPad|iPod/i.test(ua);
    const ipadDesktopMode = platform === "MacIntel" && maxTouchPoints > 1;
    return iosByUa || ipadDesktopMode;
  }

  function setFullscreenUi(active) {
    state.fullscreenActive = Boolean(active);
    document.body.classList.toggle("video-only-mode", state.fullscreenActive);
    refs.btnToggleFullscreen.classList.toggle("active", state.fullscreenActive);
    refs.btnToggleFullscreen.setAttribute("aria-pressed", state.fullscreenActive ? "true" : "false");
    const enterText = state.isIosLike ? "Enter focus mode" : "Enter fullscreen";
    const exitText = state.isIosLike ? "Exit focus mode" : "Exit fullscreen";
    refs.btnToggleFullscreen.title = state.fullscreenActive ? exitText : enterText;
    refs.btnToggleFullscreen.setAttribute("aria-label", refs.btnToggleFullscreen.title);

    if (state.fullscreenActive) {
      setSettingsPanelOpen(false);
    }
  }

  async function enterFullscreen() {
    if (!document.documentElement.requestFullscreen) {
      throw new Error("Fullscreen is not supported in this browser");
    }

    try {
      await document.documentElement.requestFullscreen({ navigationUI: "hide" });
    } catch {
      await document.documentElement.requestFullscreen();
    }
  }

  async function exitFullscreen() {
    if (document.fullscreenElement && document.exitFullscreen) {
      await document.exitFullscreen();
    }
  }

  async function toggleFullscreen() {
    if (state.isIosLike) {
      state.pseudoFullscreenActive = !state.pseudoFullscreenActive;
      setFullscreenUi(state.pseudoFullscreenActive);
      return;
    }

    if (state.pseudoFullscreenActive) {
      state.pseudoFullscreenActive = false;
      setFullscreenUi(Boolean(document.fullscreenElement));
      return;
    }

    try {
      if (document.fullscreenElement) {
        await exitFullscreen();
      } else {
        await enterFullscreen();
      }
    } catch (err) {
      state.pseudoFullscreenActive = true;
      setFullscreenUi(true);
    }
  }

  function updateFeedModeUi() {
    if (state.selectedAuthor) {
      const current = state.activeIndex >= 0 ? state.activeIndex + 1 : 0;
      const total = Number.isInteger(state.selectedAuthorTotal)
        ? state.selectedAuthorTotalComplete
          ? String(state.selectedAuthorTotal)
          : `${state.selectedAuthorTotal}+`
        : "...";
      refs.navVideos.classList.remove("active");
      refs.navVideos.removeAttribute("aria-current");
      refs.navSeparator.classList.remove("hidden");
      refs.navAuthor.classList.remove("hidden");
      refs.navAuthor.classList.add("active");
      refs.navAuthor.setAttribute("aria-current", "page");
      refs.navAuthor.textContent = `@${state.selectedAuthor} ${current}/${total}`;
      return;
    }

    refs.navVideos.classList.add("active");
    refs.navVideos.setAttribute("aria-current", "page");
    refs.navSeparator.classList.add("hidden");
    refs.navAuthor.classList.add("hidden");
    refs.navAuthor.classList.remove("active");
    refs.navAuthor.removeAttribute("aria-current");
  }

  async function refreshAuthorTotal(authorRaw) {
    const author = (authorRaw || "").trim();
    if (!author) {
      return;
    }

    state.selectedAuthorTotal = null;
    state.selectedAuthorTotalLoading = true;
    state.selectedAuthorTotalComplete = true;
    updateFeedModeUi();

    try {
      const result = await api(`/api/feed/author-stats?author=${encodeURIComponent(author)}`);
      if (state.selectedAuthor !== author) {
        return;
      }
      state.selectedAuthorTotal = Number.isInteger(result.totalVideos) ? result.totalVideos : null;
      state.selectedAuthorTotalComplete = result.complete !== false;
    } catch {
      if (state.selectedAuthor !== author) {
        return;
      }
      state.selectedAuthorTotal = null;
      state.selectedAuthorTotalComplete = true;
    } finally {
      if (state.selectedAuthor === author) {
        state.selectedAuthorTotalLoading = false;
        updateFeedModeUi();
      }
    }
  }

  async function resetFeedAndLoad() {
    stopAutoAdvanceTimer();
    observer.disconnect();
    refs.feed.innerHTML = "";
    state.items = [];
    state.nextCursor = null;
    state.loadingFeed = false;
    state.activeIndex = -1;
    state.prefetchSent.clear();
    state.failedVideoIds.clear();

    await loadMore();
    if (state.items.length > 0) {
      await setActiveIndex(0);
    }
  }

  async function switchToAuthor(authorRaw) {
    const author = (authorRaw || "").trim();
    if (!author || author === state.selectedAuthor) {
      return;
    }

    state.selectedAuthor = author;
    state.selectedAuthorTotal = null;
    state.selectedAuthorTotalLoading = true;
    state.selectedAuthorTotalComplete = true;
    updateFeedModeUi();
    void refreshAuthorTotal(author);
    await resetFeedAndLoad();
    if (state.items.length === 0) {
      showToast(`No videos found for @${author}`, true);
    } else {
      showToast(`Switched to @${author}`);
    }
  }

  async function switchToGeneralFeed() {
    if (!state.selectedAuthor) {
      return;
    }
    state.selectedAuthor = null;
    state.selectedAuthorTotal = null;
    state.selectedAuthorTotalLoading = false;
    state.selectedAuthorTotalComplete = true;
    updateFeedModeUi();
    await resetFeedAndLoad();
    showToast("Returned to general feed");
  }

  async function flushCacheAndIndex() {
    const confirmed = window.confirm("Flush all cached videos and delete local index? This cannot be undone.");
    if (!confirmed) {
      return;
    }

    const secondConfirm = window.confirm("Are you sure? This will remove all cached files now.");
    if (!secondConfirm) {
      return;
    }

    try {
      const result = await api("/api/cache/flush", {
        method: "POST",
        body: JSON.stringify({ confirm: true })
      });
      showToast(
        `Cache flushed: ${formatInt(result.deletedFilesEstimate)} videos, ${formatBytes(result.deletedBytesEstimate)} removed`
      );

      stopAutoAdvanceTimer();
      state.items = [];
      state.nextCursor = null;
      state.activeIndex = -1;
      state.prefetchSent.clear();
      state.failedVideoIds.clear();
      refs.feed.innerHTML = "";
      observer.disconnect();

      await refreshStats();
      await loadMore();
      if (state.items.length > 0) {
        await setActiveIndex(0);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast(`Flush failed: ${message}`, true);
    }
  }

  async function setActiveIndex(index) {
    if (index === state.activeIndex || index < 0 || index >= state.items.length) {
      return;
    }

    const previousIndex = state.activeIndex;
    state.activeIndex = index;
    updateFeedModeUi();

    const cards = refs.feed.querySelectorAll(".video-card");
    cards.forEach((card, cardIndex) => {
      const video = card.querySelector("video");
      if (cardIndex === index) {
        video.play().catch(() => {});
      } else {
        video.pause();
      }
    });

    await prefetchFrom(index);

    if (state.items.length - index <= 4) {
      await loadMore();
    }

    if (previousIndex >= 0 && state.audioEnabled && state.audioSwitchOnFeedAdvance && index !== previousIndex) {
      void switchAudioTrack("feed-advance", true);
    }

    scheduleAutoAdvance();
  }

  async function skipBrokenActiveVideo(failedIndex, videoId) {
    if (!state.authValid || failedIndex !== state.activeIndex) {
      return;
    }

    showToast(`Video unavailable (${videoId}). Skipping...`, true);

    let next = failedIndex + 1;
    if (next >= state.items.length) {
      await loadMore();
      next = failedIndex + 1;
    }

    if (next < state.items.length) {
      const target = refs.feed.querySelector(`.video-card[data-idx="${next}"]`);
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      return;
    }

    showToast("No additional playable videos right now", true);
  }

  function onIntersect(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) {
        continue;
      }
      const idx = Number.parseInt(entry.target.dataset.idx, 10);
      if (Number.isInteger(idx)) {
        void setActiveIndex(idx);
      }
    }
  }

  function bindEvents() {
    refs.btnToggleAudio.addEventListener("click", () => {
      if (state.audioEnabled && state.audioAutoplayBlocked) {
        void switchAudioTrack("button", false);
        return;
      }
      void setAudioEnabled(!state.audioEnabled, "button");
    });
    refs.btnToggleAutoAdvance.addEventListener("click", () => {
      state.autoAdvanceEnabled = !state.autoAdvanceEnabled;
      syncAutoAdvanceControls();
      scheduleAutoAdvance();
      showToast(state.autoAdvanceEnabled ? `Auto-advance enabled (${state.autoAdvanceSeconds}s)` : "Auto-advance disabled");
    });
    refs.btnToggleFullscreen.addEventListener("click", () => void toggleFullscreen());
    refs.btnToggleSettings.addEventListener("click", () => toggleSettingsPanel());
    refs.btnCloseSettings.addEventListener("click", () => setSettingsPanelOpen(false));
    refs.settingsBackdrop.addEventListener("click", () => setSettingsPanelOpen(false));
    document.addEventListener("fullscreenchange", () => {
      if (document.fullscreenElement) {
        state.pseudoFullscreenActive = false;
      }
      setFullscreenUi(Boolean(document.fullscreenElement) || state.pseudoFullscreenActive);
    });

    document.getElementById("btn-save-cookies").addEventListener("click", () => void saveCookies());
    document.getElementById("btn-auth-status").addEventListener("click", () => void checkAuth());
    document.getElementById("btn-save-settings").addEventListener("click", () => void saveSettings());
    document.getElementById("btn-refresh-stats").addEventListener("click", () => void refreshStats());
    document.getElementById("btn-reload-spec").addEventListener("click", () => void reloadSpec());
    refs.btnRefreshAudioLibrary.addEventListener("click", () => void refreshAudioLibrary(true));
    refs.navVideos.addEventListener("click", () => void switchToGeneralFeed());
    refs.btnFlushCache.addEventListener("click", () => void flushCacheAndIndex());
    refs.audioEnabled.addEventListener("change", () => {
      void setAudioEnabled(refs.audioEnabled.checked, "settings");
    });
    refs.audioMinSwitchSec.addEventListener("change", () => {
      state.audioMinSwitchSec = normalizeAudioSwitchSec(refs.audioMinSwitchSec.value, state.audioMinSwitchSec);
      if (state.audioMaxSwitchSec < state.audioMinSwitchSec) {
        state.audioMaxSwitchSec = state.audioMinSwitchSec;
      }
      syncAudioControls();
      if (state.audioEnabled) {
        scheduleAudioSwitch();
      }
    });
    refs.audioMaxSwitchSec.addEventListener("change", () => {
      state.audioMaxSwitchSec = normalizeAudioSwitchSec(refs.audioMaxSwitchSec.value, state.audioMaxSwitchSec);
      if (state.audioMinSwitchSec > state.audioMaxSwitchSec) {
        state.audioMinSwitchSec = state.audioMaxSwitchSec;
      }
      syncAudioControls();
      if (state.audioEnabled) {
        scheduleAudioSwitch();
      }
    });
    refs.audioCrossfadeSec.addEventListener("change", () => {
      state.audioCrossfadeSec = normalizeAudioCrossfadeSec(refs.audioCrossfadeSec.value, state.audioCrossfadeSec);
      syncAudioControls();
    });
    refs.audioSwitchOnFeedAdvance.addEventListener("change", () => {
      state.audioSwitchOnFeedAdvance = refs.audioSwitchOnFeedAdvance.checked;
      syncAudioControls();
    });
    refs.autoAdvanceEnabled.addEventListener("change", () => {
      state.autoAdvanceEnabled = refs.autoAdvanceEnabled.checked;
      syncAutoAdvanceControls();
      scheduleAutoAdvance();
    });
    refs.autoAdvanceSeconds.addEventListener("change", () => {
      state.autoAdvanceSeconds = normalizeAutoAdvanceSeconds(refs.autoAdvanceSeconds.value);
      syncAutoAdvanceControls();
      scheduleAutoAdvance();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.settingsPanelOpen) {
        setSettingsPanelOpen(false);
        return;
      }

      if (event.key === "Escape" && state.pseudoFullscreenActive) {
        state.pseudoFullscreenActive = false;
        setFullscreenUi(Boolean(document.fullscreenElement));
        return;
      }

      if (event.key === "f" || event.key === "F") {
        event.preventDefault();
        void toggleFullscreen();
        return;
      }

      if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "j" && event.key !== "k") {
        return;
      }

      const dir = event.key === "ArrowUp" || event.key === "k" ? -1 : 1;
      const next = Math.max(0, Math.min(state.items.length - 1, state.activeIndex + dir));
      const target = refs.feed.querySelector(`.video-card[data-idx="${next}"]`);
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });

    refs.feed.addEventListener("scroll", () => {
      const nearBottom = refs.feed.scrollTop + refs.feed.clientHeight >= refs.feed.scrollHeight - refs.feed.clientHeight;
      if (nearBottom) {
        void loadMore();
      }
    });
  }

  async function init() {
    bindEvents();
    populateAutoAdvanceOptions();
    state.isIosLike = detectIosLike();
    state.autoAdvanceEnabled = refs.autoAdvanceEnabled.checked;
    state.autoAdvanceSeconds = normalizeAutoAdvanceSeconds(refs.autoAdvanceSeconds.value);
    syncAutoAdvanceControls();
    syncAudioControls();
    setFullscreenUi(Boolean(document.fullscreenElement));
    setSettingsPanelOpen(false);
    updateFeedModeUi();
    await loadSettings();
    await refreshAudioLibrary(false);
    state.audioEnabled = false;
    syncAudioControls();
    await refreshStats();
    startStatsAutoRefresh();

    const valid = await checkAuth();
    if (!valid) {
      showToast("Import cookies to start", true);
      return;
    }

    await loadMore();
    if (state.items.length > 0) {
      await setActiveIndex(0);
    }
  }

  void init();
})();
