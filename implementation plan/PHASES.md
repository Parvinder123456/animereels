# AnimeReels — Video Summary & Translation Build Plan

This document defines the phases for adding two new features to the existing
manga/manhwa pipeline:

1. **Video Summary** — upload a full anime episode, output a narrated recap reel.
2. **YouTube Hindi → English** — paste a YouTube link, output the relevant
   segment with English narration and subtitles.

The plan is structured so each phase has a **clear exit criterion** and the
later phases can slip without blocking the earlier ones shipping.

---

## Pre-flight (do before Phase 0)

These are blockers — every phase below assumes they're done.

| Item | Why it matters | Owner |
|---|---|---|
| DeepSeek API key in `.env` as `DEEPSEEK_API_KEY` | All text generation will route through DeepSeek V4 | user |
| Confirm Gemini API key still works (`GEMINI_API_KEY`) | Multimodal step (Feature 1 video analysis) stays on Gemini Flash for now | user |
| Decide max source video duration per project (suggest: 30 min) | Caps cost, storage, and Gemini upload size | user |
| Decide storage retention for raw uploads (suggest: delete after `final.mp4` is built) | Anime episodes are 200 MB – 1.5 GB each | user |
| Confirm yt-dlp is acceptable for YouTube downloading + add to `nixpacks.toml` | Required for Feature 2 ingestion | dev |
| Verify `ffmpeg-static` build supports H.264 + scene detection on Windows + Linux | Needed for clip extraction & scene detect | dev |

---

## Phase 0 — LLM routing: add DeepSeek as a text backend

**Goal:** every text-only LLM call in the project can be switched to DeepSeek
V4 from settings, with zero behavior change at the caller sites.

The repo already has `utils/textClient.js` and `utils/visionClient.js` that
route between Ollama / Groq / Gemini based on `settings.json`. We add a
fourth option: `deepseek`.

### Changes

| File | Change |
|---|---|
| `server/utils/textClient.js` | Add `deepseekText()` branch and route when `textBackend === 'deepseek'` |
| `server/utils/appSettings.js` | Add `deepseekTextModel` default (`deepseek-v4-flash`), `deepseekBaseUrl` default (`https://api.deepseek.com`) |
| `data/settings.json` | Document the new keys (no value change unless user opts in) |
| `client/src/components/Settings.jsx` (or equivalent) | Add `DeepSeek` to text backend dropdown |
| `.env.example` | Add `DEEPSEEK_API_KEY=` placeholder |

### Exit criterion

- Toggle text backend to `deepseek` in settings → existing `analyze` and
  `script` flows still produce valid output on a known project.
- A minimal smoke-test script (`scripts/test-deepseek.js`) calls
  `textQuery('say hi')` and prints the response.

### What this unblocks

- The narrator-script step in **both** new features uses DeepSeek immediately
  (no parallel client to maintain).
- Translation in Phase 3 reuses the same `textQuery()` entry point.
- Vision/multimodal stays on Gemini until DeepSeek ships hosted vision.

---

### Status — Phase 0 shipped

| Change | Location |
|---|---|
| DeepSeek branch in router | `server/utils/textClient.js` (`deepseekText()`) |
| Defaults: `deepseekTextModel`, `deepseekBaseUrl` | `server/utils/appSettings.js` |
| Settings API exposes DeepSeek + accepts `textBackend: 'deepseek'` | `server/routes/settings.js` |
| UI dropdown shows DeepSeek option (text only) | `client/src/components/Layout.jsx` |
| Smoke-test script | `scripts/test-deepseek.js` |

