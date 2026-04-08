#!/usr/bin/env node

/**
 * Showcase Launcher
 *
 * Runs setup.js with forwarded CLI args, then launches the dev server
 * with MAESTRO_DEMO_DIR pointing to the showcase data.
 *
 * Usage: node scripts/showcase/launch.js [--theme <id>] [--size <WxH>]
 * Or via: npm run dev:showcase [-- --theme <id> --size <WxH>]
 */

const { execFileSync, spawn } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const args = process.argv.slice(2);

// Run setup with forwarded CLI args
execFileSync(process.execPath, [path.join(__dirname, 'setup.js'), ...args], {
	stdio: 'inherit',
	cwd: ROOT,
});

// Launch dev server with showcase data directory
const child = spawn('npm', ['run', 'dev'], {
	stdio: 'inherit',
	env: { ...process.env, MAESTRO_DEMO_DIR: '/tmp/maestro-showcase' },
	cwd: ROOT,
	shell: true,
});

process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', (code) => process.exit(code ?? 1));
