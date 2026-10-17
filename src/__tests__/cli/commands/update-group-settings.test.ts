/**
 * @file update-group-settings.test.ts
 * @description Tests for the update-group-settings verb: the flags read into
 * the patch the app applies, the refusals made before the app is asked, the
 * publish confirmation, and the readback guard.
 */

import * as path from 'path';
import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import type { Group } from '../../../shared/types';

vi.mock('../../../cli/services/maestro-client', () => ({ withMaestroClient: vi.fn() }));
vi.mock('../../../cli/services/storage', () => ({
	resolveGroupId: vi.fn((id: string) => id),
	resolveAgentId: vi.fn((id: string) => id),
	readActiveAgentId: vi.fn(() => undefined),
	readGroups: vi.fn(() => [] as Group[]),
	getSessionsByGroup: vi.fn(() => []),
	readLocalModelEndpoints: vi.fn(() => []),
	readSessions: vi.fn(() => []),
	readSettingValue: vi.fn(() => undefined),
	readSshRemotes: vi.fn(() => []),
}));
vi.mock('../../../cli/utils/confirm', () => ({
	canPrompt: vi.fn(() => false),
	confirmOnTerminal: vi.fn(async () => false),
}));

import { updateGroupSettings } from '../../../cli/commands/update-group-settings';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import {
	getSessionsByGroup,
	readGroups,
	resolveAgentId,
	resolveGroupId,
} from '../../../cli/services/storage';
import { canPrompt, confirmOnTerminal } from '../../../cli/utils/confirm';

const BASE: Group = { id: 'g1', name: 'BACKEND', emoji: '🛠', collapsed: false };

function stored(group: Partial<Group> = {}): void {
	vi.mocked(readGroups).mockReturnValue([{ ...BASE, ...group }]);
}

/** Capture the one payload sent, and answer it. */
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

function members(count: number) {
	vi.mocked(getSessionsByGroup).mockReturnValue(
		Array.from({ length: count }, (_, i) => ({ id: `agent-${i}` })) as never
	);
}

