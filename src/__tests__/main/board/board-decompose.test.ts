/**
 * @file board-decompose.test.ts
 * @description Tests for the OPTIONAL Board auto-decompose layer (Phase 5).
 * Covers the strict off-by-default gate (a triage card is NEVER auto-expanded
 * when the flag is off), the response parser (fenced/bare JSON, malformed
 * dependsOn clamping), the per-tick cap, parent wiring, and triage retirement.
 */

import { describe, it, expect, vi } from 'vitest';
import {
	parseDecomposition,
	autoDecomposeBoard,
	buildDecomposePrompt,
	DEFAULT_AUTO_DECOMPOSE_PER_TICK,
	type AutoDecomposeDeps,
} from '../../../main/board/board-decompose';
import type { Board, BoardCard } from '../../../shared/board/types';

function card(overrides: Partial<BoardCard> = {}): BoardCard {
	// Default to a profile assignee unless the caller pins an agent instead
	// (Phase 6: a card needs a role and/or a pinned agent, not necessarily both).
	const hasExplicitAssignee = 'assigneeProfileId' in overrides || 'assigneeAgentId' in overrides;
	return {
		id: overrides.id ?? 'c1',
		title: overrides.title ?? 'Implement feature X',
		body: overrides.body ?? 'Do the thing',
		parents: overrides.parents ?? [],
		status: overrides.status ?? 'triage',
		createdAt: overrides.createdAt ?? '2026-07-10T00:00:00.000Z',
		updatedAt: overrides.updatedAt ?? '2026-07-10T00:00:00.000Z',
		runs: overrides.runs,
		worktree: overrides.worktree,
		...(hasExplicitAssignee
			? {
					...(overrides.assigneeProfileId
						? { assigneeProfileId: overrides.assigneeProfileId }
						: {}),
					...(overrides.assigneeAgentId ? { assigneeAgentId: overrides.assigneeAgentId } : {}),
				}
			: { assigneeProfileId: 'p1' }),
	};
}

function board(cards: BoardCard[], autoDecompose?: boolean): Board {
	return { id: 'b1', name: 'Board', cards, autoDecompose };
}

const NOW = '2026-07-10T12:00:00.000Z';

describe('parseDecomposition', () => {
	it('parses a fenced json block', () => {
		const out = 'Here you go:\n```json\n[{"title":"A","body":"a","dependsOn":[]}]\n```\ndone';
		const children = parseDecomposition(out);
		expect(children).toHaveLength(1);
		expect(children[0].title).toBe('A');
	});

	it('parses a bare json array', () => {
		const children = parseDecomposition('[{"title":"A","body":"","dependsOn":[]}]');
		expect(children).toHaveLength(1);
	});

	it('returns [] on non-array / unparseable output', () => {
		expect(parseDecomposition('no json here')).toEqual([]);
		expect(parseDecomposition('```json\n{"title":"A"}\n```')).toEqual([]);
		expect(parseDecomposition('')).toEqual([]);
	});

	it('drops entries with no title', () => {
		const children = parseDecomposition('[{"body":"x"},{"title":"Keep","body":"y"}]');
		expect(children).toHaveLength(1);
		expect(children[0].title).toBe('Keep');
	});

	it('clamps dependsOn to earlier, in-range, non-self indices (acyclic)', () => {
		const out = JSON.stringify([
			{ title: 'A', body: '', dependsOn: [0, 5, 1] }, // self + out-of-range + forward
			{ title: 'B', body: '', dependsOn: [0] },
		]);
		const children = parseDecomposition(out);
		expect(children[0].dependsOn).toEqual([]); // all invalid for index 0
		expect(children[1].dependsOn).toEqual([0]); // valid backward edge
	});
});

describe('buildDecomposePrompt', () => {
	it('substitutes title and body', () => {
		const prompt = buildDecomposePrompt('T={{CARD_TITLE}} B={{CARD_BODY}}', card());
		expect(prompt).toBe('T=Implement feature X B=Do the thing');
	});

	it('falls back to a placeholder when the body is empty', () => {
		const prompt = buildDecomposePrompt('{{CARD_BODY}}', card({ body: '' }));
		expect(prompt).toContain('no additional detail');
	});
});

describe('autoDecomposeBoard - strict off-by-default gate', () => {
	it('NEVER auto-expands a triage card when the flag is off (undefined)', async () => {
		const b = board([card({ status: 'triage' })]); // autoDecompose undefined
		const spawn = vi.fn();
		const count = await autoDecomposeBoard(b, { spawn });
		expect(count).toBe(0);
		expect(spawn).not.toHaveBeenCalled();
		expect(b.cards).toHaveLength(1);
		expect(b.cards[0].status).toBe('triage'); // untouched
	});

	it('NEVER auto-expands when the flag is explicitly false', async () => {
		const b = board([card({ status: 'triage' })], false);
		const spawn = vi.fn();
		const count = await autoDecomposeBoard(b, { spawn });
		expect(count).toBe(0);
		expect(spawn).not.toHaveBeenCalled();
	});
});

