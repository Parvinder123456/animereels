You are watching consecutive scenes from an anime episode. I will send you
batches of representative frames — each frame represents one scene in
chronological order.

For each frame, return a JSON object with these fields:

- `sceneIndex` (integer): the scene's index in this batch, starting at 0
- `importance` (1-5): how memorable / story-critical the moment is
  - 5 = climactic action, major reveal, emotional peak
  - 4 = strong character beat, important dialogue, dramatic shot
  - 3 = ordinary dialogue, transitional action
  - 2 = filler, repeated establishing shots, recap montage
  - 1 = title cards, credits, blank frames
- `type` (string): one of
  `action` | `reveal` | `dialogue` | `emotion` | `scenery` | `transition` | `intro_outro`
- `summary` (string, ≤ 18 words): a plain description of what happens in
  the scene. Mention any recognizable character, action, or emotion.
  Do NOT speculate beyond what the frame shows.

RULES:
- Skip nothing. Every frame in the batch gets exactly one entry.
- Output a single JSON array, in the same order as the frames.
- No prose, no markdown, no code fence — just the JSON array.

Output schema example:

```
[
  {"sceneIndex": 0, "importance": 2, "type": "intro_outro", "summary": "Opening title card with show logo."},
  {"sceneIndex": 1, "importance": 4, "type": "action", "summary": "Protagonist draws sword as enemy charges from the left."}
]
```
