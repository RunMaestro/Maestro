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

import { describe, it, expect } from 'vitest';
import {
	detectWizardError,
	formatWizardError,
	createGenericErrorMessage,
} from '../../../../../renderer/components/Wizard/services/wizardErrorDetection';

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
