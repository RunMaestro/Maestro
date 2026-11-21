// Source: src/__tests__/renderer/commandModeBubbles.e2e.test.tsx
// Source: src/__tests__/renderer/hooks/agent/internal/useAgentDataListener.test.tsx
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { beforeEach } from 'vitest';
import { afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { act } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { TerminalOutput } from '../../renderer/components/TerminalOutput';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import { useBatchedSessionUpdates } from '../../renderer/hooks/session/useBatchedSessionUpdates';
import { useAgentDataListener } from '../../renderer/hooks/agent/internal/useAgentDataListener';
import { useSessionStore } from '../../renderer/stores/sessionStore';
import { runShellCommand } from '../../renderer/services/shellCommand';
import { createMockSession } from '../helpers/mockSession';
import { createMockAITab } from '../helpers/mockTab';
import type { LogEntry } from '../../renderer/types';
import type { Session } from '../../renderer/types';
import { useRetryStore } from '../../renderer/stores/retryStore';
import type { BatchedUpdater } from '../../renderer/hooks/agent/internal/types';
vi.mock('react-markdown', () => ({
	default: ({ children }: { children: string }) => (
		<div data-testid="react-markdown">{children}</div>
	),
}));
vi.mock('remark-gfm', () => ({ default: () => {} }));
vi.mock('react-syntax-highlighter', () => ({
	Prism: ({ children }: { children: string }) => <pre>{children}</pre>,
}));
vi.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({ oneDark: {} }));
vi.mock('dompurify', () => ({ default: { sanitize: (html: string) => html } }));
describeSourceSuite('commandModeBubbles.e2e', () => {
	const SESSION_ID = 'session-1';
	const TAB_ID = 'tab-1';

	// --- window.maestro.process double -------------------------------------------

	type Listener = (sessionId: string, arg: never) => void;
	let dataListeners: Listener[] = [];
	let stderrListeners: Listener[] = [];
	let exitListeners: Listener[] = [];
	const runCommand = vi.fn();

	function subscribe(bucket: Listener[]) {
		return (cb: Listener) => {
			bucket.push(cb);
			return () => {
				const i = bucket.indexOf(cb);
				if (i >= 0) bucket.splice(i, 1);
			};
		};
	}

	const emit = (bucket: Listener[], sessionId: string, arg: unknown) =>
		bucket.slice().forEach((l) => l(sessionId, arg as never));

	// --- helpers -----------------------------------------------------------------

	function tabLogs(): LogEntry[] {
		const s = useSessionStore.getState().sessions.find((x) => x.id === SESSION_ID);
		return s?.aiTabs.find((t) => t.id === TAB_ID)?.logs ?? [];
	}

	function currentSession(): Session {
		return useSessionStore.getState().sessions.find((x) => x.id === SESSION_ID)!;
	}

	const defaultTheme = {
		id: 'test',
		name: 'Test',
		colors: {
			bgMain: '#1a1a2e',
			bgSidebar: '#16213e',
			bgActivity: '#0f3460',
			textMain: '#e94560',
			textDim: '#a0a0a0',
			accent: '#e94560',
			accentDim: '#b83b5e',
			accentForeground: '#fff',
			border: '#2a2a4e',
			success: '#00ff88',
			warning: '#ffcc00',
			error: '#ff4444',
		},
	} as never;

	function renderTranscript() {
		return render(
			<LayerStackProvider>
				<TerminalOutput
					session={currentSession()}
					theme={defaultTheme}
					fontFamily="monospace"
					activeFocus="main"
					outputSearchOpen={false}
					outputSearchQuery=""
					outputSearchRegex={false}
					setOutputSearchOpen={vi.fn()}
					setOutputSearchQuery={vi.fn()}
					setOutputSearchRegex={vi.fn()}
					setActiveFocus={vi.fn()}
					setLightboxImage={vi.fn()}
					inputRef={{ current: null } as never}
					logsEndRef={{ current: null } as never}
					maxOutputLines={50}
					markdownEditMode={false}
					setMarkdownEditMode={vi.fn()}
				/>
			</LayerStackProvider>
		);
	}

	beforeEach(() => {
		vi.clearAllMocks();
		dataListeners = [];
		stderrListeners = [];
		exitListeners = [];
		runCommand.mockResolvedValue({ exitCode: 0 });

		(window as unknown as { maestro: unknown }).maestro = {
			process: {
				runCommand,
				cancelCommand: vi.fn().mockResolvedValue(true),
				onData: subscribe(dataListeners),
				onStderr: subscribe(stderrListeners),
				onCommandExit: subscribe(exitListeners),
			},
			logger: { log: vi.fn() },
		};

		// Flush the output buffer synchronously so ordering is deterministic.
		vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
			cb(0);
			return 1;
		});
		vi.stubGlobal('cancelAnimationFrame', () => {});

		useSessionStore.setState({
			sessions: [
				createMockSession({
					id: SESSION_ID,
					cwd: '/repo',
					activeTabId: TAB_ID,
					aiTabs: [createMockAITab({ id: TAB_ID, logs: [] })],
				}),
			],
			activeSessionId: SESSION_ID,
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	describe('command mode: one bubble per command, one per reply', () => {
		it('keeps an agent reply and a following command in separate entries and rows', async () => {
			const { result } = renderHook(() => useBatchedSessionUpdates());

			// 1. Agent streams a reply, exactly as the data listener would.
			act(() => {
				result.current.appendLog(SESSION_ID, TAB_ID, true, 'rather than guess now.');
				result.current.flushNow();
			});
			expect(tabLogs()).toHaveLength(1);

			// 2. The user runs `!ls`. The card is appended EMPTY here - this is the
			//    detail the earlier fixture-based tests skipped.
			let run!: Promise<void>;
			await act(async () => {
				run = runShellCommand({ session: currentSession(), tabId: TAB_ID, command: 'ls' });
				await Promise.resolve();
			});

			const runSessionId = runCommand.mock.calls[0][0].sessionId as string;

			// 3. Output arrives and the command exits.
			await act(async () => {
				emit(dataListeners, runSessionId, 'node_modules tailwind.config.mjs\n');
				emit(exitListeners, runSessionId, 0);
				await run;
			});

			const logs = tabLogs();
			const card = logs.find((l) => l.shellCommand);
			const reply = logs.find((l) => !l.shellCommand);

			// The card owns its output; the reply is untouched.
			expect(logs).toHaveLength(2);
			expect(card?.text).toContain('node_modules');
			expect(reply?.text).toBe('rather than guess now.');
			expect(reply?.text).not.toContain('node_modules');

			// And they render as two rows, not one merged bubble.
			const { container } = renderTranscript();
			expect(container.querySelectorAll('[data-log-index]').length).toBe(2);
		});

		it('does not let a reply arriving DURING a command land in the card', async () => {
			// The realistic case: command mode exists to run things mid-turn, so the
			// card is the newest entry while the agent is still streaming.
			const { result } = renderHook(() => useBatchedSessionUpdates());

			let run!: Promise<void>;
			await act(async () => {
				run = runShellCommand({ session: currentSession(), tabId: TAB_ID, command: 'ls' });
				await Promise.resolve();
			});
			const runSessionId = runCommand.mock.calls[0][0].sessionId as string;

			// Agent chunk lands while the command is still in flight.
			act(() => {
				result.current.appendLog(SESSION_ID, TAB_ID, true, 'agent still talking');
				result.current.flushNow();
			});

			await act(async () => {
				emit(dataListeners, runSessionId, 'ls output here\n');
				emit(exitListeners, runSessionId, 0);
				await run;
			});

			const card = tabLogs().find((l) => l.shellCommand);
			expect(card?.text).toContain('ls output here');
			expect(card?.text).not.toContain('agent still talking');

			const { container } = renderTranscript();
			expect(container.querySelectorAll('[data-log-index]').length).toBe(2);
		});

		it('routes shell output through the REAL agent data listener without leaking', async () => {
			// The one path the rest of this file reasons about but does not execute.
			// useAgentDataListener sees EVERY process:data event, including the
			// synthetic `{sessionId}-shell-{runId}` id. If it ever treated that id as
			// belonging to the agent, the command's output would be appended to the
			// agent's own entry - which is the exact shape of the reported bug.
			const hiddenToolRef = { current: new Map() };
			const { result } = renderHook(() => {
				const batchedUpdater = useBatchedSessionUpdates();
				useAgentDataListener({ batchedUpdater, activeHiddenToolRef: hiddenToolRef as never });
				return batchedUpdater;
			});

			// An agent reply is already on screen.
			act(() => {
				result.current.appendLog(SESSION_ID, TAB_ID, true, 'agent reply text');
				result.current.flushNow();
			});

			let run!: Promise<void>;
			await act(async () => {
				run = runShellCommand({ session: currentSession(), tabId: TAB_ID, command: 'ls' });
				await Promise.resolve();
			});
			const sid = runCommand.mock.calls[0][0].sessionId as string;

			// Emit on the synthetic id: BOTH the shellCommand service listener and the
			// agent data listener receive this, exactly as in the running app.
			await act(async () => {
				emit(dataListeners, sid, 'SHELL_ONLY_MARKER\n');
				emit(exitListeners, sid, 0);
				await run;
				result.current.flushNow();
			});

			const logs = tabLogs();
			const card = logs.find((l) => l.shellCommand);
			const reply = logs.find((l) => !l.shellCommand);

			expect(card?.text).toContain('SHELL_ONLY_MARKER');
			expect(reply?.text).toBe('agent reply text');
			expect(logs).toHaveLength(2);

			const { container } = renderTranscript();
			expect(container.querySelectorAll('[data-log-index]').length).toBe(2);
		});

		it('gives three consecutive commands three rows', async () => {
			for (const cmd of ['ls', 'pwd', 'whoami']) {
				let run!: Promise<void>;
				await act(async () => {
					run = runShellCommand({ session: currentSession(), tabId: TAB_ID, command: cmd });
					await Promise.resolve();
				});
				const sid = runCommand.mock.calls[runCommand.mock.calls.length - 1][0].sessionId as string;
				await act(async () => {
					emit(dataListeners, sid, `${cmd} output\n`);
					emit(exitListeners, sid, 0);
					await run;
				});
			}

			expect(tabLogs()).toHaveLength(3);
			const { container } = renderTranscript();
			expect(container.querySelectorAll('[data-log-index]').length).toBe(3);
		});

		it('interleaves reply / command / reply as three rows', async () => {
			const { result } = renderHook(() => useBatchedSessionUpdates());

			act(() => {
				result.current.appendLog(SESSION_ID, TAB_ID, true, 'Before.');
				result.current.flushNow();
			});

			let run!: Promise<void>;
			await act(async () => {
				run = runShellCommand({ session: currentSession(), tabId: TAB_ID, command: 'ls' });
				await Promise.resolve();
			});
			const sid = runCommand.mock.calls[0][0].sessionId as string;
			await act(async () => {
				emit(dataListeners, sid, 'middle output\n');
				emit(exitListeners, sid, 0);
				await run;
			});

			act(() => {
				result.current.appendLog(SESSION_ID, TAB_ID, true, 'After.');
				result.current.flushNow();
			});

			const texts = tabLogs().map((l) => l.text);
			expect(tabLogs()).toHaveLength(3);
			expect(texts.some((t) => t.includes('Before.') && t.includes('After.'))).toBe(false);

			const { container } = renderTranscript();
			expect(container.querySelectorAll('[data-log-index]').length).toBe(3);
		});
	});
});
describeSourceSuite('useAgentDataListener', () => {
	let handler: ((sessionId: string, data: string) => void) | undefined;
	const mockUnsubscribe = vi.fn();

	const mockProcess = {
		onData: vi.fn((h: any) => {
			handler = h;
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

	function makeRef(): {
		current: Map<string, { toolName: string; toolState?: any }>;
	} {
		return { current: new Map() };
	}

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
		(window as any).maestro = {
			...((window as any).maestro || {}),
			process: mockProcess,
			agentError: { clearError: vi.fn().mockResolvedValue(undefined) },
		};
	});

	describe('useAgentDataListener', () => {
		it('routes ai-formatted ids through batched appendLog with isAi=true', () => {
			const tab = createMockAITab({ id: 'tab-1' });
			const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
			useSessionStore.setState({ sessions: [session] } as any);

			const batched = makeBatched();
			renderHook(() =>
				useAgentDataListener({ batchedUpdater: batched, activeHiddenToolRef: makeRef() })
			);

			handler!('sess-1-ai-tab-1', 'hello\n');

			expect(batched.appendLog).toHaveBeenCalledWith('sess-1', 'tab-1', true, 'hello\n');
			expect(batched.markDelivered).toHaveBeenCalledWith('sess-1', 'tab-1');
			expect(batched.updateCycleBytes).toHaveBeenCalledWith('sess-1', 6);
		});

		it('routes plain session ids as terminal output', () => {
			const session = createMockSession({ id: 'sess-1' });
			useSessionStore.setState({ sessions: [session] } as any);

			const batched = makeBatched();
			renderHook(() =>
				useAgentDataListener({ batchedUpdater: batched, activeHiddenToolRef: makeRef() })
			);

			handler!('sess-1', 'terminal output');
			expect(batched.appendLog).toHaveBeenCalledWith('sess-1', null, false, 'terminal output');
			expect(batched.markDelivered).not.toHaveBeenCalled();
		});

		it('drops empty terminal output', () => {
			const batched = makeBatched();
			renderHook(() =>
				useAgentDataListener({ batchedUpdater: batched, activeHiddenToolRef: makeRef() })
			);

			handler!('sess-1', '   ');
			expect(batched.appendLog).not.toHaveBeenCalled();
		});

		it('ignores -terminal and -batch- session ids', () => {
			const batched = makeBatched();
			renderHook(() =>
				useAgentDataListener({ batchedUpdater: batched, activeHiddenToolRef: makeRef() })
			);

			handler!('sess-1-terminal', 'data');
			handler!('sess-1-batch-x', 'data');
			expect(batched.appendLog).not.toHaveBeenCalled();
		});

		it('deletes the matching activeHiddenToolRef entry on first chunk', () => {
			const tab = createMockAITab({ id: 'tab-1' });
			const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
			useSessionStore.setState({ sessions: [session] } as any);

			const ref = makeRef();
			ref.current.set('sess-1:tab-1', { toolName: 'Read' });
			const batched = makeBatched();

			renderHook(() => useAgentDataListener({ batchedUpdater: batched, activeHiddenToolRef: ref }));

			handler!('sess-1-ai-tab-1', 'data');
			expect(ref.current.has('sess-1:tab-1')).toBe(false);
		});

		it('clears lingering session.agentError on next data chunk', () => {
			const tab = createMockAITab({ id: 'tab-1' });
			const session = createMockSession({
				id: 'sess-1',
				aiTabs: [tab],
				activeTabId: 'tab-1',
				agentError: { type: 'auth_expired', message: 'expired', timestamp: 0 } as any,
				state: 'error',
			});
			useSessionStore.setState({ sessions: [session] } as any);

			const batched = makeBatched();
			renderHook(() =>
				useAgentDataListener({ batchedUpdater: batched, activeHiddenToolRef: makeRef() })
			);
			handler!('sess-1-ai-tab-1', 'data');

			const updated = useSessionStore.getState().sessions[0];
			expect(updated.agentError).toBeUndefined();
			expect(updated.state).toBe('busy');
		});

		// Claude prints "Prompt is too long" on the result envelope as ordinary
		// output, after the error that started the compaction recovery. Rendered, it
		// puts the failure the recovery is masking straight back into the transcript.
		it('drops output from a turn that failed on the context limit and is being re-run', () => {
			const tab = createMockAITab({ id: 'tab-1' });
			const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
			useSessionStore.setState({ sessions: [session] } as any);
			useRetryStore.setState({
				retries: {
					'sess-1:tab-1': {
						sessionId: 'sess-1',
						tabId: 'tab-1',
						key: 'sess-1:tab-1',
						outageId: 'o1',
						strategy: 'context-compaction',
						mode: 'resend',
						status: 'scheduled',
						attempt: 0,
						startedAt: 0,
						nextRetryAt: 0,
						lastMessage: 'Prompt is too long',
						compaction: { pill: null, error: {} as any, compacted: false },
					},
				},
				outages: {},
			});

			const batched = makeBatched();
			renderHook(() =>
				useAgentDataListener({ batchedUpdater: batched, activeHiddenToolRef: makeRef() })
			);

			handler!('sess-1-ai-tab-1', 'Prompt is too long');
			expect(batched.appendLog).not.toHaveBeenCalled();

			// Once the compaction is under way the tab's next writer is the resend.
			useRetryStore.setState((state) => ({
				retries: {
					'sess-1:tab-1': { ...state.retries['sess-1:tab-1'], status: 'in-flight' },
				},
			}));
			handler!('sess-1-ai-tab-1', 'Here is the answer.');
			expect(batched.appendLog).toHaveBeenCalledWith(
				'sess-1',
				'tab-1',
				true,
				'Here is the answer.'
			);

			useRetryStore.setState({ retries: {}, outages: {} });
		});
	});
});
