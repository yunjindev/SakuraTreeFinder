/**
 * Sakura Tree Finder :: app.js
 *
 * - Initializes a Leaflet map with CartoDB Voyager tiles
 * - Uses browser Geolocation API to get user position
 * - Queries Overpass API for nearby cherry blossom trees
 * - Finds and highlights the nearest one
 * - Renders pink dot markers for all results
 */

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

const OVERPASS_URL         = 'https://overpass-api.de/api/interpreter';
const OVERPASS_TIMEOUT_MS  = 20000;  // abort a single attempt after 20s
const OVERPASS_MAX_RETRIES = 3;      // total attempts before giving up

// Search radius in meters
const SEARCH_RADIUS = 50000;

// Default map center (Tokyo — spiritual home of the sakura)
const DEFAULT_CENTER = [35.6762, 139.6503];
const DEFAULT_ZOOM   = 5;

// Statuses displayed in the terminal-style status bar
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

// ─── Module State ─────────────────────────────────────────────────────────────

let map          = null;   // Leaflet map instance
let userMarker   = null;   // User location marker
let treeLayer    = null;   // LayerGroup for tree markers
let userLatLng   = null;   // { lat, lon }

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

// Result fields
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

// ─── Map Initialization ───────────────────────────────────────────────────────

function initMap() {
    map = L.map('map', {
        center: DEFAULT_CENTER,
        zoom:   DEFAULT_ZOOM,
        zoomControl: true,
        attributionControl: true,
    });

    // CartoDB Voyager — clean, slightly vintage look, free, no API key
    L.tileLayer(
        'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
        {
            attribution:
                '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/">CARTO</a>',
            subdomains: 'abcd',
            maxZoom: 19,
        }
    ).addTo(map);

    treeLayer = L.layerGroup().addTo(map);
}

// ─── Main Flow ────────────────────────────────────────────────────────────────

function onLocateClick() {
    if (!navigator.geolocation) {
        setStatus(STATUS.ERR_GEO);
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

    // Remove user marker & tree markers
    if (userMarker) { map.removeLayer(userMarker); userMarker = null; }
    treeLayer.clearLayers();
    treeCountEl.textContent = '0';
    userLatLng = null;
}

async function onLocationSuccess(position) {
    const { latitude: lat, longitude: lon } = position.coords;
    userLatLng = { lat, lon };

    // Place user marker
    placeUserMarker(lat, lon);
    map.setView([lat, lon], 13);

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
        // TIMEOUT or unknown
        setStatus(STATUS.ERR_TIMEOUT);
    }
}

// ─── Overpass API Query ───────────────────────────────────────────────────────

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
            const delaySec = 2 ** (attempt - 2); // 1s, 2s
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

            // 4xx errors are not transient — don't retry
            if (resp.status >= 400 && resp.status < 500) {
                throw new Error(`Overpass API returned ${resp.status}. Not retrying.`);
            }

            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

            const json = await resp.json();
            return json.elements || [];

        } catch (err) {
            clearTimeout(timeoutId);
            lastError = err;

            // Non-transient: bubble immediately
            if (err.message && err.message.includes('Not retrying')) throw err;

            // Otherwise loop to next attempt
            console.warn(`Overpass attempt ${attempt} failed:`, err.message);
        }
    }

    throw lastError;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function renderTrees(trees) {
    treeLayer.clearLayers();

    trees.forEach(tree => {
        const icon = L.divIcon({
            className:  'sakura-marker-container',
            html:       '<div class="sakura-dot"></div>',
            iconSize:   [10, 10],
            iconAnchor: [5, 5],
        });

        const marker = L.marker([tree.lat, tree.lon], { icon });
        marker.bindPopup(buildPopup(tree));
        treeLayer.addLayer(marker);
    });

    treeCountEl.textContent = trees.length.toLocaleString();
}

function placeUserMarker(lat, lon) {
    if (userMarker) map.removeLayer(userMarker);

    const icon = L.divIcon({
        className:  'user-marker-container',
        html:       '<div class="user-dot"></div>',
        iconSize:   [14, 14],
        iconAnchor: [7, 7],
    });

    userMarker = L.marker([lat, lon], { icon, zIndexOffset: 1000 });
    userMarker.bindPopup('<div class="popup-title">Your Location</div>');
    userMarker.addTo(map);
}

