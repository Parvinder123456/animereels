You are watching a chunk of a video (audio + video). Produce a structured
segment-by-segment breakdown of THIS chunk.

For video podcasts / interviews / talking-head content:
  Anchor segments to TOPIC CHANGES — when the speaker shifts to a new subject,
  insight, or story. Don't split on every sentence; group related points into
  one segment. A 3-minute deep dive on one subject is ONE segment.

For narrative content (anime, film, documentary):
  Anchor segments to VISUAL CUTS — when the camera cuts to a fundamentally
  different image or location, start a new segment.

Each segment's `visualDescription` must describe what is LITERALLY on screen:
people present, their expressions, gestures, any graphics/B-roll shown.

The `dialogueGist` summarizes what is said (in English, even if the source
uses another language). The `dialogueVerbatim` captures the exact words for
key quotes worth preserving — lines that are quotable, surprising, or
actionable.

Return ONLY this JSON — no prose, no markdown, no code fence:

{
  "chunkStartSec": <copy from the metadata block I provide>,
  "contentType": "podcast|interview|lecture|narrative|documentary",
  "scenes": [
    {
      "startSec":          <number, seconds relative to THIS CHUNK's start>,
      "endSec":            <number, seconds relative to THIS CHUNK's start>,
      "type":              "insight|story|explanation|debate|action|emotional|reveal|transition|intro_outro",
      "importance":        <integer 1-5; 5 = key takeaway, major revelation, or climax>,
      "mood":              "calm|energetic|dramatic|emotional|comedic|reveal|suspense|inspirational",
      "visualDescription": "<what's on screen: speakers, expressions, gestures, graphics, B-roll>",
      "dialogueGist":      "<English summary of what's said, '' if silent>",
      "dialogueVerbatim":  "<original-language key quotes worth preserving, '' if none>",
      "characters":        ["<speaker names or roles visible/speaking>"],
      "keyTakeaway":       "<if importance >= 3: the one actionable insight or memorable point, '' otherwise>",
      "callbackTo":        <index of an earlier scene in THIS CHUNK that this scene builds on, references, or pays off; null if none>
    }
  ]
}

RULES:
- Segments cover the chunk continuously. Every second must belong to some scene.
- Minimum segment length 5 seconds. Merge tiny exchanges into the surrounding segment.
- For podcasts/interviews: one segment per TOPIC, not per sentence.
- Mark `type: "intro_outro"` for intros, outros, sponsor reads, and housekeeping.
- `type: "insight"` = a concrete, actionable takeaway the viewer can apply.
- `type: "story"` = a personal anecdote, case study, or illustrative example.
- `type: "explanation"` = detailed breakdown of a concept or mechanism.
- `type: "debate"` = disagreement, pushback, or nuanced discussion between speakers.
- `keyTakeaway` is the SINGLE most useful/memorable insight from that segment —
  the kind of thing a viewer would screenshot or write down.
- `callbackTo` links a segment to an earlier one it builds on. Use this when a
  speaker returns to an earlier point, contradicts it, adds a twist, or
  delivers a payoff. This helps the narrator connect ideas across the video.
- Be specific. "They discuss health" is bad. "Huberman explains that morning
  sunlight exposure within 30 minutes of waking sets circadian rhythm via
  melanopsin cells in the retina" is good.
- For narrative content: "Two characters talk" is bad. "Tanjiro kneels beside
  an unconscious Nezuko, trembling as he reaches for her" is good.
- Output ONLY the JSON object.
