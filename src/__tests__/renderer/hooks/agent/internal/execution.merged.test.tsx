// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/renderer/hooks/agent/internal/useAgentThinkingListener.test.tsx
// Source: src/__tests__/renderer/hooks/agent/internal/useAgentToolExecutionListener.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook as s1_renderHook } from '@testing-library/react';
import { useAgentThinkingListener } from '../../../../../renderer/hooks/agent/internal/useAgentThinkingListener';
import { useSessionStore as s1_useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { createMockSession as s1_createMockSession } from '../../../../helpers/mockSession';
import { createMockAITab as s1_createMockAITab } from '../../../../helpers/mockTab';
import type { LogEntry } from '../../../../../renderer/types';
import { noteRetryProgress as s1_noteRetryProgress } from '../../../../../renderer/stores/retryStore';
import { renderHook as s2_renderHook } from '@testing-library/react';
import { useAgentToolExecutionListener } from '../../../../../renderer/hooks/agent/internal/useAgentToolExecutionListener';
import { useSessionStore as s2_useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { createMockSession as s2_createMockSession } from '../../../../helpers/mockSession';
import { createMockAITab as s2_createMockAITab } from '../../../../helpers/mockTab';
import { noteRetryProgress as s2_noteRetryProgress } from '../../../../../renderer/stores/retryStore';
vi.mock('../../../../../renderer/stores/retryStore', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../../renderer/stores/retryStore')>()),
	noteRetryProgress: vi.fn(),
}));
// Source: src/__tests__/renderer/hooks/agent/internal/useAgentThinkingListener.test.tsx
describe('', () => {
	let handler: ((sessionId: string, content: string) => void) | undefined;
	const mockUnsubscribe = vi.fn();
	const mockProcess = {
		onThinkingChunk: vi.fn((h: any) => {
			handler = h;
			return mockUnsubscribe;
		}),
	};
	let originalRaf: typeof requestAnimationFrame;
	let originalCancelRaf: typeof cancelAnimationFrame;
	// Map id -> callback so cancelAnimationFrame can actually remove the queued
	// callback (matches real browser semantics). A vi.fn() stub here would let a
	// post-unmount flushRaf() still fire the callback, masking cleanup bugs.
	let scheduled: Map<number, () => void> = new Map();
	let nextRafId = 0;
	const cancelRafSpy = vi.fn();
	beforeEach(() => {
		vi.clearAllMocks();
		cancelRafSpy.mockClear();
		handler = undefined;
		scheduled = new Map();
		nextRafId = 0;
		originalRaf = global.requestAnimationFrame;
		originalCancelRaf = global.cancelAnimationFrame;
		global.requestAnimationFrame = ((cb: FrameRequestCallback) => {
			nextRafId += 1;
			const id = nextRafId;
			scheduled.set(id, () => cb(performance.now()));
			return id;
		}) as any;
		global.cancelAnimationFrame = ((id: number) => {
			cancelRafSpy(id);
			scheduled.delete(id);
		}) as any;
		s1_useSessionStore.setState({
			sessions: [],
			groups: [],
			activeSessionId: '',
			initialLoadComplete: false,
			removedWorktreePaths: new Set(),
		});
		(window as any).maestro = { ...((window as any).maestro || {}), process: mockProcess };
	});
	afterEach(() => {
		global.requestAnimationFrame = originalRaf;
		global.cancelAnimationFrame = originalCancelRaf;
	});
	function flushRaf() {
		const queued = Array.from(scheduled.values());
		scheduled.clear();
		queued.forEach((cb) => cb());
	}
	describe('useAgentThinkingListener', () => {
		it('reports model output to the retry engine even when thinking is hidden', () => {
			const tab = s1_createMockAITab({ id: 'tab-1', showThinking: 'off' });
			const session = s1_createMockSession({ id: 'sess-1', aiTabs: [tab] });
			s1_useSessionStore.setState({ sessions: [session] } as any);
			s1_renderHook(() => useAgentThinkingListener());
			handler!('sess-1-ai-tab-1', 'Working on it');
			expect(s1_noteRetryProgress).toHaveBeenCalledWith('sess-1', 'tab-1');
		});
		it('subscribes once and unsubscribes on unmount', () => {
			const { unmount } = s1_renderHook(() => useAgentThinkingListener());
			expect(mockProcess.onThinkingChunk).toHaveBeenCalledTimes(1);
			unmount();
			expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
		});
		it('appends a thinking log on first chunk and merges on subsequent chunks (RAF-batched)', () => {
			const tab = s1_createMockAITab({ id: 'tab-1', showThinking: 'on' });
			const session = s1_createMockSession({ id: 'sess-1', aiTabs: [tab] });
			s1_useSessionStore.setState({ sessions: [session] } as any);
			s1_renderHook(() => useAgentThinkingListener());
			handler!('sess-1-ai-tab-1', 'hello ');
			handler!('sess-1-ai-tab-1', 'world');
			// Before flush - no log yet.
			expect(s1_useSessionStore.getState().sessions[0].aiTabs[0].logs).toHaveLength(0);
			flushRaf();
			const tabAfter = s1_useSessionStore.getState().sessions[0].aiTabs[0];
			expect(tabAfter.logs).toHaveLength(1);
			expect(tabAfter.logs[0].source).toBe('thinking');
			expect(tabAfter.logs[0].text).toBe('hello world');
		});
		it('skips when tab.showThinking is off', () => {
			const tab = s1_createMockAITab({ id: 'tab-1', showThinking: 'off' });
			const session = s1_createMockSession({ id: 'sess-1', aiTabs: [tab] });
			s1_useSessionStore.setState({ sessions: [session] } as any);
			s1_renderHook(() => useAgentThinkingListener());
			handler!('sess-1-ai-tab-1', 'should not render');
			flushRaf();
			expect(s1_useSessionStore.getState().sessions[0].aiTabs[0].logs).toHaveLength(0);
		});
		it('cancels pending RAF on unmount and post-unmount flushRaf is a no-op', () => {
			// First mount with no events scheduled - nothing to cancel.
			s1_renderHook(() => useAgentThinkingListener()).unmount();
			expect(cancelRafSpy).not.toHaveBeenCalled();
			// Second mount: schedule a RAF, unmount, then assert flushing the RAF
			// queue does NOT invoke the previously scheduled callback (it was
			// cancelled and removed from the queue).
			const tab = s1_createMockAITab({ id: 'tab-1', showThinking: 'on' });
			const session = s1_createMockSession({ id: 'sess-1', aiTabs: [tab] });
			s1_useSessionStore.setState({ sessions: [session] } as any);
			const { unmount } = s1_renderHook(() => useAgentThinkingListener());
			handler!('sess-1-ai-tab-1', 'data');
			unmount();
			expect(cancelRafSpy).toHaveBeenCalled();
			flushRaf();
			expect(s1_useSessionStore.getState().sessions[0].aiTabs[0].logs).toHaveLength(0);
		});
		// Regression: the fast (rAF) writer must not append a thinking log below the
		// turn's answer, which the slow (200ms batched) writer flushed in between.
		describe('stale straggler after the turn answer landed', () => {
			function makeLog(
				source: LogEntry['source'],
				text: string,
				id: string,
				timestamp = 1
			): LogEntry {
				return { id, timestamp, source, text };
			}
			/**
			 * Reproduce the real interleaving: the chunk is buffered FIRST, then the
			 * 200ms batch flushes the answer, then the rAF fires. The stdout log must
			 * therefore carry a timestamp LATER than the moment buffering started -
			 * that ordering is exactly what marks the chunk stale. Placing the answer
			 * with an earlier timestamp would instead model an intermediate assistant
			 * message, which must NOT drop the chunk (see the mid-turn cases below).
			 */
			function landAnswerAfterBuffering(logs: LogEntry[], answerText: string): LogEntry[] {
				return [...logs, makeLog('stdout', answerText, 'answer', Date.now() + 1000)];
			}
			it('drops the chunk when the turn stdout answer landed after buffering', () => {
				const logs = landAnswerAfterBuffering([makeLog('user', 'prompt', 'l1')], 'final answer');
				const tab = s1_createMockAITab({ id: 'tab-1', showThinking: 'on', logs });
				const session = s1_createMockSession({ id: 'sess-1', aiTabs: [tab] });
				s1_useSessionStore.setState({ sessions: [session] } as any);
				s1_renderHook(() => useAgentThinkingListener());
				handler!('sess-1-ai-tab-1', 'final ans');
				flushRaf();
				const tabAfter = s1_useSessionStore.getState().sessions[0].aiTabs[0];
				expect(tabAfter.logs).toHaveLength(2);
				expect(tabAfter.logs.some((l) => l.source === 'thinking')).toBe(false);
				expect(tabAfter.logs).toEqual(logs);
			});
			// Greptile P1 on PR #1347: claude-code and factory-droid stream at MESSAGE
			// granularity, so an intermediate assistant message flushes as stdout
			// mid-turn and more reasoning legitimately follows it. A source-only guard
			// treated that as the final answer and silenced thinking for the rest of
			// the turn.
			it('still appends reasoning that arrives AFTER an intermediate stdout message', () => {
				const logs = [
					makeLog('user', 'prompt', 'l1'),
					makeLog('stdout', 'intermediate assistant message', 'l2'),
				];
				const tab = s1_createMockAITab({ id: 'tab-1', showThinking: 'on', logs });
				const session = s1_createMockSession({ id: 'sess-1', aiTabs: [tab] });
				s1_useSessionStore.setState({ sessions: [session] } as any);
				s1_renderHook(() => useAgentThinkingListener());
				// Buffered AFTER that stdout already existed, so it is new content.
				handler!('sess-1-ai-tab-1', 'more reasoning');
				flushRaf();
				const tabAfter = s1_useSessionStore.getState().sessions[0].aiTabs[0];
				expect(tabAfter.logs).toHaveLength(3);
				expect(tabAfter.logs[2].source).toBe('thinking');
				expect(tabAfter.logs[2].text).toBe('more reasoning');
			});
			it('still appends when the last log is the user prompt (normal turn start)', () => {
				const tab = s1_createMockAITab({
					id: 'tab-1',
					showThinking: 'on',
					logs: [makeLog('user', 'prompt', 'l1')],
				});
				const session = s1_createMockSession({ id: 'sess-1', aiTabs: [tab] });
				s1_useSessionStore.setState({ sessions: [session] } as any);
				s1_renderHook(() => useAgentThinkingListener());
				handler!('sess-1-ai-tab-1', 'thinking...');
				flushRaf();
				const tabAfter = s1_useSessionStore.getState().sessions[0].aiTabs[0];
				expect(tabAfter.logs).toHaveLength(2);
				expect(tabAfter.logs[1].source).toBe('thinking');
				expect(tabAfter.logs[1].text).toBe('thinking...');
			});
			it('still coalesces into an open thinking log', () => {
				const tab = s1_createMockAITab({
					id: 'tab-1',
					showThinking: 'on',
					logs: [makeLog('user', 'prompt', 'l1'), makeLog('thinking', 'hello ', 'l2')],
				});
				const session = s1_createMockSession({ id: 'sess-1', aiTabs: [tab] });
				s1_useSessionStore.setState({ sessions: [session] } as any);
				s1_renderHook(() => useAgentThinkingListener());
				handler!('sess-1-ai-tab-1', 'world');
				flushRaf();
				const tabAfter = s1_useSessionStore.getState().sessions[0].aiTabs[0];
				expect(tabAfter.logs).toHaveLength(2);
				expect(tabAfter.logs[1].source).toBe('thinking');
				expect(tabAfter.logs[1].text).toBe('hello world');
			});
			it('drops the stale chunk in sticky mode but keeps existing thinking logs', () => {
				const logs = landAnswerAfterBuffering(
					[makeLog('thinking', 'earlier reasoning', 'l1')],
					'final answer'
				);
				const tab = s1_createMockAITab({ id: 'tab-1', showThinking: 'sticky', logs });
				const session = s1_createMockSession({ id: 'sess-1', aiTabs: [tab] });
				s1_useSessionStore.setState({ sessions: [session] } as any);
				s1_renderHook(() => useAgentThinkingListener());
				handler!('sess-1-ai-tab-1', 'final ans');
				flushRaf();
				const tabAfter = s1_useSessionStore.getState().sessions[0].aiTabs[0];
				expect(tabAfter.logs).toEqual(logs);
				expect(tabAfter.logs.filter((l) => l.source === 'thinking')).toHaveLength(1);
			});
			it('still appends when the last log is tool activity (thinking resumes mid-turn)', () => {
				const tab = s1_createMockAITab({
					id: 'tab-1',
					showThinking: 'on',
					logs: [makeLog('user', 'prompt', 'l1'), makeLog('tool', 'Read(file.ts)', 'l2')],
				});
				const session = s1_createMockSession({ id: 'sess-1', aiTabs: [tab] });
				s1_useSessionStore.setState({ sessions: [session] } as any);
				s1_renderHook(() => useAgentThinkingListener());
				handler!('sess-1-ai-tab-1', 'back to thinking');
				flushRaf();
				const tabAfter = s1_useSessionStore.getState().sessions[0].aiTabs[0];
				expect(tabAfter.logs).toHaveLength(3);
				expect(tabAfter.logs[2].source).toBe('thinking');
				expect(tabAfter.logs[2].text).toBe('back to thinking');
			});
		});
		it('ignores non-AI session ids', () => {
			const tab = s1_createMockAITab({ id: 'tab-1', showThinking: 'on' });
			const session = s1_createMockSession({ id: 'sess-1', aiTabs: [tab] });
			s1_useSessionStore.setState({ sessions: [session] } as any);
			s1_renderHook(() => useAgentThinkingListener());
			handler!('sess-1-terminal', 'data');
			flushRaf();
			expect(s1_useSessionStore.getState().sessions[0].aiTabs[0].logs).toHaveLength(0);
		});
	});
});
// Source: src/__tests__/renderer/hooks/agent/internal/useAgentToolExecutionListener.test.tsx
describe('', () => {
	let handler: ((sessionId: string, toolEvent: any) => void) | undefined;
	const mockUnsubscribe = vi.fn();
	const mockProcess = {
		onToolExecution: vi.fn((h: any) => {
			handler = h;
			return mockUnsubscribe;
		}),
	};
	beforeEach(() => {
		vi.clearAllMocks();
		handler = undefined;
		s2_useSessionStore.setState({
			sessions: [],
			groups: [],
			activeSessionId: '',
			initialLoadComplete: false,
			removedWorktreePaths: new Set(),
		});
		(window as any).maestro = { ...((window as any).maestro || {}), process: mockProcess };
	});
	describe('useAgentToolExecutionListener', () => {
		it('reports a tool call to the retry engine', () => {
			const tab = s2_createMockAITab({ id: 'tab-1', showThinking: 'off' });
			const session = s2_createMockSession({ id: 'sess-1', aiTabs: [tab] });
			s2_useSessionStore.setState({ sessions: [session] } as any);
			s2_renderHook(() => useAgentToolExecutionListener());
			handler!('sess-1-ai-tab-1', {
				toolName: 'Read',
				state: { status: 'running' },
				timestamp: 1,
				toolCallId: 'c1',
			});
			expect(s2_noteRetryProgress).toHaveBeenCalledWith('sess-1', 'tab-1');
		});
		it('appends a tool log when targetTab has thinking enabled', () => {
			const tab = s2_createMockAITab({ id: 'tab-1', showThinking: 'on' });
			const session = s2_createMockSession({ id: 'sess-1', aiTabs: [tab] });
			s2_useSessionStore.setState({ sessions: [session] } as any);
			s2_renderHook(() => useAgentToolExecutionListener());
			handler!('sess-1-ai-tab-1', {
				toolName: 'Read',
				state: { status: 'running' },
				timestamp: 1700000000000,
				toolCallId: 'call-1',
			});
			const updated = s2_useSessionStore.getState().sessions[0].aiTabs[0];
			expect(updated.logs).toHaveLength(1);
			expect(updated.logs[0].source).toBe('tool');
			expect(updated.logs[0].text).toBe('Read');
		});
		it('merges completed event into a previously-running entry by toolCallId', () => {
			const tab = s2_createMockAITab({ id: 'tab-1', showThinking: 'on' });
			const session = s2_createMockSession({ id: 'sess-1', aiTabs: [tab] });
			s2_useSessionStore.setState({ sessions: [session] } as any);
			s2_renderHook(() => useAgentToolExecutionListener());
			handler!('sess-1-ai-tab-1', {
				toolName: 'Read',
				state: { status: 'running' },
				timestamp: 1,
				toolCallId: 'c1',
			});
			handler!('sess-1-ai-tab-1', {
				toolName: 'Read',
				state: { status: 'completed', output: 'ok' },
				timestamp: 2,
				toolCallId: 'c1',
			});
			const tabAfter = s2_useSessionStore.getState().sessions[0].aiTabs[0];
			expect(tabAfter.logs).toHaveLength(1);
			expect(tabAfter.logs[0].metadata?.toolState?.status).toBe('completed');
			expect(tabAfter.logs[0].metadata?.toolState?.output).toBe('ok');
		});
		it('records tool events even when showThinking is off (hidden at render)', () => {
			const tab = s2_createMockAITab({ id: 'tab-1', showThinking: 'off' });
			const session = s2_createMockSession({ id: 'sess-1', aiTabs: [tab] });
			s2_useSessionStore.setState({ sessions: [session] } as any);
			s2_renderHook(() => useAgentToolExecutionListener());
			handler!('sess-1-ai-tab-1', {
				toolName: 'Read',
				state: { status: 'running' },
				timestamp: 1,
				toolCallId: 'c1',
			});
			expect(s2_useSessionStore.getState().sessions[0].aiTabs[0].logs).toHaveLength(1);
		});
		it('records tool events when showThinking is not set', () => {
			const tab = s2_createMockAITab({ id: 'tab-1' });
			const session = s2_createMockSession({ id: 'sess-1', aiTabs: [tab] });
			s2_useSessionStore.setState({ sessions: [session] } as any);
			s2_renderHook(() => useAgentToolExecutionListener());
			handler!('sess-1-ai-tab-1', {
				toolName: 'Read',
				state: { status: 'running' },
				timestamp: 1,
				toolCallId: 'c1',
			});
			expect(s2_useSessionStore.getState().sessions[0].aiTabs[0].logs).toHaveLength(1);
		});
		it('attributes finalising event to most recent running entry without toolCallId', () => {
			const tab = s2_createMockAITab({
				id: 'tab-1',
				showThinking: 'on',
				logs: [
					{
						id: 'tool-prev',
						timestamp: 1,
						source: 'tool',
						text: 'Bash',
						metadata: { toolState: { status: 'running' } },
					},
				],
			});
			const session = s2_createMockSession({ id: 'sess-1', aiTabs: [tab] });
			s2_useSessionStore.setState({ sessions: [session] } as any);
			s2_renderHook(() => useAgentToolExecutionListener());
			handler!('sess-1-ai-tab-1', {
				toolName: 'Bash',
				state: { status: 'completed' },
				timestamp: 2,
			});
			const updated = s2_useSessionStore.getState().sessions[0].aiTabs[0];
			expect(updated.logs).toHaveLength(1);
			expect(updated.logs[0].metadata?.toolState?.status).toBe('completed');
		});
		it('skips no-op render when session is missing (orphan event)', () => {
			const setSessionsSpy = vi.spyOn(s2_useSessionStore.getState(), 'setSessions');
			s2_renderHook(() => useAgentToolExecutionListener());
			handler!('missing-session-ai-tab-1', { toolName: 'Read', timestamp: 1 });
			expect(setSessionsSpy).not.toHaveBeenCalled();
		});
		it('ignores non-AI session ids', () => {
			const tab = s2_createMockAITab({ id: 'tab-1', showThinking: 'on' });
			const session = s2_createMockSession({ id: 'sess-1', aiTabs: [tab] });
			s2_useSessionStore.setState({ sessions: [session] } as any);
			s2_renderHook(() => useAgentToolExecutionListener());
			handler!('sess-1-terminal', { toolName: 'Read', timestamp: 1 });
			expect(s2_useSessionStore.getState().sessions[0].aiTabs[0].logs).toHaveLength(0);
		});
		it('tags new tool logs with renderStyle:text-stream when session is in interactive mode', () => {
			const tab = s2_createMockAITab({ id: 'tab-1', showThinking: 'on' });
			const session = s2_createMockSession({
				id: 'sess-1',
				aiTabs: [tab],
				claudeInteractive: { mode: 'interactive', modeReason: 'auto' },
			});
			s2_useSessionStore.setState({ sessions: [session] } as any);
			s2_renderHook(() => useAgentToolExecutionListener());
			handler!('sess-1-ai-tab-1', {
				toolName: 'Bash',
				state: { status: 'running' },
				timestamp: 1,
				toolCallId: 'c1',
			});
			const log = s2_useSessionStore.getState().sessions[0].aiTabs[0].logs[0];
			expect(log.renderStyle).toBe('text-stream');
		});
		it('stores parentToolUseId in metadata for subagent tool events', () => {
			const tab = s2_createMockAITab({ id: 'tab-1', showThinking: 'on' });
			const session = s2_createMockSession({ id: 'sess-1', aiTabs: [tab] });
			s2_useSessionStore.setState({ sessions: [session] } as any);
			s2_renderHook(() => useAgentToolExecutionListener());
			handler!('sess-1-ai-tab-1', {
				toolName: 'Grep',
				state: { status: 'running' },
				timestamp: 1,
				toolCallId: 'child-1',
				parentToolUseId: 'toolu_task_1',
			});
			const log = s2_useSessionStore.getState().sessions[0].aiTabs[0].logs[0];
			expect(log.metadata?.parentToolUseId).toBe('toolu_task_1');
		});
		it('preserves parentToolUseId when a later event omits it', () => {
			const tab = s2_createMockAITab({ id: 'tab-1', showThinking: 'on' });
			const session = s2_createMockSession({ id: 'sess-1', aiTabs: [tab] });
			s2_useSessionStore.setState({ sessions: [session] } as any);
			s2_renderHook(() => useAgentToolExecutionListener());
			handler!('sess-1-ai-tab-1', {
				toolName: 'Grep',
				state: { status: 'running' },
				timestamp: 1,
				toolCallId: 'child-1',
				parentToolUseId: 'toolu_task_1',
			});
			handler!('sess-1-ai-tab-1', {
				toolName: 'Grep',
				state: { status: 'completed', output: 'done' },
				timestamp: 2,
				toolCallId: 'child-1',
			});
			const logs = s2_useSessionStore.getState().sessions[0].aiTabs[0].logs;
			expect(logs).toHaveLength(1);
			expect(logs[0].metadata?.parentToolUseId).toBe('toolu_task_1');
			expect(logs[0].metadata?.toolState?.status).toBe('completed');
		});
		it('omits parentToolUseId for main-transcript tool events', () => {
			const tab = s2_createMockAITab({ id: 'tab-1', showThinking: 'on' });
			const session = s2_createMockSession({ id: 'sess-1', aiTabs: [tab] });
			s2_useSessionStore.setState({ sessions: [session] } as any);
			s2_renderHook(() => useAgentToolExecutionListener());
			handler!('sess-1-ai-tab-1', {
				toolName: 'Read',
				state: { status: 'running' },
				timestamp: 1,
				toolCallId: 'c1',
			});
			const log = s2_useSessionStore.getState().sessions[0].aiTabs[0].logs[0];
			expect(log.metadata?.parentToolUseId).toBeUndefined();
		});
		it('omits renderStyle on tool logs when session is in api mode', () => {
			const tab = s2_createMockAITab({ id: 'tab-1', showThinking: 'on' });
			const session = s2_createMockSession({
				id: 'sess-1',
				aiTabs: [tab],
				claudeInteractive: { mode: 'api', modeReason: 'auto' },
			});
			s2_useSessionStore.setState({ sessions: [session] } as any);
			s2_renderHook(() => useAgentToolExecutionListener());
			handler!('sess-1-ai-tab-1', {
				toolName: 'Bash',
				state: { status: 'running' },
				timestamp: 1,
				toolCallId: 'c1',
			});
			const log = s2_useSessionStore.getState().sessions[0].aiTabs[0].logs[0];
			expect(log.renderStyle).toBeUndefined();
		});
	});
});
