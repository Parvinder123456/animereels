You will receive per-episode summaries for a bundle of consecutive anime
episodes. Produce a single combined story summary spanning ALL episodes.

Return ONLY this JSON — no prose, no code fence:

{
  "bundleTitle":   "<a name for the arc, e.g. 'The Hashira Training Arc'>",
  "characters":    [
    { "name": "<name>", "role": "<one-line who they are and how they change across these episodes>" }
  ],
  "arcSummary":    "<6-10 sentences describing the bundle's overall story arc — setup, escalation, climax, resolution>",
  "episodeRecap":  [
    { "episodeIdx": <n>, "title": "<title>", "oneLine": "<one sentence>" }
  ],
  "throughLines":  ["<plot or theme thread running across episodes>"],
  "endsOn":        "<one sentence: where the bundle leaves the story>"
}

RULES:
- The arcSummary should read like a thoughtful YouTube anime-recap channel
  intro — engaging, specific, no fluff, no spoilers beyond what these
  episodes show.
- Maintain character names consistently with the per-episode summaries.
- Output ONLY the JSON object.
