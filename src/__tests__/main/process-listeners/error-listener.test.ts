/**
 * Tests for the agent-error listener, focusing on account multiplexing
 * routing: auth_expired → auth recovery (with throttle fallback),
 * rate_limited → throttle handler, everything else → no account routing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupErrorListener } from '../../../main/process-listeners/error-listener';
import { capabilitySnapshots } from '../../../main/agents/capability-snapshot';
import type { ProcessManager } from '../../../main/process-manager';
import type { AgentError } from '../../../shared/types';
import type { AccountRegistry } from '../../../main/accounts/account-registry';
import type { AccountThrottleHandler } from '../../../main/accounts/account-throttle-handler';
import type { AccountAuthRecovery } from '../../../main/accounts/account-auth-recovery';

vi.mock('../../../main/agents/capability-snapshot', () => ({
	capabilitySnapshots: {
		markAuthRequired: vi.fn(),
	},
}));

function makeError(overrides: Partial<AgentError> = {}): AgentError {
	return {
		type: 'rate_limited',
		agentId: 'claude-code',
		message: 'Rate limit exceeded',
		recoverable: true,
		timestamp: Date.now(),
		...overrides,
	} as AgentError;
}

describe('Error Listener', () => {
	let eventHandlers: Map<string, (...args: unknown[]) => void>;
	let mockProcessManager: ProcessManager;
	let mockSafeSend: ReturnType<typeof vi.fn>;
	let mockLogger: {
		info: ReturnType<typeof vi.fn>;
		error: ReturnType<typeof vi.fn>;
		warn: ReturnType<typeof vi.fn>;
		debug: ReturnType<typeof vi.fn>;
	};
	let mockRegistry: { getAssignment: ReturnType<typeof vi.fn> };
	let mockThrottleHandler: { handleThrottle: ReturnType<typeof vi.fn> };
	let mockAuthRecovery: { recoverAuth: ReturnType<typeof vi.fn> };

	function setup(opts: { accountDeps?: boolean; authRecovery?: boolean | 'absent' } = {}) {
		setupErrorListener(
			mockProcessManager,
			{ safeSend: mockSafeSend, logger: mockLogger },
			opts.accountDeps
				? {
						getAccountRegistry: () => mockRegistry as unknown as AccountRegistry,
						getThrottleHandler: () => mockThrottleHandler as unknown as AccountThrottleHandler,
						getAuthRecovery:
							opts.authRecovery === 'absent'
								? undefined
								: () =>
										opts.authRecovery ? (mockAuthRecovery as unknown as AccountAuthRecovery) : null,
					}
				: undefined
		);
		return eventHandlers.get('agent-error')!;
	}

	beforeEach(() => {
		vi.clearAllMocks();
		eventHandlers = new Map();
		mockSafeSend = vi.fn();
		mockLogger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
		mockRegistry = {
			getAssignment: vi.fn().mockReturnValue({ sessionId: 's1', accountId: 'acct-1' }),
		};
		mockThrottleHandler = { handleThrottle: vi.fn() };
		mockAuthRecovery = { recoverAuth: vi.fn().mockResolvedValue(true) };
		mockProcessManager = {
			on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
				eventHandlers.set(event, handler);
			}),
		} as unknown as ProcessManager;
	});

	it('registers the agent-error event listener', () => {
		setup();
		expect(mockProcessManager.on).toHaveBeenCalledWith('agent-error', expect.any(Function));
	});

	it('logs and forwards every error to the renderer', () => {
		const handler = setup();
		const error = makeError({ type: 'token_exhaustion', recoverable: false });

		handler('s1-ai-tab1', error);

		expect(mockSafeSend).toHaveBeenCalledWith('agent:error', 's1-ai-tab1', error);
		expect(mockLogger.info).toHaveBeenCalledWith(
			'Agent error detected: token_exhaustion',
			'AgentError',
			expect.objectContaining({ sessionId: 's1-ai-tab1' })
		);
	});

	it('marks capability snapshot auth_required on auth_expired', () => {
		const handler = setup();
		handler('s1', makeError({ type: 'auth_expired', message: 'expired', sshRemoteId: 'r1' }));

		expect(capabilitySnapshots.markAuthRequired).toHaveBeenCalledWith(
			'claude-code',
			'expired',
			'r1'
		);
	});

	describe('without accountDeps (accounts not configured)', () => {
		it('does no account routing', () => {
			const handler = setup({ accountDeps: false });
			handler('s1', makeError({ type: 'rate_limited' }));
			handler('s1', makeError({ type: 'auth_expired' }));

			expect(mockThrottleHandler.handleThrottle).not.toHaveBeenCalled();
			expect(mockAuthRecovery.recoverAuth).not.toHaveBeenCalled();
		});
	});

	describe('with accountDeps', () => {
		it('skips routing when the session has no account assignment', () => {
			mockRegistry.getAssignment.mockReturnValue(null);
			const handler = setup({ accountDeps: true, authRecovery: true });

			handler('s1', makeError({ type: 'rate_limited' }));

			expect(mockThrottleHandler.handleThrottle).not.toHaveBeenCalled();
			expect(mockAuthRecovery.recoverAuth).not.toHaveBeenCalled();
		});

		it('routes rate_limited to the throttle handler', () => {
			const handler = setup({ accountDeps: true, authRecovery: true });

			handler('s1-ai-tab1', makeError({ type: 'rate_limited', message: 'throttled hard' }));

			expect(mockThrottleHandler.handleThrottle).toHaveBeenCalledWith({
				sessionId: 's1-ai-tab1',
				accountId: 'acct-1',
				errorType: 'rate_limited',
				errorMessage: 'throttled hard',
			});
			expect(mockAuthRecovery.recoverAuth).not.toHaveBeenCalled();
		});

		it('routes auth_expired to auth recovery, NOT the throttle handler', () => {
			const handler = setup({ accountDeps: true, authRecovery: true });

			handler('s1', makeError({ type: 'auth_expired' }));

			expect(mockAuthRecovery.recoverAuth).toHaveBeenCalledWith('s1', 'acct-1');
			expect(mockThrottleHandler.handleThrottle).not.toHaveBeenCalled();
		});

		it('falls back to the throttle handler for auth_expired when recovery is unavailable', () => {
			const handler = setup({ accountDeps: true, authRecovery: false });

			handler('s1', makeError({ type: 'auth_expired', message: 'expired' }));

			expect(mockThrottleHandler.handleThrottle).toHaveBeenCalledWith(
				expect.objectContaining({ errorType: 'auth_expired' })
			);
		});

		it('falls back to the throttle handler when getAuthRecovery is not provided', () => {
			const handler = setup({ accountDeps: true, authRecovery: 'absent' });

			handler('s1', makeError({ type: 'auth_expired' }));

			expect(mockThrottleHandler.handleThrottle).toHaveBeenCalled();
		});

		it('logs but does not crash when recoverAuth rejects', async () => {
			mockAuthRecovery.recoverAuth.mockRejectedValue(new Error('login timeout'));
			const handler = setup({ accountDeps: true, authRecovery: true });

			handler('s1', makeError({ type: 'auth_expired' }));
			// Flush the rejected promise's catch handler
			await new Promise((resolve) => setImmediate(resolve));

			expect(mockLogger.error).toHaveBeenCalledWith(
				'Auth recovery failed',
				'AgentError',
				expect.objectContaining({ sessionId: 's1' })
			);
		});

		it('does not route non-account error types', () => {
			const handler = setup({ accountDeps: true, authRecovery: true });

			for (const type of ['token_exhaustion', 'network_error', 'session_not_found'] as const) {
				handler('s1', makeError({ type }));
			}

			expect(mockThrottleHandler.handleThrottle).not.toHaveBeenCalled();
			expect(mockAuthRecovery.recoverAuth).not.toHaveBeenCalled();
		});
	});
});
