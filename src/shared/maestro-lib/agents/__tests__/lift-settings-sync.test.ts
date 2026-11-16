/**
 * Federation settings sync: the three-way merge of a lifted agent's local pointer and its host
 * agent, what each side's change turns into, and what never crosses.
 */
import { describe, expect, it } from 'vitest';

import type { AgentRecord } from '../../store/records';
import {
	applyLiftSyncPull,
	planLiftedSettingsSync,
	readLiftSyncBaseline,
	settleLiftSyncBaseline,
	type LiftSyncBaseline,
} from '../lift-settings-sync';

/** The pointer this Maestro keeps: an SSH agent whose provider ran in the override directory. */
function local(overrides: Partial<AgentRecord> = {}): AgentRecord {
	return {
		id: 'local-1',
		name: 'Docs',
		toolType: 'claude-code',
		cwd: '/Users/me/placeholder',
		sessionSshRemoteConfig: { enabled: true, remoteId: 'r1', workingDirOverride: '/home/me/docs' },
		customModel: 'opus',
		nudgeMessage: 'keep going',
		aiTabs: [
			{ id: 'tab-1', name: 'Main', readOnlyMode: false },
			{ id: 'tab-2', hidden: true },
		],
		liftedTo: { peer: 'build-box', agentId: 'host-1', at: 1 },
		...overrides,
	};
}

/** The same agent as the host holds it after the lift. */
function host(overrides: Partial<AgentRecord> = {}): AgentRecord {
	return {
		id: 'host-1',
		name: 'Docs',
		toolType: 'claude-code',
		cwd: '/home/me/docs',
		customModel: 'opus',
		nudgeMessage: 'keep going',
		aiTabs: [{ id: 'tab-1', name: 'Main' }, { id: 'tab-host-only' }],
		...overrides,
	};
}

/** The baseline the first in-step pass leaves. */
function agreed(localRecord = local(), hostRecord = host()): LiftSyncBaseline {
	return planLiftedSettingsSync({ local: localRecord, host: hostRecord, now: 0 }).baseline;
}

