/**
 * TrueAdvisor Full Scraper — Apify Actor
 *
 * Strategy:
 *   - Dense metro areas (NYC, LA, Chicago, etc.) → 0.05° tiles
 *   - All other US areas                         → 1.0° tiles
 *   - Any tile still returning 50 results gets   → auto sub-tiled at 0.01°
 *
 * Output: Apify dataset (downloadable as CSV/JSON/Excel from Apify console)
 */

import Apify from 'apify';

const { Actor, Dataset, log } = Apify;

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

const BASE_URL   = 'https://trueadvisor.com';
const ENDPOINT   = '/api/map-search/';
const API_CAP    = 50;   // Max results the API returns per tile

// Continental US bounding box
const US = { latMin: 24.5, latMax: 49.5, lngMin: -125.0, lngMax: -66.5 };

// Known dense metro areas that need fine tiling (0.05°)
// Format: [name, latMin, latMax, lngMin, lngMax]
const METROS = [
    ['New York City',    40.4, 41.3, -74.4, -73.6],
    ['Los Angeles',      33.6, 34.4, -118.8,-117.9],
    ['Chicago',          41.5, 42.2, -88.1, -87.3],
    ['Houston',          29.4, 30.2, -95.9, -95.0],
    ['Dallas',           32.5, 33.3, -97.2, -96.4],
    ['Phoenix',          33.2, 33.8, -112.5,-111.7],
    ['Philadelphia',     39.8, 40.3, -75.4, -74.9],
    ['San Antonio',      29.1, 29.8, -98.8, -98.2],
    ['San Diego',        32.5, 33.0, -117.4,-116.8],
    ['San Jose',         37.1, 37.6, -122.2,-121.6],
    ['Austin',           30.0, 30.6, -98.0, -97.4],
    ['Seattle',          47.3, 47.9, -122.6,-121.9],
    ['Denver',           39.5, 40.0, -105.2,-104.6],
    ['Boston',           42.1, 42.6, -71.4, -70.8],
    ['Miami',            25.5, 26.1, -80.6, -80.0],
    ['Atlanta',          33.5, 34.1, -84.8, -84.1],
    ['Minneapolis',      44.7, 45.2, -93.6, -92.9],
    ['Portland',         45.3, 45.8, -122.9,-122.3],
    ['St Louis',         38.4, 38.9, -90.5, -89.9],
    ['Tampa',            27.7, 28.2, -82.8, -82.2],
    ['Pittsburgh',       40.2, 40.7, -80.3, -79.7],
    ['Charlotte',        34.9, 35.5, -81.1, -80.5],
    ['Sacramento',       38.3, 38.8, -121.8,-121.2],
    ['Kansas City',      38.8, 39.3, -94.8, -94.2],
    ['Columbus',         39.8, 40.3, -83.3, -82.7],
    ['Cleveland',        41.3, 41.8, -81.9, -81.3],
    ['Indianapolis',     39.6, 40.1, -86.5, -85.9],
    ['San Francisco',    37.6, 37.9, -122.6,-122.3],
    ['Las Vegas',        35.9, 36.4, -115.5,-114.9],
    ['Cincinnati',       39.0, 39.4, -84.8, -84.2],
    ['Raleigh',          35.6, 36.1, -79.1, -78.5],
    ['Washington DC',    38.7, 39.2, -77.4, -76.8],
    ['Baltimore',        39.1, 39.6, -76.9, -76.3],
    ['Nashville',        36.0, 36.5, -87.1, -86.5],
    ['Salt Lake City',   40.5, 41.0, -112.2,-111.6],
    ['Richmond',         37.3, 37.8, -77.7, -77.1],
    ['Hartford',         41.6, 42.1, -73.0, -72.4],
    ['Jacksonville',     30.0, 30.5, -81.9, -81.3],
    ['Oklahoma City',    35.3, 35.8, -97.7, -97.1],
    ['Memphis',          34.9, 35.4, -90.3, -89.7],
    ['Louisville',       38.0, 38.5, -85.9, -85.3],
    ['New Orleans',      29.8, 30.3, -90.4, -89.8],
    ['Buffalo',          42.7, 43.2, -79.1, -78.5],
    ['Hartford',         41.6, 42.1, -72.9, -72.3],
    ['Birmingham',       33.3, 33.8, -87.0, -86.4],
    ['Rochester',        43.0, 43.4, -77.8, -77.2],
];

