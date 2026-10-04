(() => {
  "use strict";

  const API = "https://api.telegra.ph";
  const PATH = window.PEEPOFF_TELEGRAPH_PATH || "PeepOff-Arena-Stats-10-04";
  const TOKEN = window.PEEPOFF_TELEGRAPH_TOKEN || "";
  const configured = Boolean(TOKEN);
  const TITLE = "PeepOff Arena Stats";
  const PENDING_KEY = "peepoff-stats-pending";
  const CACHE_KEY = "peepoff-stats-cache";
  const FLUSH_DELAY = 4000;
  const RETRY_DELAY = 15000;
  const BASE_RATING = 1500;

  const empty = () => ({ v: 1, tournaments: 0, picks: 0, songs: {}, champions: {} });
  const clone = (obj) => JSON.parse(JSON.stringify(obj));

  let data = empty();
  let pending = empty();
  let listeners = [];
  let flushTimer = null;
  let flushing = false;
  let offline = false;
  let lastSync = 0;

  function normalize(raw) {
    const out = empty();
    if (!raw || typeof raw !== "object") return out;
    out.tournaments = Number(raw.tournaments) || 0;
    out.picks = Number(raw.picks) || 0;
    for (const [id, rec] of Object.entries(raw.songs || {})) {
      const w = Number(rec && rec.w) || 0;
      const l = Number(rec && rec.l) || 0;
      if (w || l) out.songs[id] = { w, l };
    }
    for (const [id, n] of Object.entries(raw.champions || {})) {
      const count = Number(n) || 0;
      if (count) out.champions[id] = count;
    }
    return out;
  }

  function mergeInto(target, src, sign) {
    target.tournaments += sign * (src.tournaments || 0);
    target.picks += sign * (src.picks || 0);
    for (const [id, rec] of Object.entries(src.songs || {})) {
      const t = target.songs[id] || { w: 0, l: 0 };
      t.w += sign * rec.w;
      t.l += sign * rec.l;
      if (t.w || t.l) target.songs[id] = t;
      else delete target.songs[id];
    }
    for (const [id, n] of Object.entries(src.champions || {})) {
      const c = (target.champions[id] || 0) + sign * n;
      if (c) target.champions[id] = c;
      else delete target.champions[id];
    }
  }

  function view() {
    const out = clone(data);
    mergeInto(out, pending, 1);
    return out;
  }

  function pendingCount() {
    return (
      Math.abs(pending.picks) +
      Math.abs(pending.tournaments) +
      Object.keys(pending.songs).length +
      Object.keys(pending.champions).length
    );
  }

  function notify() {
    for (const fn of listeners) {
      try {
        fn();
      } catch {}
    }
  }

  function persist() {
    try {
      localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    } catch {}
  }

  function cacheSave() {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(data));
    } catch {}
  }

  function restore() {
    try {
      const p = JSON.parse(localStorage.getItem(PENDING_KEY) || "null");
      if (p) pending = normalize(p);
    } catch {}
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
      if (c) data = normalize(c);
    } catch {}
  }

  function extract(page) {
    const nodes = (page && page.result && page.result.content) || [];
    const node = nodes.find((n) => n && n.tag === "pre");
    if (!node || !Array.isArray(node.children)) return empty();
    try {
      return normalize(JSON.parse(node.children.join("")));
    } catch {
      return empty();
    }
  }

  async function load() {
    if (!configured || typeof fetch !== "function") return null;
    try {
      const res = await fetch(`${API}/getPage/${PATH}?return_content=true&ts=${Date.now()}`);
      if (!res.ok) throw new Error(String(res.status));
      data = extract(await res.json());
      offline = false;
      lastSync = Date.now();
      cacheSave();
      notify();
      return data;
    } catch {
      offline = true;
      notify();
      return null;
    }
  }

  function schedule(delay = FLUSH_DELAY) {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, delay);
  }

  async function flush() {
    if (flushing || !configured || typeof fetch !== "function") return;
    if (!pendingCount()) return;
    flushing = true;
    notify();
    const snapshot = clone(pending);
    try {
      const res = await fetch(`${API}/getPage/${PATH}?return_content=true&ts=${Date.now()}`);
      if (!res.ok) throw new Error(String(res.status));
      const fresh = extract(await res.json());
      mergeInto(fresh, snapshot, 1);
      const body = new URLSearchParams({
        access_token: TOKEN,
        title: TITLE,
        content: JSON.stringify([{ tag: "pre", children: [JSON.stringify(fresh)] }]),
      });
      const put = await fetch(`${API}/editPage/${PATH}`, { method: "POST", body });
      if (!put.ok) throw new Error(String(put.status));
      data = fresh;
      mergeInto(pending, snapshot, -1);
      offline = false;
      lastSync = Date.now();
      persist();
      cacheSave();
    } catch {
      offline = true;
      schedule(RETRY_DELAY);
    } finally {
      flushing = false;
      notify();
    }
  }

  function recordPick(winnerId, loserId, sign = 1) {
    const w = String(winnerId);
    const l = String(loserId);
    pending.picks += sign;
    const wr = pending.songs[w] || { w: 0, l: 0 };
    wr.w += sign;
    const lr = pending.songs[l] || { w: 0, l: 0 };
    lr.l += sign;
    pending.songs[w] = wr;
    pending.songs[l] = lr;
    persist();
    schedule();
    notify();
  }

  function recordChampion(id, sign = 1) {
    const key = String(id);
    pending.tournaments += sign;
    pending.champions[key] = (pending.champions[key] || 0) + sign;
    persist();
    schedule();
    notify();
  }

  function ratingOf(rec) {
    return Math.round(BASE_RATING + 400 * Math.log10((rec.w + 2) / (rec.l + 2)));
  }

  function standings() {
    const v = view();
    const rows = Object.entries(v.songs).map(([id, rec]) => ({
      id,
      w: rec.w,
      l: rec.l,
      matches: rec.w + rec.l,
      rating: ratingOf(rec),
      winRate: rec.w / (rec.w + rec.l),
      titles: v.champions[id] || 0,
    }));
    rows.sort((a, b) => {
      if ((a.matches === 0) !== (b.matches === 0)) return a.matches === 0 ? 1 : -1;
      return b.rating - a.rating || b.matches - a.matches || a.id.localeCompare(b.id);
    });
    return { tournaments: v.tournaments, picks: v.picks, rows };
  }

  window.PeepOffStats = {
    recordPick,
    recordChampion,
    load,
    flush,
    standings,
    onUpdate(fn) {
      listeners.push(fn);
      return () => {
        listeners = listeners.filter((f) => f !== fn);
      };
    },
    get status() {
      return { configured, flushing, offline, lastSync, pending: pendingCount() };
    },
  };

  restore();
  if (pendingCount() > 0) schedule(1500);
})();
