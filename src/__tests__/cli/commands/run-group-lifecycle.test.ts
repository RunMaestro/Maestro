/**
 * @file run-group-lifecycle.test.ts
 * @description Tests for the run-group-lifecycle verb: the request it sends,
 * the refusals made before the app is asked, and what it reports.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import type { Group } from '../../../shared/types';

vi.mock('../../../cli/services/maestro-client', () => ({ withMaestroClient: vi.fn() }));
vi.mock('../../../cli/services/storage', () => ({
	resolveGroupId: vi.fn((id: string) => id),
	resolveAgentId: vi.fn((id: string) => id),
	readGroups: vi.fn(() => [] as Group[]),
	getSessionById: vi.fn(() => undefined),
	readLocalModelEndpoints: vi.fn(() => []),
	readSessions: vi.fn(() => []),
	readSettingValue: vi.fn(() => undefined),
	readSshRemotes: vi.fn(() => []),
}));

import { runGroupLifecycle } from '../../../cli/commands/run-group-lifecycle';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { readGroups } from '../../../cli/services/storage';

const GROUP: Group = { id: 'g1', name: 'BACKEND', emoji: '🛠', collapsed: false };

function mockSend(result: Record<string, unknown>) {
	let captured: Record<string, unknown> | undefined;
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
				captured = payload;
				return Promise.resolve(result);
			}),
		} as never)
	);
	return () => captured;
}

describe('run-group-lifecycle command', () => {
	let logSpy: MockInstance;
	let exitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(readGroups).mockReturnValue([GROUP]);
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
	});

	it('sends a run request that writes nothing, and prints where it was queued', async () => {
		const run = {
			stage: 'offboarding',
			subjectAgentId: 'a1',
			runAgentId: 'a1',
			tabId: 't1',
			tabName: 'Offboarding',
		};
		const payload = mockSend({ success: true, changed: [], lifecycleRun: run });

		await runGroupLifecycle('g1', 'Offboarding', { agent: 'a1', json: true });

		expect(payload()).toEqual({
			type: 'update_group_settings',
			groupId: 'g1',
			runLifecycle: { stage: 'offboarding', agentId: 'a1' },
		});
		expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual({
			success: true,
			groupId: 'g1',
			run,
		});
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('refuses an unknown stage before asking the app', async () => {
		await runGroupLifecycle('g1', 'midboarding', { agent: 'a1', json: true });
		expect(withMaestroClient).not.toHaveBeenCalled();
		expect(exitSpy).toHaveBeenCalled();
	});

	it('refuses a worktree group before asking the app', async () => {
		vi.mocked(readGroups).mockReturnValue([{ ...GROUP, kind: 'worktree' }]);
		await runGroupLifecycle('g1', 'onboarding', { agent: 'a1', json: true });
		expect(withMaestroClient).not.toHaveBeenCalled();
		expect(exitSpy).toHaveBeenCalled();
	});

	it("reports the app's refusal", async () => {
		mockSend({ success: false, error: '"BACKEND" has no Onboarding prompt.' });
		await runGroupLifecycle('g1', 'onboarding', { agent: 'a1', json: true });
		expect(logSpy.mock.calls.flat().join(' ')).toContain('no Onboarding prompt');
		expect(exitSpy).toHaveBeenCalled();
	});

	it('names an app too old to run the prompt', async () => {
		mockSend({ success: true, changed: [] });
		await runGroupLifecycle('g1', 'onboarding', { agent: 'a1', json: true });
		expect(logSpy.mock.calls.flat().join(' ')).toContain('does not know Onboarding');
	});
});
