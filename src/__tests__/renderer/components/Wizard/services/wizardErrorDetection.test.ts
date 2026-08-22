/**
 * Wizard error detection now runs on the canonical bank in
 * `shared/agentErrorPatterns.ts` rather than on its own copy of the regexes.
 * These tests pin the two things that consolidation could break: the wizard
 * still recognises everything its old bank did, and it never again tells the
 * user to go run a login command in a terminal.
 */

import { describe, it, expect } from 'vitest';
import {
	detectWizardError,
	formatWizardError,
	createGenericErrorMessage,
} from '../../../../../renderer/components/Wizard/services/wizardErrorDetection';

describe('detectWizardError', () => {
	it('returns null for empty output and for output with no known error', () => {
		expect(detectWizardError('', 'claude-code')).toBeNull();
		expect(detectWizardError('Everything went fine.', 'claude-code')).toBeNull();
	});

	describe('coverage the wizard had before the banks were merged', () => {
		// The six auth strings the wizard's own bank matched. Each must still be
		// detected through the canonical claude-code patterns.
		const legacyAuthOutputs = [
			'API Error: OAuth token has expired',
			'{"type":"authentication_error","message":"bad token"}',
			'Error: Invalid API key',
			'Please run `claude login` to authenticate',
			'Request failed: UNAUTHORIZED',
			'You are not authenticated',
		];

		it.each(legacyAuthOutputs)('classifies %j as auth_expired', (output) => {
			expect(detectWizardError(output, 'claude-code')?.type).toBe('auth_expired');
		});

		it('still classifies the non-auth types it used to', () => {
			expect(detectWizardError('Error: rate limit exceeded', 'claude-code')?.type).toBe(
				'rate_limited'
			);
			expect(detectWizardError('too many requests', 'claude-code')?.type).toBe('rate_limited');
			expect(detectWizardError('Service overloaded', 'claude-code')?.type).toBe('rate_limited');
			expect(detectWizardError('quota exceeded for this key', 'claude-code')?.type).toBe(
				'rate_limited'
			);
			expect(detectWizardError('context too long', 'claude-code')?.type).toBe('token_exhaustion');
			expect(detectWizardError('token limit reached', 'claude-code')?.type).toBe(
				'token_exhaustion'
			);
			expect(detectWizardError('connection refused', 'claude-code')?.type).toBe('network_error');
			expect(detectWizardError('read ECONNRESET', 'claude-code')?.type).toBe('network_error');
			expect(detectWizardError('socket hang up', 'claude-code')?.type).toBe('network_error');
			expect(detectWizardError('fatal error in agent', 'claude-code')?.type).toBe('agent_crashed');
		});
	});

	it('uses the failing agent’s bank, not claude-code’s', () => {
		// Codex-only phrasing: claude-code has no 403 auth pattern, codex does.
		const codexOnly = 'Error: 403 forbidden';
		expect(detectWizardError(codexOnly, 'codex')?.type).toBe('auth_expired');
		expect(detectWizardError(codexOnly, 'claude-code')?.type).not.toBe('auth_expired');

		// And the message comes from the agent that actually failed.
		expect(detectWizardError('invalid api key', 'codex')?.message).toContain('OpenAI');
	});

	describe('presentation', () => {
		it('offers no retry for an auth failure and points at the in-app sign-in', () => {
			const error = detectWizardError('OAuth token has expired', 'claude-code');
			expect(error).not.toBeNull();
			expect(error?.canRetry).toBe(false);
			expect(error?.title).toBe('Authentication Required');
			expect(error?.recoveryHint).toMatch(/sign in/i);
		});

		it('allows a retry for transient failures only', () => {
			expect(detectWizardError('rate limit exceeded', 'claude-code')?.canRetry).toBe(true);
			expect(detectWizardError('connection refused', 'claude-code')?.canRetry).toBe(true);
			expect(detectWizardError('context too long', 'claude-code')?.canRetry).toBe(false);
		});

		it('never sends the user to a terminal to log in', () => {
			const outputs = [
				'OAuth token has expired',
				'authentication_error',
				'Invalid API key',
				'Please run `claude login` to authenticate',
				'UNAUTHORIZED',
				'not authenticated',
				'rate limit exceeded',
				'connection refused',
			];
			for (const output of outputs) {
				for (const agent of ['claude-code', 'codex', 'opencode', 'copilot-cli'] as const) {
					const hint = detectWizardError(output, agent)?.recoveryHint ?? '';
					expect(hint).not.toMatch(/terminal/i);
					// "Maestro runs the login for you" is fine; "run <something> login"
					// is the dead end this phase removes.
					expect(hint).not.toMatch(/run\s+["`']?\w+\s+(login|auth)/i);
				}
			}
		});

		it('carries no login-command advice in the message either', () => {
			const messages = [
				detectWizardError('OAuth token has expired', 'claude-code')?.message,
				detectWizardError('authentication_error', 'claude-code')?.message,
				detectWizardError('Please run `claude login` to authenticate', 'claude-code')?.message,
				detectWizardError('Not authenticated', 'copilot-cli')?.message,
			];
			for (const message of messages) {
				expect(message).toBeTruthy();
				expect(message).not.toMatch(/claude login|gh auth login/i);
			}
		});
	});
});

describe('formatWizardError', () => {
	it('renders title, message, and hint', () => {
		const error = detectWizardError('OAuth token has expired', 'claude-code');
		expect(formatWizardError(error!)).toBe(
			`${error!.title}: ${error!.message}\n\n${error!.recoveryHint}`
		);
	});
});

describe('createGenericErrorMessage', () => {
	it('prefers a JSON message, then an error line, then the exit code', () => {
		expect(createGenericErrorMessage('{"message":"boom"}', 1)).toBe('boom');
		expect(createGenericErrorMessage('Error: something broke\nmore', 1)).toBe('something broke');
		expect(createGenericErrorMessage('', 7)).toContain('code 7');
	});
});
