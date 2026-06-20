import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setupExitListener } from '../../main/process-listeners/exit-listener';
import type { ProcessManager } from '../../main/process-manager';
import type { ProcessListenerDependencies } from '../../main/process-listeners/types';

const sentry = vi.hoisted(() => ({
	captureException: vi.fn(),
}));

vi.mock('../../main/utils/sentry', () => ({
	captureException: sentry.captureException,
}));

type ExitHandler = (sessionId: string, code: number) => void;

function groupChat() {
	return {
		id: 'chat-1',
		name: 'Build Chat',
		moderatorAgentId: 'claude-code',
		participants: [{ name: 'Worker', agentId: 'codex' }],
	};
}

describe('exit-listener integration', () => {
	let handlers: Map<string, (...args: unknown[]) => void>;
	let processManager: ProcessManager;
	let agentDetector: ReturnType<ProcessListenerDependencies['getAgentDetector']>;
	let deps: Parameters<typeof setupExitListener>[1];

	beforeEach(() => {
		vi.clearAllMocks();
		handlers = new Map();
		processManager = {
			on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
				handlers.set(event, handler);
			}),
		} as unknown as ProcessManager;
		agentDetector = { detectAgents: vi.fn() } as unknown as ReturnType<
			ProcessListenerDependencies['getAgentDetector']
		>;
		deps = {
			safeSend: vi.fn(),
			getProcessManager: vi.fn(() => processManager),
			getAgentDetector: vi.fn(() => agentDetector),
			getWebServer: vi.fn(() => null),
			powerManager: {
				addBlockReason: vi.fn(),
				removeBlockReason: vi.fn(),
			},
			outputBuffer: {
				appendToGroupChatBuffer: vi.fn(),
				getGroupChatBufferedOutput: vi.fn(() => '{"type":"text","text":"hello"}'),
				clearGroupChatBuffer: vi.fn(),
			},
			outputParser: {
				extractTextFromStreamJson: vi.fn(() => 'parsed response'),
				parseParticipantSessionId: vi.fn(() => null),
			},
			groupChatEmitters: {
				emitStateChange: vi.fn(),
				emitParticipantState: vi.fn(),
				emitParticipantsChanged: vi.fn(),
				emitModeratorUsage: vi.fn(),
				emitMessage: vi.fn(),
			},
			groupChatRouter: {
				getGroupChatReadOnlyState: vi.fn(() => true),
				routeModeratorResponse: vi.fn().mockResolvedValue(undefined),
				clearModeratorResponseTimeout: vi.fn(),
				clearActiveParticipantTaskSession: vi.fn(),
				markParticipantResponded: vi.fn(() => false),
				spawnModeratorSynthesis: vi.fn().mockResolvedValue(undefined),
				routeAgentResponse: vi.fn().mockResolvedValue(undefined),
				respawnParticipantWithRecovery: vi.fn().mockResolvedValue(undefined),
			},
			groupChatStorage: {
				loadGroupChat: vi.fn().mockResolvedValue(groupChat()),
				updateGroupChat: vi.fn(),
				updateParticipant: vi.fn(),
			},
			sessionRecovery: {
				needsSessionRecovery: vi.fn(() => false),
				initiateSessionRecovery: vi.fn().mockResolvedValue(true),
			},
			debugLog: vi.fn(),
			logger: {
				info: vi.fn(),
				error: vi.fn(),
				warn: vi.fn(),
				debug: vi.fn(),
			},
			patterns: {
				REGEX_MODERATOR_SESSION: /^group-chat-(.+)-moderator-/,
				REGEX_MODERATOR_SESSION_TIMESTAMP: /^group-chat-(.+)-moderator-\d+$/,
				REGEX_AI_SUFFIX: /-ai-.+$/,
				REGEX_AI_TAB_ID: /-ai-(.+)$/,
				REGEX_BATCH_SESSION: /-batch-\d+$/,
				REGEX_SYNOPSIS_SESSION: /-synopsis-\d+$/,
			},
		};
	});

	function setup() {
		setupExitListener(processManager, deps);
		return handlers.get('exit') as ExitHandler;
	}

	it('forwards regular exits, removes power blocks, and broadcasts base session ids', () => {
		const broadcastToSessionClients = vi.fn();
		deps.getWebServer = vi.fn(
			() =>
				({ broadcastToSessionClients }) as unknown as ReturnType<
					ProcessListenerDependencies['getWebServer']
				>
		);
		const exit = setup();

		exit('session-1-ai-tab-1', 143);

		expect(deps.powerManager.removeBlockReason).toHaveBeenCalledWith('session:session-1-ai-tab-1');
		expect(deps.safeSend).toHaveBeenCalledWith('process:exit', 'session-1-ai-tab-1', 143);
		expect(broadcastToSessionClients).toHaveBeenCalledWith(
			'session-1',
			expect.objectContaining({
				type: 'session_exit',
				sessionId: 'session-1',
				exitCode: 143,
				timestamp: expect.any(Number),
			})
		);
	});

	it('routes moderator output after retrying chat load and handles empty moderator buffers', async () => {
		vi.mocked(deps.groupChatStorage.loadGroupChat)
			.mockRejectedValueOnce(new Error('transient'))
			.mockResolvedValueOnce(groupChat() as any);
		const exit = setup();

		exit('group-chat-chat-1-moderator-abc', 0);

		await vi.waitFor(() =>
			expect(deps.groupChatRouter.routeModeratorResponse).toHaveBeenCalledWith(
				'chat-1',
				'parsed response',
				processManager,
				agentDetector,
				true
			)
		);
		expect(deps.groupChatRouter.clearModeratorResponseTimeout).toHaveBeenCalledWith('chat-1');
		expect(deps.logger.warn).toHaveBeenCalledWith(
			'[GroupChat] Chat load failed, retrying once',
			'ProcessListener',
			expect.objectContaining({ groupChatId: 'chat-1' })
		);
		expect(deps.outputBuffer.clearGroupChatBuffer).toHaveBeenCalledWith(
			'group-chat-chat-1-moderator-abc'
		);

		vi.clearAllMocks();
		vi.mocked(deps.outputBuffer.getGroupChatBufferedOutput).mockReturnValueOnce('');
		exit('group-chat-chat-1-moderator-empty', 0);

		expect(deps.groupChatRouter.routeModeratorResponse).not.toHaveBeenCalled();
		expect(deps.logger.warn).toHaveBeenCalledWith(
			'[GroupChat] Moderator exit with no buffered output',
			'ProcessListener',
			expect.objectContaining({ groupChatId: 'chat-1' })
		);
		expect(deps.groupChatEmitters.emitStateChange).toHaveBeenCalledWith('chat-1', 'idle');
	});

	it('routes participant output, clears task state, and reports synthesis failures', async () => {
		vi.mocked(deps.outputParser.parseParticipantSessionId).mockReturnValue({
			groupChatId: 'chat-1',
			participantName: 'Worker',
		});
		vi.mocked(deps.groupChatRouter.markParticipantResponded).mockReturnValue(true);
		const synthesisError = new Error('synthesis failed');
		vi.mocked(deps.groupChatRouter.spawnModeratorSynthesis).mockRejectedValue(synthesisError);
		const exit = setup();

		exit('group-chat-chat-1-participant-Worker-abc', 0);

		await vi.waitFor(() =>
			expect(deps.groupChatRouter.routeAgentResponse).toHaveBeenCalledWith(
				'chat-1',
				'Worker',
				'parsed response',
				processManager
			)
		);
		await vi.waitFor(() =>
			expect(deps.groupChatEmitters.emitStateChange).toHaveBeenCalledWith('chat-1', 'idle')
		);
		expect(deps.groupChatEmitters.emitParticipantState).toHaveBeenCalledWith(
			'chat-1',
			'Worker',
			'idle'
		);
		expect(deps.groupChatRouter.clearActiveParticipantTaskSession).toHaveBeenCalledWith(
			'chat-1',
			'Worker'
		);
		expect(deps.groupChatEmitters.emitMessage).toHaveBeenCalledWith(
			'chat-1',
			expect.objectContaining({
				from: 'system',
				content: expect.stringContaining('Synthesis failed'),
			})
		);
		expect(sentry.captureException).toHaveBeenCalledWith(synthesisError, {
			operation: 'groupChat:spawnModeratorSynthesis',
			groupChatId: 'chat-1',
		});
		expect(deps.outputBuffer.clearGroupChatBuffer).toHaveBeenCalledWith(
			'group-chat-chat-1-participant-Worker-abc'
		);
	});

	it('recovers expired participant sessions and falls back when recovery cannot respawn', async () => {
		vi.mocked(deps.outputParser.parseParticipantSessionId).mockReturnValue({
			groupChatId: 'chat-1',
			participantName: 'Worker',
		});
		vi.mocked(deps.sessionRecovery.needsSessionRecovery).mockReturnValue(true);
		const exit = setup();

		exit('group-chat-chat-1-participant-Worker-abc', 0);

		await vi.waitFor(() =>
			expect(deps.sessionRecovery.initiateSessionRecovery).toHaveBeenCalledWith('chat-1', 'Worker')
		);
		expect(deps.groupChatEmitters.emitMessage).toHaveBeenCalledWith(
			'chat-1',
			expect.objectContaining({ content: expect.stringContaining('Session expired') })
		);
		expect(deps.groupChatRouter.respawnParticipantWithRecovery).toHaveBeenCalledWith(
			'chat-1',
			'Worker',
			processManager,
			agentDetector
		);
		expect(deps.groupChatRouter.markParticipantResponded).not.toHaveBeenCalled();

		vi.clearAllMocks();
		vi.mocked(deps.groupChatRouter.respawnParticipantWithRecovery).mockRejectedValueOnce(
			new Error('respawn failed')
		);
		exit('group-chat-chat-1-participant-Worker-def', 0);

		await vi.waitFor(() =>
			expect(deps.groupChatRouter.markParticipantResponded).toHaveBeenCalledWith('chat-1', 'Worker')
		);
		expect(deps.groupChatEmitters.emitMessage).toHaveBeenCalledWith(
			'chat-1',
			expect.objectContaining({ content: expect.stringContaining('Failed to create new session') })
		);
	});

	it('uses participant fallback routing when primary routing fails and marks empty output as done', async () => {
		vi.mocked(deps.outputParser.parseParticipantSessionId).mockReturnValue({
			groupChatId: 'chat-1',
			participantName: 'Worker',
		});
		vi.mocked(deps.groupChatRouter.routeAgentResponse)
			.mockRejectedValueOnce(new Error('route failed'))
			.mockResolvedValueOnce(undefined);
		const exit = setup();

		exit('group-chat-chat-1-participant-Worker-abc', 0);

		await vi.waitFor(() =>
			expect(deps.groupChatRouter.routeAgentResponse).toHaveBeenCalledTimes(2)
		);
		expect(deps.groupChatRouter.routeAgentResponse).toHaveBeenLastCalledWith(
			'chat-1',
			'Worker',
			'parsed response',
			processManager
		);
		expect(deps.groupChatRouter.markParticipantResponded).toHaveBeenCalledWith('chat-1', 'Worker');

		vi.clearAllMocks();
		vi.mocked(deps.outputBuffer.getGroupChatBufferedOutput).mockReturnValueOnce('');
		exit('group-chat-chat-1-participant-Worker-empty', 0);

		expect(deps.groupChatRouter.routeAgentResponse).not.toHaveBeenCalled();
		expect(deps.groupChatRouter.markParticipantResponded).toHaveBeenCalledWith('chat-1', 'Worker');
	});
});
