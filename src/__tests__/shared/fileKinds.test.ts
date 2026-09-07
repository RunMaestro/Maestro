/**
 * Which files can be talked ABOUT.
 *
 * The three "Talk with Document" entry points all ask this one question, so a
 * file that hides the microphone in the Files panel must also hide it in the
 * preview toolbar and in the command palette.
 */

import { describe, it, expect } from 'vitest';
import { isTalkableDocumentPath } from '../../shared/fileKinds';

describe('isTalkableDocumentPath', () => {
	it('accepts prose, code, and config - anything with text in it', () => {
		expect(isTalkableDocumentPath('/repo/docs/system-overview.md')).toBe(true);
		expect(isTalkableDocumentPath('src/main/index.ts')).toBe(true);
		expect(isTalkableDocumentPath('.maestro/cue.yaml')).toBe(true);
		expect(isTalkableDocumentPath('Makefile')).toBe(true);
	});

	it('refuses images, including SVG, which the preview shows as a picture', () => {
		expect(isTalkableDocumentPath('docs/screenshots/left-bar.png')).toBe(false);
		expect(isTalkableDocumentPath('logo.SVG')).toBe(false);
	});

	it('refuses playable media, which has nothing to read', () => {
		expect(isTalkableDocumentPath('/Users/me/Scratch/notes.mp3')).toBe(false);
		expect(isTalkableDocumentPath('demo.mp4')).toBe(false);
	});

	it('refuses compiled binaries and archives', () => {
		expect(isTalkableDocumentPath('build/app.wasm')).toBe(false);
		expect(isTalkableDocumentPath('release.zip')).toBe(false);
		expect(isTalkableDocumentPath('cache.sqlite3')).toBe(false);
	});

	it('refuses parquet, which reaches the renderer as a marker, not as text', () => {
		// Deliberately not in BINARY_EXTENSIONS - putting it there would swap the
		// columnar viewer for an "Open Externally" card. Asked separately instead.
		expect(isTalkableDocumentPath('data/events.parquet')).toBe(false);
		expect(isTalkableDocumentPath('events.pq')).toBe(false);
	});

	it('refuses an empty path rather than opening a session about nothing', () => {
		expect(isTalkableDocumentPath('')).toBe(false);
	});
});
