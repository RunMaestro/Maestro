import { describe, expect, it } from 'vitest';
import { composerFrom, EMPTY_COMPOSER } from '../draft';
import {
	INTERRUPT_NOTICE,
	QUIT_WINDOW_MS,
	decideCtrlC,
	interruptTurn,
	submitDraft,
} from '../turns';
import { createFakeClient } from '../../__tests__/fakeClient';

describe('decideCtrlC', () => {
	it('interrupts a running turn on the first press', () => {
		expect(decideCtrlC({ now: 5_000, lastAt: undefined, running: true })).toBe('interrupt');
	});

	it('only arms the quit window when nothing is running', () => {
		expect(decideCtrlC({ now: 5_000, lastAt: undefined, running: false })).toBe('arm-quit');
	});

	it('quits on a second press within one second, running or not', () => {
		expect(decideCtrlC({ now: 5_000 + QUIT_WINDOW_MS, lastAt: 5_000, running: true })).toBe('quit');
		expect(decideCtrlC({ now: 5_400, lastAt: 5_000, running: false })).toBe('quit');
	});

	it('starts over once the window has passed', () => {
		expect(decideCtrlC({ now: 5_000 + QUIT_WINDOW_MS + 1, lastAt: 5_000, running: true })).toBe(
			'interrupt'
		);
	});
});

describe('submitDraft', () => {
	it('sends the trimmed text with the exact call and reports a started turn', async () => {
		const fake = createFakeClient();
		const outcome = await submitDraft(fake.client, 'a1', 't1', composerFrom('Fix the bug  \n\n'));
		expect(fake.requests).toEqual([
			{ method: 'turns.send', args: ['a1', 't1', { text: 'Fix the bug' }] },
		]);
		expect(outcome).toEqual({ status: 'sent', queued: false, notice: '' });
	});

	it('keeps the inner line breaks of a multi-line message', async () => {
		const fake = createFakeClient();
		await submitDraft(fake.client, 'a1', 't1', composerFrom('line one\nline two'));
		expect(fake.requests[0]?.args[2]).toEqual({ text: 'line one\nline two' });
	});

	it('says where a message waits when the agent is busy (CH-4)', async () => {
		const fake = createFakeClient({
			sendReceipts: [{ status: 'queued', itemId: 'q1', position: 2, queueLength: 3 }],
		});
		const outcome = await submitDraft(fake.client, 'a1', 't1', composerFrom('next'));
		expect(outcome).toEqual({
			status: 'sent',
			queued: true,
			notice: 'Queued: 2 of 3 waiting behind the running turn.',
		});
	});

	it('sends nothing for a blank draft', async () => {
		const fake = createFakeClient();
		expect(await submitDraft(fake.client, 'a1', 't1', EMPTY_COMPOSER)).toEqual({
			status: 'empty',
		});
		expect(await submitDraft(fake.client, 'a1', 't1', composerFrom(' \n '))).toEqual({
			status: 'empty',
		});
		expect(fake.requests).toEqual([]);
	});

	it('reports the host refusal', async () => {
		const fake = createFakeClient({ failures: { 'turns.send': 'not-found' } });
		expect(await submitDraft(fake.client, 'a1', 't1', composerFrom('hi'))).toEqual({
			status: 'failed',
			message: 'fake not-found',
		});
	});
});

describe('interruptTurn', () => {
	it('stops the tab and says so', async () => {
		const fake = createFakeClient();
		const result = await interruptTurn(fake.client, 'a1', 't1');
		expect(fake.requests).toEqual([{ method: 'turns.interrupt', args: ['a1', 't1'] }]);
		expect(result).toEqual({ ok: true, value: INTERRUPT_NOTICE });
	});

	it('says nothing was running when the host stopped nothing', async () => {
		const fake = createFakeClient({ interruptStopped: false });
		expect(await interruptTurn(fake.client, 'a1', 't1')).toEqual({
			ok: true,
			value: 'No turn is running on this tab.',
		});
	});

	it('passes a refusal through', async () => {
		const fake = createFakeClient({ failures: { 'turns.interrupt': 'host-lost' } });
		const result = await interruptTurn(fake.client, 'a1', 't1');
		expect(result.ok).toBe(false);
	});
});