describe('planLiftedSettingsSync', () => {
	it('does nothing for a pointer and host in step, and records them as agreed', () => {
		const plan = planLiftedSettingsSync({ local: local(), host: host(), now: 0 });
		expect(plan.pushes).toEqual([]);
		expect(plan.pulls).toBe(false);
		expect(plan.baseline.values).toMatchObject({
			name: 'Docs',
			cwd: '/home/me/docs',
			customModel: 'opus',
			nudgeMessage: 'keep going',
			customEffort: null,
			'tab:tab-1:name': 'Main',
			'tab:tab-1:readOnlyMode': null,
		});
	});

	it('sends a setting changed here as one agent update, clearing with null', () => {
		const baseline = agreed();
		const plan = planLiftedSettingsSync({
			local: local({ customModel: 'sonnet', nudgeMessage: undefined, customEffort: 'high' }),
			host: host(),
			baseline,
			now: 0,
		});
		expect(plan.pushes).toEqual([
			{
				action: {
					kind: 'update-agent',
					patch: { model: 'sonnet', effort: 'high', nudgeMessage: null },
				},
				ids: ['customModel', 'customEffort', 'nudgeMessage'],
				fieldIds: {
					model: ['customModel'],
					effort: ['customEffort'],
					nudgeMessage: ['nudgeMessage'],
				},
			},
		]);
		expect(plan.pulls).toBe(false);
		// Pushed fields keep their old agreed value until the host settles them.
		expect(plan.baseline.values.customModel).toBe('opus');
		expect(plan.pushed.customModel).toEqual({ local: 'sonnet', host: 'opus' });
	});

	it('sends a difference made before any baseline existed, and pulls nothing', () => {
		const plan = planLiftedSettingsSync({
			local: local({ nudgeMessage: 'new nudge' }),
			host: host(),
			now: 0,
		});
		expect(plan.pushes[0].action).toEqual({
			kind: 'update-agent',
			patch: { nudgeMessage: 'new nudge' },
		});
		expect(plan.pulls).toBe(false);
	});

	it('pulls a setting the host changed onto the pointer', () => {
		const baseline = agreed();
		const plan = planLiftedSettingsSync({
			local: local(),
			host: host({ customModel: 'haiku', newSessionMessage: 'hello' }),
			baseline,
			now: 0,
		});
		expect(plan.pushes).toEqual([]);
		expect(plan.pull.agent).toEqual({ customModel: 'haiku', newSessionMessage: 'hello' });
		expect(plan.baseline.values.customModel).toBe('haiku');
		const pulled = applyLiftSyncPull(local(), plan.pull);
		expect(pulled.customModel).toBe('haiku');
		expect(pulled.newSessionMessage).toBe('hello');
	});

	it('lets the local value win when both sides changed', () => {
		const baseline = agreed();
		const plan = planLiftedSettingsSync({
			local: local({ customModel: 'sonnet' }),
			host: host({ customModel: 'haiku' }),
			baseline,
			now: 0,
		});
		expect(plan.pushes[0].action).toEqual({ kind: 'update-agent', patch: { model: 'sonnet' } });
		expect(plan.pulls).toBe(false);
	});

	it('waits for a sent value to come back before reading the host as changed', () => {
		const first = planLiftedSettingsSync({
			local: local({ customModel: 'sonnet' }),
			host: host(),
			baseline: agreed(),
			now: 0,
		});
		const settled = settleLiftSyncBaseline(first, first.baseline, ['customModel']);
		const awaiting = { customModel: { before: 'opus', until: 100 } };
		// The host's record has not caught up yet: no pull of the old value.
		const waiting = planLiftedSettingsSync({
			local: local({ customModel: 'sonnet' }),
			host: host(),
			baseline: settled,
			awaiting,
			now: 50,
		});
		expect(waiting.pushes).toEqual([]);
		expect(waiting.pulls).toBe(false);
		// Once the wait is over, the host's value stands and comes back here.
		const expired = planLiftedSettingsSync({
			local: local({ customModel: 'sonnet' }),
			host: host(),
			baseline: settled,
			awaiting,
			now: 150,
		});
		expect(expired.pull.agent).toEqual({ customModel: 'opus' });
	});

	it('brings the host value back after a refusal settled the field', () => {
		const first = planLiftedSettingsSync({
			local: local({ cwd: '/elsewhere', sessionSshRemoteConfig: undefined }),
			host: host(),
			baseline: agreed(),
			now: 0,
		});
		expect(first.pushes[0].action).toEqual({ kind: 'update-agent', patch: { cwd: '/elsewhere' } });
		const refused = settleLiftSyncBaseline(first, first.baseline, ['cwd']);
		const next = planLiftedSettingsSync({
			local: local({ cwd: '/elsewhere', sessionSshRemoteConfig: undefined }),
			host: host(),
			baseline: refused,
			now: 0,
		});
		expect(next.pushes).toEqual([]);
		expect(next.pull.agent).toEqual({ cwd: '/home/me/docs' });
	});

	it('compares the working directory the provider runs in and writes it back there', () => {
		const baseline = agreed();
		const plan = planLiftedSettingsSync({
			local: local(),
			host: host({ cwd: '/home/me/docs-v2' }),
			baseline,
			now: 0,
		});
		const pulled = applyLiftSyncPull(local(), plan.pull);
		expect(pulled.cwd).toBe('/Users/me/placeholder');
		expect(pulled.sessionSshRemoteConfig).toEqual({
			enabled: true,
			remoteId: 'r1',
			workingDirOverride: '/home/me/docs-v2',
		});
	});

	it('treats the default spellings of unset as unset', () => {
		const plan = planLiftedSettingsSync({
			local: local({ codexTransport: 'exec', harnessControlMode: 'current', customEffort: '  ' }),
			host: host(),
			now: 0,
		});
		expect(plan.pushes).toEqual([]);
	});

	it('never syncs the group, the SSH settings, or the maestro-p binary path', () => {
		const plan = planLiftedSettingsSync({
			local: local({ groupId: 'g-local', maestroPPath: '/Users/me/bin/maestro-p' }),
			host: host({ groupId: 'g-host' }),
			now: 0,
		});
		expect(plan.pushes).toEqual([]);
		expect(plan.pulls).toBe(false);
	});

	describe('env vars', () => {
		it('sends one changed var, keeping the host vars this agent never set', () => {
			const hostRecord = host({ customEnvVars: { CLAUDE_CONFIG_DIR: '~/.claude-work', A: '1' } });
			const baseline = agreed(local({ customEnvVars: { A: '1' } }), hostRecord);
			const plan = planLiftedSettingsSync({
				local: local({ customEnvVars: { A: '2', B: '3' } }),
				host: hostRecord,
				baseline,
				now: 0,
			});
			expect(plan.pushes[0].action).toEqual({
				kind: 'update-agent',
				patch: { env: { CLAUDE_CONFIG_DIR: '~/.claude-work', A: '2', B: '3' } },
			});
			expect(plan.pushes[0].fieldIds).toEqual({ env: ['env:A', 'env:B'] });
		});

		it('sends a removal of a var this agent held', () => {
			const hostRecord = host({ customEnvVars: { A: '1', KEEP: 'x' } });
			const baseline = agreed(local({ customEnvVars: { A: '1' } }), hostRecord);
			expect(baseline.envKeys).toEqual(['A']);
			const plan = planLiftedSettingsSync({
				local: local({ customEnvVars: {} }),
				host: hostRecord,
				baseline,
				now: 0,
			});
			expect(plan.pushes[0].action).toEqual({
				kind: 'update-agent',
				patch: { env: { KEEP: 'x' } },
			});
		});

		it('never pulls or removes a host var this agent never set', () => {
			const plan = planLiftedSettingsSync({
				local: local(),
				host: host({ customEnvVars: { CLAUDE_CONFIG_DIR: '~/.claude-work' } }),
				now: 0,
			});
			expect(plan.pushes).toEqual([]);
			expect(plan.pulls).toBe(false);
		});

		it('keeps a secret the lift withheld here, and syncs one the host already holds', () => {
			const withheld = planLiftedSettingsSync({
				local: local({ customEnvVars: { ANTHROPIC_API_KEY: 'sk-local' } }),
				host: host(),
				now: 0,
			});
			expect(withheld.pushes).toEqual([]);
			const held = planLiftedSettingsSync({
				local: local({ customEnvVars: { ANTHROPIC_API_KEY: 'sk-new' } }),
				host: host({ customEnvVars: { ANTHROPIC_API_KEY: 'sk-old' } }),
				baseline: agreed(
					local({ customEnvVars: { ANTHROPIC_API_KEY: 'sk-old' } }),
					host({ customEnvVars: { ANTHROPIC_API_KEY: 'sk-old' } })
				),
				now: 0,
			});
			expect(held.pushes[0].action).toEqual({
				kind: 'update-agent',
				patch: { env: { ANTHROPIC_API_KEY: 'sk-new' } },
			});
		});

		it('pulls a host change to a var this agent holds', () => {
			const hostBefore = host({ customEnvVars: { A: '1' } });
			const localRecord = local({ customEnvVars: { A: '1', SECRET_TOKEN: 'kept' } });
			const baseline = agreed(localRecord, hostBefore);
			const plan = planLiftedSettingsSync({
				local: localRecord,
				host: host({ customEnvVars: { A: '9' } }),
				baseline,
				now: 0,
			});
			expect(plan.pull.env).toEqual({ A: '9' });
			expect(applyLiftSyncPull(localRecord, plan.pull).customEnvVars).toEqual({
				A: '9',
				SECRET_TOKEN: 'kept',
			});
		});
	});

	describe('tabs', () => {
		it('sends a rename, a star, and the composer chips of a tab both sides hold', () => {
			const plan = planLiftedSettingsSync({
				local: local({
					aiTabs: [
						{
							id: 'tab-1',
							name: 'Plan',
							starred: true,
							readOnlyMode: true,
							showThinking: 'sticky',
							customModel: 'sonnet',
						},
					],
				}),
				host: host(),
				baseline: agreed(),
				now: 0,
			});
			expect(plan.pushes.map((push) => push.action)).toEqual([
				{ kind: 'rename-tab', tabId: 'tab-1', name: 'Plan' },
				{ kind: 'star-tab', tabId: 'tab-1', starred: true },
				{
					kind: 'update-tab',
					tabId: 'tab-1',
					patch: { model: 'sonnet', readOnly: true, thinking: 'sticky' },
				},
			]);
		});

		it('ignores tabs only one side holds and hidden consult tabs', () => {
			const plan = planLiftedSettingsSync({
				local: local({
					aiTabs: [
						{ id: 'tab-1', name: 'Main' },
						{ id: 'tab-local-only', readOnlyMode: true },
						{ id: 'tab-2', hidden: true, readOnlyMode: true },
					],
				}),
				host: host({
					aiTabs: [
						{ id: 'tab-1', name: 'Main' },
						{ id: 'tab-2', hidden: true },
					],
				}),
				now: 0,
			});
			expect(plan.pushes).toEqual([]);
		});

		it('pulls a tab the host renamed, and keeps the host value for an unset it cannot send', () => {
			const plan = planLiftedSettingsSync({
				local: local({ aiTabs: [{ id: 'tab-1', name: 'Main' }] }),
				host: host({ aiTabs: [{ id: 'tab-1', name: 'Auto-named', saveToHistory: false }] }),
				baseline: agreed(),
				now: 0,
			});
			expect(plan.pushes).toEqual([]);
			expect(plan.pull.tabs).toEqual({
				'tab-1': { name: 'Auto-named', saveToHistory: false },
			});
			const pulled = applyLiftSyncPull(local(), plan.pull);
			expect(pulled.aiTabs?.[0]).toMatchObject({ name: 'Auto-named', saveToHistory: false });
		});
	});
});

describe('readLiftSyncBaseline', () => {
	it('keeps well-formed entries and drops the rest', () => {
		expect(
			readLiftSyncBaseline({
				values: { a: 'x', b: null, c: 3, d: true, e: { nested: 1 }, f: Number.NaN },
				envKeys: ['A', 7],
			})
		).toEqual({ values: { a: 'x', b: null, c: 3, d: true }, envKeys: ['A'] });
		expect(readLiftSyncBaseline(null)).toBeUndefined();
		expect(readLiftSyncBaseline({ values: [] })).toBeUndefined();
	});
});
