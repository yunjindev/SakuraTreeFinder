/**
 * Sakura Tree Finder :: app.js
 *
 * Tree data sources (queried in parallel, results merged):
 *   1. iNaturalist API  — citizen science observations, global coverage,
 *                         includes cultivated trees via quality_grade=any
 *   2. Overpass API     — OSM individual tree nodes, good in DC/Tokyo/Europe
 *
 * Map: MapLibre GL JS (WebGL canvas)
 * Tiles: OpenFreeMap liberty style
 * Geocoding: Nominatim
 */

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

const OVERPASS_URL       = 'https://overpass-api.de/api/interpreter';
const INAT_URL           = 'https://api.inaturalist.org/v1/observations';
const SEARCH_RADIUS_M    = 50000;   // metres  (Overpass)
const SEARCH_RADIUS_KM   = 50;      // km      (iNaturalist)
const API_TIMEOUT_MS     = 20000;
const OVERPASS_RETRIES   = 3;
const DEDUP_THRESHOLD_M  = 30;      // treat two results within 30m as same tree

// iNaturalist taxon_id 47351 = genus Prunus (all species, all descendants)
const INAT_PRUNUS_TAXON  = 47351;

const DEFAULT_CENTER = [139.6503, 35.6762]; // Tokyo [lon, lat]
const DEFAULT_ZOOM   = 5;

const STATUS = {
    IDLE:        'Awaiting location request...',
    LOCATING:    'Acquiring GPS coordinates...',
    FETCHING:    'Searching for Sakura trees nearby...',
    MAPPING:     'Rendering trees on map...',
    DONE:        'Search complete. Results displayed below.',
    NO_RESULT:   'No trees found within 50km. Try a different area.',
    ERR_DENIED:  'Location permission denied. See instructions below.',
    ERR_UNAVAIL: 'Location unavailable. Check your device GPS and try again.',
    ERR_TIMEOUT: 'Location request timed out. Try again.',
    ERR_API:     'Could not fetch tree data. Please try again.',
};

// ─── State ────────────────────────────────────────────────────────────────────

let map         = null;
let userMarker  = null;
let activePopup = null;
let mapReady    = false;
let userLatLng  = null;

// ─── DOM References ───────────────────────────────────────────────────────────

const locateBtn      = document.getElementById('locate-btn');
const resetBtn       = document.getElementById('reset-btn');
const statusText     = document.getElementById('status-text');
const progressBar    = document.getElementById('progress-bar');
const progressFill   = document.getElementById('progress-fill');
const resultBox      = document.getElementById('result-box');
const noResults      = document.getElementById('no-results');
const directionsArea = document.getElementById('directions-area');
const treeCountEl    = document.getElementById('tree-count');
const geoErrorHelp   = document.getElementById('geo-error-help');
const searchInput    = document.getElementById('search-input');
const searchBtn      = document.getElementById('search-btn');
const searchError    = document.getElementById('search-error');

const rName     = document.getElementById('r-name');
const rSpecies  = document.getElementById('r-species');
const rDistance = document.getElementById('r-distance');
const rCoords   = document.getElementById('r-coords');
const rBearing  = document.getElementById('r-bearing');

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    initMap();
    locateBtn.addEventListener('click', onLocateClick);
    resetBtn.addEventListener('click', onReset);
    searchBtn.addEventListener('click', onSearchSubmit);
    searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') onSearchSubmit(); });
});

// ─── Map ──────────────────────────────────────────────────────────────────────

