/**
 * @file goalHandoff.test.ts
 * @description Tests for the Goal-Driven Auto Run iteration handoff helpers
 * (src/shared/goalDriven/goalHandoff.ts): blurb sanitization and the
 * {{PREDECESSOR_HANDOFF}} block formatting.
 */

import { describe, it, expect } from 'vitest';
import {
	GOAL_SYNOPSIS_REQUEST_PROMPT,
	MAX_HANDOFF_BLURB_LENGTH,
	sanitizeHandoffBlurb,
	formatPredecessorHandoff,
} from '../../../shared/goalDriven/goalHandoff';

describe('goalHandoff', () => {
	describe('GOAL_SYNOPSIS_REQUEST_PROMPT', () => {
		it('is a non-empty, forward-looking handoff request', () => {
			expect(GOAL_SYNOPSIS_REQUEST_PROMPT.length).toBeGreaterThan(0);
			expect(GOAL_SYNOPSIS_REQUEST_PROMPT.toLowerCase()).toContain('fresh');
			expect(GOAL_SYNOPSIS_REQUEST_PROMPT.toLowerCase()).toContain('handoff');
		});
	});

	describe('sanitizeHandoffBlurb', () => {
		it('returns empty string for nullish/blank input', () => {
			expect(sanitizeHandoffBlurb(undefined)).toBe('');
			expect(sanitizeHandoffBlurb(null)).toBe('');
			expect(sanitizeHandoffBlurb('   \n  ')).toBe('');
		});

		it('strips Maestro control markers and trims', () => {
			const raw = 'Data layer done.\n\n<!-- maestro:progress 60 | wip -->\n';
			const out = sanitizeHandoffBlurb(raw);
			expect(out).toBe('Data layer done.');
			expect(out).not.toContain('maestro:');
		});

		it('caps overly long blurbs and appends an ellipsis', () => {
			const long = 'x'.repeat(MAX_HANDOFF_BLURB_LENGTH + 500);
			const out = sanitizeHandoffBlurb(long);
			expect(out.length).toBeLessThanOrEqual(MAX_HANDOFF_BLURB_LENGTH + 1);
			expect(out.endsWith('…')).toBe(true);
		});
	});

	describe('formatPredecessorHandoff', () => {
		it('returns empty string when there is no predecessor note', () => {
			expect(formatPredecessorHandoff(undefined)).toBe('');
			expect(formatPredecessorHandoff(null)).toBe('');
			expect(formatPredecessorHandoff('   ')).toBe('');
		});

		it('renders a labeled, self-contained block carrying the note', () => {
			const block = formatPredecessorHandoff('Migrated the data layer; UI still pending.');
			expect(block).toContain('## Handoff From Your Predecessor');
			expect(block).toContain('Migrated the data layer; UI still pending.');
			// Leading separator so it reads as its own section in the prompt.
			expect(block.startsWith('---')).toBe(true);
		});
	});
});
