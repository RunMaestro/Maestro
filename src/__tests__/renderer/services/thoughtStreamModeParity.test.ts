/**
 * P5: an Auto Run's Thought Stream reads the same in every mode. A local and an SSH run feed it
 * from this machine's process events (`useThoughtStreamCaptureListener`,
 * `useThoughtStreamToolListener`); a hosted run feeds it from its host's run events
 * (`feedHostedAutoRunActivity()`), through the same coalescer and the same tool line.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useThoughtStreamCaptureListener } from '../../../renderer/hooks/agent/internal/useThoughtStreamCaptureListener';
import { useThoughtStreamToolListener } from '../../../renderer/hooks/agent/internal/useThoughtStreamToolListener';
import {
	feedHostedAutoRunActivity,
	flushHostedAutoRunActivity,
} from '../../../renderer/services/hostedAgentSync';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import {
	THOUGHT_FLUSH_MS,
	isToolEvent,
	useThoughtStreamStore,
} from '../../../renderer/stores/thoughtStreamStore';
import { AGENT_MODES, createModeSession, type AgentMode } from '../../helpers/mockSession';
import type { MirrorPush } from '../../../shared/maestro-lib/client/peer-mirror';

type ThinkingHandler = (sessionId: string, content: string) => void;
type ToolHandler = (
	sessionId: string,
	toolEvent: { toolName: string; state?: unknown; timestamp: number; toolCallId?: string }
) => void;

let thinkingHandler: ThinkingHandler | undefined;
let toolHandler: ToolHandler | undefined;

const SESSION_ID = 'agent-1';
const READ_RUNNING = { status: 'running', input: { file_path: '/w/src/a.ts' } };
const READ_DONE = { status: 'completed', input: { file_path: '/w/src/a.ts' } };

/** The same task's work, as the run's own machine reports it. */
function runTheTask(mode: AgentMode): void {
	if (mode !== 'hosted') {
		const processId = `${SESSION_ID}-batch-1700000000000`;
		act(() => {
			thinkingHandler?.(processId, 'First I read ');
			thinkingHandler?.(processId, 'the source.');
			vi.advanceTimersByTime(THOUGHT_FLUSH_MS);
			toolHandler?.(processId, {
				toolName: 'Read',
				state: READ_RUNNING,
				timestamp: 10,
				toolCallId: 'c1',
			});
			toolHandler?.(processId, {
				toolName: 'Read',
				state: READ_DONE,
				timestamp: 20,
				toolCallId: 'c1',
			});
		});
		return;
	}
	const processId = 'h1-batch-1700000000000';
	const push = (activity: Record<string, unknown>): MirrorPush =>
		({
			peerId: 'box',
			event: { type: 'agent.autorunActivity', agentId: 'h1', activity },
		}) as MirrorPush;
	act(() => {
		feedHostedAutoRunActivity(push({ kind: 'thinking', at: 1, processId, text: 'First I read ' }));
		feedHostedAutoRunActivity(push({ kind: 'thinking', at: 2, processId, text: 'the source.' }));
		feedHostedAutoRunActivity(
			push({
				kind: 'tool',
				at: 10,
				processId,
				toolName: 'Read',
				state: READ_RUNNING,
				toolCallId: 'c1',
			})
		);
		feedHostedAutoRunActivity(
			push({
				kind: 'tool',
				at: 20,
				processId,
				toolName: 'Read',
				state: READ_DONE,
				toolCallId: 'c1',
			})
		);
		vi.advanceTimersByTime(THOUGHT_FLUSH_MS);
	});
}

/** What the panel draws: the counts and each entry, without ids or the run's process key. */
function drawnStream() {
	const entries = useThoughtStreamStore.getState().buffers[SESSION_ID]?.entries ?? [];
	return {
		thoughts: entries.filter((entry) => !isToolEvent(entry)).length,
		actions: entries.filter(isToolEvent).length,
		entries: entries.map((entry) =>
			isToolEvent(entry)
				? {
						tool: entry.tool.name,
						label: entry.tool.label,
						status: entry.tool.status,
						at: entry.timestamp,
					}
				: { thought: entry.text }
		),
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	thinkingHandler = undefined;
	toolHandler = undefined;
	(window as any).maestro = {
		...((window as any).maestro || {}),
		process: {
			...((window as any).maestro?.process || {}),
			onThinkingChunk: vi.fn((handler: ThinkingHandler) => {
				thinkingHandler = handler;
				return () => undefined;
			}),
			onToolExecution: vi.fn((handler: ToolHandler) => {
				toolHandler = handler;
				return () => undefined;
			}),
		},
	};
	useThoughtStreamStore.setState({ panelSessionId: null, buffers: {} });
	useSettingsStore.setState({ federationHostedAgents: true });
});

