/**
 * Tests for shared/symphony-types.ts
 * Validates Symphony type definitions and the SymphonyError class.
 */

import { describe, it, expect } from 'vitest';
import {
	SymphonyError,
	type SymphonyErrorType,
	type SymphonyCategory,
	type SymphonyLabel,
	type SymphonyIssue,
	type SymphonyCache,
	type ContributionStatus,
	type IssueStatus,
} from '../../shared/symphony-types';

describe('shared/symphony-types', () => {
	// ==========================================================================
	// SymphonyError Class Tests
	// ==========================================================================
	describe('SymphonyError', () => {
		it('should set message correctly', () => {
			const error = new SymphonyError('Test error message', 'network');
			expect(error.message).toBe('Test error message');
		});

		it('should set type property', () => {
			const error = new SymphonyError('Test error', 'github_api');
			expect(error.type).toBe('github_api');
		});

		it('should set cause property', () => {
			const originalError = new Error('Original error');
			const error = new SymphonyError('Wrapped error', 'git', originalError);
			expect(error.cause).toBe(originalError);
		});

		it('should have name as "SymphonyError"', () => {
			const error = new SymphonyError('Test', 'network');
			expect(error.name).toBe('SymphonyError');
		});

		it('should be instanceof Error', () => {
			const error = new SymphonyError('Test', 'network');
			expect(error).toBeInstanceOf(Error);
		});

		it('should be instanceof SymphonyError', () => {
			const error = new SymphonyError('Test', 'network');
			expect(error).toBeInstanceOf(SymphonyError);
		});

		it('should work without cause parameter', () => {
			const error = new SymphonyError('No cause', 'parse');
			expect(error.cause).toBeUndefined();
		});

		it('should preserve stack trace', () => {
			const error = new SymphonyError('Test', 'network');
			expect(error.stack).toBeDefined();
			expect(error.stack).toContain('SymphonyError');
		});

		describe('error type values', () => {
			const errorTypes: SymphonyErrorType[] = [
				'network',
				'github_api',
				'git',
				'parse',
				'pr_creation',
				'autorun',
				'cancelled',
			];

			it.each(errorTypes)('should accept "%s" as a valid error type', (errorType) => {
				const error = new SymphonyError(`Error of type ${errorType}`, errorType);
				expect(error.type).toBe(errorType);
			});
		});
	});

	// ==========================================================================
	// Type Validation Tests (compile-time checks with runtime verification)
	// ==========================================================================
	describe('SymphonyCategory type', () => {
		it('should accept any string as a category (extensible via registry)', () => {
			const known: SymphonyCategory = 'ai-ml';
			const custom: SymphonyCategory = 'my-custom-category';
			expect(known).toBe('ai-ml');
			expect(custom).toBe('my-custom-category');
		});
	});

	describe('ContributionStatus type', () => {
		const validStatuses: ContributionStatus[] = [
			'cloning',
			'creating_pr',
			'running',
			'paused',
			'completed',
			'completing',
			'ready_for_review',
			'failed',
			'cancelled',
		];

		it.each(validStatuses)('should accept "%s" as a valid contribution status', (status) => {
			const testStatus: ContributionStatus = status;
			expect(testStatus).toBe(status);
		});

		it('should have 9 valid contribution statuses', () => {
			expect(validStatuses).toHaveLength(9);
		});
	});

	describe('IssueStatus type', () => {
		const validStatuses: IssueStatus[] = ['available', 'in_progress', 'completed'];

		it.each(validStatuses)('should accept "%s" as a valid issue status', (status) => {
			const testStatus: IssueStatus = status;
			expect(testStatus).toBe(status);
		});

		it('should have 3 valid issue statuses', () => {
			expect(validStatuses).toHaveLength(3);
		});
	});

	describe('SymphonyErrorType type', () => {
		const validErrorTypes: SymphonyErrorType[] = [
			'network',
			'github_api',
			'git',
			'parse',
			'pr_creation',
			'autorun',
			'cancelled',
		];

		it.each(validErrorTypes)('should accept "%s" as a valid error type', (errorType) => {
			const testErrorType: SymphonyErrorType = errorType;
			expect(testErrorType).toBe(errorType);
		});

		it('should have 7 valid error types', () => {
			expect(validErrorTypes).toHaveLength(7);
		});
	});

	// ==========================================================================
	// SymphonyLabel Type Tests
	// ==========================================================================
	describe('SymphonyLabel type', () => {
		it('should accept valid label objects', () => {
			const label: SymphonyLabel = { name: 'blocking', color: 'e4e669' };
			expect(label.name).toBe('blocking');
			expect(label.color).toBe('e4e669');
		});
	});

	// ==========================================================================
	// SymphonyIssue labels field Tests
	// ==========================================================================
	describe('SymphonyIssue labels field', () => {
		it('should include labels in issue interface', () => {
			const issue: SymphonyIssue = {
				number: 1,
				title: 'Test',
				body: '',
				url: 'https://api.github.com/repos/owner/repo/issues/1',
				htmlUrl: 'https://github.com/owner/repo/issues/1',
				author: 'user',
				createdAt: '2024-01-01',
				updatedAt: '2024-01-01',
				documentPaths: [],
				labels: [{ name: 'blocking', color: 'e4e669' }],
				status: 'available',
			};
			expect(issue.labels).toHaveLength(1);
			expect(issue.labels[0].name).toBe('blocking');
		});

		it('should allow empty labels array', () => {
			const issue: SymphonyIssue = {
				number: 2,
				title: 'No labels',
				body: '',
				url: 'https://api.github.com/repos/owner/repo/issues/2',
				htmlUrl: 'https://github.com/owner/repo/issues/2',
				author: 'user',
				createdAt: '2024-01-01',
				updatedAt: '2024-01-01',
				documentPaths: [],
				labels: [],
				status: 'available',
			};
			expect(issue.labels).toEqual([]);
		});
	});

	// ==========================================================================
	// SymphonyCache Type Tests
	// ==========================================================================
	describe('SymphonyCache type', () => {
		it('should allow issueCounts field to be omitted (optional)', () => {
			const cache: SymphonyCache = { issues: {} };
			expect(cache.issueCounts).toBeUndefined();
		});

		it('should accept issueCounts with data, fetchedAt, and repoSlugs', () => {
			const cache: SymphonyCache = {
				issues: {},
				issueCounts: {
					data: { 'owner/repo': 5, 'owner/other': 0 },
					fetchedAt: 1700000000000,
					repoSlugs: ['owner/other', 'owner/repo'],
				},
			};
			expect(cache.issueCounts?.data['owner/repo']).toBe(5);
			expect(cache.issueCounts?.data['owner/other']).toBe(0);
			expect(cache.issueCounts?.fetchedAt).toBe(1700000000000);
			expect(cache.issueCounts?.repoSlugs).toEqual(['owner/other', 'owner/repo']);
		});
	});
});
