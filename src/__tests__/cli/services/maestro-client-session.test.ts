/**
 * @file maestro-client-session.test.ts
 * @description Tests for CLI Maestro session resolution helpers
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionInfo } from '../../../shared/types';

vi.mock('../../../cli/services/storage', () => ({
	getSessionById: vi.fn(),
	readSessions: vi.fn(),
	readSettings: vi.fn(),
}));

import { resolveSessionId } from '../../../cli/services/maestro-client';
import { getSessionById, readSessions, readSettings } from '../../../cli/services/storage';

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
		vi.mocked(readSettings).mockReturnValue({});
		vi.mocked(readSessions).mockReturnValue([]);
		vi.mocked(getSessionById).mockReturnValue(undefined);
	});

	it('uses an explicit session when provided', () => {
		expect(resolveSessionId({ session: 'target-session' })).toBe('target-session');
		expect(readSettings).not.toHaveBeenCalled();
	});

	it('uses the active session from settings when it exists', () => {
		vi.mocked(readSettings).mockReturnValue({ activeSessionId: 'active-session' });
		vi.mocked(getSessionById).mockReturnValue(mockSession({ id: 'active-session' }));

		expect(resolveSessionId()).toBe('active-session');
	});

	it('falls back to the first stored session when there is no active session', () => {
		vi.mocked(readSessions).mockReturnValue([mockSession({ id: 'first-session' })]);

		expect(resolveSessionId()).toBe('first-session');
	});

	it('throws when no session can be resolved', () => {
		expect(() => resolveSessionId()).toThrow(
			'No Maestro sessions found. Pass --session <id> to target a specific session.'
		);
	});
});
