#!/usr/bin/env node

/**
 * Showcase Setup Script
 *
 * Prepares /tmp/maestro-showcase with curated seed data for demo/presentation mode.
 * On every run:
 *   1. Wipes /tmp/maestro-showcase clean
 *   2. Copies curated JSON configs and group chat data from scripts/showcase/seed/data/
 *   3. Replaces $CWD placeholders with the actual repo path
 *   4. Optionally patches theme and window size from CLI args
 *
 * No base/Electron seed directory needed — Electron creates its internals on first launch.
 *
 * Usage: node scripts/showcase/setup.js [--theme <id>] [--size <WxH>]
 * Or via: npm run dev:showcase [-- --theme <id> --size <WxH>]
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TARGET_DIR = '/tmp/maestro-showcase';
const DATA_DIR = path.join(__dirname, 'seed', 'data');

// --- Parse CLI args ---

function parseArg(name) {
	const idx = process.argv.indexOf(`--${name}`);
	return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : null;
}

const cliTheme = parseArg('theme');
const cliSize = parseArg('size');

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
	console.error('[showcase] Run: node scripts/showcase/generate-seed.js');
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
console.log(`[showcase] Replacing $CWD → ${REPO_ROOT}`);
replaceInFile(path.join(TARGET_DIR, 'maestro-sessions.json'), '$CWD', REPO_ROOT);
replaceInFile(path.join(TARGET_DIR, 'maestro-claude-session-origins.json'), '$CWD', REPO_ROOT);
replaceInFile(path.join(TARGET_DIR, 'maestro-agent-session-origins.json'), '$CWD', REPO_ROOT);

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
		console.error(`[showcase] ERROR: Invalid size format "${cliSize}". Use WxH (e.g., 1796x1151)`);
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

console.log('[showcase] Done. Ready to launch with MAESTRO_DEMO_DIR=/tmp/maestro-showcase');
