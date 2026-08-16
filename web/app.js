/**
 * TNGPlaylists — frontend app logic
 * Vanilla JS (no framework), mirrors the Notes app's no-build philosophy.
 */

const API_BASE = "/api";

// Guests keep their watched list here (JSON array of episode ids). Signed-in
// users get server-side sync instead — the two stores are kept separate, so
// signing in never uploads (or clobbers) a guest list.
const WATCHED_LS_KEY = "tngplaylists.watched";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  tab: "browse",
  episodes: [],
  searchMode: "",
  playlists: [],
  currentPlaylist: null,
  user: null,
  // Watched episode ids. Signed in → mirrors the server; signed out → mirrors
  // localStorage. Deliberately never merged (see WATCHED_LS_KEY below).
  watched: new Set(),
  filters: {
    season: "",
    character: "",
    keyword: "",
    category: "",
    writer: "",
    director: "",
  },
};

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

async function api(path, options = {}) {
  const resp = await fetch(`${API_BASE}${path}`, options);
  if (resp.status === 204) return null;
  const data = await resp.json().catch(() => null);
  if (!resp.ok || (data && data.success === false)) {
    throw new Error(data?.error || `HTTP ${resp.status}`);
  }
  return data?.data ?? data;
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => (t.hidden = true), 2500);
}

function esc(s) {
  const div = document.createElement("div");
  div.textContent = String(s ?? "");
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
const canWrite = () =>
  state.user && (state.user.role === "writer" || state.user.role === "admin");
const isAdmin = () => state.user?.role === "admin";

async function loadAuth() {
  try {
    const data = await api("/auth/me");
    state.user = data.user;
  } catch {
    state.user = null;
  }
  renderAuth();
  await loadWatched();
}

function renderAuth() {
  const area = $("#auth-area");
  area.innerHTML = "";

  if (!state.user) {
    const btn = el("a", "btn btn-ghost btn-sm", "Sign in with Google");
    btn.href = "/api/auth/login";
    area.appendChild(btn);
    document.querySelectorAll(".write-only").forEach((e) => (e.hidden = true));
    $("#admin-tab").hidden = true;
    return;
  }

  const chip = el("div", "user-chip");
  if (state.user.picture) {
    const img = document.createElement("img");
    img.src = state.user.picture;
    img.alt = "";
    chip.appendChild(img);
  }
  chip.appendChild(el("span", null, state.user.email));
  chip.appendChild(el("span", "role-badge", state.user.role));
  area.appendChild(chip);

  const logout = el("button", "btn btn-ghost btn-sm", "Sign out");
  logout.addEventListener("click", async () => {
    try {
      await api("/auth/logout", { method: "POST" });
    } catch { /* best effort */ }
    state.user = null;
    renderAuth();
    loadWatched();
    loadEpisodes();
  });
  area.appendChild(logout);

  document.querySelectorAll(".write-only").forEach((e) => (e.hidden = !canWrite()));
  $("#admin-tab").hidden = !isAdmin();
  // Add-all button visibility follows auth state, result count (≤12), and results
  const addAllBtn = $("#add-all-btn");
  if (addAllBtn) {
    addAllBtn.hidden = !(
      state.episodes.length > 0 && state.episodes.length <= 12 && canWrite()
    );
  }
}

// ---------------------------------------------------------------------------
// Watched episodes — hybrid store
//
// Signed in: the server is the source of truth (synced across devices).
// Signed out: the browser's localStorage is. The two are never merged — on
// sign-in the server list simply takes over.
// ---------------------------------------------------------------------------

/** Read the guest watched list from localStorage (never throws). */
function readGuestWatched() {
  try {
    const raw = JSON.parse(localStorage.getItem(WATCHED_LS_KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.map(Number).filter(Number.isInteger) : []);
  } catch {
    return new Set();
  }
}

function writeGuestWatched(set) {
  try {
    localStorage.setItem(WATCHED_LS_KEY, JSON.stringify([...set]));
  } catch { /* private mode / quota — the in-memory Set still works */ }
}

/** Fill state.watched from whichever store applies, then paint the cards. */
async function loadWatched() {
  if (state.user) {
    try {
      const data = await api("/watched");
      state.watched = new Set(data.watched.map(Number));
    } catch {
      state.watched = new Set();
    }
  } else {
    state.watched = readGuestWatched();
  }
  renderWatchedMarks();
}

const isWatched = (episodeId) => state.watched.has(Number(episodeId));

/** Toggle one episode: API when signed in, localStorage-only when a guest. */
async function toggleWatched(episodeId) {
  const id = Number(episodeId);
  const nowWatched = !state.watched.has(id);

  if (state.user) {
    try {
      await api(`/watched/${id}`, { method: nowWatched ? "PUT" : "DELETE" });
    } catch (err) {
      toast(err.message);
      return;
    }
  }

  if (nowWatched) state.watched.add(id);
  else state.watched.delete(id);
  if (!state.user) writeGuestWatched(state.watched);

  renderWatchedMarks();
}

/**
 * Build the watched toggle for an episode card — a visible labeled pill so
 * the affordance is obvious (the original bare ✓ at 50% opacity read as a
 * decorative badge, not a button). Used by BOTH card builders — the browse
 * grid and the playlist detail grid — so keep those two in sync.
 */
function watchedToggle(episodeId) {
  const btn = el("button", "ep-watched");
  btn.type = "button";
  btn.appendChild(el("span", "ep-watched-icon", "✓"));
  btn.appendChild(el("span", "ep-watched-label", "Mark watched"));
  btn.addEventListener("click", (e) => {
    e.stopPropagation(); // must not open the episode modal
    toggleWatched(episodeId);
  });
  return btn;
}

/** Sync every rendered card with state.watched (no refetch, no re-layout). */
function renderWatchedMarks() {
  document.querySelectorAll(".episode-card[data-episode-id]").forEach((card) => {
    const on = isWatched(card.dataset.episodeId);
    card.classList.toggle("watched", on);
    const btn = card.querySelector(".ep-watched");
    if (!btn) return;
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-pressed", String(on));
    btn.title = on ? "Watched — click to unmark" : "Mark as watched";
    const label = btn.querySelector(".ep-watched-label");
    if (label) label.textContent = on ? "Watched" : "Mark watched";
  });
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    $(`#tab-${tab}`).classList.add("active");
    state.tab = tab;
    if (tab === "browse") loadEpisodes();
    if (tab === "playlists") loadPlaylists();
    if (tab === "admin") loadUsers();
  });
});

