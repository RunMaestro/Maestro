/**
 * @file useWorktreeManager.test.ts
 * @description Tests for PR title and body generation in useWorktreeManager.
 */

import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useWorktreeManager } from '../../../../renderer/hooks/batch/useWorktreeManager';
import type { BatchDocumentEntry } from '../../../../renderer/types';

const singleDoc: BatchDocumentEntry[] = [
	{ filename: 'auth-module', resetOnCompletion: false },
];

const twoDocs: BatchDocumentEntry[] = [
	{ filename: 'auth-module', resetOnCompletion: false },
	{ filename: 'db-migration', resetOnCompletion: false },
];

const manyDocs: BatchDocumentEntry[] = [
	{ filename: 'auth-module', resetOnCompletion: false },
	{ filename: 'db-migration', resetOnCompletion: false },
	{ filename: 'api-routes', resetOnCompletion: false },
	{ filename: 'frontend-ui', resetOnCompletion: false },
];

describe('useWorktreeManager — PR generation', () => {
	describe('generatePRTitle', () => {
		it('includes branch name and document name for single doc', () => {
			const { result } = renderHook(() => useWorktreeManager());
			const title = result.current.generatePRTitle('feature/auth', singleDoc, 5);
			expect(title).toBe('feature/auth: 5 tasks completed in auth-module');
		});

		it('lists both document names for two docs', () => {
			const { result } = renderHook(() => useWorktreeManager());
			const title = result.current.generatePRTitle('feature/auth', twoDocs, 12);
			expect(title).toBe('feature/auth: 12 tasks across auth-module, db-migration');
		});

		it('truncates with "+N more" for three or more docs', () => {
			const { result } = renderHook(() => useWorktreeManager());
			const title = result.current.generatePRTitle('feature/auth', manyDocs, 20);
			expect(title).toBe('feature/auth: 20 tasks across auth-module, db-migration +2 more');
		});

		it('uses singular "task" for 1 completed task', () => {
			const { result } = renderHook(() => useWorktreeManager());
			const title = result.current.generatePRTitle('hotfix/typo', singleDoc, 1);
			expect(title).toContain('1 task completed');
		});

		it('falls back to "Auto Run" when branch name is undefined', () => {
			const { result } = renderHook(() => useWorktreeManager());
			const title = result.current.generatePRTitle(undefined, singleDoc, 3);
			expect(title).toMatch(/^Auto Run:/);
		});
	});

	describe('generatePRBody', () => {
		it('includes document list and task count', () => {
			const { result } = renderHook(() => useWorktreeManager());
			const body = result.current.generatePRBody(twoDocs, 8);
			expect(body).toContain('- auth-module');
			expect(body).toContain('- db-migration');
			expect(body).toContain('**Total tasks completed:** 8');
		});

		it('includes commit subjects when provided', () => {
			const { result } = renderHook(() => useWorktreeManager());
			const commits = ['Add login endpoint', 'Fix password hashing', 'Update tests'];
			const body = result.current.generatePRBody(singleDoc, 3, commits);
			expect(body).toContain('## Changes');
			expect(body).toContain('- Add login endpoint');
			expect(body).toContain('- Fix password hashing');
			expect(body).toContain('- Update tests');
		});

		it('omits Changes section when no commits provided', () => {
			const { result } = renderHook(() => useWorktreeManager());
			const body = result.current.generatePRBody(singleDoc, 1);
			expect(body).not.toContain('## Changes');
		});

		it('omits Changes section for empty commit list', () => {
			const { result } = renderHook(() => useWorktreeManager());
			const body = result.current.generatePRBody(singleDoc, 1, []);
			expect(body).not.toContain('## Changes');
		});

		it('includes Maestro attribution footer', () => {
			const { result } = renderHook(() => useWorktreeManager());
			const body = result.current.generatePRBody(singleDoc, 1);
			expect(body).toContain('Maestro');
			expect(body).toContain('Auto Run');
		});
	});
});
