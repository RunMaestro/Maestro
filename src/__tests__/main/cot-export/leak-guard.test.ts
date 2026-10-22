/**
 * The leak guard of the chain of thought export.
 *
 * WHAT IT PROVES
 * Nothing an agent or a new contributor reads to learn how Maestro works
 * mentions the export: not the docs, not the prompts, not the CLI source, not
 * the guides, not the surfaces a person opens by keyboard, palette, or menu.
 *
 * WHY
 * The feature records an agent's own reasoning, and only a person at the
 * desktop app may turn it on. A page that explains it, a CLI verb that
 * drives it, or a prompt that names it hands the agent a way to find it, or
 * hands a helpful contributor the idea that it belongs beside every other
 * setting. The standing guides ask for exactly that (a hotkey, a palette
 * entry, a menu item, a `UI_SURFACES` entry, a CLI verb, a docs page), and
 * this test is what stops them being followed here.
 *
 * HOW
 * Every file under the paths in `WALKED` is read line by line. A line that
 * matches any pattern in `FORBIDDEN` fails the test, and the failure names
 * the file and the line.
 *
 * The test reads files and nothing else. It runs no app code.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

// ============================================================================
// The rule: the patterns, and the paths they are held against
// ============================================================================

/**
 * What no walked file may contain. The search ignores case.
 *
 * The person sees the feature as the "Audit Log". "audit log" alone is not
 * forbidden: the docs and the CLI use it for Pianola and for git history. Only
 * the phrasings that tie an audit log to an agent are.
 */
const FORBIDDEN =
	/cot[-_ ]?export|chain[- ]of[- ]thought export|cotExport|maestro[-.]device-state|keep an audit log|per[- ]agent audit log|audit log (for|of) (this|an?|each|every|the) agent|audit log section/i;

/**
 * Where an agent or a contributor would look, relative to the repo root. A
 * folder is walked at any depth. `CLAUDE*.md` is every file at the root with
 * that shape.
 */
const WALKED = {
	folders: [
		'docs',
		'docs/agent-guides',
		'src/prompts',
		'src/cli',
		'src/renderer/components/QuickActionsModal',
	],
	files: [
		'src/shared/uiSurfaces.ts',
		'src/renderer/constants/shortcuts.ts',
		// The hamburger menu content component.
		'src/renderer/components/SessionList/HamburgerMenuContent.tsx',
	],
	rootFilePattern: /^CLAUDE.*\.md$/,
	/**
	 * The settings search registry. `searchableSettings.ts` only gathers the
	 * entries; they are written in the files beside it, one per settings tab.
	 */
	settingsSearch: {
		folder: 'src/renderer/components/Settings',
		filePattern: /^searchableSettings.*\.ts$/,
	},
} as const;

/** Folders that hold other people's code, or build output. They are not read. */
const SKIPPED_FOLDERS = new Set(['node_modules', '.git', 'dist', 'release']);

/** Files that are not text. They are not read. */
const BINARY_EXTENSIONS = new Set([
	'.png',
	'.jpg',
	'.jpeg',
	'.gif',
	'.webp',
	'.ico',
	'.icns',
	'.pdf',
	'.mp3',
	'.mp4',
	'.mov',
	'.webm',
	'.wav',
	'.zip',
	'.gz',
	'.woff',
	'.woff2',
	'.ttf',
	'.otf',
]);

const FAILURE_EXPLANATION = [
	'The chain of thought export is deliberately undocumented and hidden from agents.',
	'It has no docs page, no CLI verb, no prompt text, no hotkey, no palette entry, no menu item,',
	'no UI_SURFACES entry, and no entry in any guide. Only a person at the desktop app turns it on,',
	'in the Edit Agent dialog. Remove the mention below. Do not add an exception for it here.',
].join('\n');

// ============================================================================
// The walk
// ============================================================================

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');

/** Every file under `dir`, at any depth, skipping folders that are not ours. */
function filesUnder(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) return SKIPPED_FOLDERS.has(entry.name) ? [] : filesUnder(full);
		return entry.isFile() ? [full] : [];
	});
}

/** Every file the rule is held against, as absolute paths, each once. */
function walkedFiles(root: string): string[] {
	const found = new Set<string>();
	for (const folder of WALKED.folders) {
		for (const file of filesUnder(path.join(root, folder))) found.add(file);
	}
	for (const file of WALKED.files) found.add(path.join(root, file));
	const settingsDir = path.join(root, WALKED.settingsSearch.folder);
	for (const entry of fs.readdirSync(settingsDir, { withFileTypes: true })) {
		if (entry.isFile() && WALKED.settingsSearch.filePattern.test(entry.name)) {
			found.add(path.join(settingsDir, entry.name));
		}
	}
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		if (entry.isFile() && WALKED.rootFilePattern.test(entry.name)) {
			found.add(path.join(root, entry.name));
		}
	}
	return [...found].sort();
}

