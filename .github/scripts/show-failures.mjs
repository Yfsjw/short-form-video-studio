// Turns the failing tests of a `node --test` run (TAP text) into annotations on the CI run. The full log of a run is not always
// reachable (it is a download from another host), while annotations are part of the run's page and its API.
import { readFileSync } from 'node:fs';

const MAX_ANNOTATIONS = 10;
const MAX_LINES_PER_FAILURE = 16;
const MAX_CHARS = 1800;

const lines = readFileSync(process.argv[2] ?? 'test-output.txt', 'utf8').split('\n');
const failures = [];
let current;
for (const line of lines) {
  const failed = /^(\s*)not ok \d+ - (.*)$/.exec(line);
  if (failed) { current = { title: failed[2], body: [] }; failures.push(current); continue; }
  if (/^\s*ok \d+ - /.test(line)) { current = undefined; continue; }
  if (!current) continue;
  const text = line.trim();
  if (!text || text === '---' || text === '...' || /^(duration_ms|type):/.test(text)) continue;
  if (current.body.length < MAX_LINES_PER_FAILURE) current.body.push(text);
}

// Workflow commands need these characters written out in the message.
const escapeData = (text) => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (text) => escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');

console.log(`${failures.length} failing test(s) found in the output`);
for (const failure of failures.slice(0, MAX_ANNOTATIONS)) {
  const message = failure.body.join('\n').slice(0, MAX_CHARS) || '(no details were printed)';
  console.log(`::error title=${escapeProperty(failure.title.slice(0, 120))}::${escapeData(message)}`);
}
if (failures.length > MAX_ANNOTATIONS) console.log(`::error title=more failures::${failures.length - MAX_ANNOTATIONS} more failing tests are not shown`);
