#!/usr/bin/env node
// Fake `qoder --list-models` for tests — stands in for the real CLI.
// Prints a table-ish list (header + separator + model rows, one bare
// tier name) so the parser is exercised the way the real output would
// exercise it.
const rows = [
  'Model Name        Credit',
  '--------------------------',
  'Qwen3.8-Max       0.5x',
  'DeepSeek-V4-Flash 0.3x',
  'auto',
];
for (const row of rows) process.stdout.write(`${row}\n`);
