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
