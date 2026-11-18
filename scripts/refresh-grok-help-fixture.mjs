#!/usr/bin/env node
/**
 * Capture the help text of an installed `grok` binary into a version-stamped
 * fixture, one file per command, for the launch-surface test
 * (src/__tests__/shared/maestro-lib/providers/grok-help-fixture.test.ts).
 *
 *   node scripts/refresh-grok-help-fixture.mjs [--grok <path>] [--out <dir>] [--force]
 *
 * The fixture directory is src/__tests__/fixtures/grok/help-<version>/ unless
 * --out names another. The binary's version line is written to version.txt.
 * The script refuses to write into a directory whose name or version.txt names
 * a different version, so an upgrade lands beside the old fixture instead of
 * silently replacing it. --force rewrites an existing fixture of the SAME
 * version only. Help output needs no account and starts no turn.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_ROOT = path.join(ROOT, 'src', '__tests__', 'fixtures', 'grok');

/** File name to argv. The test reads exactly these names. */
export const GROK_HELP_COMMANDS = Object.freeze({
	'grok--help.txt': ['--help'],
	'grok-help.txt': ['help'],
	'grok-agent--help.txt': ['agent', '--help'],
	'grok-agent-stdio--help.txt': ['agent', 'stdio', '--help'],
});

function fail(message) {
	console.error(`refresh-grok-help-fixture: ${message}`);
	process.exit(1);
}

function parseArgs(argv) {
	const options = { grok: process.env.GROK_BIN || 'grok', out: undefined, force: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--grok') options.grok = argv[++i];
		else if (arg === '--out') options.out = argv[++i];
		else if (arg === '--force') options.force = true;
		else fail(`unknown argument ${arg}`);
	}
	if (!options.grok) fail('--grok needs a path');
	return options;
}

function run(grok, args) {
	const result = spawnSync(grok, args, {
		encoding: 'utf8',
		timeout: 15_000,
		// A fixed width keeps clap's wrapping stable between terminals.
		env: { ...process.env, COLUMNS: '100', NO_COLOR: '1', TERM: 'dumb' },
	});
	if (result.error) fail(`could not run ${grok} ${args.join(' ')}: ${result.error.message}`);
	if (result.status !== 0) {
		fail(`${grok} ${args.join(' ')} exited ${result.status}: ${result.stderr.trim()}`);
	}
	// Normalize trailing whitespace so a rewrite of the same version is byte-stable.
	return (
		result.stdout
			.split('\n')
			.map((line) => line.replace(/\s+$/, ''))
			.join('\n')
			.trimEnd() + '\n'
	);
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	const versionLine = run(options.grok, ['--version']).trim();
	const match = versionLine.match(/^grok (\d+\.\d+\.\d+)\b/);
	if (!match) fail(`unrecognized version line: ${versionLine}`);
	const version = match[1];

	const out = path.resolve(options.out ?? path.join(FIXTURE_ROOT, `help-${version}`));
	const dirVersion = path.basename(out).match(/^help-(\d+\.\d+\.\d+)$/)?.[1];
	if (dirVersion && dirVersion !== version) {
		fail(
			`${out} is the fixture of ${dirVersion}; the binary is ${version}. Refusing to overwrite.`
		);
	}
	const versionFile = path.join(out, 'version.txt');
	if (fs.existsSync(versionFile)) {
		const recorded = fs.readFileSync(versionFile, 'utf8').trim();
		const recordedVersion = recorded.match(/^grok (\d+\.\d+\.\d+)\b/)?.[1];
		if (recordedVersion !== version) {
			fail(
				`${versionFile} records "${recorded}"; the binary is ${version}. Refusing to overwrite.`
			);
		}
		if (!options.force) {
			fail(`${out} already holds the ${version} fixture. Pass --force to rewrite it.`);
		}
	}

	const files = { 'version.txt': `${versionLine}\n` };
	for (const [name, args] of Object.entries(GROK_HELP_COMMANDS))
		files[name] = run(options.grok, args);
	fs.mkdirSync(out, { recursive: true });
	for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(out, name), text);
	console.log(
		`wrote ${Object.keys(files).length} files for ${versionLine} to ${path.relative(ROOT, out)}`
	);
}

main();
