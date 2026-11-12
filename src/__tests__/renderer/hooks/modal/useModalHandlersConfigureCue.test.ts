/**
 * Tests for handleConfigureCue.
 *
 * The Left Bar's per-agent "Configure Maestro Cue" opens a dashboard listing
 * EVERY Cue-enabled agent. The handler used to take `_session` and throw it
 * away, so the menu item promised one agent and delivered an unmarked table.
 *
 * Lives in its own file because it needs `cueService` mocked, and the main
 * useModalHandlers suite deliberately runs against the real one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('../../../../renderer/hooks/agent/useAgentErrorRecovery', () => ({
	useAgentErrorRecovery: vi.fn().mockReturnValue({ recoveryActions: [] }),
}));

vi.mock('../../../../renderer/services/git', () => ({
	gitService: { getDiff: vi.fn().mockResolvedValue({ diff: '' }) },
}));

vi.mock('../../../../renderer/contexts/GitStatusContext', () => ({
	useGitDetail: () => ({
		getFileDetails: () => undefined,
		refreshGitStatus: vi.fn().mockResolvedValue(undefined),
	}),
}));

const getStatus = vi.fn();
vi.mock('../../../../renderer/services/cue', () => ({
	cueService: {
		getStatus: (...args: unknown[]) => getStatus(...args),
	},
}));

import { useModalHandlers } from '../../../../renderer/hooks/modal/useModalHandlers';
import { useModalStore } from '../../../../renderer/stores/modalStore';
import { createMockSession } from '../../../helpers/mockSession';

function cueStatus(sessionId: string) {
	return {
		sessionId,
		sessionName: `S-${sessionId}`,
		toolType: 'claude-code',
		projectRoot: '/proj',
		enabled: true,
		subscriptionCount: 1,
		activeRuns: 0,
	};
}

function renderHandlers() {
	return renderHook(() => useModalHandlers({ current: null }, { current: null }));
}

/** The payload the cueModal was opened with. */
function openedWith() {
	return useModalStore.getState().modals.get('cueModal')?.data as
		| { initialTab?: string; focusSessionId?: string }
		| undefined;
}

describe('handleConfigureCue', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useModalStore.setState({ modals: new Map() } as never);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('carries the right-clicked agent through so its row can be marked', async () => {
		getStatus.mockResolvedValue([cueStatus('agent-a'), cueStatus('agent-b')]);
		const { result } = renderHandlers();

		await act(async () => {
			result.current.handleConfigureCue(createMockSession({ id: 'agent-b' }));
		});

		expect(openedWith()?.focusSessionId).toBe('agent-b');
	});

	// The landing tab asks about THIS agent, not "does any agent have config".
	// The old global test dumped someone who right-clicked a fresh agent onto a
	// dashboard that said nothing about it.
	it('lands a configured agent on the dashboard', async () => {
		getStatus.mockResolvedValue([cueStatus('agent-a')]);
		const { result } = renderHandlers();

		await act(async () => {
			result.current.handleConfigureCue(createMockSession({ id: 'agent-a' }));
		});

		expect(openedWith()?.initialTab).toBe('dashboard');
	});

	it('lands an unconfigured agent on the pipeline builder even when others are configured', async () => {
		getStatus.mockResolvedValue([cueStatus('agent-a')]);
		const { result } = renderHandlers();

		await act(async () => {
			result.current.handleConfigureCue(createMockSession({ id: 'brand-new' }));
		});

		expect(openedWith()?.initialTab).toBe('pipeline');
		expect(openedWith()?.focusSessionId).toBe('brand-new');
	});

	it('falls back to the pipeline builder when the status query fails', async () => {
		getStatus.mockRejectedValue(new Error('engine unreachable'));
		const { result } = renderHandlers();

		await act(async () => {
			result.current.handleConfigureCue(createMockSession({ id: 'agent-a' }));
		});

		expect(openedWith()?.initialTab).toBe('pipeline');
	});
});
