#!/usr/bin/env node
/**
 * One-step installer for dsh-model-bridge into a local DeepSeek Harness profile.
 *
 *   node scripts/install-into-dsh.mjs [profile] [--home <dir>]
 *
 * profile defaults to `web` (also common: `desktop`, `headless`).
 *
 * What it does (idempotent):
 *   1. `pnpm add <this package dir> --save-exact` inside ~/.dsh/profiles/<profile>
 *      (falls back to printing the equivalent `dsh plugin add` command).
 *   2. Append the plugin block to the profile's cordis.patch.yml (with a
 *      timestamped backup) when `id: model-bridge` is not already there.
 *
 * Zero npm dependencies.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const homeIdx = argv.indexOf('--home');
const dshHome = homeIdx >= 0 ? resolve(argv[homeIdx + 1]) : join(homedir(), '.dsh');
const profile = (homeIdx >= 0 ? [...argv.slice(0, homeIdx), ...argv.slice(homeIdx + 2)] : argv)[0] ?? 'web';

const profileDir = join(dshHome, 'profiles', profile);
if (!existsSync(join(profileDir, 'package.json'))) {
    console.error(`error: profile "${profile}" not found at ${profileDir}`);
    console.error('       pass the profile name as the first argument, e.g.:');
    console.error('       node scripts/install-into-dsh.mjs desktop');
    process.exit(1);
}

console.log(`dsh home : ${dshHome}`);
console.log(`profile  : ${profile} (${profileDir})`);
console.log(`plugin   : ${pluginDir}`);

// --- step 1: dependency into the profile -----------------------------------

const pnpm = spawnSync('pnpm', ['add', pluginDir, '--save-exact'], {
    cwd: profileDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
});
if (pnpm.status !== 0) {
    console.error('\npnpm add failed (or pnpm is not on PATH). Run the dsh CLI equivalent instead:');
    console.error(`  dsh plugin --profile ${profile} add "${pluginDir}"`);
    if (pnpm.error?.code === 'ENOENT') {
        console.error('(pnpm was not found; installing pnpm or using the dsh CLI both work.)');
    }
    process.exit(1);
}

// --- step 2: patch entry ------------------------------------------------------

const patchPath = join(profileDir, 'cordis.patch.yml');
const block = [
    '- insert:',
    '  - id: model-bridge',
    '    name: dsh-model-bridge',
    '    config:',
    '      port: 3091',
    '      defaultModel: deepseek-flash',
    '      # authToken: leave empty and set DSH_BRIDGE_TOKEN instead',
    '',
].join('\n');

let patch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '';
if (/^-\s*insert:/m.test(patch) && /id:\s*model-bridge/m.test(patch)) {
    console.log('patch    : already present in cordis.patch.yml — nothing to do');
} else {
    if (existsSync(patchPath)) {
        const backup = `${patchPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        copyFileSync(patchPath, backup);
        console.log(`patch    : backed up to ${backup}`);
    }
    if (patch && !patch.endsWith('\n')) patch += '\n';
    writeFileSync(patchPath, patch + block, 'utf8');
    console.log(`patch    : appended plugin block to ${patchPath}`);
}

console.log('\nDone. Restart the harness, then connect any MCP client to:');
console.log(`  http://127.0.0.1:3091/mcp   (Bearer: $DSH_BRIDGE_TOKEN, if set)`);
