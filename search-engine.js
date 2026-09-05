// ==========================================================================
// TripSearchEngine — Hybrid version (Option 1)
// 1. Try live Overpass first
// 2. If nothing found → fall back to real curated places
// Always returns a target
// ==========================================================================
(function (global) {
  "use strict";

  // ---------- Rate limiting ----------
  let lastOverpassCall = 0;
  const MIN_INTERVAL_MS = 40000; // 40 seconds

  function getSecondsUntilNextAllowed() {
    const elapsed = Date.now() - lastOverpassCall;
    const remaining = Math.ceil((MIN_INTERVAL_MS - elapsed) / 1000);
    return remaining > 0 ? remaining : 0;
  }

  // ---------- Curated real places (fallback) ----------
  const CURATED = [
    // Present
    { name: "The Last Bookstore", loc: "Los Angeles, USA", lat: 34.0477, lon: -118.2498, desc: "Large independent bookstore still open and staffed.", link: "https://lastbookstorela.com", photoUrl: null, source: "curated", type: "present" },
    { name: "Shakespeare and Company", loc: "Paris, France", lat: 48.8526, lon: 2.3470, desc: "Famous independent bookstore on the Left Bank, still open.", link: "https://shakespeareandcompany.com", photoUrl: null, source: "curated", type: "present" },
    { name: "Labassin Waterfall Restaurant", loc: "Tiaong, Philippines", lat: 13.95, lon: 121.35, desc: "Restaurant with tables in the water at the base of a waterfall.", link: null, photoUrl: null, source: "curated", type: "present" },
    { name: "El Ateneo Grand Splendid", loc: "Buenos Aires, Argentina", lat: -34.599, lon: -58.393, desc: "Bookstore inside a former theatre – still fully open.", link: null, photoUrl: null, source: "curated", type: "present" },
    { name: "Chillout Ice Lounge", loc: "Dubai, UAE", lat: 25.2048, lon: 55.2708, desc: "Ice lounge kept at sub-zero temperatures, currently operating.", link: null, photoUrl: null, source: "curated", type: "present" },

    // Past
    { name: "Crystal Palace site", loc: "Sydenham Hill, London, UK", lat: 51.422, lon: -0.076, desc: "Site of the great glass palace that burned down in 1936.", link: "https://en.wikipedia.org/wiki/The_Crystal_Palace", photoUrl: null, source: "curated", type: "past" },
    { name: "Original Pennsylvania Station site", loc: "New York City, USA", lat: 40.7503, lon: -73.9931, desc: "Location of the famous Beaux-Arts station demolished in the 1960s.", link: null, photoUrl: null, source: "curated", type: "past" },
    { name: "Site of the Great Library of Alexandria", loc: "Alexandria, Egypt", lat: 31.2001, lon: 29.9187, desc: "Approximate location of the ancient library that no longer exists.", link: null, photoUrl: null, source: "curated", type: "past" },
    { name: "Original Globe Theatre site", loc: "Southwark, London, UK", lat: 51.5074, lon: -0.0955, desc: "Location of Shakespeare’s original theatre.", link: "https://en.wikipedia.org/wiki/Globe_Theatre", photoUrl: null, source: "curated", type: "past" },

    // Future / Events
    { name: "Burning Man 2026 – Black Rock City", loc: "Black Rock Desert, Nevada, USA", lat: 40.7869, lon: -119.2042, desc: "Temporary city that will exist 30 August – 7 September 2026.", link: "https://burningman.org", photoUrl: null, source: "curated", type: "future" },
    { name: "EDC Las Vegas 2027", loc: "Las Vegas Motor Speedway, USA", lat: 36.272, lon: -115.010, desc: "Major electronic music festival planned for May 2027.", link: null, photoUrl: null, source: "curated", type: "future" },
    { name: "Tempe Festival of the Arts 2026", loc: "Tempe, Arizona, USA", lat: 33.4255, lon: -111.9400, desc: "Large outdoor arts festival scheduled for December 2026.", link: null, photoUrl: null, source: "curated", type: "future" }
  ];

  // ---------- Overpass helpers ----------
  const OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.osm.ch/api/interpreter"
  ];

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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 14000);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        body: "data=" + encodeURIComponent(query),
        signal: controller.signal
      });
      if (!res.ok) throw new Error(`${endpoint} → ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function queryOverpass(query) {
    const waitSec = getSecondsUntilNextAllowed();
    if (waitSec > 0) {
      const err = new Error(`Rate limited – wait ${waitSec}s`);
      err.rateLimited = true;
      err.waitSeconds = waitSec;
      throw err;
    }

    lastOverpassCall = Date.now();
    const endpoints = [...OVERPASS_ENDPOINTS].sort(() => Math.random() - 0.5);
    const errors = [];

    for (const endpoint of endpoints) {
      try {
        return await queryOverpassOnce(endpoint, query);
      } catch (err) {
        errors.push(err.message || String(err));
        if ((err.message || "").includes("429")) {
          await new Promise(r => setTimeout(r, 6000));
        } else {
          await new Promise(r => setTimeout(r, 600));
        }
      }
    }
    throw new Error(errors.join(" | "));
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

  // ---------- Main function ----------
  async function fetchRandomTarget(map, mode, sec, keyword) {
    // 1. Try live Overpass first
    try {
      const b = map.getBounds();
      const bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];
      const tagPairs = tagsFor(mode, sec);

      const data = await queryOverpass(buildOverpassQuery(bbox, tagPairs, keyword, 35));
      const pool = [];

      for (const el of (data.elements || [])) {
        const t = describeOsmElement(el);
        if (t) pool.push(t);
      }

      // Soft keyword fallback
      if (keyword && pool.length === 0) {
        const data2 = await queryOverpass(buildOverpassQuery(bbox, tagPairs, null, 35));
        for (const el of (data2.elements || [])) {
          const t = describeOsmElement(el);
          if (t) pool.push(t);
        }
      }

      if (pool.length > 0) {
        return { target: pool[Math.floor(Math.random() * pool.length)], widened: false };
      }
    } catch (err) {
      if (err.rateLimited) {
        return {
          rateLimited: true,
          waitSeconds: err.waitSeconds,
          message: err.message
        };
      }
      console.warn("Live Overpass failed, using curated fallback:", err.message);
    }

    // 2. Fallback to curated real places
    let pool = CURATED;

    // Filter by secondary mode if possible
    if (sec === "past" || sec === "future" || sec === "present") {
      const filtered = CURATED.filter(t => t.type === sec);
      if (filtered.length > 0) pool = filtered;
    }

    // Simple keyword filter on curated
    if (keyword) {
      const q = keyword.toLowerCase();
      const filtered = pool.filter(t =>
        t.name.toLowerCase().includes(q) ||
        t.loc.toLowerCase().includes(q) ||
        t.desc.toLowerCase().includes(q)
      );
      if (filtered.length > 0) pool = filtered;
    }

    const target = pool[Math.floor(Math.random() * pool.length)];
    return {
      target: { ...target, desc: target.desc + " (curated fallback)" },
      widened: true
    };
  }

  async function fetchWikipediaThumbnail(wikipediaTag) {
    try {
      const parts = wikipediaTag.split(":");
      const lang = parts.length > 1 ? parts[0] : "en";
      const title = parts.length > 1 ? parts.slice(1).join(":") : parts[0];
      const res = await fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
      if (!res.ok) return null;
      const data = await res.json();
      return (data.thumbnail && data.thumbnail.source) || null;
    } catch {
      return null;
    }
  }

  function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
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
    fetchWikipediaThumbnail,
    pick,
    KEYWORD_IDEAS,
    getSecondsUntilNextAllowed
  };
})(window);
