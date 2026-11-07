/**
 * @file agent-output-tap.test.ts
 *
 * What reaches a speaker, and what must never. The filters are asserted against
 * the shapes agents really emit - fenced code, unified diffs, tool gutters,
 * spinner frames, bare paths - because every one of them read aloud is a defect
 * a user hears immediately and reports as "it read me a diff".
 *
 * The source is a bare EventEmitter on purpose: that is what `ProcessManager` is,
 * and binding the suite to the real class would test the process manager.
 */

import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';

import {
	AgentOutputTap,
	type AgentOutputChunk,
} from '../../../../main/acappella/speech/agent-output-tap';

const AGENT = 'agent-1';
const TAB = 'tab-7';
const PROCESS_ID = `${AGENT}-ai-${TAB}`;

function harness(options: { minChunkChars?: number; hangMs?: number } = {}) {
	const source = new EventEmitter();
	const chunks: AgentOutputChunk[] = [];
	const timers: { fn: () => void; ms: number }[] = [];

	const tap = new AgentOutputTap({
		source,
		onChunk: (chunk) => chunks.push(chunk),
		minChunkChars: options.minChunkChars ?? 200,
		hangMs: options.hangMs ?? 20_000,
		now: () => 1_000,
		setTimeoutFn: (fn, ms) => {
			timers.push({ fn, ms });
			return timers.length as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimeoutFn: vi.fn(),
	});
	tap.watch({ agentSessionId: AGENT, tabId: TAB });

	return {
		tap,
		chunks,
		spoken: () => chunks.map((chunk) => chunk.text),
		data: (text: string) => source.emit('data', PROCESS_ID, text),
		complete: () => source.emit('query-complete', PROCESS_ID, {}),
		fail: (message: string) => source.emit('agent-error', PROCESS_ID, { message }),
		exit: (code: number) => source.emit('exit', PROCESS_ID, code),
		fireHang: () => timers[timers.length - 1]?.fn(),
	};
}

describe('AgentOutputTap', () => {
	it('emits the finished reply as one spoken chunk', () => {
		const h = harness();
		h.data('Fixed the auth bug.\nIt was a stale token check.\n');
		h.complete();

		expect(h.spoken()).toEqual(['Fixed the auth bug. It was a stale token check.']);
		expect(h.chunks[0].kind).toBe('final');
		expect(h.chunks[0].agentSessionId).toBe(AGENT);
		expect(h.chunks[0].tabId).toBe(TAB);
	});

	it('never speaks a code fence, even when it spans several output events', () => {
		const h = harness();
		h.data('Here is the fix:\n\n```ts\nconst token = read');
		h.data('Fresh();\nreturn token;\n```\n\nThat is the whole change.\n');
		h.complete();

		expect(h.spoken().join(' ')).not.toContain('token');
		expect(h.spoken()).toEqual(['Here is the fix:', 'That is the whole change.']);
	});

	it('drops diffs, tool gutters, bare paths, spinners, and progress readouts', () => {
		const h = harness();
		h.data(
			[
				'⏺ Bash(npm test)',
				'⎿ 18 passed',
				'diff --git a/src/main/auth.ts b/src/main/auth.ts',
				'@@ -1,4 +1,4 @@',
				'-const token = read();',
				'+const token = readFresh();',
				'src/main/auth/middleware.ts',
				'⠋ thinking',
				'42% done',
				'──────────────',
				'The auth fix is in.',
				'',
			].join('\n')
		);
		h.complete();

		expect(h.spoken()).toEqual(['The auth fix is in.']);
	});

	it('strips ANSI rather than reading escape codes aloud', () => {
		const h = harness();
		h.data('[32mTests pass.[0m\n');
		h.complete();

		expect(h.spoken()).toEqual(['Tests pass.']);
	});

	it('speaks the text out of stream-json and never the tool payload around it', () => {
		const h = harness();
		h.data(
			[
				JSON.stringify({ type: 'text', text: 'Done.' }),
				JSON.stringify({ type: 'tool_use', name: 'Bash', input: { command: 'rm -rf /' } }),
				'',
			].join('\n')
		);
		h.complete();

		expect(h.spoken().join(' ')).not.toContain('rm -rf');
		expect(h.spoken().join(' ')).toContain('Done.');
	});

	it('cuts a completed thought loose mid-reply rather than waiting for the whole answer', () => {
		const h = harness({ minChunkChars: 20 });
		h.data('The first completed thought is here.\n\nStill writing the rest');

		// The paragraph before the blank line is spoken while the agent types on.
		expect(h.spoken()).toEqual(['The first completed thought is here.']);
		expect(h.chunks[0].kind).toBe('text');
	});

	it('speaks a short honest status when the agent errors instead of going silent', () => {
		const h = harness();
		h.data('Working on it.\n');
		h.fail('rate limited by the API');

		expect(h.spoken()).toEqual(['Working on it.', 'It hit an error: rate limited by the API']);
		expect(h.chunks[1].kind).toBe('status');
	});

	it('says something when the agent goes quiet, once', () => {
		const h = harness({ hangMs: 5_000 });
		h.data('Starting.\n');
		h.fireHang();
		h.fireHang();

		expect(h.spoken().filter((text) => text.includes('still working'))).toEqual([
			'It is still working on that one.',
		]);
	});

	it('reports an agent that exited without answering', () => {
		const h = harness();
		h.exit(1);

		expect(h.spoken()).toEqual(['It stopped without answering, exit code 1.']);
	});

	it('stays silent about output from a tab it is not following', () => {
		const h = harness();
		h.tap.unwatch({ agentSessionId: AGENT, tabId: TAB });
		h.data('Something nobody asked to hear.\n');
		h.complete();

		expect(h.spoken()).toEqual([]);
		expect(h.tap.isWatching).toBe(false);
	});

	it('drops every subscription on dispose', () => {
		const h = harness();
		h.tap.dispose();
		h.data('Too late.\n');
		h.complete();

		expect(h.spoken()).toEqual([]);
	});
});
