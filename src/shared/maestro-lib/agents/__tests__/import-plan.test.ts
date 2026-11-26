/**
 * `planAgentImport()`: the one `import_agent` rule both hosts apply (the headless host through the
 * repository, the desktop app through `importAgentIntoDesktop()`).
 */

import { describe, expect, it } from 'vitest';
import type { AgentImportInput } from '../../client/types';
import { planAgentImport, type AgentImportPlanContext } from '../import-plan';
import { DEFAULT_TAB_DEFAULTS, type RuleContext } from '../rules';

let next = 0;
const ctx: RuleContext = { newId: () => `id-${++next}`, now: () => 1000, random: () => 0 };

function input(extra: Partial<AgentImportInput> = {}): AgentImportInput {
	return {
		agent: { name: 'Substrate', provider: 'claude-code', cwd: '/work/substrate' },
		tabs: [
			{ id: 'tA', name: 'Main', agentSessionId: 'sess-A', logs: [] },
			{ id: 'tB', logs: [] },
		],
		...extra,
	};
}

function context(extra: Partial<AgentImportPlanContext> = {}): AgentImportPlanContext {
	return {
		agents: [],
		groupIds: ['g1'],
		defaults: DEFAULT_TAB_DEFAULTS,
		ctx,
		checkCwd: () => null,
		...extra,
	};
}

describe('planAgentImport', () => {
	it('builds the record with the imported tabs, their ids and their provider sessions', () => {
		const plan = planAgentImport(input({ activeTabId: 'tB' }), context());
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.agent.name).toBe('Substrate');
		expect(plan.agent.cwd).toBe('/work/substrate');
		expect(plan.agent.aiTabs?.map((tab) => tab.id)).toEqual(['tA', 'tB']);
		expect(plan.agent.aiTabs?.[0].agentSessionId).toBe('sess-A');
		expect(plan.agent.activeTabId).toBe('tB');
		expect(plan.agent.unifiedTabOrder).toEqual([
			{ type: 'ai', id: 'tA' },
			{ type: 'ai', id: 'tB' },
		]);
	});

	it('refuses a name the host already uses', () => {
		const plan = planAgentImport(
			input(),
			context({ agents: [{ id: 'x', name: 'substrate', cwd: '/elsewhere' }] })
		);
		expect(plan).toMatchObject({ ok: false, code: 'invalid' });
	});

	// T5: the agent's own copy, left by a Move Back while the host was down, is replaced.
	it('replaces the copy it names, whose name and directory are then no conflict', () => {
		const stale = { id: 'stale-1', name: 'Substrate', cwd: '/work/substrate' };
		const plan = planAgentImport(
			input({ replacesAgentId: 'stale-1' }),
			context({ agents: [stale] })
		);
		expect(plan).toMatchObject({ ok: true, replaces: 'stale-1' });
	});

	it('still refuses another agent with the name when it replaces one', () => {
		const plan = planAgentImport(
			input({ replacesAgentId: 'stale-1' }),
			context({
				agents: [
					{ id: 'stale-1', name: 'Old name', cwd: '/elsewhere' },
					{ id: 'other', name: 'substrate', cwd: '/elsewhere' },
				],
			})
		);
		expect(plan).toMatchObject({ ok: false, code: 'invalid' });
	});

	it('replaces nothing when the copy it names is gone, and checks the name as before', () => {
		const plan = planAgentImport(
			input({ replacesAgentId: 'gone' }),
			context({ agents: [{ id: 'x', name: 'substrate', cwd: '/elsewhere' }] })
		);
		expect(plan).toMatchObject({ ok: false, code: 'invalid' });
		const free = planAgentImport(input({ replacesAgentId: 'gone' }), context());
		expect(free.ok).toBe(true);
		expect(free).not.toHaveProperty('replaces');
	});

	it('refuses a group the host lacks as not found', () => {
		const plan = planAgentImport(
			input({ agent: { ...input().agent, groupId: 'missing' } }),
			context()
		);
		expect(plan).toEqual({ ok: false, code: 'not-found', message: 'No group missing.' });
	});

	it('refuses a working directory the host cannot use', () => {
		const plan = planAgentImport(input(), context({ checkCwd: () => 'No such directory' }));
		expect(plan).toEqual({ ok: false, code: 'invalid', message: 'No such directory' });
	});

	it('refuses an agent that still carries an SSH remote', () => {
		const plan = planAgentImport(
			input({
				agent: {
					...input().agent,
					ssh: { enabled: true, remoteId: 'r1' },
				} as AgentImportInput['agent'],
			}),
			context()
		);
		expect(plan).toMatchObject({ ok: false, code: 'invalid' });
	});
});
