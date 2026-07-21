import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAgentToolExecutionListener } from '../../../../../renderer/hooks/agent/internal/useAgentToolExecutionListener';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { createMockSession } from '../../../../helpers/mockSession';
import { createMockAITab } from '../../../../helpers/mockTab';

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
	useSessionStore.setState({
		sessions: [],
		groups: [],
		activeSessionId: '',
		initialLoadComplete: false,
		removedWorktreePaths: new Set(),
	});
	(window as any).maestro = { ...((window as any).maestro || {}), process: mockProcess };
});

describe('useAgentToolExecutionListener', () => {
	it('appends a tool log when targetTab has thinking enabled', () => {
		const tab = createMockAITab({ id: 'tab-1', showThinking: 'on' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab] });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentToolExecutionListener());
		handler!('sess-1-ai-tab-1', {
			toolName: 'Read',
			state: { status: 'running' },
			timestamp: 1700000000000,
			toolCallId: 'call-1',
		});

		const updated = useSessionStore.getState().sessions[0].aiTabs[0];
		expect(updated.logs).toHaveLength(1);
		expect(updated.logs[0].source).toBe('tool');
		expect(updated.logs[0].text).toBe('Read');
	});

	it('merges completed event into a previously-running entry by toolCallId', () => {
		const tab = createMockAITab({ id: 'tab-1', showThinking: 'on' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab] });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentToolExecutionListener());
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

		const tabAfter = useSessionStore.getState().sessions[0].aiTabs[0];
		expect(tabAfter.logs).toHaveLength(1);
		expect(tabAfter.logs[0].metadata?.toolState?.status).toBe('completed');
		expect(tabAfter.logs[0].metadata?.toolState?.output).toBe('ok');
	});

	it('records tool events even when showThinking is off (hidden at render)', () => {
		const tab = createMockAITab({ id: 'tab-1', showThinking: 'off' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab] });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentToolExecutionListener());
		handler!('sess-1-ai-tab-1', {
			toolName: 'Read',
			state: { status: 'running' },
			timestamp: 1,
			toolCallId: 'c1',
		});

		expect(useSessionStore.getState().sessions[0].aiTabs[0].logs).toHaveLength(1);
	});

	it('records tool logs when showTools is true even if showThinking is off', () => {
		const tab = createMockAITab({ id: 'tab-1', showThinking: 'off', showTools: true });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab] });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentToolExecutionListener());
		handler!('sess-1-ai-tab-1', {
			toolName: 'Read',
			state: { status: 'running' },
			timestamp: 1,
			toolCallId: 'c1',
		});

		expect(useSessionStore.getState().sessions[0].aiTabs[0].logs).toHaveLength(1);
	});

	it('records tool events even when showTools is false (hidden at render, never dropped)', () => {
		const tab = createMockAITab({ id: 'tab-1', showThinking: 'on', showTools: false });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab] });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentToolExecutionListener());
		handler!('sess-1-ai-tab-1', {
			toolName: 'Read',
			state: { status: 'running' },
			timestamp: 1,
			toolCallId: 'c1',
		});

		expect(useSessionStore.getState().sessions[0].aiTabs[0].logs).toHaveLength(1);
	});

	it('records tool events when neither showTools nor showThinking is set', () => {
		const tab = createMockAITab({ id: 'tab-1' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab] });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentToolExecutionListener());
		handler!('sess-1-ai-tab-1', {
			toolName: 'Read',
			state: { status: 'running' },
			timestamp: 1,
			toolCallId: 'c1',
		});

		expect(useSessionStore.getState().sessions[0].aiTabs[0].logs).toHaveLength(1);
	});

	it('attributes finalising event to most recent running entry without toolCallId', () => {
		const tab = createMockAITab({
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
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab] });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentToolExecutionListener());
		handler!('sess-1-ai-tab-1', {
			toolName: 'Bash',
			state: { status: 'completed' },
			timestamp: 2,
		});

		const updated = useSessionStore.getState().sessions[0].aiTabs[0];
		expect(updated.logs).toHaveLength(1);
		expect(updated.logs[0].metadata?.toolState?.status).toBe('completed');
	});

	it('skips no-op render when session is missing (orphan event)', () => {
		const setSessionsSpy = vi.spyOn(useSessionStore.getState(), 'setSessions');
		renderHook(() => useAgentToolExecutionListener());
		handler!('missing-session-ai-tab-1', { toolName: 'Read', timestamp: 1 });
		expect(setSessionsSpy).not.toHaveBeenCalled();
	});

	it('ignores non-AI session ids', () => {
		const tab = createMockAITab({ id: 'tab-1', showThinking: 'on' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab] });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentToolExecutionListener());
		handler!('sess-1-terminal', { toolName: 'Read', timestamp: 1 });

		expect(useSessionStore.getState().sessions[0].aiTabs[0].logs).toHaveLength(0);
	});

	it('tags new tool logs with renderStyle:text-stream when session is in interactive mode', () => {
		const tab = createMockAITab({ id: 'tab-1', showThinking: 'on' });
		const session = createMockSession({
			id: 'sess-1',
			aiTabs: [tab],
			claudeInteractive: { mode: 'interactive', modeReason: 'auto' },
		});
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentToolExecutionListener());
		handler!('sess-1-ai-tab-1', {
			toolName: 'Bash',
			state: { status: 'running' },
			timestamp: 1,
			toolCallId: 'c1',
		});

		const log = useSessionStore.getState().sessions[0].aiTabs[0].logs[0];
		expect(log.renderStyle).toBe('text-stream');
	});

	it('stores parentToolUseId in metadata for subagent tool events', () => {
		const tab = createMockAITab({ id: 'tab-1', showThinking: 'on' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab] });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentToolExecutionListener());
		handler!('sess-1-ai-tab-1', {
			toolName: 'Grep',
			state: { status: 'running' },
			timestamp: 1,
			toolCallId: 'child-1',
			parentToolUseId: 'toolu_task_1',
		});

		const log = useSessionStore.getState().sessions[0].aiTabs[0].logs[0];
		expect(log.metadata?.parentToolUseId).toBe('toolu_task_1');
	});

	it('preserves parentToolUseId when a later event omits it', () => {
		const tab = createMockAITab({ id: 'tab-1', showThinking: 'on' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab] });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentToolExecutionListener());
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

		const logs = useSessionStore.getState().sessions[0].aiTabs[0].logs;
		expect(logs).toHaveLength(1);
		expect(logs[0].metadata?.parentToolUseId).toBe('toolu_task_1');
		expect(logs[0].metadata?.toolState?.status).toBe('completed');
	});

	it('omits parentToolUseId for main-transcript tool events', () => {
		const tab = createMockAITab({ id: 'tab-1', showThinking: 'on' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab] });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentToolExecutionListener());
		handler!('sess-1-ai-tab-1', {
			toolName: 'Read',
			state: { status: 'running' },
			timestamp: 1,
			toolCallId: 'c1',
		});

		const log = useSessionStore.getState().sessions[0].aiTabs[0].logs[0];
		expect(log.metadata?.parentToolUseId).toBeUndefined();
	});

	it('omits renderStyle on tool logs when session is in api mode', () => {
		const tab = createMockAITab({ id: 'tab-1', showThinking: 'on' });
		const session = createMockSession({
			id: 'sess-1',
			aiTabs: [tab],
			claudeInteractive: { mode: 'api', modeReason: 'auto' },
		});
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentToolExecutionListener());
		handler!('sess-1-ai-tab-1', {
			toolName: 'Bash',
			state: { status: 'running' },
			timestamp: 1,
			toolCallId: 'c1',
		});

		const log = useSessionStore.getState().sessions[0].aiTabs[0].logs[0];
		expect(log.renderStyle).toBeUndefined();
	});
});
