/**
 * Tests for modal priority constants
 *
 * These tests ensure that modal priorities are correctly ordered to guarantee
 * that child modals (opened from within parent modals) always have higher
 * priority than their parents. This is critical for proper Escape key handling.
 */

import { describe, it, expect } from 'vitest';
import { MODAL_PRIORITIES } from '../../../renderer/constants/modalPriorities';

describe('modalPriorities', () => {
	describe('child modal priority ordering', () => {
		/**
		 * When a modal opens another modal, the child must have higher priority
		 * so that pressing Escape closes the child first, not the parent.
		 */

		it('DOCUMENT_SELECTOR should have higher priority than BATCH_RUNNER (opens from within)', () => {
			// DocumentSelectorModal opens from BatchRunnerModal via "+ Add Docs" button
			expect(MODAL_PRIORITIES.DOCUMENT_SELECTOR).toBeGreaterThan(MODAL_PRIORITIES.BATCH_RUNNER);
		});

		it('MARKETPLACE should have higher priority than BATCH_RUNNER (opens from within)', () => {
			// MarketplaceModal (Playbook Exchange) opens from BatchRunnerModal
			expect(MODAL_PRIORITIES.MARKETPLACE).toBeGreaterThan(MODAL_PRIORITIES.BATCH_RUNNER);
		});

		it('MARKETPLACE should have higher priority than AUTORUN_EXPANDED (opens from within)', () => {
			// MarketplaceModal can also open from AutoRunExpandedModal
			expect(MODAL_PRIORITIES.MARKETPLACE).toBeGreaterThan(MODAL_PRIORITIES.AUTORUN_EXPANDED);
		});

		it('AGENT_PROMPT_COMPOSER should have higher priority than BATCH_RUNNER (opens from within)', () => {
			// AgentPromptComposerModal opens from BatchRunnerModal
			expect(MODAL_PRIORITIES.AGENT_PROMPT_COMPOSER).toBeGreaterThan(MODAL_PRIORITIES.BATCH_RUNNER);
		});

		it('PLAYBOOK_DELETE_CONFIRM should have higher priority than BATCH_RUNNER (opens from within)', () => {
			// PlaybookDeleteConfirmModal opens from BatchRunnerModal
			expect(MODAL_PRIORITIES.PLAYBOOK_DELETE_CONFIRM).toBeGreaterThan(
				MODAL_PRIORITIES.BATCH_RUNNER
			);
		});

		it('PLAYBOOK_NAME should have higher priority than BATCH_RUNNER (opens from within)', () => {
			// PlaybookNameModal opens from BatchRunnerModal
			expect(MODAL_PRIORITIES.PLAYBOOK_NAME).toBeGreaterThan(MODAL_PRIORITIES.BATCH_RUNNER);
		});

		it('AUTORUN_LIGHTBOX should have higher priority than AUTORUN_EXPANDED (opens from within)', () => {
			// AutoRunLightbox opens from AutoRunExpandedModal
			expect(MODAL_PRIORITIES.AUTORUN_LIGHTBOX).toBeGreaterThan(MODAL_PRIORITIES.AUTORUN_EXPANDED);
		});

		it('AUTORUN_RESET_TASKS should have higher priority than AUTORUN_EXPANDED (opens from within)', () => {
			// Reset tasks confirmation opens from AutoRunExpandedModal
			expect(MODAL_PRIORITIES.AUTORUN_RESET_TASKS).toBeGreaterThan(
				MODAL_PRIORITIES.AUTORUN_EXPANDED
			);
		});

		it('SYMPHONY_AGENT_CREATION should have higher priority than SYMPHONY (opens from within)', () => {
			// Agent creation dialog opens from SymphonyModal
			expect(MODAL_PRIORITIES.SYMPHONY_AGENT_CREATION).toBeGreaterThan(MODAL_PRIORITIES.SYMPHONY);
		});

		it('WIZARD_EXIT_CONFIRM should have higher priority than WIZARD (opens from within)', () => {
			// Exit confirmation opens from WizardModal
			expect(MODAL_PRIORITIES.WIZARD_EXIT_CONFIRM).toBeGreaterThan(MODAL_PRIORITIES.WIZARD);
		});

		it('WIZARD_RESUME should have higher priority than WIZARD (opens from within)', () => {
			// Resume dialog opens from WizardModal
			expect(MODAL_PRIORITIES.WIZARD_RESUME).toBeGreaterThan(MODAL_PRIORITIES.WIZARD);
		});

		it('EXISTING_AUTORUN_DOCS should have higher priority than WIZARD (opens from within)', () => {
			// Existing docs modal opens from WizardModal
			expect(MODAL_PRIORITIES.EXISTING_AUTORUN_DOCS).toBeGreaterThan(MODAL_PRIORITIES.WIZARD);
		});

		it('INLINE_WIZARD_EXIT_CONFIRM should have higher priority than WIZARD_MODE_PROMPT', () => {
			// Inline wizard exit confirm should close before mode prompt
			expect(MODAL_PRIORITIES.INLINE_WIZARD_EXIT_CONFIRM).toBeGreaterThan(
				MODAL_PRIORITIES.WIZARD_MODE_PROMPT
			);
		});

		it('SSH_REMOTE should have higher priority than SETTINGS (opens from within)', () => {
			// SSH Remote config opens from Settings modal
			expect(MODAL_PRIORITIES.SSH_REMOTE).toBeGreaterThan(MODAL_PRIORITIES.SETTINGS);
		});

		it('TERMINAL_TAB_RENAME should sit with rename modal priorities', () => {
			expect(MODAL_PRIORITIES.TERMINAL_TAB_RENAME).toBeLessThan(MODAL_PRIORITIES.RENAME_TAB);
			expect(MODAL_PRIORITIES.TERMINAL_TAB_RENAME).toBeGreaterThan(MODAL_PRIORITIES.RENAME_GROUP);
		});
	});

	describe('confirmation dialog priorities', () => {
		/**
		 * Confirmation dialogs should always have high priority to ensure
		 * they are closed first and block interaction with underlying modals.
		 */

		it('CONFIRM should be in the highest priority range (1000+)', () => {
			expect(MODAL_PRIORITIES.CONFIRM).toBeGreaterThanOrEqual(1000);
		});

		it('QUIT_CONFIRM should be in the highest priority range (1000+)', () => {
			expect(MODAL_PRIORITIES.QUIT_CONFIRM).toBeGreaterThanOrEqual(1000);
		});

		it('AGENT_ERROR should be in the highest priority range (1000+)', () => {
			expect(MODAL_PRIORITIES.AGENT_ERROR).toBeGreaterThanOrEqual(1000);
		});
	});

	describe('overlay priorities', () => {
		/**
		 * Overlays and previews should generally have lower priorities
		 * than modals to allow modals to take precedence.
		 */

		it('FILE_PREVIEW should have lower priority than most modals', () => {
			expect(MODAL_PRIORITIES.FILE_PREVIEW).toBeLessThan(MODAL_PRIORITIES.SETTINGS);
		});

		it('LIGHTBOX should have lower priority than most modals', () => {
			expect(MODAL_PRIORITIES.LIGHTBOX).toBeLessThan(MODAL_PRIORITIES.SETTINGS);
		});

		it('SLASH_AUTOCOMPLETE and FILE_TREE_FILTER should have very low priorities', () => {
			// These should be at the bottom of the priority range
			expect(MODAL_PRIORITIES.SLASH_AUTOCOMPLETE).toBeLessThanOrEqual(100);
			expect(MODAL_PRIORITIES.FILE_TREE_FILTER).toBeLessThanOrEqual(100);
		});
	});

	describe('tour and celebration priorities', () => {
		/**
		 * Tours and celebrations should have very high priority to ensure
		 * they are visible above other modals.
		 */

		it('TOUR should have higher priority than WIZARD', () => {
			expect(MODAL_PRIORITIES.TOUR).toBeGreaterThan(MODAL_PRIORITIES.WIZARD);
		});

		it('STANDING_OVATION should have very high priority', () => {
			expect(MODAL_PRIORITIES.STANDING_OVATION).toBeGreaterThan(1000);
		});

		it('KEYBOARD_MASTERY should have very high priority', () => {
			expect(MODAL_PRIORITIES.KEYBOARD_MASTERY).toBeGreaterThan(1000);
		});
	});

	describe('priority uniqueness', () => {
		/**
		 * While not strictly required, having unique priorities helps
		 * ensure deterministic ordering.
		 */

		it('should have mostly unique priority values', () => {
			const allPriorities = Object.values(MODAL_PRIORITIES);
			const uniquePriorities = new Set(allPriorities);

			// Allow some duplicates but flag if there are many
			const duplicateCount = allPriorities.length - uniquePriorities.size;
			expect(duplicateCount).toBeLessThan(5); // Allow up to 4 duplicates
		});
	});

	describe('priority ranges', () => {
		/**
		 * Priorities should fall within documented ranges for their category.
		 */

		it('all priorities should be positive integers', () => {
			Object.entries(MODAL_PRIORITIES).forEach(([name, priority]) => {
				expect(Number.isInteger(priority)).toBe(true);
				expect(priority).toBeGreaterThan(0);
			});
		});

		it('critical modals should be 1000+', () => {
			expect(MODAL_PRIORITIES.CONFIRM).toBeGreaterThanOrEqual(1000);
			expect(MODAL_PRIORITIES.QUIT_CONFIRM).toBeGreaterThanOrEqual(1000);
			expect(MODAL_PRIORITIES.AGENT_ERROR).toBeGreaterThanOrEqual(1000);
		});

		it('standard modals should be in 700-999 range', () => {
			expect(MODAL_PRIORITIES.BATCH_RUNNER).toBeGreaterThanOrEqual(700);
			expect(MODAL_PRIORITIES.BATCH_RUNNER).toBeLessThan(1000);

			expect(MODAL_PRIORITIES.NEW_INSTANCE).toBeGreaterThanOrEqual(700);
			expect(MODAL_PRIORITIES.NEW_INSTANCE).toBeLessThan(1000);
		});

		it('settings and info modals should be in 400-699 range', () => {
			expect(MODAL_PRIORITIES.SETTINGS).toBeGreaterThanOrEqual(400);
			expect(MODAL_PRIORITIES.SETTINGS).toBeLessThan(700);

			expect(MODAL_PRIORITIES.ABOUT).toBeGreaterThanOrEqual(400);
			expect(MODAL_PRIORITIES.ABOUT).toBeLessThan(700);
		});

		it('overlays and previews should be in 100-399 range', () => {
			expect(MODAL_PRIORITIES.FILE_PREVIEW).toBeGreaterThanOrEqual(100);
			expect(MODAL_PRIORITIES.FILE_PREVIEW).toBeLessThan(400);

			expect(MODAL_PRIORITIES.LIGHTBOX).toBeGreaterThanOrEqual(100);
			expect(MODAL_PRIORITIES.LIGHTBOX).toBeLessThan(400);
		});

		it('autocomplete should be in 1-99 range', () => {
			expect(MODAL_PRIORITIES.SLASH_AUTOCOMPLETE).toBeGreaterThanOrEqual(1);
			expect(MODAL_PRIORITIES.SLASH_AUTOCOMPLETE).toBeLessThan(100);
		});
	});
});
