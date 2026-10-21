// Runs every benchmark in its own process and leaves the results in
// bench/results/. phases.js needs internet and is skipped without it.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const benches = ['parser', 'accuracy', 'overhead', 'memory', 'phases'];
const only = process.argv.slice(2);

for (const name of benches.filter((b) => only.length === 0 || only.includes(b))) {
  console.log(`\n# ${name}`);
  const file = fileURLToPath(new URL(`./${name}.js`, import.meta.url));
  const { status } = spawnSync(process.execPath, [file], { stdio: 'inherit' });
  if (status !== 0) console.log(`${name} failed with status ${status}${name === 'phases' ? ' (needs internet)' : ''}`);
}
