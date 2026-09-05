RudVentur – Feeling Lucky
A single-file, no-build, vanilla HTML/CSS/JS "I'm Feeling Lucky" for real places. No curated list, no suggestions — every target comes from a live random search of OpenStreetMap data via the Overpass API, picked with a single uniform random draw across whatever the search turns up.
What it does
Three modes:
Lucky Place — real nearby places: cafés, parks, museums, bookshops, viewpoints, and so on.
Lucky Event — real nearby venues where things happen: theatres, stadiums, nightclubs, theme parks. (There's no free public live-events API, so this is honestly "venue", not a scheduled event with a date.)
Good Trip — both pools combined.
Each mode also has a Present / Past / Future filter:
Present — normal, currently-open places.
Past — real `historic=*` tagged OpenStreetMap sites: ruins, monuments, memorials, former buildings.
Future — real `construction=*` tagged sites: places that are literally being built right now. (Chosen deliberately over fabricating fake future event dates.)
How the randomisation works
The visible map is the real search area — pan, zoom, or drag the resize handle to change what gets searched. It isn't decorative.
Hitting I'm Feeling Lucky builds an Overpass QL query for the current mode/filter and sends it to whichever of three independent Overpass mirrors responds first:
`overpass-api.de`
`overpass.kumi.systems`
`overpass.osm.ch`
Every matching real place comes back, and one is picked with a single `Math.random()` draw — uniform, no weighting, no ranking.
If nothing matches, the search area automatically widens (zooms out) a few times before it honestly reports no luck, rather than falling back to a fake result.
If you haven't set a start point or touched the map at all, it quietly tries a one-shot GPS lookup first — otherwise the default world view would search the middle of the ocean.
Running it
It's a single static HTML file — no build step, no dependencies to install.
Locally: just open `feeling-lucky.html` in a browser. Some browsers restrict pages opened directly as a local file (`file://…`) from calling external APIs, which can show up as a `Failed to fetch` error even though nothing is actually wrong with the code — if you hit that, serve the folder locally (e.g. VS Code's Live Server) or test it via GitHub Pages instead.
GitHub Pages: push `feeling-lucky.html` (rename to `index.html` if you want it at the repo root) to a repo and enable Pages in Settings → Pages. That's the real target environment and the most reliable way to test it.
Structure
One file. All CSS and JS are inline — no build tools, no package manager, matching the rest of the RudVentur projects. The only external dependencies are loaded via CDN at runtime: Leaflet for the map, and OpenStreetMap tiles/Overpass for data.
Known limitations
Routes and "leave by" timing are still rough placeholders (`buildRoute` / `estimateLeaveHours`), not real routing or transit data — flagged as "estimation" in the UI on purpose.
The typed start-point text field doesn't geocode free text into coordinates yet — GPS and map-pick are the reliable ways to set a start point.
Overpass is a shared public service with fair-use limits; heavy repeated use can get rate-limited (hence the three-mirror fallback).
Credits
Map data © OpenStreetMap contributors, queried via the Overpass API.
Map rendering via Leaflet.
