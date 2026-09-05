/**
 * useThoughtStreamToolListener tests
 *
 * The action half of the Thought Stream. What matters here:
 * - Auto Run `-batch-` tool calls ARE captured (the in-chat transcript listener
 *   matches `REGEX_AI_TAB` only, so an Auto Run has no other surface at all).
 * - Interactive `-ai-` tool calls are NOT (same scoping as the thinking
 *   listener; capturing them is what once made the panel show ordinary chat).
 * - Provider status wording normalizes onto running/completed/failed.
 * - A completion merges into its start rather than appending a second row.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useThoughtStreamToolListener } from '../../../../../renderer/hooks/agent/internal/useThoughtStreamToolListener';
import {
	useThoughtStreamStore,
	isToolEvent,
	type ToolActivityEntry,
} from '../../../../../renderer/stores/thoughtStreamStore';

type ToolHandler = (
	sessionId: string,
	toolEvent: { toolName: string; state?: unknown; timestamp: number; toolCallId?: string }
) => void;

let toolHandler: ToolHandler | undefined;
const mockUnsubscribe = vi.fn();

const SESSION_ID = 'session-abc';
const BATCH = `${SESSION_ID}-batch-1700000000000`;

/** Tool events for a session, in timeline order. */
function toolEvents(sessionId = SESSION_ID): ToolActivityEntry[] {
	const entries = useThoughtStreamStore.getState().buffers[sessionId]?.entries ?? [];
	return entries.filter(isToolEvent);
}