// ---------------------------------------------------------------------------
// Browse: episodes
// ---------------------------------------------------------------------------
async function loadEpisodes() {
  const grid = $("#episode-grid");
  const info = $("#results-info");
  $("#loading").hidden = false;
  grid.innerHTML = "";

  try {
    const params = new URLSearchParams({ limit: "200" });
    if (state.filters.season) params.set("season", state.filters.season);
    if (state.filters.character) params.set("character", state.filters.character);
    if (state.filters.keyword) params.set("keyword", state.filters.keyword);
    if (state.filters.category) params.set("category", state.filters.category);
    if (state.filters.writer) params.set("writer", state.filters.writer);
    if (state.filters.director) params.set("director", state.filters.director);

    const query = $("#search-input").value.trim();
    if (query) {
      // Semantic search path
      const data = await api(`/search?q=${encodeURIComponent(query)}&limit=50`);
      renderEpisodes(data.results, data.mode);
      info.textContent = data.mode === "semantic"
        ? `Semantic search: "${query}" — ${data.results.length} results`
        : `Text search: "${query}" — ${data.results.length} results`;
      $("#loading").hidden = true;
      return;
    }

    const data = await api(`/episodes?${params}`);
    renderEpisodes(data.episodes, "browse");
    info.textContent = `Showing ${data.episodes.length} of ${data.meta.total} episodes`;
  } catch (err) {
    grid.innerHTML = "";
    grid.appendChild(emptyState("⚠️", err.message));
  }
  $("#loading").hidden = true;
}

