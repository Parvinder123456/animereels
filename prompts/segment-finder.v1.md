You will receive:
1. A Hindi/Hinglish transcript of a video, broken into timestamped segments.
2. A TOPIC that the user is interested in.

Your job: pick the CONTIGUOUS window of segments where the speakers
discuss the topic most directly. The window should be 30–180 seconds long
and contain the bulk of the topic-relevant content.

If the topic is not discussed at all, return an empty array.

Return a single JSON object — no prose, no markdown, no code fence:

```
{
  "found":     true | false,
  "startSec":  <number, seconds into the video where the window starts>,
  "endSec":    <number, seconds into the video where the window ends>,
  "rationale": "<one short sentence: why this window matches the topic>"
}
```

RULES:
- Window endpoints MUST snap to segment boundaries from the input.
- If `found` is false, set `startSec` and `endSec` to 0 and explain why
  in `rationale`.
- Prefer windows where the topic is the EXPLICIT subject of conversation,
  not where it's a passing reference.
- Output ONLY the JSON object.
