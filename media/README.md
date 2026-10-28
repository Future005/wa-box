# WA Box media

The animations in the main README, made with [HyperFrames](https://github.com/heygen-com/hyperframes):
each one is an HTML page animated with GSAP and rendered to video.

| File | What it is | Output |
|---|---|---|
| `index.html` | README hero: copy-paste chaos → write once → sends like a person → end card (14 s, 1920×1080) | `docs/media/hero.gif`, `hero.mp4` |
| `compositions/date-check.html` | The date check catching "today" on the wrong day (6 s, 1200×640) | `docs/media/date-check.gif` |
| `compositions/never-twice.html` | A lost reply: WA Box checks the chat instead of resending (7 s) | `docs/media/never-twice.gif` |
| `compositions/api.html` | A Google Sheet row becomes a scheduled message (7 s) | `docs/media/api.gif` |

Sample names only ("Weekend Cohort 1"); no real groups or numbers.

## Re-render

Needs Node 22, FFmpeg and Chrome.

```bash
cd media
npm ci
export HYPERFRAMES_BROWSER_PATH="/path/to/chrome"     # if HyperFrames can't download its own

npx hyperframes@0.8.212 preview                        # live preview in the browser
npx hyperframes@0.8.212 check                          # layout, contrast and timing checks
npx hyperframes@0.8.212 render -q delivery -o out/hero.mp4
npx hyperframes@0.8.212 render -c compositions/api.html -q delivery -o out/api.mp4

# MP4 -> GIF for the README (hero at 1200 px / 20 fps, loops at 900 px / 15 fps)
ffmpeg -i out/hero.mp4 -vf "fps=20,scale=1200:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle" -loop 0 ../docs/media/hero.gif
ffmpeg -i out/api.mp4  -vf "fps=15,scale=900:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle" -loop 0 ../docs/media/api.gif
```

Rules from HyperFrames: one paused GSAP timeline registered on `window.__timelines`, every timed element has
`data-start` and `data-duration`, and nothing random or time-based, so every render is identical.
