/**
 * Tests for the "Debug: Trigger Provider Re-auth" palette commands.
 *
 * These exist so the re-authentication flow can be exercised without waiting
 * for a real token to expire. What matters is that they go through the REAL
 * event channel with a payload a real failure would carry - a command that
 * shortcuts into the renderer's stores would prove nothing about the flow it
 * is supposed to test, and would have hidden the SSH spawn bug entirely.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { buildDebugCommands } from '../../../../../renderer/components/QuickActionsModal/commands/debugCommands';
import { createMockSession } from '../../../../helpers/mockSession';
import { createMockAITab } from '../../../../helpers/mockTab';
import type { Session } from '../../../../../renderer/types';

const simulateAuthExpiry = vi.fn();
const notifyToast = vi.fn();
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const setQuickActionOpen = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	simulateAuthExpiry.mockResolvedValue({ success: true });
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(window as any).maestro = { ...((window as any).maestro ?? {}), debug: { simulateAuthExpiry } };
});

function build(activeSession: Session | undefined) {
	return buildDebugCommands({
		activeSession,
		activeSessionId: activeSession?.id ?? '',
		sessions: activeSession ? [activeSession] : [],
		setSessions: vi.fn(),
		setQuickActionOpen,
		profilingActive: false,
		onStartProfiling: vi.fn(),
		onStopProfiling: vi.fn(),
		getInstallationId: vi.fn().mockResolvedValue('install-1'),
		safeClipboardWrite: vi.fn().mockResolvedValue(true),
		flashCopiedToClipboard: vi.fn(),
		notifyToast,
		logger,
	});
}

function agentWithTab(overrides: Partial<Session> = {}): Session {
	return createMockSession({
		id: 'sess-1',
		name: 'Cyber Stocks',
		toolType: 'claude-code',
		aiTabs: [createMockAITab({ id: 'tab-1' })],
		activeTabId: 'tab-1',
		...overrides,
	});
}

function find(commands: ReturnType<typeof build>, id: string) {
	const command = commands.find((c) => c.id === id);
	if (!command) throw new Error(`No debug command with id ${id}`);
	return command;
}

describe('Debug: Trigger Provider Re-auth', () => {
	it('is offered for the active agent', () => {
		const ids = build(agentWithTab()).map((c) => c.id);
		expect(ids).toContain('debugTriggerReauth');
		expect(ids).toContain('debugTriggerReauthPipeline');
	});

	it('is hidden when there is no agent to fail', () => {
		const ids = build(undefined).map((c) => c.id);
		expect(ids).not.toContain('debugTriggerReauth');
		expect(ids).not.toContain('debugTriggerReauthPipeline');
	});

	// The full process id is what a real agent error carries, and it is how the
	// failing tab is identified for replay. A base agent id would open the dialog
	// and then resume nothing, which would look like a working test.
	it('sends the full process id so the failed turn can be replayed', async () => {
		await find(build(agentWithTab()), 'debugTriggerReauth').action();

		expect(simulateAuthExpiry).toHaveBeenCalledWith({
			processSessionId: 'sess-1-ai-tab-1',
			agentId: 'claude-code',
			fromPipeline: false,
		});
	});

	// A Cue run owns no AI tab, so its event carries the base agent id and
	// arrives on the separate channel Cue failures use.
	it('sends the bare agent id for the pipeline variant', async () => {
		await find(build(agentWithTab()), 'debugTriggerReauthPipeline').action();

		expect(simulateAuthExpiry).toHaveBeenCalledWith({
			processSessionId: 'sess-1',
			agentId: 'claude-code',
			fromPipeline: true,
		});
	});

	it('names the agent that will fail, so the wrong one is not triggered', () => {
		const command = find(build(agentWithTab()), 'debugTriggerReauth');
		expect(command.subtext).toContain('Cyber Stocks');
	});

	it('reports the agent provider rather than assuming Claude', async () => {
		await find(build(agentWithTab({ toolType: 'codex' })), 'debugTriggerReauth').action();

		expect(simulateAuthExpiry).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'codex' }));
	});

	// An agent with no AI tab has no turn to fail, so the interactive variant
	// would send a malformed id. The pipeline variant still applies.
	it('hides the interactive variant for an agent with no tabs', () => {
		const ids = build(agentWithTab({ aiTabs: [], activeTabId: undefined })).map((c) => c.id);
		expect(ids).not.toContain('debugTriggerReauth');
		expect(ids).toContain('debugTriggerReauthPipeline');
	});

	it('closes the palette and surfaces a failure rather than dying silently', async () => {
		simulateAuthExpiry.mockRejectedValue(new Error('ipc down'));

		await find(build(agentWithTab()), 'debugTriggerReauth').action();

		expect(setQuickActionOpen).toHaveBeenCalledWith(false);
		expect(notifyToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
		expect(logger.error).toHaveBeenCalled();
	});
});
