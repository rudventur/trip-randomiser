// ==========================================================================
// TripSearchEngine — more aggressive pure-live version
// Goal: almost always return at least one real target from Overpass
// ==========================================================================
(function (global) {
  "use strict";

  // Broader, simpler tags that actually return results in most areas
  const CATEGORY_TAGS = {
    place: {
      present: [
        ["tourism", "attraction|museum|viewpoint|artwork|gallery|zoo|picnic_site|hotel|hostel"],
        ["amenity", "cafe|restaurant|bar|pub|library|cinema|theatre|place_of_worship|fountain|marketplace"],
        ["leisure", "park|garden|nature_reserve|beach_resort|stadium"],
        ["shop", "books|mall"],
        ["natural", "beach|peak|water|cliff"]
      ],
      past: [
        ["historic", ".*"],
        ["tourism", "attraction|museum"]
      ],
      future: [
        ["building", "construction"],
        ["landuse", "construction"],
        ["construction", ".*"]
      ]
    },
    event: {
      present: [
        ["amenity", "nightclub|theatre|cinema|arts_centre|community_centre|events_venue|marketplace"],
        ["leisure", "stadium|sports_centre|water_park"],
        ["tourism", "theme_park|attraction|zoo"]
      ],
      past: [["historic", ".*"]],
      future: [
        ["building", "construction"],
        ["landuse", "construction"]
      ]
    }
  };

  // Very broad last-resort tags – almost always finds something
  const LAST_RESORT_TAGS = [
    ["tourism", ".*"],
    ["amenity", "cafe|restaurant|bar|pub|library|place_of_worship|theatre|cinema"],
    ["leisure", "park|garden|stadium"],
    ["historic", ".*"],
    ["shop", "books"]
  ];

  const WIKIDATA_CLASSES = {
    place: {
      present: ["Q570116", "Q33506", "Q22698", "Q23413", "Q16560"],
      past: ["Q839954", "Q13418847"],
      future: []
    },
    event: {
      present: ["Q1656682", "Q132241", "Q483110"],
      past: ["Q13418847"],
      future: []
    }
  };

  const OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.osm.ch/api/interpreter"
  ];

  const WIKIDATA_TIMEOUT_MS = 5500;
  const OVERPASS_TIMEOUT_MS = 16000;

  function tagsFor(mode, sec) {
    if (mode === "both") {
      const p = CATEGORY_TAGS.place[sec] || CATEGORY_TAGS.place.present;
      const e = CATEGORY_TAGS.event[sec] || CATEGORY_TAGS.event.present;
      return [...p, ...e];
    }
    const table = CATEGORY_TAGS[mode] || CATEGORY_TAGS.place;
    return table[sec] || table.present;
  }

  function escapeForQuotedRegex(s) {
    return s.replace(/[\\"[\]().*+?^${}|]/g, "\\$&");
  }

  function buildOverpassQuery(bbox, tagPairs, keyword, limit = 60) {
    const [s, w, n, e] = bbox;
    const esc = keyword ? escapeForQuotedRegex(keyword) : null;

    const clauses = tagPairs.map(([k, v]) => {
      const pattern = v === ".*" ? ".*" : `^(${v})$`;
      const nameFilter = esc ? `["name"~"${esc}",i]` : "";
      return `nwr["${k}"~"${pattern}"]${nameFilter}(${s},${w},${n},${e});`;
    }).join("\n");

    return `[out:json][timeout:18];(${clauses});out center ${limit};`;
  }

  // Extremely broad query – last resort
  function buildLastResortQuery(bbox) {
    const [s, w, n, e] = bbox;
    const clauses = LAST_RESORT_TAGS.map(([k, v]) => {
      const pattern = v === ".*" ? ".*" : `^(${v})$`;
      return `nwr["${k}"~"${pattern}"]["name"](${s},${w},${n},${e});`;
    }).join("\n");
    return `[out:json][timeout:15];(${clauses});out center 40;`;
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

  async function queryOverpass(query) {
    const errors = [];
    // Shuffle mirrors a bit so we don't always hit the same one first
    const endpoints = [...OVERPASS_ENDPOINTS].sort(() => Math.random() - 0.5);

    for (const endpoint of endpoints) {
      try {
        const data = await queryOverpassOnce(endpoint, query);
        return data;
      } catch (err) {
        errors.push(err.message || String(err));
        // small pause before next mirror
        await new Promise(r => setTimeout(r, 280 + Math.random() * 200));
      }
    }
    const e = new Error(errors.join(" | "));
    e.allMirrorsFailed = true;
    throw e;
  }

  function elCenter(el) {
    if (typeof el.lat === "number" && typeof el.lon === "number") {
      return { lat: el.lat, lon: el.lon };
    }
    if (el.center && typeof el.center.lat === "number") {
      return { lat: el.center.lat, lon: el.center.lon };
    }
    return null;
  }

  function humanizeTagValue(v) {
    return String(v).replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  }

  function categoryLabel(key, val) {
    if (key === "historic") return val && val !== "yes" ? `Historic ${humanizeTagValue(val)}` : "Historic Site";
    if (key === "landuse" && val === "construction") return "Construction Site";
    if (key === "construction" || val === "construction") return "Under Construction";
    if (val === "yes") return humanizeTagValue(key);
    return humanizeTagValue(val);
  }

  const CATEGORY_KEYS = ["tourism", "amenity", "leisure", "shop", "natural", "historic", "building", "landuse", "construction"];

  function describeOsmElement(el) {
    const tags = el.tags || {};
    const coords = elCenter(el);
    if (!coords) return null;

    let matchedKey = null, matchedVal = null;
    for (const k of CATEGORY_KEYS) {
      if (tags[k]) {
        matchedKey = k;
        matchedVal = tags[k];
        break;
      }
    }

    const label = matchedKey ? categoryLabel(matchedKey, matchedVal) : "Place";
    const name = tags.name || `Unnamed ${label.toLowerCase()}`;

    const addrLine = [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" ");
    const addrCity = tags["addr:city"] || tags["addr:town"] || tags["addr:suburb"] || tags["addr:village"];
    const loc = [addrLine, addrCity].filter(Boolean).join(", ") || label;

    const link = tags.website || tags["contact:website"] ||
      (tags.wikipedia ? `https://en.wikipedia.org/wiki/${encodeURIComponent((tags.wikipedia.split(":")[1] || tags.wikipedia))}` : null);

    let photoUrl = null;
    if (tags.image && /^https?:\/\//i.test(tags.image)) {
      photoUrl = tags.image;
    } else if (tags.wikimedia_commons && tags.wikimedia_commons.startsWith("File:")) {
      photoUrl = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(tags.wikimedia_commons.slice(5))}?width=500`;
    }

    return {
      name,
      loc,
      lat: coords.lat,
      lon: coords.lon,
      desc: `Found on OpenStreetMap · ${label}`,
      link,
      photoUrl,
      wikipedia: tags.wikipedia || null,
      source: "osm"
    };
  }

  // ---------- Wikidata (bonus only) ----------
  function bboxToCenterRadius(bbox) {
    const [s, w, n, e] = bbox;
    const lat = (s + n) / 2;
    const lon = (w + e) / 2;
    const kmPerDegLat = 111;
    const kmPerDegLon = 111 * Math.cos(lat * Math.PI / 180);
    const halfDiagKm = Math.sqrt(
      ((n - s) * kmPerDegLat / 2) ** 2 +
      ((e - w) * kmPerDegLon / 2) ** 2
    );
    const radius = Math.min(10, Math.max(1.5, halfDiagKm));
    return { lat, lon, radius };
  }

  function buildWikidataQuery(center, classQids, keyword) {
    if (!classQids.length) return null;
    const valuesClause = classQids.map(q => `wd:${q}`).join(" ");
    const keywordClause = keyword
      ? `?item rdfs:label ?lbl . FILTER(LANG(?lbl)="en") FILTER(CONTAINS(LCASE(?lbl), "${escapeForQuotedRegex(keyword.toLowerCase())}"))`
      : "";

    return `SELECT ?item ?itemLabel ?coord ?classLabel ?image WHERE {
      SERVICE wikibase:around {
        ?item wdt:P625 ?coord .
        bd:serviceParam wikibase:center "Point(${center.lon} ${center.lat})"^^geo:wktLiteral .
        bd:serviceParam wikibase:radius "${center.radius}" .
      }
      ?item wdt:P31 ?class .
      VALUES ?class { ${valuesClause} }
      OPTIONAL { ?item wdt:P18 ?image . }
      ${keywordClause}
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    } LIMIT 40`;
  }

  async function queryWikidata(query) {
    if (!query) return [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WIKIDATA_TIMEOUT_MS);
    try {
      const url = "https://query.wikidata.org/sparql?query=" + encodeURIComponent(query);
      const res = await fetch(url, {
        headers: { Accept: "application/sparql-results+json" },
        signal: controller.signal
      });
      if (!res.ok) return [];
      const data = await res.json();
      return (data.results && data.results.bindings) || [];
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  function describeWikidataBinding(b) {
    const m = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(b.coord && b.coord.value);
    if (!m) return null;
    const lon = parseFloat(m[1]);
    const lat = parseFloat(m[2]);
    const qid = b.item.value.split("/").pop();
    const rawName = b.itemLabel && b.itemLabel.value;
    const label = b.classLabel ? humanizeTagValue(b.classLabel.value) : "Place";
    const name = (rawName && !/^Q\d+$/.test(rawName)) ? rawName : `Unnamed ${label.toLowerCase()}`;
    const photoUrl = (b.image && b.image.value) ? b.image.value + "?width=500" : null;

    return {
      name,
      loc: label,
      lat,
      lon,
      desc: `Found on Wikidata · ${label}`,
      link: `https://www.wikidata.org/wiki/${qid}`,
      photoUrl,
      wikipedia: null,
      source: "wikidata"
    };
  }

  async function fetchWikidataTargets(bbox, mode, sec, keyword) {
    const table = WIKIDATA_CLASSES[mode] || WIKIDATA_CLASSES.place;
    const classQids = table[sec] || [];
    if (!classQids.length) return [];

    const center = bboxToCenterRadius(bbox);
    const query = buildWikidataQuery(center, classQids, keyword);
    const bindings = await queryWikidata(query);

    const seen = new Set();
    const targets = [];
    for (const b of bindings) {
      const t = describeWikidataBinding(b);
      if (!t || seen.has(t.link)) continue;
      seen.add(t.link);
      targets.push(t);
    }
    return targets;
  }

  function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function ensureSearchableZoom(map) {
    if (map.getZoom() < 12) {
      map.setView(map.getCenter(), 13, { animate: false });
    }
  }

  // ---------- Main public function ----------
  async function fetchRandomTarget(map, mode, sec, keyword) {
    ensureSearchableZoom(map);

    const tagPairs = tagsFor(mode, sec);
    let widened = false;

    for (let attempt = 0; attempt < 5; attempt++) {
      const b = map.getBounds();
      const bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];

      // 1. Try normal query (with keyword if provided)
      let pool = [];

      try {
        const osmData = await queryOverpass(buildOverpassQuery(bbox, tagPairs, keyword, 60));
        for (const el of (osmData.elements || [])) {
          const t = describeOsmElement(el);
          if (t) pool.push(t);
        }
      } catch (err) {
        console.warn("Overpass attempt failed:", err.message);
      }

      // 2. Soft keyword: if keyword was used and pool is empty → try again without keyword
      if (keyword && pool.length === 0) {
        try {
          const osmData = await queryOverpass(buildOverpassQuery(bbox, tagPairs, null, 60));
          for (const el of (osmData.elements || [])) {
            const t = describeOsmElement(el);
            if (t) pool.push(t);
          }
        } catch (err) {
          console.warn("Overpass (no keyword) failed:", err.message);
        }
      }

      // 3. Add Wikidata as pure bonus (never blocks)
      try {
        const wikiTargets = await fetchWikidataTargets(bbox, mode, sec, keyword);
        pool.push(...wikiTargets);
      } catch (_) {}

      if (pool.length > 0) {
        return { target: pick(pool), widened };
      }

      // 4. Last resort broad query on this bbox
      try {
        const lastData = await queryOverpass(buildLastResortQuery(bbox));
        for (const el of (lastData.elements || [])) {
          const t = describeOsmElement(el);
          if (t) pool.push(t);
        }
        if (pool.length > 0) {
          return { target: pick(pool), widened: true };
        }
      } catch (err) {
        console.warn("Last-resort Overpass failed:", err.message);
      }

      // 5. Gentle widen – only 1 zoom level
      widened = true;
      const newZoom = Math.max(3, map.getZoom() - 1);
      map.setView(map.getCenter(), newZoom, { animate: false });
    }

    // Absolute last chance – global-ish broad query around current center
    try {
      const b = map.getBounds();
      const bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];
      const lastData = await queryOverpass(buildLastResortQuery(bbox));
      const pool = [];
      for (const el of (lastData.elements || [])) {
        const t = describeOsmElement(el);
        if (t) pool.push(t);
      }
      if (pool.length > 0) {
        return { target: pick(pool), widened: true };
      }
    } catch (_) {}

    return null; // only if everything really failed
  }

  // Optional helper for photos
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

  global.TripSearchEngine = {
    fetchRandomTarget,
    fetchWikipediaThumbnail,
    pick
  };
})(window);
