import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
	FeedbackConversationManager,
	type FeedbackDiagnostic,
} from '../../../renderer/services/feedbackConversation';

type ExitCallback = (sessionId: string, code: number) => void;
type DataCallback = (sessionId: string, data: string) => void;
type ToolCallback = (
	sessionId: string,
	toolEvent: { toolName: string; state?: unknown; timestamp: number; toolCallId?: string }
) => void;

const CLAUDE_AGENT = {
	id: 'claude-code',
	command: 'claude',
	available: true,
	args: [
		'--print',
		'--verbose',
		'--output-format',
		'stream-json',
		'--dangerously-skip-permissions',
	],
	capabilities: { supportsStreamJsonInput: false },
};

const CODEX_AGENT = {
	id: 'codex',
	command: 'codex',
	available: true,
	args: [],
	batchModeArgs: ['--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check'],
	jsonOutputArgs: ['--json'],
	capabilities: {},
};

/**
 * Wire the window.maestro surface the manager talks to, exposing the listener
 * callbacks so a test can drive the process lifecycle by hand.
 */
function installProcessMocks(agent: unknown) {
	const listeners: {
		exit?: ExitCallback;
		data?: DataCallback;
		tool?: ToolCallback;
	} = {};
	const spawn = vi.fn();

	(window as any).maestro = {
		agents: { get: vi.fn().mockResolvedValue(agent) },
		process: {
			spawn,
			kill: vi.fn(),
			onData: vi.fn((cb: DataCallback) => {
				listeners.data = cb;
				return () => {};
			}),
			onExit: vi.fn((cb: ExitCallback) => {
				listeners.exit = cb;
				return () => {};
			}),
			onToolExecution: vi.fn((cb: ToolCallback) => {
				listeners.tool = cb;
				return () => {};
			}),
			onThinkingChunk: vi.fn(() => () => {}),
		},
	};

	return { spawn, listeners };
}

/** Finish the turn so `sendMessage()`'s promise settles. */
function completeTurn(
	listeners: { exit?: ExitCallback; data?: DataCallback },
	sessionId: string,
	payload: Record<string, unknown>
) {
	listeners.data?.(sessionId, JSON.stringify(payload));
	listeners.exit?.(sessionId, 0);
}

const VALID_RESPONSE = {
	confidence: 55,
	ready: false,
	message: 'Tell me more.',
	category: 'bug_report',
	summary: 'Something broke',
	structured: {
		expectedBehavior: '',
		actualBehavior: '',
		reproductionSteps: '',
		additionalContext: '',
	},
};

