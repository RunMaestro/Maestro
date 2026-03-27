import { describe, it, expect } from 'vitest';
import {
	detectAcpError,
	isExpectedDisconnect,
	type DetectedError,
} from '../../../main/acp/acp-error-detector';

describe('ACP Error Detector', () => {
	describe('detectAcpError', () => {
		describe('JSON-RPC error codes', () => {
			it('should detect auth errors from error code', () => {
				const result = detectAcpError({ code: -32001, message: 'Unauthorized' });
				expect(result.type).toBe('auth_expired');
				expect(result.recoverable).toBe(true);
			});

			it('should detect auth expired from error code', () => {
				const result = detectAcpError({ code: -32002, message: 'Token expired' });
				expect(result.type).toBe('auth_expired');
				expect(result.recoverable).toBe(true);
			});

			it('should detect rate limiting from error code', () => {
				const result = detectAcpError({ code: -32010, message: 'Rate limited' });
				expect(result.type).toBe('rate_limited');
				expect(result.recoverable).toBe(true);
			});

			it('should detect quota exceeded from error code', () => {
				const result = detectAcpError({ code: -32011, message: 'Quota exceeded' });
				expect(result.type).toBe('rate_limited');
				expect(result.recoverable).toBe(true);
			});

			it('should detect context too long from error code', () => {
				const result = detectAcpError({ code: -32020, message: 'Context too long' });
				expect(result.type).toBe('token_exhaustion');
				expect(result.recoverable).toBe(true);
			});

			it('should detect token limit from error code', () => {
				const result = detectAcpError({ code: -32021, message: 'Token limit exceeded' });
				expect(result.type).toBe('token_exhaustion');
				expect(result.recoverable).toBe(true);
			});

			it('should detect session not found from error code', () => {
				const result = detectAcpError({ code: -32030, message: 'Session not found' });
				expect(result.type).toBe('session_not_found');
				expect(result.recoverable).toBe(true);
			});

			it('should detect connection error from error code', () => {
				const result = detectAcpError({ code: -32040, message: 'Connection failed' });
				expect(result.type).toBe('network_error');
				expect(result.recoverable).toBe(true);
			});

			it('should detect permission denied from error code', () => {
				const result = detectAcpError({ code: -32050, message: 'Permission denied' });
				expect(result.type).toBe('permission_denied');
				expect(result.recoverable).toBe(false);
			});

			it('should detect parse error from standard JSON-RPC code', () => {
				const result = detectAcpError({ code: -32700, message: 'Parse error' });
				expect(result.type).toBe('agent_crashed');
			});

			it('should detect internal error from standard JSON-RPC code', () => {
				const result = detectAcpError({ code: -32603, message: 'Internal error' });
				expect(result.type).toBe('agent_crashed');
			});
		});

		describe('message-based detection', () => {
			it('should detect auth errors from message keywords', () => {
				const tests = [
					'Invalid API key provided',
					'Authentication failed',
					'Unauthorized access',
					'Error 401: Unauthorized',
				];

				for (const message of tests) {
					const result = detectAcpError(message);
					expect(result.type).toBe('auth_expired');
					expect(result.recoverable).toBe(true);
				}
			});

			it('should detect rate limiting from message keywords', () => {
				const tests = [
					'Rate limit exceeded',
					'Too many requests',
					'Quota exceeded',
					'Error 429: Rate limited',
				];

				for (const message of tests) {
					const result = detectAcpError(message);
					expect(result.type).toBe('rate_limited');
					expect(result.recoverable).toBe(true);
				}
			});

			it('should detect token exhaustion from message keywords', () => {
				const tests = [
					'Context length exceeded',
					'Maximum tokens reached',
					'Token limit exceeded',
					'Input too long',
				];

				for (const message of tests) {
					const result = detectAcpError(message);
					expect(result.type).toBe('token_exhaustion');
					expect(result.recoverable).toBe(true);
				}
			});

			it('should detect network errors from message keywords', () => {
				const tests = [
					'Connection failed',
					'Network error occurred',
					'Request timed out',
					'ECONNREFUSED',
					'ECONNRESET',
					'ETIMEDOUT',
				];

				for (const message of tests) {
					const result = detectAcpError(message);
					expect(result.type).toBe('network_error');
					expect(result.recoverable).toBe(true);
				}
			});

			it('should detect session not found from message keywords', () => {
				const result = detectAcpError('Session not found');
				expect(result.type).toBe('session_not_found');
				expect(result.recoverable).toBe(true);
			});

			it('should detect permission denied from message keywords', () => {
				const tests = ['Permission denied', 'Access denied'];

				for (const message of tests) {
					const result = detectAcpError(message);
					expect(result.type).toBe('permission_denied');
					expect(result.recoverable).toBe(false);
				}
			});

			it('should return unknown for unrecognized errors', () => {
				const result = detectAcpError('Some random error message');
				expect(result.type).toBe('unknown');
				expect(result.recoverable).toBe(false);
			});
		});

		describe('Error input types', () => {
			it('should handle Error objects', () => {
				const error = new Error('Invalid API key');
				const result = detectAcpError(error);
				expect(result.type).toBe('auth_expired');
				// Message is replaced with user-friendly version from OpenCode patterns
				expect(result.message).toContain('Invalid');
			});

			it('should handle string errors', () => {
				const result = detectAcpError('Rate limit exceeded');
				expect(result.type).toBe('rate_limited');
				// Message is replaced with user-friendly version from OpenCode patterns
				expect(result.message).toContain('Rate limit');
			});

			it('should handle objects with code and message', () => {
				const result = detectAcpError({ code: -32010, message: 'Rate limited' });
				expect(result.type).toBe('rate_limited');
				expect(result.message).toBe('Rate limited');
			});

			it('should handle objects with only message', () => {
				const result = detectAcpError({ message: 'Connection refused' });
				expect(result.type).toBe('network_error');
				// Message is replaced with user-friendly version from OpenCode patterns
				expect(result.message).toContain('Connection');
			});

			it('should handle objects with no message', () => {
				const result = detectAcpError({ code: 500 } as { code: number; message?: string });
				expect(result.type).toBe('unknown');
				expect(result.message).toBe('Unknown error');
			});

			it('should use jsonRpcCode parameter when provided', () => {
				const result = detectAcpError('Something went wrong', -32010);
				expect(result.type).toBe('rate_limited');
			});

			it('should preserve original message when no pattern matches', () => {
				const result = detectAcpError('Some unique unrecognized error');
				expect(result.type).toBe('unknown');
				expect(result.message).toBe('Some unique unrecognized error');
			});
		});

		describe('OpenCode error patterns', () => {
			it('should match OpenCode-specific auth patterns', () => {
				const result = detectAcpError('invalid key provided');
				expect(result.type).toBe('auth_expired');
			});

			it('should match OpenCode context exceeded pattern', () => {
				const result = detectAcpError('context length exceeded the maximum');
				expect(result.type).toBe('token_exhaustion');
			});

			it('should match OpenCode rate limit patterns', () => {
				const result = detectAcpError('rate limit reached');
				expect(result.type).toBe('rate_limited');
			});
		});

		describe('Gemini CLI error patterns', () => {
			it('should match Gemini CLI Google auth failure', () => {
				const result = detectAcpError('Google auth failed');
				expect(result.type).toBe('auth_expired');
				expect(result.recoverable).toBe(true);
			});

			it('should match Gemini CLI GOOGLE_API_KEY pattern', () => {
				const result = detectAcpError('Please set GOOGLE_API_KEY environment variable');
				expect(result.type).toBe('auth_expired');
				expect(result.recoverable).toBe(true);
			});

			it('should match Gemini CLI GOOGLE_CLOUD_PROJECT pattern', () => {
				const result = detectAcpError(
					'GOOGLE_CLOUD_PROJECT not configured for this request'
				);
				expect(result.type).toBe('auth_expired');
				expect(result.recoverable).toBe(true);
			});

			it('should match Gemini CLI RESOURCE_EXHAUSTED pattern', () => {
				const result = detectAcpError('Error: RESOURCE_EXHAUSTED: quota exceeded', undefined, 'gemini-cli');
				expect(result.type).toBe('rate_limited');
				expect(result.recoverable).toBe(true);
			});

			it('should match Gemini CLI PERMISSION_DENIED pattern', () => {
				const result = detectAcpError('PERMISSION_DENIED: missing required IAM role');
				expect(result.type).toBe('permission_denied');
				expect(result.recoverable).toBe(false);
			});

			it('should match Gemini CLI UNAVAILABLE pattern', () => {
				const result = detectAcpError('UNAVAILABLE: service is currently down');
				expect(result.type).toBe('network_error');
				expect(result.recoverable).toBe(true);
			});

			it('should match Gemini CLI login required pattern', () => {
				const result = detectAcpError('login required to access this resource');
				expect(result.type).toBe('auth_expired');
				expect(result.recoverable).toBe(true);
			});
		});

		describe('agentType parameter', () => {
			it('should prioritize specified agent patterns when agentType is provided', () => {
				// GOOGLE_API_KEY is only in Gemini CLI patterns
				const result = detectAcpError(
					'Missing GOOGLE_API_KEY',
					undefined,
					'gemini-cli'
				);
				expect(result.type).toBe('auth_expired');
			});

			it('should still match patterns without agentType specified', () => {
				// GOOGLE_API_KEY should still match via fallback to all ACP agents
				const result = detectAcpError('Missing GOOGLE_API_KEY');
				expect(result.type).toBe('auth_expired');
			});

			it('should check all ACP agents when agentType does not match', () => {
				// RESOURCE_EXHAUSTED is a Gemini CLI pattern, but works for any ACP agent
				const result = detectAcpError(
					'RESOURCE_EXHAUSTED',
					undefined,
					'opencode'
				);
				expect(result.type).toBe('rate_limited');
			});

			it('should work with opencode agentType for OpenCode-specific patterns', () => {
				const result = detectAcpError('invalid key error', undefined, 'opencode');
				expect(result.type).toBe('auth_expired');
			});

			it('should fall back to keyword detection when no pattern matches', () => {
				const result = detectAcpError(
					'unauthorized access to resource',
					undefined,
					'gemini-cli'
				);
				expect(result.type).toBe('auth_expired');
			});
		});
	});

	describe('isExpectedDisconnect', () => {
		it('should identify connection closed as expected', () => {
			expect(isExpectedDisconnect(new Error('Connection closed'))).toBe(true);
			expect(isExpectedDisconnect('Connection closed')).toBe(true);
		});

		it('should identify process exited as expected', () => {
			expect(isExpectedDisconnect(new Error('Process exited'))).toBe(true);
		});

		it('should identify cancelled as expected', () => {
			expect(isExpectedDisconnect(new Error('Operation cancelled'))).toBe(true);
		});

		it('should identify SIGTERM as expected', () => {
			expect(isExpectedDisconnect(new Error('Received SIGTERM'))).toBe(true);
		});

		it('should identify SIGINT as expected', () => {
			expect(isExpectedDisconnect(new Error('Received SIGINT'))).toBe(true);
		});

		it('should not identify other errors as expected', () => {
			expect(isExpectedDisconnect(new Error('Invalid API key'))).toBe(false);
			expect(isExpectedDisconnect(new Error('Rate limited'))).toBe(false);
			expect(isExpectedDisconnect(new Error('Network error'))).toBe(false);
		});
	});

	describe('DetectedError interface', () => {
		it('should have correct structure', () => {
			const error: DetectedError = {
				type: 'auth_expired',
				message: 'API key invalid',
				recoverable: true,
			};

			expect(error.type).toBe('auth_expired');
			expect(error.message).toBe('API key invalid');
			expect(error.recoverable).toBe(true);
		});
	});
});