describe('autoDecomposeBoard - enabled', () => {
	const deps = (spawnImpl: AutoDecomposeDeps['spawn']): AutoDecomposeDeps => ({
		spawn: spawnImpl,
		now: () => NOW,
	});

	it('fans a triage card into children, wires parents, and retires the triage card', async () => {
		const triage = card({ id: 't1', status: 'triage', assigneeProfileId: 'pX' });
		const b = board([triage], true);
		const spawn = vi.fn().mockResolvedValue(
			JSON.stringify([
				{ title: 'Design', body: 'd', dependsOn: [] },
				{ title: 'Build', body: 'b', dependsOn: [0] },
			])
		);

		const count = await autoDecomposeBoard(b, deps(spawn));

		expect(count).toBe(1);
		// Triage card retired to done so it is never re-expanded.
		const retired = b.cards.find((c) => c.id === 't1')!;
		expect(retired.status).toBe('done');
		expect(retired.runs?.[0].summary).toContain('2 child');

		const children = b.cards.filter((c) => c.id !== 't1');
		expect(children).toHaveLength(2);
		// Every child inherits the assignee and depends on the triage umbrella.
		for (const child of children) {
			expect(child.assigneeProfileId).toBe('pX');
			expect(child.status).toBe('todo');
			expect(child.parents).toContain('t1');
		}
		// The second child also depends on the first (sibling wiring).
		const build = children.find((c) => c.title === 'Build')!;
		const design = children.find((c) => c.title === 'Design')!;
		expect(build.parents).toContain(design.id);
	});

	it('inherits a pinned agent (agent-only triage) so children stay valid (Phase 6)', async () => {
		// An agent-only triage card has no profile; children must inherit the pin,
		// or validateBoardCard would drop them (a card needs a role or an agent).
		const triage = card({
			id: 't1',
			status: 'triage',
			assigneeProfileId: undefined,
			assigneeAgentId: 'agent-9',
		});
		const b = board([triage], true);
		const spawn = vi.fn().mockResolvedValue('[{"title":"Sub","body":"s","dependsOn":[]}]');

		const count = await autoDecomposeBoard(b, deps(spawn));

		expect(count).toBe(1);
		const child = b.cards.find((c) => c.title === 'Sub')!;
		expect(child.assigneeAgentId).toBe('agent-9');
		expect(child.assigneeProfileId).toBeUndefined();
	});

	it('caps the number of triage cards decomposed per tick', async () => {
		const triageCards = Array.from({ length: DEFAULT_AUTO_DECOMPOSE_PER_TICK + 2 }, (_, i) =>
			card({ id: `t${i}`, status: 'triage' })
		);
		const b = board(triageCards, true);
		const spawn = vi.fn().mockResolvedValue('[{"title":"child","body":"","dependsOn":[]}]');

		const count = await autoDecomposeBoard(b, deps(spawn));

		expect(count).toBe(DEFAULT_AUTO_DECOMPOSE_PER_TICK);
		expect(spawn).toHaveBeenCalledTimes(DEFAULT_AUTO_DECOMPOSE_PER_TICK);
	});

	it('respects a custom maxPerTick', async () => {
		const triageCards = Array.from({ length: 3 }, (_, i) =>
			card({ id: `t${i}`, status: 'triage' })
		);
		const b = board(triageCards, true);
		const spawn = vi.fn().mockResolvedValue('[{"title":"child","body":"","dependsOn":[]}]');

		const count = await autoDecomposeBoard(b, { spawn, now: () => NOW, maxPerTick: 1 });
		expect(count).toBe(1);
	});

	it('leaves the triage card untouched when the LLM output is unparseable', async () => {
		const b = board([card({ id: 't1', status: 'triage' })], true);
		const spawn = vi.fn().mockResolvedValue('sorry, I could not help');
		const count = await autoDecomposeBoard(b, deps(spawn));
		expect(count).toBe(0);
		expect(b.cards).toHaveLength(1);
		expect(b.cards[0].status).toBe('triage');
	});

	it('skips a card whose spawn returns null (failure) without throwing', async () => {
		const b = board([card({ id: 't1', status: 'triage' })], true);
		const spawn = vi.fn().mockResolvedValue(null);
		const count = await autoDecomposeBoard(b, deps(spawn));
		expect(count).toBe(0);
		expect(b.cards[0].status).toBe('triage');
	});

	it('ignores non-triage cards', async () => {
		const b = board([card({ id: 't1', status: 'todo' })], true);
		const spawn = vi.fn();
		const count = await autoDecomposeBoard(b, deps(spawn));
		expect(count).toBe(0);
		expect(spawn).not.toHaveBeenCalled();
	});
});