function renderEpisodes(episodes, mode) {
  const grid = $("#episode-grid");
  grid.innerHTML = "";
  state.episodes = episodes;

  const addAllBtn = $("#add-all-btn");
  // "Add all" is capped at 12 episodes to keep the bulk-add snappy
  addAllBtn.hidden = !(episodes.length > 0 && episodes.length <= 12 && canWrite());

  if (!episodes.length) {
    grid.appendChild(emptyState("🔭", "No episodes found. Try different filters."));
    return;
  }

  episodes.forEach((ep) => {
    const card = el("div", "episode-card");
    card.dataset.episodeId = ep.episode_id;
    const badge = el("span", "ep-badge", `S${ep.season}E${String(ep.episode_number).padStart(2, "0")}`);
    const title = el("div", "ep-title", ep.title);
    card.appendChild(badge);
    card.appendChild(title);

    const meta = el("div", "ep-meta");
    if (ep.original_air_date) meta.appendChild(document.createTextNode(`Aired ${ep.original_air_date}`));
    if (ep.character_lines !== undefined) {
      meta.appendChild(document.createTextNode(` · ${ep.character_lines} lines`));
    }
    card.appendChild(meta);

    if (mode === "semantic" && ep.similarity) {
      const sim = el("div", "ep-sim", `${(parseFloat(ep.similarity) * 100).toFixed(0)}% match`);
      card.appendChild(sim);
    }

    card.appendChild(watchedToggle(ep.episode_id));
    card.addEventListener("click", () => openEpisodeModal(ep.episode_id));
    grid.appendChild(card);
  });

  renderWatchedMarks();
}

function emptyState(icon, text) {
  const div = el("div", "empty");
  div.appendChild(el("div", "big", icon));
  div.appendChild(el("p", null, text));
  return div;
}

