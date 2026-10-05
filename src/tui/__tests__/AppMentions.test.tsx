import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { render } from 'ink-testing-library';
import type { AgentRecord, GroupRecord } from '../../shared/maestro-lib';
import { App } from '../App';
import { createFakeClient, type FakeClientOptions } from './fakeClient';

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const ENTER = '\r';
const ESC = '\u001B';
const TAB = '\t';
const DOWN = '\u001B[B';
const CTRL_D = '\u0004';

const AGENTS: AgentRecord[] = [
	{
		id: 'a1',
		name: 'Alpha',
		toolType: 'claude-code',
		state: 'idle',
		activeTabId: 't1',
		aiTabs: [{ id: 't1', name: 'first' }],
	},
	{
		id: 'a2',
		name: 'Beta',
		toolType: 'codex',
		state: 'idle',
		groupId: 'g1',
		aiTabs: [{ id: 't2', name: 'two' }],
	},
	{
		id: 'a3',
		name: 'Gamma',
		toolType: 'claude-code',
		state: 'idle',
		groupId: 'g1',
		aiTabs: [{ id: 't3', name: 'three' }],
	},
];
const GROUPS: GroupRecord[] = [{ id: 'g1', name: 'Core' }];

describe('cross-agent mentions in the composer (XM-1 to XM-3)', () => {
	let dir: string;

	const mount = async (options: FakeClientOptions = {}) => {
		const fake = createFakeClient({ agents: AGENTS, groups: GROUPS, ...options });
		const instance = render(
			<App
				paths={{
					userDataDir: dir,
					sessionsFile: path.join(dir, 'maestro-sessions.json'),
					groupsFile: path.join(dir, 'maestro-groups.json'),
					settingsFile: path.join(dir, 'maestro-settings.json'),
					agentConfigsFile: path.join(dir, 'maestro-agent-configs.json'),
					historyDir: path.join(dir, 'history'),
				}}
				client={fake.client}
			/>
		);
		await tick();
		const stdout = instance.stdout as unknown as { emit: (event: string) => boolean };
		Object.defineProperty(stdout, 'columns', { value: 140, configurable: true });
		Object.defineProperty(stdout, 'rows', { value: 40, configurable: true });
		stdout.emit('resize');
		await tick();
		const press = async (...keys: string[]) => {
			for (const key of keys) {
				instance.stdin.write(key);
				await tick();
			}
		};
		const frame = () => instance.lastFrame() ?? '';
		const methods = () => fake.requests.map((request) => request.method);
		const request = (method: string) => fake.requests.filter((r) => r.method === method);
		/** Moves the agent cursor onto Alpha and gives the composer the keyboard. */
		const focusAlpha = async () => {
			for (
				let i = 0;
				i < 12 &&
				!/Alpha/.test(
					frame()
						.split('\n')
						.find((l) => l.includes('›')) ?? ''
				);
				i += 1
			) {
				await press('j');
			}
			await press(ENTER);
		};
		return { ...instance, fake, press, frame, methods, request, focusAlpha };
	};

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-tui-mentions-'));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('opens a picker on @ with the other agents and the group, and closes it with Esc keeping the text', async () => {
		const { press, frame, focusAlpha, unmount } = await mount();
		await focusAlpha();
		await press('h', 'i', ' ', '@');
		expect(frame()).toContain('Mention an agent');
		expect(frame()).toContain('Core');
		expect(frame()).toContain('group of 2 agents');
		expect(frame()).toContain('Beta');
		expect(frame()).toContain('Gamma');
		// The asker is never offered to itself.
		expect(frame().split('Mention an agent')[1]).not.toContain('Alpha');

		await press(ESC);
		expect(frame()).not.toContain('Mention an agent');
		expect(frame()).toContain('hi @');
		unmount();
	});

	it('filters as the name is typed and inserts the picked agent on Tab', async () => {
		const { press, frame, focusAlpha, unmount } = await mount();
		await focusAlpha();
		await press('@', 'b', 'e');
		const picker = frame().split('Mention an agent')[1] ?? '';
		expect(picker).toContain('Beta');
		expect(picker).not.toContain('Gamma');
		await press(TAB);
		expect(frame()).not.toContain('Mention an agent');
		expect(frame()).toContain('@Beta');
		unmount();
	});

	it('expands a picked group into its member agents', async () => {
		const { press, frame, focusAlpha, unmount } = await mount();
		await focusAlpha();
		await press('@', 'c', 'o', 'r', 'e');
		await press(ENTER);
		expect(frame()).toContain('@Beta @Gamma');
		expect(frame()).not.toContain('@Core');
		unmount();
	});

	it('moves the pick with the arrows before inserting', async () => {
		const { press, frame, focusAlpha, unmount } = await mount();
		await focusAlpha();
		await press('@', DOWN, DOWN, TAB);
		// Rows are Core, Beta, Gamma: two steps down lands on Gamma.
		expect(frame()).toContain('@Gamma');
		unmount();
	});

	it('consults a leading mention in the background and answers inline, without sending the agent a turn (XM-2)', async () => {
		const { press, frame, focusAlpha, request, methods, fake, unmount } = await mount({
			consultReplies: { a2: { answer: 'Use the main branch.' } },
			holdConsults: true,
		});
		await focusAlpha();
		await press(...'@Beta which branch?'.split(''));
		// Typing the name opened the picker; a space after a complete name closed it.
		await press(ENTER);
		expect(request('consults.ask')).toEqual([
			{
				method: 'consults.ask',
				args: [
					{
						targetAgentId: 'a2',
						question: 'which branch?',
						fromAgentId: 'a1',
						fromTabId: 't1',
					},
				],
			},
		]);
		// This agent is not sent the message, and the consulted agent gets no turn or tab.
		expect(methods()).not.toContain('turns.send');
		expect(methods()).not.toContain('tabs.create');
		expect(frame()).toContain('Beta (consulting)');
		expect(frame()).toContain('@Beta which branch?');

		fake.releaseConsults();
		await tick(60);
		expect(frame()).toContain('Beta (consult)');
		expect(frame()).toContain('Use the main branch.');
		expect(frame()).not.toContain('Beta (consulting)');
		unmount();
	});

	it('sends this agent the message too when the mention is not leading, with the name quoted so the desktop does not consult twice', async () => {
		const { press, frame, focusAlpha, request, unmount } = await mount({
			consultReplies: { a2: { answer: 'Yes, ready.' } },
		});
		await focusAlpha();
		await press(...'is @Beta ready?'.split(''));
		await press(ENTER);
		expect(request('turns.send')).toEqual([
			{ method: 'turns.send', args: ['a1', 't1', { text: 'is "@Beta" ready?' }] },
		]);
		expect(request('consults.ask')).toHaveLength(1);
		expect((request('consults.ask')[0]!.args[0] as { question: string }).question).toBe(
			'is ready?'
		);
		await tick(60);
		expect(frame()).toContain('Beta (consult)');
		expect(frame()).toContain('Yes, ready.');
		unmount();
	});

	it('does not consult when the local send is refused, and keeps the draft', async () => {
		const { press, frame, focusAlpha, request, unmount } = await mount({
			failures: { 'turns.send': 'rejected' },
		});
		await focusAlpha();
		await press(...'is @Beta ready?'.split(''));
		await press(ENTER);
		expect(request('consults.ask')).toEqual([]);
		expect(frame()).toContain('is @Beta ready?');
		unmount();
	});

	it('consults every agent a group expands to, one request each', async () => {
		const { press, focusAlpha, request, unmount } = await mount({
			consultReplies: { a2: { answer: 'b' }, a3: { answer: 'g' } },
		});
		await focusAlpha();
		await press('@', 'c', 'o', 'r', 'e', ENTER);
		await press(...'status?'.split(''));
		await press(ENTER);
		await tick(60);
		expect(
			request('consults.ask').map((r) => (r.args[0] as { targetAgentId: string }).targetAgentId)
		).toEqual(['a2', 'a3']);
		unmount();
	});

	it('shows a consult that failed under the agent, without losing the question', async () => {
		const { press, frame, focusAlpha, unmount } = await mount({
			consultReplies: { a2: { code: 'not-found' } },
		});
		await focusAlpha();
		await press(...'@Beta hello'.split(''));
		await press(ENTER);
		await tick(60);
		expect(frame()).toContain('Beta (no answer)');
		expect(frame()).toContain('fake not-found');
		expect(frame()).toContain('@Beta hello');
		unmount();
	});

	it('leaves an unknown @word alone: no consult, an ordinary send', async () => {
		const { press, focusAlpha, request, unmount } = await mount();
		await focusAlpha();
		await press(...'ping @nobody'.split(''));
		// Nothing matches, so no picker opens and Enter sends.
		await press(ENTER);
		expect(request('consults.ask')).toEqual([]);
		expect(request('turns.send')).toEqual([
			{ method: 'turns.send', args: ['a1', 't1', { text: 'ping @nobody' }] },
		]);
		unmount();
	});

	it('refuses a mention with nothing to ask and keeps the draft', async () => {
		const { press, frame, focusAlpha, request, unmount } = await mount();
		await focusAlpha();
		await press(...'@Beta'.split(''));
		await press(ESC, ENTER);
		expect(request('consults.ask')).toEqual([]);
		expect(request('turns.send')).toEqual([]);
		expect(frame()).toContain('Say what to ask Beta');
		unmount();
	});

	describe('delegating work (XM-3)', () => {
		it('says what it grants and sends nothing on the first press', async () => {
			const { press, frame, focusAlpha, methods, unmount } = await mount();
			await focusAlpha();
			await press(...'@Beta add the endpoint'.split(''));
			await press(CTRL_D);
			expect(frame()).toContain('Delegating to Beta');
			expect(frame()).toContain('EDIT files and run commands');
			expect(methods()).not.toContain('tabs.create');
			expect(methods()).not.toContain('turns.send');
			expect(methods()).not.toContain('consults.ask');
			unmount();
		});

		it('sends the work to a new tab on the agent on the second press', async () => {
			const { press, frame, focusAlpha, request, methods, unmount } = await mount();
			await focusAlpha();
			await press(...'@Beta add the endpoint'.split(''));
			await press(CTRL_D, CTRL_D);
			await tick(60);
			expect(
				methods().filter((m) => ['tabs.create', 'tabs.rename', 'turns.send'].includes(m))
			).toEqual(['tabs.create', 'tabs.rename', 'turns.send']);
			expect(request('turns.send')[0]!.args[0]).toBe('a2');
			expect(methods()).not.toContain('consults.ask');
			expect(frame()).toContain('Beta (delegated)');
			expect(frame()).toContain('edit rights');
			unmount();
		});

		it('disarms when anything else is typed, so the next Ctrl-D warns again', async () => {
			const { press, frame, focusAlpha, methods, unmount } = await mount();
			await focusAlpha();
			await press(...'@Beta add it'.split(''));
			await press(CTRL_D, '!', CTRL_D);
			expect(frame()).toContain('Delegating to Beta');
			expect(methods()).not.toContain('turns.send');
			unmount();
		});

		it('needs a mentioned agent to delegate to', async () => {
			const { press, frame, focusAlpha, methods, unmount } = await mount();
			await focusAlpha();
			await press(...'no one named'.split(''));
			await press(CTRL_D);
			expect(frame()).toContain('names an agent with @');
			expect(methods()).not.toContain('tabs.create');
			unmount();
		});
	});
});
