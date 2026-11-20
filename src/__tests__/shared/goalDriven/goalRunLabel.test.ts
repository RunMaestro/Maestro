/**
 * Tests for the Goal-Driven stats/History label helpers.
 *
 * @file src/shared/goalDriven/goalRunLabel.ts
 */

import { describe, it, expect } from 'vitest';
import {
	GOAL_RUN_DOCUMENT_PREFIX,
	GOAL_RUN_LABEL_MAX_LENGTH,
	formatGoalRunDocumentPath,
	isGoalRunDocument,
	goalRunLabel,
} from '../../../shared/goalDriven/goalRunLabel';

describe('formatGoalRunDocumentPath', () => {
	it('prefixes a short goal with the Goal: marker', () => {
		expect(formatGoalRunDocumentPath('Migrate to Zustand')).toBe('Goal: Migrate to Zustand');
	});

	it('trims surrounding whitespace before prefixing', () => {
		expect(formatGoalRunDocumentPath('   Refactor auth   ')).toBe('Goal: Refactor auth');
	});

	it('clips a long goal to the max length with an ellipsis', () => {
		const longGoal = 'x'.repeat(GOAL_RUN_LABEL_MAX_LENGTH + 50);
		const result = formatGoalRunDocumentPath(longGoal);
		expect(result.startsWith(GOAL_RUN_DOCUMENT_PREFIX)).toBe(true);
		// Prefix + exactly GOAL_RUN_LABEL_MAX_LENGTH chars + the ellipsis.
		expect(result).toBe(`${GOAL_RUN_DOCUMENT_PREFIX}${'x'.repeat(GOAL_RUN_LABEL_MAX_LENGTH)}…`);
	});

	it('does not clip a goal exactly at the limit', () => {
		const exact = 'y'.repeat(GOAL_RUN_LABEL_MAX_LENGTH);
		expect(formatGoalRunDocumentPath(exact)).toBe(`${GOAL_RUN_DOCUMENT_PREFIX}${exact}`);
		expect(formatGoalRunDocumentPath(exact)).not.toContain('…');
	});
});

describe('isGoalRunDocument', () => {
	it('recognizes a formatted goal label', () => {
		expect(isGoalRunDocument(formatGoalRunDocumentPath('Ship it'))).toBe(true);
	});

	it('rejects a real document path', () => {
		expect(isGoalRunDocument('/Users/me/project/Phase-01.md')).toBe(false);
	});

	it('rejects null/undefined', () => {
		expect(isGoalRunDocument(undefined)).toBe(false);
		expect(isGoalRunDocument(null)).toBe(false);
	});
});

describe('goalRunLabel', () => {
	it('strips the prefix to recover the goal text', () => {
		expect(goalRunLabel('Goal: Migrate to Zustand')).toBe('Migrate to Zustand');
	});

	it('returns a document path unchanged', () => {
		expect(goalRunLabel('/Users/me/project/Phase-01.md')).toBe('/Users/me/project/Phase-01.md');
	});

	it('returns an empty string for null/undefined', () => {
		expect(goalRunLabel(undefined)).toBe('');
		expect(goalRunLabel(null)).toBe('');
	});

	it('round-trips with formatGoalRunDocumentPath for a short goal', () => {
		const goal = 'Add pagination to the user list';
		expect(goalRunLabel(formatGoalRunDocumentPath(goal))).toBe(goal);
	});
});