// ---------------------------------------------------------------------------
// Episode modal
// ---------------------------------------------------------------------------
async function openEpisodeModal(id) {
  const modal = $("#episode-modal");
  const body = $("#modal-body");
  body.innerHTML = "";
  modal.hidden = false;

  try {
    const ep = await api(`/episodes/${id}`);

    // Header
    const title = el("h2", null, ep.title);
    const sub = el("div", "modal-sub", `Season ${ep.season}, Episode ${ep.episode_number} · Aired ${ep.original_air_date || "?"} · ${ep.us_viewers_millions ? `${ep.us_viewers_millions}M viewers` : ""}`);
    body.appendChild(title);
    body.appendChild(sub);

    // Characters
    if (ep.characters?.length) {
      const sec = el("div", "modal-section");
      sec.appendChild(el("h3", null, "Characters"));
      ep.characters.slice(0, 30).forEach((c) => {
        const row = el("div", "char-row");
        row.appendChild(el("span", "char-name", c.character_name));
        row.appendChild(el("span", "char-leader"));
        row.appendChild(el("span", "lines", `${c.line_count} lines`));
        sec.appendChild(row);
      });
      body.appendChild(sec);
    }

    // Credits
    if (ep.credits?.length) {
      const sec = el("div", "modal-section");
      sec.appendChild(el("h3", null, "Credits"));
      const writers = ep.credits.filter((c) => c.role !== "director");
      const directors = ep.credits.filter((c) => c.role === "director");
      writers.forEach((c) => {
        const line = el("div", "credit-line", `${c.name} `);
        line.appendChild(el("span", "role", `(${c.role})`));
        sec.appendChild(line);
      });
      directors.forEach((c) => {
        const line = el("div", "credit-line", `${c.name} `);
        line.appendChild(el("span", "role", "(director)"));
        sec.appendChild(line);
      });
      body.appendChild(sec);
    }

    // Keywords
    if (ep.keywords?.length) {
      const sec = el("div", "modal-section");
      sec.appendChild(el("h3", null, "Keywords"));
      const tags = el("div", "tag-list");
      ep.keywords.slice(0, 25).forEach((k) => {
        tags.appendChild(el("span", "tag", `${k.canonical} ×${k.occurrences}`));
      });
      sec.appendChild(tags);
      body.appendChild(sec);
    }

    // Summary (if available)
    if (ep.summary) {
      const s = ep.summary;

      if (s.themes?.length) {
        const sec = el("div", "modal-section");
        sec.appendChild(el("h3", null, "Themes"));
        const tags = el("div", "tag-list");
        s.themes.forEach((t) => tags.appendChild(el("span", "tag", t)));
        sec.appendChild(tags);
        body.appendChild(sec);
      }

      if (s.places?.length) {
        const sec = el("div", "modal-section");
        sec.appendChild(el("h3", null, "Places"));
        sec.appendChild(el("div", null, s.places.join(" · ")));
        body.appendChild(sec);
      }

      if (s.species?.length) {
        const sec = el("div", "modal-section");
        sec.appendChild(el("h3", null, "Species"));
        sec.appendChild(el("div", null, s.species.join(" · ")));
        body.appendChild(sec);
      }

      if (s.technology?.length) {
        const sec = el("div", "modal-section");
        sec.appendChild(el("h3", null, "Technology"));
        const tags = el("div", "tag-list");
        s.technology.forEach((t) => tags.appendChild(el("span", "tag", t)));
        sec.appendChild(tags);
        body.appendChild(sec);
      }

      if (s.key_events?.length) {
        const sec = el("div", "modal-section");
        sec.appendChild(el("h3", null, "Key Events"));
        [...s.key_events]
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
          .slice(0, 15)
          .forEach((ev) => sec.appendChild(el("div", "event-item", ev.event)));
        body.appendChild(sec);
      }

      if (s.moral_dilemma) {
        const sec = el("div", "modal-section");
        sec.appendChild(el("h3", null, "Moral Dilemma"));
        sec.appendChild(el("div", "dilemma-box", s.moral_dilemma));
        body.appendChild(sec);
      }
    } else {
      const sec = el("div", "modal-section");
      sec.appendChild(el("p", "empty", "No AI summary yet for this episode."));
      body.appendChild(sec);
    }

    // Actions
    const actions = el("div", "modal-actions");
    const addBtn = el("button", "btn btn-primary btn-sm", "＋ Add to playlist");
    addBtn.addEventListener("click", () => promptAddToPlaylist(ep.episode_id));
    actions.appendChild(addBtn);
    if (!state.user) {
      const hint = el("span", "auth-hint", "Sign in to add to playlists");
      actions.appendChild(hint);
    } else if (!canWrite()) {
      const hint = el("span", "auth-hint", "Write access requires admin approval");
      actions.appendChild(hint);
    }
    body.appendChild(actions);

  } catch (err) {
    body.appendChild(el("p", "empty", `Error: ${err.message}`));
  }
}

function closeModal() {
  $("#episode-modal").hidden = true;
}
$("#modal-close").addEventListener("click", closeModal);
$("#episode-modal").addEventListener("click", (e) => {
  if (e.target === $("#episode-modal")) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
});

// ---------------------------------------------------------------------------
// Playlists
// ---------------------------------------------------------------------------
async function loadPlaylists() {
  const list = $("#playlist-list");
  list.innerHTML = "";

  try {
    const data = await api("/playlists");
    state.playlists = data.playlists;
    if (!data.playlists.length) {
      list.appendChild(emptyState("📀", "No playlists yet. Create your first one!"));
      return;
    }
    data.playlists.forEach((p) => {
      const card = el("div", "playlist-card");
      card.appendChild(el("div", "pl-name", p.name));
      if (p.is_smart) card.appendChild(el("div", "pl-smart", "⚡ smart"));
      card.appendChild(el("div", "pl-meta", `${p.episode_count} episode(s)`));
      card.addEventListener("click", () => openPlaylist(p.playlist_id));
      list.appendChild(card);
    });
  } catch (err) {
    list.appendChild(emptyState("⚠️", err.message));
  }
}

