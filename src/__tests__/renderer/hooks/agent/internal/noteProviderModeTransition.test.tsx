import { describe as __maestroMicrobenchDescribe } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { beforeEach } from 'vitest';
import { noteProviderModeTransition } from '../../../../../renderer/hooks/agent/internal/useAgentClaudeModeResolvedListener';
import { __resetAnnouncedProviderMode } from '../../../../../renderer/hooks/agent/internal/useAgentClaudeModeResolvedListener';
import { vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAgentCommandExitListener } from '../../../../../renderer/hooks/agent/internal/useAgentCommandExitListener';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { createMockSession } from '../../../../helpers/mockSession';
import { createMockAITab } from '../../../../helpers/mockTab';
import { useAgentStderrListener } from '../../../../../renderer/hooks/agent/internal/useAgentStderrListener';
import type { BatchedUpdater } from '../../../../../renderer/hooks/agent/internal/types';
import { useAgentSlashCommandsListener } from '../../../../../renderer/hooks/agent/internal/useAgentSlashCommandsListener';
__maestroMicrobenchDescribe('noteProviderModeTransition', () => {
	describe('noteProviderModeTransition', () => {
		beforeEach(() => {
			__resetAnnouncedProviderMode();
		});

		it('baselines the first observation per provider without announcing', () => {
			expect(noteProviderModeTransition('/Users/me/.claude', 'interactive')).toEqual({
				transitioned: false,
			});
		});

		it('does not announce when the mode is unchanged (the cascade: other agents follow silently)', () => {
			noteProviderModeTransition('/Users/me/.claude', 'interactive'); // baseline
			// Three more agents on the same account resolve the same mode.
			expect(noteProviderModeTransition('/Users/me/.claude', 'interactive').transitioned).toBe(
				false
			);
			expect(noteProviderModeTransition('/Users/me/.claude', 'interactive').transitioned).toBe(
				false
			);
			expect(noteProviderModeTransition('/Users/me/.claude', 'interactive').transitioned).toBe(
				false
			);
		});

		it('announces exactly once on a real account-wide transition, then cascades silently', () => {
			noteProviderModeTransition('/Users/me/.claude', 'interactive'); // baseline

			// First agent to hit the limit flips the account to API → announce once.
			expect(noteProviderModeTransition('/Users/me/.claude', 'api')).toEqual({
				transitioned: true,
				prevMode: 'interactive',
			});
			// Every other agent on the same account that resolves API after the flip
			// must NOT re-announce.
			expect(noteProviderModeTransition('/Users/me/.claude', 'api').transitioned).toBe(false);
			expect(noteProviderModeTransition('/Users/me/.claude', 'api').transitioned).toBe(false);
		});

		it('announces the switch back to Time Limits once when the quota window resets', () => {
			noteProviderModeTransition('/Users/me/.claude', 'api'); // baseline (account already limited)

			expect(noteProviderModeTransition('/Users/me/.claude', 'interactive')).toEqual({
				transitioned: true,
				prevMode: 'api',
			});
			expect(noteProviderModeTransition('/Users/me/.claude', 'interactive').transitioned).toBe(
				false
			);
		});

		it('tracks each provider (account) independently', () => {
			noteProviderModeTransition('/Users/me/.claude', 'interactive'); // baseline A
			noteProviderModeTransition('/Users/me/.claude-work', 'interactive'); // baseline B

			// Account A flips; account B is untouched.
			expect(noteProviderModeTransition('/Users/me/.claude', 'api').transitioned).toBe(true);
			expect(noteProviderModeTransition('/Users/me/.claude-work', 'interactive').transitioned).toBe(
				false
			);
			// Account B's own later flip announces on its own schedule.
			expect(noteProviderModeTransition('/Users/me/.claude-work', 'api').transitioned).toBe(true);
		});
	});
});
__maestroMicrobenchDescribe('useAgentCommandExitListener', () => {
	let handler: ((sessionId: string, code: number) => void) | undefined;
	const mockUnsubscribe = vi.fn();

	const mockProcess = {
		onCommandExit: vi.fn((h: any) => {
			handler = h;
			return mockUnsubscribe;
		}),
	};

	beforeEach(() => {
		vi.clearAllMocks();
		handler = undefined;
		useSessionStore.setState({
			sessions: [],
			groups: [],
			activeSessionId: '',
			initialLoadComplete: false,
			removedWorktreePaths: new Set(),
		});
		(window as any).maestro = { ...((window as any).maestro || {}), process: mockProcess };
	});

	describe('useAgentCommandExitListener', () => {
		it('appends a system log on non-zero exit code', () => {
			const session = createMockSession({ id: 'sess-1', shellLogs: [] });
			useSessionStore.setState({ sessions: [session] } as any);

			renderHook(() => useAgentCommandExitListener());
			handler!('sess-1', 2);

			const updated = useSessionStore.getState().sessions[0];
			const sysLog = updated.shellLogs[updated.shellLogs.length - 1];
			expect(sysLog?.text).toContain('exited with code 2');
			expect(sysLog?.source).toBe('system');
		});

		it('does not append a log on zero exit code', () => {
			const session = createMockSession({ id: 'sess-1', shellLogs: [] });
			useSessionStore.setState({ sessions: [session] } as any);

			renderHook(() => useAgentCommandExitListener());
			handler!('sess-1', 0);

			expect(useSessionStore.getState().sessions[0].shellLogs).toEqual([]);
		});

		it('keeps session busy when an AI tab is still busy', () => {
			const tab = createMockAITab({ id: 'tab-1', state: 'busy' });
			const session = createMockSession({
				id: 'sess-1',
				aiTabs: [tab],
				activeTabId: 'tab-1',
				state: 'busy',
			});
			useSessionStore.setState({ sessions: [session] } as any);

			renderHook(() => useAgentCommandExitListener());
			handler!('sess-1', 0);

			expect(useSessionStore.getState().sessions[0].state).toBe('busy');
		});

		it('transitions session to idle when no AI tabs busy', () => {
			const tab = createMockAITab({ id: 'tab-1', state: 'idle' });
			const session = createMockSession({
				id: 'sess-1',
				aiTabs: [tab],
				activeTabId: 'tab-1',
				state: 'busy',
			});
			useSessionStore.setState({ sessions: [session] } as any);

			renderHook(() => useAgentCommandExitListener());
			handler!('sess-1', 0);

			expect(useSessionStore.getState().sessions[0].state).toBe('idle');
		});

		it('skips no-op render when session is missing (orphan event)', () => {
			const setSessionsSpy = vi.spyOn(useSessionStore.getState(), 'setSessions');
			renderHook(() => useAgentCommandExitListener());
			handler!('missing', 0);
			expect(setSessionsSpy).not.toHaveBeenCalled();
		});
	});
});
__maestroMicrobenchDescribe('useAgentStderrListener', () => {
	let onStderrHandler: ((sessionId: string, data: string) => void) | undefined;
	const mockUnsubscribe = vi.fn();

	const mockProcess = {
		onStderr: vi.fn((handler: any) => {
			onStderrHandler = handler;
			return mockUnsubscribe;
		}),
	};

	function makeBatched(): BatchedUpdater {
		return {
			appendLog: vi.fn(),
			markDelivered: vi.fn(),
			markUnread: vi.fn(),
			updateUsage: vi.fn(),
			updateContextUsage: vi.fn(),
			updateCycleBytes: vi.fn(),
			updateCycleTokens: vi.fn(),
		};
	}

	beforeEach(() => {
		vi.clearAllMocks();
		onStderrHandler = undefined;
		(window as any).maestro = { ...((window as any).maestro || {}), process: mockProcess };
	});

	describe('useAgentStderrListener', () => {
		it('subscribes once and unsubscribes on unmount', () => {
			const { unmount } = renderHook(() =>
				useAgentStderrListener({ batchedUpdater: makeBatched() })
			);
			expect(mockProcess.onStderr).toHaveBeenCalledTimes(1);
			unmount();
			expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
		});

		it('routes ai-tab-format stderr to the AI tab with isStderr=true', () => {
			const batched = makeBatched();
			renderHook(() => useAgentStderrListener({ batchedUpdater: batched }));
			onStderrHandler!('sess-1-ai-tab-1', 'oh no\n');
			expect(batched.appendLog).toHaveBeenCalledWith('sess-1', 'tab-1', true, 'oh no\n', true);
		});

		it('routes plain session ids to the terminal log with isStderr=true', () => {
			const batched = makeBatched();
			renderHook(() => useAgentStderrListener({ batchedUpdater: batched }));
			onStderrHandler!('sess-1', 'oops');
			expect(batched.appendLog).toHaveBeenCalledWith('sess-1', null, false, 'oops', true);
		});

		it('drops empty/whitespace-only stderr', () => {
			const batched = makeBatched();
			renderHook(() => useAgentStderrListener({ batchedUpdater: batched }));
			onStderrHandler!('sess-1', '   ');
			onStderrHandler!('sess-1', '\n\t');
			expect(batched.appendLog).not.toHaveBeenCalled();
		});

		it('ignores batch session ids', () => {
			const batched = makeBatched();
			renderHook(() => useAgentStderrListener({ batchedUpdater: batched }));
			onStderrHandler!('sess-1-batch-tab-1', 'data');
			expect(batched.appendLog).not.toHaveBeenCalled();
		});
	});
});
__maestroMicrobenchDescribe('useAgentSlashCommandsListener', () => {
	let onSlashCommandsHandler: ((sessionId: string, slashCommands: string[]) => void) | undefined;
	const mockUnsubscribe = vi.fn();

	const mockProcess = {
		onSlashCommands: vi.fn((handler: any) => {
			onSlashCommandsHandler = handler;
			return mockUnsubscribe;
		}),
	};

	beforeEach(() => {
		vi.clearAllMocks();
		onSlashCommandsHandler = undefined;
		useSessionStore.setState({
			sessions: [],
			groups: [],
			activeSessionId: '',
			initialLoadComplete: false,
			removedWorktreePaths: new Set(),
		});
		(window as any).maestro = { ...((window as any).maestro || {}), process: mockProcess };
	});

	describe('useAgentSlashCommandsListener', () => {
		it('registers exactly one listener on mount and unsubscribes on unmount', () => {
			const { unmount } = renderHook(() => useAgentSlashCommandsListener());
			expect(mockProcess.onSlashCommands).toHaveBeenCalledTimes(1);
			unmount();
			expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
		});

		it('writes normalised commands to the matching session', () => {
			const session = createMockSession({ id: 'sess-1', toolType: 'claude-code' });
			useSessionStore.setState({ sessions: [session] } as any);

			renderHook(() => useAgentSlashCommandsListener());
			onSlashCommandsHandler!('sess-1', ['help', '/clear', 'config']);

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated?.agentCommands?.map((c) => c.command)).toEqual(['/help', '/clear', '/config']);
			updated?.agentCommands?.forEach((c) => {
				expect(c.description).toBeDefined();
			});
		});

		it('skips no-op renders when the session does not exist (orphan event)', () => {
			const setSessionsSpy = vi.spyOn(useSessionStore.getState(), 'setSessions');
			renderHook(() => useAgentSlashCommandsListener());
			onSlashCommandsHandler!('missing-session', ['/help']);
			expect(setSessionsSpy).not.toHaveBeenCalled();
		});

		it('handles empty command arrays', () => {
			const session = createMockSession({ id: 'sess-1' });
			useSessionStore.setState({ sessions: [session] } as any);

			renderHook(() => useAgentSlashCommandsListener());
			onSlashCommandsHandler!('sess-1', []);

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated?.agentCommands).toEqual([]);
		});
	});
});
