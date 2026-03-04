(() => {
  const state = {
    items: [],
    nextCursor: null,
    loadingFeed: false,
    authValid: false,
    activeIndex: -1,
    prefetchDepth: 3,
    prefetchSent: new Set(),
    prefetchPending: new Set(),
    failedVideoIds: new Set(),
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
    browsingLevelR: false,
    browsingLevelX: true,
    browsingLevelXXX: true,
    feedSort: "Newest",
    feedPeriod: "Week",
    sortMenuOpen: false,
    periodMenuOpen: false,
    audioLibrary: [],
    audioCurrentTrack: null,
    audioTimerId: null,
    audioPlayers: null,
    audioActivePlayerIndex: -1,
    audioFadeTimerId: null,
    audioFadeResolver: null,
    audioSwitchInFlight: false,
    audioPendingSwitchRequested: false,
    audioPendingSwitchPreferDifferent: false,
    audioAutoplayBlocked: false,
    videoReloadSeq: 0,
    selectedAuthor: null,
    selectedAuthorTotal: null,
    selectedAuthorTotalLoading: false,
    selectedAuthorTotalComplete: true,
    likedUsers: new Set(),
    likedUsersListOpen: false
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
    browsingLevelR: document.getElementById("browsing-level-r"),
    browsingLevelX: document.getElementById("browsing-level-x"),
    browsingLevelXXX: document.getElementById("browsing-level-xxx"),
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
    navHome: document.getElementById("nav-home"),
    feedNav: document.getElementById("feed-nav"),
    navAuthor: document.getElementById("nav-author"),
    btnLikeAuthor: document.getElementById("btn-like-author"),
    navSeparator: document.getElementById("nav-separator"),
    btnToggleFullscreen: document.getElementById("btn-toggle-fullscreen"),
    btnExitFullscreen: document.getElementById("btn-exit-fullscreen"),
    btnToggleSettings: document.getElementById("btn-toggle-settings"),
    btnCloseSettings: document.getElementById("btn-close-settings"),
    settingsPanel: document.getElementById("settings-panel"),
    settingsBackdrop: document.getElementById("settings-backdrop"),
    feedFilters: document.getElementById("feed-filters"),
    sortControl: document.getElementById("sort-control"),
    btnSortToggle: document.getElementById("btn-sort-toggle"),
    sortMenu: document.getElementById("sort-menu"),
    periodControl: document.getElementById("period-control"),
    btnPeriodToggle: document.getElementById("btn-period-toggle"),
    periodMenu: document.getElementById("period-menu"),
    btnShowLikedUsers: document.getElementById("btn-show-liked-users"),
    likedUsersList: document.getElementById("liked-users-list"),
    fixedMeta: document.getElementById("fixed-meta"),
    fixedMetaMain: document.getElementById("fixed-meta-main"),
    fixedMetaSub: document.getElementById("fixed-meta-sub")
  };

  const observer = new IntersectionObserver(onIntersect, {
    threshold: [0.65, 0.9]
  });
  const FEED_SORT_OPTIONS = ["Most Reactions", "Most Comments", "Most Collected", "Newest", "Oldest"];
  const FEED_PERIOD_OPTIONS = ["Day", "Week", "Month", "Year", "AllTime"];
  const VIDEO_KEEP_BEHIND = 10;
  const VIDEO_KEEP_AHEAD = 2;

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
    refs.toast.style.borderColor = isError ? "rgba(255, 162, 136, 0.5)" : "rgba(255, 119, 180, 0.5)";
    refs.toast.style.background = isError ? "rgba(35, 14, 14, 0.9)" : "rgba(34, 14, 24, 0.9)";
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

  function normalizeAuthorKey(author) {
    return String(author || "")
      .trim()
      .toLowerCase();
  }

  function normalizeFeedSort(value, fallback = "Newest") {
    const normalized = String(value || "")
      .trim()
      .toLowerCase();
    const match = FEED_SORT_OPTIONS.find((candidate) => candidate.toLowerCase() === normalized);
    return match || fallback;
  }

  function normalizeFeedPeriod(value, fallback = "Week") {
    const normalized = String(value || "")
      .trim()
      .toLowerCase();
    const match = FEED_PERIOD_OPTIONS.find((candidate) => candidate.toLowerCase() === normalized);
    return match || fallback;
  }

  function setHeartButtonState(button, liked, labelBase) {
    if (!button) {
      return;
    }
    const active = Boolean(liked);
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
    const title = active ? `Unlike ${labelBase}` : `Like ${labelBase}`;
    button.title = title;
    button.setAttribute("aria-label", title);
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

    const summary = document.createElement("div");
    summary.className = "stats-summary";

    const heading = document.createElement("div");
    heading.className = "stats-summary-title";
    heading.textContent = "Cache Overview";
    summary.appendChild(heading);

    const rows = [
      ["Ready Videos", `${formatInt(stats.readyVideos)} / ${formatInt(stats.totalVideos)}`],
      ["Downloading", `${formatInt(stats.downloadingVideos)} (${formatInt(stats.failedVideos)} failed)`],
      ["Cache Size", formatBytes(stats.totalBytes)],
      ["Hit Rate", `${formatPercent(stats.hitRate)} (${formatInt(stats.cacheHits)} hits / ${formatInt(stats.cacheMisses)} misses)`],
      ["Download Failures", formatInt(stats.downloadFailures)],
      ["Free Disk", `${formatBytes(disk.freeBytes)}${disk.lowDisk ? " (Low disk warning)" : ""}`],
      ["Cache Directory", statsResponse.cacheDir || "-"],
      ["Spec Loaded", statsResponse.specConfigured ? "Yes" : "No"],
      ["Updated", updatedAt]
    ];

    for (const [label, value] of rows) {
      const row = document.createElement("div");
      row.className = "stats-summary-row";
      const left = document.createElement("span");
      left.textContent = label;
      const right = document.createElement("span");
      right.textContent = value;
      row.appendChild(left);
      row.appendChild(right);
      summary.appendChild(row);
    }

    refs.stats.appendChild(summary);
  }

  function renderLikedUsersList() {
    refs.likedUsersList.innerHTML = "";

    if (!state.likedUsersListOpen) {
      refs.likedUsersList.classList.add("hidden");
      return;
    }

    refs.likedUsersList.classList.remove("hidden");
    const users = Array.from(state.likedUsers).sort((a, b) => a.localeCompare(b));
    if (users.length === 0) {
      const empty = document.createElement("div");
      empty.className = "muted-note";
      empty.textContent = "No liked users yet.";
      refs.likedUsersList.appendChild(empty);
      return;
    }

    for (const username of users) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "liked-user-item";
      btn.textContent = `@${username}`;
      btn.addEventListener("click", () => {
        setSettingsPanelOpen(false);
        void switchToAuthor(username);
      });
      refs.likedUsersList.appendChild(btn);
    }
  }

  async function loadLikedUsers() {
    const result = await api(`/api/likes/users?_ts=${Date.now()}`);
    const next = new Set();
    if (Array.isArray(result.users)) {
      for (const raw of result.users) {
        const username = normalizeAuthorKey(raw);
        if (username) {
          next.add(username);
        }
      }
    }
    state.likedUsers = next;
    renderLikedUsersList();
  }

  async function toggleSelectedAuthorLike() {
    const username = normalizeAuthorKey(state.selectedAuthor);
    if (!username) {
      return;
    }

    const nextLiked = !state.likedUsers.has(username);
    try {
      const result = await api("/api/likes/user", {
        method: "POST",
        body: JSON.stringify({
          username,
          liked: nextLiked
        })
      });
      if (result.liked) {
        state.likedUsers.add(username);
      } else {
        state.likedUsers.delete(username);
      }
      setHeartButtonState(refs.btnLikeAuthor, result.liked, "user");
      if (state.likedUsersListOpen) {
        renderLikedUsersList();
      }
    } catch (err) {
      showToast(`User like error: ${err.message}`, true);
    }
  }

  async function setVideoLike(videoId, liked) {
    if (!videoId) {
      return;
    }

    try {
      const result = await api("/api/likes/video", {
        method: "POST",
        body: JSON.stringify({
          videoId,
          liked
        })
      });
      const idx = state.items.findIndex((item) => item.id === videoId);
      if (idx >= 0) {
        state.items[idx].liked = Boolean(result.liked);
        if (idx === state.activeIndex) {
          updateFixedMeta();
        }
      }
    } catch (err) {
      showToast(`Video like error: ${err.message}`, true);
    }
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
      void refreshStats();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setAuthPill(false, message);
      showToast(`Cookie error: ${message}`, true);
      void refreshStats();
    }
  }

  function getSelectedAuthorTotalLabel() {
    if (Number.isInteger(state.selectedAuthorTotal)) {
      return state.selectedAuthorTotalComplete ? String(state.selectedAuthorTotal) : `${state.selectedAuthorTotal}+`;
    }
    return "...";
  }

  function renderFixedMeta(item, index) {
    if (!item || !Number.isInteger(index) || index < 0) {
      refs.fixedMeta.classList.add("hidden");
      refs.fixedMetaMain.innerHTML = "";
      refs.fixedMetaSub.innerHTML = "";
      return;
    }

    refs.fixedMeta.classList.remove("hidden");
    refs.fixedMetaMain.innerHTML = "";
    refs.fixedMetaSub.innerHTML = "";
    const sourceUrl = item.pageUrl || item.mediaUrl;
    const isAuthorFeedItem = Boolean(
      state.selectedAuthor && item.author && normalizeAuthorKey(item.author) === normalizeAuthorKey(state.selectedAuthor)
    );
    const createVideoHeart = () => {
      const heart = document.createElement("button");
      heart.type = "button";
      heart.className = "heart-btn meta-heart-btn";
      heart.innerHTML =
        '<svg class="heart-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M12.1 20.3 5 13.7a4.8 4.8 0 0 1 6.8-6.8L12 7l.2-.1A4.8 4.8 0 1 1 19 13.7l-6.9 6.6z"></path></svg>';
      setHeartButtonState(heart, Boolean(item.liked), "video");
      heart.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void setVideoLike(item.id, !Boolean(item.liked));
      });
      return heart;
    };

    if (item.author) {
      if (isAuthorFeedItem) {
        let linked = false;
        if (sourceUrl) {
          try {
            const source = new URL(sourceUrl);
            if (source.protocol === "http:" || source.protocol === "https:") {
              const authorLink = document.createElement("a");
              authorLink.className = "author-link";
              authorLink.href = source.toString();
              authorLink.target = "_blank";
              authorLink.rel = "noopener noreferrer";
              authorLink.textContent = `@${item.author}`;
              authorLink.title = "Open current Civitai video";
              refs.fixedMetaMain.appendChild(authorLink);
              linked = true;
            }
          } catch {
            // fall through to plain text below
          }
        }

        if (!linked) {
          const authorText = document.createElement("span");
          authorText.className = "author-link";
          authorText.textContent = `@${item.author}`;
          refs.fixedMetaMain.appendChild(authorText);
        }

        const counter = document.createElement("span");
        counter.className = "author-counter";
        counter.textContent = `${index + 1}/${getSelectedAuthorTotalLabel()}`;
        refs.fixedMetaMain.appendChild(counter);
        refs.fixedMetaMain.appendChild(createVideoHeart());
      } else {
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
        refs.fixedMetaMain.appendChild(authorBtn);
        refs.fixedMetaMain.appendChild(createVideoHeart());
      }
    } else {
      const fallback = document.createElement("span");
      fallback.textContent = `Video ${item.id.slice(0, 8)}`;
      refs.fixedMetaMain.appendChild(fallback);
      refs.fixedMetaMain.appendChild(createVideoHeart());
    }
  }

  function updateFixedMeta() {
    const item = state.items[state.activeIndex] ?? null;
    renderFixedMeta(item, state.activeIndex);
  }

  function buildVideoApiUrl(videoId, reloadToken) {
    const base = `/api/video/${encodeURIComponent(videoId)}`;
    if (!Number.isInteger(reloadToken)) {
      return base;
    }
    return `${base}?_reload=${reloadToken}`;
  }

  function attachVideoSource(video, videoId, forceReload = false) {
    if (!video || !videoId) {
      return;
    }
    if (!forceReload && video.getAttribute("src")) {
      return;
    }

    let reloadToken = null;
    if (forceReload) {
      state.videoReloadSeq += 1;
      reloadToken = state.videoReloadSeq;
    }

    video.src = buildVideoApiUrl(videoId, reloadToken);
  }

  function detachVideoSource(video) {
    if (!video || !video.getAttribute("src")) {
      return;
    }

    // Detaching source can emit transient media errors in some browsers.
    video.dataset.suppressErrorUntil = String(Date.now() + 800);
    video.pause();
    video.removeAttribute("src");
    video.load();
  }

  function updateVideoMemoryWindow(activeIndex) {
    if (!Number.isInteger(activeIndex) || activeIndex < 0) {
      return;
    }

    const keepStart = Math.max(0, activeIndex - VIDEO_KEEP_BEHIND);
    const keepEnd = Math.min(state.items.length - 1, activeIndex + VIDEO_KEEP_AHEAD);
    const cards = refs.feed.querySelectorAll(".video-card");

    cards.forEach((card) => {
      const idx = Number.parseInt(card.dataset.idx || "-1", 10);
      if (!Number.isInteger(idx) || idx < 0) {
        return;
      }
      const video = card.querySelector("video");
      const videoId = card.dataset.videoId;
      const keepLoaded = idx >= keepStart && idx <= keepEnd;

      if (keepLoaded) {
        if (!video.getAttribute("src")) {
          attachVideoSource(video, videoId, true);
          video.load();
        }
        return;
      }

      if (!video.getAttribute("src")) {
        return;
      }

      detachVideoSource(video);
    });
  }

  function renderItem(item, index) {
    const node = refs.tpl.content.firstElementChild.cloneNode(true);
    node.dataset.videoId = item.id;
    node.dataset.idx = String(index);

    const video = node.querySelector("video");
    video.loop = true;
    video.muted = true;
    video.preload = state.isIosLike ? "auto" : "metadata";
    video.playsInline = true;

    video.addEventListener("error", () => {
      const suppressUntil = Number.parseInt(video.dataset.suppressErrorUntil || "0", 10);
      if (Date.now() < suppressUntil) {
        return;
      }

      const errorCode = Number(video.error?.code || 0);
      const isAborted = errorCode === 1;
      const err = node.querySelector(".error");
      if (state.failedVideoIds.has(item.id)) {
        return;
      }
      const idx = Number.parseInt(node.dataset.idx || "-1", 10);
      const isActive = idx === state.activeIndex;
      if (!isActive || isAborted || !video.getAttribute("src")) {
        return;
      }

      state.failedVideoIds.add(item.id);
      err.classList.remove("hidden");
      err.textContent = "Playback failed. Check auth and source URL.";
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
      if (state.activeIndex >= 0) {
        updateVideoMemoryWindow(state.activeIndex);
      }

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
      void refreshStats();
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
      state.browsingLevelR = Boolean(result.settings.browsingLevelR);
      state.browsingLevelX = Boolean(result.settings.browsingLevelX);
      state.browsingLevelXXX = Boolean(result.settings.browsingLevelXXX);
      state.feedSort = normalizeFeedSort(result.settings.feedSort, "Newest");
      state.feedPeriod = normalizeFeedPeriod(result.settings.feedPeriod, "Week");
      if (state.audioMaxSwitchSec < state.audioMinSwitchSec) {
        const tmp = state.audioMinSwitchSec;
        state.audioMinSwitchSec = state.audioMaxSwitchSec;
        state.audioMaxSwitchSec = tmp;
      }
      refs.prefetchDepth.value = String(result.settings.prefetchDepth);
      refs.diskWarn.value = String(result.settings.lowDiskWarnGb);
      refs.audioMinSwitchSec.value = String(state.audioMinSwitchSec);
      refs.audioMaxSwitchSec.value = String(state.audioMaxSwitchSec);
      refs.audioCrossfadeSec.value = String(state.audioCrossfadeSec);
      refs.browsingLevelR.checked = state.browsingLevelR;
      refs.browsingLevelX.checked = state.browsingLevelX;
      refs.browsingLevelXXX.checked = state.browsingLevelXXX;
      syncAudioControls();
      syncSortControl();
      syncPeriodControl();
    } catch (err) {
      showToast(`Settings load failed: ${err.message}`, true);
    }
  }

  async function saveSettings() {
    const browsingChanged =
      state.browsingLevelR !== refs.browsingLevelR.checked ||
      state.browsingLevelX !== refs.browsingLevelX.checked ||
      state.browsingLevelXXX !== refs.browsingLevelXXX.checked;
    const prefetchDepth = Number.parseInt(refs.prefetchDepth.value, 10);
    const lowDiskWarnGb = Number.parseFloat(refs.diskWarn.value);
    const audioMinSwitchSec = normalizeAudioSwitchSec(refs.audioMinSwitchSec.value, state.audioMinSwitchSec);
    const audioMaxSwitchSec = normalizeAudioSwitchSec(refs.audioMaxSwitchSec.value, state.audioMaxSwitchSec);
    const audioCrossfadeSec = normalizeAudioCrossfadeSec(refs.audioCrossfadeSec.value, state.audioCrossfadeSec);
    const normalizedAudioMin = Math.min(audioMinSwitchSec, audioMaxSwitchSec);
    const normalizedAudioMax = Math.max(audioMinSwitchSec, audioMaxSwitchSec);
    const audioEnabled = refs.audioEnabled.checked;
    const browsingLevelR = refs.browsingLevelR.checked;
    const browsingLevelX = refs.browsingLevelX.checked;
    const browsingLevelXXX = refs.browsingLevelXXX.checked;
    const feedSort = state.feedSort;
    const feedPeriod = state.feedPeriod;

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
          browsingLevelR,
          browsingLevelX,
          browsingLevelXXX,
          feedSort,
          feedPeriod
        })
      });

      state.prefetchDepth = result.settings.prefetchDepth;
      state.audioEnabled = Boolean(result.settings.audioEnabled);
      state.audioMinSwitchSec = normalizeAudioSwitchSec(result.settings.audioMinSwitchSec, normalizedAudioMin);
      state.audioMaxSwitchSec = normalizeAudioSwitchSec(result.settings.audioMaxSwitchSec, normalizedAudioMax);
      state.audioCrossfadeSec = normalizeAudioCrossfadeSec(result.settings.audioCrossfadeSec, audioCrossfadeSec);
      state.browsingLevelR = Boolean(result.settings.browsingLevelR);
      state.browsingLevelX = Boolean(result.settings.browsingLevelX);
      state.browsingLevelXXX = Boolean(result.settings.browsingLevelXXX);
      state.feedSort = normalizeFeedSort(result.settings.feedSort, feedSort);
      state.feedPeriod = normalizeFeedPeriod(result.settings.feedPeriod, feedPeriod);
      refs.prefetchDepth.value = String(result.settings.prefetchDepth);
      refs.audioMinSwitchSec.value = String(state.audioMinSwitchSec);
      refs.audioMaxSwitchSec.value = String(state.audioMaxSwitchSec);
      refs.audioCrossfadeSec.value = String(state.audioCrossfadeSec);
      refs.browsingLevelR.checked = state.browsingLevelR;
      refs.browsingLevelX.checked = state.browsingLevelX;
      refs.browsingLevelXXX.checked = state.browsingLevelXXX;
      syncAudioControls();
      syncSortControl();
      syncPeriodControl();
      if (state.audioEnabled) {
        requestAudioSwitch("settings-save", false);
      } else {
        stopAudioPlayback();
      }
      if (browsingChanged && state.authValid) {
        await resetFeedAndLoad();
        if (state.selectedAuthor) {
          void refreshAuthorTotal(state.selectedAuthor);
        }
        showToast("Settings saved. Feed reloaded");
      } else {
        showToast("Settings saved");
      }
      void refreshStats();
    } catch (err) {
      showToast(`Settings error: ${err.message}`, true);
      void refreshStats();
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

  async function prefetchFrom(index) {
    const start = index + 1;
    const end = start + state.prefetchDepth;
    const ids = state.items
      .slice(start, end)
      .map((item) => item.id)
      .filter((id) => !state.prefetchSent.has(id) && !state.prefetchPending.has(id));

    if (ids.length === 0) {
      return;
    }

    ids.forEach((id) => state.prefetchPending.add(id));

    try {
      const result = await api("/api/prefetch", {
        method: "POST",
        body: JSON.stringify({ videoIds: ids })
      });
      const queuedIds = Array.isArray(result?.queued) ? result.queued : ids;
      queuedIds.forEach((id) => state.prefetchSent.add(id));
    } catch (err) {
      showToast(`Prefetch error: ${err.message}`, true);
    } finally {
      ids.forEach((id) => state.prefetchPending.delete(id));
      void refreshStats();
    }
  }

  function stopAutoAdvanceTimer() {
    if (state.autoAdvanceTimerId !== null) {
      clearTimeout(state.autoAdvanceTimerId);
      state.autoAdvanceTimerId = null;
    }
    if (state.autoAdvanceTransitionInFlight) {
      state.autoAdvanceTransitionInFlight = false;
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
    refs.browsingLevelR.checked = state.browsingLevelR;
    refs.browsingLevelX.checked = state.browsingLevelX;
    refs.browsingLevelXXX.checked = state.browsingLevelXXX;
    refs.btnToggleAudio.classList.toggle("active", state.audioEnabled);
    refs.btnToggleAudio.setAttribute("aria-pressed", state.audioEnabled ? "true" : "false");
    refs.btnToggleAudio.title = state.audioEnabled ? "Disable background loops" : "Enable background loops";
  }

  function syncSortControl() {
    const current = normalizeFeedSort(state.feedSort, "Newest");
    state.feedSort = current;
    refs.btnSortToggle.textContent = current;
    refs.btnSortToggle.title = `Sort: ${current}`;
    refs.btnSortToggle.setAttribute("aria-label", refs.btnSortToggle.title);

    const items = refs.sortMenu.querySelectorAll(".sort-menu-item");
    items.forEach((node) => {
      const option = normalizeFeedSort(node.dataset.sort, "Newest");
      const active = option === current;
      node.classList.toggle("active", active);
      node.setAttribute("aria-checked", active ? "true" : "false");
    });
  }

  function setSortMenuOpen(open) {
    const next = Boolean(open);
    state.sortMenuOpen = next;
    refs.sortMenu.classList.toggle("hidden", !next);
    refs.btnSortToggle.setAttribute("aria-expanded", next ? "true" : "false");
  }

  function syncPeriodControl() {
    const current = normalizeFeedPeriod(state.feedPeriod, "Week");
    state.feedPeriod = current;
    const buttonLabel = current === "AllTime" ? "All Time" : current;
    refs.btnPeriodToggle.textContent = buttonLabel;
    refs.btnPeriodToggle.title = `Period: ${buttonLabel}`;
    refs.btnPeriodToggle.setAttribute("aria-label", refs.btnPeriodToggle.title);

    const items = refs.periodMenu.querySelectorAll(".period-menu-item");
    items.forEach((node) => {
      const option = normalizeFeedPeriod(node.dataset.period, "Week");
      const active = option === current;
      node.classList.toggle("active", active);
      node.setAttribute("aria-checked", active ? "true" : "false");
    });
  }

  function setPeriodMenuOpen(open) {
    const next = Boolean(open);
    state.periodMenuOpen = next;
    refs.periodMenu.classList.toggle("hidden", !next);
    refs.btnPeriodToggle.setAttribute("aria-expanded", next ? "true" : "false");
  }

  async function applyFeedSort(nextSortRaw) {
    const nextSort = normalizeFeedSort(nextSortRaw, state.feedSort);
    if (nextSort === state.feedSort) {
      setSortMenuOpen(false);
      return;
    }

    try {
      const result = await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          feedSort: nextSort
        })
      });
      state.feedSort = normalizeFeedSort(result.settings.feedSort, nextSort);
      syncSortControl();
      setSortMenuOpen(false);
      if (state.authValid) {
        await resetFeedAndLoad();
        if (state.selectedAuthor) {
          void refreshAuthorTotal(state.selectedAuthor);
        }
      }
      showToast(`Sort: ${state.feedSort}`);
    } catch (err) {
      showToast(`Sort update failed: ${err.message}`, true);
    }
  }

  async function applyFeedPeriod(nextPeriodRaw) {
    const nextPeriod = normalizeFeedPeriod(nextPeriodRaw, state.feedPeriod);
    if (nextPeriod === state.feedPeriod) {
      setPeriodMenuOpen(false);
      return;
    }

    try {
      const result = await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          feedPeriod: nextPeriod
        })
      });
      state.feedPeriod = normalizeFeedPeriod(result.settings.feedPeriod, nextPeriod);
      syncPeriodControl();
      setPeriodMenuOpen(false);
      if (state.authValid) {
        await resetFeedAndLoad();
        if (state.selectedAuthor) {
          void refreshAuthorTotal(state.selectedAuthor);
        }
      }
      showToast(`Period: ${state.feedPeriod === "AllTime" ? "All Time" : state.feedPeriod}`);
    } catch (err) {
      showToast(`Period update failed: ${err.message}`, true);
    }
  }

  function updateAudioLibraryStatus() {
    const count = state.audioLibrary.length;
    refs.audioLibraryStatus.textContent = `Audio library: ${count} file${count === 1 ? "" : "s"}`;
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
        requestAudioSwitch("error", true);
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
    state.audioPendingSwitchRequested = false;
    state.audioPendingSwitchPreferDifferent = false;
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
      requestAudioSwitch("timer", true);
    }, randomAudioSwitchMs());
  }

  function buildRandomTrackCandidates(preferDifferent) {
    const tracks = state.audioLibrary.slice();
    if (tracks.length === 0) {
      return [];
    }

    const currentName = state.audioCurrentTrack?.name ?? null;
    let pool = tracks;
    if (preferDifferent && currentName && tracks.length > 1) {
      const filtered = tracks.filter((track) => track.name !== currentName);
      if (filtered.length > 0) {
        pool = filtered;
      }
    }

    for (let idx = pool.length - 1; idx > 0; idx -= 1) {
      const swapIdx = Math.floor(Math.random() * (idx + 1));
      const tmp = pool[idx];
      pool[idx] = pool[swapIdx];
      pool[swapIdx] = tmp;
    }

    return pool;
  }

  function requestAudioSwitch(reason, preferDifferent) {
    if (!state.audioEnabled) {
      return;
    }
    if (state.audioSwitchInFlight) {
      state.audioPendingSwitchRequested = true;
      state.audioPendingSwitchPreferDifferent = state.audioPendingSwitchPreferDifferent || Boolean(preferDifferent);
      return;
    }
    void switchAudioTrack(reason, preferDifferent);
  }

  async function switchAudioTrack(reason, preferDifferent) {
    if (!state.audioEnabled) {
      return false;
    }
    if (state.audioSwitchInFlight) {
      state.audioPendingSwitchRequested = true;
      state.audioPendingSwitchPreferDifferent = state.audioPendingSwitchPreferDifferent || Boolean(preferDifferent);
      return false;
    }

    state.audioSwitchInFlight = true;
    state.audioPendingSwitchRequested = false;
    state.audioPendingSwitchPreferDifferent = false;
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
      const candidates = buildRandomTrackCandidates(preferDifferent);
      for (const nextTrack of candidates) {
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
      if (reason !== "button") {
        scheduleAudioSwitch();
      }
      return false;
    } finally {
      state.audioSwitchInFlight = false;
      const pendingRequested = state.audioPendingSwitchRequested;
      const pendingPreferDifferent = state.audioPendingSwitchPreferDifferent;
      state.audioPendingSwitchRequested = false;
      state.audioPendingSwitchPreferDifferent = false;
      if (pendingRequested && state.audioEnabled) {
        queueMicrotask(() => requestAudioSwitch("queued", pendingPreferDifferent));
      }
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

  async function autoAdvanceTo(next) {
    state.autoAdvanceTransitionInFlight = true;
    try {
      jumpFeedToIndexNoAnimation(next);
      await setActiveIndex(next);
    } finally {
      state.autoAdvanceTransitionInFlight = false;
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
        await autoAdvanceTo(next);
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
    if (!next && state.likedUsersListOpen) {
      state.likedUsersListOpen = false;
      refs.btnShowLikedUsers.textContent = "Liked Users";
      renderLikedUsersList();
    }
  }

  function toggleSettingsPanel() {
    setSettingsPanelOpen(!state.settingsPanelOpen);
  }

  async function toggleLikedUsersList() {
    state.likedUsersListOpen = !state.likedUsersListOpen;
    if (state.likedUsersListOpen) {
      refs.btnShowLikedUsers.textContent = "Hide Liked Users";
      try {
        await loadLikedUsers();
      } catch (err) {
        showToast(`Liked users load failed: ${err.message}`, true);
        state.likedUsersListOpen = false;
        refs.btnShowLikedUsers.textContent = "Liked Users";
      }
    } else {
      refs.btnShowLikedUsers.textContent = "Liked Users";
      renderLikedUsersList();
    }
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
    refs.btnExitFullscreen.classList.toggle("hidden", !state.fullscreenActive);
    refs.btnExitFullscreen.title = exitText;
    refs.btnExitFullscreen.setAttribute("aria-label", exitText);

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

  async function closeFullscreenMode() {
    if (state.pseudoFullscreenActive) {
      state.pseudoFullscreenActive = false;
      setFullscreenUi(Boolean(document.fullscreenElement));
      return;
    }

    if (document.fullscreenElement) {
      await exitFullscreen();
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
      const authorKey = normalizeAuthorKey(state.selectedAuthor);
      refs.navHome.classList.remove("active");
      refs.navHome.removeAttribute("aria-current");
      refs.feedNav.classList.remove("hidden");
      refs.navSeparator.classList.add("hidden");
      refs.navAuthor.classList.remove("hidden");
      refs.navAuthor.classList.add("active");
      refs.navAuthor.setAttribute("aria-current", "page");
      refs.navAuthor.textContent = `@${state.selectedAuthor}`;
      refs.btnLikeAuthor.classList.remove("hidden");
      setHeartButtonState(refs.btnLikeAuthor, state.likedUsers.has(authorKey), "user");
      updateFixedMeta();
      return;
    }

    refs.navHome.classList.add("active");
    refs.navHome.setAttribute("aria-current", "page");
    refs.feedNav.classList.add("hidden");
    refs.navSeparator.classList.add("hidden");
    refs.navAuthor.classList.add("hidden");
    refs.navAuthor.classList.remove("active");
    refs.navAuthor.removeAttribute("aria-current");
    refs.btnLikeAuthor.classList.add("hidden");
    setHeartButtonState(refs.btnLikeAuthor, false, "user");
    updateFixedMeta();
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
    state.prefetchPending.clear();
    state.failedVideoIds.clear();
    updateFixedMeta();

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

  async function navigateHome() {
    if (state.selectedAuthor) {
      await switchToGeneralFeed();
      return;
    }

    const firstCard = getCardByIndex(0);
    if (firstCard) {
      firstCard.scrollIntoView({ behavior: "smooth", block: "start" });
    }
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
      state.prefetchPending.clear();
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
    updateVideoMemoryWindow(index);

    // Always switch to a random next loop on any feed advance, independent of timer settings.
    if (previousIndex >= 0 && index !== previousIndex) {
      requestAudioSwitch("feed-advance", true);
    }

    const cards = refs.feed.querySelectorAll(".video-card");
    cards.forEach((card, cardIndex) => {
      const video = card.querySelector("video");
      const videoId = card.dataset.videoId;
      const keepPreviousPlaying = state.isIosLike && previousIndex >= 0 && cardIndex === previousIndex;
      if (cardIndex === index || keepPreviousPlaying) {
        if (!video.getAttribute("src")) {
          attachVideoSource(video, videoId, true);
          video.load();
        }
        video.play().catch(() => {});
      } else {
        video.pause();
      }
    });

    await prefetchFrom(index);

    if (state.items.length - index <= 4) {
      await loadMore();
    }

    scheduleAutoAdvance();
    void refreshStats();
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
    const minRatio = 0.9;
    let candidateIdx = -1;
    let candidateRatio = minRatio;
    for (const entry of entries) {
      if (!entry.isIntersecting || entry.intersectionRatio < minRatio) {
        continue;
      }
      const idx = Number.parseInt(entry.target.dataset.idx, 10);
      if (Number.isInteger(idx) && entry.intersectionRatio >= candidateRatio) {
        candidateIdx = idx;
        candidateRatio = entry.intersectionRatio;
      }
    }

    if (candidateIdx >= 0) {
      void setActiveIndex(candidateIdx);
    }
  }

  function bindEvents() {
    refs.btnToggleAudio.addEventListener("click", () => {
      if (state.audioEnabled && state.audioAutoplayBlocked) {
        requestAudioSwitch("button", false);
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
    refs.btnExitFullscreen.addEventListener("click", () => void closeFullscreenMode());
    refs.btnToggleSettings.addEventListener("click", () => toggleSettingsPanel());
    refs.btnCloseSettings.addEventListener("click", () => setSettingsPanelOpen(false));
    refs.settingsBackdrop.addEventListener("click", () => setSettingsPanelOpen(false));
    refs.btnSortToggle.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setPeriodMenuOpen(false);
      setSortMenuOpen(!state.sortMenuOpen);
    });
    refs.sortMenu.addEventListener("click", (event) => {
      const target = event.target?.closest?.(".sort-menu-item");
      if (!target) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void applyFeedSort(target.dataset.sort);
    });
    refs.btnPeriodToggle.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setSortMenuOpen(false);
      setPeriodMenuOpen(!state.periodMenuOpen);
    });
    refs.periodMenu.addEventListener("click", (event) => {
      const target = event.target?.closest?.(".period-menu-item");
      if (!target) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void applyFeedPeriod(target.dataset.period);
    });
    refs.btnLikeAuthor.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void toggleSelectedAuthorLike();
    });
    refs.btnShowLikedUsers.addEventListener("click", () => void toggleLikedUsersList());
    document.addEventListener("fullscreenchange", () => {
      if (document.fullscreenElement) {
        state.pseudoFullscreenActive = false;
      }
      setFullscreenUi(Boolean(document.fullscreenElement) || state.pseudoFullscreenActive);
    });

    document.getElementById("btn-save-cookies").addEventListener("click", () => void saveCookies());
    document.getElementById("btn-save-settings").addEventListener("click", () => void saveSettings());
    refs.btnRefreshAudioLibrary.addEventListener("click", () => void refreshAudioLibrary(true));
    refs.navHome.addEventListener("click", () => void navigateHome());
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
    refs.browsingLevelR.addEventListener("change", () => {
      state.browsingLevelR = refs.browsingLevelR.checked;
      syncAudioControls();
    });
    refs.browsingLevelX.addEventListener("change", () => {
      state.browsingLevelX = refs.browsingLevelX.checked;
      syncAudioControls();
    });
    refs.browsingLevelXXX.addEventListener("change", () => {
      state.browsingLevelXXX = refs.browsingLevelXXX.checked;
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

      if (event.key === "Escape" && state.sortMenuOpen) {
        setSortMenuOpen(false);
        return;
      }

      if (event.key === "Escape" && state.periodMenuOpen) {
        setPeriodMenuOpen(false);
        return;
      }

      if (event.key === "Escape" && state.pseudoFullscreenActive) {
        void closeFullscreenMode();
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
    document.addEventListener("click", (event) => {
      if (!state.sortMenuOpen && !state.periodMenuOpen) {
        return;
      }
      const target = event.target;
      if (refs.feedFilters.contains(target)) {
        return;
      }
      setSortMenuOpen(false);
      setPeriodMenuOpen(false);
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
    syncSortControl();
    syncPeriodControl();
    setFullscreenUi(Boolean(document.fullscreenElement));
    setSettingsPanelOpen(false);
    updateFeedModeUi();
    await loadSettings();
    try {
      await loadLikedUsers();
    } catch {
      // Keep UI usable; likes can still be toggled on demand.
    }
    await refreshAudioLibrary(false);
    state.audioEnabled = false;
    syncAudioControls();
    await refreshStats();

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
