/**
 * End-to-end: a `!` command and an agent reply must never share a bubble.
 *
 * This deliberately avoids hand-built log entries. Everything below runs the
 * REAL pipeline - the real session store, the real batched updater, the real
 * shellCommand service, and the real TerminalOutput render - because the two
 * previous attempts at this bug were verified against hand-built fixtures that
 * did not reproduce how the entries are actually created:
 *
 *  - the card is appended EMPTY and patched later, not born with its text
 *  - agent text arrives as buffered chunks through the batched updater
 *  - the two interleave in wall-clock order, not in a tidy sequence
 *
 * Assertions cover both layers: the shape of `tab.logs` (data), and the number
 * of rendered rows (presentation). A bug in either produces a merged bubble.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { renderHook } from '@testing-library/react';

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

import { TerminalOutput } from '../../renderer/components/TerminalOutput';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import { useBatchedSessionUpdates } from '../../renderer/hooks/session/useBatchedSessionUpdates';
import { useAgentDataListener } from '../../renderer/hooks/agent/internal/useAgentDataListener';
import { useSessionStore } from '../../renderer/stores/sessionStore';
import { runShellCommand } from '../../renderer/services/shellCommand';
import { createMockSession } from '../helpers/mockSession';
import { createMockAITab } from '../helpers/mockTab';
import type { LogEntry, Session } from '../../renderer/types';

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
