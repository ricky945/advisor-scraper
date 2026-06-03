import { Actor, Dataset, log } from 'apify';

await Actor.init();

const input = await Actor.getInput() ?? {};
const PORTFOLIO       = input.portfolio      ?? 1160000;
const CONCURRENCY     = input.maxConcurrency ?? 10;
const DELAY_MS        = input.delayMs        ?? 100;
const API_CAP         = 50;
const BASE            = 'https://trueadvisor.com';

const r6 = n => Math.round(n * 1e6) / 1e6;

function tiles(latMin, latMax, lngMin, lngMax, step) {
  const out = [];
  for (let la = latMin; la < latMax; la = r6(la + step))
    for (let lo = lngMin; lo < lngMax; lo = r6(lo + step))
      out.push({ swLat: r6(la), swLng: r6(lo),
                 neLat: r6(Math.min(la+step,latMax)),
                 neLng: r6(Math.min(lo+step,lngMax)) });
  return out;
}

const METROS = [
  ['NYC',       40.4,41.3,-74.4,-73.6], ['LA',       33.6,34.4,-118.8,-117.9],
  ['Chicago',   41.5,42.2,-88.1,-87.3], ['Houston',  29.4,30.2,-95.9,-95.0],
  ['Dallas',    32.5,33.3,-97.2,-96.4], ['Phoenix',  33.2,33.8,-112.5,-111.7],
  ['Philly',    39.8,40.3,-75.4,-74.9], ['Seattle',  47.3,47.9,-122.6,-121.9],
  ['Denver',    39.5,40.0,-105.2,-104.6],['Boston',  42.1,42.6,-71.4,-70.8],
  ['Miami',     25.5,26.1,-80.6,-80.0], ['Atlanta',  33.5,34.1,-84.8,-84.1],
  ['DC',        38.7,39.2,-77.4,-76.8], ['SF',       37.6,37.9,-122.6,-122.3],
  ['Minneapolis',44.7,45.2,-93.6,-92.9],['Portland', 45.3,45.8,-122.9,-122.3],
  ['Tampa',     27.7,28.2,-82.8,-82.2], ['Charlotte',34.9,35.5,-81.1,-80.5],
  ['Austin',    30.0,30.6,-98.0,-97.4], ['SanDiego', 32.5,33.0,-117.4,-116.8],
  ['SanJose',   37.1,37.6,-122.2,-121.6],['LasVegas',35.9,36.4,-115.5,-114.9],
  ['Nashville', 36.0,36.5,-87.1,-86.5], ['Raleigh',  35.6,36.1,-79.1,-78.5],
  ['StLouis',   38.4,38.9,-90.5,-89.9], ['Pittsburgh',40.2,40.7,-80.3,-79.7],
  ['Cleveland', 41.3,41.8,-81.9,-81.3], ['SaltLake', 40.5,41.0,-112.2,-111.6],
  ['KansasCity',38.8,39.3,-94.8,-94.2], ['Indianapolis',39.6,40.1,-86.5,-85.9],
];

const metroBoxes = METROS.map(([,a,b,c,d]) => [a,b,c,d]);
const inMetro = (la, lo) => metroBoxes.some(([a,b,c,d]) => la>=a&&la<b&&lo>=c&&lo<d);

const allTiles = [
  ...tiles(24.5,49.5,-125,-66.5,1.0).filter(t => {
    const clat = (t.swLat+t.neLat)/2, clng = (t.swLng+t.neLng)/2;
    return !inMetro(clat, clng);
  }),
  ...METROS.flatMap(([,a,b,c,d]) => tiles(a,b,c,d,0.05)),
];

log.info(`Total tiles: ${allTiles.length.toLocaleString()}`);
log.info(`Concurrency: ${CONCURRENCY}`);

async function fetchTile({ swLat, swLng, neLat, neLng }, attempt = 0) {
  const url = `${BASE}/api/map-search/?ne_lat=${neLat}&ne_lng=${neLng}&sw_lat=${swLat}&sw_lng=${swLng}&type=advisors&portfolio=${PORTFOLIO}&skip_count=true`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        'Referer':    'https://trueadvisor.com/search?type=advisors',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 429) {
      await new Promise(r => setTimeout(r, 3000 * (attempt+1)));
      return fetchTile({ swLat, swLng, neLat, neLng }, attempt+1);
    }
    if (!res.ok) return [];
    const d = await res.json();
    return d.advisors ?? [];
  } catch {
    if (attempt < 2) {
      await new Promise(r => setTimeout(r, 2000));
      return fetchTile({ swLat, swLng, neLat, neLng }, attempt+1);
    }
    return [];
  }
}

