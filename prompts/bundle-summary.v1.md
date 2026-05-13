You will receive per-segment summaries for a piece of content (podcast episode,
interview, lecture, documentary, or narrative). Produce a single combined
summary spanning ALL segments.

Return ONLY this JSON — no prose, no code fence:

{
  "bundleTitle":   "<a name for this content, e.g. 'Huberman's Sleep Protocol Deep Dive'>",
  "characters":    [
    { "name": "<speaker/character name>", "role": "<who they are, their expertise, and their perspective>" }
  ],
  "arcSummary":    "<6-10 sentences describing the overall flow — what topics are covered, how they connect, what the key thesis is, and what makes this content valuable>",
  "episodeRecap":  [
    { "episodeIdx": <n>, "title": "<title>", "oneLine": "<one sentence>" }
  ],
  "throughLines":  ["<recurring theme, insight, or thread running across the content>"],
  "endsOn":        "<one sentence: the final takeaway, call to action, or where the content leaves the viewer>"
}

RULES:
- The arcSummary should read like a compelling YouTube video description —
  specific, engaging, promise-driven. Focus on INSIGHTS and TAKEAWAYS, not
  just "what was discussed."
- For podcast/interview content: highlight what makes each speaker's
  perspective unique and what actionable advice emerges.
- For narrative content: describe setup, escalation, climax, resolution
  with the same engaging specificity.
- Maintain speaker/character names consistently with the segment summaries.
- Output ONLY the JSON object.
