#!/usr/bin/env node

/**
 * Showcase Setup Script
 *
 * Prepares the showcase data directory with curated seed data for demo/presentation mode.
 * On every run:
 *   1. Wipes the showcase directory clean
 *   2. Copies curated JSON configs and group chat data from scripts/showcase/seed/data/
 *   3. Replaces $CWD / $USERDATA placeholders with real paths
 *   4. Optionally patches theme and window size from CLI args
 *
 * No base/Electron seed directory is needed: Electron creates its internals on
 * first launch.
 *
 * Usage: node scripts/showcase/setup.js [--theme <id>] [--size <WxH>] [--cwd <path>]
 *                                       [--typography default|hacker]
 * Or via: npm run dev:showcase [-- --theme <id> --size <WxH>]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const { SHOWCASE_DIR: TARGET_DIR } = require('./showcase-dir');
const DATA_DIR = path.join(__dirname, 'seed', 'data');

// --- Parse CLI args ---

function parseArg(name) {
	const idx = process.argv.indexOf(`--${name}`);
	return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : null;
}

const cliTheme = parseArg('theme');
const cliSize = parseArg('size');

/**
 * What `$CWD` in the seed becomes: the working directory the demo agents point
 * at, and therefore the path PRINTED over the Files panel in every screenshot.
 *
 * Defaults to this checkout, which makes the file tree resolve and look real.
 * That also publishes wherever you happen to have cloned Maestro, so for a set
 * that is going on the website, pass `--cwd` pointing at a checkout living at a
 * neutral path. It must be a REAL directory either way - a made-up path renders
 * an empty tree, which looks broken rather than anonymous.
 */
const cliCwd = parseArg('cwd');

function rmrf(dirPath) {
	if (!fs.existsSync(dirPath)) return;
	fs.rmSync(dirPath, { recursive: true, force: true });
}

function copyDirRecursive(src, dest) {
	fs.mkdirSync(dest, { recursive: true });
	const entries = fs.readdirSync(src, { withFileTypes: true });
	for (const entry of entries) {
		const srcPath = path.join(src, entry.name);
		const destPath = path.join(dest, entry.name);
		if (entry.isDirectory()) {
			copyDirRecursive(srcPath, destPath);
		} else {
			fs.copyFileSync(srcPath, destPath);
		}
	}
}

function replaceInFile(filePath, search, replacement) {
	if (!fs.existsSync(filePath)) return;
	let content = fs.readFileSync(filePath, 'utf8');
	const original = content;
	content = content.replaceAll(search, replacement);
	if (content !== original) {
		fs.writeFileSync(filePath, content, 'utf8');
	}
}

// --- Main ---

console.log('[showcase] Setting up showcase data...');
console.log(`[showcase] Repo root: ${REPO_ROOT}`);
console.log(`[showcase] Target:    ${TARGET_DIR}`);

// 1. Clean and create target
console.log('[showcase] Cleaning target directory...');
rmrf(TARGET_DIR);
fs.mkdirSync(TARGET_DIR, { recursive: true });

// 2. Copy curated JSON configs and group chat directories
if (!fs.existsSync(DATA_DIR)) {
	console.error(`[showcase] ERROR: Seed data directory not found: ${DATA_DIR}`);
	console.error('[showcase] The seed is committed; this checkout may be incomplete.');
	process.exit(1);
}

const jsonFiles = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json'));
console.log(`[showcase] Writing ${jsonFiles.length} config files...`);
for (const file of jsonFiles) {
	fs.copyFileSync(path.join(DATA_DIR, file), path.join(TARGET_DIR, file));
}

// Copy group-chats directory if it exists
const groupChatsSource = path.join(DATA_DIR, 'group-chats');
if (fs.existsSync(groupChatsSource)) {
	const groupChatsDest = path.join(TARGET_DIR, 'group-chats');
	console.log('[showcase] Copying group chat data...');
	copyDirRecursive(groupChatsSource, groupChatsDest);
}

// 3. Replace $CWD placeholders with actual repo path
const demoCwd = cliCwd ? path.resolve(cliCwd) : REPO_ROOT;
if (cliCwd && !fs.existsSync(demoCwd)) {
	console.error(`[showcase] ERROR: --cwd path does not exist: ${demoCwd}`);
	console.error('[showcase] It has to be a real checkout, or the Files panel renders empty.');
	process.exit(1);
}
console.log(`[showcase] Replacing $CWD → ${demoCwd}`);
replaceInFile(path.join(TARGET_DIR, 'maestro-sessions.json'), '$CWD', demoCwd);
replaceInFile(path.join(TARGET_DIR, 'maestro-claude-session-origins.json'), '$CWD', demoCwd);
replaceInFile(path.join(TARGET_DIR, 'maestro-agent-session-origins.json'), '$CWD', demoCwd);

// 3b. Replace $USERDATA placeholders with target directory (for group chat paths)
console.log(`[showcase] Replacing $USERDATA → ${TARGET_DIR}`);
const groupChatsDir = path.join(TARGET_DIR, 'group-chats');
if (fs.existsSync(groupChatsDir)) {
	const chatDirs = fs.readdirSync(groupChatsDir, { withFileTypes: true });
	for (const entry of chatDirs) {
		if (entry.isDirectory()) {
			replaceInFile(path.join(groupChatsDir, entry.name, 'metadata.json'), '$USERDATA', TARGET_DIR);
		}
	}
}

