/**
 * Ratchet on the Cue engine's Electron coupling.
 *
 * The standalone Cue runner cannot import Electron, so every file that still
 * does is listed here. The list may shrink, never grow: a new entry means the
 * engine just became harder to run without the desktop app.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const CUE_DIR = path.join(__dirname, '../../../main/cue');

/** Files that still reach for Electron, and why. Shrink this, never grow it. */
const KNOWN_ELECTRON_IMPORTERS = [
	'backup/cue-backup-manager.ts', // app.getPath for the backup directory
	'cue-auth-detector.ts', // type-only: BrowserWindow for the re-auth prompt
	'cue-notify-bridge.ts', // BrowserWindow for toast delivery
	'cue-notify-executor.ts', // BrowserWindow for toast delivery
];

function walk(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) return walk(full);
		return entry.name.endsWith('.ts') ? [full] : [];
	});
}

describe('Cue engine Electron coupling', () => {
	// Covers both quote styles, `require`, and a dynamic `import()`, so the
	// ratchet cannot be stepped around by changing the syntax.
	// The trailing `(?:\/[^'"]*)?` catches subpath imports like `electron/main`,
	// which the bare form would let through.
	const ELECTRON_REF = /(?:from|require\(|import\()\s*['"]electron(?:\/[^'"]*)?['"]/;

	const importers = walk(CUE_DIR)
		.filter((file) => ELECTRON_REF.test(fs.readFileSync(file, 'utf-8')))
		.map((file) => path.relative(CUE_DIR, file))
		.sort();

	it('has no Electron importer outside the known list', () => {
		expect(importers).toEqual([...KNOWN_ELECTRON_IMPORTERS].sort());
	});

	it('resolves its data directory without Electron', () => {
		for (const file of ['cue-db.ts', 'pipeline-layout-store.ts']) {
			const source = fs.readFileSync(path.join(CUE_DIR, file), 'utf-8');
			expect(source).not.toMatch(/app\.getPath\(/);
			expect(source).toMatch(/resolveUserDataDir/);
		}
	});
});
