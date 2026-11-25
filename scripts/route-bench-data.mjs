/**
 * Held-out routing benchmark. None of these prompts appears in
 * ROUTING_EXAMPLES or in any specialist description — a test holds that
 * line — so a router that merely memorised its examples scores like one.
 * Six per specialist plus a handful written to be ambiguous on purpose,
 * labelled the way the built-in router's comments say they should go.
 */
export const BENCH = [
  // researcher: the outside world
  ["what did the fed decide about rates this week", "researcher"],
  ["is the new macbook air worth it compared to last year's", "researcher"],
  ["who won the champions league final", "researcher"],
  ["summarise the latest on the eu ai act", "researcher"],
  ["find me a good recipe for shakshuka", "researcher"],
  ["what's the weather going to be like in lisbon this weekend", "researcher"],
  // coder: files, code, documents on disk
  ["add a retry to the fetch call in api/client.ts", "coder"],
  ["why does npm install fail with EACCES", "coder"],
  ["write a cover letter for the data analyst role and save it", "coder"],
  ["make a spreadsheet-style summary of expenses.csv", "coder"],
  ["rename every .jpeg in the photos folder to .jpg", "coder"],
  ["draft the release notes for version 2.1 as a markdown file", "coder"],
  // librarian: the user, memory, library, files by name
  ["what do you remember about my sister's birthday", "librarian"],
  ["remember that my landlord's name is Teresa", "librarian"],
  ["search my library for the apartment lease", "librarian"],
  ["where did I save the insurance policy pdf", "librarian"],
  ["what have we talked about regarding the garden project", "librarian"],
  ["remind yourself that I prefer metric units", "librarian"],
  // mail
  ["any unread emails from the accountant", "mail"],
  ["reply to Jonas and tell him thursday works", "mail"],
  ["what did the school send about the trip", "mail"],
  ["find the drive doc shared by marketing last week", "mail"],
  ["email the invoice to the client", "mail"],
  ["show me the last message from my bank", "mail"],
  // planner: calendar, todos, contacts through a connected account
  ["what's on my calendar tomorrow afternoon", "planner"],
  ["add dentist to my todo list for friday", "planner"],
  ["move the standup to 10", "planner"],
  ["what's Priya's phone number", "planner"],
  ["am I free next tuesday morning", "planner"],
  ["list my open todos", "planner"],
  // operator: doing things in mac apps
  ["open spotify and play my focus playlist", "operator"],
  ["take a screenshot of this window", "operator"],
  ["create a note called packing list with sunscreen and a hat", "operator"],
  ["set a timer for twenty minutes", "operator"],
  ["turn the volume down", "operator"],
  ["open the pdf in preview and zoom in", "operator"],
  // generalist: conversation, reasoning, automations
  ["what's the difference between a roth and a traditional ira", "generalist"],
  ["help me think through whether to take the job offer", "generalist"],
  ["run the weekly-digest automation now", "generalist"],
  ["set up an automation that summarises my inbox every morning", "generalist"],
  ["explain how a hash map works", "generalist"],
  ["tell me a joke about compilers", "generalist"],
  // deliberately ambiguous, labelled per the router's own rules
  ["write down that the meeting moved to 3", "operator"],
  ["make me a budget for the trip", "coder"],
  ["what did Sam say about the deadline", "mail"],
  ["find the notes from the offsite", "librarian"],
];

/**
 * A second set, aimed at the lines between agents rather than at their
 * middles: a calendar or todo change against a Mac app action, a reply
 * against a note, bulk file work against Finder, storing a preference
 * against conversation. BENCH has two or three of each, which was too few to
 * see that nearly all of them went the same wrong way.
 *
 * Its two halves have different standing. The first was written before the
 * routing examples were changed in November 2026 and used to choose them, so
 * it is no longer held out. The second was written after the examples were
 * chosen and before it was ever run, and nothing was tuned against it: its
 * misses are recorded in DECISIONS.md, not fixed.
 *
 * Labels follow the tables' own rules: a reminder or an alarm is the
 * operator's, a todo or an event the planner's. A calendar or todo change is
 * labelled for an install with the calendar write grant; without it those
 * belong to the operator (calendarChanger in src/routing-fast.ts).
 */
