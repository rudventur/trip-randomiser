// ==========================================================================
// TripSearchEngine
// 1. Try live Overpass first — all mirrors raced in parallel, first one back wins.
// 2. If nothing found → fall back to real, live news headlines (free news
//    sites, via GDELT's free API) placed on the map. No hardcoded/curated
//    list of places — every result is live data.
// Returns a target, or null if genuinely nothing turned up.
// ==========================================================================
(function (global) {
  "use strict";

  // ---------- Rate limiting (polite spacing for the free Overpass mirrors —
  // never blocks the user: if we're inside the cooldown we just skip
  // straight to the news fallback instead of making them wait) ----------
  let lastOverpassCall = 0;
  const MIN_INTERVAL_MS = 15000; // 15 seconds

  function canCallOverpassNow() {
    return Date.now() - lastOverpassCall >= MIN_INTERVAL_MS;
  }

  // ---------- Overpass helpers ----------
  // overpass.osm.ch was dropped: verified it returns a "successful" but
  // permanently empty result set (even for node(1), which must always
  // exist), so it could silently win the race with garbage and make every
  // search look like it found nothing.
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_MS);
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

  // Race every mirror at once instead of trying them one after another with
  // backoff delays in between — whichever responds first wins, and a slow
  // or dead mirror no longer costs the user extra seconds.
  async function queryOverpassRace(query) {
    const attempts = OVERPASS_ENDPOINTS.map(ep => queryOverpassOnce(ep, query));
    return await Promise.any(attempts);
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

  // ---------- Live news fallback (free news sites, via GDELT's free,
  // keyless news API) — replaces the old hardcoded curated list. Every
  // result here is a real, live headline linking back to the original
  // article, dropped on the map at its reporting country's location. ----------
  const NEWS_DOMAINS = [
    "bbc.co.uk", "reuters.com", "apnews.com", "theguardian.com",
    "npr.org", "aljazeera.com", "dw.com"
  ];
  const NEWS_TIMEOUT_MS = 15000;

  // Rough country centroids so a real headline can be placed on the map
  // without an extra geocoding round trip (keeps the fallback fast).
  const COUNTRY_CENTROIDS = {
    "united states": [39.8, -98.6], "canada": [56.1, -106.3], "mexico": [23.6, -102.6],
    "united kingdom": [54.0, -2.9], "ireland": [53.4, -8.2], "france": [46.6, 2.2],
    "germany": [51.2, 10.4], "spain": [40.0, -3.7], "portugal": [39.6, -8.0],
    "italy": [42.8, 12.6], "netherlands": [52.2, 5.5], "belgium": [50.5, 4.5],
    "switzerland": [46.8, 8.2], "austria": [47.5, 14.6], "sweden": [62.0, 15.0],
    "norway": [64.6, 11.5], "denmark": [56.0, 9.5], "finland": [64.9, 26.0],
    "iceland": [64.9, -19.0], "poland": [52.0, 19.1], "czech republic": [49.8, 15.5],
    "slovakia": [48.7, 19.7], "hungary": [47.2, 19.5], "romania": [45.9, 24.9],
    "bulgaria": [42.7, 25.5], "greece": [39.1, 21.8], "turkey": [39.0, 35.2],
    "ukraine": [48.4, 31.2], "belarus": [53.7, 27.9], "russia": [61.5, 105.3],
    "serbia": [44.0, 21.0], "croatia": [45.1, 15.2], "bosnia and herzegovina": [44.0, 17.7],
    "slovenia": [46.1, 14.8], "albania": [41.2, 20.2], "north macedonia": [41.6, 21.7],
    "moldova": [47.2, 28.5], "lithuania": [55.2, 23.9], "latvia": [56.9, 24.6],
    "estonia": [58.6, 25.0], "georgia": [42.3, 43.4], "armenia": [40.1, 45.0],
    "azerbaijan": [40.1, 47.6], "kazakhstan": [48.0, 66.9], "uzbekistan": [41.4, 64.6],
    "china": [35.9, 104.2], "japan": [36.2, 138.3], "south korea": [35.9, 127.8],
    "north korea": [40.3, 127.5], "taiwan": [23.7, 121.0], "hong kong": [22.3, 114.2],
    "mongolia": [46.9, 103.8], "india": [22.4, 78.7], "pakistan": [30.4, 69.3],
    "bangladesh": [23.7, 90.4], "sri lanka": [7.9, 80.8], "nepal": [28.4, 84.1],
    "afghanistan": [33.9, 67.7], "iran": [32.4, 53.7], "iraq": [33.2, 43.7],
    "syria": [34.8, 39.0], "lebanon": [33.9, 35.9], "israel": [31.0, 34.9],
    "palestinian territories": [31.9, 35.2], "jordan": [30.6, 36.2], "saudi arabia": [24.0, 45.1],
    "yemen": [15.6, 48.0], "united arab emirates": [23.4, 53.8], "qatar": [25.4, 51.2],
    "kuwait": [29.3, 47.5], "oman": [21.5, 55.9], "indonesia": [-2.5, 118.0],
    "philippines": [12.9, 121.8], "vietnam": [14.1, 108.3], "thailand": [15.9, 100.9],
    "malaysia": [4.2, 101.9], "singapore": [1.35, 103.8], "myanmar": [21.9, 96.0],
    "cambodia": [12.6, 105.0], "laos": [19.9, 102.5], "australia": [-25.3, 133.8],
    "new zealand": [-41.0, 174.9], "papua new guinea": [-6.3, 143.9], "fiji": [-17.7, 178.1],
    "brazil": [-10.3, -53.2], "argentina": [-35.4, -65.2], "chile": [-35.7, -71.5],
    "colombia": [4.6, -74.3], "peru": [-9.2, -75.0], "venezuela": [7.1, -66.1],
    "ecuador": [-1.8, -78.2], "bolivia": [-16.3, -63.6], "paraguay": [-23.4, -58.4],
    "uruguay": [-32.5, -55.8], "cuba": [21.5, -79.5], "dominican republic": [18.9, -70.5],
    "haiti": [19.0, -72.4], "jamaica": [18.1, -77.3], "panama": [8.5, -80.8],
    "costa rica": [9.7, -83.8], "guatemala": [15.8, -90.2], "honduras": [15.2, -86.2],
    "nicaragua": [12.9, -85.2], "trinidad and tobago": [10.7, -61.2],
    "egypt": [26.8, 30.8], "libya": [26.3, 17.2], "tunisia": [33.9, 9.5],
    "algeria": [28.0, 1.7], "morocco": [31.8, -7.1], "sudan": [15.6, 30.2],
    "south sudan": [7.3, 30.3], "ethiopia": [9.1, 40.5], "kenya": [-0.0, 37.9],
    "somalia": [5.2, 46.2], "tanzania": [-6.4, 34.9], "uganda": [1.4, 32.3],
    "rwanda": [-1.9, 29.9], "nigeria": [9.1, 8.7], "ghana": [7.9, -1.0],
    "ivory coast": [7.5, -5.5], "senegal": [14.5, -14.5], "cameroon": [3.8, 12.4],
    "democratic republic of the congo": [-4.0, 21.8], "angola": [-11.2, 17.9],
    "zambia": [-13.1, 27.8], "zimbabwe": [-19.0, 29.2], "mozambique": [-18.7, 35.5],
    "south africa": [-30.6, 22.9], "namibia": [-22.9, 18.5], "botswana": [-22.3, 24.7]
  };

  function countryCentroid(name) {
    if (!name) return null;
    return COUNTRY_CENTROIDS[String(name).trim().toLowerCase()] || null;
  }

  function buildNewsQuery(keyword) {
    const domainClause = "(" + NEWS_DOMAINS.map(d => `domain:${d}`).join(" OR ") + ")";
    return keyword ? `${domainClause} ${keyword}` : domainClause;
  }

  async function fetchNewsTarget(keyword) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NEWS_TIMEOUT_MS);
    try {
      const q = encodeURIComponent(buildNewsQuery(keyword));
      const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${q}&mode=artlist&maxrecords=30&timespan=3d&sort=hybridrel&format=json`;
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`GDELT news → ${res.status}`);
      const data = await res.json();
      const articles = data.articles || [];

      const mappable = [];
      for (const a of articles) {
        const coords = countryCentroid(a.sourcecountry);
        if (coords) mappable.push({ a, coords });
      }
      if (mappable.length === 0) return null;

      const { a, coords } = mappable[Math.floor(Math.random() * mappable.length)];
      // Small random spread so headlines from the same country don't all
      // stack on exactly the same pixel.
      const lat = Math.max(-85, Math.min(85, coords[0] + (Math.random() - 0.5) * 4));
      const lon = coords[1] + (Math.random() - 0.5) * 4;

      return {
        name: a.title || "Untitled story",
        loc: a.sourcecountry || a.domain || "Somewhere out there",
        lat, lon,
        desc: `Live headline from ${a.domain || "a free news site"}`,
        link: a.url || null,
        photoUrl: /^https?:\/\//i.test(a.socialimage || "") ? a.socialimage : null,
        source: "news"
      };
    } catch (err) {
      console.warn("News fallback unavailable:", err && err.message);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------- Main function ----------
  async function fetchRandomTarget(map, mode, sec, keyword) {
    // 1. Try a fast, parallel live Overpass search first — skipped politely
    // (never blocking the user) if we've called it too recently.
    if (canCallOverpassNow()) {
      try {
        const b = map.getBounds();
        const bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];
        const tagPairs = tagsFor(mode, sec);
        lastOverpassCall = Date.now();

        const data = await queryOverpassRace(buildOverpassQuery(bbox, tagPairs, keyword, 35));
        const pool = [];
        for (const el of (data.elements || [])) {
          const t = describeOsmElement(el);
          if (t) pool.push(t);
        }
        if (pool.length > 0) {
          return { target: pool[Math.floor(Math.random() * pool.length)], widened: false };
        }
      } catch (err) {
        console.warn("Live Overpass unavailable, trying real news instead:", err && err.message);
      }
    }

    // 2. Fall back to real, live news headlines placed on the map. No
    // hardcoded list — a genuine "nothing found" is reported honestly.
    const newsTarget = await fetchNewsTarget(keyword);
    if (newsTarget) return { target: newsTarget, widened: true };

    return null;
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
