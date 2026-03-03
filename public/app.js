(() => {
  const state = {
    items: [],
    nextCursor: null,
    loadingFeed: false,
    authValid: false,
    activeIndex: -1,
    prefetchDepth: 3,
    prefetchSent: new Set(),
    statsIntervalId: null,
    statsRequestInFlight: false,
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
    diskWarn: document.getElementById("disk-warn"),
    stats: document.getElementById("stats-output"),
    tpl: document.getElementById("video-card-template"),
    modeLabel: document.getElementById("feed-mode-label"),
    backGeneral: document.getElementById("btn-back-general")
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
      refs.prefetchDepth.value = String(result.settings.prefetchDepth);
      refs.diskWarn.value = String(result.settings.lowDiskWarnGb);
    } catch (err) {
      showToast(`Settings load failed: ${err.message}`, true);
    }
  }

  async function saveSettings() {
    const prefetchDepth = Number.parseInt(refs.prefetchDepth.value, 10);
    const lowDiskWarnGb = Number.parseFloat(refs.diskWarn.value);

    try {
      const result = await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          prefetchDepth,
          lowDiskWarnGb
        })
      });

      state.prefetchDepth = result.settings.prefetchDepth;
      refs.prefetchDepth.value = String(result.settings.prefetchDepth);
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
      refs.stats.textContent = `${JSON.stringify(result, null, 2)}\n\nupdatedAt: ${new Date().toISOString()}`;
    } catch (err) {
      refs.stats.textContent = `Failed: ${err.message}`;
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

  function updateFeedModeUi() {
    if (state.selectedAuthor) {
      const countText = (() => {
        if (state.selectedAuthorTotalLoading) {
          return "(...)";
        }
        if (!Number.isInteger(state.selectedAuthorTotal)) {
          return "";
        }
        const formatted = new Intl.NumberFormat().format(state.selectedAuthorTotal);
        return state.selectedAuthorTotalComplete ? `(${formatted})` : `(${formatted}+)`;
      })();
      refs.modeLabel.textContent = `Author Feed: @${state.selectedAuthor}${countText ? ` ${countText}` : ""}`;
      refs.backGeneral.classList.remove("hidden");
      return;
    }

    refs.modeLabel.textContent = "General Feed";
    refs.backGeneral.classList.add("hidden");
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
    observer.disconnect();
    refs.feed.innerHTML = "";
    state.items = [];
    state.nextCursor = null;
    state.loadingFeed = false;
    state.activeIndex = -1;
    state.prefetchSent.clear();

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

  async function setActiveIndex(index) {
    if (index === state.activeIndex || index < 0 || index >= state.items.length) {
      return;
    }

    state.activeIndex = index;

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
    document.getElementById("btn-save-cookies").addEventListener("click", () => void saveCookies());
    document.getElementById("btn-auth-status").addEventListener("click", () => void checkAuth());
    document.getElementById("btn-save-settings").addEventListener("click", () => void saveSettings());
    document.getElementById("btn-refresh-stats").addEventListener("click", () => void refreshStats());
    document.getElementById("btn-reload-spec").addEventListener("click", () => void reloadSpec());
    refs.backGeneral.addEventListener("click", () => void switchToGeneralFeed());

    document.addEventListener("keydown", (event) => {
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
    updateFeedModeUi();
    await loadSettings();
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
