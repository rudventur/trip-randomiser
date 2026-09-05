// ==========================================================================
// TripSearchEngine — the "target search engine" for RudVentur Feeling Lucky.
//
// No curated suggestion lists. Every target is pulled live from two free,
// key-less public data sources — OpenStreetMap (via the Overpass API) and
// Wikidata (via its public SPARQL endpoint) — using whatever area the map
// is currently showing as the real search region. Both sources' matches are
// pooled together and one target is picked with a single uniform random
// draw across the whole pool.
//
// Wikidata is a best-effort enrichment layer: it adds real target types OSM
// doesn't cover well (festivals, planned events, historical events) but its
// public endpoint can be slow or time out under load. A Wikidata failure or
// timeout never fails the search — it just means that draw pulls from OSM
// only, same as if Wikidata had genuinely found nothing nearby.
// ==========================================================================
(function (global) {
  "use strict";

  // ---------- OSM (Overpass) category tags ----------
  // Each pair is [osmKey, valueAlternation]. "past" and "future" reuse real
  // OSM concepts instead of inventing fake events/dates: historic=* for
  // things that used to be here, construction=* for things that will exist
  // here.
  const CATEGORY_TAGS = {
    place: {
      present: [
        ["tourism", "attraction|viewpoint|museum|gallery|zoo|artwork|picnic_site"],
        ["amenity", "cafe|restaurant|bar|pub|library|cinema|theatre|arts_centre|marketplace|place_of_worship|fountain"],
        ["leisure", "park|garden|nature_reserve|beach_resort"],
        ["shop", "books"],
        ["natural", "beach|peak|water"]
      ],
      past: [["historic", ".*"]],
      future: [["building", "construction"], ["landuse", "construction"], ["construction", ".*"]]
    },
    event: {
      present: [
        ["amenity", "nightclub|theatre|cinema|arts_centre|community_centre|conference_centre|events_venue|marketplace"],
        ["leisure", "stadium|sports_centre|water_park"],
        ["tourism", "theme_park|attraction|zoo"]
      ],
      past: [["historic", ".*"]],
      future: [["building", "construction"], ["landuse", "construction"], ["construction", ".*"]]
    }
  };

  // ---------- Wikidata classes (instance-of QIDs) ----------
  // Deliberately small per bucket — a handful of QIDs keeps the SPARQL
  // query fast (verified against the live endpoint); a long VALUES list
  // over a dense city center reliably times out. "future" has no good
  // Wikidata equivalent to OSM's construction=* tag, so it's OSM-only.
  const WIKIDATA_CLASSES = {
    place: {
      present: ["Q570116", "Q33506", "Q22698", "Q23413", "Q16560", "Q4989906"],
      past: ["Q839954", "Q13418847"],
      future: []
    },
    event: {
      present: ["Q1656682", "Q132241", "Q483110"],
      past: ["Q13418847"],
      future: []
    }
  };
  const WIKIDATA_MAX_RADIUS_KM = 12;
  const WIKIDATA_TIMEOUT_MS = 9000;

  function tagsFor(mode, sec) {
    if (mode === "both") {
      const p = CATEGORY_TAGS.place[sec] || CATEGORY_TAGS.place.present;
      const e = CATEGORY_TAGS.event[sec] || CATEGORY_TAGS.event.present;
      return [...p, ...e];
    }
    const table = CATEGORY_TAGS[mode] || CATEGORY_TAGS.place;
    return table[sec] || table.present;
  }

  function wikidataClassesFor(mode, sec) {
    if (mode === "both") {
      const p = WIKIDATA_CLASSES.place[sec] || [];
      const e = WIKIDATA_CLASSES.event[sec] || [];
      return [...new Set([...p, ...e])];
    }
    const table = WIKIDATA_CLASSES[mode] || WIKIDATA_CLASSES.place;
    return table[sec] || [];
  }

  // Shared escaping for a keyword dropped into a double-quoted regex
  // literal inside a query string (Overpass QL or SPARQL) — must not let
  // the keyword break out of the quotes or the regex.
  function escapeForQuotedRegex(s) {
    return s.replace(/[\\"[\]().*+?^${}|]/g, "\\$&");
  }

  // A keyword still respects the current mode/filter category — it narrows
  // "real places of interest" (or events, or historic sites) by name,
  // rather than replacing that constraint with a bare name search across
  // every named thing on the map (street signs, building refs, etc).
  function buildOverpassQuery(bbox, tagPairs, keyword) {
    const [s, w, n, e] = bbox;
    const esc = keyword ? escapeForQuotedRegex(keyword) : null;
    const clauses = tagPairs.map(([k, v]) => {
      const pattern = v === ".*" ? ".*" : `^(${v})$`;
      const nameFilter = esc ? `["name"~"${esc}",i]` : "";
      return `nwr["${k}"~"${pattern}"]${nameFilter}(${s},${w},${n},${e});`;
    }).join("\n");
    return `[out:json][timeout:25];(${clauses});out center 300;`;
  }

  const OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.osm.ch/api/interpreter"
  ];

  async function queryOverpassOnce(endpoint, query) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        body: "data=" + encodeURIComponent(query),
        signal: controller.signal
      });
      if (!res.ok) throw new Error(`${endpoint} responded ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function queryOverpass(query) {
    const errors = [];
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        return await queryOverpassOnce(endpoint, query);
      } catch (err) {
        errors.push(`${endpoint} → ${err && err.message ? err.message : err}`);
      }
    }
    const combined = new Error(errors.join(" | "));
    combined.allMirrorsFailed = true;
    throw combined;
  }

  function elCenter(el) {
    if (typeof el.lat === "number" && typeof el.lon === "number") return { lat: el.lat, lon: el.lon };
    if (el.center && typeof el.center.lat === "number") return { lat: el.center.lat, lon: el.center.lon };
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

  // Normalizes a raw Overpass element into a plain, source-agnostic target.
  function describeOsmElement(el) {
    const tags = el.tags || {};
    const coords = elCenter(el);
    let matchedKey = null, matchedVal = null;
    for (const k of CATEGORY_KEYS) {
      if (tags[k]) { matchedKey = k; matchedVal = tags[k]; break; }
    }
    const label = matchedKey ? categoryLabel(matchedKey, matchedVal) : "Place";
    const name = tags.name || `Unnamed ${label.toLowerCase()}`;
    const addrLine = [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" ");
    const addrCity = tags["addr:city"] || tags["addr:town"] || tags["addr:suburb"] || tags["addr:village"];
    const locParts = [addrLine, addrCity].filter(Boolean);
    const loc = locParts.length ? locParts.join(", ") : label;
    const link = tags.website || tags["contact:website"] ||
      (tags.wikipedia ? `https://en.wikipedia.org/wiki/${encodeURIComponent(tags.wikipedia.split(":").slice(1).join(":") || tags.wikipedia)}` : null);

    // Closest available picture: prefer a direct "image" tag, then a
    // Wikimedia Commons file tag (resolved via Special:FilePath, which
    // works as a plain <img src> with no extra API call). Otherwise we
    // fall back to a Wikipedia page thumbnail lookup (see
    // fetchWikipediaThumbnail), once the caller knows the target.
    let photoUrl = null;
    if (tags.image && /^https?:\/\//i.test(tags.image)) {
      photoUrl = tags.image;
    } else if (tags.wikimedia_commons && tags.wikimedia_commons.startsWith("File:")) {
      photoUrl = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(tags.wikimedia_commons.slice(5))}?width=500`;
    }

    return {
      name, loc, lat: coords.lat, lon: coords.lon,
      desc: `Found on OpenStreetMap · ${label}`,
      link, photoUrl, wikipedia: tags.wikipedia || null, source: "osm"
    };
  }

  // ---------- Wikidata ----------
  function bboxToCenterRadius(bbox) {
    const [s, w, n, e] = bbox;
    const lat = (s + n) / 2, lon = (w + e) / 2;
    const kmPerDegLat = 111;
    const kmPerDegLon = 111 * Math.cos(lat * Math.PI / 180);
    const halfDiagKm = Math.sqrt(
      ((n - s) * kmPerDegLat / 2) ** 2 + ((e - w) * kmPerDegLon / 2) ** 2
    );
    const radius = Math.min(WIKIDATA_MAX_RADIUS_KM, Math.max(1, halfDiagKm));
    return { lat, lon, radius };
  }

  function buildWikidataQuery(center, classQids, keyword) {
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
    } LIMIT 80`;
  }

  // Never throws — a Wikidata failure just means this draw has no Wikidata
  // contribution, same as if it had genuinely found nothing nearby.
  async function queryWikidata(query) {
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
    const lon = parseFloat(m[1]), lat = parseFloat(m[2]);
    const qid = b.item.value.split("/").pop();
    const rawName = b.itemLabel && b.itemLabel.value;
    const label = b.classLabel ? humanizeTagValue(b.classLabel.value) : "Place";
    const name = (rawName && !/^Q\d+$/.test(rawName)) ? rawName : `Unnamed ${label.toLowerCase()}`;
    const photoUrl = (b.image && b.image.value) ? `${b.image.value}?width=500` : null;
    return {
      name, loc: label, lat, lon,
      desc: `Found on Wikidata · ${label}`,
      link: `https://www.wikidata.org/wiki/${qid}`,
      photoUrl, wikipedia: null, source: "wikidata", _qid: qid
    };
  }

  async function fetchWikidataTargets(bbox, mode, sec, keyword) {
    const classQids = wikidataClassesFor(mode, sec);
    if (classQids.length === 0) return [];
    const center = bboxToCenterRadius(bbox);
    const query = buildWikidataQuery(center, classQids, keyword);
    const bindings = await queryWikidata(query);
    const seen = new Set();
    const targets = [];
    for (const b of bindings) {
      const t = describeWikidataBinding(b);
      if (!t || seen.has(t._qid)) continue;
      seen.add(t._qid);
      targets.push(t);
    }
    return targets;
  }

  // Fallback photo lookup when an OSM element has no photo tag of its own:
  // ask Wikipedia's REST summary API (CORS-enabled) for its page thumbnail.
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

  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  const KEYWORD_IDEAS = [
    "castle", "waterfall", "lighthouse", "cave", "bridge", "market",
    "brewery", "vineyard", "island", "ruins", "garden", "tower",
    "monastery", "windmill", "harbour", "canyon", "volcano", "lake",
    "fortress", "abbey", "palace", "observatory", "aquarium", "mill",
    "festival", "stadium", "museum"
  ];

  function ensureSearchableZoom(map) {
    if (map.getZoom() < 11) {
      map.setView(map.getCenter(), 13, { animate: false });
    }
  }

  // Fetch one random real target from the combined OSM + Wikidata pool. If
  // the current view has no matches, the search area is automatically
  // widened (zoomed out) a few times before giving up — still no
  // suggestions, just a bigger honest search.
  async function fetchRandomTarget(map, mode, sec, keyword) {
    ensureSearchableZoom(map);
    const tagPairs = tagsFor(mode, sec);
    let widened = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const b = map.getBounds();
      const bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];

      const [osmResult, wikidataTargets] = await Promise.allSettled([
        queryOverpass(buildOverpassQuery(bbox, tagPairs, keyword)),
        fetchWikidataTargets(bbox, mode, sec, keyword)
      ]);

      const pool = [];
      if (osmResult.status === "fulfilled") {
        for (const el of (osmResult.value.elements || [])) {
          if (elCenter(el)) pool.push(describeOsmElement(el));
        }
      }
      if (wikidataTargets.status === "fulfilled") {
        pool.push(...wikidataTargets.value);
      }

      if (pool.length > 0) {
        return { target: pick(pool), widened };
      }

      // Only a hard Overpass failure (all mirrors down) on the very first,
      // un-widened attempt is worth surfacing — otherwise an empty pool
      // just means "nothing here", and we keep widening.
      if (osmResult.status === "rejected" && attempt === 0) {
        throw osmResult.reason;
      }

      widened = true;
      const z = Math.max(2, map.getZoom() - 3);
      map.setView(map.getCenter(), z, { animate: false });
    }
    return null;
  }

  global.TripSearchEngine = {
    fetchRandomTarget,
    fetchWikipediaThumbnail,
    pick,
    KEYWORD_IDEAS
  };
})(window);
