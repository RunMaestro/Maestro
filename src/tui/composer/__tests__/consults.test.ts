import { describe, expect, it } from 'vitest';
import type { AgentRecord, GroupRecord } from '../../../shared/maestro-lib';
import { createFakeClient } from '../../__tests__/fakeClient';
import {
	addConsult,
	consultEntries,
	consultStyle,
	delegationPrompt,
	delegationWarning,
	mergeByTime,
	planMentionSend,
	runConsult,
	runDelegation,
	settleConsult,
	type ConsultItem,
} from '../consults';

const AGENTS: AgentRecord[] = [
	{ id: 'me', name: 'Frontend', toolType: 'claude-code', aiTabs: [{ id: 't1' }] },
	{ id: 'be', name: 'Backend', toolType: 'codex', groupId: 'g1', aiTabs: [{ id: 'bt' }] },
	{ id: 'dw', name: 'Docs Writer', toolType: 'claude-code', groupId: 'g1', aiTabs: [{ id: 'dt' }] },
];
const GROUPS: GroupRecord[] = [{ id: 'g1', name: 'Core' }];

const entry = (id: string, timestamp: number, source = 'ai') => ({
	id,
	timestamp,
	source,
	text: id,
});

describe('planning a send with mentions', () => {
	it('is undefined for a message that names no other agent', () => {
		expect(planMentionSend('just you', AGENTS, GROUPS, 'me')).toBeUndefined();
	});

	it('names the targets, the question, and what the source agent is sent', () => {
		const plan = planMentionSend(
			'check with @Backend and @Docs-Writer: ready?',
			AGENTS,
			GROUPS,
			'me'
		)!;
		expect(plan.targets).toEqual([
			{ id: 'be', name: 'Backend' },
			{ id: 'dw', name: 'Docs Writer' },
		]);
		expect(plan.suppressLocal).toBe(false);
		expect(plan.question).toBe('check with and : ready?');
		expect(plan.localText).toBe('check with "@Backend" and "@Docs-Writer": ready?');
	});

	it('addresses a leading mention to the consulted agent alone', () => {
		const plan = planMentionSend('@Backend what is the schema?', AGENTS, GROUPS, 'me')!;
		expect(plan.suppressLocal).toBe(true);
		expect(plan.question).toBe('what is the schema?');
	});
});

describe('answers shown inline', () => {
	const item = (overrides: Partial<ConsultItem> = {}): ConsultItem => ({
		id: 'c1',
		agentId: 'be',
		agentName: 'Backend',
		status: 'asking',
		text: '',
		at: 1000,
		...overrides,
	});

	it('shows the consulted agent under its own name, and where the answer stands', () => {
		const [pending] = consultEntries([item()]);
		expect(pending).toMatchObject({ source: 'consult:asking:Backend', text: '_Asking..._' });
		expect(consultStyle(pending!)).toEqual({ label: 'Backend (consulting)', dimColor: true });

		const [answered] = consultEntries([
			item({ status: 'answered', text: 'Use main.', settledAt: 2000 }),
		]);
		expect(answered).toMatchObject({ timestamp: 2000, text: 'Use main.' });
		expect(consultStyle(answered!)?.label).toBe('Backend (consult)');

		const [failed] = consultEntries([item({ status: 'failed', text: 'Agent not found' })]);
		expect(consultStyle(failed!)).toEqual({ label: 'Backend (no answer)', color: 'red' });
		expect(consultStyle({ id: 'x', timestamp: 0, source: 'ai', text: '' })).toBeUndefined();
	});

	it("puts the person's line above the answers once, for a message the source agent did not get", () => {
		const entries = consultEntries([
			item({ message: '@Backend @Docs-Writer hi' }),
			item({
				id: 'c2',
				agentId: 'dw',
				agentName: 'Docs Writer',
				message: '@Backend @Docs-Writer hi',
			}),
		]);
		expect(entries.map((e) => e.source)).toEqual([
			'user',
			'consult:asking:Backend',
			'consult:asking:Docs Writer',
		]);
	});

	it('settles one item without touching the others', () => {
		let all = addConsult({}, 'k', item());
		all = addConsult(all, 'k', item({ id: 'c2' }));
		all = settleConsult(all, 'k', 'c1', { status: 'answered', text: 'ok', settledAt: 5 });
		expect(all.k!.map((i) => i.status)).toEqual(['answered', 'asking']);
		expect(settleConsult(all, 'missing', 'c1', { status: 'failed', text: '' })).toBe(all);
	});

	it('merges into the transcript by time, keeping stored entries first on a tie', () => {
		const stored = [entry('a', 1), entry('b', 5), entry('c', 9)];
		const merged = mergeByTime(stored, [entry('x', 5, 'consult:answered:B'), entry('y', 20)]);
		expect(merged.map((e) => e.id)).toEqual(['a', 'b', 'x', 'c', 'y']);
		expect(mergeByTime(stored, [])).toBe(stored);
	});
});

