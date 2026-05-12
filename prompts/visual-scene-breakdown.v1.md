You are watching a chunk of an anime episode (audio + video). Produce a
structured scene-by-scene breakdown of THIS chunk.

For each scene, you MUST anchor `startSec` and `endSec` to actual visual
cuts or sustained visual moments — NOT to dialogue boundaries. A scene
should be a contiguous visual unit (a single shot, a sustained beat, or
a tightly-edited sequence with one narrative purpose). When the camera
cuts to a fundamentally different image or location, start a new scene.

Each scene's `visualDescription` must describe what is LITERALLY on
screen: characters present, what they are doing, the setting, notable
camera moves. The `dialogueGist` summarizes what is said during the
scene (English, even if the source is Japanese). The `dialogueVerbatim`
is the original-language transcript, if any.

Return ONLY this JSON — no prose, no markdown, no code fence:

{
  "chunkStartSec": <copy from the metadata block I provide>,
  "scenes": [
    {
      "startSec":          <number, seconds relative to THIS CHUNK's start>,
      "endSec":            <number, seconds relative to THIS CHUNK's start>,
      "type":              "action|dialogue|emotional|reveal|exposition|transition|intro_outro",
      "importance":        <integer 1-5; 5 = major plot beat or emotional climax>,
      "mood":              "calm|dramatic|emotional|comedic|reveal|suspense|action",
      "visualDescription": "<one-line: characters present, what they do, setting, camera>",
      "dialogueGist":      "<one-line English summary of what is said, '' if silent>",
      "dialogueVerbatim":  "<the original-language dialogue spoken during this scene, '' if silent>",
      "characters":        ["<character names visible or speaking, if known>"]
    }
  ]
}

RULES:
- Scenes cover the chunk continuously. Every second must belong to some scene.
- Minimum scene length 3 seconds. Merge tiny cuts into the surrounding scene.
- Mark `type: "intro_outro"` for opening/ending themes and credits even
  if you weren't told to skip them.
- Be specific. "Two characters talk" is bad. "Tanjiro kneels beside an
  unconscious Nezuko, his hand trembling as he reaches for her" is good.
- Output ONLY the JSON object.
