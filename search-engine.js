// ==========================================================================
// TripSearchEngine
// 1. Live Overpass search first — all mirrors raced in parallel, first one
//    back wins. Every place comes straight from live OpenStreetMap data.
// 2. If nothing found (or Overpass is unreachable / cooling down) → fetch
//    FRESH live news headlines (GDELT, free & keyless) and geocode them on
//    the fly with Nominatim so they land on the map at real coordinates.
//    NO curated place data exists in this file — the old COUNTRY_CENTROIDS
//    table is gone; every coordinate is resolved live.
// Returns { target, widened } — or null if genuinely nothing turned up.
// ==========================================================================
(function (global) {
  "use strict";

  // ---------- Safe JSON fetch ----------
  // Free APIs often answer HTTP 200 with an HTML error page or an empty
  // body (rate limits, bot filters). res.json() on that throws a confusing
  // SyntaxError. Reading text first gives a clear, reportable error.
  async function fetchJson(url, options = {}, timeoutMs = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`${new URL(url).host} answered with non-JSON (rate-limited or blocked?)`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------- Promise.any replacement ----------
  // Works in every browser (Promise.any needs ES2021) and, when all
  // endpoints fail, reports every error instead of an empty AggregateError.
  function firstSuccess(promises) {
    return new Promise((resolve, reject) => {
      let pending = promises.length;
      if (pending === 0) return reject(new Error("no endpoints to try"));
      const errors = [];
      promises.forEach(p =>
        Promise.resolve(p).then(resolve, err => {
          errors.push(err && err.message ? err.message : String(err));
          if (--pending === 0) reject(new Error(errors.join(" | ")));
        })
      );
    });
  }

  // ---------- Rate limiting (polite spacing for the free Overpass mirrors —
  // never blocks the user: inside the cooldown we just go straight to the
  // fresh-news fallback instead of making them wait) ----------
let lastOverpassCall = 0;
  const MIN_INTERVAL_MS = 15000;

  function canCallOverpassNow() {
    return Date.now() - lastOverpassCall >= MIN_INTERVAL_MS;
  }


  const OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter"
  ];
  // The default "place/present" query ORs together 4 broad tag categories
  // in one call, which measurably takes public Overpass mirrors 8-15s under
  // normal load — a short timeout here was cutting off genuinely-working
  // mirrors before they could ever answer, not just skipping dead ones.
  const OVERPASS_TIMEOUT_MS = 15000;

  const CATEGORY_TAGS = {
    place: {
      present: [
        ["tourism", "attraction|museum|viewpoint|artwork|gallery|zoo"],
        ["amenity", "cafe|restaurant|bar|pub|library|cinema|theatre|place_of_worship"],
        ["leisure", "park|garden|stadium"],
        ["historic", ".*"]
      ],
      past: [["historic", ".*"], ["tourism", "attraction|museum"]],
      future: [["building", "construction"], ["landuse", "construction"]]
    },
    event: {
      present: [
        ["amenity", "theatre|cinema|arts_centre|events_venue|marketplace"],
        ["leisure", "stadium|sports_centre"],
        ["tourism", "theme_park|attraction"]
      ],
      past: [["historic", ".*"]],
      future: [["building", "construction"], ["landuse", "construction"]]
    }
  };

  function tagsFor(mode, sec) {
    if (mode === "both") {
      return [...(CATEGORY_TAGS.place[sec] || CATEGORY_TAGS.place.present),
              ...(CATEGORY_TAGS.event[sec] || CATEGORY_TAGS.event.present)];
    }
    const table = CATEGORY_TAGS[mode] || CATEGORY_TAGS.place;
    return table[sec] || table.present;
  }

  function escapeForQuotedRegex(s) {
    return s.replace(/[\\"[\]().*+?^${}|]/g, "\\$&");
  }

  function buildOverpassQuery(bbox, tagPairs, keyword, limit = 35) {
    const [s, w, n, e] = bbox;
    const esc = keyword ? escapeForQuotedRegex(keyword) : null;
    const clauses = tagPairs.map(([k, v]) => {
      const pattern = v === ".*" ? ".*" : `^(${v})$`;
      const nameFilter = esc ? `["name"~"${esc}",i]` : "";
      return `nwr["${k}"~"${pattern}"]${nameFilter}(${s},${w},${n},${e});`;
    }).join("\n");
    return `[out:json][timeout:15];(${clauses});out center ${limit};`;
  }

  async function queryOverpassOnce(endpoint, query) {
    return fetchJson(endpoint, {
      method: "POST",
      body: "data=" + encodeURIComponent(query)
    }, OVERPASS_TIMEOUT_MS);
  }

  async function queryOverpassRace(query) {
    return firstSuccess(OVERPASS_ENDPOINTS.map(ep => queryOverpassOnce(ep, query)));
  }

  function elCenter(el) {
    if (typeof el.lat === "number" && typeof el.lon === "number") return { lat: el.lat, lon: el.lon };
    if (el.center) return { lat: el.center.lat, lon: el.center.lon };
    return null;
  }

  function describeOsmElement(el) {
    const tags = el.tags || {};
    const coords = elCenter(el);
    if (!coords) return null;

    const name = tags.name || "Unnamed place";
    const label = tags.tourism || tags.amenity || tags.leisure || tags.historic || "Place";
    const loc = [tags["addr:street"], tags["addr:city"] || tags["addr:town"]].filter(Boolean).join(", ") || label;

    let photoUrl = null;
    if (tags.image && /^https?:\/\//i.test(tags.image)) photoUrl = tags.image;
    else if (tags.wikimedia_commons && tags.wikimedia_commons.startsWith("File:")) {
      photoUrl = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(tags.wikimedia_commons.slice(5))}?width=500`;
    }

    return {
      name,
      loc,
      lat: coords.lat,
      lon: coords.lon,
      desc: `Found on OpenStreetMap · ${label}`,
      link: tags.website || tags["contact:website"] || null,
      photoUrl,
      wikipedia: tags.wikipedia || null,
      source: "osm"
    };
  }

  // ---------- Fresh-news fallback (NO curated coordinates) ----------
  // Real, live headlines from free news sites via GDELT (keyless). Where the
  // old version used a hardcoded country-centroid table to place stories,
  // the location is now resolved at request time with Nominatim —
  // OpenStreetMap's free geocoder — so any country works.
  const NEWS_DOMAINS = [
    "bbc.co.uk", "reuters.com", "apnews.com", "theguardian.com",
    "npr.org", "aljazeera.com", "dw.com"
  ];
  const NEWS_TIMEOUT_MS = 12000;
  const GEOCODE_TIMEOUT_MS = 7000;
  // Capped low on purpose: each try is sequential (GDELT + up to N geocode
  // calls stack up), so this bounds worst-case latency instead of letting
  // a single click chain into a near-minute wait.
  const MAX_GEOCODE_TRIES = 2;

  function buildNewsQuery(keyword) {
    const domainClause = "(" + NEWS_DOMAINS.map(d => `domain:${d}`).join(" OR ") + ")";
    return keyword ? `${domainClause} ${keyword}` : domainClause;
  }

  async function geocodeName(name) {
    // Two live strategies: strict country lookup first, then free-text.
    const urls = [
      `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&country=${encodeURIComponent(name)}`,
      `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(name)}`
    ];
    for (const url of urls) {
      try {
        const data = await fetchJson(url, {}, GEOCODE_TIMEOUT_MS);
        if (Array.isArray(data) && data.length && data[0].lat != null && data[0].lon != null) {
          return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
        }
      } catch { /* try the next strategy */ }
    }
    return null;
  }

  async function fetchNewsTarget(keyword, onStatus) {
    const say = m => { if (onStatus) onStatus(m); };
    try {
      // With the keyword first; if that finds nothing, retry with no keyword
      // so the fallback can always surface *some* fresh news.
      const attempts = keyword ? [keyword, null] : [null];
      let articles = [];
      for (const kw of attempts) {
        say("Fetching fresh headlines…");
        try {
          const q = encodeURIComponent(buildNewsQuery(kw));
          const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${q}&mode=artlist&maxrecords=50&timespan=3d&sort=datedesc&format=json`;
          const data = await fetchJson(url, {}, NEWS_TIMEOUT_MS);
          articles = (data && data.articles) || [];
        } catch (e) {
          console.warn("GDELT attempt failed:", e && e.message);
        }
        if (articles.length) break;
      }
      if (!articles.length) return null;

      // Shuffle for the lucky factor, then geocode each story's country
      // (deduped, capped) until one resolves to real coordinates.
      const shuffled = articles.slice().sort(() => Math.random() - 0.5);
      const tried = new Set();
      let tries = 0;

      for (const a of shuffled) {
        if (tries >= MAX_GEOCODE_TRIES) break;
        const where = a.sourcecountry && a.sourcecountry.trim();
        if (!where || tried.has(where)) continue;
        tried.add(where);
        tries++;

        say(`Placing fresh news on the map — locating ${where}…`);
        const coords = await geocodeName(where);
        if (!coords) continue;

        const lat = Math.max(-85, Math.min(85, coords.lat + (Math.random() - 0.5) * 2));
        const lon = coords.lon + (Math.random() - 0.5) * 2;

        return {
          name: a.title || "Untitled story",
          loc: where,
          lat, lon,
          desc: `Live headline from ${a.domain || "a free news site"} · located just now via live geocoding (country-level)`,
          link: a.url || null,
          photoUrl: /^https?:\/\//i.test(a.socialimage || "") ? a.socialimage : null,
          source: "news"
        };
      }
      return null;
    } catch (err) {
      console.warn("News fallback unavailable:", err && err.message);
      return null;
    }
  }

  // ---------- Main ----------
  async function fetchRandomTarget(map, mode, sec, keyword, onStatus) {
    const say = m => { if (onStatus) onStatus(m); };

    // 1. Live Overpass search inside the current map view.
    if (canCallOverpassNow()) {
      try {
        const b = map.getBounds();
        const bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];
        const tagPairs = tagsFor(mode, sec);
        lastOverpassCall = Date.now();

        say("Searching OpenStreetMap live in this view…");
        const data = await queryOverpassRace(buildOverpassQuery(bbox, tagPairs, keyword, 35));
        const pool = [];
        for (const el of (data.elements || [])) {
          const t = describeOsmElement(el);
          if (t) pool.push(t);
        }
        if (pool.length > 0) {
          say("");
          return { target: pool[Math.floor(Math.random() * pool.length)], widened: false };
        }
        say("Nothing matched in this view — falling back to fresh news…");
      } catch (err) {
        console.warn("Live Overpass unavailable, trying live news instead:", err && err.message);
        say("OpenStreetMap unreachable — falling back to fresh news…");
      }
    } else {
      say("Overpass is cooling down — this click uses fresh news…");
    }

    // 2. Fresh live news, geolocated live. If this also comes up empty we
    //    honestly report "no luck" instead of inventing anything.
    const newsTarget = await fetchNewsTarget(keyword, onStatus);
    if (newsTarget) return { target: newsTarget, widened: true };
    return null;
  }

  async function fetchWikipediaThumbnail(wikipediaTag) {
    try {
      const parts = wikipediaTag.split(":");
      const lang = parts.length > 1 ? parts[0] : "en";
      const title = parts.length > 1 ? parts.slice(1).join(":") : parts[0];
      const data = await fetchJson(
        `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
        {}, 8000
      );
      return (data.thumbnail && data.thumbnail.source) || null;
    } catch {
      return null;
    }
  }

  function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // ---------- Funny route ----------
  const FUNNY_VEHICLES = [
    "a caffeinated pigeon courier", "a shopping cart with one wobbly wheel",
    "a unicycle borrowed from a circus", "a suspiciously fast tortoise",
    "a hot air balloon named Gerald", "a fleet of confused Roombas",
    "a llama with a passport", "the last known flying carpet",
    "a golf cart that should not be street legal", "a very motivated goose",
    "a rowboat and pure optimism", "a skateboard with rocket boosters",
    "a rented segway and a dream", "a mysterious portal behind the shed",
    "a marching band that happens to be going that way",
    "a paper airplane, scaled up considerably", "a tandem bike missing its second rider"
  ];
  const FUNNY_HUBS = [
    "the nearest questionable food truck", "a roundabout with strong opinions",
    "the town's one confusing bus stop", "a suspiciously well-lit alley",
    "a vending machine that dispenses directions", "the local pigeon parliament",
    "a fortune teller's tent", "an unattended lemonade stand",
    "a payphone that still somehow works", "a duck pond with excellent Wi-Fi"
  ];

  function distanceJoke(km) {
    if (km > 8000) return " (bring snacks, and maybe a visa)";
    if (km > 3000) return " (pack a book, it's a while)";
    if (km > 500) return " (stretch your legs first)";
    return "";
  }

  function buildFunnyRoute(startName, target, startLat, startLon, isReturn) {
    const stages = [];
    const from = startName || "your current position";
    stages.push(`Leave ${from} aboard ${pick(FUNNY_VEHICLES)}`);
    stages.push(`Stop at ${pick(FUNNY_HUBS)} to ask for directions (they will be confidently wrong)`);

    let distanceLabel = "";
    if (typeof startLat === "number" && typeof startLon === "number") {
      const km = Math.round(haversineKm(startLat, startLon, target.lat, target.lon));
      distanceLabel = ` — roughly ${km.toLocaleString()} km${distanceJoke(km)}`;
    }
    stages.push(`Cover the distance to ${target.loc} via the scenic, deeply unnecessary route${distanceLabel}`);
    stages.push(`Arrive at ${target.name}, slightly dizzy but triumphant`);
    if (isReturn) stages.push(`Return leg: same nonsense, reversed, aboard ${pick(FUNNY_VEHICLES)}`);
    return stages;
  }

  const KEYWORD_IDEAS = [
    "castle", "waterfall", "lighthouse", "cave", "bridge", "market",
    "brewery", "vineyard", "island", "ruins", "garden", "tower",
    "monastery", "windmill", "harbour", "canyon", "volcano", "lake",
    "fortress", "abbey", "palace", "museum", "library", "park", "beach"
  ];

  // Public API
  global.TripSearchEngine = {
    fetchRandomTarget,
    fetchNewsTarget,
    fetchWikipediaThumbnail,
    buildFunnyRoute,
    haversineKm,
    pick,
    KEYWORD_IDEAS
  };
})(window);