// 3c. Every first-run modal must already be answered in the seed.
//
// The onboarding series shows one modal per step and each carries its OWN seen
// flag, so a step added later defaults to UNSEEN and silently parks a modal over
// the app. That is invisible until a capture run comes back with the hero shot
// covered by a dialog - which is exactly how the `updates` step was found. The
// step list is read out of the shared module rather than restated here, so a
// fifth step fails LOUDLY at seed time instead of quietly ruining a run.
{
	const stepsFile = path.join(REPO_ROOT, 'src', 'shared', 'onboardingSeries.ts');
	const source = fs.readFileSync(stepsFile, 'utf8');
	const list = source.match(/export const ONBOARDING_STEPS = \[([^\]]+)\]/);
	if (!list) {
		console.error('[showcase] ERROR: could not read ONBOARDING_STEPS from', stepsFile);
		process.exit(1);
	}
	const steps = [...list[1].matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]);
	const settingsFile = path.join(TARGET_DIR, 'maestro-settings.json');
	const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
	const missing = steps.filter((step) => settings[`${step}PromptSeen`] !== true);
	if (missing.length) {
		console.error(
			`[showcase] ERROR: seed does not dismiss every first-run modal. Add ${missing
				.map((s) => `"${s}PromptSeen": true`)
				.join(', ')} to scripts/showcase/seed/data/maestro-settings.json`
		);
		process.exit(1);
	}
	console.log(`[showcase] First-run modals dismissed: ${steps.join(', ')}`);
}

// 3d. Write the typography preset the screenshots are shot in.
//
// The STORE default is still all-monospace, deliberately: Maestro looked that
// way before per-surface fonts existed, and a returning user must not have
// their look changed underneath them. New users are offered the choice by the
// typography step of the onboarding series - which this seed dismisses, so
// without writing a preset here every screenshot comes out in `hacker` and
// advertises a look that is no longer what a new install is steered toward.
//
// The values are LOADED from `src/shared/typographyPresets.ts` rather than
// copied into the seed JSON, because a preset is a live product decision: when
// the Default face or its sizes are retuned, the published set should follow on
// the next run rather than keep photographing a preset nobody ships. Typography
// is twelve settings across six surfaces, and a hand-copied set of twelve
// drifts one field at a time, invisibly.
{
	const presetId = parseArg('typography') || 'default';
	let presets;
	// Bundled to a temp file and required, rather than evaluated in-process:
	// the bytes are esbuild's output for a first-party source file, but a plain
	// `require` of a real file keeps this out of the eval family entirely, so
	// nobody reviewing it has to reason about whether anything can reach the
	// evaluated string.
	const bundlePath = path.join(
		os.tmpdir(),
		`maestro-showcase-typography-${process.pid}-${Date.now()}.cjs`
	);
	try {
		require('esbuild').buildSync({
			entryPoints: [path.join(REPO_ROOT, 'src', 'shared', 'typographyPresets.ts')],
			outfile: bundlePath,
			bundle: true,
			format: 'cjs',
			platform: 'node',
			logLevel: 'silent',
		});
		presets = require(bundlePath).TYPOGRAPHY_PRESETS;
	} catch (err) {
		console.error(`[showcase] ERROR: could not load typography presets: ${err.message}`);
		process.exit(1);
	} finally {
		fs.rmSync(bundlePath, { force: true });
	}

	const preset = presets[presetId];
	if (!preset) {
		console.error(
			`[showcase] ERROR: unknown typography preset "${presetId}". Valid: ${Object.keys(presets).join(', ')}`
		);
		process.exit(1);
	}

	const settingsFile = path.join(TARGET_DIR, 'maestro-settings.json');
	const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
	Object.assign(settings, preset.fonts, preset.sizes);
	fs.writeFileSync(settingsFile, JSON.stringify(settings, null, '\t'), 'utf8');
	console.log(`[showcase] Typography preset → ${preset.label} (${preset.tagline})`);
}

// 4. Patch theme and window size from CLI args
if (cliTheme) {
	const settingsFile = path.join(TARGET_DIR, 'maestro-settings.json');
	console.log(`[showcase] Setting theme → ${cliTheme}`);
	const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
	settings.activeThemeId = cliTheme;
	fs.writeFileSync(settingsFile, JSON.stringify(settings, null, '\t'), 'utf8');
}

if (cliSize) {
	const match = cliSize.match(/^(\d+)x(\d+)$/);
	if (!match) {
		console.error(`[showcase] ERROR: Invalid size format "${cliSize}". Use WxH (e.g., 2304x1360)`);
		process.exit(1);
	}
	const width = parseInt(match[1], 10);
	const height = parseInt(match[2], 10);
	console.log(`[showcase] Setting window size → ${width}x${height}`);
	const windowStateFile = path.join(TARGET_DIR, 'maestro-window-state.json');
	const windowState = JSON.parse(fs.readFileSync(windowStateFile, 'utf8'));
	windowState.width = width;
	windowState.height = height;
	fs.writeFileSync(windowStateFile, JSON.stringify(windowState, null, '\t'), 'utf8');
}

console.log(`[showcase] Done. Ready to launch with MAESTRO_DEMO_DIR=${TARGET_DIR}`);
