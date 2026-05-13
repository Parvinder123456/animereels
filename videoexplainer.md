# Video Explainer / Podcast Recap — Status Document

## What This Is

A web app that takes a long-form YouTube video (podcast, interview, lecture) or uploaded video files and produces a condensed, narrated recap video — similar to what channels like "WisdomCast" or "Iman Gadzhi recaps" do for Huberman Lab, Lex Fridman, etc.

**Target niche**: Podcast Key Takeaways / Condensed Recap — highest demand, best RPM on YouTube in 2026.

**Target channels to feed in**: Huberman Lab, Lex Fridman, The Diary of a CEO, Shawn Ryan Show, Modern Wisdom.

**Video types to generate from one source episode**:
- Top 10-15 Key Takeaways (8-12 min)
- Condensed Recap (10-15 min)
- "How to Apply X in Your Life" motivational spin (8-10 min)
- Best Moments highlight reel (5-8 min)
- YouTube Shorts from high-importance segments (30-60s)

---

## What's Built (Done)

### Full Pipeline — End to End Working

#### Step 1: Source Ingest
- [x] YouTube URL download via yt-dlp (max 90 min, mweb fallback for 503)
- [x] File upload: 1-10 video files, stitched into single `source.mp4`
- [x] `episodes.json` written with per-file offsets for timestamp mapping
- [x] SSE real-time progress to frontend

**Files**: `server/routes/videoExplainer.js` (routes), `server/services/youtubeDownloader.js`, `server/services/videoStitcher.js`

#### Step 2: AI Analysis Pipeline
- [x] OP/ED theme detection (Gemini audio fingerprint) — auto-generates skip windows
- [x] Manual skip windows (user types time ranges like `0:00-1:30, 22:00-24:00`)
- [x] Gemini multimodal scene breakdown (video+audio uploaded to Gemini Files API)
  - 960px wide, 4fps, 18-minute chunks
  - Thinking mode enabled (`thinkingBudget: 8192`) for better JSON + timestamps
  - Returns per-scene: `visualDescription`, `dialogueGist`, `dialogueVerbatim`, `mood`, `importance`, `type`, `characters`, `keyTakeaway`, `callbackTo`
  - JSON repair for malformed Gemini output (trailing commas, missing commas, truncation)
- [x] Skip-window filtering applied dynamically (works even on cached scene plans)
- [x] Story summarization: per-episode summaries -> bundle summary (arc, characters, through-lines, ending)
- [x] Scene selection with 3 modes:
  - `continuous` (ratio < 2.5): keep nearly all, drop filler
  - `hybrid` (2.5-3.5): most scenes, drop low-importance
  - `cut` (> 3.5): sparse subset, round-robin from thirds for arc coverage
- [x] Setup-payoff pair preservation: `callbackTo` references resolved, both scenes kept
- [x] Script writer:
  - Mood-adaptive word budgets (action=3.0, calm=2.3, emotional=1.8, breathe=0 words/sec)
  - Cold-open hook from highest-importance scene (tease without spoiling)
  - Previous-batch context: last 3 segments passed to next batch for continuity
  - Breathe segments: script writer can output `text: ""` to let original audio play
  - Batched into groups of 12 scenes per LLM call
  - Gemini thinking mode (`thinkingBudget: 4096`) for better word budget adherence
- [x] Caching: scene-plan, OP/ED cuts, episode summaries, bundle summary all cached by source file identity (size + mtime). Re-runs skip the expensive Gemini breakdown.

**Files**: `server/services/geminiVideoBreakdown.js`, `server/services/opEdDetector.js`, `server/services/sceneSelector.js`, `server/services/storySummarizer.js`, `server/services/explainerScriptWriter.js`

**Prompts**: `prompts/visual-scene-breakdown.v1.md`, `prompts/explainer-narration.v1.md`, `prompts/bundle-summary.v1.md`, `prompts/episode-summary.v1.md`

#### Step 3: Voice Generation (TTS)
- [x] Edge TTS (free, Microsoft Neural voices — 8 voice options)
- [x] ElevenLabs (paid, higher quality)
- [x] Per-segment word-level timestamps (`segmentBoundaries` in `timestamps.json`)
- [x] Mood-based breathing room between segments (action=0.15s, reveal=0.60s, etc.)
- [x] SSML prosody per mood: `<prosody rate="+10%" pitch="+3%">` for energetic, `-8% rate` for dramatic, etc.
- [x] Breathe segment handling: generates silence for the scene's source duration so original audio plays through

**Files**: `server/services/edgeTTS.js`, `server/services/elevenLabsTTS.js`

#### Step 4: Render
- [x] Per-segment TTS sync: each video segment individually speed-matched to its TTS boundary (eliminates drift — was up to 191s, now frame-accurate)
- [x] Three render modes (continuous / cut / stretch) each with per-segment timing
- [x] Ducked source audio: original audio mixed at 18% volume under narration. During breathe segments, source audio is the only thing heard.
- [x] ASS subtitles burned in (word-level timing from TTS)
- [x] Aspect ratio: 16:9, 9:16, 1:1
- [x] GPU acceleration: NVENC if available, else libx264
- [x] Filter graph written to file (handles 80+ segment concat graphs)
- [x] Fallback: if segment/boundary count mismatch, gracefully falls back to proportional timing

