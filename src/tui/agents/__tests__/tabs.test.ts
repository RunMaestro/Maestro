import { describe, expect, it } from 'vitest';
import type { AITabRecord, AgentRecord } from '../../../shared/maestro-lib';
import { createFakeClient } from '../../__tests__/fakeClient';
import { promptProblem, promptTitle, renameTabPrompt, submitPrompt } from '../manage';
import { submitCloseTab, submitNewTab, tabAfterClose } from '../tabs';

const tab = (id: string, name?: string): AITabRecord => ({ id, ...(name ? { name } : {}) });

const agent = (): AgentRecord => ({
	id: 'a1',
	name: 'Alpha',
	toolType: 'codex',
	aiTabs: [tab('t1', 'one'), tab('t2', 'two'), tab('t3')],
});

describe('tabAfterClose', () => {
	const tabs = [tab('t1'), tab('t2'), tab('t3')];

	it('lands on the left neighbor, else the right one', () => {
		expect(tabAfterClose(tabs, 't3')?.id).toBe('t2');
		expect(tabAfterClose(tabs, 't2')?.id).toBe('t1');
		expect(tabAfterClose(tabs, 't1')?.id).toBe('t2');
	});

	it('has no answer for the only tab or an unknown one', () => {
		expect(tabAfterClose([tab('t1')], 't1')).toBeUndefined();
		expect(tabAfterClose(tabs, 'nope')).toBeUndefined();
	});
});

describe('new and close', () => {
	it('opens a tab with the exact call and reports its id', async () => {
		const fake = createFakeClient({ agents: [agent()] });
		const result = await submitNewTab(fake.client, agent());
		expect(result).toEqual({
			ok: true,
			value: { tabId: 'new-tab-1', notice: 'Opened a new tab in Alpha.' },
		});
		expect(fake.requests).toEqual([{ method: 'tabs.create', args: ['a1'] }]);
	});

	it('closes a tab with the exact call and says where the transcript stays', async () => {
		const fake = createFakeClient({ agents: [agent()] });
		const result = await submitCloseTab(fake.client, agent(), tab('t2', 'two'));
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toContain('Closed two.');
			expect(result.value).toContain('closed-tab history');
			expect(result.value).toContain('History');
		}
		expect(fake.requests).toEqual([{ method: 'tabs.close', args: ['a1', 't2'] }]);
		expect(fake.closedTabs.map((closed) => closed.tab.id)).toEqual(['t2']);
	});

	it("passes the host's refusal through", async () => {
		const fake = createFakeClient({ agents: [agent()], failures: { 'tabs.close': 'rejected' } });
		const result = await submitCloseTab(fake.client, agent(), tab('t1'));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe('rejected');
	});
});

describe('renaming a tab', () => {
	it("starts from the tab's own name and allows an empty one", () => {
		const prompt = renameTabPrompt(agent(), tab('t1', 'one'));
		expect(prompt).toMatchObject({ kind: 'renameTab', agentId: 'a1', targetId: 't1', name: 'one' });
		expect(promptTitle(prompt)).toBe('Rename tab: one');
		expect(promptTitle(renameTabPrompt(agent(), tab('t3')))).toBe('Rename tab: unnamed');
		expect(promptProblem({ ...prompt, name: '' })).toBeNull();
	});

	it('sends the exact rename call', async () => {
		const fake = createFakeClient({ agents: [agent()] });
		const prompt = { ...renameTabPrompt(agent(), tab('t1', 'one')), name: ' uno ' };
		const result = await submitPrompt(fake.client, prompt);
		expect(result).toEqual({ ok: true, value: 'Renamed the tab to uno.' });
		expect(fake.requests).toEqual([{ method: 'tabs.rename', args: ['a1', 't1', 'uno'] }]);
	});

	it('clears the name with an empty box, and sends nothing when unchanged', async () => {
		const fake = createFakeClient({ agents: [agent()] });
		const base = renameTabPrompt(agent(), tab('t1', 'one'));
		expect(await submitPrompt(fake.client, { ...base, name: '' })).toEqual({
			ok: true,
			value: 'Cleared the tab name.',
		});
		expect(fake.requests).toEqual([{ method: 'tabs.rename', args: ['a1', 't1', ''] }]);
		expect(await submitPrompt(fake.client, base)).toEqual({ ok: true, value: 'Name unchanged.' });
		expect(fake.requests).toHaveLength(1);
	});
});