**Routing surface:** when `textBackend === 'deepseek'`, every call to
`textQuery()` from the existing pipeline goes to DeepSeek. Today that is
exactly **one caller**: `services/geminiScriptWriter.js` (which is misnamed —
it's the LLM-agnostic script writer that already routes via `textClient`).
All future text-only flows (translation, segment finder, narrator scripts
for the new features) reuse the same entry point and inherit DeepSeek for free.

**To turn it on:**
1. `cd animereels && npm install`
2. Add `DEEPSEEK_API_KEY=sk-...` to a `.env` file at the repo root
3. `node scripts/test-deepseek.js` — should print `pong` and token usage
4. In the running app, click the AI badge → Text AI → DeepSeek Cloud

---

## Phase 1 — Video Summary MVP (cheap path)

**Goal:** end-to-end ugly version. Upload a 24-min episode → get a 5-min
narrated reel out the other side. Use frame-grid sampling (cheap) over
Gemini Files API (premium) to keep the first integration simple.

### New project type

`config.projectType = 'video_summary'` alongside existing `'manga'` /
`'webtoon'`. All routing decisions key off this.

### Pipeline

```
upload .mp4
  → videoIngestion.js   (probe + normalize to 1080p mp4 if needed)
  → sceneDetector.js    (ffmpeg scene cuts → list of [start, end] windows)
  → frameSampler.js     (1 frame per scene + 1 fallback frame every 2s)
  → videoAnalyzer.js    (Gemini Flash on frame batches → importance scores)
  → momentSelector.js   (top-N windows fitting target duration)
  → geminiScriptWriter  (now via DeepSeek) → narrator script bridging beats
  → existing TTS + Whisper word-timestamps
  → clipExtractor.js    (ffmpeg -ss / -to per chosen window)
  → videoRenderer.js    (NEW branch: concat video clips instead of zoompan)
  → audioMixer.js       (duck source audio under narrator)
  → subtitleGenerator.js (existing)
  → final.mp4
```

### Files

| File | Action |
|---|---|
| `server/services/videoIngestion.js` | NEW |
| `server/services/sceneDetector.js` | NEW |
| `server/services/frameSampler.js` | NEW |
| `server/services/videoAnalyzer.js` | NEW |
| `server/services/momentSelector.js` | NEW |
| `server/services/clipExtractor.js` | NEW |
| `server/services/videoRenderer.js` | MODIFY — add `renderFromClips()` branch |
| `server/routes/upload.js` | MODIFY — accept `.mp4`/`.mkv` for `video_summary` projects |
| `server/routes/projects.js` | MODIFY — `projectType` in default config + PATCH handler |
| `server/jobs/processor.js` | MODIFY — branch on `projectType` to run the new pipeline |
| `prompts/video-scene-analysis.v1.md` | NEW — frame batch scoring prompt |
| `prompts/anime-recap.v1.md` | NEW — narrator-script prompt for video summaries |
| `client/src/pages/ProjectWizard.jsx` | MODIFY — project type selector, video upload widget |

### Exit criterion

- A 5-minute test clip (`naruto_sample.mp4`) is uploaded via the UI.
- Pipeline completes end-to-end, producing a `final.mp4` of the requested duration.
- The narration audibly references on-screen events (not generic filler).
- Original audio is ducked, narrator is intelligible, subtitles are aligned.

### What we explicitly skip in MVP

- Per-beat clip vs screenshot decisions (everything is a clip; polish in Phase 2).
- Gemini Files API native-video understanding (frame-grid only; polish in Phase 2).
- Cost estimator UI.
- Original-audio ducking under narrator (Phase 1 MVP drops the source audio entirely).
- Frontend wizard for `video_summary` projects — kicks via `curl` for now.

### Status — Phase 1 shipped (server-side pipeline)

| Component | File |
|---|---|
| Probe + cap source duration | `server/services/videoIngestion.js` |
| Scene cuts via ffmpeg `select=gt(scene,T)` | `server/services/sceneDetector.js` |
| Mid-scene keyframe extraction | `server/services/frameSampler.js` |
| Per-scene importance scoring (Gemini Flash via existing `visionClient`) | `server/services/videoAnalyzer.js` |
| Top-N moment picker with story-arc coverage | `server/services/momentSelector.js` |
| Pre-built clip extractor (currently unused — renderer re-cuts to narration; kept for Phase 2 ducked-audio path) | `server/services/clipExtractor.js` |
| Narrator script via `textQuery` (DeepSeek when toggled) | `server/services/videoSummaryScriptWriter.js` |
| Concat + narrate + sub burner | `server/services/videoSummaryRenderer.js` |
| Upload + orchestration endpoint | `server/routes/videoSummary.js` |
| Render-route branch on `projectType` | `server/routes/render.js` |

**End-to-end flow (curl-driven for MVP):**

```bash
# 1. Create project
curl -X POST http://localhost:3001/api/projects \
  -H 'Content-Type: application/json' \
  -d '{"name":"My Anime Recap"}'
# → returns { id: "proj_xxxx" }

# 2. Set duration + project type, upload source video
curl -X PATCH http://localhost:3001/api/projects/proj_xxxx/config \
  -H 'Content-Type: application/json' \
  -d '{"projectType":"video_summary","duration":300,"detail":"medium"}'

curl -X POST http://localhost:3001/api/projects/proj_xxxx/video-source \
  -F "video=@./episode.mp4"

# 3. Run analyze → script (uses Gemini for vision, DeepSeek for text if toggled)
curl -X POST http://localhost:3001/api/projects/proj_xxxx/video-summary/run \
  -H 'Content-Type: application/json' \
  -d '{"duration":300}'

# 4. Generate narration (existing endpoint)
curl -X POST http://localhost:3001/api/projects/proj_xxxx/voice/generate \
  -H 'Content-Type: application/json' \
  -d '{"voiceId":"en-US-GuyNeural","engine":"edge"}'

# 5. Render (existing endpoint, branches on projectType)
curl -X POST http://localhost:3001/api/projects/proj_xxxx/render

# 6. Download
curl -O http://localhost:3001/api/projects/proj_xxxx/download
```

**Watch progress:** SSE at `GET /api/events/<projectId>` — the same channel manga uses.

### Open issues to fix in Phase 2

1. `clipExtractor.js` is dead code — wire it in once the ducked-audio path is built, or remove it.
2. The `panels` state field is repurposed for "scene analysis" progress. Consider renaming for clarity, or keep for backwards compat.
3. The narrator's pacing assumption (≈ 2.5 words / sec) is an estimate — measure on real episodes and tune in `videoSummaryScriptWriter.js`.

---

## Phase 2 — Video Summary quality polish

**Goal:** make the output good enough to share publicly.

| Improvement | What changes |
|---|---|
| Native video understanding | Switch `videoAnalyzer` to Gemini Files API for clips that are <2 GB and <30 min. Fall back to frame-grid otherwise. |
| Clip vs screenshot per beat | `momentSelector` tags each beat as `clip` or `still`. `videoRenderer` honors the tag — stills get the existing zoompan, clips get raw cut. |
| Audio ducking | `audioMixer` drops source to ~15% under narrator with sidechain compression. Clip-only "money shot" beats keep full original audio. |
| Cost estimator | Before kicking off, show user `~$X estimate` based on duration + chosen detail level. |
| Scene-aware clip boundaries | Snap clip cuts to scene boundaries from `sceneDetector` so we never cut mid-shot. |

### Exit criterion

- Side-by-side: Phase 1 output vs Phase 2 output on the same source. Phase 2
  is clearly more watchable.
- Cost estimate shown pre-render is within 25 % of actual API spend.

---

## Phase 3 — YouTube Hindi → English  (SHIPPED)

**Goal:** paste a Hindi YouTube link + optional topic, get an English-narrated
clip of the relevant segment with subs.

### Pipeline

```
URL + optional topic
  → youtubeDownloader.js  (yt-dlp wrapper → mp4 + audio.wav)
  → whisperTimestamps     (existing, language='hi')
  → translationService.js (DeepSeek translates Hindi transcript → English)
  → segmentFinder.js      (DeepSeek picks window matching topic, or densest segment)
  → clipExtractor.js      (reused from Phase 1)
  → existing TTS (English voice)
  → videoRenderer.js      (reuse Phase 1 clip-render branch)
  → audioMixer            (duck Hindi original under English narrator)
  → subtitleGenerator     (English subs from translated text)
  → final.mp4
```

### Files

| File | Action |
|---|---|
| `server/services/youtubeDownloader.js` | NEW |
| `server/services/translationService.js` | NEW (just wraps `textQuery`) |
| `server/services/segmentFinder.js` | NEW |
| `server/routes/translate.js` | NEW endpoint: `POST /api/translate` |
| `prompts/hi-en-translate.v1.md` | NEW |
| `prompts/segment-finder.v1.md` | NEW |
| `nixpacks.toml` | MODIFY — install `yt-dlp` |
| `client/src/pages/TranslatePage.jsx` | NEW — URL + topic input + progress view |

### Exit criterion

- Paste a known Hindi YouTube interview URL + topic "education".
- Output is a 1-3 min clip with English narrator over the matching segment,
  English subs aligned, original Hindi audio ducked but audible.

### Status — Phase 3 shipped

| Component | File |
|---|---|
| YouTube fetch via yt-dlp | `server/services/youtubeDownloader.js` |
| OpenAI Whisper API transcription with word timestamps | `server/services/whisperTranscribe.js` |
| Topic-window picker via DeepSeek | `server/services/segmentFinder.js` |
| Hindi → English translator → script.json | `server/services/translationService.js` |
| Single-clip renderer (cuts window, time-fits narration with atempo, ducks Hindi audio) | `server/services/translatedRenderer.js` |
| Orchestration endpoint `POST /api/translate` | `server/routes/translate.js` |
| Render-route branch on `projectType === 'translate'` | `server/routes/render.js` |
| `nixpacks.toml` installs yt-dlp | `nixpacks.toml` |

### Client UI — what shipped

| Component | File |
|---|---|
| Dashboard modal: 3 project types (manga / video_summary / translate), conditional fields | `client/src/pages/Dashboard.jsx` |
| Video Summary page (upload → run → voice → render → download) | `client/src/pages/VideoSummaryPage.jsx` |
| Translate page (live progress → voice → render → download) | `client/src/pages/TranslatePage.jsx` |
| Routes `/projects/:id/video` and `/projects/:id/translate` | `client/src/App.jsx` |

### End-to-end usage (UI)

1. Click **+ New Project**.
2. Pick a project type:
   - **Manga / Manhwa** — name only → existing wizard.
   - **Video Summary** — name + duration → upload .mp4 → Run analysis → Generate voice → Render.
   - **YouTube Hindi → English** — URL + optional topic → auto-runs download/transcribe/translate → Generate voice → Render.
3. Watch live progress via SSE bar at the top.
4. Click **Download** when render completes.

### Required keys / binaries

| Need | When |
|---|---|
| `DEEPSEEK_API_KEY` (or `GEMINI_API_KEY`) in `.env` | All text generation |
| `GEMINI_API_KEY` | Multimodal scene scoring (Feature 1) |
| `OPENAI_API_KEY` | Whisper API transcription (Feature 2) |
| `ELEVENLABS_API_KEY` | Optional, only for ElevenLabs voice |
| `yt-dlp` on PATH | YouTube download (Feature 2) — `winget install yt-dlp` on Windows |

---

## Phase 4 — Hardening & polish

**Goal:** turn the prototype into something safely runnable for users beyond
yourself.

| Item | Notes |
|---|---|
| Storage cleanup job | Delete `data/projects/<id>/source.*` after `final.mp4` exists for >1 hour |
| Job queue concurrency limit | Cap to N concurrent video jobs (CPU/GPU-bound) |
| Per-project cost tracking | Log every LLM call with `{provider, model, tokens, $}` to `data/projects/<id>/costs.jsonl` |
| Failure recovery | If a job dies mid-pipeline, the resume button picks up at the last completed step |
| Quota / rate-limit handling | Backoff + clear error UI when DeepSeek/Gemini return 429 |
| Tests | Smoke tests per service (no full E2E test — too slow); fixture videos in `test/fixtures/` |

### Exit criterion

- A second person can run the project on their machine following only the
  README, without you intervening.

---

## Open questions to revisit at each phase boundary

1. **Multimodal on DeepSeek** — once they ship hosted vision/video, swap
   `geminiClient` calls for `deepseekClient` calls in `videoAnalyzer`.
2. **Local Whisper vs OpenAI Whisper API** — current code uses local Whisper.
   For Hindi we may want `large-v3`; cost/quality decision at Phase 3 start.
3. **TTS for Hindi→English translations** — does the user want one specific
   English voice (ElevenLabs), or fallback to Edge TTS for cost? Same pattern
   as existing voice selector.
4. **Clip vs full-episode upload** — for very long anime (full season), do we
   accept multi-file uploads and stitch summaries, or cap at one episode per project?
