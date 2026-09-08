---
name: analyze-data
agents: [coder]
description: >-
  Analyzing a CSV, TSV, JSON or other data file — counting, summarizing,
  grouping, finding the largest or the average, spotting duplicates. Use
  whenever the user points at a data file and asks a question about what is
  in it.
allowed-tools: [read_file, run_command, write_file]
---

# Analyze a data file

The tools for this are `read_file` and `run_command` with a short Python
script. Never claim there is no tool for analyzing data — Python through
`run_command` analyzes anything.

Work in this order:

1. **Look at the shape first.** `read_file` the file. For a large file, the
   point is only the header row and a few data rows — enough to learn the
   column names and what the values look like. Never try to read a huge file
   whole.

2. **Answer with a one-shot Python script.** Use only the standard library —
   `csv`, `json`, `collections`, `statistics` — so nothing needs installing:

   ```
   run_command: python3 -c "
   import csv
   from collections import Counter
   with open('sales.csv') as f:
       rows = list(csv.DictReader(f))
   print('rows:', len(rows))
   total = sum(float(r['amount']) for r in rows)
   print('total amount:', round(total, 2))
   by_region = Counter(r['region'] for r in rows)
   print('by region:', by_region.most_common())
   "
   ```

   Adapt the column names to what step 1 actually showed — never guess at
   them.

3. **Answer the question in plain words**, with the numbers the script
   printed. The user asked a question, not for a script; show the code only
   if they asked how.

4. **A bigger analysis becomes a file.** If the user wants a report or a
   cleaned-up version of the data, write the result with `write_file` and
   say where it went.

If the file turns out not to exist, say what `read_file` reported and stop —
do not invent example data and analyze that instead.
