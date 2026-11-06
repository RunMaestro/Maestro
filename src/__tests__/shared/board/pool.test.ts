/**
 * @file pool.test.ts
 * @description Tests for the Board Phase 6 worker-pool selection helpers:
 * directory containment (`isPathWithin`) and opt-in filtering
 * (`selectPoolAgentIds`).
 */

import { describe, it, expect } from 'vitest';
import { isPathWithin, selectPoolAgentIds, type PoolCandidate } from '../../../shared/board/pool';

describe('isPathWithin', () => {
	it('matches the directory itself and nested sub-folders', () => {
		expect(isPathWithin('/repo', '/repo')).toBe(true);
		expect(isPathWithin('/repo', '/repo/packages/api')).toBe(true);
	});

	it('is boundary-safe (sibling prefix is not contained)', () => {
		expect(isPathWithin('/repo', '/repo-two')).toBe(false);
		expect(isPathWithin('/repo', '/other')).toBe(false);
	});

	it('tolerates trailing separators and backslashes', () => {
		expect(isPathWithin('/repo/', '/repo/sub')).toBe(true);
		expect(isPathWithin('C:\\repo', 'C:\\repo\\sub')).toBe(true);
	});

	it('never contains empty / missing paths', () => {
		expect(isPathWithin('/repo', undefined)).toBe(false);
		expect(isPathWithin('/repo', null)).toBe(false);
		expect(isPathWithin('', '/repo')).toBe(false);
	});
});

describe('selectPoolAgentIds', () => {
	const agents: PoolCandidate[] = [
		{ id: 'a', dir: '/repo', boardWorker: true },
		{ id: 'b', dir: '/repo/pkg', boardWorker: true },
		{ id: 'c', dir: '/repo', boardWorker: false }, // not opted in
		{ id: 'd', dir: '/elsewhere', boardWorker: true }, // outside the project
		{ id: 'e', dir: undefined, boardWorker: true }, // no dir
	];

	it('keeps only opted-in, in-directory agents, preserving order', () => {
		expect(selectPoolAgentIds('/repo', agents)).toEqual(['a', 'b']);
	});

	it('returns an empty pool when nobody has opted in', () => {
		expect(
			selectPoolAgentIds(
				'/repo',
				agents.map((a) => ({ ...a, boardWorker: false }))
			)
		).toEqual([]);
	});
});
