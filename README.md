# Dancy Fingers — website

The landing page for the Android app: the game itself, playable in the
browser with eight of the forty songs, plus how-it-plays and music sections,
an about section, the privacy policy Google Play requires, and a download
call to action.

Plain static files, no build step.

```
index.html     landing page: hero with the live game, how it plays, music, about, CTA
privacy.html   privacy policy (link this URL in Play Console and AdMob)
privacy/       index.html redirects /privacy/ to /privacy.html (noindex, not in the sitemap)
404.html       not-found page (root-absolute links: GitHub Pages serves it at any path)
style.css      one stylesheet for every page
game.js        the game, a port of the Godot scenes to canvas
audio.js       Web Audio layer: songs, previews, menu loop, sound effects
tracks/        eight songs (.ogg + .m4a) with their charts and a manifest
music/         the menu loop (.ogg + .m4a)
sfx/           the sound effects, small WAVs
favicon.svg    the app icon
og.png         1200x630 share card (Open Graph / Twitter)
icon.png       512x512 app icon (structured data), copied from the game repo
shots/         the Play screenshots as WebP (structured data and image sitemap)
app-ads.txt    AdMob authorised-seller line; must be served at the domain root
test/soak.js   headless soak test of game.js (see below)
CNAME, robots.txt, sitemap.xml, .nojekyll   GitHub Pages and crawler files
```

## Run locally

```sh
python3 -m http.server 8000
# then open http://localhost:8000/
```

The page must be served over HTTP(S), not opened as a file: the game
fetches its charts and audio. It is served from the root of
`dancy-fingers.com` (see Deploy), so `app-ads.txt` resolves at
`https://dancy-fingers.com/app-ads.txt`; AdMob only checks the root.

## The browser game

`game.js` is a port of the Godot scenes: the same neon backdrop, arrow rain,
main menu with the top-score panel, song list with difficulty picker and
previews, gameplay (timing windows, scoring, health, holds, pause, note
speed, audio offset), results, high scores and settings. It draws vectors on
a 360x640 canvas, one third of the app's 1080x1920 layout, so the page can
scale it to any size. Ads and the in-app composer do not exist on the web:
a survival fail goes straight to the results (no "watch an ad to continue"),
and there is no Generate Song button. Settings and personal bests live in
`localStorage`, keyed exactly like the app's save file
(`track_id|difficulty|mode`).

Input goes through `game.pointerDown/Up/Move(id, x, y)` in canvas units and
`game.key(code, pressed)`; `DancyFingers.mount()` wires those to the DOM.
The game never touches audio: `audio.js` implements a small adapter (load,
play, pause, position, preview, menu loop, sfx) that `create()` receives,
and the HTML toggles under the frame call `game.setAudio()`; the game emits
`settings` whenever a switch changes so the toggles stay in step.

Keep `game.js` in step with `scripts/gameplay.gd`, `highway.gd` and
`judge.gd` when gameplay changes. The numbers on `index.html` (timing
windows, grade thresholds, health) describe the same constants in words.

## Songs on the site

`tracks/` holds the first track of each of the eight styles from
`../dancy-fingers/assets/tracks/` (the game repo), copied as-is (OGG Vorbis) plus an AAC encode for Safari,
which cannot decode Vorbis:

```sh
cd ../dancy-fingers
for id in 01_pixel_odyssey 02_glass_odyssey 03_ultra_skyline 04_turbo_engine \
          05_hyper_skyline 06_radiant_bloom 07_violet_echo 08_velvet_horizon; do
  cp assets/tracks/$id.ogg assets/tracks/$id.json ../dancy-fingers-landing-page/tracks/
  ffmpeg -y -i assets/tracks/$id.ogg -c:a aac -b:a 128k -movflags +faststart ../dancy-fingers-landing-page/tracks/$id.m4a
done
```

`tracks/manifest.json` is the app manifest trimmed to those eight; the track
list in `index.html` describes the same songs. Redo both after regenerating
the album.

## SEO