export const BOUNDARY = [
  // used to choose the examples
  ["push my 2pm to tomorrow", "planner"],
  ["cancel the meeting with Rita on wednesday", "planner"],
  ["book an hour for the gym on saturday morning", "planner"],
  ["add call the plumber to my list of things to do", "planner"],
  ["what do I have going on next week", "planner"],
  ["invite Tomás to the review on monday at 11", "planner"],
  ["reschedule the haircut to next thursday", "planner"],
  ["what's Marta's number", "planner"],
  ["do I have time for lunch on wednesday", "planner"],
  ["create an event for the school play on the 12th at 6pm", "planner"],
  ["write back to Helena and say I'll send it monday", "mail"],
  ["send Pedro the meeting notes by email", "mail"],
  ["answer the email from HR and accept", "mail"],
  ["let Carla know by email that the delivery is late", "mail"],
  ["forward the contract to my lawyer", "mail"],
  ["has the bank written to me this week", "mail"],
  ["draft an email to the team about the outage", "mail"],
  ["convert the csv files in this project to json", "coder"],
  ["delete the unused imports in utils.py", "coder"],
  ["count the lines in every file under src", "coder"],
  ["batch rename the screenshots in the assets folder", "coder"],
  ["move the test files into a tests directory", "coder"],
  ["open system settings", "operator"],
  ["pause the music", "operator"],
  ["make a note in notes titled ideas", "operator"],
  ["wake me up at 6:30 with an alarm", "operator"],
  ["remind me to take the bins out at 8", "operator"],
  ["what app is in front right now", "operator"],
  ["close the finder window", "operator"],
  ["run my resize shortcut", "operator"],
  ["switch to dark mode", "operator"],
  ["skip this song", "operator"],
  ["open the calendar app", "operator"],
  ["show me what's on the screen", "operator"],
  ["remember that my accountant is called Rui", "librarian"],
  ["note that I prefer answers in portuguese", "librarian"],
  ["from now on call me Zé", "librarian"],
  ["don't forget that my car is a 2019 golf", "librarian"],
  ["what's my wife's name", "librarian"],
  ["I'd like you to be more concise from now on", "librarian"],
  ["what do you know about where I work", "librarian"],
  ["why is the sky blue", "generalist"],
  ["what's a good way to learn the guitar", "generalist"],
  ["what's 15 percent of 240", "generalist"],
  ["latest news on the spacex launch", "researcher"],
  ["how much is a train ticket from porto to braga", "researcher"],
  // never tuned against
  ["pencil in coffee with Inês for thursday at four", "planner"],
  ["shift the team sync to the afternoon", "planner"],
  ["tick off the groceries task", "planner"],
  ["block out friday afternoon for deep work", "planner"],
  ["look up Ricardo's phone number", "planner"],
  ["is anything scheduled for the 3rd", "planner"],
  ["put pay the electricity bill on my task list", "planner"],
  ["set up a meeting with the design team next monday", "planner"],
  ["tell Miguel by email that the quote is approved", "mail"],
  ["respond to the landlord's message and say tomorrow is fine", "mail"],
  ["did the airline send a receipt", "mail"],
  ["send my cv to the recruiter", "mail"],
  ["what did the clinic write about my results", "mail"],
  ["rename the photos in the trip folder by date", "coder"],
  ["merge the two csv files in the data folder", "coder"],
  ["remove the console logs from main.js", "coder"],
  ["put all the images into an images folder", "coder"],
  ["launch the notes app", "operator"],
  ["open the reminders app", "operator"],
  ["turn the brightness up", "operator"],
  ["remind me at noon to call the bank", "operator"],
  ["start a stopwatch", "operator"],
  ["jot down a note that the wifi code is on the fridge", "operator"],
  ["run the shortcut for my morning routine", "operator"],
  ["quit safari", "operator"],
  ["what's playing right now", "operator"],
  ["remember that our anniversary is in june", "librarian"],
  ["please stop using emojis in your replies", "librarian"],
  ["what's my dog called", "librarian"],
  ["for future reference, I work night shifts", "librarian"],
  ["why do onions make you cry", "generalist"],
  ["how do vaccines work", "generalist"],
  ["what should I cook for six people", "generalist"],
  ["who is the prime minister of portugal right now", "researcher"],
  ["what's the score in the benfica game", "researcher"],
];

/**
 * Requests that take more than one agent, for scripts/flow-bench.mjs: the
 * positives for the check that turns such a request into a draft plan
 * instead of routing it to one agent. BENCH and BOUNDARY are its negatives,
 * since every prompt there belongs to exactly one agent. Written before the
 * check was run on anything.
 */
export const FLOWS = [
  "search the web for the best budget laptops and email me a summary",
  "look up tomorrow's weather in porto and add a reminder to bring an umbrella",
  "find the latest news on the eu ai act, write it up as a document and email it to Ana",
  "take a screenshot and email it to me",
  "research the top three project management tools then save a comparison as a markdown file",
  "check my inbox for the invoice from the accountant and add the due date to my calendar",
  "read my calendar for tomorrow and email the agenda to Marco",
  "find the lease in my library and summarise it in a document",
  "search for a lentil soup recipe and put the ingredients in a note",
  "look up the train times from lisbon to porto, then add the 9am one to my calendar",
  "remember that my passport expires in march and add a todo to renew it",
  "summarise the unread emails from this week and save the summary as a file",
  "find the pdf called insurance policy on my mac and email it to the broker",
  "research competitors for a coffee subscription, then draft an email to my partner with the findings",
  "check what's on my calendar this week and write a status report document",
  "search the web for flights to madrid in june and remember the cheapest price",
  "summarise expenses.csv and email the totals to my accountant",
  "look in my library for the warranty and add a calendar event for the day it ends",
  "get the headlines about spacex, then make a note of them in the notes app",
  "find Priya's email address and send her the meeting notes",
  "read the readme in my project and email a summary to the team",
  "search for the best hiking trails near sintra and create a document with the top five",
  "check the weather for saturday and schedule a picnic if it's dry",
  "find my notes about the tax audit and email them to my accountant",
];
