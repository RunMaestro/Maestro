/**
 * Tests for the desktop's `RepositoryProcesses` (DG2): liveness from what ProcessManager is running,
 * and a delete that stops everything the agent owns.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDesktopRuntimeProcesses } from '../../../main/library-runtime/processes';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const cliBusy = vi.hoisted(() => ({ ids: new Set<string>() }));
vi.mock('../../../shared/cli-activity', () => ({
	isSessionBusyWithCli: (id: string) => cliBusy.ids.has(id),
}));

function fakeManager(ids: string[]) {
	const live = new Set(ids);
	return {
		live,
		get: (id: string) => (live.has(id) ? { sessionId: id } : undefined),
		getAll: () => [...live].map((sessionId) => ({ sessionId })),
		kill: vi.fn((id: string) => live.delete(id)),
	};
}

describe('createDesktopRuntimeProcesses', () => {
	beforeEach(() => {
		cliBusy.ids.clear();
	});

	describe('isBusy', () => {
		it('is false with no ProcessManager yet', () => {
			const processes = createDesktopRuntimeProcesses(() => null);
			expect(processes.isBusy('a1')).toBe(false);
			expect(processes.isBusy('a1', 't1')).toBe(false);
		});

		it('sees an AI tab process by its compound id, for that tab only', () => {
			const processes = createDesktopRuntimeProcesses(() => fakeManager(['a1-ai-t1']));
			expect(processes.isBusy('a1', 't1')).toBe(true);
			expect(processes.isBusy('a1', 't2')).toBe(false);
			expect(processes.isBusy('a2', 't1')).toBe(false);
		});

		it('sees the legacy bare id as the active tab, and errs toward busy for any tab', () => {
			const processes = createDesktopRuntimeProcesses(() => fakeManager(['a1-ai']));
			expect(processes.isBusy('a1')).toBe(true);
			expect(processes.isBusy('a1', 'any-tab')).toBe(true);
		});

		it('is busy at the agent level when any tab or Auto Run turn runs', () => {
			const tab = createDesktopRuntimeProcesses(() => fakeManager(['a1-ai-t9']));
			const batch = createDesktopRuntimeProcesses(() => fakeManager(['a1-batch-1700000000']));
			expect(tab.isBusy('a1')).toBe(true);
			expect(batch.isBusy('a1')).toBe(true);
			expect(tab.isBusy('a2')).toBe(false);
		});

		it('does not count a terminal shell or another agent as a turn', () => {
			const processes = createDesktopRuntimeProcesses(() =>
				fakeManager(['a1-terminal', 'a1-terminal-t1', 'a10-ai-t1', 'group-chat-x-moderator'])
			);
			expect(processes.isBusy('a1')).toBe(false);
			expect(processes.isBusy('a1', 't1')).toBe(false);
		});

		it('counts a playbook the CLI drives against the agent', () => {
			cliBusy.ids.add('a1');
			const processes = createDesktopRuntimeProcesses(() => fakeManager([]));
			expect(processes.isBusy('a1')).toBe(true);
			expect(processes.isBusy('a1', 't1')).toBe(true);
			expect(processes.isBusy('a2')).toBe(false);
		});
	});

	describe('stopAgent', () => {
		it("kills every process the agent owns and nobody else's", async () => {
			const manager = fakeManager([
				'a1-ai-t1',
				'a1-ai-t2',
				'a1-ai',
				'a1-terminal',
				'a1-terminal-t3',
				'a1-batch-17',
				'a1-synopsis-17',
				'a1-shell-9',
				'a10-ai-t1',
				'a2-ai-t1',
				'group-chat-g-moderator',
				'cross-agent-r1',
			]);
			await createDesktopRuntimeProcesses(() => manager).stopAgent('a1');

			expect([...manager.live].sort()).toEqual([
				'a10-ai-t1',
				'a2-ai-t1',
				'cross-agent-r1',
				'group-chat-g-moderator',
			]);
		});

		it('keeps going when one kill throws', async () => {
			const manager = fakeManager(['a1-ai-t1', 'a1-ai-t2']);
			manager.kill.mockImplementationOnce(() => {
				throw new Error('EPERM');
			});
			await expect(
				createDesktopRuntimeProcesses(() => manager).stopAgent('a1')
			).resolves.toBeUndefined();
			expect(manager.kill).toHaveBeenCalledTimes(2);
		});

		it('is a no-op with no ProcessManager', async () => {
			await expect(
				createDesktopRuntimeProcesses(() => null).stopAgent('a1')
			).resolves.toBeUndefined();
		});
	});
});
