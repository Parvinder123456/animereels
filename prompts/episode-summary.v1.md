You will receive the dialogue transcript of one anime episode, with timestamps.

Produce a tight summary that captures the story so the narrator who will
later write commentary KNOWS what is happening, who matters, and why.

Return ONLY this JSON — no prose, no code fence:

{
  "episodeIdx":  <integer>,
  "title":       "<a short episode title you can infer from the dialogue, e.g. 'The Sword's Awakening'>",
  "characters":  [
    { "name": "<name or role>", "role": "<one-line who they are and what they want>" }
  ],
  "plotArc":     "<3-5 sentence description of what happens in this episode from start to end>",
  "keyMoments":  [
    { "atSec": <number>, "what": "<one-line: what happens here that matters>" }
  ],
  "themes":      ["<theme1>", "<theme2>"],
  "unresolved":  "<one sentence: what's set up to pay off later>"
}

RULES:
- Be specific about WHAT happens, not vague. "Hero meets a stranger" is bad;
  "Tanjiro encounters the demon slayer Giyu, who challenges him to prove his
   resolve" is good.
- Names matter. Use them if the dialogue gives them, otherwise label by role.
- 5-8 keyMoments, in chronological order, with absolute timestamps.
- Output ONLY the JSON object.