afterEach(() => {
	flushHostedAutoRunActivity();
	useSessionStore.setState({ sessions: [] });
	vi.useRealTimers();
});

describe('Auto Run Thought Stream across modes (P5)', () => {
	function streamFor(mode: AgentMode) {
		useThoughtStreamStore.setState({ panelSessionId: null, buffers: {} });
		useSessionStore.setState({ sessions: [createModeSession(mode, { id: SESSION_ID })] });
		const thinking = renderHook(() => useThoughtStreamCaptureListener());
		const tools = renderHook(() => useThoughtStreamToolListener());
		runTheTask(mode);
		thinking.unmount();
		tools.unmount();
		return drawnStream();
	}

	it('draws the same thoughts and actions in all three modes', () => {
		const [local, ssh, hosted] = AGENT_MODES.map(streamFor);
		expect(local).toEqual({
			thoughts: 1,
			actions: 1,
			entries: [
				{ thought: 'First I read the source.' },
				{ tool: 'Read', label: expect.anything(), status: 'completed', at: 10 },
			],
		});
		expect(ssh).toEqual(local);
		expect(hosted).toEqual(local);
	});

	it('puts a tool call after the reasoning still being joined before it, in every mode', () => {
		for (const mode of AGENT_MODES) {
			useThoughtStreamStore.setState({ panelSessionId: null, buffers: {} });
			useSessionStore.setState({ sessions: [createModeSession(mode, { id: SESSION_ID })] });
			const thinking = renderHook(() => useThoughtStreamCaptureListener());
			const tools = renderHook(() => useThoughtStreamToolListener());
			act(() => {
				if (mode === 'hosted') {
					const processId = 'h1-batch-1';
					const push = (activity: Record<string, unknown>) =>
						feedHostedAutoRunActivity({
							peerId: 'box',
							event: { type: 'agent.autorunActivity', agentId: 'h1', activity },
						} as MirrorPush);
					push({ kind: 'thinking', at: 1, processId, text: 'Reading first' });
					push({ kind: 'tool', at: 2, processId, toolName: 'Read', state: READ_RUNNING });
				} else {
					const processId = `${SESSION_ID}-batch-1`;
					thinkingHandler?.(processId, 'Reading first');
					toolHandler?.(processId, { toolName: 'Read', state: READ_RUNNING, timestamp: 2 });
				}
				vi.advanceTimersByTime(THOUGHT_FLUSH_MS);
			});
			thinking.unmount();
			tools.unmount();
			const kinds = drawnStream().entries.map((entry) => ('thought' in entry ? 'thought' : 'tool'));
			expect({ mode, kinds }).toEqual({ mode, kinds: ['thought', 'tool'] });
		}
	});

	it('feeds nothing for a host agent no record is drawn as, or with hosted agents off', () => {
		useSessionStore.setState({ sessions: [createModeSession('hosted', { id: SESSION_ID })] });
		const activity = { kind: 'thinking', at: 1, processId: 'x-batch-1', text: 'hmm' };
		const other = {
			peerId: 'box',
			event: { type: 'agent.autorunActivity', agentId: 'someone-else', activity },
		} as MirrorPush;
		act(() => {
			expect(feedHostedAutoRunActivity(other)).toBe(true);
			useSettingsStore.setState({ federationHostedAgents: false });
			feedHostedAutoRunActivity({
				peerId: 'box',
				event: { type: 'agent.autorunActivity', agentId: 'h1', activity },
			} as MirrorPush);
			vi.advanceTimersByTime(THOUGHT_FLUSH_MS);
		});
		expect(useThoughtStreamStore.getState().buffers).toEqual({});
		// Any other push is not this feed's.
		expect(feedHostedAutoRunActivity({ peerId: 'box', event: { type: 'peer.stale' } })).toBe(false);
	});
});