describe('FeedbackConversationManager diagnostics', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('spawns the diagnostic agent in read-only mode', async () => {
		const { spawn, listeners } = installProcessMocks(CLAUDE_AGENT);
		const manager = new FeedbackConversationManager();
		const sessionId = manager.start({
			agentType: 'claude-code',
			systemPrompt: 'prompt',
			cwd: '/home/tester',
		});

		const pending = manager.sendMessage('it broke', []);
		await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
		completeTurn(listeners, sessionId, VALID_RESPONSE);
		await pending;

		expect(spawn.mock.calls[0][0]).toMatchObject({ readOnlyMode: true });
	});

	it('runs diagnostics from the supplied working directory', async () => {
		const { spawn, listeners } = installProcessMocks(CLAUDE_AGENT);
		const manager = new FeedbackConversationManager();
		const sessionId = manager.start({
			agentType: 'claude-code',
			systemPrompt: 'prompt',
			cwd: '/home/tester',
		});

		const pending = manager.sendMessage('it broke', []);
		await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
		completeTurn(listeners, sessionId, VALID_RESPONSE);
		await pending;

		// The old hard-coded '.' resolved to the app's cwd ('/' for a packaged
		// .app), where no diagnostic command finds anything.
		expect(spawn.mock.calls[0][0].cwd).toBe('/home/tester');
	});

	it('strips blanket permission grants from the agent args', async () => {
		const { spawn, listeners } = installProcessMocks(CLAUDE_AGENT);
		const manager = new FeedbackConversationManager();
		const sessionId = manager.start({ agentType: 'claude-code', systemPrompt: 'prompt' });

		const pending = manager.sendMessage('it broke', []);
		await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
		completeTurn(listeners, sessionId, VALID_RESPONSE);
		await pending;

		const args: string[] = spawn.mock.calls[0][0].args;
		// Leaving this in would override the provider's read-only flag and hand a
		// bug-reporting assistant write access to the app it is reporting on.
		expect(args).not.toContain('--dangerously-skip-permissions');
		expect(args).toContain('--output-format');
	});

	it('omits Codex batch-mode permission bypass args', async () => {
		const { spawn, listeners } = installProcessMocks(CODEX_AGENT);
		const manager = new FeedbackConversationManager();
		const sessionId = manager.start({ agentType: 'codex', systemPrompt: 'prompt' });

		const pending = manager.sendMessage('it broke', []);
		await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
		completeTurn(listeners, sessionId, VALID_RESPONSE);
		await pending;

		const args: string[] = spawn.mock.calls[0][0].args;
		expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
		expect(args).toContain('--json');
	});

	it('reports each diagnostic command the agent runs', async () => {
		const { spawn, listeners } = installProcessMocks(CLAUDE_AGENT);
		const manager = new FeedbackConversationManager();
		const sessionId = manager.start({ agentType: 'claude-code', systemPrompt: 'prompt' });

		const seen: FeedbackDiagnostic[] = [];
		const pending = manager.sendMessage('it broke', [], {
			onDiagnostic: (diagnostic) => seen.push(diagnostic),
		});
		await vi.waitFor(() => expect(spawn).toHaveBeenCalled());

		listeners.tool?.(sessionId, {
			toolName: 'Bash',
			state: { status: 'running', input: { command: 'maestro-cli doctor' } },
			timestamp: 1,
			toolCallId: 'call-1',
		});
		// A single call is reported again as it completes; the user should see it once.
		listeners.tool?.(sessionId, {
			toolName: 'Bash',
			state: { status: 'completed', input: { command: 'maestro-cli doctor' } },
			timestamp: 2,
			toolCallId: 'call-1',
		});
		listeners.tool?.(sessionId, {
			toolName: 'Read',
			state: { status: 'running', input: { file_path: '/tmp/maestro.log' } },
			timestamp: 3,
			toolCallId: 'call-2',
		});

		completeTurn(listeners, sessionId, VALID_RESPONSE);
		await pending;

		expect(seen).toHaveLength(2);
		expect(seen[0]).toMatchObject({ toolName: 'Bash', command: 'maestro-cli doctor' });
		// No command in the input - the UI falls back to naming the tool.
		expect(seen[1]).toMatchObject({ toolName: 'Read', command: undefined });
	});

	it('recovers the response when the agent wraps it in prose', async () => {
		const { spawn, listeners } = installProcessMocks(CLAUDE_AGENT);
		const manager = new FeedbackConversationManager();
		const sessionId = manager.start({ agentType: 'claude-code', systemPrompt: 'prompt' });

		const pending = manager.sendMessage('it broke', []);
		await vi.waitFor(() => expect(spawn).toHaveBeenCalled());

		// Running diagnostics first makes a preamble far more likely, and the
		// greedy match this replaced spanned first-brace to last-brace, so a single
		// stray sentence used to turn a real answer into the "didn't catch that"
		// fallback.
		listeners.data?.(
			sessionId,
			`I checked your logs first.\n\n${JSON.stringify(VALID_RESPONSE)}\n\nHope that helps.`
		);
		listeners.exit?.(sessionId, 0);
		const response = await pending;

		expect(response.confidence).toBe(55);
		expect(response.message).toBe('Tell me more.');
	});

	it('is not fooled by braces inside the message body', async () => {
		const { spawn, listeners } = installProcessMocks(CLAUDE_AGENT);
		const manager = new FeedbackConversationManager();
		const sessionId = manager.start({ agentType: 'claude-code', systemPrompt: 'prompt' });

		const pending = manager.sendMessage('it broke', []);
		await vi.waitFor(() => expect(spawn).toHaveBeenCalled());

		const withBraces = {
			...VALID_RESPONSE,
			message: 'Your config has a stray } in it - see {"a": 1} on line 4.',
		};
		listeners.data?.(sessionId, `Here you go:\n${JSON.stringify(withBraces)}`);
		listeners.exit?.(sessionId, 0);
		const response = await pending;

		expect(response.message).toBe('Your config has a stray } in it - see {"a": 1} on line 4.');
	});

	it('falls back to the default response when nothing parses', async () => {
		const { spawn, listeners } = installProcessMocks(CLAUDE_AGENT);
		const manager = new FeedbackConversationManager();
		const sessionId = manager.start({ agentType: 'claude-code', systemPrompt: 'prompt' });

		const pending = manager.sendMessage('it broke', []);
		await vi.waitFor(() => expect(spawn).toHaveBeenCalled());

		listeners.data?.(sessionId, 'Sorry, I got confused and wrote no JSON at all.');
		listeners.exit?.(sessionId, 0);
		const response = await pending;

		expect(response.ready).toBe(false);
		expect(response.message).toContain("didn't quite catch that");
	});

	it('ignores tool events belonging to another session', async () => {
		const { spawn, listeners } = installProcessMocks(CLAUDE_AGENT);
		const manager = new FeedbackConversationManager();
		const sessionId = manager.start({ agentType: 'claude-code', systemPrompt: 'prompt' });

		const seen: FeedbackDiagnostic[] = [];
		const pending = manager.sendMessage('it broke', [], {
			onDiagnostic: (diagnostic) => seen.push(diagnostic),
		});
		await vi.waitFor(() => expect(spawn).toHaveBeenCalled());

		listeners.tool?.('some-other-session', {
			toolName: 'Bash',
			state: { status: 'running', input: { command: 'rm -rf /' } },
			timestamp: 1,
			toolCallId: 'other-1',
		});

		completeTurn(listeners, sessionId, VALID_RESPONSE);
		await pending;

		expect(seen).toHaveLength(0);
	});
});
