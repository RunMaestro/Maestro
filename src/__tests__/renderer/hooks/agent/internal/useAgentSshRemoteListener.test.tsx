import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAgentSshRemoteListener } from '../../../../../renderer/hooks/agent/internal/useAgentSshRemoteListener';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { createMockSession } from '../../../../helpers/mockSession';
import { gitService } from '../../../../../renderer/services/git';

vi.mock('../../../../../renderer/services/git', () => ({
	gitService: {
		isRepo: vi.fn(),
		getBranches: vi.fn(),
		getTags: vi.fn(),
	},
}));

let handler: ((sessionId: string, remote: any) => void) | undefined;
const mockUnsubscribe = vi.fn();

const mockProcess = {
	onSshRemote: vi.fn((h: any) => {
		handler = h;
		return mockUnsubscribe;
	}),
};

beforeEach(() => {
	vi.clearAllMocks();
	handler = undefined;
	vi.mocked(gitService.isRepo).mockResolvedValue(false);
	vi.mocked(gitService.getBranches).mockResolvedValue([] as any);
	vi.mocked(gitService.getTags).mockResolvedValue([] as any);
	useSessionStore.setState({
		sessions: [],
		groups: [],
		activeSessionId: '',
		initialLoadComplete: false,
		removedWorktreePaths: new Set(),
	});
	(window as any).maestro = { ...((window as any).maestro || {}), process: mockProcess };
});

describe('useAgentSshRemoteListener', () => {
	it('stamps sshRemote on the matching session', () => {
		const session = createMockSession({ id: 'sess-1' });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentSshRemoteListener());
		handler!('sess-1-ai-tab-1', { id: 'r-1', name: 'remote', host: 'h.example' });

		const updated = useSessionStore.getState().sessions[0];
		expect(updated.sshRemote?.id).toBe('r-1');
		expect(updated.sshRemoteId).toBe('r-1');
	});

	it('does NOT re-fetch when same remote already attached and session is already a git repo', async () => {
		const session = createMockSession({
			id: 'sess-1',
			isGitRepo: true,
			sshRemote: { id: 'r-1', name: 'r', host: 'h' } as any,
			sshRemoteId: 'r-1',
		});
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentSshRemoteListener());
		handler!('sess-1', { id: 'r-1', name: 'r', host: 'h' });
		await new Promise((r) => setTimeout(r, 0));
		await new Promise((r) => setTimeout(r, 0));

		// Probe is gated off by session.isGitRepo; nothing to refetch when the
		// remote already has its branches/tags cached.
		expect(gitService.isRepo).not.toHaveBeenCalled();
		expect(gitService.getBranches).not.toHaveBeenCalled();
		expect(gitService.getTags).not.toHaveBeenCalled();
	});

	it('triggers git probe when new remote attaches and session is not yet a git repo', async () => {
		vi.mocked(gitService.isRepo).mockResolvedValue(true);
		vi.mocked(gitService.getBranches).mockResolvedValue(['main'] as any);
		vi.mocked(gitService.getTags).mockResolvedValue([] as any);

		const session = createMockSession({ id: 'sess-1', isGitRepo: false });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentSshRemoteListener());
		handler!('sess-1', { id: 'r-1', name: 'r', host: 'h' });

		await new Promise((r) => setTimeout(r, 0));
		await new Promise((r) => setTimeout(r, 0));

		expect(gitService.isRepo).toHaveBeenCalledWith(expect.any(String), 'r-1');
	});

	it('does NOT re-probe on a duplicate event for the SAME remote (e.g. reconnect/replay)', async () => {
		vi.mocked(gitService.isRepo).mockResolvedValue(false);

		const session = createMockSession({
			id: 'sess-1',
			isGitRepo: false,
			sshRemote: { id: 'r-1', name: 'r', host: 'h' } as any,
			sshRemoteId: 'r-1',
		});
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentSshRemoteListener());
		// Same remote ID arrives again - could be a reconnect or a duplicate
		// IPC event. The store already has remote 'r-1' attached and the
		// previous probe already returned non-git, so re-probing would burn
		// 3 IPC calls for nothing.
		handler!('sess-1', { id: 'r-1', name: 'r', host: 'h' });
		await new Promise((r) => setTimeout(r, 0));
		await new Promise((r) => setTimeout(r, 0));

		expect(gitService.isRepo).not.toHaveBeenCalled();
		expect(gitService.getBranches).not.toHaveBeenCalled();
		expect(gitService.getTags).not.toHaveBeenCalled();
	});

	it('skips no-op render when session is missing', () => {
		const setSessionsSpy = vi.spyOn(useSessionStore.getState(), 'setSessions');
		renderHook(() => useAgentSshRemoteListener());
		handler!('missing-session', { id: 'r-1', name: 'r', host: 'h' });
		expect(setSessionsSpy).not.toHaveBeenCalled();
	});
});
