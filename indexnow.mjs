// After a successful production deploy, tell IndexNow (Bing, Yandex, and the
// AI crawlers that read the same feed, such as ChatGPT search) which pages are
// new or changed. Google ignores IndexNow and uses the sitemap instead.
//
// This runs against the LIVE site, not a local build: Vercel's GitHub
// integration does the actual build and deploy, so this workflow only fires
// afterwards (see .github/workflows/indexnow.yml) and reads whatever the
// sitemap says is live right now.
//
// Ownership is proven by a key file served from the site root
// (public/<key>.txt). Before sending anything, the script checks that file is
// actually live: pinging IndexNow while the key file has not deployed yet
// would get every submission rejected and teaches nothing.
//
// Only URLs never announced before, or whose <lastmod> changed since the last
// announced run, are sent. The url -> lastmod map of everything already
// announced is kept in a state file (see STATE_PATH) that rides in the GitHub
// Actions cache, not in git.
//
// Run with: node scripts/indexnow.mjs [--dry-run] [--state <path>]
//   --dry-run  parse the live sitemap and print what would be sent, but do
//              not check the key file, POST anything, or write the state file.
//   --state    path to the state file. Defaults to STATE_PATH env var, then
//              .indexnow-state.json in the repo root.
//
// Never fails the deploy: network and HTTP errors are logged and the script
// exits 0.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export const HOST = 'www.shahidali.co';
export const KEY = '0a3ddd2b4a1ecb87f609774f653347c7';
export const KEY_LOCATION = `https://${HOST}/${KEY}.txt`;
export const SITEMAP_INDEX = `https://${HOST}/sitemap-index.xml`;
export const ENDPOINT = 'https://api.indexnow.org/indexnow';

/** IndexNow's own cap per request. */
export const BATCH_SIZE = 10000;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const stateFlagIndex = args.indexOf('--state');
const statePath =
  stateFlagIndex !== -1 && args[stateFlagIndex + 1]
    ? path.resolve(args[stateFlagIndex + 1])
    : process.env.STATE_PATH
      ? path.resolve(process.env.STATE_PATH)
      : path.join(ROOT, '.indexnow-state.json');

/** Pull every <loc> out of an XML document. Good enough for sitemap XML. */
function locsOf(xml) {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
}

/** Pull the sibling <lastmod> for each <url> block, keyed by its <loc>. */
function urlEntriesOf(xml) {
  const entries = [];
  for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const block = m[1];
    const loc = block.match(/<loc>([^<]+)<\/loc>/)?.[1]?.trim();
    if (!loc) continue;
    const lastmod = block.match(/<lastmod>([^<]+)<\/lastmod>/)?.[1]?.trim() ?? null;
    entries.push({ url: loc, lastmod });
  }
  return entries;
}

/** Fetch the sitemap index, then every child sitemap it lists, live. */
async function fetchSitemapEntries() {
  const indexRes = await fetch(SITEMAP_INDEX);
  if (!indexRes.ok) {
    throw new Error(`sitemap index ${SITEMAP_INDEX} returned HTTP ${indexRes.status}`);
  }
  const indexXml = await indexRes.text();
  const childSitemaps = locsOf(indexXml);
  if (childSitemaps.length === 0) {
    throw new Error(`sitemap index ${SITEMAP_INDEX} listed no child sitemaps`);
  }

  const entries = [];
  for (const sitemapUrl of childSitemaps) {
    const res = await fetch(sitemapUrl);
    if (!res.ok) {
      console.warn(`[indexnow] could not fetch ${sitemapUrl}, skipping it: HTTP ${res.status}`);
      continue;
    }
    entries.push(...urlEntriesOf(await res.text()));
  }
  return entries;
}

/** True only when the key file is live and serves exactly the key. */
async function keyFileIsLive() {
  let res;
  try {
    res = await fetch(KEY_LOCATION);
  } catch (err) {
    console.warn(`[indexnow] could not reach ${KEY_LOCATION}: ${err.message}`);
    return false;
  }
  if (!res.ok) {
    console.warn(`[indexnow] key file not live yet: ${KEY_LOCATION} returned HTTP ${res.status}`);
    return false;
  }
  const body = (await res.text()).trim();
  if (body !== KEY) {
    console.warn(`[indexnow] key file at ${KEY_LOCATION} does not match the expected key, refusing to submit`);
    return false;
  }
  return true;
}

