/**
 * Which files can be talked ABOUT.
 *
 * The three "Talk with Document" entry points all ask this one question, so a
 * file that hides the microphone in the Files panel must also hide it in the
 * preview toolbar and in the command palette.
 */

import { describe, it, expect } from 'vitest';
import { isBinaryContent, isTalkableDocumentPath } from '../../shared/fileKinds';

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

describe('isBinaryContent', () => {
	it('detects null bytes as binary', () => {
		expect(isBinaryContent('hello\0world')).toBe(true);
	});

	it('finds a null byte past the sampled window', () => {
		expect(isBinaryContent('a'.repeat(20_000) + '\0')).toBe(true);
	});

	it('returns false for normal text', () => {
		expect(isBinaryContent('Hello, world!\nThis is text.')).toBe(false);
	});

	it('returns false for empty content', () => {
		expect(isBinaryContent('')).toBe(false);
	});

	it('allows common whitespace (tab, newline, vertical tab, form feed, carriage return)', () => {
		expect(isBinaryContent('hello\tworld\r\n\v\f')).toBe(false);
	});

	it('detects high non-printable ratio as binary', () => {
		// More than 10% non-printable characters
		const binary = String.fromCharCode(1).repeat(20) + 'a'.repeat(80);
		expect(isBinaryContent(binary)).toBe(true);
	});

	it('counts DEL and the C1 controls as non-printable', () => {
		expect(isBinaryContent(String.fromCharCode(127, 128, 159).repeat(10) + 'a'.repeat(30))).toBe(
			true
		);
	});

	it('allows low non-printable ratio as text', () => {
		// Less than 10% non-printable
		const almostText = String.fromCharCode(1).repeat(5) + 'a'.repeat(100);
		expect(isBinaryContent(almostText)).toBe(false);
	});

	it('judges only the first 8192 characters for the ratio', () => {
		const lateControls = 'a'.repeat(8192) + String.fromCharCode(1).repeat(8192);
		expect(isBinaryContent(lateControls)).toBe(false);
	});
});
