// Regenerates songs.js with Lil Peep's official streamable catalog from the Deezer API.
// Usage: node update-songs.mjs
import { writeFileSync } from "node:fs";

const ARTIST_ID = 11420468;
const API = "https://api.deezer.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(API + path);
    if (res.status === 429) {
      await sleep(1500);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
    const json = await res.json();
    if (json.error) {
      if (json.error.code === 4) {
        await sleep(1500);
        continue;
      }
      throw new Error(`API error ${json.error.code}: ${json.error.message} (${path})`);
    }
    return json;
  }
  throw new Error(`Gave up after retries: ${path}`);
}

// Collapses alternate versions of the same song (remixes, singles, deluxe/OG copies).
function normTitle(s) {
  return clean(s)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[([][^)\]]*(feat|ft\.?|remix|remaster|bonus|deluxe|version|edit|live|demo|instrumental|sped|slowed|og\b)[^)\]]*[)\]]/g, "")
    .replace(/\s*-\s*(feat|ft|remaster|remix|version|live|demo|bonus|single).*$/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

const BAD = /tribute|karaoke|type beat|originally performed|cover version|made famous/i;

const clean = (s) =>
  (s || "").replace(/[\u200b-\u200d\u00ad\ufeff]/gi, "").replace(/\s+/g, " ").trim();

async function main() {
  const albums = [];
  for (let index = 0; ; index += 100) {
    const page = await api(`/artist/${ARTIST_ID}/albums?limit=100&index=${index}`);
    albums.push(...page.data);
    if (!page.next) break;
    await sleep(150);
  }
  console.log(`albums: ${albums.length}`);

  const raw = [];
  for (const album of albums) {
    if (BAD.test(album.title)) {
      console.log(`  skip: ${album.title}`);
      continue;
    }
    let path = `/album/${album.id}/tracks?limit=100`;
    while (path) {
      const page = await api(path);
      for (const t of page.data) raw.push({ ...t, _album: { ...album, title: clean(album.title) } });
      path = page.next ? page.next.replace(API, "") : null;
      await sleep(140);
    }
  }
  console.log(`raw tracks: ${raw.length}`);

  // verified features on other artists' releases
  const EXTRA_TRACK_IDS = [
    1494409192, 600314212, 118761662, 4203098342, 4203031522, 2281013757, 451082452,
    1143684982, 546890472, 1821665327, 2474244831, 1123691612, 124337534, 3229540321,
    403284132, 3263494271, 416904852, 920167652, 2240888237, 1458995672, 1845182007,
    1686044037, 1222562562, 377239171, 920878762, 2985396791, 716159692, 1303372852,
    528837031, 528837041, 528837051, 528837061, 528837071, 528837081,
  ];
  for (const id of EXTRA_TRACK_IDS) {
    const t = await api(`/track/${id}`);
    const album = await api(`/album/${t.album.id}`);
    raw.push({ ...t, _album: { ...album, title: clean(album.title) } });
    await sleep(150);
  }
  console.log(`raw tracks with features: ${raw.length}`);

  // Every release fetched here is credited to Lil Peep, so collabs where the
  // track artist is the other act (e.g. Marshmello on "Spotlight") stay in.
  const filtered = raw.filter((t) => {
    const artist = (t.artist?.name || "").toLowerCase();
    if (BAD.test(t.title) || BAD.test(artist) || BAD.test(t._album.title)) {
      if (process.env.DEBUG) console.log(`  dropped (bad match): ${t.title} [${t._album.title}]`);
      return false;
    }
    return true;
  });
  console.log(`after filter: ${filtered.length}`);

  // Among copies of the same song (single / album / compilation / live / OG),
  // the original release wins so we keep its art and metadata.
  function better(a, b) {
    const da = a._album.release_date || "9999-99-99";
    const db = b._album.release_date || "9999-99-99";
    if (da !== db) return da < db;
    const score = (t) =>
      (t.preview ? 2 : 0) + (t.title.includes("(") ? 0 : 1) - (/og version/i.test(t._album.title) ? 2 : 0);
    return score(a) > score(b);
  }

  const best = new Map();
  const merged = new Map();
  for (const t of filtered) {
    const key = normTitle(t.title);
    if (!key) continue;
    const cur = best.get(key);
    if (!cur || better(t, cur)) best.set(key, t);
    if (!merged.has(key)) merged.set(key, []);
    merged.get(key).push(t);
  }
  console.log(`unique songs: ${best.size}`);
  const multi = [...merged.entries()].filter(([, list]) => list.length > 1);
  console.log(`merged duplicates: ${multi.length}`);
  if (process.env.DEBUG) {
    for (const [key, list] of multi) {
      const win = best.get(key);
      console.log(`  ${key}:`);
      for (const t of list) console.log(`    ${t === win ? ">" : " "} [${t.title}] ${t._album.title} (${t._album.release_date})`);
    }
  }

  const songs = [...best.values()]
    .sort((a, b) =>
      (a._album.release_date || "").localeCompare(b._album.release_date || "") ||
      a.title.localeCompare(b.title)
    )
    .map((t) => ({
      id: t.id,
      title: clean(t.title),
      album: t._album.title,
      cover: t._album.cover_big || t._album.cover_medium || "",
      dur: t.duration,
      link: t.link,
    }));

  const body = songs.map((s) => "  " + JSON.stringify(s) + ",").join("\n");
  const out =
    `// Lil Peep — official streamable catalog from the Deezer API.\n` +
    `// Generated ${new Date().toISOString().slice(0, 10)}. Regenerate with: node update-songs.mjs\n` +
    `window.PEEP_SONGS = [\n${body}\n];\n`;
  writeFileSync(new URL("./songs.js", import.meta.url), out);
  console.log(`wrote songs.js (${songs.length} songs)`);

  const previewless = songs.filter((s) => !s.cover).length;
  if (previewless) console.log(`songs without cover: ${previewless}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