Every indexable page (`index.html`, `privacy.html`) has a title that says
what it is, a description, a canonical URL, and Open Graph and Twitter card
tags. The home page also has JSON-LD (`WebSite`, `Organization` and a
`VideoGame` + `MobileApplication` for the app); no ratings until there are
real ones. `sitemap.xml` lists both pages, with the share image, screenshots
and icon as image entries on the home page; bump a page's `lastmod` when you
change it. `privacy/` and `404.html` are `noindex` and stay out of it.

`og.png` is the share card: the web game's main menu in a phone frame next
to the tagline; no script in either repo makes it. It must stay a 1200x630
PNG. If it needs redoing and there is nothing better, crop the Play feature
graphic:

```sh
magick ../dancy-fingers/store/general/feature_graphic.png \
  -resize 1200x630^ -gravity center -extent 1200x630 -strip og.png
```

`icon.png` and `shots/` come from the game repo's `store/`; redo them after
regenerating the store images:

```sh
cp ../dancy-fingers/store/general/icon_512.png icon.png
for f in ../dancy-fingers/store/screenshots/?_*.png; do
  n=$(basename "$f" .png); n=${n#?_}
  magick "$f" -strip -quality 85 "shots/${n//_/-}.webp"
done
```

## Soak test

```sh
node test/soak.js          # every chart; or: easy | normal | hard
```

Runs the real game on a stub canvas with a silent audio adapter and steps it
deterministically: walks the settings, high-score and song-list screens
through their real buttons, then for every chart plays a perfect run (must
score 1,000,000 with an SSS full combo and every hold kept), pauses, resumes
and restarts along the way, and a silent run (must fail in survival mode,
and end with a D and zero points with survival off). It also checks the
judge tables and that bests persist across a reload. Exits non-zero on any
failure.

## Deploy

GitHub Pages, no build step: what is in `main` is what is served.

1. Push to a public repository `eiilo-games/dancy-fingers-landing-page`.
2. Settings > Pages > Build and deployment: Source "Deploy from a branch",
   branch `main`, folder `/ (root)`.
3. Custom domain: `dancy-fingers.com` (already in `CNAME`). Once the DNS below
   resolves and the certificate is issued, tick **Enforce HTTPS**.
4. Verify the domain for the organisation, so no other GitHub account can
   claim it: org Settings > Pages > Verified domains > Add a domain, then
   add the `_github-pages-challenge-eiilo-games` TXT record it shows at
   OVH and click Verify.

DNS at OVH (Web Cloud > Domain names > `dancy-fingers.com` > DNS zone):

| Host  | Type  | Target                   |
|-------|-------|--------------------------|
| (apex)| A     | `185.199.108.153`        |
| (apex)| A     | `185.199.109.153`        |
| (apex)| A     | `185.199.110.153`        |
| (apex)| A     | `185.199.111.153`        |
| (apex)| AAAA  | `2606:50c0:8000::153`    |
| (apex)| AAAA  | `2606:50c0:8001::153`    |
| (apex)| AAAA  | `2606:50c0:8002::153`    |
| (apex)| AAAA  | `2606:50c0:8003::153`    |
| `www` | CNAME | `eiilo-games.github.io.` |

Delete OVH's default apex A record (`213.186.33.5`) and any default `www`
record (A, AAAA or CNAME) first; leftovers break the certificate. GitHub
redirects `www.dancy-fingers.com` to the apex.

After it is live:

- In Play Console set the developer website to `https://dancy-fingers.com` (AdMob
  only checks `https://dancy-fingers.com/app-ads.txt`, at the root) and the privacy
  policy to `https://dancy-fingers.com/privacy.html`; use the same URL in AdMob and keep the Data
  safety form in line with the policy.
- The Google Play buttons point at
  `https://play.google.com/store/apps/details?id=com.eiilo.games.dancyfingers`, which 404s until
  the app is published.

## Audio

Browsers block audio until a user gesture, so the first click on the frame
both focuses the game and unlocks sound; the menu loop starts then. Song
clocks come from the AudioContext, latency-corrected, the same way the app
reads its playback position. Music and sound effects default on; both
switches persist in `localStorage` with the other settings.
