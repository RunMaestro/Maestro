import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useThoughtStreamToolListener } from '../../../../../renderer/hooks/agent/internal/useThoughtStreamToolListener';
import { useThoughtStreamStore } from '../../../../../renderer/stores/thoughtStreamStore';

type ToolEvent = {
	toolName: string;
	state?: unknown;
	timestamp: number;
	toolCallId?: string;
};

// Capture the registered onToolExecution handler so tests can drive it directly.
let toolHandler: ((sessionId: string, toolEvent: ToolEvent) => void) | undefined;
const mockUnsubscribe = vi.fn();

const SESSION_ID = 'session-abc';

beforeEach(() => {
	vi.clearAllMocks();
	toolHandler = undefined;

	(window as any).maestro = {
		...((window as any).maestro || {}),
		process: {
			...((window as any).maestro?.process || {}),
			onToolExecution: vi.fn((h: (sessionId: string, toolEvent: ToolEvent) => void) => {
				toolHandler = h;
				return mockUnsubscribe;
			}),
		},
	};

	useThoughtStreamStore.setState({
		panelSessionId: null,
		minimized: false,
		buffers: {},
		capturing: {},
	});
});

const activities = (sessionId = SESSION_ID) =>
	useThoughtStreamStore.getState().buffers[sessionId]?.activities ?? [];

describe('useThoughtStreamToolListener', () => {
	it('captures tool calls from an Auto Run despite the `-batch-` streaming id', () => {
		// The in-chat listener matches with REGEX_AI_TAB alone, so it never sees an
		// Auto Run's tool calls. This listener resolves the id with parseSessionId.
		renderHook(() => useThoughtStreamToolListener());
		act(() => useThoughtStreamStore.getState().openPanel(SESSION_ID));

		act(() => {
			toolHandler?.(`${SESSION_ID}-batch-1699999999999`, {
				toolName: 'Bash',
				state: { status: 'running', input: { command: 'npm test' } },
				timestamp: 1000,
				toolCallId: 'call-1',
			});
		});

		expect(activities()).toHaveLength(1);
		expect(activities()[0].verb).toBe('Ran');
		expect(activities()[0].target).toBe('npm test');
		expect(activities()[0].status).toBe('running');
	});

	it('captures interactive `-ai-` tab tool calls and tags the tab', () => {
		renderHook(() => useThoughtStreamToolListener());
		act(() => useThoughtStreamStore.getState().openPanel(SESSION_ID));

		act(() => {
			toolHandler?.(`${SESSION_ID}-ai-tab1`, {
				toolName: 'Read',
				state: { status: 'running', input: { file_path: 'src/App.tsx' } },
				timestamp: 2000,
				toolCallId: 'call-2',
			});
		});

		expect(activities()[0].tabId).toBe('tab1');
		expect(activities()[0].verb).toBe('Read');
	});

	it('merges the completion event into the same line', () => {
		renderHook(() => useThoughtStreamToolListener());
		act(() => useThoughtStreamStore.getState().openPanel(SESSION_ID));

		act(() => {
			toolHandler?.(`${SESSION_ID}-ai-tab1`, {
				toolName: 'Read',
				state: { status: 'running', input: { file_path: 'a.ts' } },
				timestamp: 1000,
				toolCallId: 'call-3',
			});
			toolHandler?.(`${SESSION_ID}-ai-tab1`, {
				toolName: 'Read',
				state: { status: 'completed' },
				timestamp: 1500,
				toolCallId: 'call-3',
			});
		});

		expect(activities()).toHaveLength(1);
		expect(activities()[0].status).toBe('completed');
		expect(activities()[0].target).toBe('a.ts');
	});

	it("normalizes a provider's `error` status onto `failed`", () => {
		renderHook(() => useThoughtStreamToolListener());
		act(() => useThoughtStreamStore.getState().openPanel(SESSION_ID));

		act(() => {
			toolHandler?.(`${SESSION_ID}-ai-tab1`, {
				toolName: 'Bash',
				state: { status: 'error', input: { command: 'false' } },
				timestamp: 1000,
				toolCallId: 'call-4',
			});
		});

		expect(activities()[0].status).toBe('failed');
	});

	it('treats a missing status as still running', () => {
		renderHook(() => useThoughtStreamToolListener());
		act(() => useThoughtStreamStore.getState().openPanel(SESSION_ID));

		act(() => {
			toolHandler?.(`${SESSION_ID}-ai-tab1`, {
				toolName: 'Grep',
				state: { input: { pattern: 'TODO' } },
				timestamp: 1000,
			});
		});

		expect(activities()[0].status).toBe('running');
		expect(activities()[0].verb).toBe('Searched for');
	});

	it('drops tool calls for a session that is not capturing', () => {
		renderHook(() => useThoughtStreamToolListener());
		// No openPanel - nothing is capturing.

		act(() => {
			toolHandler?.(`${SESSION_ID}-ai-tab1`, {
				toolName: 'Read',
				state: { status: 'running', input: { file_path: 'a.ts' } },
				timestamp: 1000,
			});
		});

		expect(useThoughtStreamStore.getState().buffers[SESSION_ID]).toBeUndefined();
	});

	it('does not cross-contaminate a different session', () => {
		renderHook(() => useThoughtStreamToolListener());
		act(() => useThoughtStreamStore.getState().openPanel(SESSION_ID));

		act(() => {
			toolHandler?.('other-session-ai-tab1', {
				toolName: 'Read',
				state: { status: 'running', input: { file_path: 'not-mine.ts' } },
				timestamp: 1000,
			});
		});

		expect(activities()).toHaveLength(0);
		expect(useThoughtStreamStore.getState().buffers['other-session']).toBeUndefined();
	});

	it('unsubscribes on unmount', () => {
		const { unmount } = renderHook(() => useThoughtStreamToolListener());
		unmount();
		expect(mockUnsubscribe).toHaveBeenCalled();
	});
});
