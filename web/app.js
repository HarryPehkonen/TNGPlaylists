/**
 * TNGPlaylists — frontend app logic
 * Vanilla JS (no framework), mirrors the Notes app's no-build philosophy.
 */

const API_BASE = "/api";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  tab: "browse",
  episodes: [],
  searchMode: "",
  characters: [],
  playlists: [],
  currentPlaylist: null,
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
    if (tab === "characters") loadCharacters();
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

  if (!episodes.length) {
    grid.appendChild(emptyState("🔭", "No episodes found. Try different filters."));
    return;
  }

  episodes.forEach((ep) => {
    const card = el("div", "episode-card");
    const badge = el("span", "ep-badge", `S${ep.season}E${String(ep.episode_number).padStart(2, "0")}`);
    const title = el("div", "ep-title", ep.title);
    card.appendChild(badge);
    card.appendChild(title);

    const meta = el("div", "ep-meta");
    if (ep.original_air_date) meta.appendChild(document.createTextNode(`Aired ${ep.original_air_date}`));
    card.appendChild(meta);

    if (mode === "semantic" && ep.similarity) {
      const sim = el("div", "ep-sim", `${(parseFloat(ep.similarity) * 100).toFixed(0)}% match`);
      card.appendChild(sim);
    }

    card.addEventListener("click", () => openEpisodeModal(ep.episode_id));
    grid.appendChild(card);
  });
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
        row.appendChild(el("span", null, c.character_name));
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
    const grid = $("#playlist-detail-episodes");
    grid.innerHTML = "";
    if (!p.episodes.length) {
      grid.appendChild(emptyState("📀", "Empty playlist — open episodes and add them."));
      return;
    }
    p.episodes.forEach((ep) => {
      const card = el("div", "episode-card");
      card.appendChild(el("span", "ep-badge", `S${ep.season}E${String(ep.episode_number).padStart(2, "0")}`));
      card.appendChild(el("div", "ep-title", ep.title));
      card.addEventListener("click", () => openEpisodeModal(ep.episode_id));
      grid.appendChild(card);
    });
  } catch (err) {
    toast(err.message);
  }
}

async function promptAddToPlaylist(episodeId) {
  if (!state.playlists.length) {
    await loadPlaylists();
  }
  if (!state.playlists.length) {
    const name = prompt(
      "No playlists yet. Create one to add this episode:\nEnter a playlist name:",
    );
    if (!name || !name.trim()) return;
    try {
      const created = await api("/playlists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), description: "", is_smart: false }),
      });
      await api(`/playlists/${created.playlist_id}/episodes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ episode_id: episodeId }),
      });
      state.playlists.push(created);
      toast(`Created "${created.name}" and added episode ✓`);
      return;
    } catch (err) {
      toast(err.message);
      return;
    }
  }

  const names = state.playlists.map((p) => p.name);
  const pick = prompt(`Add to playlist:\n${names.map((n, i) => `${i + 1}. ${n}`).join("\n")}`);
  if (!pick) return;
  const idx = parseInt(pick, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= state.playlists.length) {
    toast("Invalid selection");
    return;
  }

  try {
    await api(`/playlists/${state.playlists[idx].playlist_id}/episodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ episode_id: episodeId }),
    });
    toast(`Added to "${state.playlists[idx].name}" ✓`);
    if (state.currentPlaylist?.playlist_id === state.playlists[idx].playlist_id) {
      openPlaylist(state.playlists[idx].playlist_id);
    }
  } catch (err) {
    toast(err.message);
  }
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
// Characters
// ---------------------------------------------------------------------------
async function loadCharacters() {
  const list = $("#character-list");
  const q = $("#char-search-input").value.trim();
  list.innerHTML = "";
  $("#loading").hidden = false;

  try {
    const params = new URLSearchParams({ limit: "500" });
    if (q) params.set("q", q);
    const data = await api(`/characters?${params}`);
    state.characters = data.characters;

    if (!data.characters.length) {
      list.appendChild(emptyState("👤", "No characters found."));
      $("#loading").hidden = true;
      return;
    }

    data.characters.slice(0, 200).forEach((c) => {
      const card = el("div", "character-card");
      card.appendChild(el("div", "ch-name", c.character_name));
      card.appendChild(el("div", "ch-stats", `${c.total_lines} lines across ${c.episode_count} episodes`));
      card.addEventListener("click", () => openCharacterModal(c.character_name));
      list.appendChild(card);
    });
  } catch (err) {
    list.appendChild(emptyState("⚠️", err.message));
  }
  $("#loading").hidden = true;
}

async function openCharacterModal(name) {
  const modal = $("#episode-modal");
  const body = $("#modal-body");
  body.innerHTML = "";
  modal.hidden = false;

  try {
    const c = await api(`/characters/${encodeURIComponent(name)}`);
    body.appendChild(el("h2", null, c.character_name));
    body.appendChild(el("div", "modal-sub", `${c.total_lines} lines across ${c.episode_count} episodes`));

    const sec = el("div", "modal-section");
    sec.appendChild(el("h3", null, "Episodes"));
    c.episodes.forEach((ep) => {
      const row = el("div", "char-row");
      const label = el("span", null, `S${ep.season}E${String(ep.episode_number).padStart(2, "0")} — ${ep.title}`);
      row.appendChild(label);
      row.appendChild(el("span", "lines", `${ep.line_count} lines`));
      row.addEventListener("click", () => {
        closeModal();
        setTimeout(() => openEpisodeModalBySeason(ep.season, ep.episode_number), 50);
      });
      sec.appendChild(row);
    });
    body.appendChild(sec);
  } catch (err) {
    body.appendChild(el("p", "empty", err.message));
  }
}

// Find episode_id from season+episode number in current state, else fetch
async function openEpisodeModalBySeason(season, epNum) {
  const match = state.episodes.find((e) => e.season === season && e.episode_number === epNum);
  if (match) {
    openEpisodeModal(match.episode_id);
    return;
  }
  // Fetch by search
  const data = await api(`/search?season=${season}`);
  const found = data.results.find((e) => e.episode_number === epNum);
  if (found) openEpisodeModal(found.episode_id);
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------
$("#search-btn").addEventListener("click", loadEpisodes);
$("#search-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") loadEpisodes();
});
$("#char-search-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") loadCharacters();
});
$("#char-search-input").addEventListener("input", debounce(loadCharacters, 400));

["season", "character", "keyword", "category", "writer", "director"].forEach((f) => {
  $(`#filter-${f}`).addEventListener("change", () => {
    state.filters[f] = $(`#filter-${f}`).value;
    loadEpisodes();
  });
});

$("#filter-clear").addEventListener("click", () => {
  ["season", "character", "keyword", "category", "writer", "director"].forEach((f) => {
    $(`#filter-${f}`).value = "";
    state.filters[f] = "";
  });
  $("#search-input").value = "";
  loadEpisodes();
});

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// Preload character datalist
(async () => {
  try {
    const data = await api("/characters?limit=500");
    const dl = $("#character-list");
    data.characters.slice(0, 200).forEach((c) => {
      const opt = el("option");
      opt.value = c.character_name;
      dl.appendChild(opt);
    });
  } catch { /* non-critical */ }
})();

// Initial load
loadEpisodes();
