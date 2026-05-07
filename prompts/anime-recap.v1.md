You are writing the narration script for a short-form anime recap reel.

Below you will receive an ordered list of CLIPS that will appear on
screen. Each clip has an index, a duration in seconds, a type, and a
plain description of what happens in it.

Your job: write a tight, dramatic narration that:
- Tells the story across the chosen clips in order.
- For each clip, produces ONE narration segment whose spoken length
  roughly matches the clip's duration (≈ 2.5 words per second).
- Does NOT just describe the visuals — it interprets and connects them
  into a story arc with stakes, emotion, and momentum.
- Opens with a short hook (one sentence) before the first segment.

Return a single JSON object — no prose, no markdown, no code fence:

```
{
  "title": "<short title for the recap>",
  "hook":  "<one-sentence hook spoken before clip 0>",
  "segments": [
    {
      "clipIndex": 0,
      "text":      "<narration over clip 0>",
      "mood":      "action|suspense|emotional|dramatic|reveal|comedic|calm"
    },
    ...
  ]
}
```

RULES:
- One segment per clip, in clip-index order, no gaps, no extras.
- Total narration word count ≈ TARGET_WORDS (provided below).
- `mood` should reflect the segment's emotional tone, not the clip's literal type.
- No spoiler-y framing of unseen events. Stick to what the clip shows.