function initMap() {
    map = new maplibregl.Map({
        container: 'map',
        style: 'https://tiles.openfreemap.org/styles/liberty',
        center: DEFAULT_CENTER,
        zoom: DEFAULT_ZOOM,
        attributionControl: false,
    });

    map.on('load', () => {
        mapReady = true;

        map.addSource('trees', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] }
        });

        map.addLayer({
            id: 'tree-circles',
            type: 'circle',
            source: 'trees',
            paint: {
                'circle-radius': 6,
                'circle-color': '#ff69b4',
                'circle-stroke-color': '#c2185b',
                'circle-stroke-width': 2,
                'circle-opacity': 0.9,
            }
        });

        map.on('click', 'tree-circles', e => {
            const props  = e.features[0].properties;
            const coords = e.features[0].geometry.coordinates.slice();
            if (activePopup) activePopup.remove();
            activePopup = new maplibregl.Popup({ closeButton: true, offset: 8 })
                .setLngLat(coords)
                .setHTML(buildPopup(props))
                .addTo(map);
        });

        map.on('mouseenter', 'tree-circles', () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', 'tree-circles', () => { map.getCanvas().style.cursor = ''; });
    });
}

// ─── Tree Fetching — Primary: iNaturalist, Secondary: Overpass ────────────────

async function fetchTrees(lat, lon) {
    setStatus('Searching iNaturalist and OpenStreetMap...');

    const [inatResult, osmResult] = await Promise.allSettled([
        fetchFromINaturalist(lat, lon),
        fetchFromOverpass(lat, lon),
    ]);

    const trees = [];
    if (inatResult.status === 'fulfilled') trees.push(...inatResult.value);
    if (osmResult.status  === 'fulfilled') trees.push(...osmResult.value);

    // Both failed — surface an error
    if (trees.length === 0 && inatResult.status === 'rejected' && osmResult.status === 'rejected') {
        console.error('iNaturalist error:', inatResult.reason);
        console.error('Overpass error:',    osmResult.reason);
        throw new Error('All data sources failed');
    }

    return deduplicateByProximity(trees, DEDUP_THRESHOLD_M);
}

// ── iNaturalist ───────────────────────────────────────────────────────────────

async function fetchFromINaturalist(lat, lon) {
    const params = new URLSearchParams({
        taxon_id:      INAT_PRUNUS_TAXON,
        lat:           lat,
        lng:           lon,              // iNaturalist uses "lng" not "lon"
        radius:        SEARCH_RADIUS_KM,
        per_page:      200,
        quality_grade: 'any',            // crucial: includes cultivated/captive trees
        geo:           'true',
        order_by:      'id',
    });

    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

    try {
        const resp = await fetch(`${INAT_URL}?${params}`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!resp.ok) throw new Error(`iNaturalist HTTP ${resp.status}`);

        const json = await resp.json();

        return (json.results || [])
            .filter(obs => obs.location && isCherryTaxon(obs.taxon))
            .map(normalizeINatObservation)
            .filter(t => !isNaN(t.lat) && !isNaN(t.lon));

    } catch (err) {
        clearTimeout(timeoutId);
        console.warn('iNaturalist fetch failed:', err.message);
        throw err;
    }
}

/**
 * Returns true if the iNaturalist taxon is a cherry blossom species.
 * Rejects plums, peaches, apricots, almonds (other Prunus species).
 */
function isCherryTaxon(taxon) {
    if (!taxon) return false;
    const common = (taxon.preferred_common_name || '').toLowerCase();
    const name   = (taxon.name || '').toLowerCase();

    // Common name contains "cherry" or "sakura"
    if (common.includes('cherry') || common.includes('sakura')) return true;

    // Scientific name matches known cherry species
    const cherryPrefixes = [
        'prunus serrulata', 'prunus yedoensis', 'prunus × yedoensis',
        'prunus x yedoensis', 'prunus subhirtella', 'prunus pendula',
        'prunus sargentii', 'prunus speciosa', 'prunus jamasakura',
        'prunus campanulata', 'prunus avium', 'prunus cerasus',
        'prunus mahaleb', 'prunus incisa', 'prunus rufa', 'prunus nipponica',
        'prunus maximowiczii', 'prunus verecunda', 'prunus itosakura',
    ];
    return cherryPrefixes.some(p => name.startsWith(p));
}