**Files**: `server/services/videoExplainerRenderer.js`, `server/services/gpuDetect.js`, `server/services/subtitleGenerator.js`

#### Frontend
- [x] `VideoExplainerPage.jsx` — 4-step wizard UI
  - Step 1: YouTube URL input OR file upload (with "OR" divider)
  - Step 2: Analysis config (target duration, manual skip windows, force re-run)
  - Analysis preview card: per-scene breakdown with visual/dialogue/narration side-by-side, expandable rows, stats, skip windows display, story arc context
  - Step 3: Voice selection (8 Edge voices + ElevenLabs) + engine picker
  - Step 4: Render with aspect ratio picker + download link
- [x] SSE real-time progress bar for each step
- [x] Error display + last error banner
- [x] Re-generate script (keeps cached scene plan, only re-runs selection + script)

**Files**: `client/src/pages/VideoExplainerPage.jsx`

#### Infrastructure
- [x] Background job processor with SSE progress events
- [x] YouTube OAuth uploader (credentials-based, already wired)
- [x] Project system: create/list/config/download

**Files**: `server/jobs/processor.js`, `server/routes/events.js`, `server/services/youtubeUploader.js`, `server/routes/youtube.js`

---

## What's Left (TODO)

### P0 — Must Have for Launch

#### Copyright Hardening Layer
The user's plan explicitly calls for this. None of it is implemented.
- [ ] Horizontal flip (hflip) — mirror the source video so content-ID doesn't match
- [ ] Subtle color shift — slight hue/saturation/brightness adjustment
- [ ] Subtle zoom / crop — 2-5% crop to alter framing
- [ ] +1% pitch shift on source audio — avoid audio fingerprint matching
- [ ] Text overlay watermark — channel name burned into corner
- [ ] Implementation: add these as FFmpeg filters in `videoExplainerRenderer.js` filter graph, controlled by a `copyrightHardening: true/false` flag in project config

#### Multi-Format Output from Single Source
The user wants 2-3 full videos + 5-10 Shorts from one episode.
- [ ] "Output type" selector: Takeaways / Recap / Motivational / Highlight Reel
- [ ] Each type should have a different prompt variant or prompt modifier that adjusts the script writer's style
- [ ] Shorts extraction: take high-importance segments (importance >= 4) and render as 30-60s vertical clips — can reuse the existing Shorts pipeline (`server/services/shortsDetector.js`, `server/services/shortsRenderer.js`) but feed it the already-analyzed scene plan instead of re-analyzing
- [ ] Batch generation: "Generate all formats" button that queues multiple render jobs

#### Title/Description Generator
- [ ] Auto-generate YouTube title using proven formulas:
  - "Top 10 Life-Changing Lessons from [Channel] [Episode Title] (2026)"
  - "Key Takeaways from [Guest] on [Channel]"
  - "[Channel]: The Most Important [Topic] Everyone Missed"
- [ ] Auto-generate YouTube description with timestamps, key points, tags
- [ ] UI: show generated title/description with copy button
- [ ] Implementation: one more LLM call after script generation, using the bundle summary + script segments

### P1 — High Impact, Should Do Soon

#### Dynamic Source Audio Ducking
Current: constant 18% volume bed. Better approach:
- [ ] Use FFmpeg `sidechaincompress` to dynamically duck source audio when narrator speaks
- [ ] When narrator is silent (breathe segments), source audio rises to ~50-60% volume
- [ ] This is the difference between "AI recap" and "actual recap channel"

#### Subtitle Style Update for Podcast Content
Current subtitle style is "manhwa recap" (bold white, karaoke yellow highlight).
- [ ] Update to clean podcast recap style: white text, no karaoke highlight, slightly smaller font
- [ ] Maybe: show speaker name as subtitle prefix during verbatim quotes
- [ ] Configurable subtitle style presets

#### ElevenLabs Voice Cloning / Premium Voices
Edge TTS is decent but flat on emotional beats.
- [ ] Surface ElevenLabs voice library in the UI (not just one voice ID)
- [ ] Allow voice cloning (upload sample → generate with that voice)
- [ ] Per-segment voice switching (narrator voice vs. character voice for quotes)

#### One-Click YouTube Upload
The OAuth uploader service exists but isn't wired into the explainer flow.
- [ ] After render complete, show "Upload to YouTube" button
- [ ] Pre-fill title/description from the auto-generator
- [ ] Set category, tags, thumbnail
- [ ] Schedule upload time

### P2 — Nice to Have