// ─── TILE HELPERS ────────────────────────────────────────────────────────────

function round6(n) {
    return Math.round(n * 1e6) / 1e6;
}

/**
 * Build a flat list of {swLat, swLng, neLat, neLng} tiles
 * covering [latMin,latMax] × [lngMin,lngMax] at given step size.
 */
function buildTiles(latMin, latMax, lngMin, lngMax, step) {
    const tiles = [];
    for (let lat = latMin; lat < latMax; lat = round6(lat + step)) {
        for (let lng = lngMin; lng < lngMax; lng = round6(lng + step)) {
            tiles.push({
                swLat: round6(lat),
                swLng: round6(lng),
                neLat: round6(Math.min(lat + step, latMax)),
                neLng: round6(Math.min(lng + step, lngMax)),
            });
        }
    }
    return tiles;
}

/**
 * Returns true if a point (lat, lng) is inside any metro bounding box.
 */
function isInMetro(lat, lng) {
    return METROS.some(([, latMin, latMax, lngMin, lngMax]) =>
        lat >= latMin && lat < latMax && lng >= lngMin && lng < lngMax
    );
}

/**
 * Build the full tile list:
 *   - 1° tiles for rural US (skipping metro areas)
 *   - 0.05° tiles for each metro
 */
function buildAllTiles() {
    const tiles = [];

    // Coarse rural tiles (1°), skipping cells that overlap a metro
    for (const tile of buildTiles(US.latMin, US.latMax, US.lngMin, US.lngMax, 1.0)) {
        const centerLat = (tile.swLat + tile.neLat) / 2;
        const centerLng = (tile.swLng + tile.neLng) / 2;
        if (!isInMetro(centerLat, centerLng)) {
            tiles.push({ ...tile, resolution: 'rural' });
        }
    }

    // Fine metro tiles (0.05°)
    for (const [name, latMin, latMax, lngMin, lngMax] of METROS) {
        for (const tile of buildTiles(latMin, latMax, lngMin, lngMax, 0.05)) {
            tiles.push({ ...tile, resolution: `metro:${name}` });
        }
    }

    return tiles;
}

// ─── ADVISOR FLATTENER ───────────────────────────────────────────────────────

