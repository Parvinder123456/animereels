You will receive the transcript of a content segment (podcast, interview,
lecture, or video), with timestamps.

Produce a tight summary that captures the key insights so the narrator who
will later write commentary KNOWS what was said, who said it, and why it
matters.

Return ONLY this JSON — no prose, no code fence:

{
  "episodeIdx":  <integer>,
  "title":       "<a short descriptive title, e.g. 'The Morning Sunlight Protocol'>",
  "characters":  [
    { "name": "<speaker name or role>", "role": "<who they are and their expertise>" }
  ],
  "plotArc":     "<3-5 sentences: what's discussed from start to finish, and the key thesis>",
  "keyMoments":  [
    { "atSec": <number>, "what": "<one-line: actionable insight, powerful quote, or key revelation>" }
  ],
  "themes":      ["<theme1>", "<theme2>"],
  "unresolved":  "<one sentence: what question is left open or what's set up for later>"
}

RULES:
- Be specific about WHAT was said. "They talk about health" is bad;
  "Huberman explains that 10 minutes of morning sunlight within 30 min of
   waking triggers melanopsin cells to set circadian rhythm, improving sleep
   onset by ~30 minutes" is good.
- Names matter. Use speaker names from the transcript. If unknown, label
  by role (Host, Guest, etc.).
- 5-8 keyMoments, in chronological order, with absolute timestamps.
- Focus on ACTIONABLE insights the narrator can turn into advice for the
  viewer.
- For narrative content: focus on what happens, who changes, and why it
  matters to the story.
- Output ONLY the JSON object.