#### Thumbnail Generation
- [ ] Extract the most visually interesting frame from the highest-importance scene
- [ ] Overlay: title text, speaker face crop, channel logo
- [ ] Use Gemini to pick the best frame and suggest text placement
- [ ] Save as `output/thumbnail.jpg`

#### A/B Title Testing
- [ ] Generate 3-5 title variants per video
- [ ] If YouTube API allows, track CTR per title
- [ ] Show analytics dashboard

#### Multi-Language Narration
- [ ] Translate the English script to other languages (Hindi, Spanish, Portuguese)
- [ ] Generate TTS in target language
- [ ] Render with translated subtitles
- [ ] Could reuse existing `translationService.js` + `translatedRenderer.js`

#### Background Music Bed
- [ ] Add royalty-free background music (lo-fi, cinematic, motivational)
- [ ] Auto-duck music when narrator speaks (same sidechaincompress approach)
- [ ] Music mood matched to content mood (calm → lo-fi, action → cinematic)

#### Clip/Shorts Auto-Export
- [ ] After full video render, automatically extract top 5-10 moments as Shorts
- [ ] Each Short gets its own title, description, and thumbnail
- [ ] Batch upload all Shorts to YouTube

#### Analytics Dashboard
- [ ] Track: videos generated, total processing time, Gemini API cost estimate
- [ ] Per-video stats: word count, scene count, render duration, file size
- [ ] YouTube performance tracking (if OAuth connected): views, watch time, CTR

---

## File Map

### Backend (server/)
| File | Purpose |
|------|---------|
| `routes/videoExplainer.js` | API endpoints: upload, youtube download, run pipeline, preview |
| `services/youtubeDownloader.js` | yt-dlp download with mweb fallback |
| `services/videoStitcher.js` | Concat multiple video files into source.mp4 |
| `services/opEdDetector.js` | Gemini audio fingerprint OP/ED detection |
| `services/geminiVideoBreakdown.js` | Gemini multimodal scene breakdown (core AI) |
| `services/storySummarizer.js` | Episode + bundle summarization |
| `services/sceneSelector.js` | Mode picking + scene selection + callbackTo |
| `services/explainerScriptWriter.js` | AI narrator script with mood WPS + cold-open |
| `services/edgeTTS.js` | Edge TTS with SSML prosody + breathe segments |
| `services/elevenLabsTTS.js` | ElevenLabs TTS (paid alternative) |
| `services/videoExplainerRenderer.js` | FFmpeg render: per-segment sync + ducked audio |
| `services/subtitleGenerator.js` | ASS subtitle generation from word timestamps |
| `services/gpuDetect.js` | NVENC/libx264 detection |
| `services/youtubeUploader.js` | YouTube OAuth upload (exists, not wired to explainer) |
| `utils/textClient.js` | Gemini text generation client (thinking mode) |
| `jobs/processor.js` | Background job queue with SSE events |

### Prompts (prompts/)
| File | Purpose |
|------|---------|
| `visual-scene-breakdown.v1.md` | Gemini scene analysis (podcast/interview/narrative) |
| `explainer-narration.v1.md` | Script writer narrator style + breathe + cold-open |
| `bundle-summary.v1.md` | Multi-segment content summarization |
| `episode-summary.v1.md` | Per-episode/section summarization |

### Frontend (client/src/)
| File | Purpose |
|------|---------|
| `pages/VideoExplainerPage.jsx` | Main 4-step wizard UI |
| `App.jsx` | Router + layout |
| `pages/Dashboard.jsx` | Project list / home |

### API Endpoints
| Method | Path | What It Does |
|--------|------|-------------|
| POST | `/api/projects/:id/explainer-sources` | Upload episode files |
| POST | `/api/projects/:id/explainer-youtube` | Download from YouTube URL |
| POST | `/api/projects/:id/explainer/run` | Run analysis pipeline (OP/ED + breakdown + script) |
| GET | `/api/projects/:id/explainer/preview` | Get script + scene preview for review |
| POST | `/api/projects/:id/voice/generate` | Generate TTS narration |
| POST | `/api/projects/:id/render` | Render final video |
| GET | `/api/projects/:id/download` | Download output file |

---

## Tech Stack
- **Runtime**: Node.js (ESM), Express
- **AI**: Google Gemini 2.5 Flash (multimodal video+audio + text generation, thinking mode)
- **TTS**: Edge TTS (free, 8 voices, SSML prosody) / ElevenLabs (paid)
- **Video**: FFmpeg (complex filter graphs, NVENC GPU encoding)
- **Download**: yt-dlp
- **Frontend**: React (Vite), SSE for progress
- **SDK**: `@google/generative-ai` v0.24.1

## Key Numbers
- Gemini cost: ~$0.90 per source video (free tier covers several per day)
- Scene breakdown: 960px, 4fps, 18-min chunks
- TTS: ~2.3 words/sec average (mood-adjusted)
- Render FPS: 25
- Speed clamp: [0.25x, 4.0x] per segment
- Max YouTube download: 90 min
- Max file upload: 3 GB per file, 10 files max
