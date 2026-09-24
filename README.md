# shahidali-indexnow

Pings [IndexNow](https://www.indexnow.org/) with new or changed URLs from the
live sitemaps of https://www.shahidali.co and https://aniimoindex.com. gta6record.com and manhwaindex.com ping from their own deploy workflows. Runs every 3 hours on GitHub Actions.

Only URLs that are new, or whose `lastmod` changed, are sent. State lives in
the Actions cache. Run it by hand from the Actions tab (workflow_dispatch) or
locally with `node indexnow.mjs --dry-run`.
