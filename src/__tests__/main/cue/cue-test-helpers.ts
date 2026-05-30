/**
 * Shared test factories for Cue engine tests.
 *
 * Provides createMockSession, createMockConfig, and createMockDeps
 * used across 6+ Cue test files. Centralizes the factory functions
 * to avoid duplication and ensure consistent defaults.
 */

import { vi } from 'vitest';
import type { CueConfig, CueEvent, CueRunResult } from '../../../main/cue/cue-types';
import type { SessionInfo } from '../../../shared/types';
import type { CueEngineDeps } from '../../../main/cue/cue-engine';

export function createMockSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
	return {
		id: 'session-1',
		name: 'Test Session',
		toolType: 'claude-code',
		cwd: '/projects/test',
		projectRoot: '/projects/test',
		...overrides,
	};
}

export function createMockConfig(overrides: Partial<CueConfig> = {}): CueConfig {
	return {
		subscriptions: [],
		settings: { timeout_minutes: 30, timeout_on_fail: 'break', max_concurrent: 1, queue_size: 10 },
		...overrides,
	};
}

export function createMockDeps(overrides: Partial<CueEngineDeps> = {}): CueEngineDeps {
	return {
		getSessions: vi.fn(() => [createMockSession()]),
		onCueRun: vi.fn(async (request: Parameters<CueEngineDeps['onCueRun']>[0]) => ({
			runId: 'run-1',
			sessionId: 'session-1',
			sessionName: 'Test Session',
			subscriptionName: request.subscriptionName,
			event: request.event,
			status: 'completed' as const,
			stdout: 'output',
			stderr: '',
			exitCode: 0,
			durationMs: 100,
			startedAt: new Date().toISOString(),
			endedAt: new Date().toISOString(),
		})),
		onStopCueRun: vi.fn(() => true),
		onLog: vi.fn(),
		...overrides,
	};
}
