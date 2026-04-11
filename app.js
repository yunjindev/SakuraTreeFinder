/**
 * Sakura Tree Finder :: app.js
 *
 * Map: MapLibre GL JS (WebGL canvas — no tile-grid desync issues)
 * Tiles: OpenFreeMap liberty style (free, no API key)
 * Trees: Overpass API queried live on geolocation
 */

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

const OVERPASS_URL         = 'https://overpass-api.de/api/interpreter';
const OVERPASS_TIMEOUT_MS  = 20000;
const OVERPASS_MAX_RETRIES = 3;
const SEARCH_RADIUS        = 50000;

// MapLibre uses [lon, lat] order (GeoJSON standard)
const DEFAULT_CENTER = [139.6503, 35.6762]; // Tokyo
const DEFAULT_ZOOM   = 5;

const STATUS = {
    IDLE:        'Awaiting location request...',
    LOCATING:    'Acquiring GPS coordinates...',
    FETCHING:    'Querying Overpass API for Sakura trees...',
    MAPPING:     'Rendering trees on map...',
    DONE:        'Search complete. Results displayed below.',
    NO_RESULT:   'No trees found within 50km. Try a larger area.',
    ERR_DENIED:  'Location permission denied. See instructions below.',
    ERR_UNAVAIL: 'Location unavailable. Check your device GPS and try again.',
    ERR_TIMEOUT: 'Location request timed out. Try again.',
    ERR_API:     'Overpass API unavailable after 3 attempts. Try again later.',
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
});

// ─── Map ──────────────────────────────────────────────────────────────────────

function initMap() {
    map = new maplibregl.Map({
        container: 'map',
        style: 'https://tiles.openfreemap.org/styles/liberty',
        center: DEFAULT_CENTER,
        zoom: DEFAULT_ZOOM,
        attributionControl: true,
    });

    map.on('load', () => {
        mapReady = true;

        // GeoJSON source — all tree dots live here
        map.addSource('trees', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] }
        });

        // Pink circle layer — rendered in WebGL, handles thousands of points
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

        // Popup on tree click
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

