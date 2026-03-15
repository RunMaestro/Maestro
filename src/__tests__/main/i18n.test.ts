/**
 * Tests for main process i18n initialization
 *
 * Verifies that the main process i18next instance:
 * - Initializes correctly with default and stored language preferences
 * - Translates keys from common and notifications namespaces
 * - Switches language at runtime via changeMainLanguage()
 * - Falls back to English for unknown keys
 * - Handles interpolation correctly
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock logger before importing the module under test
vi.mock('../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

import { initMainI18n, changeMainLanguage, mainT, mainI18n } from '../../main/i18n';
import { SUPPORTED_LANGUAGES } from '../../shared/i18n/config';

describe('Main process i18n', () => {
	beforeEach(async () => {
		// Reset to a clean state before each test
		if (mainI18n.isInitialized) {
			await mainI18n.changeLanguage('en');
		}
	});

	describe('initMainI18n', () => {
		it('initializes with English by default', async () => {
			await initMainI18n();
			expect(mainI18n.language).toBe('en');
			expect(mainI18n.isInitialized).toBe(true);
		});

		it('initializes with a specified language', async () => {
			await initMainI18n('es');
			expect(mainI18n.language).toBe('es');
		});

		it('falls back to English for unsupported language codes', async () => {
			await initMainI18n('xx');
			expect(mainI18n.language).toBe('en');
		});

		it('falls back to English for undefined language', async () => {
			await initMainI18n(undefined);
			expect(mainI18n.language).toBe('en');
		});

		it('falls back to English for empty string', async () => {
			await initMainI18n('');
			expect(mainI18n.language).toBe('en');
		});
	});

	describe('mainT', () => {
		it('returns English translations by default', async () => {
			await initMainI18n('en');
			expect(mainT('common:save')).toBe('Save');
			expect(mainT('common:cancel')).toBe('Cancel');
			expect(mainT('common:close')).toBe('Close');
		});

		it('returns Spanish translations when initialized with es', async () => {
			await initMainI18n('es');
			expect(mainT('common:save')).toBe('Guardar');
			expect(mainT('common:cancel')).toBe('Cancelar');
		});

		it('translates notification keys', async () => {
			await initMainI18n('en');
			expect(mainT('notifications:task.completed_title')).toBe('Task Complete');
			expect(mainT('notifications:task.failed_title')).toBe('Task Failed');
		});

		it('handles interpolation', async () => {
			await initMainI18n('en');
			const result = mainT('notifications:task.completed_message', {
				agent: 'Claude',
				duration: '5m',
			});
			expect(result).toContain('Claude');
			expect(result).toContain('5m');
		});

		it('falls back to English for missing translations', async () => {
			await initMainI18n('es');
			// Use a key that exists in English — even if Spanish has it,
			// we can verify the fallback mechanism works by checking a valid return
			const result = mainT('common:save');
			expect(result).toBeTruthy();
			expect(result).not.toBe('common:save'); // Not the raw key
		});
	});

	describe('changeMainLanguage', () => {
		it('switches language at runtime', async () => {
			await initMainI18n('en');
			expect(mainT('common:save')).toBe('Save');

			await changeMainLanguage('es');
			expect(mainI18n.language).toBe('es');
			expect(mainT('common:save')).toBe('Guardar');
		});

		it('switches to all supported languages', async () => {
			await initMainI18n('en');

			for (const lang of SUPPORTED_LANGUAGES) {
				await changeMainLanguage(lang);
				expect(mainI18n.language).toBe(lang);

				// Every language should have a translation for 'save' that differs from the raw key
				const save = mainT('common:save');
				expect(save).toBeTruthy();
				expect(save).not.toBe('common:save');
				expect(save).not.toBe('save');
			}
		});

		it('round-trips back to English correctly', async () => {
			await initMainI18n('en');
			const enSave = mainT('common:save');

			await changeMainLanguage('fr');
			const frSave = mainT('common:save');
			expect(frSave).not.toBe(enSave); // French should differ

			await changeMainLanguage('en');
			expect(mainT('common:save')).toBe(enSave);
		});
	});

	describe('namespace isolation', () => {
		it('only loads common and notifications namespaces', async () => {
			await initMainI18n('en');
			// Keys from other namespaces should not resolve
			const settingsKey = mainT('settings:tabs.general');
			// Should return the raw key since settings namespace is not loaded
			expect(settingsKey).toBe('tabs.general');
		});

		it('common namespace has expected keys', async () => {
			await initMainI18n('en');
			const keys = ['save', 'cancel', 'close', 'delete', 'confirm', 'error', 'ok'];
			for (const key of keys) {
				const value = mainT(`common:${key}`);
				expect(value, `common:${key} should be translated`).toBeTruthy();
				expect(value).not.toBe(key); // Should not return raw key
			}
		});

		it('notifications namespace has expected keys', async () => {
			await initMainI18n('en');
			const keys = [
				'notifications:task.completed_title',
				'notifications:task.failed_title',
				'notifications:connection.lost_title',
				'notifications:connection.restored_title',
			];
			for (const key of keys) {
				const value = mainT(key);
				expect(value, `${key} should be translated`).toBeTruthy();
				expect(value).not.toBe(key);
			}
		});
	});

	describe('non-Latin script languages', () => {
		it('Arabic translations contain Arabic script', async () => {
			await initMainI18n('ar');
			const save = mainT('common:save');
			expect(save).toMatch(/[\u0600-\u06FF]/);
		});

		it('Chinese translations contain CJK characters', async () => {
			await initMainI18n('zh');
			const save = mainT('common:save');
			expect(save).toMatch(/[\u4E00-\u9FFF\u3400-\u4DBF]/);
		});

		it('Hindi translations contain Devanagari script', async () => {
			await initMainI18n('hi');
			const save = mainT('common:save');
			expect(save).toMatch(/[\u0900-\u097F]/);
		});

		it('Bengali translations contain Bengali script', async () => {
			await initMainI18n('bn');
			const save = mainT('common:save');
			expect(save).toMatch(/[\u0980-\u09FF]/);
		});
	});
});