describe('the calls', () => {
	const source = { agentId: 'me', tabId: 't1' };

	it('consults read-only through consults.ask, attributed to the asking agent and tab', async () => {
		const fake = createFakeClient({
			agents: AGENTS,
			consultReplies: { be: { answer: '  Use main.  ' } },
		});
		const settled = await runConsult(
			fake.client,
			source,
			{ id: 'be', name: 'Backend' },
			'which branch?',
			() => 7
		);
		expect(settled).toEqual({ status: 'answered', text: 'Use main.', settledAt: 7 });
		expect(fake.requests).toEqual([
			{
				method: 'consults.ask',
				args: [
					{
						targetAgentId: 'be',
						question: 'which branch?',
						fromAgentId: 'me',
						fromTabId: 't1',
					},
				],
			},
		]);
		// Nothing was sent to the consulted agent as a turn, and no tab was made there.
		expect(fake.requests.map((r) => r.method)).not.toContain('turns.send');
		expect(fake.requests.map((r) => r.method)).not.toContain('tabs.create');
	});

	it('reports a consult that failed with the host reason', async () => {
		const fake = createFakeClient({
			agents: AGENTS,
			consultReplies: { be: { code: 'not-found' } },
		});
		const settled = await runConsult(
			fake.client,
			source,
			{ id: 'be', name: 'Backend' },
			'q',
			() => 1
		);
		expect(settled).toMatchObject({ status: 'failed', text: 'fake not-found' });
	});

	it('says what a delegation grants before it is sent, naming every agent', () => {
		const warning = delegationWarning([
			{ id: 'be', name: 'Backend' },
			{ id: 'dw', name: 'Docs Writer' },
		]);
		expect(warning).toContain('Backend, Docs Writer');
		expect(warning).toContain('EDIT files and run commands');
		expect(warning).toContain('Ctrl-D again');
	});

	it('delegates as work in a new, named tab on the target, never in its open conversation', async () => {
		const fake = createFakeClient({ agents: AGENTS });
		const settled = await runDelegation(
			fake.client,
			'Frontend',
			{ id: 'be', name: 'Backend' },
			'add the endpoint',
			() => 3
		);
		expect(settled.status).toBe('delegated');
		expect(settled.text).toContain('edit rights');
		expect(settled.text).toContain('"From Frontend"');
		const methods = fake.requests.map((r) => r.method);
		expect(methods).toEqual(['tabs.create', 'tabs.rename', 'turns.send']);
		const send = fake.requests.find((r) => r.method === 'turns.send')!;
		expect(send.args[0]).toBe('be');
		expect(send.args[1]).toBe('new-tab-1');
		expect(send.args[2]).toEqual({ text: delegationPrompt('add the endpoint', 'Frontend') });
	});

	it('says a delegation is queued when the target is busy, and reports a refusal', async () => {
		const queued = createFakeClient({
			agents: AGENTS,
			sendReceipts: [{ status: 'queued', itemId: 'q', position: 1, queueLength: 1 }],
		});
		const waiting = await runDelegation(
			queued.client,
			'Frontend',
			{ id: 'be', name: 'Backend' },
			'x'
		);
		expect(waiting.text).toContain('queued');

		const refused = createFakeClient({ agents: AGENTS, failures: { 'tabs.create': 'rejected' } });
		const failed = await runDelegation(
			refused.client,
			'Frontend',
			{ id: 'be', name: 'Backend' },
			'x'
		);
		expect(failed.status).toBe('failed');
		expect(refused.requests.map((r) => r.method)).toEqual(['tabs.create']);
	});
});
