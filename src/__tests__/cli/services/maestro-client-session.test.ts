/**
 * @file maestro-client-session.test.ts
 * @description Tests for CLI Maestro session resolution helpers
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionInfo } from '../../../shared/types';

vi.mock('../../../cli/services/storage', () => ({
	readSessions: vi.fn(),
}));

import { resolveSessionId } from '../../../cli/services/maestro-client';
import { readSessions } from '../../../cli/services/storage';

describe('resolveSessionId', () => {
	const mockSession = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
		id: 'session-123',
		name: 'Test Agent',
		toolType: 'claude-code',
		cwd: '/path/to/project',
		projectRoot: '/path/to/project',
		...overrides,
	});

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(readSessions).mockReturnValue([]);
	});

	it('uses an explicit session when provided', () => {
		expect(resolveSessionId({ session: 'target-session' })).toBe('target-session');
	});

	it('falls back to the first stored session when no session is provided', () => {
		vi.mocked(readSessions).mockReturnValue([mockSession({ id: 'first-session' })]);

		expect(resolveSessionId()).toBe('first-session');
	});

	it('exits when no session can be resolved', () => {
		const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

		expect(resolveSessionId()).toBe('');
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			'Error: No agents found. Create an agent in Maestro first.'
		);
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});
});