beforeEach(() => {
	vi.clearAllMocks();
	toolHandler = undefined;

	(window as any).maestro = {
		...((window as any).maestro || {}),
		process: {
			...((window as any).maestro?.process || {}),
			onToolExecution: vi.fn((h: ToolHandler) => {
				toolHandler = h;
				return mockUnsubscribe;
			}),
		},
	};

	useThoughtStreamStore.setState({ panelSessionId: null, buffers: {} });
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('useThoughtStreamToolListener', () => {
	it('captures Auto Run tool calls despite the `-batch-` streaming id', () => {
		// The gap this feature exists to close: `useAgentToolExecutionListener`
		// matches REGEX_AI_TAB, so during an Auto Run every tool call was dropped
		// and no surface anywhere showed what the agent was doing.
		renderHook(() => useThoughtStreamToolListener());

		act(() => {
			toolHandler?.(BATCH, {
				toolName: 'Bash',
				state: { status: 'running', input: { command: 'npm test' } },
				timestamp: 1000,
			});
		});

		const events = toolEvents();
		expect(events).toHaveLength(1);
		expect(events[0].tool.name).toBe('Bash');
		expect(events[0].tool.label).toEqual({ verb: 'Ran', target: 'npm test' });
		expect(events[0].tool.status).toBe('running');
	});

	it('does not capture interactive `-ai-` tab tool calls', () => {
		renderHook(() => useThoughtStreamToolListener());

		act(() => {
			toolHandler?.(`${SESSION_ID}-ai-tab1`, {
				toolName: 'Read',
				state: { status: 'completed', input: { file_path: '/tmp/a.ts' } },
				timestamp: 1000,
			});
		});

		expect(useThoughtStreamStore.getState().buffers[SESSION_ID]).toBeUndefined();
	});

	it('does not capture synopsis spawns', () => {
		renderHook(() => useThoughtStreamToolListener());

		act(() => {
			toolHandler?.(`${SESSION_ID}-synopsis-1700000000000`, {
				toolName: 'Read',
				state: { status: 'completed' },
				timestamp: 1000,
			});
		});

		expect(useThoughtStreamStore.getState().buffers[SESSION_ID]).toBeUndefined();
	});

	it('merges a completion into the call it started, keeping one row', () => {
		renderHook(() => useThoughtStreamToolListener());

		act(() => {
			toolHandler?.(BATCH, {
				toolName: 'Bash',
				state: { status: 'running', input: { command: 'npm test' } },
				timestamp: 1000,
				toolCallId: 'call-1',
			});
			toolHandler?.(BATCH, {
				toolName: 'Bash',
				state: { status: 'completed' },
				timestamp: 8000,
				toolCallId: 'call-1',
			});
		});

		const events = toolEvents();
		expect(events).toHaveLength(1);
		expect(events[0].tool.status).toBe('completed');
		// The row keeps its START time so it does not jump position on finishing.
		expect(events[0].timestamp).toBe(1000);
		expect(events[0].tool.endedAt).toBe(8000);
	});

	it('normalizes `error` onto `failed`', () => {
		renderHook(() => useThoughtStreamToolListener());

		act(() => {
			toolHandler?.(BATCH, {
				toolName: 'Bash',
				state: { status: 'error' },
				timestamp: 1000,
			});
		});

		expect(toolEvents()[0].tool.status).toBe('failed');
	});

	it('marks a Codex shell failure as failed even though it reports `completed`', () => {
		// The end-to-end shape of the regression: codex-output-parser reports a
		// non-zero shell exit as `status: 'completed'` and puts the outcome in
		// exit_code, so a listener reading the word alone drew a check mark next
		// to a failed build - in the one feed built for spotting that.
		renderHook(() => useThoughtStreamToolListener());

		act(() => {
			toolHandler?.(BATCH, {
				toolName: 'shell',
				state: { status: 'completed', input: { command: 'npm test' }, exitCode: 1 },
				timestamp: 1000,
			});
		});

		const event = toolEvents()[0];
		expect(event.tool.status).toBe('failed');
		expect(event.tool.label).toEqual({ verb: 'Ran', target: 'npm test' });
	});

	it('leaves a clean Codex shell run a success', () => {
		renderHook(() => useThoughtStreamToolListener());

		act(() => {
			toolHandler?.(BATCH, {
				toolName: 'shell',
				state: { status: 'completed', input: { command: 'npm test' }, exitCode: 0 },
				timestamp: 1000,
			});
		});

		expect(toolEvents()[0].tool.status).toBe('completed');
	});

	it('treats a missing status as still running', () => {
		// An unfinished call is the reading that cannot mislead: it resolves
		// itself the moment a completion arrives.
		renderHook(() => useThoughtStreamToolListener());

		act(() => {
			toolHandler?.(BATCH, { toolName: 'Bash', timestamp: 1000 });
		});

		expect(toolEvents()[0].tool.status).toBe('running');
	});

	it('interleaves with reasoning on ONE timeline, in arrival order', () => {
		renderHook(() => useThoughtStreamToolListener());
		const { appendThought } = useThoughtStreamStore.getState();

		act(() => {
			appendThought(SESSION_ID, BATCH, 'let me check the tests ');
			toolHandler?.(BATCH, {
				toolName: 'Bash',
				state: { status: 'completed', input: { command: 'npm test' } },
				timestamp: 2000,
			});
			appendThought(SESSION_ID, BATCH, 'they passed');
		});

		const entries = useThoughtStreamStore.getState().buffers[SESSION_ID].entries;
		expect(entries.map(isToolEvent)).toEqual([false, true, false]);
	});

	it('keeps parallel runs in their own buffers', () => {
		renderHook(() => useThoughtStreamToolListener());

		act(() => {
			toolHandler?.(BATCH, { toolName: 'Bash', state: { status: 'running' }, timestamp: 1 });
			toolHandler?.('other-session-batch-1700000000000', {
				toolName: 'Read',
				state: { status: 'running' },
				timestamp: 2,
			});
		});

		expect(toolEvents().map((e) => e.tool.name)).toEqual(['Bash']);
		expect(toolEvents('other-session').map((e) => e.tool.name)).toEqual(['Read']);
	});

	it('unsubscribes on unmount', () => {
		const { unmount } = renderHook(() => useThoughtStreamToolListener());
		act(() => unmount());
		expect(mockUnsubscribe).toHaveBeenCalled();
	});
});
