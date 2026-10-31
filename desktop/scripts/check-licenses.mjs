// Free-stack rule: no GPL/AGPL (or unknown) dependency may ship without explicit approval.
// Only production dependencies are checked; those are what end up inside the app.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FORBIDDEN = /(^|[^L])(A?GPL)|SSPL|BUSL|Commercial/i;
const tree = JSON.parse(execSync('npm ls --omit=dev --all --json --long', { encoding: 'utf8', maxBuffer: 1 << 28 }));

const seen = new Map();
(function walk(node) {
  for (const dep of Object.values(node.dependencies ?? {})) {
    if (!dep.path || seen.has(dep.path)) continue;
    const pkg = JSON.parse(readFileSync(join(dep.path, 'package.json'), 'utf8'));
    seen.set(dep.path, { name: pkg.name, license: typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? 'UNKNOWN') });
    walk(dep);
  }
})(tree);

const packages = [...seen.values()];
const bad = packages.filter((p) => p.license === 'UNKNOWN' || FORBIDDEN.test(p.license));
const summary = Object.entries(Object.groupBy(packages, (p) => p.license)).map(([license, list]) => `${license}: ${list.length}`);
console.log(`${packages.length} production packages. ${summary.join(', ')}`);
if (bad.length) {
  console.error('Not allowed without approval:', bad);
  process.exit(1);
}