async function openPlaylist(id) {
  try {
    const p = await api(`/playlists/${id}`);
    state.currentPlaylist = p;
    const detail = $("#playlist-detail");
    detail.hidden = false;
    $("#playlist-detail-title").textContent = p.name;
    document.querySelectorAll(".pl-detail-actions").forEach((e) => (e.hidden = !canWrite()));
    const grid = $("#playlist-detail-episodes");
    grid.innerHTML = "";
    if (!p.episodes.length) {
      grid.appendChild(emptyState("📀", "Empty playlist — open episodes and add them."));
      return;
    }
    p.episodes.forEach((ep) => {
      const card = el("div", "episode-card");
      card.dataset.episodeId = ep.episode_id;
      card.appendChild(el("span", "ep-badge", `S${ep.season}E${String(ep.episode_number).padStart(2, "0")}`));
      card.appendChild(el("div", "ep-title", ep.title));
      if (canWrite()) {
        const rm = el("button", "ep-remove", "✕");
        rm.title = "Remove from playlist";
        rm.addEventListener("click", (e) => {
          e.stopPropagation();
          if (!confirm(`Remove "${ep.title}" from this playlist?`)) return;
          removeEpisodeFromPlaylist(id, ep.episode_id);
        });
        card.appendChild(rm);
      }
      // Appended after the remove button so the CSS can offset it (see .ep-watched)
      card.appendChild(watchedToggle(ep.episode_id));
      card.addEventListener("click", () => openEpisodeModal(ep.episode_id));
      grid.appendChild(card);
    });

    renderWatchedMarks();
  } catch (err) {
    toast(err.message);
  }
}

async function removeEpisodeFromPlaylist(playlistId, episodeId) {
  try {
    await api(`/playlists/${playlistId}/episodes/${episodeId}`, { method: "DELETE" });
    toast("Removed from playlist ✓");
    openPlaylist(playlistId);
  } catch (err) {
    toast(err.message);
  }
}

