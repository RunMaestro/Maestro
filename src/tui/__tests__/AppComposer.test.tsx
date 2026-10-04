import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { render } from 'ink-testing-library';
import type { AgentRecord, TurnEvent } from '../../shared/maestro-lib';
import { App } from '../App';
import { createFakeClient, type FakeClientOptions } from './fakeClient';

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const ENTER = '\r';
const ESC = '\u001B';
const BACKSPACE = '\u007f';
const LEFT = '\u001B[D';
const CTRL_C = '\u0003';
const CTRL_J = '\n';
const ALT_ENTER = '\u001B\r';

const T0 = Date.now();

const AGENTS = (
	tabExtras: Record<string, unknown> = {},
	state: 'idle' | 'busy' = 'idle'
): AgentRecord[] => [
	{
		id: 'a1',
		name: 'Alpha',
		toolType: 'claude-code',
		state,
		activeTabId: 't1',
		aiTabs: [
			{ id: 't1', name: 'first', state, ...tabExtras },
			{ id: 't2', name: 'second' },
		],
	},
];

describe('the composer and live turns in the App (CH-2, CH-3, CH-4)', () => {
	let dir: string;

	const mount = async (options: FakeClientOptions = {}, withClient = true) => {
		const fake = createFakeClient({ agents: AGENTS(), ...options });
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
				client={withClient ? fake.client : undefined}
			/>
		);
		await tick();
		const stdout = instance.stdout as unknown as { emit: (event: string) => boolean };
		Object.defineProperty(stdout, 'columns', { value: 140, configurable: true });
		Object.defineProperty(stdout, 'rows', { value: 36, configurable: true });
		stdout.emit('resize');
		await tick();
		const press = async (...keys: string[]) => {
			for (const key of keys) {
				instance.stdin.write(key);
				await tick();
			}
		};
		const turn = async (event: TurnEvent, tabId = 't1') => {
			fake.push({ type: 'turn', agentId: 'a1', tabId, event });
			await tick();
		};
		const sends = () => fake.requests.filter((request) => request.method === 'turns.send');
		return { ...instance, fake, press, turn, sends, frame: () => instance.lastFrame() ?? '' };
	};

	/** Rows from the top: the Ungrouped header, then Alpha. Enter on Alpha gives the composer the keyboard. */
	const FOCUS_COMPOSER = ['j', ENTER];

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-tui-composer-'));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	describe('typing and sending', () => {
		it('types letters that are keys elsewhere, and Enter sends the exact message', async () => {
			const { press, frame, sends, fake, unmount } = await mount();
			await press(...FOCUS_COMPOSER);
			expect(frame()).toContain('Type a message');
			// `t` is new tab, `x` closes one, `q` quits: in the composer they are letters.
			await press('t', 'q', 'x');
			expect(frame()).toContain('tqx');
			expect(fake.requests).toEqual([]);

			await press(ENTER);
			expect(sends()).toEqual([{ method: 'turns.send', args: ['a1', 't1', { text: 'tqx' }] }]);
			expect(frame()).not.toContain('tqx');
			expect(frame()).toContain('Type a message');
			unmount();
		});

		it('does not send a blank draft', async () => {
			const { press, sends, unmount } = await mount();
			await press(...FOCUS_COMPOSER, ' ', ENTER);
			expect(sends()).toEqual([]);
			unmount();
		});

		it('inserts a newline on Ctrl-J and on Alt-Enter, and sends them as one message', async () => {
			const { press, frame, sends, unmount } = await mount();
			await press(...FOCUS_COMPOSER, 'one', CTRL_J, 'two', ALT_ENTER, 'three');
			expect(frame()).toContain('one');
			expect(frame()).toContain('two');
			expect(frame()).toContain('three');
			expect(sends()).toEqual([]);
			await press(ENTER);
			expect(sends()[0]?.args[2]).toEqual({ text: 'one\ntwo\nthree' });
			unmount();
		});

		it('keeps the line breaks of a pasted block', async () => {
			const { press, sends, unmount } = await mount();
			await press(...FOCUS_COMPOSER, 'first line\r\nsecond line\rthird', ENTER);
			expect(sends()[0]?.args[2]).toEqual({ text: 'first line\nsecond line\nthird' });
			unmount();
		});

		it('edits at the caret: arrows, backspace, and the line keys', async () => {
			const { press, sends, unmount } = await mount();
			// "abd" -> Left -> "abXd" -> Backspace -> "abd" -> Ctrl-A -> "Zabd"
			await press(...FOCUS_COMPOSER, 'abd', LEFT, 'X', BACKSPACE, 'c', '\u0001', 'Z', ENTER);
			expect(sends()[0]?.args[2]).toEqual({ text: 'Zabcd' });
			unmount();
		});

		it('puts a refused message back in the box and says why', async () => {
			const { press, frame, sends, unmount } = await mount({
				failures: { 'turns.send': 'host-lost' },
			});
			await press(...FOCUS_COMPOSER, 'hello there', ENTER);
			expect(sends()).toHaveLength(1);
			expect(frame()).toContain('fake host-lost');
			expect(frame()).toContain('hello there');
			unmount();
		});

		it('keeps a draft per tab', async () => {
			const { press, frame, unmount } = await mount();
			await press(...FOCUS_COMPOSER, 'draft for first');
			// Esc leaves the composer; T opens the switcher on the open tab, j picks the second.
			await press(ESC, 'T', 'j', ENTER);
			expect(frame()).toContain('tab: second');
			await press(ENTER);
			expect(frame()).not.toContain('draft for first');
			await press('only here', ESC, 'T', 'k', ENTER, ENTER);
			expect(frame()).toContain('tab: first');
			expect(frame()).toContain('draft for first');
			expect(frame()).not.toContain('only here');
			unmount();
		});
	});

	describe('keys', () => {
		it('Esc gives the keys back to the Agents pane, where letters act again', async () => {
			const { press, fake, unmount } = await mount();
			await press(...FOCUS_COMPOSER, 't');
			expect(fake.requests).toEqual([]);
			await press(ESC, 't');
			expect(fake.requests).toEqual([{ method: 'tabs.create', args: ['a1'] }]);
			unmount();
		});

		it('Ctrl-K still opens the palette from the composer, and the palette lists the composer actions', async () => {
			const { press, frame, unmount } = await mount();
			await press(...FOCUS_COMPOSER, '\u000b');
			expect(frame()).toContain('Command palette');
			await press('interrupt');
			expect(frame()).toContain('Interrupt the turn');
			unmount();
		});

		it('has no composer when no desktop is attached, and the letters stay keys', async () => {
			const { press, frame, fake, unmount } = await mount({}, false);
			await press(...FOCUS_COMPOSER);
			expect(frame()).not.toContain('Type a message');
			expect(frame()).not.toContain('Message');
			expect(fake.requests).toEqual([]);
			unmount();
		});

		it('shows what the composer is for in its header', async () => {
			const { press, frame, unmount } = await mount();
			// With an agent selected the composer is drawn, but the keyboard is still the list's.
			await press('j');
			expect(frame()).toContain('Tab to type');
			await press(ENTER);
			expect(frame()).toContain('Enter send');
			expect(frame()).toContain('Ctrl-J / Alt-Enter newline');
			unmount();
		});
	});

	describe('a streamed turn', () => {
		const stream = async (turn: (event: TurnEvent) => Promise<void>) => {
			await turn({
				kind: 'user',
				at: T0,
				entry: { id: 'u1', timestamp: T0, source: 'user', text: 'List the files' },
			});
			await turn({ kind: 'started', at: T0 + 10 });
			await turn({ kind: 'thinking', at: T0 + 20, text: 'Let me look around.' });
			await turn({
				kind: 'tool',
				at: T0 + 30,
				tool: { id: 'c1', name: 'Bash', status: 'running', detail: { input: { command: 'ls' } } },
			});
			await turn({
				kind: 'tool',
				at: T0 + 40,
				tool: {
					id: 'c1',
					name: 'Bash',
					status: 'completed',
					detail: { input: { command: 'ls' }, output: 'a.ts' },
				},
			});
			await turn({ kind: 'text', at: T0 + 50, text: 'Found ' });
			await turn({ kind: 'text', at: T0 + 60, text: '**one** file.' });
		};

		it('renders the reply as it arrives, tool calls collapsed, thinking hidden by default', async () => {
			const { press, turn, frame, unmount } = await mount();
			await press(...FOCUS_COMPOSER);
			await stream(turn);
			expect(frame()).toContain('List the files');
			expect(frame()).toMatch(/✓ .*ls/);
			expect(frame()).toContain('Found one file.');
			expect(frame()).not.toContain('Let me look around.');
			expect(frame()).toContain('Agent is working');
			unmount();
		});

		it('shows thinking in sticky mode, and in on mode only until the answer starts', async () => {
			const sticky = await mount({ agents: AGENTS({ showThinking: 'sticky' }) });
			await sticky.press(...FOCUS_COMPOSER);
			await stream(sticky.turn);
			expect(sticky.frame()).toContain('Let me look around.');
			sticky.unmount();

			const on = await mount({ agents: AGENTS({ showThinking: 'on' }) });
			await on.press(...FOCUS_COMPOSER);
			await on.turn({ kind: 'started', at: T0 });
			await on.turn({ kind: 'thinking', at: T0 + 1, text: 'Pondering.' });
			expect(on.frame()).toContain('Pondering.');
			await on.turn({ kind: 'text', at: T0 + 2, text: 'Answer.' });
			expect(on.frame()).not.toContain('Pondering.');
			expect(on.frame()).toContain('Answer.');
			on.unmount();
		});

		it('hands over to the stored transcript once it holds the finished turn', async () => {
			const { press, turn, frame, fake, unmount } = await mount();
			await press(...FOCUS_COMPOSER);
			await stream(turn);
			fake.setTranscript('a1', 't1', [
				{ id: 'u1', timestamp: T0, source: 'user', text: 'List the files' },
				{ id: 'r1', timestamp: T0 + 100, source: 'ai', text: 'Stored version of the reply' },
			]);
			await turn({ kind: 'outcome', at: T0 + 80, outcome: 'completed', exitCode: 0 });
			await tick(300);
			expect(frame()).toContain('Stored version of the reply');
			expect(frame()).not.toContain('Found one file.');
			expect(frame()).not.toContain('Agent is working');
			unmount();
		});

		it('says why an interrupted turn stopped', async () => {
			const { press, turn, frame, unmount } = await mount();
			await press(...FOCUS_COMPOSER);
			await turn({ kind: 'started', at: T0 });
			await turn({ kind: 'outcome', at: T0 + 5, outcome: 'interrupted', exitCode: null });
			expect(frame()).toContain('The turn was interrupted.');
			unmount();
		});

		it("ignores another tab's events", async () => {
			const { press, turn, frame, unmount } = await mount();
			await press(...FOCUS_COMPOSER);
			await turn({ kind: 'text', at: T0, text: 'From the other tab' }, 't2');
			expect(frame()).not.toContain('From the other tab');
			unmount();
		});

		it('does not read the transcript on every chunk of a long reply', async () => {
			const { press, turn, fake, unmount } = await mount();
			await press(...FOCUS_COMPOSER);
			await turn({ kind: 'started', at: T0 });
			await tick(300);
			const reads = fake.transcriptReads.length;
			for (let chunk = 0; chunk < 12; chunk++) {
				await turn({ kind: 'text', at: T0 + chunk, text: `chunk ${chunk} ` });
			}
			await tick(300);
			expect(fake.transcriptReads.length).toBe(reads);
			unmount();
		});
	});

	describe('queueing while the agent is busy (CH-4)', () => {
		it('sends the message, says where it waits, and shows the queued count', async () => {
			const { press, frame, sends, fake, unmount } = await mount({
				agents: AGENTS({}, 'busy'),
				sendReceipts: [{ status: 'queued', itemId: 'q1', position: 1, queueLength: 1 }],
			});
			await press(...FOCUS_COMPOSER);
			expect(frame()).toContain('Agent is working: Enter queues your message');
			expect(frame()).not.toContain('queued ·');

			fake.setQueue([
				{ itemId: 'q1', tabId: 't1', queuedAt: T0, kind: 'message', text: 'later', paused: false },
				{
					itemId: 'q2',
					tabId: 't2',
					queuedAt: T0,
					kind: 'message',
					text: 'elsewhere',
					paused: false,
				},
			]);
			await press('later', ENTER);
			await tick(60);
			expect(sends()[0]?.args).toEqual(['a1', 't1', { text: 'later' }]);
			expect(frame()).toContain('Queued: 1 of 1 waiting behind the running turn.');
			// Only this tab's items count.
			expect(frame()).toContain('1 queued');
			unmount();
		});

		it('re-reads the queue when a turn ends', async () => {
			const { press, turn, frame, fake, unmount } = await mount({
				queue: [
					{ itemId: 'q1', tabId: 't1', queuedAt: T0, kind: 'message', text: 'x', paused: false },
				],
			});
			await press(...FOCUS_COMPOSER);
			expect(frame()).toContain('1 queued');
			fake.setQueue([]);
			await turn({ kind: 'outcome', at: T0, outcome: 'completed', exitCode: 0 });
			await tick(60);
			expect(frame()).not.toContain('queued');
			unmount();
		});
	});

	describe('Ctrl-C', () => {
		it('interrupts the running turn with the exact call', async () => {
			const { press, turn, frame, fake, unmount } = await mount();
			await press(...FOCUS_COMPOSER);
			await turn({ kind: 'started', at: T0 });
			await press(CTRL_C);
			expect(fake.requests).toEqual([{ method: 'turns.interrupt', args: ['a1', 't1'] }]);
			expect(frame()).toContain('Interrupting the turn. Press Ctrl-C again to quit.');
			unmount();
		});

		it('quits on a second Ctrl-C within a second', async () => {
			const { press, frame, unmount } = await mount();
			await press(...FOCUS_COMPOSER, 'ab');
			await press(CTRL_C);
			expect(frame()).toContain('Nothing is running. Press Ctrl-C again to quit.');
			await press(CTRL_C);
			await press('cd');
			// Ink left the last frame on screen after exit: the later keys never reached the box.
			expect(frame()).toContain('ab');
			expect(frame()).not.toContain('abcd');
			unmount();
		});

		it('does not quit when the second press comes after the window', async () => {
			const { press, frame, unmount } = await mount();
			await press(...FOCUS_COMPOSER, 'ab', CTRL_C);
			await tick(1100);
			await press(CTRL_C, 'cd');
			expect(frame()).toContain('abcd');
			unmount();
		});

		it('stops a busy tab even though no event was seen for it, and does not claim the key for the palette entry', async () => {
			const { press, fake, unmount } = await mount({ agents: AGENTS({}, 'busy') });
			await press(...FOCUS_COMPOSER, CTRL_C);
			expect(fake.requests).toEqual([{ method: 'turns.interrupt', args: ['a1', 't1'] }]);
			unmount();
		});

		it('the palette entry only interrupts: it never arms the quit window', async () => {
			const { press, frame, fake, unmount } = await mount({ interruptStopped: false });
			await press(...FOCUS_COMPOSER, '\u000b', 'interrupt', ENTER);
			expect(fake.requests).toEqual([{ method: 'turns.interrupt', args: ['a1', 't1'] }]);
			expect(frame()).toContain('No turn is running on this tab.');
			unmount();
		});
	});
});