function buildPopup(tree) {
    const name    = tree.tags?.name || tree.tags?.['name:en'] || 'Cherry Blossom Tree';
    const species = tree.tags?.species || tree.tags?.taxon || tree.tags?.['species:en'] || 'Prunus sp.';
    const height  = tree.tags?.height ? `<div class="popup-row"><span class="popup-label">Height:</span> ${tree.tags.height}m</div>` : '';

    return `
        <div class="popup-title">&#10047; ${escapeHtml(name)}</div>
        <div class="popup-row"><span class="popup-label">Species:</span> <em>${escapeHtml(species)}</em></div>
        ${height}
        <div class="popup-row"><span class="popup-label">Coords:</span> ${tree.lat.toFixed(5)}, ${tree.lon.toFixed(5)}</div>
        <div class="popup-row"><a href="https://www.openstreetmap.org/node/${tree.id}" target="_blank" style="font-size:11px">View on OSM &#8594;</a></div>
    `;
}

// ─── Nearest Tree Calculation ─────────────────────────────────────────────────

function findNearest(trees, userLat, userLon) {
    let nearest  = null;
    let minDist  = Infinity;

    trees.forEach(tree => {
        const d = haversineMeters(userLat, userLon, tree.lat, tree.lon);
        if (d < minDist) {
            minDist  = d;
            nearest  = tree;
        }
    });

    nearest._distanceMeters = minDist;
    return nearest;
}

function showResult(tree, userLat, userLon) {
    const name    = tree.tags?.name || tree.tags?.['name:en'] || '(unnamed tree #' + tree.id + ')';
    const species = tree.tags?.species || tree.tags?.taxon || tree.tags?.['species:en'] || 'Prunus sp. (cherry)';
    const dist    = tree._distanceMeters;
    const bearing = compassBearing(userLat, userLon, tree.lat, tree.lon);

    rName.textContent     = name;
    rSpecies.innerHTML    = `<em>${escapeHtml(species)}</em>`;
    rDistance.textContent = formatDistance(dist);
    rCoords.textContent   = `${tree.lat.toFixed(5)}° N, ${tree.lon.toFixed(5)}° E`;
    rBearing.textContent  = `${Math.round(bearing)}° (${degreesToCardinal(bearing)})`;

    const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${tree.lat},${tree.lon}`;
    const dirLink = document.getElementById('directions-link');
    dirLink.href = mapsUrl;
    directionsArea.style.visibility = 'visible';

    noResults.classList.add('hidden');
    resultBox.classList.remove('hidden');

    // Pan map to center between user and nearest tree
    const bounds = L.latLngBounds([[userLat, userLon], [tree.lat, tree.lon]]);
    map.fitBounds(bounds, { padding: [50, 50], maxZoom: 16 });

    // Highlight the nearest tree marker by opening its popup
    treeLayer.eachLayer(layer => {
        const ll = layer.getLatLng();
        if (Math.abs(ll.lat - tree.lat) < 0.00001 && Math.abs(ll.lng - tree.lon) < 0.00001) {
            layer.openPopup();
        }
    });
}

function showNoResults() {
    resultBox.classList.remove('hidden');
    noResults.classList.remove('hidden');
    directionsArea.style.visibility = 'hidden';
    setStatus(STATUS.NO_RESULT);
}

// ─── UI Helpers ───────────────────────────────────────────────────────────────

function setStatus(msg) {
    statusText.textContent = msg;
}

function showProgress(visible) {
    if (visible) {
        progressBar.classList.remove('hidden');
    } else {
        progressBar.classList.add('hidden');
    }
}

function setProgress(pct) {
    progressFill.style.width = pct + '%';
}

// ─── Math Utilities ───────────────────────────────────────────────────────────

/**
 * Haversine formula — returns distance in meters between two lat/lon pairs.
 */
function haversineMeters(lat1, lon1, lat2, lon2) {
    const R  = 6371000; // Earth radius in metres
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(Δφ / 2) ** 2 +
              Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Returns the initial bearing (degrees, 0–360) from point 1 to point 2.
 */
function compassBearing(lat1, lon1, lat2, lon2) {
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) -
              Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);

    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function degreesToCardinal(deg) {
    const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    return dirs[Math.round(deg / 22.5) % 16];
}

function formatDistance(meters) {
    if (meters < 1000) {
        return Math.round(meters) + ' m';
    }
    return (meters / 1000).toFixed(2) + ' km';
}

// ─── Security Helper ──────────────────────────────────────────────────────────

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g,  '&amp;')
        .replace(/</g,  '&lt;')
        .replace(/>/g,  '&gt;')
        .replace(/"/g,  '&quot;')
        .replace(/'/g,  '&#039;');
}