$("#pl-rename-btn").addEventListener("click", async () => {
  const p = state.currentPlaylist;
  if (!p) return;
  const name = prompt("Rename playlist:", p.name);
  if (!name || !name.trim() || name.trim() === p.name) return;
  try {
    await api(`/playlists/${p.playlist_id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
    toast(`Renamed to "${name.trim()}" ✓`);
    loadPlaylists();
    openPlaylist(p.playlist_id);
  } catch (err) {
    toast(err.message);
  }
});

$("#pl-delete-btn").addEventListener("click", async () => {
  const p = state.currentPlaylist;
  if (!p) return;
  if (!confirm(`Delete playlist "${p.name}"? This cannot be undone.`)) return;
  try {
    await api(`/playlists/${p.playlist_id}`, { method: "DELETE" });
    state.currentPlaylist = null;
    $("#playlist-detail").hidden = true;
    toast(`Deleted "${p.name}" ✓`);
    loadPlaylists();
  } catch (err) {
    toast(err.message);
  }
});

// ---------------------------------------------------------------------------
// Add to playlist — picker modal
// ---------------------------------------------------------------------------
let _ppEpisodeIds = [];

function openPlaylistPicker(episodeId) {
  _ppEpisodeIds = [episodeId];
  const ep = state.episodes.find((e) => e.episode_id === episodeId);
  $("#pp-episode-label").textContent = ep
    ? `S${ep.season}E${String(ep.episode_number).padStart(2, "0")} — ${ep.title}`
    : "";
  openPlaylistPickerModal();
}

function openPlaylistPickerAll() {
  _ppEpisodeIds = state.episodes.map((e) => e.episode_id);
  const shown = _ppEpisodeIds.length;
  $("#pp-episode-label").textContent =
    `${shown} episode${shown === 1 ? "" : "s"}`;
  openPlaylistPickerModal();
}

function openPlaylistPickerModal() {
  $("#pp-new-name").value = "";
  renderPlaylistPicker();
  $("#playlist-picker").hidden = false;
  // Autofocus the new-playlist field when the list is empty
  if (!state.playlists.length) $("#pp-new-name").focus();
}

function renderPlaylistPicker() {
  const list = $("#pp-list");
  list.innerHTML = "";

  if (!state.playlists.length) {
    list.appendChild(el("div", "pp-empty", "No playlists yet — create one below."));
    return;
  }

  state.playlists.forEach((p) => {
    const label = el("label", "pp-item");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = p.playlist_id;
    cb.dataset.name = p.name;
    label.appendChild(cb);
    label.appendChild(el("span", null, p.name));
    if (p.episode_count !== undefined) {
      label.appendChild(el("span", "pp-count",
        `${p.episode_count} ep${p.episode_count === 1 ? "" : "s"}`));
    }
    list.appendChild(label);
  });
}

function closePlaylistPicker() {
  $("#playlist-picker").hidden = true;
  _ppEpisodeIds = [];
}

$("#pp-close").addEventListener("click", closePlaylistPicker);
$("#pp-cancel-btn").addEventListener("click", closePlaylistPicker);
$("#playlist-picker").addEventListener("click", (e) => {
  if (e.target === $("#playlist-picker")) closePlaylistPicker();
});

$("#pp-create-btn").addEventListener("click", async () => {
  const name = $("#pp-new-name").value.trim();
  if (!name) {
    toast("Playlist needs a name");
    return;
  }
  try {
    const created = await api("/playlists", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description: "", is_smart: false }),
    });
    $("#pp-new-name").value = "";
    await loadPlaylists();
    renderPlaylistPicker();
    // Auto-check the freshly created playlist so it's ready to receive the episode
    const cb = [...document.querySelectorAll("#pp-list input[type=checkbox]")]
      .find((c) => c.value === String(created.playlist_id));
    if (cb) cb.checked = true;
    toast(`Created "${created.name}" ✓`);
  } catch (err) {
    toast(err.message);
  }
});

$("#pp-new-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#pp-create-btn").click();
});

$("#pp-add-btn").addEventListener("click", async () => {
  const checked = [...document.querySelectorAll("#pp-list input[type=checkbox]:checked")];
  if (!checked.length) {
    toast("Select at least one playlist");
    return;
  }
  if (!_ppEpisodeIds.length) return;

  const targets = checked.map((c) => ({
    id: parseInt(c.value, 10),
    name: c.dataset.name ?? `#${c.value}`,
  }));

  let added = 0;
  try {
    for (const t of targets) {
      for (const episodeId of _ppEpisodeIds) {
        await api(`/playlists/${t.id}/episodes`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ episode_id: episodeId }),
        });
        added++;
      }
    }
    toast(`Added ${added} episode${added === 1 ? "" : "s"} across ${targets.length} playlist${targets.length === 1 ? "" : "s"} ✓`);
    const wasCurrent = state.currentPlaylist?.playlist_id &&
      targets.some((t) => t.id === state.currentPlaylist.playlist_id);
    closePlaylistPicker();
    if (wasCurrent) openPlaylist(state.currentPlaylist.playlist_id);
  } catch (err) {
    toast(`Added ${added}, then: ${err.message}`);
  }
});

$("#add-all-btn").addEventListener("click", () => {
  if (!state.user) {
    toast("Sign in to create playlists");
    return;
  }
  if (!canWrite()) {
    toast("Write access requires admin approval");
    return;
  }
  if (!state.episodes.length) return;
  if (!state.playlists.length) {
    loadPlaylists().then(() => openPlaylistPickerAll());
    return;
  }
  openPlaylistPickerAll();
});

async function promptAddToPlaylist(episodeId) {
  if (!state.user) {
    toast("Sign in to create playlists");
    return;
  }
  if (!canWrite()) {
    toast("Write access requires admin approval");
    return;
  }
  if (!state.playlists.length) {
    await loadPlaylists();
  }
  openPlaylistPicker(episodeId);
}

// Playlist creation
$("#playlist-create-btn").addEventListener("click", async () => {
  const name = $("#playlist-name").value.trim();
  const desc = $("#playlist-desc").value.trim();
  if (!name) {
    toast("Playlist needs a name");
    return;
  }
  try {
    await api("/playlists", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description: desc, is_smart: false }),
    });
    $("#playlist-name").value = "";
    $("#playlist-desc").value = "";
    toast(`Created "${name}" ✓`);
    loadPlaylists();
  } catch (err) {
    toast(err.message);
  }
});