function normalizeINatObservation(obs) {
    const [latStr, lonStr] = obs.location.split(',');
    return {
        id:         'inat_' + obs.id,
        lat:        parseFloat(latStr),
        lon:        parseFloat(lonStr),
        name:       obs.taxon?.preferred_common_name || obs.taxon?.name || 'Cherry Blossom',
        species:    obs.taxon?.name || 'Prunus sp.',
        source:     'iNaturalist',
        source_url: 'https://www.inaturalist.org/observations/' + obs.id,
    };
}

// ── Overpass (OSM) ────────────────────────────────────────────────────────────

async function fetchFromOverpass(lat, lon) {
    // Broad query — just look for any Prunus tree, any species tagging style
    const query = `
[out:json][timeout:25];
(
  node["natural"="tree"]["species"~"Prunus",i](around:${SEARCH_RADIUS_M},${lat},${lon});
  node["natural"="tree"]["taxon"~"Prunus",i](around:${SEARCH_RADIUS_M},${lat},${lon});
  node["natural"="tree"]["genus"="Prunus"](around:${SEARCH_RADIUS_M},${lat},${lon});
  node["natural"="tree"]["species:en"~"cherry",i](around:${SEARCH_RADIUS_M},${lat},${lon});
  node["natural"="tree"]["name"~"sakura|cherry blossom",i](around:${SEARCH_RADIUS_M},${lat},${lon});
);
out body;
    `.trim();

    let lastError;

    for (let attempt = 1; attempt <= OVERPASS_RETRIES; attempt++) {
        if (attempt > 1) {
            const delay = 2 ** (attempt - 2);
            await sleep(delay * 1000);
        }

        const controller = new AbortController();
        const timeoutId  = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

        try {
            const resp = await fetch(OVERPASS_URL, {
                method:  'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body:    'data=' + encodeURIComponent(query),
                signal:  controller.signal,
            });
            clearTimeout(timeoutId);

            if (resp.status >= 400 && resp.status < 500) throw new Error(`Overpass ${resp.status} not retrying`);
            if (!resp.ok) throw new Error(`Overpass HTTP ${resp.status}`);

            const json = await resp.json();
            return (json.elements || []).map(normalizeOverpassElement);

        } catch (err) {
            clearTimeout(timeoutId);
            lastError = err;
            if (err.message.includes('not retrying')) throw err;
            console.warn(`Overpass attempt ${attempt} failed:`, err.message);
        }
    }

    throw lastError;
}

function normalizeOverpassElement(el) {
    return {
        id:         'osm_' + el.id,
        lat:        el.lat,
        lon:        el.lon,
        name:       el.tags?.['name:en'] || el.tags?.name || el.tags?.['species:en'] || 'Cherry Blossom',
        species:    el.tags?.species || el.tags?.taxon || el.tags?.['species:en'] || 'Prunus sp.',
        source:     'OpenStreetMap',
        source_url: 'https://www.openstreetmap.org/node/' + el.id,
    };
}

// ── Deduplication ─────────────────────────────────────────────────────────────

function deduplicateByProximity(trees, thresholdMeters) {
    const kept = [];
    for (const tree of trees) {
        const isDup = kept.some(k => haversineMeters(k.lat, k.lon, tree.lat, tree.lon) < thresholdMeters);
        if (!isDup) kept.push(tree);
    }
    return kept;
}

// ─── Map Rendering ────────────────────────────────────────────────────────────

function renderTrees(trees) {
    const geojson = {
        type: 'FeatureCollection',
        features: trees.map(tree => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [tree.lon, tree.lat] },
            properties: {
                id:         tree.id,
                lat:        tree.lat,
                lon:        tree.lon,
                name:       tree.name,
                species:    tree.species,
                source:     tree.source,
                source_url: tree.source_url,
            }
        }))
    };

    if (mapReady) map.getSource('trees').setData(geojson);
    treeCountEl.textContent = trees.length.toLocaleString();
}

function placeUserMarker(lat, lon) {
    if (userMarker) userMarker.remove();

    const el = document.createElement('div');
    el.className = 'user-dot';

    userMarker = new maplibregl.Marker({ element: el })
        .setLngLat([lon, lat])
        .setPopup(new maplibregl.Popup({ offset: 10 })
            .setHTML('<div class="popup-title">Your Location</div>'))
        .addTo(map);
}

