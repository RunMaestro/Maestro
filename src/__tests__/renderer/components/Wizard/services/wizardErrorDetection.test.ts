/**
 * @file wizardErrorDetection.test.ts
 * @description Tests that the wizard classifies failures through the app's bank.
 *
 * The wizard used to carry its own regexes. They drifted: fewer auth patterns
 * than the canonical bank, and a recovery hint that told every user to run
 * `claude login` - not a real command, and the wrong provider for four of the
 * agents the wizard can drive. So the behavior under test is that detection is
 * delegated, and that what stays here (title, hint, retryability) is named for
 * the agent actually in use.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	detectWizardError,
	formatWizardError,
	createGenericErrorMessage,
	wizardErrorFromAgentError,
	captureAgentError,
} from '../../../../../renderer/components/Wizard/services/wizardErrorDetection';

// The two messages Cursor's bank produces (src/shared/agentErrorPatterns.ts).
const CURSOR_AUTH_MESSAGE = 'Not authenticated with Cursor. Sign in again to continue.';
const CURSOR_FREE_PLAN_MESSAGE =
	"Cursor's Free plan only allows the Auto model. Set this agent's model to auto, or upgrade your Cursor plan.";

describe('detectWizardError', () => {
	it('returns null for empty output and for ordinary output', () => {
		expect(detectWizardError('', 'claude-code')).toBeNull();
		expect(detectWizardError('Wrote 3 files.', 'claude-code')).toBeNull();
	});

	it('classifies an auth failure through the shared bank', () => {
		const error = detectWizardError('OAuth token has expired', 'claude-code');
		expect(error).toMatchObject({ type: 'auth_expired', title: 'Authentication Required' });
	});

	// The whole point of the move: the bank knows patterns the wizard's own copy
	// never had.
	it('recognises an auth failure the wizard bank used to miss', () => {
		// The old copy had `authentication_error` but not `authentication_failed`,
		// so this exact output classified as `unknown` in the wizard while the rest
		// of the app treated it as an expired login.
		expect(detectWizardError('{"error":"authentication_failed"}', 'claude-code')).toMatchObject({
			type: 'auth_expired',
		});
	});

	it('names the provider login command rather than assuming Claude', () => {
		expect(detectWizardError('unauthorized', 'codex')?.recoveryHint).toContain('codex login');
		expect(detectWizardError('unauthorized', 'claude-code')?.recoveryHint).toContain(
			'claude /login'
		);
	});

	// Some providers only expose the flow as a slash command inside their TUI.
	it('carries the TUI follow-up into the hint', () => {
		expect(detectWizardError('unauthorized', 'factory-droid')?.recoveryHint).toContain('/login');
	});

	// Resending is not the same question as "the user can fix this". An expired
	// login is fixable and retrying it is pointless until they sign in.
	it('marks an expired login as not worth retrying', () => {
		expect(detectWizardError('OAuth token has expired', 'claude-code')?.canRetry).toBe(false);
	});

	it('marks a transient failure as retryable', () => {
		expect(detectWizardError('ECONNRESET', 'claude-code')?.canRetry).toBe(true);
	});

	// The bank's streaming length guard exists for single-token chunks; the
	// wizard hands it a whole finished buffer, so a short one must still match.
	it('classifies output shorter than the streaming guard', () => {
		expect(detectWizardError('529', 'claude-code')).toMatchObject({ type: 'rate_limited' });
	});

	// No message here should send the user to a terminal to guess a command.
	it('does not repeat a login command inside the error message itself', () => {
		expect(detectWizardError('OAuth token has expired', 'claude-code')?.message).not.toContain(
			'claude login'
		);
	});
});

describe('formatWizardError', () => {
	it('puts the title, the message, and the hint into one string', () => {
		const error = detectWizardError('OAuth token has expired', 'claude-code');
		const text = formatWizardError(error!);
		expect(text).toContain(error!.title);
		expect(text).toContain(error!.message);
		expect(text).toContain(error!.recoveryHint);
	});
});

describe('createGenericErrorMessage', () => {
	it('prefers a JSON message field', () => {
		expect(createGenericErrorMessage('{"message": "boom"}', 1)).toBe('boom');
	});

	it('falls back to the first error line', () => {
		expect(createGenericErrorMessage('Error: something broke\nmore', 1)).toBe('something broke');
	});

	it('names the exit code when there is nothing else to say', () => {
		expect(createGenericErrorMessage('', 3)).toContain('3');
	});
});

describe('wizardErrorFromAgentError', () => {
	it('presents an expired Cursor login with the sign-in hint and no retry', () => {
		const error = wizardErrorFromAgentError(
			{ type: 'auth_expired', message: CURSOR_AUTH_MESSAGE },
			'cursor-cli'
		);
		expect(error).toMatchObject({
			type: 'auth_expired',
			title: 'Authentication Required',
			message: CURSOR_AUTH_MESSAGE,
			canRetry: false,
		});
		expect(error.recoveryHint).toContain('agent login');
	});

	it("presents Cursor's Free-plan refusal as a retryable agent error", () => {
		const error = wizardErrorFromAgentError(
			{ type: 'agent_crashed', message: CURSOR_FREE_PLAN_MESSAGE },
			'cursor-cli'
		);
		expect(error).toMatchObject({
			type: 'agent_crashed',
			title: 'Agent Error',
			message: CURSOR_FREE_PLAN_MESSAGE,
			canRetry: true,
		});
	});

	// The type crosses IPC as a plain string; only the taxonomy's own keys count.
	it('treats a type outside the taxonomy as unknown', () => {
		expect(wizardErrorFromAgentError({ type: 'not_a_type', message: 'x' }, 'cursor-cli').type).toBe(
			'unknown'
		);
		expect(wizardErrorFromAgentError({ type: 'toString', message: 'x' }, 'cursor-cli').type).toBe(
			'unknown'
		);
	});
});

describe('captureAgentError', () => {
	type AgentErrorCallback = (sessionId: string, error: { type: string; message: string }) => void;

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function stubOnAgentError() {
		let callback: AgentErrorCallback | undefined;
		const unsubscribe = vi.fn();
		const onAgentError = vi.fn((cb: AgentErrorCallback) => {
			callback = cb;
			return unsubscribe;
		});
		vi.stubGlobal('window', { maestro: { process: { onAgentError } } });
		return {
			emit: (sid: string, type: string, message: string) => callback?.(sid, { type, message }),
			unsubscribe,
		};
	}

	it('keeps the latest error for its own session and ignores other sessions', () => {
		const { emit } = stubOnAgentError();
		const capture = captureAgentError('wizard-1');

		emit('wizard-2', 'rate_limited', 'someone else');
		expect(capture.latest()).toBeUndefined();

		emit('wizard-1', 'rate_limited', 'first');
		emit('wizard-1', 'auth_expired', CURSOR_AUTH_MESSAGE);
		expect(capture.latest()).toEqual({ type: 'auth_expired', message: CURSOR_AUTH_MESSAGE });
	});

	it('unsubscribes on cleanup and still answers latest() afterwards', () => {
		const { emit, unsubscribe } = stubOnAgentError();
		const capture = captureAgentError('wizard-1');
		emit('wizard-1', 'auth_expired', CURSOR_AUTH_MESSAGE);

		capture.cleanup();
		capture.cleanup();
		expect(unsubscribe).toHaveBeenCalledTimes(1);
		expect(capture.latest()?.type).toBe('auth_expired');
	});

	it('works against a process mock that has no onAgentError', () => {
		vi.stubGlobal('window', { maestro: { process: {} } });
		const capture = captureAgentError('wizard-1');
		expect(capture.latest()).toBeUndefined();
		expect(() => capture.cleanup()).not.toThrow();
	});
});
