# shahidali-indexnow

Pings [IndexNow](https://www.indexnow.org/) with new or changed URLs from the
live sitemaps of shahidali.co, aniimoindex.com, gta6record.com and manhwaindex.com.

Only URLs that are new, or whose `lastmod` changed, are sent. State lives in
the Actions cache. Run it by hand from the Actions tab (workflow_dispatch) or
locally with `node indexnow.mjs --dry-run`.

gta6record and manhwaindex also ping from their own deploys. Here their first
run only records state (`SEED_IF_EMPTY=1`). Every run sends at most 10,000 URLs
per site (`MAX_PER_RUN`); the rest wait for the next run.
