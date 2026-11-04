/**
 * Tests for wizardIntentParser service
 *
 * Tests the natural language intent parsing for the inline wizard command.
 */

import { describe, it, expect } from 'vitest';
import {
	parseWizardIntent,
	suggestsIterateIntent,
	suggestsNewIntent,
} from '../../../renderer/services/wizardIntentParser';

describe('wizardIntentParser', () => {
	describe('parseWizardIntent', () => {
		describe('empty input handling', () => {
			it('returns ask mode when input is empty and docs exist', () => {
				const result = parseWizardIntent('', true);
				expect(result.mode).toBe('ask');
				expect(result.goal).toBeUndefined();
			});

			it('returns new mode when input is empty and no docs exist', () => {
				const result = parseWizardIntent('', false);
				expect(result.mode).toBe('new');
				expect(result.goal).toBeUndefined();
			});

			it('handles whitespace-only input as empty', () => {
				const result = parseWizardIntent('   ', true);
				expect(result.mode).toBe('ask');
			});
		});

		describe('new mode keywords', () => {
			const newModeKeywords = [
				'new',
				'fresh',
				'start',
				'create',
				'begin',
				'scratch',
				'start over',
				'start fresh',
				'start new',
				'from scratch',
				'new project',
				'fresh start',
				'reset',
				'clear',
				'blank',
			];

			it.each(newModeKeywords)('detects "%s" as new mode', (keyword) => {
				const result = parseWizardIntent(keyword, true);
				expect(result.mode).toBe('new');
			});

			it('handles uppercase input', () => {
				const result = parseWizardIntent('NEW', true);
				expect(result.mode).toBe('new');
			});

			it('handles mixed case input', () => {
				const result = parseWizardIntent('Start Fresh', true);
				expect(result.mode).toBe('new');
			});
		});

		describe('iterate mode keywords', () => {
			const iterateModeKeywords = [
				'continue',
				'iterate',
				'add',
				'update',
				'modify',
				'extend',
				'expand',
				'change',
				'edit',
				'append',
				'include',
				'enhance',
				'improve',
				'refine',
				'augment',
				'adjust',
				'revise',
				'next',
				'next phase',
				'more',
				'additional',
				'another',
			];

			it.each(iterateModeKeywords)('detects "%s" as iterate mode', (keyword) => {
				const result = parseWizardIntent(keyword, true);
				expect(result.mode).toBe('iterate');
			});

			it('handles uppercase input', () => {
				const result = parseWizardIntent('ADD', true);
				expect(result.mode).toBe('iterate');
			});
		});

		describe('goal extraction', () => {
			it('extracts goal from "add authentication feature"', () => {
				const result = parseWizardIntent('add authentication feature', true);
				expect(result.mode).toBe('iterate');
				expect(result.goal).toBe('authentication feature');
			});

			it('extracts goal from "update the login flow"', () => {
				const result = parseWizardIntent('update the login flow', true);
				expect(result.mode).toBe('iterate');
				expect(result.goal).toBe('the login flow');
			});

			it('extracts goal from "continue with database integration"', () => {
				const result = parseWizardIntent('continue with database integration', true);
				expect(result.mode).toBe('iterate');
				expect(result.goal).toBe('with database integration');
			});

			it('uses full input as goal when keyword is the only content', () => {
				const result = parseWizardIntent('add', true);
				expect(result.mode).toBe('iterate');
				expect(result.goal).toBe('add');
			});

			it('preserves original casing in goal', () => {
				const result = parseWizardIntent('Add OAuth Integration', true);
				expect(result.mode).toBe('iterate');
				expect(result.goal).toBe('OAuth Integration');
			});
		});

		describe('ambiguous input', () => {
			it('returns ask mode for ambiguous input with existing docs', () => {
				const result = parseWizardIntent('authentication feature', true);
				expect(result.mode).toBe('ask');
			});

			it('returns new mode for ambiguous input without existing docs', () => {
				const result = parseWizardIntent('authentication feature', false);
				expect(result.mode).toBe('new');
			});

			it('returns ask mode for unrecognized verb with existing docs', () => {
				const result = parseWizardIntent('implement user profiles', true);
				expect(result.mode).toBe('ask');
			});
		});

		describe('keyword matching anywhere in input', () => {
			it('detects new keyword in middle of sentence', () => {
				const result = parseWizardIntent('I want a new project', true);
				expect(result.mode).toBe('new');
			});

			it('detects iterate keyword in middle of sentence', () => {
				const result = parseWizardIntent('please add a feature', true);
				expect(result.mode).toBe('iterate');
			});
		});

		describe('edge cases', () => {
			it('handles extra whitespace', () => {
				const result = parseWizardIntent('  add   feature  ', true);
				expect(result.mode).toBe('iterate');
			});

			it('handles special characters in goal', () => {
				const result = parseWizardIntent('add OAuth2.0 support', true);
				expect(result.mode).toBe('iterate');
				expect(result.goal).toBe('OAuth2.0 support');
			});
		});
	});

	describe('suggestsIterateIntent', () => {
		it('detects "I want to add" pattern', () => {
			expect(suggestsIterateIntent('i want to add something')).toBe(true);
		});

		it('detects "add a new" pattern', () => {
			expect(suggestsIterateIntent('add a new feature')).toBe(true);
		});

		it('detects "can you add" pattern', () => {
			expect(suggestsIterateIntent('can you add something')).toBe(true);
		});

		it('detects "lets add" pattern', () => {
			expect(suggestsIterateIntent("let's add more")).toBe(true);
		});

		it('detects "additionally" pattern', () => {
			expect(suggestsIterateIntent('additionally we need')).toBe(true);
		});

		it('detects "next lets" pattern', () => {
			expect(suggestsIterateIntent("next let's add")).toBe(true);
		});

		it('returns false for unrelated input', () => {
			expect(suggestsIterateIntent('build a spaceship')).toBe(false);
		});
	});

	describe('suggestsNewIntent', () => {
		it('detects "start from scratch" pattern', () => {
			expect(suggestsNewIntent('start from scratch')).toBe(true);
		});

		it('detects "lets start fresh" pattern', () => {
			expect(suggestsNewIntent("let's start fresh")).toBe(true);
		});

		it('detects "forget the existing" pattern', () => {
			expect(suggestsNewIntent('forget the existing docs')).toBe(true);
		});

		it('detects "new project" pattern', () => {
			expect(suggestsNewIntent('new project for auth')).toBe(true);
		});

		it('detects "create a new" pattern', () => {
			expect(suggestsNewIntent('create a new plan')).toBe(true);
		});

		it('returns false for unrelated input', () => {
			expect(suggestsNewIntent('build a spaceship')).toBe(false);
		});
	});
});
