// Runs a dev tool with ELECTRON_RUN_AS_NODE cleared. Editors built on Electron (like VS Code) set it
// in their terminals, and it makes Electron start as plain Node with no app at all.
import { spawnSync } from 'node:child_process';

const [cmd, ...args] = process.argv.slice(2);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(`npx ${cmd} ${args.join(' ')}`, { stdio: 'inherit', env, shell: true });
process.exit(result.status ?? 1);
