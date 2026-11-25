/**
 * Federation settings sync: the three-way merge of a hosted agent's local copy and its host
 * record. The host is the default: a host change is taken, a change made here is sent, and a field
 * both sides changed (or one that differs on the first sync) waits for the person.
 */
import { describe, expect, it } from 'vitest';

import type { AgentRecord } from '../../store/records';
import {
	AGENT_PATCH_FEDERATION,
	TAB_PATCH_FEDERATION,
	applyLiftSyncPull,
	liftFollowUpPatch,
	liftSyncAgentValues,
	liftSyncFieldLabel,
	overlaySyncValues,
	planLiftedSettingsSync,
	readLiftSyncBaseline,
	settleLiftSyncBaseline,
	syncedAgentPatchFields,
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
		expect(plan.conflicts).toEqual([]);
		expect(plan.baseline.values).toMatchObject({
			name: 'Docs',
			cwd: '/home/me/docs',
			customModel: 'opus',
			nudgeMessage: 'keep going',
			customEffort: null,
			'tab:tab-1:name': 'Main',
		});
	});

	it('sends a setting changed here as one agent update, clearing with null', () => {
		const plan = planLiftedSettingsSync({
			local: local({ customModel: 'sonnet', nudgeMessage: undefined, customEffort: 'high' }),
			host: host(),
			baseline: agreed(),
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

	it('takes a setting another conductor changed on the host', () => {
		const plan = planLiftedSettingsSync({
			local: local(),
			host: host({ customModel: 'haiku', newSessionMessage: 'hello' }),
			baseline: agreed(),
			now: 0,
		});
		expect(plan.pushes).toEqual([]);
		expect(plan.conflicts).toEqual([]);
		expect(plan.pull.agent).toEqual({ customModel: 'haiku', newSessionMessage: 'hello' });
		expect(plan.baseline.values.customModel).toBe('haiku');
		const pulled = applyLiftSyncPull(local(), plan.pull);
		expect(pulled.customModel).toBe('haiku');
		expect(pulled.newSessionMessage).toBe('hello');
	});

	it('asks the person when both sides changed the same field', () => {
		const plan = planLiftedSettingsSync({
			local: local({ nudgeMessage: 'mine' }),
			host: host({ nudgeMessage: 'theirs' }),
			baseline: agreed(),
			now: 0,
		});
		expect(plan.pushes).toEqual([]);
		expect(plan.pulls).toBe(false);
		expect(plan.conflicts).toEqual([
			{
				id: 'nudgeMessage',
				label: 'Nudge message',
				local: 'mine',
				host: 'theirs',
				mergeable: true,
				firstSync: false,
			},
		]);
		// Nothing agreed moves until the person picks.
		expect(plan.baseline.values.nudgeMessage).toBe('keep going');
	});

	it('asks the person about every difference on the first sync, and pulls nothing', () => {
		const plan = planLiftedSettingsSync({
			local: local({ nudgeMessage: 'stale edit', customModel: 'sonnet' }),
			host: host(),
			now: 0,
		});
		expect(plan.pushes).toEqual([]);
		expect(plan.pulls).toBe(false);
		expect(plan.conflicts.map((conflict) => [conflict.id, conflict.firstSync])).toEqual([
			['customModel', true],
			['nudgeMessage', true],
		]);
		expect(plan.baseline.values).not.toHaveProperty('nudgeMessage');
	});

	describe('resolutions', () => {
		const conflicting = () => ({
			local: local({ nudgeMessage: 'mine' }),
			host: host({ nudgeMessage: 'theirs' }),
			baseline: agreed(),
			now: 0,
		});

		it('takes the host value onto this copy', () => {
			const plan = planLiftedSettingsSync({
				...conflicting(),
				resolutions: { nudgeMessage: { take: 'host' } },
			});
			expect(plan.conflicts).toEqual([]);
			expect(plan.pull.agent).toEqual({ nudgeMessage: 'theirs' });
			expect(plan.baseline.values.nudgeMessage).toBe('theirs');
		});

		it('sends this copy to the host', () => {
			const plan = planLiftedSettingsSync({
				...conflicting(),
				resolutions: { nudgeMessage: { take: 'local' } },
			});
			expect(plan.conflicts).toEqual([]);
			expect(plan.pushes[0].action).toEqual({
				kind: 'update-agent',
				patch: { nudgeMessage: 'mine' },
			});
		});

		it('writes a merged value here and sends it to the host', () => {
			const plan = planLiftedSettingsSync({
				...conflicting(),
				resolutions: { nudgeMessage: { take: 'value', value: 'mine and theirs' } },
			});
			expect(plan.pushes[0].action).toEqual({
				kind: 'update-agent',
				patch: { nudgeMessage: 'mine and theirs' },
			});
			expect(plan.pull.agent).toEqual({ nudgeMessage: 'mine and theirs' });
			const settled = settleLiftSyncBaseline(plan, plan.baseline, ['nudgeMessage']);
			expect(settled.values.nudgeMessage).toBe('mine and theirs');
		});

		it('settles a first-sync conflict once the host took the pick', () => {
			const first = planLiftedSettingsSync({
				local: local({ nudgeMessage: 'stale edit' }),
				host: host(),
				resolutions: { nudgeMessage: { take: 'local' } },
				now: 0,
			});
			expect(first.baseline.values).not.toHaveProperty('nudgeMessage');
			const settled = settleLiftSyncBaseline(first, first.baseline, ['nudgeMessage']);
			expect(settled.values.nudgeMessage).toBe('stale edit');
		});
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

	it('writes the working directory back where the provider runs', () => {
		const plan = planLiftedSettingsSync({
			local: local(),
			host: host({ cwd: '/home/me/docs-v2' }),
			baseline: agreed(),
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
		expect(plan.conflicts).toEqual([]);
		expect(plan.pushes).toEqual([]);
	});

	it('never syncs the group, the SSH settings, or the maestro-p binary path', () => {
		const plan = planLiftedSettingsSync({
			local: local({ groupId: 'g-local', maestroPPath: '/Users/me/bin/maestro-p' }),
			host: host({ groupId: 'g-host' }),
			now: 0,
		});
		expect(plan.pushes).toEqual([]);
		expect(plan.conflicts).toEqual([]);
	});

	describe('env vars', () => {
		it('sends one changed var, keeping the host vars this agent never set', () => {
			const hostRecord = host({ customEnvVars: { CLAUDE_CONFIG_DIR: '~/.claude-work', A: '1' } });
			const baseline = agreed(local({ customEnvVars: { A: '1' } }), hostRecord);
			const plan = planLiftedSettingsSync({
				local: local({ customEnvVars: { A: '2' } }),
				host: hostRecord,
				baseline,
				now: 0,
			});
			expect(plan.pushes[0].action).toEqual({
				kind: 'update-agent',
				patch: { env: { CLAUDE_CONFIG_DIR: '~/.claude-work', A: '2' } },
			});
			expect(plan.pushes[0].fieldIds).toEqual({ env: ['env:A'] });
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
			expect(plan.conflicts).toEqual([]);
			expect(plan.pulls).toBe(false);
		});

		it('keeps a secret the lift withheld here, and syncs one the host already holds', () => {
			const withheld = planLiftedSettingsSync({
				local: local({ customEnvVars: { ANTHROPIC_API_KEY: 'sk-local' } }),
				host: host(),
				now: 0,
			});
			expect(withheld.pushes).toEqual([]);
			expect(withheld.conflicts).toEqual([]);
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

		it('takes a host change to a var this agent holds', () => {
			const hostBefore = host({ customEnvVars: { A: '1' } });
			const localRecord = local({ customEnvVars: { A: '1', SECRET_TOKEN: 'kept' } });
			const plan = planLiftedSettingsSync({
				local: localRecord,
				host: host({ customEnvVars: { A: '9' } }),
				baseline: agreed(localRecord, hostBefore),
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
		it('syncs only the tab name; each conductor keeps their own chips and star', () => {
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
			]);
		});

		it('takes a tab the host renamed, and ignores tabs only one side holds', () => {
			const plan = planLiftedSettingsSync({
				local: local({ aiTabs: [{ id: 'tab-1', name: 'Main' }, { id: 'tab-local-only' }] }),
				host: host({ aiTabs: [{ id: 'tab-1', name: 'Auto-named' }] }),
				baseline: agreed(),
				now: 0,
			});
			expect(plan.pushes).toEqual([]);
			expect(plan.pull.tabs).toEqual({ 'tab-1': { name: 'Auto-named' } });
		});
	});
});

describe('pending edits on a mirrored agent', () => {
	it('stands for the host record with the edited fields in it', () => {
		const record = overlaySyncValues(host({ customEnvVars: { A: '1' } }), {
			nudgeMessage: 'edited',
			customModel: null,
			'env:B': '2',
		});
		expect(record.nudgeMessage).toBe('edited');
		expect(record).not.toHaveProperty('customModel');
		expect(record.customEnvVars).toEqual({ A: '1', B: '2' });
	});

	it('sends an edit whose base is still the host value, and asks when the host moved since', () => {
		const sent = planLiftedSettingsSync({
			local: overlaySyncValues(host(), { nudgeMessage: 'edited' }),
			host: host(),
			baseline: { values: { nudgeMessage: 'keep going' }, envKeys: [] },
			now: 0,
		});
		expect(sent.pushes[0].action).toEqual({
			kind: 'update-agent',
			patch: { nudgeMessage: 'edited' },
		});
		const moved = planLiftedSettingsSync({
			local: overlaySyncValues(host({ nudgeMessage: 'other' }), { nudgeMessage: 'edited' }),
			host: host({ nudgeMessage: 'other' }),
			baseline: { values: { nudgeMessage: 'keep going' }, envKeys: [] },
			now: 0,
		});
		expect(moved.pushes).toEqual([]);
		expect(moved.conflicts.map((conflict) => conflict.id)).toEqual(['nudgeMessage']);
	});

	it('reads every shared setting by field id', () => {
		const values = liftSyncAgentValues(host({ customEnvVars: { A: '1' }, bookmarked: true }));
		expect(values).toMatchObject({
			name: 'Docs',
			customModel: 'opus',
			bookmarked: true,
			'env:A': '1',
		});
	});
});

describe('liftFollowUpPatch', () => {
	it('carries the settings an import cannot', () => {
		expect(
			liftFollowUpPatch(
				local({ bookmarked: true, codexTransport: 'app-server', enableMaestroP: false })
			)
		).toEqual({ bookmarked: true, codexTransport: 'app-server', enableMaestroP: false });
	});

	it('is undefined when the agent sets none of them', () => {
		expect(liftFollowUpPatch(local({ codexTransport: 'exec' }))).toBeUndefined();
	});
});

describe('liftSyncFieldLabel', () => {
	it('names agent fields, env vars, and tab names', () => {
		expect(liftSyncFieldLabel('nudgeMessage')).toBe('Nudge message');
		expect(liftSyncFieldLabel('env:FOO')).toBe('Env var FOO');
		expect(liftSyncFieldLabel('tab:t1:name')).toBe('Tab name');
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

describe('the Federation decision table', () => {
	it('syncs exactly the agent fields it calls shared', () => {
		const shared = Object.entries(AGENT_PATCH_FEDERATION)
			.filter(([, rule]) => rule.scope === 'shared')
			.map(([field]) => field)
			.sort();
		expect([...syncedAgentPatchFields()].sort()).toEqual(shared);
	});

	it('shares no tab setting through tabs.update, only the conversation the tab resumes', () => {
		const shared = Object.entries(TAB_PATCH_FEDERATION)
			.filter(([, rule]) => rule.scope === 'shared')
			.map(([field]) => field);
		expect(shared).toEqual(['agentSessionId']);
	});
});