function flattenAdvisor(a) {
    return {
        advisor_id:              a.individual_pk,
        full_name:               a.full_name,
        city:                    a.city,
        state:                   a.state,
        address:                 a.address,
        latitude:                a.latitude,
        longitude:               a.longitude,
        years_experience:        a.years_experience,
        firm_name:               a.current_firm_name,
        firm_crd:                a.current_firm_crd,
        firm_advisor_count:      a.current_firm_advisor_count,
        firm_client_count:       a.current_firm_client_count,
        avg_advisor_aum:         a.avg_advisor_aum,
        avg_client_aum:          a.avg_client_aum,
        minimum_investment:      a.minimum_investment,
        compensation_types:      (a.compensation_types  || []).join('; '),
        planning_fee_structure:  a.planning_fee_structure,
        min_aum_fee_pct:         a.min_aum_fee,
        max_aum_fee_pct:         a.max_aum_fee,
        min_hourly_fee:          a.min_hourly_fee,
        max_hourly_fee:          a.max_hourly_fee,
        calculated_fee_amount:   a.calculated_fee?.fee_amount,
        effective_rate_pct:      a.calculated_fee?.effective_rate,
        fee_percentile:          a.calculated_fee?.fee_percentile,
        disclosure_count:        a.disclosure_count,
        is_broker:               a.is_broker,
        areas_of_practice:       (a.areas_of_practice || []).join('; '),
        designations:            (a.designations       || []).join('; '),
        has_email:               a.has_email,
        claimed:                 a.claimed,
        profile_url:             `https://trueadvisor.com/advisor/${a.individual_pk}/`,
    };
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

await Actor.init();

const input = await Actor.getInput() ?? {};
const PORTFOLIO       = input.portfolio      ?? 1160000;
const MAX_CONCURRENCY = input.maxConcurrency ?? 5;
const DELAY_MS        = input.delayMs        ?? 200;

const dataset  = await Dataset.open();
const seen     = new Set();
let   total    = 0;
let   cappedCount = 0;

log.info('Building tile list...');
const tiles = buildAllTiles();
log.info(`Total tiles to fetch: ${tiles.length.toLocaleString()}`);
log.info(`Max concurrency: ${MAX_CONCURRENCY}`);

/**
 * Fetch a single tile, return the advisors array.
 * Returns [] on error after retries.
 */
async function fetchTile(tile, retries = 3) {
    const url = `${BASE_URL}${ENDPOINT}?ne_lat=${tile.neLat}&ne_lng=${tile.neLng}&sw_lat=${tile.swLat}&sw_lng=${tile.swLng}&type=advisors&portfolio=${PORTFOLIO}&skip_count=true`;

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const resp = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                    'Referer':    'https://trueadvisor.com/search?type=advisors',
                    'Accept':     'application/json',
                },
            });

            if (resp.status === 429) {
                const wait = 5000 * attempt;
                log.warning(`Rate limited — waiting ${wait}ms`);
                await new Promise(r => setTimeout(r, wait));
                continue;
            }

            if (!resp.ok) {
                log.warning(`HTTP ${resp.status} for tile ${tile.swLat},${tile.swLng}`);
                return [];
            }

            const data = await resp.json();
            return data.advisors ?? [];

        } catch (err) {
            if (attempt === retries) {
                log.error(`Failed tile ${tile.swLat},${tile.swLng}: ${err.message}`);
                return [];
            }
            await new Promise(r => setTimeout(r, 2000 * attempt));
        }
    }
    return [];
}

/**
 * Process a tile: fetch it, save new advisors, sub-tile if capped.
 */
async function processTile(tile, depth = 0) {
    const advisors = await fetchTile(tile);
    const newRows  = [];

    for (const a of advisors) {
        if (!seen.has(a.individual_pk)) {
            seen.add(a.individual_pk);
            newRows.push(flattenAdvisor(a));
        }
    }

    if (newRows.length > 0) {
        await dataset.pushData(newRows);
        total += newRows.length;
    }

    // If capped and we haven't gone too deep, sub-tile at 0.01°
    if (advisors.length >= API_CAP && depth < 2) {
        cappedCount++;
        const subTiles = buildTiles(tile.swLat, tile.neLat, tile.swLng, tile.neLng, 0.01);
        await processQueue(subTiles, depth + 1);
    }

    await new Promise(r => setTimeout(r, DELAY_MS));
}

/**
 * Run a list of tiles with bounded concurrency.
 */
async function processQueue(tileList, depth = 0) {
    let index = 0;

    async function worker() {
        while (index < tileList.length) {
            const tile = tileList[index++];
            await processTile(tile, depth);

            if (total % 1000 === 0 && total > 0) {
                log.info(`Progress: ${total.toLocaleString()} unique advisors saved | Tiles processed: ${index}/${tileList.length}`);
            }
        }
    }

    const workers = Array.from({ length: MAX_CONCURRENCY }, worker);
    await Promise.all(workers);
}

log.info('Starting scrape...');
const startTime = Date.now();

await processQueue(tiles);

const elapsed = Math.round((Date.now() - startTime) / 1000);
log.info('═'.repeat(50));
log.info(`DONE in ${elapsed}s`);
log.info(`Total unique advisors: ${total.toLocaleString()}`);
log.info(`Capped tiles that were sub-tiled: ${cappedCount}`);
log.info('Download your CSV from the Storage → Dataset tab in Apify console.');
log.info('═'.repeat(50));

await Actor.exit();