/** Whether `file` is text worth reading. */
function isText(file: string, bytes: Buffer): boolean {
	if (BINARY_EXTENSIONS.has(path.extname(file).toLowerCase())) return false;
	// A NUL byte near the start is how a file says it is not text.
	return !bytes.subarray(0, 8000).includes(0);
}

interface Leak {
	file: string;
	line: number;
	text: string;
}

/** Every line of `content` that names the feature. */
function leaksIn(file: string, content: string): Leak[] {
	const leaks: Leak[] = [];
	content.split(/\r?\n/).forEach((text, index) => {
		if (FORBIDDEN.test(text)) leaks.push({ file, line: index + 1, text: text.trim() });
	});
	return leaks;
}

/** What to tell the person when a leak is found. */
function describeLeaks(leaks: Leak[]): string {
	const where = leaks
		.map((leak) => `  ${leak.file}:${leak.line}: ${leak.text.slice(0, 160)}`)
		.join('\n');
	return `${FAILURE_EXPLANATION}\n\nFound in:\n${where}`;
}

// ============================================================================
// The tests
// ============================================================================

describe('the rule', () => {
	it('matches every spelling of the feature', () => {
		for (const spelling of [
			'cot-export',
			'cot_export',
			'cot export',
			'cotexport',
			'COT-EXPORT',
			'cotExport:get',
			'getCotExportWriter',
			'Chain of Thought Export',
			'chain-of-thought export',
			'maestro-device-state.json',
			// The service name of the anchor in the OS credential store.
			'com.maestro.device-state',
			// The name the person sees in the Edit Agent dialog.
			'Keep an audit log for this agent',
			'The audit log of an agent is failing',
			'Turn on the per-agent audit log',
			'Open the Audit Log section of Edit Agent',
			"import x from '../cot-export/runtime'",
		]) {
			expect(FORBIDDEN.test(spelling), spelling).toBe(true);
		}
	});

	it('leaves ordinary text alone', () => {
		for (const text of [
			'Extended thinking shows the chain of thought in the transcript.',
			'Export the transcript as HTML.',
			'Settings are stored in maestro-settings.json.',
			'cost export',
			'Show recent Pianola decisions from the audit log',
			'**Git as audit log.** Every applied proposal is a commit.',
		]) {
			expect(FORBIDDEN.test(text), text).toBe(false);
		}
	});

	it('reports the file and the line of a mention', () => {
		const leaks = leaksIn('docs/x.md', 'first\nsecond\nsee the cot-export page\nfourth');
		expect(leaks).toEqual([{ file: 'docs/x.md', line: 3, text: 'see the cot-export page' }]);
		const message = describeLeaks(leaks);
		expect(message).toContain('deliberately undocumented and hidden from agents');
		expect(message).toContain('docs/x.md:3');
	});

	it('reads a line that ends in a carriage return', () => {
		expect(leaksIn('a.md', 'ok\r\ncotExport\r\n').map((leak) => leak.line)).toEqual([2]);
	});
});

describe('the walked paths', () => {
	it.each([...WALKED.folders])('has the folder %s', (folder) => {
		const full = path.join(ROOT, folder);
		// A path that was renamed would otherwise make this guard pass over nothing.
		expect(fs.existsSync(full), `${folder} is gone: update WALKED in this test`).toBe(true);
		expect(fs.statSync(full).isDirectory()).toBe(true);
		expect(filesUnder(full).length).toBeGreaterThan(0);
	});

	it.each([...WALKED.files])('has the file %s', (file) => {
		expect(
			fs.existsSync(path.join(ROOT, file)),
			`${file} is gone: update WALKED in this test`
		).toBe(true);
	});

	it('finds the settings search registry and the files its entries are written in', () => {
		const names = walkedFiles(ROOT)
			.map((file) => path.relative(ROOT, file))
			.filter((name) => WALKED.settingsSearch.filePattern.test(path.basename(name)));
		expect(names).toContain(path.join(WALKED.settingsSearch.folder, 'searchableSettings.ts'));
		// The aggregator alone holds no entry. A registry moved elsewhere would
		// otherwise leave this guard reading a file with nothing in it.
		expect(names.length).toBeGreaterThan(1);
	});

	it('finds the CLAUDE guides at the root', () => {
		const names = walkedFiles(ROOT).map((file) => path.relative(ROOT, file));
		expect(names).toContain('CLAUDE.md');
		expect(names.filter((name) => WALKED.rootFilePattern.test(name)).length).toBeGreaterThan(1);
	});
});

describe('the docs, prompts, CLI, guides, and surfaces an agent or a contributor reads', () => {
	it('never mention the chain of thought export', () => {
		const leaks: Leak[] = [];
		for (const file of walkedFiles(ROOT)) {
			const bytes = fs.readFileSync(file);
			if (!isText(file, bytes)) continue;
			leaks.push(...leaksIn(path.relative(ROOT, file), bytes.toString('utf8')));
		}
		expect(leaks, leaks.length > 0 ? describeLeaks(leaks) : undefined).toEqual([]);
	});
});
