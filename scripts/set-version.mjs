#!/usr/bin/env node
/**
 * Cross-platform script to set VITE_APP_VERSION environment variable
 * with the local git hash. Works on Windows, macOS, and Linux.
 *
 * Usage: node scripts/set-version.mjs <command> [args...]
 * Example: bun scripts/set-version.mjs bun run build
 */

import { execFileSync, spawn } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import process from 'process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getGitHash() {
	try {
		const hash = execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], {
			encoding: 'utf8',
			stdio: ['pipe', 'pipe', 'pipe'],
		}).trim();
		return hash;
	} catch {
		return 'unknown';
	}
}

function getPackageVersion() {
	try {
		const packageJson = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
		return packageJson.version;
	} catch {
		return 'unknown';
	}
}

const gitHash = getGitHash();
const packageVersion = getPackageVersion();
const version = `${packageVersion} ${gitHash} (local)`;

// Set environment variable
process.env.VITE_APP_VERSION = version;

// Get the command and args to run
const [, , ...args] = process.argv;

if (args.length === 0) {
	console.log(`VITE_APP_VERSION=${version}`);
	process.exit(0);
}

// Run the command with the environment variable set
const command = args[0];
const commandArgs = args.slice(1);

const child = spawn(command, commandArgs, {
	stdio: 'inherit',
	shell: true,
	env: { ...process.env, VITE_APP_VERSION: version },
});

child.on('close', (code) => {
	process.exit(code ?? 0);
});

child.on('error', (err) => {
	console.error(`Failed to run command: ${err.message}`);
	process.exit(1);
});