/**
 * Pure diff: given what was already announced (url -> lastmod, or null) and
 * the sitemap's current entries, decide which URLs are new or changed.
 * A URL is sent when it was never announced before, or its lastmod differs
 * from what was last announced. A URL with no lastmod at all is treated as
 * changed only the first time it is seen, since there is no signal to compare
 * against on later runs.
 */
export function diffUrls(previousState, currentEntries) {
  const toSend = [];
  const nextState = {};
  for (const { url, lastmod } of currentEntries) {
    nextState[url] = lastmod;
    const previousLastmod = previousState ? previousState[url] : undefined;
    const isNew = previousLastmod === undefined;
    const changed = !isNew && lastmod !== null && lastmod !== previousLastmod;
    if (isNew || changed) toSend.push(url);
  }
  return { toSend, nextState };
}

function loadState() {
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch (err) {
    console.warn(`[indexnow] could not parse existing state, treating as first run: ${err.message}`);
    return null;
  }
}

async function submit(urlList) {
  const failed = [];
  for (let i = 0; i < urlList.length; i += BATCH_SIZE) {
    const chunk = urlList.slice(i, i + BATCH_SIZE);
    const body = JSON.stringify({ host: HOST, key: KEY, keyLocation: KEY_LOCATION, urlList: chunk });
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body,
      });
      if (res.status === 200 || res.status === 202) {
        console.log(`[indexnow] submitted ${chunk.length} url(s), HTTP ${res.status}`);
      } else if (res.status === 422) {
        console.warn(`[indexnow] HTTP 422: URLs do not belong to the host or key, chunk dropped without retry`);
      } else if (res.status === 403) {
        console.warn(`[indexnow] HTTP 403: key not valid (e.g. key file 404 or mismatched), will retry next run`);
        failed.push(...chunk);
      } else if (res.status === 429) {
        console.warn(`[indexnow] HTTP 429: rate limited, will retry next run`);
        failed.push(...chunk);
      } else {
        console.warn(`[indexnow] unexpected HTTP ${res.status}, will retry next run`);
        failed.push(...chunk);
      }
    } catch (err) {
      console.warn(`[indexnow] network error, will retry next run: ${err.message}`);
      failed.push(...chunk);
    }
  }
  return failed;
}

async function main() {
  const entries = await fetchSitemapEntries();
  console.log(`[indexnow] ${entries.length} url(s) in the live sitemap`);

  const previousState = loadState();
  const { toSend, nextState } = diffUrls(previousState, entries);
  console.log(
    previousState === null
      ? `[indexnow] no previous state found, ${toSend.length} url(s) would be sent`
      : `[indexnow] ${toSend.length} url(s) new or changed since the last announced run`,
  );

  if (dryRun) {
    console.log(`[indexnow] dry-run: would submit ${toSend.length} url(s), nothing sent, state not written`);
    return;
  }

  if (toSend.length === 0) {
    console.log('[indexnow] nothing new to announce');
    writeFileSync(statePath, JSON.stringify(nextState, null, 0), 'utf8');
    return;
  }

  if (!(await keyFileIsLive())) {
    console.log('[indexnow] key file is not live, exiting without submitting or updating state');
    return;
  }

  const failed = await submit(toSend);
  const failedUrls = new Set(failed);
  for (const url of failedUrls) {
    // Do not record a failed URL as announced: drop it back to whatever the
    // previous state had (or leave it out entirely), so the next run treats
    // it as still-pending and retries.
    if (previousState && previousState[url] !== undefined) nextState[url] = previousState[url];
    else delete nextState[url];
  }
  if (failed.length > 0) console.warn(`[indexnow] ${failed.length} url(s) not accepted, kept for the next run`);

  writeFileSync(statePath, JSON.stringify(nextState, null, 0), 'utf8');
  console.log(`[indexnow] wrote state (${Object.keys(nextState).length} url(s)) to ${statePath}`);
}

// Only run when executed directly (`node scripts/indexnow.mjs`), never when
// imported, e.g. by indexnow.test.mjs pulling in diffUrls.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.warn(`[indexnow] unexpected error, not failing the deploy: ${err.message}`);
    process.exit(0);
  });
}
