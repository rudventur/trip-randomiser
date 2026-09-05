// ==========================================================================
// TripSearchEngine
//
// 1. Search LIVE OpenStreetMap/Overpass inside the visible map.
// 2. Pick one random real result.
// 3. If Overpass fails OR finds nothing, fetch fresh news from GDELT.
// 4. Prefer news from countries represented inside the current map view.
// 5. If country/location matching isn't possible, still return a live article.
//
// No curated destination list.
// No hardcoded places.
// No fake destinations.
// ==========================================================================

(function (global) {
  "use strict";

  // ------------------------------------------------------------------------
  // CONFIG
  // ------------------------------------------------------------------------

  const OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.osm.ch/api/interpreter"
  ];

  const OVERPASS_TIMEOUT_MS = 10000;
  const NEWS_TIMEOUT_MS = 10000;

  // Prevent hammering free Overpass servers.
  let lastOverpassCall = 0;
  const MIN_INTERVAL_MS = 10000;

  const NEWS_DOMAINS = [
    "bbc.co.uk",
    "reuters.com",
    "apnews.com",
    "theguardian.com",
    "npr.org",
    "aljazeera.com",
    "dw.com"
  ];

  // ------------------------------------------------------------------------
  // OSM SEARCH
  //
  // These are OpenStreetMap TAG TYPES, not curated destinations.
  // The actual places are always retrieved live from OSM.
  // ------------------------------------------------------------------------

  const CATEGORY_TAGS = {
    place: {
      present: [
        ["tourism", "attraction|museum|viewpoint|artwork|gallery|zoo"],
        ["amenity", "cafe|restaurant|bar|pub|library|cinema|theatre|place_of_worship"],
        ["leisure", "park|garden|stadium"],
        ["historic", ".*"]
      ],

      past: [
        ["historic", ".*"],
        ["tourism", "attraction|museum"]
      ],

      future: [
        ["building", "construction"],
        ["landuse", "construction"]
      ]
    },

    event: {
      present: [
        ["amenity", "theatre|cinema|arts_centre|events_venue|marketplace"],
        ["leisure", "stadium|sports_centre"],
        ["tourism", "theme_park|attraction"]
      ],

      past: [
        ["historic", ".*"]
      ],

      future: [
        ["building", "construction"],
        ["landuse", "construction"]
      ]
    }
  };

  function tagsFor(mode, sec) {
    if (mode === "both") {
      return [
        ...(CATEGORY_TAGS.place[sec] || CATEGORY_TAGS.place.present),
        ...(CATEGORY_TAGS.event[sec] || CATEGORY_TAGS.event.present)
      ];
    }

    const table = CATEGORY_TAGS[mode] || CATEGORY_TAGS.place;
    return table[sec] || table.present;
  }

  function escapeForQuotedRegex(s) {
    return String(s).replace(/[\\"[\]().*+?^${}|]/g, "\\$&");
  }

  function buildOverpassQuery(bbox, tagPairs, keyword, limit = 50) {
    const [south, west, north, east] = bbox;

    const escapedKeyword = keyword
      ? escapeForQuotedRegex(keyword)
      : null;

    const clauses = tagPairs.map(([key, value]) => {
      const pattern = value === ".*"
        ? ".*"
        : `^(${value})$`;

      const nameFilter = escapedKeyword
        ? `["name"~"${escapedKeyword}",i]`
        : "";

      return `
        nwr
        ["${key}"~"${pattern}"]
        ${nameFilter}
        (${south},${west},${north},${east});
      `;
    }).join("\n");

    return `
      [out:json][timeout:15];
      (
        ${clauses}
      );
      out center ${limit};
    `;
  }

  async function queryOverpassOnce(endpoint, query) {
    const controller = new AbortController();

    const timer = setTimeout(() => {
      controller.abort();
    }, OVERPASS_TIMEOUT_MS);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"
        },
        body: "data=" + encodeURIComponent(query),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(
          `Overpass ${response.status} from ${endpoint}`
        );
      }

      return await response.json();

    } finally {
      clearTimeout(timer);
    }
  }

  async function queryOverpassRace(query) {
    const requests = OVERPASS_ENDPOINTS.map(endpoint =>
      queryOverpassOnce(endpoint, query)
    );

    // Promise.any is supported by modern browsers.
    // If it isn't available, use Promise.allSettled instead.
    if (typeof Promise.any === "function") {
      return Promise.any(requests);
    }

    const results = await Promise.allSettled(requests);

    const successful = results.find(
      result => result.status === "fulfilled"
    );

    if (!successful) {
      throw new Error("All Overpass servers failed");
    }

    return successful.value;
  }

  function elementCenter(element) {
    if (
      typeof element.lat === "number" &&
      typeof element.lon === "number"
    ) {
      return {
        lat: element.lat,
        lon: element.lon
      };
    }

    if (
      element.center &&
      typeof element.center.lat === "number" &&
      typeof element.center.lon === "number"
    ) {
      return {
        lat: element.center.lat,
        lon: element.center.lon
      };
    }

    return null;
  }

  function describeOsmElement(element) {
    const tags = element.tags || {};
    const coords = elementCenter(element);

    if (!coords) {
      return null;
    }

    const name = tags.name || "Unnamed place";

    const label =
      tags.tourism ||
      tags.amenity ||
      tags.leisure ||
      tags.historic ||
      tags.shop ||
      "place";

    const location = [
      tags["addr:street"],
      tags["addr:city"] ||
      tags["addr:town"] ||
      tags["addr:village"]
    ]
      .filter(Boolean)
      .join(", ");

    let photoUrl = null;

    if (
      tags.image &&
      /^https?:\/\//i.test(tags.image)
    ) {
      photoUrl = tags.image;
    }

    if (
      !photoUrl &&
      tags.wikimedia_commons &&
      tags.wikimedia_commons.startsWith("File:")
    ) {
      photoUrl =
        "https://commons.wikimedia.org/wiki/Special:FilePath/" +
        encodeURIComponent(
          tags.wikimedia_commons.slice(5)
        ) +
        "?width=500";
    }

    return {
      name,
      loc: location || label,
      lat: coords.lat,
      lon: coords.lon,

      desc:
        `Live OpenStreetMap result · ${label}`,

      link:
        tags.website ||
        tags["contact:website"] ||
        null,

      photoUrl,
      wikipedia: tags.wikipedia || null,

      source: "osm"
    };
  }

  // ------------------------------------------------------------------------
  // NEWS FALLBACK
  //
  // GDELT provides fresh articles. We don't maintain a destination list.
  // ------------------------------------------------------------------------

  function buildNewsQuery(keyword) {
    const domainClause =
      "(" +
      NEWS_DOMAINS
        .map(domain => `domain:${domain}`)
        .join(" OR ") +
      ")";

    return keyword
      ? `${domainClause} ${keyword}`
      : domainClause;
  }

  function insideBounds(lat, lon, bounds) {
    if (!bounds) return true;

    const south = bounds.getSouth();
    const north = bounds.getNorth();
    const west = bounds.getWest();
    const east = bounds.getEast();

    // Normal longitude range.
    if (west <= east) {
      return (
        lat >= south &&
        lat <= north &&
        lon >= west &&
        lon <= east
      );
    }

    // Handles maps crossing the international date line.
    return (
      lat >= south &&
      lat <= north &&
      (lon >= west || lon <= east)
    );
  }

  function countryCentroid(country) {
    if (!country) return null;

    // GDELT gives us the reporting country, but not necessarily exact
    // article coordinates. Use a lightweight country-centre fallback.
    const countries = {
      "united kingdom": [54.0, -2.9],
      "ireland": [53.4, -8.2],
      "france": [46.6, 2.2],
      "germany": [51.2, 10.4],
      "spain": [40.0, -3.7],
      "portugal": [39.6, -8.0],
      "italy": [42.8, 12.6],
      "netherlands": [52.2, 5.5],
      "belgium": [50.5, 4.5],
      "switzerland": [46.8, 8.2],
      "austria": [47.5, 14.6],
      "poland": [52.0, 19.1],
      "czech republic": [49.8, 15.5],
      "denmark": [56.0, 9.5],
      "sweden": [62.0, 15.0],
      "norway": [64.6, 11.5],
      "finland": [64.9, 26.0],
      "iceland": [64.9, -19.0],
      "united states": [39.8, -98.6],
      "canada": [56.1, -106.3],
      "mexico": [23.6, -102.6],
      "brazil": [-10.3, -53.2],
      "argentina": [-35.4, -65.2],
      "chile": [-35.7, -71.5],
      "colombia": [4.6, -74.3],
      "peru": [-9.2, -75.0],
      "australia": [-25.3, 133.8],
      "new zealand": [-41.0, 174.9],
      "japan": [36.2, 138.3],
      "south korea": [35.9, 127.8],
      "china": [35.9, 104.2],
      "india": [22.4, 78.7],
      "singapore": [1.35, 103.8],
      "indonesia": [-2.5, 118.0],
      "south africa": [-30.6, 22.9],
      "egypt": [26.8, 30.8],
      "morocco": [31.8, -7.1],
      "turkey": [39.0, 35.2],
      "greece": [39.1, 21.8],
      "ukraine": [48.4, 31.2],
      "israel": [31.0, 34.9],
      "united arab emirates": [23.4, 53.8]
    };

    return countries[
      String(country).trim().toLowerCase()
    ] || null;
  }

  async function fetchNewsTarget(keyword, map) {
    const controller = new AbortController();

    const timer = setTimeout(() => {
      controller.abort();
    }, NEWS_TIMEOUT_MS);

    try {
      const query = encodeURIComponent(
        buildNewsQuery(keyword)
      );

      const url =
        `https://api.gdeltproject.org/api/v2/doc/doc` +
        `?query=${query}` +
        `&mode=artlist` +
        `&maxrecords=50` +
        `&timespan=1d` +
        `&sort=hybridrel` +
        `&format=json`;

      const response = await fetch(url, {
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(
          `GDELT returned HTTP ${response.status}`
        );
      }

      const data = await response.json();

      const articles = Array.isArray(data.articles)
        ? data.articles
        : [];

      if (!articles.length) {
        return null;
      }

      const bounds =
        map && typeof map.getBounds === "function"
          ? map.getBounds()
          : null;

      const candidates = [];

      for (const article of articles) {
        const coords =
          countryCentroid(article.sourcecountry);

        if (!coords) {
          continue;
        }

        const [baseLat, baseLon] = coords;

        // Keep the fallback visually inside the selected map area
        // whenever possible.
        if (
          bounds &&
          insideBounds(baseLat, baseLon, bounds)
        ) {
          candidates.push({
            article,
            lat: baseLat,
            lon: baseLon,
            exactRegion: true
          });

          continue;
        }

        // If the exact country centre isn't inside the map, keep it
        // as a secondary candidate. This prevents "no news" just
        // because the map is zoomed into a smaller area.
        candidates.push({
          article,
          lat: baseLat,
          lon: baseLon,
          exactRegion: false
        });
      }

      if (!candidates.length) {
        return null;
      }

      // Strong preference for news that actually belongs to a country
      // inside the current map view.
      const localCandidates =
        candidates.filter(item => item.exactRegion);

      const pool =
        localCandidates.length
          ? localCandidates
          : candidates;

      const chosen =
        pool[Math.floor(Math.random() * pool.length)];

      const article = chosen.article;

      // Tiny jitter makes repeated country results easier to see.
      const lat =
        chosen.lat +
        (Math.random() - 0.5) * 1.5;

      const lon =
        chosen.lon +
        (Math.random() - 0.5) * 1.5;

      return {
        name:
          article.title ||
          "Fresh news story",

        loc:
          article.sourcecountry ||
          article.domain ||
          "News",

        lat: Math.max(-85, Math.min(85, lat)),
        lon,

        desc:
          `Fresh news from ${article.domain || "the web"} · ` +
          `${article.sourcecountry || "unknown location"}`,

        link:
          article.url || null,

        photoUrl:
          /^https?:\/\//i.test(
            article.socialimage || ""
          )
            ? article.socialimage
            : null,

        source: "news"
      };

    } finally {
      clearTimeout(timer);
    }
  }

  // ------------------------------------------------------------------------
  // MAIN SEARCH
  // ------------------------------------------------------------------------

  async function fetchRandomTarget(
    map,
    mode,
    sec,
    keyword
  ) {
    let overpassError = null;

    // ------------------------------------------------------
    // 1. LIVE OSM
    // ------------------------------------------------------

    if (
      Date.now() - lastOverpassCall >=
      MIN_INTERVAL_MS
    ) {
      try {
        const bounds = map.getBounds();

        const bbox = [
          bounds.getSouth(),
          bounds.getWest(),
          bounds.getNorth(),
          bounds.getEast()
        ];

        const tagPairs = tagsFor(mode, sec);

        lastOverpassCall = Date.now();

        const query = buildOverpassQuery(
          bbox,
          tagPairs,
          keyword,
          50
        );

        console.log(
          "[RudVentur] Searching live OSM..."
        );

        const data =
          await queryOverpassRace(query);

        const pool = [];

        for (
          const element of
          (data.elements || [])
        ) {
          const target =
            describeOsmElement(element);

          if (target) {
            pool.push(target);
          }
        }

        if (pool.length) {
          console.log(
            `[RudVentur] Found ${pool.length} live OSM results.`
          );

          return {
            target:
              pool[
                Math.floor(
                  Math.random() * pool.length
                )
              ],

            widened: false,
            source: "osm"
          };
        }

        console.log(
          "[RudVentur] OSM returned no results."
        );

      } catch (error) {
        overpassError = error;

        console.warn(
          "[RudVentur] OSM search failed:",
          error
        );
      }
    } else {
      console.log(
        "[RudVentur] Overpass cooldown active; going to news."
      );
    }

    // ------------------------------------------------------
    // 2. FRESH NEWS FALLBACK
    // ------------------------------------------------------

    try {
      console.log(
        "[RudVentur] Fetching fresh news fallback..."
      );

      const newsTarget =
        await fetchNewsTarget(
          keyword,
          map
        );

      if (newsTarget) {
        console.log(
          "[RudVentur] Using fresh news result."
        );

        return {
          target: newsTarget,
          widened: true,
          source: "news"
        };
      }

      console.warn(
        "[RudVentur] GDELT returned no usable news."
      );

    } catch (error) {
      console.error(
        "[RudVentur] News fallback failed:",
        error
      );
    }

    // Nothing worked.
    return null;
  }

  // ------------------------------------------------------------------------
  // WIKIPEDIA PHOTO
  // ------------------------------------------------------------------------

  async function fetchWikipediaThumbnail(
    wikipediaTag
  ) {
    try {
      const parts =
        String(wikipediaTag).split(":");

      const lang =
        parts.length > 1
          ? parts[0]
          : "en";

      const title =
        parts.length > 1
          ? parts.slice(1).join(":")
          : parts[0];

      const response =
        await fetch(
          `https://${lang}.wikipedia.org/api/rest_v1/page/summary/` +
          encodeURIComponent(title)
        );

      if (!response.ok) {
        return null;
      }

      const data =
        await response.json();

      return (
        data.thumbnail &&
        data.thumbnail.source
      ) || null;

    } catch (error) {
      console.warn(
        "[RudVentur] Wikipedia image failed:",
        error
      );

      return null;
    }
  }

  // ------------------------------------------------------------------------
  // RANDOM HELPER
  // ------------------------------------------------------------------------

  function pick(array) {
    if (!Array.isArray(array) || !array.length) {
      return null;
    }

    return array[
      Math.floor(
        Math.random() * array.length
      )
    ];
  }

  // ------------------------------------------------------------------------
  // DISTANCE
  // ------------------------------------------------------------------------

  function haversineKm(
    lat1,
    lon1,
    lat2,
    lon2
  ) {
    const R = 6371;

    const dLat =
      (lat2 - lat1) *
      Math.PI / 180;

    const dLon =
      (lon2 - lon1) *
      Math.PI / 180;

    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * Math.PI / 180) *
      Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) ** 2;

    return (
      R *
      2 *
      Math.atan2(
        Math.sqrt(a),
        Math.sqrt(1 - a)
      )
    );
  }

  // ------------------------------------------------------------------------
  // FUNNY ROUTES
  // ------------------------------------------------------------------------

  const FUNNY_VEHICLES = [
    "a caffeinated pigeon courier",
    "a shopping cart with one wobbly wheel",
    "a unicycle borrowed from a circus",
    "a suspiciously fast tortoise",
    "a hot air balloon named Gerald",
    "a fleet of confused Roombas",
    "a llama with a passport",
    "the last known flying carpet",
    "a golf cart that should not be street legal",
    "a very motivated goose",
    "a rowboat and pure optimism",
    "a skateboard with rocket boosters",
    "a rented segway and a dream",
    "a mysterious portal behind the shed",
    "a marching band that happens to be going that way",
    "a paper airplane, scaled up considerably",
    "a tandem bike missing its second rider"
  ];

  const FUNNY_HUBS = [
    "the nearest questionable food truck",
    "a roundabout with strong opinions",
    "the town's one confusing bus stop",
    "a suspiciously well-lit alley",
    "a vending machine that dispenses directions",
    "the local pigeon parliament",
    "a fortune teller's tent",
    "an unattended lemonade stand",
    "a payphone that still somehow works",
    "a duck pond with excellent Wi-Fi"
  ];

  function distanceJoke(km) {
    if (km > 8000) {
      return " (bring snacks, and maybe a visa)";
    }

    if (km > 3000) {
      return " (pack a book, it's a while)";
    }

    if (km > 500) {
      return " (stretch your legs first)";
    }

    return "";
  }

  function buildFunnyRoute(
    startName,
    target,
    startLat,
    startLon,
    isReturn
  ) {
    const stages = [];

    const from =
      startName ||
      "your current position";

    stages.push(
      `Leave ${from} aboard ${pick(FUNNY_VEHICLES)}`
    );

    stages.push(
      `Stop at ${pick(FUNNY_HUBS)} to ask for directions (they will be confidently wrong)`
    );

    let distanceLabel = "";

    if (
      typeof startLat === "number" &&
      typeof startLon === "number"
    ) {
      const km = Math.round(
        haversineKm(
          startLat,
          startLon,
          target.lat,
          target.lon
        )
      );

      distanceLabel =
        ` — roughly ${km.toLocaleString()} km` +
        distanceJoke(km);
    }

    stages.push(
      `Cover the distance to ${target.loc} via the scenic, deeply unnecessary route${distanceLabel}`
    );

    stages.push(
      `Arrive at ${target.name}, slightly dizzy but triumphant`
    );

    if (isReturn) {
      stages.push(
        `Return leg: same nonsense, reversed, aboard ${pick(FUNNY_VEHICLES)}`
      );
    }

    return stages;
  }

  // ------------------------------------------------------------------------
  // PUBLIC API
  // ------------------------------------------------------------------------

  global.TripSearchEngine = {
    fetchRandomTarget,
    fetchWikipediaThumbnail,
    buildFunnyRoute,
    haversineKm,
    pick
  };

})(window);
