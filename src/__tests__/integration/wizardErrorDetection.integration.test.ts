import { describe, expect, it } from 'vitest';
import {
	createGenericErrorMessage,
	detectWizardError,
	formatWizardError,
	type WizardError,
} from '../../renderer/components/Wizard/services/wizardErrorDetection';

describe('wizardErrorDetection', () => {
	describe('detectWizardError', () => {
		it.each([
			{
				output: 'OAuth token has expired while starting Claude',
				type: 'auth_expired',
				title: 'Authentication Expired',
				canRetry: false,
			},
			{
				output: 'authentication_error: session is no longer valid',
				type: 'auth_expired',
				title: 'Authentication Error',
				canRetry: false,
			},
			{
				output: 'invalid api key supplied',
				type: 'auth_expired',
				title: 'Invalid API Key',
				canRetry: false,
			},
			{
				output: 'Please run claude login before continuing',
				type: 'auth_expired',
				title: 'Login Required',
				canRetry: false,
			},
			{
				output: 'HTTP 401 unauthorized',
				type: 'auth_expired',
				title: 'Unauthorized',
				canRetry: false,
			},
			{
				output: 'user is not authenticated',
				type: 'auth_expired',
				title: 'Not Authenticated',
				canRetry: false,
			},
			{
				output: 'rate limit reached',
				type: 'rate_limited',
				title: 'Rate Limited',
				canRetry: true,
			},
			{
				output: '429 too many requests',
				type: 'rate_limited',
				title: 'Too Many Requests',
				canRetry: true,
			},
			{
				output: '529 overloaded',
				type: 'rate_limited',
				title: 'Service Overloaded',
				canRetry: true,
			},
			{
				output: 'quota exceeded',
				type: 'rate_limited',
				title: 'Quota Exceeded',
				canRetry: false,
			},
			{
				output: 'context window is too long',
				type: 'token_exhaustion',
				title: 'Context Too Long',
				canRetry: false,
			},
			{
				output: 'maximum output tokens reached',
				type: 'token_exhaustion',
				title: 'Token Limit Reached',
				canRetry: false,
			},
			{
				output: 'connection reset by peer',
				type: 'network_error',
				title: 'Connection Failed',
				canRetry: true,
			},
			{
				output: 'ETIMEDOUT while contacting provider',
				type: 'network_error',
				title: 'Network Error',
				canRetry: true,
			},
			{
				output: 'network unavailable',
				type: 'network_error',
				title: 'Network Unavailable',
				canRetry: true,
			},
			{
				output: 'socket hang up',
				type: 'network_error',
				title: 'Connection Interrupted',
				canRetry: true,
			},
			{
				output: 'fatal error: unexpected provider state',
				type: 'agent_crashed',
				title: 'Agent Error',
				canRetry: true,
			},
			{
				output: 'panic: runtime failure',
				type: 'agent_crashed',
				title: 'Agent Crashed',
				canRetry: true,
			},
		])('detects $title', ({ output, type, title, canRetry }) => {
			expect(detectWizardError(output)).toMatchObject({
				type,
				title,
				canRetry,
			});
		});

		it('returns null for empty or non-error output', () => {
			expect(detectWizardError('')).toBeNull();
			expect(detectWizardError('Wizard generated a valid plan.')).toBeNull();
		});
	});

	describe('formatWizardError', () => {
		it('formats title, message, and recovery hint for display', () => {
			const error: WizardError = {
				type: 'network_error',
				title: 'Network Error',
				message: 'A network error occurred.',
				recoveryHint: 'Check your internet connection.',
				canRetry: true,
			};

			expect(formatWizardError(error)).toBe(
				'Network Error: A network error occurred.\n\nCheck your internet connection.'
			);
		});
	});

	describe('createGenericErrorMessage', () => {
		it('uses JSON error messages when present', () => {
			expect(createGenericErrorMessage('{"message":"Provider rejected the request"}', 1)).toBe(
				'Provider rejected the request'
			);
		});

		it('uses the first error line when JSON message is absent', () => {
			expect(createGenericErrorMessage('stderr\nError: missing binary\nmore details', 127)).toBe(
				'missing binary'
			);
		});

		it('falls back to the exit code when no useful message is found', () => {
			expect(createGenericErrorMessage('ordinary output', 42)).toBe(
				'Agent exited with code 42. Check the terminal for details.'
			);
		});
	});
});