function renderTrees(trees) {
    const geojson = {
        type: 'FeatureCollection',
        features: trees.map(tree => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [tree.lon, tree.lat] },
            properties: {
                id:      tree.id,
                lat:     tree.lat,
                lon:     tree.lon,
                name:    tree.tags?.name    || tree.tags?.['name:en']    || '',
                species: tree.tags?.species || tree.tags?.['species:en'] || tree.tags?.taxon || '',
                height:  tree.tags?.height  || '',
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
    const name    = props.name    || ('Cherry Blossom Tree #' + props.id);
    const species = props.species || 'Prunus sp.';
    const lat     = typeof props.lat === 'number' ? props.lat : parseFloat(props.lat);
    const lon     = typeof props.lon === 'number' ? props.lon : parseFloat(props.lon);
    const height  = props.height
        ? `<div class="popup-row"><span class="popup-label">Height:</span> ${escapeHtml(String(props.height))}m</div>`
        : '';

    return `
        <div class="popup-title">&#10047; ${escapeHtml(name)}</div>
        <div class="popup-row"><span class="popup-label">Species:</span> <em>${escapeHtml(species)}</em></div>
        ${height}
        <div class="popup-row"><span class="popup-label">Coords:</span> ${lat.toFixed(5)}, ${lon.toFixed(5)}</div>
        <div class="popup-row"><a href="https://www.openstreetmap.org/node/${props.id}" target="_blank" style="font-size:11px">View on OSM &#8594;</a></div>
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

    placeUserMarker(lat, lon);
    map.setCenter([lon, lat]);
    map.setZoom(13);

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
        console.error('Overpass API error:', err);
        setStatus(STATUS.ERR_API);
        showProgress(false);
        resetBtn.classList.remove('hidden');
    }
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

// ─── Overpass API ─────────────────────────────────────────────────────────────

async function fetchTrees(lat, lon) {
    const query = `
[out:json][timeout:25];
(
  node["natural"="tree"]["species"~"Prunus serrulata|Prunus × yedoensis|Prunus yedoensis|Prunus pendula|Prunus subhirtella|Prunus sargentii|Prunus speciosa|Prunus jamasakura",i](around:${SEARCH_RADIUS},${lat},${lon});
  node["natural"="tree"]["taxon"~"Prunus serrulata|Prunus yedoensis|Prunus pendula|Prunus subhirtella|Prunus sargentii",i](around:${SEARCH_RADIUS},${lat},${lon});
  node["natural"="tree"]["species:en"~"cherry blossom|japanese cherry|yoshino cherry|sakura",i](around:${SEARCH_RADIUS},${lat},${lon});
  node["natural"="tree"]["name"~"sakura|cherry blossom|cerisier|kirschbaum",i](around:${SEARCH_RADIUS},${lat},${lon});
);
out body;
    `.trim();

    let lastError;

    for (let attempt = 1; attempt <= OVERPASS_MAX_RETRIES; attempt++) {
        if (attempt > 1) {
            const delaySec = 2 ** (attempt - 2);
            setStatus(`Overpass API busy. Retrying in ${delaySec}s... (attempt ${attempt}/${OVERPASS_MAX_RETRIES})`);
            await sleep(delaySec * 1000);
            setStatus(STATUS.FETCHING);
        }

        const controller = new AbortController();
        const timeoutId  = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_MS);

        try {
            const resp = await fetch(OVERPASS_URL, {
                method:  'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body:    'data=' + encodeURIComponent(query),
                signal:  controller.signal,
            });
            clearTimeout(timeoutId);

            if (resp.status >= 400 && resp.status < 500) {
                throw new Error(`Overpass API returned ${resp.status}. Not retrying.`);
            }
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

            const json = await resp.json();
            return json.elements || [];

        } catch (err) {
            clearTimeout(timeoutId);
            lastError = err;
            if (err.message && err.message.includes('Not retrying')) throw err;
            console.warn(`Overpass attempt ${attempt} failed:`, err.message);
        }
    }

    throw lastError;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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
    const name    = tree.tags?.name    || tree.tags?.['name:en']    || '(unnamed tree #' + tree.id + ')';
    const species = tree.tags?.species || tree.tags?.['species:en'] || tree.tags?.taxon || 'Prunus sp. (cherry)';
    const bearing = compassBearing(userLat, userLon, tree.lat, tree.lon);

    rName.textContent     = name;
    rSpecies.innerHTML    = `<em>${escapeHtml(species)}</em>`;
    rDistance.textContent = formatDistance(tree._distanceMeters);
    rCoords.textContent   = `${tree.lat.toFixed(5)}° N, ${tree.lon.toFixed(5)}° E`;
    rBearing.textContent  = `${Math.round(bearing)}° (${degreesToCardinal(bearing)})`;

    document.getElementById('directions-link').href =
        `https://www.google.com/maps/dir/?api=1&destination=${tree.lat},${tree.lon}`;
    directionsArea.style.visibility = 'visible';

    noResults.classList.add('hidden');
    resultBox.classList.remove('hidden');

    // Fit map to frame both user and nearest tree
    map.fitBounds(
        [[Math.min(userLon, tree.lon), Math.min(userLat, tree.lat)],
         [Math.max(userLon, tree.lon), Math.max(userLat, tree.lat)]],
        { padding: 60, maxZoom: 16 }
    );

    // Open popup on the nearest tree
    if (activePopup) activePopup.remove();
    activePopup = new maplibregl.Popup({ closeButton: true, offset: 8 })
        .setLngLat([tree.lon, tree.lat])
        .setHTML(buildPopup({
            id:      tree.id,
            lat:     tree.lat,
            lon:     tree.lon,
            name:    tree.tags?.name    || tree.tags?.['name:en']    || '',
            species: tree.tags?.species || tree.tags?.['species:en'] || tree.tags?.taxon || '',
            height:  tree.tags?.height  || '',
        }))
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

// ─── Security ─────────────────────────────────────────────────────────────────

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