function flatten(a) {
  return {
    advisor_id:             a.individual_pk,
    full_name:              a.full_name,
    city:                   a.city,
    state:                  a.state,
    address:                a.address,
    latitude:               a.latitude,
    longitude:              a.longitude,
    years_experience:       a.years_experience,
    firm_name:              a.current_firm_name,
    firm_crd:               a.current_firm_crd,
    firm_advisor_count:     a.current_firm_advisor_count,
    firm_client_count:      a.current_firm_client_count,
    avg_advisor_aum:        a.avg_advisor_aum,
    avg_client_aum:         a.avg_client_aum,
    minimum_investment:     a.minimum_investment,
    compensation_types:     (a.compensation_types  || []).join('; '),
    planning_fee_structure: a.planning_fee_structure,
    min_aum_fee_pct:        a.min_aum_fee,
    max_aum_fee_pct:        a.max_aum_fee,
    min_hourly_fee:         a.min_hourly_fee,
    max_hourly_fee:         a.max_hourly_fee,
    calculated_fee_amount:  a.calculated_fee?.fee_amount,
    effective_rate_pct:     a.calculated_fee?.effective_rate,
    fee_percentile:         a.calculated_fee?.fee_percentile,
    disclosure_count:       a.disclosure_count,
    is_broker:              a.is_broker,
    areas_of_practice:      (a.areas_of_practice || []).join('; '),
    designations:           (a.designations      || []).join('; '),
    has_email:              a.has_email,
    claimed:                a.claimed,
    profile_url:            `https://trueadvisor.com/advisor/${a.individual_pk}/`,
  };
}

const dataset  = await Dataset.open();
const seen     = new Set();
let   total    = 0;
let   done     = 0;
let   capped   = 0;
const extraTiles = [];
const start    = Date.now();

async function processOne(tile) {
  const advisors = await fetchTile(tile);
  const batch    = [];

  for (const a of advisors) {
    if (!seen.has(a.individual_pk)) {
      seen.add(a.individual_pk);
      batch.push(flatten(a));
    }
  }

  if (batch.length) {
    await dataset.pushData(batch);
    total += batch.length;
  }

  if (advisors.length >= API_CAP) {
    capped++;
    // Sub-tile size = 1/5 of parent tile size (max 100 sub-tiles per parent)
    const latSpan  = r6(tile.neLat - tile.swLat);
    const lngSpan  = r6(tile.neLng - tile.swLng);
    const subStep  = r6(Math.max(latSpan / 5, 0.005));
    tiles(tile.swLat, tile.neLat, tile.swLng, tile.neLng, subStep)
      .forEach(t => extraTiles.push(t));
  }

  done++;
  const totalTiles = allTiles.length;
  if (done % 100 === 0) {
    const elapsed = (Date.now()-start)/1000;
    const rate    = done / elapsed;
    const remaining = Math.round((totalTiles - done) / rate);
    log.info(`[${done}/${totalTiles}] ${total.toLocaleString()} advisors | ${rate.toFixed(1)} tiles/s | ~${Math.max(0,remaining)}s left`);
  }

  if (DELAY_MS > 0) await new Promise(r => setTimeout(r, DELAY_MS));
}

async function runPool(tileList) {
  let idx = 0;
  async function worker() {
    while (idx < tileList.length) {
      const tile = tileList[idx++];
      await processOne(tile);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

log.info('=== PASS 1: Main tile grid ===');
await runPool(allTiles);
log.info(`Pass 1 done. ${total.toLocaleString()} advisors. ${capped} capped tiles → ${extraTiles.length.toLocaleString()} sub-tiles queued.`);

if (extraTiles.length > 0) {
  log.info(`=== PASS 2: ${extraTiles.length.toLocaleString()} sub-tiles ===`);
  await runPool(extraTiles);
  log.info(`Pass 2 done. ${total.toLocaleString()} total advisors.`);
}

const elapsed = Math.round((Date.now()-start)/1000);
log.info('='.repeat(50));
log.info(`COMPLETE — ${total.toLocaleString()} unique advisors in ${elapsed}s`);
log.info('Go to Storage → Dataset → Export as CSV to download.');
log.info('='.repeat(50));

await Actor.exit();
