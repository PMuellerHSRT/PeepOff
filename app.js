(() => {
  "use strict";

  const CATALOG = window.PEEP_SONGS || [];
  const TOTAL = CATALOG.length;
  const KEY = "peepoff-v1-" + TOTAL;
  const AUDIO_KEY = "peepoff-audio";
  const MAX_UNDO = 40;

  const $ = (id) => document.getElementById(id);
  const els = {
    game: $("game"),
    champion: $("champion"),
    roundLabel: $("roundLabel"),
    matchLabel: $("matchLabel"),
    leftLabel: $("leftLabel"),
    progressFill: $("progressFill"),
    song: [$("songA"), $("songB")],
    art: [$("artA"), $("artB")],
    title: [$("titleA"), $("titleB")],
    album: [$("albumA"), $("albumB")],
    dur: [$("durA"), $("durB")],
    play: [$("playA"), $("playB")],
    undoBtn: $("undoBtn"),
    restartBtn: $("restartBtn"),
    againBtn: $("againBtn"),
    newBtn: $("newBtn"),
    champArt: $("champArt"),
    champTitle: $("champTitle"),
    champAlbum: $("champAlbum"),
    champStats: $("champStats"),
    footerCount: $("footerCount"),
    toast: $("toast"),
    volumeSlider: $("volumeSlider"),
    muteBtn: $("muteBtn"),
  };

  let state = null;
  let undoStack = [];
  let locked = false;
  let playingIdx = null;
  let playToken = 0;
  let audio = null;
  let volume = 0.9;
  let muted = false;
  const previewCache = new Map();

  try {
    const prefs = JSON.parse(localStorage.getItem(AUDIO_KEY) || "");
    if (typeof prefs.volume === "number" && prefs.volume >= 0 && prefs.volume <= 1) volume = prefs.volume;
    muted = prefs.muted === true;
  } catch {}

  const fmtDur = (sec) =>
    `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /* ---------- tournament state ---------- */

  function freshState(seed) {
    const order = seed ? seed.slice() : shuffle([...CATALOG.keys()]);
    return {
      seed: order,
      current: order.slice(),
      playable: [],
      bye: null,
      matchIdx: 0,
      winners: [],
      round: 0,
      played: 0,
      champion: null,
    };
  }

  function beginRound() {
    state.round++;
    state.playable = state.current.slice();
    state.bye = null;
    if (state.playable.length > 1 && state.playable.length % 2 === 1) {
      state.bye = state.playable.pop();
    }
    state.matchIdx = 0;
    state.winners = [];
  }

  function currentMatch() {
    const i = state.matchIdx * 2;
    return [state.playable[i], state.playable[i + 1]];
  }

  function validSnapshot(s) {
    if (!s || !Array.isArray(s.current) || !Array.isArray(s.playable) || !Array.isArray(s.winners)) return false;
    const ids = [...s.current, ...s.playable, ...s.winners];
    if (s.bye !== null && s.bye !== undefined) ids.push(s.bye);
    if (s.champion !== null && s.champion !== undefined) ids.push(s.champion);
    return ids.every((x) => Number.isInteger(x) && x >= 0 && x < TOTAL);
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({ state, undo: undoStack.slice(-MAX_UNDO) }));
    } catch {}
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!validSnapshot(data.state)) return null;
      undoStack = Array.isArray(data.undo) ? data.undo.filter(validSnapshot) : [];
      return data.state;
    } catch {
      return null;
    }
  }

  function pushUndo() {
    undoStack.push(JSON.parse(JSON.stringify(state)));
    if (undoStack.length > MAX_UNDO) undoStack.shift();
  }

  /* ---------- gameplay ---------- */

  function pick(which) {
    if (locked || state.champion !== null) return;
    const [a, b] = currentMatch();
    if (a === undefined || b === undefined) return;
    locked = true;
    stopPreview();

    const winner = which === 0 ? a : b;
    els.song[which].classList.add("winner");
    els.song[1 - which].classList.add("loser");
    pushUndo();

    window.setTimeout(() => {
      state.winners.push(winner);
      state.matchIdx++;
      state.played++;

      if (state.matchIdx * 2 >= state.playable.length) {
        const next = state.winners.slice();
        if (state.bye !== null) next.push(state.bye);
        if (next.length === 1) {
          state.current = next;
          state.champion = next[0];
        } else {
          state.current = next;
          beginRound();
        }
      }

      for (const el of els.song) el.classList.remove("winner", "loser");
      save();
      render();
      locked = false;
    }, 280);
  }

  function undo() {
    if (locked || !undoStack.length) return;
    state = undoStack.pop();
    stopPreview();
    save();
    render();
    toast("Undid last pick");
  }

  function restart(seed) {
    state = freshState(seed);
    beginRound();
    undoStack = [];
    stopPreview();
    save();
    render();
  }

  /* ---------- rendering ---------- */

  function render() {
    const hasChampion = state.champion !== null;
    els.game.hidden = hasChampion;
    els.champion.hidden = !hasChampion;
    els.undoBtn.disabled = undoStack.length === 0;
    if (hasChampion) renderChampion(state.champion);
    else renderMatch();
  }

  function renderMatch() {
    const [a, b] = currentMatch();
    [a, b].forEach((id, i) => {
      const s = CATALOG[id];
      els.art[i].src = s.cover;
      els.art[i].alt = `${s.title} — ${s.album}`;
      els.title[i].textContent = s.title;
      els.album[i].textContent = s.album;
      els.dur[i].textContent = fmtDur(s.dur);
      els.song[i].setAttribute("aria-label", `Pick ${s.title} by ${s.album}`);
      setPlayState(i, null);
    });

    const matchesThisRound = state.playable.length >> 1;
    els.roundLabel.textContent = `Round ${state.round}`;
    els.matchLabel.textContent = `Match ${state.matchIdx + 1} of ${matchesThisRound}`;
    els.leftLabel.textContent = `${state.current.length - state.matchIdx} songs left`;
    els.progressFill.style.width = `${(state.played / (TOTAL - 1)) * 100}%`;
  }

  function renderChampion(id) {
    const s = CATALOG[id];
    els.champArt.src = s.cover;
    els.champArt.alt = `${s.title} — ${s.album}`;
    els.champTitle.textContent = s.title;
    els.champAlbum.textContent = s.album;
    els.champStats.textContent = `Survived ${state.round} rounds and ${state.played} picks out of ${TOTAL} songs.`;
  }

  /* ---------- previews (fresh signed URLs via Deezer JSONP) ---------- */

  let jsonpN = 0;
  function jsonp(url) {
    return new Promise((resolve, reject) => {
      const cb = "__peepoffCb" + ++jsonpN;
      const script = document.createElement("script");
      const timer = window.setTimeout(() => {
        cleanup();
        reject(new Error("timeout"));
      }, 10000);
      function cleanup() {
        window.clearTimeout(timer);
        delete window[cb];
        script.remove();
      }
      window[cb] = (data) => {
        cleanup();
        resolve(data);
      };
      script.onerror = () => {
        cleanup();
        reject(new Error("network"));
      };
      script.src = `${url}${url.includes("?") ? "&" : "?"}output=jsonp&callback=${cb}`;
      document.head.appendChild(script);
    });
  }

  async function getPreview(trackId) {
    const hit = previewCache.get(trackId);
    if (hit && Date.now() - hit.at < 8 * 60 * 1000) return hit.url;
    const data = await jsonp(`https://api.deezer.com/track/${trackId}`);
    if (!data || !data.preview) throw new Error("no preview");
    previewCache.set(trackId, { url: data.preview, at: Date.now() });
    return data.preview;
  }

  function applyVolume() {
    if (audio) {
      audio.volume = volume;
      audio.muted = muted;
    }
    els.volumeSlider.value = String(volume);
    els.muteBtn.classList.toggle("muted", muted || volume === 0);
    els.muteBtn.setAttribute("aria-pressed", String(muted));
    els.muteBtn.title = muted ? "Unmute (M)" : "Mute (M)";
    els.muteBtn.setAttribute("aria-label", muted ? "Unmute" : "Mute");
  }

  function saveAudioPrefs() {
    try {
      localStorage.setItem(AUDIO_KEY, JSON.stringify({ volume, muted }));
    } catch {}
  }

  function getAudio() {
    if (!audio) {
      audio = new Audio();
      audio.preload = "none";
      audio.addEventListener("ended", () => {
        setPlayState(playingIdx, null);
        playingIdx = null;
      });
      applyVolume();
    }
    return audio;
  }

  function setPlayState(i, mode) {
    const btn = els.play[i];
    btn.classList.toggle("loading", mode === "loading");
    btn.classList.toggle("playing", mode === "playing");
    btn.disabled = mode === "loading";
    btn.querySelector(".ico").textContent = mode === "playing" ? "\u275a\u275a" : "\u25b6";
  }

  function stopPreview() {
    playToken++;
    playingIdx = null;
    if (audio) audio.pause();
    setPlayState(0, null);
    setPlayState(1, null);
  }

  async function togglePlay(i) {
    const [a, b] = currentMatch();
    const song = CATALOG[i === 0 ? a : b];
    if (!song) return;

    const player = getAudio();
    if (playingIdx === i && !player.paused) {
      player.pause();
      setPlayState(i, null);
      playingIdx = null;
      return;
    }

    stopPreview();
    const token = playToken;
    playingIdx = i;
    setPlayState(i, "loading");

    try {
      const url = await getPreview(song.id);
      if (token !== playToken) return;
      player.src = url;
      await player.play();
      if (token !== playToken) {
        player.pause();
        return;
      }
      setPlayState(i, "playing");
    } catch {
      if (token !== playToken) return;
      setPlayState(i, null);
      playingIdx = null;
      toast("Couldn't load the preview — are you online?");
    }
  }

  /* ---------- toast ---------- */

  let toastTimer = null;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.hidden = false;
    requestAnimationFrame(() => els.toast.classList.add("show"));
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      els.toast.classList.remove("show");
      window.setTimeout(() => {
        els.toast.hidden = true;
      }, 220);
    }, 2200);
  }

  /* ---------- wiring ---------- */

  els.song.forEach((el, i) => {
    el.addEventListener("click", () => pick(i));
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        pick(i);
      }
    });
  });

  els.play.forEach((btn, i) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePlay(i);
    });
  });

  els.volumeSlider.addEventListener("input", () => {
    volume = Number(els.volumeSlider.value);
    if (volume > 0) muted = false;
    applyVolume();
    saveAudioPrefs();
  });

  els.muteBtn.addEventListener("click", () => {
    muted = !muted;
    applyVolume();
    saveAudioPrefs();
  });

  document.addEventListener("keydown", (e) => {
    const t = e.target;
    if (t instanceof HTMLElement) {
      if (t.tagName === "TEXTAREA" || t.isContentEditable) return;
      if (t.tagName === "INPUT") {
        if (t.type !== "range") return;
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") return;
      }
    }
    if (e.key === " " || e.key === "Enter") return;
    if (e.key === "ArrowLeft" || e.key === "1") pick(0);
    else if (e.key === "ArrowRight" || e.key === "2") pick(1);
    else if (e.key === "q" || e.key === "Q") togglePlay(0);
    else if (e.key === "w" || e.key === "W") togglePlay(1);
    else if (e.key === "m" || e.key === "M") {
      muted = !muted;
      applyVolume();
      saveAudioPrefs();
    } else if (e.key === "z" || e.key === "Z") undo();
  });

  els.undoBtn.addEventListener("click", undo);
  els.restartBtn.addEventListener("click", () => {
    if (window.confirm("Start a fresh bracket? Current progress will be lost.")) restart(null);
  });
  els.againBtn.addEventListener("click", () => restart(state.seed));
  els.newBtn.addEventListener("click", () => restart(null));

  /* ---------- boot ---------- */

  function init() {
    if (TOTAL < 2) {
      document.querySelector(".wrap").innerHTML = "<p>Could not load the song catalog.</p>";
      return;
    }
    els.footerCount.textContent = `${TOTAL} songs · official Deezer catalog`;
    applyVolume();
    state = load();
    if (!state) {
      state = freshState();
      beginRound();
      save();
    }
    render();
  }

  init();
})();
