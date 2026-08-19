/**
 * @file acappella-model-catalog.test.ts
 *
 * The catalog is a promise to the user about exactly which bytes will be
 * fetched. These tests guard the properties that make that promise checkable:
 * pinned revisions (never `main`), real 64-hex SHA-256s, computed totals, and a
 * frozen table nothing downstream can edit in place.
 */

import { describe, it, expect } from 'vitest';

import {
	KOKORO_82M_ID,
	MODEL_SETS,
	OPENWAKEWORD_BASE_ID,
	QWEN3_1_7B_ID,
	VOICE_MODEL_CATALOG,
	WHISPER_BASE_EN_ID,
	formatModelSetSize,
	getModelSetEntries,
	getVoiceModel,
	isVoiceModelId,
	sumModelBytes,
} from '../../shared/acappella/model-catalog';
import { formatSize } from '../../shared/formatters';

describe('voice model catalog', () => {
	it('contains the four models the phase specifies', () => {
		expect(VOICE_MODEL_CATALOG.map((entry) => entry.id).sort()).toEqual(
			[KOKORO_82M_ID, OPENWAKEWORD_BASE_ID, QWEN3_1_7B_ID, WHISPER_BASE_EN_ID].sort()
		);
	});

	it('pins every revision to a commit, never a moving ref', () => {
		for (const entry of VOICE_MODEL_CATALOG) {
			expect(entry.revision).toMatch(/^[0-9a-f]{40}$/);
			expect(entry.revision).not.toBe('main');
			for (const file of entry.files) {
				// A `/main/` URL would make the hash below meaningless: the bytes
				// behind it could change without the catalog knowing.
				expect(file.sourceUrl).toContain(`/resolve/${entry.revision}/`);
				expect(file.sourceUrl).not.toContain('/resolve/main/');
			}
		}
	});

	it('carries a real SHA-256 and a positive size for every file', () => {
		for (const entry of VOICE_MODEL_CATALOG) {
			expect(entry.files.length).toBeGreaterThan(0);
			for (const file of entry.files) {
				expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
				expect(file.bytes).toBeGreaterThan(0);
				// Relative, POSIX, and never escaping the install root.
				expect(file.path.startsWith('/')).toBe(false);
				expect(file.path).not.toContain('..');
				expect(file.path).not.toContain('\\');
			}
		}
	});

	it('names a license and a license URL for every model', () => {
		for (const entry of VOICE_MODEL_CATALOG) {
			expect(entry.license).toBeTruthy();
			expect(entry.licenseUrl).toMatch(/^https:\/\//);
			expect(entry.requiredFor).toBeTruthy();
		}
	});

	it('computes each model total from its files', () => {
		for (const entry of VOICE_MODEL_CATALOG) {
			expect(entry.bytes).toBe(entry.files.reduce((total, file) => total + file.bytes, 0));
		}
	});

	it('computes set totals rather than hard-coding them', () => {
		for (const set of Object.values(MODEL_SETS)) {
			expect(set.bytes).toBe(sumModelBytes(set.modelIds));
			expect(set.bytes).toBeGreaterThan(0);
		}
		// The fully-local set is the hands-free set plus the Brain, so it must be
		// strictly larger. A copy-paste that left both lists the same fails here.
		expect(MODEL_SETS['fully-local'].bytes).toBeGreaterThan(MODEL_SETS['hands-free-local'].bytes);
	});

	it('formats set sizes through the shared formatter', () => {
		expect(formatModelSetSize('fully-local')).toBe(formatSize(MODEL_SETS['fully-local'].bytes));
	});

	it('returns set entries in catalog order', () => {
		const ids = getModelSetEntries('fully-local').map((entry) => entry.id);
		expect(ids).toEqual(VOICE_MODEL_CATALOG.map((entry) => entry.id));
	});

	it('excludes the Brain from the hands-free set', () => {
		expect(MODEL_SETS['hands-free-local'].modelIds).not.toContain(QWEN3_1_7B_ID);
		expect(MODEL_SETS['hands-free-local'].modelIds).toContain(OPENWAKEWORD_BASE_ID);
	});

	it('is frozen all the way down', () => {
		expect(Object.isFrozen(VOICE_MODEL_CATALOG)).toBe(true);
		for (const entry of VOICE_MODEL_CATALOG) {
			expect(Object.isFrozen(entry)).toBe(true);
			expect(Object.isFrozen(entry.files)).toBe(true);
			for (const file of entry.files) expect(Object.isFrozen(file)).toBe(true);
		}
	});

	it('looks models up by id and rejects anything else', () => {
		expect(getVoiceModel(WHISPER_BASE_EN_ID)?.role).toBe('stt');
		expect(getVoiceModel('../../etc/passwd')).toBeUndefined();
		expect(isVoiceModelId(KOKORO_82M_ID)).toBe(true);
		expect(isVoiceModelId('nope')).toBe(false);
	});

	it('ignores unknown ids when summing', () => {
		expect(sumModelBytes(['nope'])).toBe(0);
		expect(sumModelBytes([WHISPER_BASE_EN_ID, 'nope'])).toBe(
			getVoiceModel(WHISPER_BASE_EN_ID)!.bytes
		);
	});
});