function buildPopup(props) {
    const name    = props.name    || 'Cherry Blossom Tree';
    const species = props.species || 'Prunus sp.';
    const lat     = parseFloat(props.lat);
    const lon     = parseFloat(props.lon);
    const url     = props.source_url || '';
    const source  = props.source     || '';

    const sourceLink = url
        ? `<div class="popup-row"><a href="${escapeHtml(url)}" target="_blank" style="font-size:11px">View on ${escapeHtml(source)} &#8594;</a></div>`
        : '';

    return `
        <div class="popup-title">&#10047; ${escapeHtml(name)}</div>
        <div class="popup-row"><span class="popup-label">Species:</span> <em>${escapeHtml(species)}</em></div>
        <div class="popup-row"><span class="popup-label">Coords:</span> ${lat.toFixed(5)}, ${lon.toFixed(5)}</div>
        ${sourceLink}
    `;
}

// ─── Main Flow ────────────────────────────────────────────────────────────────

function onLocateClick() {
    if (!navigator.geolocation) {
        setStatus(STATUS.ERR_UNAVAIL);
        return;
    }

    locateBtn.disabled = true;
    locateBtn.classList.add('hidden');
    showProgress(true);
    setStatus(STATUS.LOCATING);

    navigator.geolocation.getCurrentPosition(
        onLocationSuccess,
        onLocationError,
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
}

function onReset() {
    resetBtn.classList.add('hidden');
    locateBtn.disabled = false;
    locateBtn.classList.remove('hidden');

    resultBox.classList.add('hidden');
    noResults.classList.add('hidden');
    geoErrorHelp.classList.add('hidden');
    directionsArea.style.visibility = 'hidden';
    showProgress(false);
    setStatus(STATUS.IDLE);
    setProgress(0);

    if (userMarker)  { userMarker.remove();  userMarker  = null; }
    if (activePopup) { activePopup.remove(); activePopup = null; }
    if (mapReady) map.getSource('trees').setData({ type: 'FeatureCollection', features: [] });
    treeCountEl.textContent = '0';
    userLatLng = null;
}

async function onLocationSuccess(position) {
    const { latitude: lat, longitude: lon } = position.coords;
    userLatLng = { lat, lon };
    await searchFromLocation(lat, lon);
}

function onLocationError(err) {
    console.warn('Geolocation error:', err.code, err.message);
    showProgress(false);
    locateBtn.disabled = false;
    locateBtn.classList.remove('hidden');

    if (err.code === GeolocationPositionError.PERMISSION_DENIED) {
        setStatus(STATUS.ERR_DENIED);
        geoErrorHelp.classList.remove('hidden');
    } else if (err.code === GeolocationPositionError.POSITION_UNAVAILABLE) {
        setStatus(STATUS.ERR_UNAVAIL);
    } else {
        setStatus(STATUS.ERR_TIMEOUT);
    }
}

async function onSearchSubmit() {
    const query = searchInput.value.trim();
    if (!query) return;

    searchError.classList.add('hidden');
    searchBtn.disabled = true;
    showProgress(true);
    setStatus(`Searching for "${query}"...`);

    try {
        const url  = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&email=hunterweisenbach@me.com`;
        const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
        const results = await resp.json();

        if (!results.length) {
            searchError.classList.remove('hidden');
            showProgress(false);
            setStatus(STATUS.IDLE);
            searchBtn.disabled = false;
            return;
        }

        const { lat, lon } = results[0];
        userLatLng = { lat: parseFloat(lat), lon: parseFloat(lon) };

        resultBox.classList.add('hidden');
        noResults.classList.add('hidden');
        if (activePopup) { activePopup.remove(); activePopup = null; }
        if (mapReady) map.getSource('trees').setData({ type: 'FeatureCollection', features: [] });
        treeCountEl.textContent = '0';

        await searchFromLocation(userLatLng.lat, userLatLng.lon);

    } catch (err) {
        console.error('Geocoding error:', err);
        searchError.classList.remove('hidden');
        showProgress(false);
        setStatus(STATUS.IDLE);
    } finally {
        searchBtn.disabled = false;
    }
}

async function searchFromLocation(lat, lon) {
    placeUserMarker(lat, lon);
    map.flyTo({ center: [lon, lat], zoom: 13 });

    setStatus(STATUS.FETCHING);
    setProgress(30);

    try {
        const trees = await fetchTrees(lat, lon);
        setProgress(75);
        setStatus(STATUS.MAPPING);

        if (trees.length === 0) {
            showNoResults();
        } else {
            renderTrees(trees);
            const nearest = findNearest(trees, lat, lon);
            showResult(nearest, lat, lon);
        }

        setProgress(100);
        setTimeout(() => showProgress(false), 600);
        setStatus(STATUS.DONE);
        resetBtn.classList.remove('hidden');

    } catch (err) {
        console.error('fetchTrees error:', err);
        setStatus(STATUS.ERR_API);
        showProgress(false);
        resetBtn.classList.remove('hidden');
    }
}

// ─── Results ──────────────────────────────────────────────────────────────────

function findNearest(trees, userLat, userLon) {
    let nearest = null;
    let minDist = Infinity;

    trees.forEach(tree => {
        const d = haversineMeters(userLat, userLon, tree.lat, tree.lon);
        if (d < minDist) { minDist = d; nearest = tree; }
    });

    nearest._distanceMeters = minDist;
    return nearest;
}

function showResult(tree, userLat, userLon) {
    const bearing = compassBearing(userLat, userLon, tree.lat, tree.lon);

    rName.textContent     = tree.name;
    rSpecies.innerHTML    = `<em>${escapeHtml(tree.species)}</em>`;
    rDistance.textContent = formatDistance(tree._distanceMeters);
    rCoords.textContent   = `${tree.lat.toFixed(5)}° N, ${tree.lon.toFixed(5)}° E`;
    rBearing.textContent  = `${Math.round(bearing)}° (${degreesToCardinal(bearing)})`;

    document.getElementById('directions-link').href =
        `https://www.google.com/maps/dir/?api=1&destination=${tree.lat},${tree.lon}`;
    directionsArea.style.visibility = 'visible';

    noResults.classList.add('hidden');
    resultBox.classList.remove('hidden');

    map.fitBounds(
        [[Math.min(userLon, tree.lon), Math.min(userLat, tree.lat)],
         [Math.max(userLon, tree.lon), Math.max(userLat, tree.lat)]],
        { padding: 60, maxZoom: 16 }
    );

    if (activePopup) activePopup.remove();
    activePopup = new maplibregl.Popup({ closeButton: true, offset: 8 })
        .setLngLat([tree.lon, tree.lat])
        .setHTML(buildPopup(tree))
        .addTo(map);
}

function showNoResults() {
    resultBox.classList.remove('hidden');
    noResults.classList.remove('hidden');
    directionsArea.style.visibility = 'hidden';
    setStatus(STATUS.NO_RESULT);
}

// ─── UI Helpers ───────────────────────────────────────────────────────────────

function setStatus(msg)  { statusText.textContent = msg; }
function showProgress(v) { progressBar.classList.toggle('hidden', !v); }
function setProgress(p)  { progressFill.style.width = p + '%'; }

// ─── Math ─────────────────────────────────────────────────────────────────────

function haversineMeters(lat1, lon1, lat2, lon2) {
    const R  = 6371000;
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    const a  = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function compassBearing(lat1, lon1, lat2, lon2) {
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    const y  = Math.sin(Δλ) * Math.cos(φ2);
    const x  = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function degreesToCardinal(deg) {
    const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
    return dirs[Math.round(deg / 22.5) % 16];
}

function formatDistance(meters) {
    return meters < 1000 ? Math.round(meters) + ' m' : (meters / 1000).toFixed(2) + ' km';
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Security ─────────────────────────────────────────────────────────────────

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
