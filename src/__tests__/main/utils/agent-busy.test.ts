/**
 * @file agent-busy.test.ts
 * @description Unit tests for the main-process "is this agent working right now?" probe.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockIsSessionBusyWithCli = vi.fn<(sessionId: string) => boolean>();
vi.mock('../../../shared/cli-activity', () => ({
	isSessionBusyWithCli: (sessionId: string) => mockIsSessionBusyWithCli(sessionId),
}));

import { isAgentBusy, isAiTabProcessActive } from '../../../main/utils/agent-busy';

/** Process manager double whose live keys are whatever this set contains. */
function probeWith(liveIds: string[]) {
	const live = new Set(liveIds);
	return { get: (sessionId: string) => (live.has(sessionId) ? { pid: 1 } : undefined) };
}

describe('agent-busy', () => {
	beforeEach(() => {
		mockIsSessionBusyWithCli.mockReset();
		mockIsSessionBusyWithCli.mockReturnValue(false);
	});

	describe('isAiTabProcessActive', () => {
		it('reports a live process on the compound tab id', () => {
			const probe = probeWith(['agent-1-ai-tab-a']);
			expect(isAiTabProcessActive(probe, 'agent-1', 'tab-a', false)).toBe(true);
		});

		it('reports idle when only another tab is running', () => {
			const probe = probeWith(['agent-1-ai-tab-b']);
			expect(isAiTabProcessActive(probe, 'agent-1', 'tab-a', false)).toBe(false);
		});

		it('accepts the legacy bare id for the active tab only', () => {
			const probe = probeWith(['agent-1-ai']);
			expect(isAiTabProcessActive(probe, 'agent-1', 'tab-a', true)).toBe(true);
			expect(isAiTabProcessActive(probe, 'agent-1', 'tab-a', false)).toBe(false);
		});

		it('reports idle with no process manager', () => {
			expect(isAiTabProcessActive(undefined, 'agent-1', 'tab-a', true)).toBe(false);
		});
	});

	describe('isAgentBusy', () => {
		const session = {
			id: 'agent-1',
			activeTabId: 'tab-a',
			aiTabs: [{ id: 'tab-a' }, { id: 'tab-b' }],
		};

		it('is busy when any tab is running, not just the active one', () => {
			expect(isAgentBusy(session, probeWith(['agent-1-ai-tab-b']))).toBe(true);
		});

		it('is idle when no tab has a live process', () => {
			expect(isAgentBusy(session, probeWith([]))).toBe(false);
		});

		it('is busy when the CLI is running a playbook against it', () => {
			mockIsSessionBusyWithCli.mockImplementation((id) => id === 'agent-1');
			expect(isAgentBusy(session, probeWith([]))).toBe(true);
		});

		it('ignores malformed tab entries', () => {
			const malformed = {
				id: 'agent-1',
				activeTabId: 'tab-a',
				aiTabs: [null, undefined, {} as { id?: string }],
			};
			expect(isAgentBusy(malformed, probeWith(['agent-1-ai-tab-a']))).toBe(false);
		});

		it('is idle for an agent with no tabs at all', () => {
			expect(isAgentBusy({ id: 'agent-1' }, probeWith(['agent-1-ai']))).toBe(false);
		});
	});
});
