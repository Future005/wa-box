# WA Box media

The animations in the main README, made with [HyperFrames](https://github.com/heygen-com/hyperframes):
each one is an HTML page animated with GSAP and rendered to video.

| File | What it is | Output | Used in README |
|---|---|---|---|
| `index.html` | Hero (15.8 s, 1920×1080): busy at 9 AM with reminders piling up → schedule once, repeats weekly → goes out on time like a person → end card | `docs/media/hero.gif`, `hero.mp4` | Top |
| `loops/per-group.html` | One message, each group gets its own name and day | `per-group.gif` | Features → Writing |
| `loops/date-check.html` | The date check catching "today" on the wrong day | `date-check.gif` | Features → Writing |
| `loops/repeat.html` | A list's usual time, then repeat every Sat & Sun | `repeat.gif` | Features → Scheduling |
| `loops/never-twice.html` | A lost reply: checks the chat instead of resending | `never-twice.gif` | Features → Sending safely |
| `loops/alerts.html` | Morning check-in, done note, and a warning in the team channel | `alerts.gif` | Features → Knowing what happened |
| `loops/api.html` | A Google Sheet row becomes a scheduled message | `api.gif` | Features → API |
| `loops/install.html` | `sh scripts/setup.sh` in a terminal | `install.gif` | Get started |

Loops are 1200×640 and 6–7.5 s.

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
npx hyperframes@0.8.212 render -c loops/api.html -q delivery -o out/api.mp4

# MP4 -> GIF for the README (hero at 1200 px / 20 fps, loops at 900 px / 15 fps)
ffmpeg -i out/hero.mp4 -vf "fps=20,scale=1200:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle" -loop 0 ../docs/media/hero.gif
ffmpeg -i out/api.mp4  -vf "fps=15,scale=900:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle" -loop 0 ../docs/media/api.gif
```

Rules from HyperFrames: one paused GSAP timeline registered on `window.__timelines`, every timed element has
`data-start` and `data-duration`, and nothing random or time-based, so every render is identical.

## Social preview

`social.html` is the 1280×640 card GitHub shows when the repo link is shared (LinkedIn, Slack, X). Output: `docs/media/social-preview.png`. Upload it in the repo's **Settings → General → Social preview**.