describe('update-group-settings command', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	let exitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(resolveGroupId).mockImplementation((id: string) => id);
		vi.mocked(resolveAgentId).mockImplementation((id: string) => id);
		vi.mocked(getSessionsByGroup).mockReturnValue([]);
		vi.mocked(canPrompt).mockReturnValue(false);
		vi.mocked(confirmOnTerminal).mockResolvedValue(false);
		stored();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
	});

	describe('the request', () => {
		it('sends the defaults flags in update-agent vocabulary', async () => {
			const payload = mockSend({
				success: true,
				defaults: { toolType: 'claude-code', customModel: 'opus', nudgeMessage: 'Be brief.' },
				shortLabel: null,
				changed: ['Provider', 'Model', 'Nudge Message'],
			});
			stored({
				defaults: { toolType: 'claude-code', customModel: 'opus', nudgeMessage: 'Be brief.' },
			});

			await updateGroupSettings('g1', {
				provider: 'claude-code',
				model: 'opus',
				nudge: 'Be brief.',
			});

			expect(payload()).toEqual({
				type: 'update_group_settings',
				groupId: 'g1',
				configPatch: { toolType: 'claude-code', customModel: 'opus', nudgeMessage: 'Be brief.' },
			});
			expect(exitSpy).not.toHaveBeenCalled();
		});

		it('maps an empty string to a clear, like update-agent', async () => {
			const payload = mockSend({ success: true, defaults: null, shortLabel: null, changed: [] });

			await updateGroupSettings('g1', { nudge: '', env: ['A=1', 'B=2'] });

			expect(payload()?.configPatch).toEqual({
				nudgeMessage: null,
				customEnvVars: { A: '1', B: '2' },
			});
		});

		it('sends a local working directory as an absolute path', async () => {
			const payload = mockSend({ success: true, defaults: null, shortLabel: null, changed: [] });

			await updateGroupSettings('g1', { cwd: '/work/app' });

			// Made absolute against the CLI's cwd, which differs by platform.
			expect(payload()?.configPatch).toEqual({ projectRoot: path.resolve('/work/app') });
		});

		it('sends --provider none as a null provider', async () => {
			const payload = mockSend({ success: true, defaults: null, shortLabel: null, changed: [] });

			await updateGroupSettings('g1', { provider: 'none' });

			expect(payload()?.configPatch).toEqual({ toolType: null });
		});

		it('sends the SSH flags as an ssh patch', async () => {
			const payload = mockSend({ success: true, defaults: null, shortLabel: null, changed: [] });

			await updateGroupSettings('g1', { sshRemote: 'box', sshCwd: '/srv/app' });

			expect(payload()?.sshPatch).toEqual({
				enabled: true,
				remoteId: 'box',
				workingDirOverride: '/srv/app',
			});
		});

		it('resolves peers by name and sends the same patch update-agent sends', async () => {
			const payload = mockSend({ success: true, defaults: null, shortLabel: null, changed: [] });
			vi.mocked(resolveAgentId).mockImplementation((ref: string) =>
				ref === 'Reviewer' ? 'agent-reviewer' : ref
			);

			await updateGroupSettings('g1', {
				peer: ['Reviewer:r'],
				peerNote: ['Reviewer:Ask before merging.'],
				groupPeers: 'rw',
			});

			expect(payload()?.configPatch).toEqual({
				peerAgentEdits: {
					upsert: [{ sessionId: 'agent-reviewer', read: true, write: false }],
					notes: [{ sessionId: 'agent-reviewer', description: 'Ask before merging.' }],
				},
				groupPeerAccess: { read: true, write: true },
			});
		});

		it('sends --clear as clearDefaults and nothing else', async () => {
			const payload = mockSend({ success: true, defaults: null, shortLabel: null, changed: [] });

			await updateGroupSettings('g1', { clear: true });

			expect(payload()).toEqual({
				type: 'update_group_settings',
				groupId: 'g1',
				clearDefaults: true,
			});
		});
	});

	describe('refusals before the app is asked', () => {
		async function refused(options: Parameters<typeof updateGroupSettings>[1], message: string) {
			const payload = mockSend({ success: true });
			await updateGroupSettings('g1', options);
			expect(payload()).toBeUndefined();
			expect(exitSpy).toHaveBeenCalledWith(1);
			expect(errorSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain(message);
		}

		it('names the missing flags when there is nothing to do', async () => {
			await refused({}, 'Specify at least one field');
		});

		it('refuses a worktree group', async () => {
			stored({ kind: 'worktree' });
			await refused({ nudge: 'x' }, 'worktree group');
		});

		it('refuses a short label longer than the pill holds', async () => {
			await refused({ shortLabel: 'ABCDEFGHIJKLM' }, '12');
		});

		it('refuses an unknown provider', async () => {
			await refused({ provider: 'gpt-9' }, 'Invalid provider');
		});

		it('refuses --clear beside a default', async () => {
			await refused({ clear: true, model: 'opus' }, 'ambiguous');
		});

		it('refuses --clear with --publish', async () => {
			await refused({ clear: true, publish: true }, 'Clear on its own');
		});

		it('refuses --run-on when the group has no provider', async () => {
			await refused({ runOn: 'ollama:qwen3' }, 'default provider');
		});

		it('refuses a peer note on a peer with no row', async () => {
			await refused({ peerNote: ['agent-a:hello'] }, 'no peer row');
		});

		it('refuses a malformed --env', async () => {
			await refused({ env: ['NOEQUALS'] }, '--env');
		});
	});

	describe('--short-label', () => {
		it('sends a label and an empty label (which clears)', async () => {
			const payload = mockSend({ success: true, defaults: null, shortLabel: 'BE', changed: [] });
			stored({ shortLabel: 'BE' });
			await updateGroupSettings('g1', { shortLabel: 'BE' });
			expect(payload()?.shortLabel).toBe('BE');

			const cleared = mockSend({ success: true, defaults: null, shortLabel: null, changed: [] });
			stored();
			await updateGroupSettings('g1', { shortLabel: '' });
			expect(cleared()?.shortLabel).toBe('');
		});

		it('is not an error beside --publish, and contributes nothing to the push', async () => {
			const payload = mockSend({
				success: true,
				defaults: null,
				shortLabel: 'BE',
				changed: [],
				publish: {
					agents: [],
					skipped: [],
					changed: [],
					unpublished: [],
					replaced: [],
					providerBound: [],
				},
			});
			stored({ shortLabel: 'BE' });

			await updateGroupSettings('g1', { shortLabel: 'BE', publish: true, yes: true });

			expect(payload()).toMatchObject({ shortLabel: 'BE', publish: true });
			expect(exitSpy).not.toHaveBeenCalled();
		});
	});

	describe('--publish', () => {
		const published = {
			success: true,
			defaults: { nudgeMessage: 'N' },
			shortLabel: null,
			changed: ['Nudge Message', 'Working Directory'],
			publish: {
				agents: [
					{ id: 'agent-0', name: 'Scraper' },
					{ id: 'agent-1', name: 'API' },
				],
				skipped: [{ agentName: 'API', label: 'Run On', reason: 'Cannot reach it.' }],
				changed: ['Nudge Message'],
				unpublished: ['Working Directory'],
				replaced: [],
				providerBound: [],
			},
		};

		it('refuses without --yes when nobody can be asked', async () => {
			const payload = mockSend(published);
			members(2);

			await updateGroupSettings('g1', { nudge: 'N', publish: true });

			expect(payload()).toBeUndefined();
			expect(exitSpy).toHaveBeenCalledWith(1);
			const err = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
			expect(err).toContain('2 agents');
			expect(err).toContain('--yes');
		});

		it('sends with --yes and reports the agents and what it skipped', async () => {
			const payload = mockSend(published);
			stored({ defaults: { nudgeMessage: 'N' } });
			members(2);

			await updateGroupSettings('g1', { nudge: 'N', publish: true, yes: true });

			expect(payload()?.publish).toBe(true);
			const out = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
			expect(out).toContain('Published to 2 agents');
			expect(out).toContain('Scraper, API');
			expect(out).toContain('Not published (new agents only): Working Directory');
			expect(out).toContain('Skipped on API: Run On. Cannot reach it.');
		});

		it('asks on a terminal, and sends only when the answer is yes', async () => {
			const payload = mockSend(published);
			stored({ defaults: { nudgeMessage: 'N' } });
			members(2);
			vi.mocked(canPrompt).mockReturnValue(true);
			vi.mocked(confirmOnTerminal).mockResolvedValue(true);

			await updateGroupSettings('g1', { nudge: 'N', publish: true });

			expect(confirmOnTerminal).toHaveBeenCalledWith(expect.stringContaining('2 agents'));
			expect(payload()?.publish).toBe(true);
		});

		it('writes nothing when the answer is no', async () => {
			const payload = mockSend(published);
			members(2);
			vi.mocked(canPrompt).mockReturnValue(true);
			vi.mocked(confirmOnTerminal).mockResolvedValue(false);

			await updateGroupSettings('g1', { nudge: 'N', publish: true });

			expect(payload()).toBeUndefined();
			expect(exitSpy).toHaveBeenCalledWith(1);
		});

		it('does not ask when the group has no agents', async () => {
			mockSend({ ...published, publish: { ...published.publish, agents: [], skipped: [] } });
			stored({ defaults: { nudgeMessage: 'N' } });
			members(0);

			await updateGroupSettings('g1', { nudge: 'N', publish: true });

			expect(confirmOnTerminal).not.toHaveBeenCalled();
			expect(exitSpy).not.toHaveBeenCalled();
		});

		it('includes the publish report in JSON', async () => {
			mockSend(published);
			stored({ defaults: { nudgeMessage: 'N' } });
			members(2);

			await updateGroupSettings('g1', { nudge: 'N', publish: true, yes: true, json: true });

			const parsed = JSON.parse(logSpy.mock.calls[0][0]);
			expect(parsed.success).toBe(true);
			expect(parsed.publish.agents).toHaveLength(2);
			expect(parsed.publish.unpublished).toEqual(['Working Directory']);
		});
	});

	describe('the answer', () => {
		it("fails with the app's reason when it refuses", async () => {
			mockSend({ success: false, error: 'tier: no source has the id "x"' });

			await updateGroupSettings('g1', { nudge: 'N' });

			expect(exitSpy).toHaveBeenCalledWith(1);
			expect(errorSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
				'no source has the id'
			);
		});

		it('fails when the group on disk is not what the app said it stored', async () => {
			mockSend({
				success: true,
				defaults: { nudgeMessage: 'N' },
				shortLabel: null,
				changed: ['Nudge Message'],
			});
			// An older desktop accepted the message and dropped the field.
			stored({});

			await updateGroupSettings('g1', { nudge: 'N' });

			expect(exitSpy).toHaveBeenCalledWith(1);
			expect(errorSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
				'did not persist'
			);
		});

		it('prints what changed and the pill label', async () => {
			mockSend({
				success: true,
				defaults: { nudgeMessage: 'N' },
				shortLabel: null,
				changed: ['Nudge Message'],
			});
			stored({ defaults: { nudgeMessage: 'N' } });

			await updateGroupSettings('g1', { nudge: 'N' });

			const out = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
			expect(out).toContain('Updated group settings');
			expect(out).toContain('Changed: Nudge Message');
			expect(out).toContain('Pill label');
		});
	});
});
