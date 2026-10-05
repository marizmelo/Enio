/**
 * Held-out replies for the mood label (scripts/mood-bench.mjs), labelled
 * by hand. None of these may appear in MOOD_EXAMPLES -- a test enforces
 * it -- because a threshold measured on the training examples measures
 * nothing. A few are deliberately ambiguous; they are what the margin is for.
 */
export const BENCH = [
  // happy
  ["Done! The note is saved under Projects and tagged for Monday.", "happy"],
  ["That worked on the first try: all forty tests pass.", "happy"],
  ["Your flight reminder is set for six in the morning, as asked.", "happy"],
  ["Great — the fix was a single line, and the build is clean now.", "happy"],
  ["I found the receipt in your Drive and attached it to the note.", "happy"],
  ["The backup finished successfully, 1.2 GB in under a minute.", "happy"],
  ["Yes! That is exactly how the router decides, and your reading of it is right.", "happy"],
  ["The email went out and the calendar invite is accepted.", "happy"],
  ["Glad that helped. The summary is in the canvas if you want to edit it.", "happy"],
  ["The model downloaded and answers in about a second now.", "happy"],
  ["Perfect, the duplicate rows are gone and the totals match.", "happy"],
  // sorry
  ["I couldn't open that spreadsheet; the file is password-protected.", "sorry"],
  ["Sorry, the web search failed with a network error, so I have nothing to show.", "sorry"],
  ["That command exited with code 1, so the deploy did not happen.", "sorry"],
  ["I wasn't able to save the note — the folder is not writable.", "sorry"],
  ["My earlier answer was wrong about the date; the meeting is Thursday, not Tuesday.", "sorry"],
  ["The transcription failed halfway through; the audio file seems to be corrupt.", "sorry"],
  ["Unfortunately the page timed out twice, so I could not read it.", "sorry"],
  ["I could not reach the calendar; the account token has expired.", "sorry"],
  ["That did not work: the test runner is not installed in this project.", "sorry"],
  ["Apologies — I attached the wrong file; here is the right one.", "sorry"],
  ["The script failed before writing anything, so nothing changed on disk.", "sorry"],
  // unsure
  ["I don't have any notes about that trip.", "unsure"],
  ["There's no record of a meeting with Dana in your calendar or memory.", "unsure"],
  ["I can't find a function called parseHeader in this codebase.", "unsure"],
  ["I'm not sure which project you mean; nothing here is named Atlas.", "unsure"],
  ["Nothing in memory mentions your dentist, so I can't say when the appointment is.", "unsure"],
  ["I don't know what the budget figure was; it isn't in any document I can see.", "unsure"],
  ["That name doesn't appear anywhere in the files I have.", "unsure"],
  ["I have no information about that contract renewal.", "unsure"],
  ["There is no such file in the workspace.", "unsure"],
  ["I couldn't find anything about the Halvorsen account.", "unsure"],
  ["I'm not certain — none of the sources answer that directly.", "unsure"],
  // neutral
  ["The function returns a promise that resolves to the parsed JSON.", "neutral"],
  ["You have two meetings tomorrow: standup at nine and a review at two.", "neutral"],
  ["It is twelve degrees and raining in Oslo right now.", "neutral"],
  ["The repository has three open pull requests, all from last week.", "neutral"],
  ["A mutex guarantees that only one thread holds the lock at a time.", "neutral"],
  ["The process is listening on port 8090 because 8080 was taken.", "neutral"],
  ["To change the voice, set the TTS voice variable and restart the agent.", "neutral"],
  ["The document has an introduction, two case studies, and a conclusion.", "neutral"],
  ["Here is the diff between the two versions, newest first.", "neutral"],
  ["Rust's borrow checker enforces ownership rules at compile time.", "neutral"],
  ["Opening the Memory panel.", "neutral"],
  ["The invoice total is 1,240 euros, due on the fifteenth.", "neutral"],
];