// ---------------------------------------------------------------------------
// Admin: user management
// ---------------------------------------------------------------------------
async function loadUsers() {
  const list = $("#user-list");
  list.innerHTML = "";
  if (!isAdmin()) {
    list.appendChild(emptyState("🔒", "Admin only"));
    return;
  }

  try {
    const data = await api("/auth/users");
    const users = data.users;
    if (!users.length) {
      list.appendChild(emptyState("👤", "No users yet."));
      return;
    }
    users.forEach((u) => {
      const row = el("div", "user-row");
      row.appendChild(el("span", "user-email", u.email));
      row.appendChild(el("span", "role-badge", u.role));
      row.appendChild(el("span", "user-meta",
        `joined ${(u.created_at ?? "").slice(0, 10)} · ${u.active_sessions} session(s)`));
      if (u.role !== "admin") {
        const btn = el("button", "btn btn-sm",
          u.role === "writer" ? "Revoke write" : "Grant write");
        btn.addEventListener("click", async () => {
          try {
            await api(`/auth/users/${u.user_id}/role`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ role: u.role === "writer" ? "reader" : "writer" }),
            });
            loadUsers();
          } catch (err) {
            toast(err.message);
          }
        });
        row.appendChild(btn);
      }
      list.appendChild(row);
    });
  } catch (err) {
    list.appendChild(emptyState("⚠️", err.message));
  }
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------
$("#search-btn").addEventListener("click", loadEpisodes);
$("#search-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") loadEpisodes();
});

["season", "character", "keyword", "category", "writer", "director"].forEach((f) => {
  $(`#filter-${f}`).addEventListener("change", () => {
    state.filters[f] = $(`#filter-${f}`).value;
    if (f === "category") loadKeywordDatalist();
    loadEpisodes();
  });
});

$("#filter-clear").addEventListener("click", () => {
  ["season", "character", "keyword", "category", "writer", "director"].forEach((f) => {
    $(`#filter-${f}`).value = "";
    state.filters[f] = "";
  });
  $("#search-input").value = "";
  loadKeywordDatalist();
  loadEpisodes();
});

// Preload character datalist (alphabetical — the API sorts by line count)
(async () => {
  try {
    const data = await api("/characters?limit=1000");
    const dl = $("#character-list");
    [...data.characters]
      .sort((a, b) => a.character_name.localeCompare(b.character_name))
      .slice(0, 500)
      .forEach((c) => {
        const opt = el("option");
        opt.value = c.character_name;
        dl.appendChild(opt);
      });
  } catch { /* non-critical */ }
})();

// Category-aware keyword datalist + placeholder
const CATEGORY_PLACEHOLDERS = {
  place: "Place (e.g. starbase 515)",
  race: "Race / species (e.g. Vulcan)",
  faction: "Faction (e.g. Klingon Empire)",
  technology: "Technology (e.g. cloaking device)",
  theme: "Theme (e.g. duty)",
  ship: "Starship (e.g. Enterprise)",
  character: "Character keyword (e.g. Q)",
};

async function loadKeywordDatalist() {
  const cat = state.filters.category;
  const input = $("#filter-keyword");
  const dl = $("#keyword-list");
  input.placeholder = cat && CATEGORY_PLACEHOLDERS[cat]
    ? CATEGORY_PLACEHOLDERS[cat]
    : "Keyword (e.g. cloaking device)";
  dl.innerHTML = "";
  try {
    const data = await api(`/keywords${cat ? `?category=${encodeURIComponent(cat)}` : ""}`);
    data.keywords.forEach((k) => {
      const opt = el("option");
      opt.value = k.canonical;
      dl.appendChild(opt);
    });
  } catch { /* non-critical */ }
}

// Initial load
loadAuth();
loadKeywordDatalist();
loadEpisodes();
