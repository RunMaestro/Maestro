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
	});

	it('formats set sizes through the shared formatter', () => {
		expect(formatModelSetSize('hands-free-local')).toBe(
			formatSize(MODEL_SETS['hands-free-local'].bytes)
		);
	});

	it('returns set entries in catalog order', () => {
		const ids = getModelSetEntries('hands-free-local').map((entry) => entry.id);
		const catalogOrder = VOICE_MODEL_CATALOG.map((entry) => entry.id).filter((id) =>
			ids.includes(id)
		);
		expect(ids).toEqual(catalogOrder);
	});

	it('bundles exactly the models the local trio can run', () => {
		// The recogniser and the wake word. The voice is the system's own and the
		// router is built in, so neither downloads anything.
		expect([...MODEL_SETS['hands-free-local'].modelIds].sort()).toEqual(
			[WHISPER_BASE_EN_ID, OPENWAKEWORD_BASE_ID].sort()
		);
	});

	it('never bundles a model nothing in this build can read', () => {
		// Kokoro and Qwen3 stay in the catalog so an existing download can be seen
		// and removed, but a bundle that fetched them would fetch weights that no
		// provider can open.
		for (const id of [KOKORO_82M_ID, QWEN3_1_7B_ID]) {
			expect(getVoiceModel(id)?.pending).toEqual(expect.any(String));
			for (const set of Object.values(MODEL_SETS)) expect(set.modelIds).not.toContain(id);
		}
		for (const id of [WHISPER_BASE_EN_ID, OPENWAKEWORD_BASE_ID]) {
			expect(getVoiceModel(id)?.pending).toBeUndefined();
		}
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
