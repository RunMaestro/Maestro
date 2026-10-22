import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
	CodexAppServerEventTranslator,
	type CodexExecLine,
	type CodexAppServerUserMessage,
	type CodexTranslatedRequestMethod,
} from '../../../main/codex-app-server/event-translator';
import type { CodexAppServerMessage } from '../../../main/codex-app-server/protocol';
import {
	CodexOutputParser,
	CODEX_CALL_USAGE_LINE_TYPE,
} from '../../../main/parsers/codex-output-parser';

const FIXTURES = join(__dirname, '..', '..', 'fixtures', 'codex-app-server');

interface FixtureLine {
	dir: 'send' | 'recv';
	msg: CodexAppServerMessage;
}

function loadFixture(name: string): FixtureLine[] {
	return readFileSync(join(FIXTURES, `${name}.jsonl`), 'utf8')
		.split('\n')
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as FixtureLine);
}

const TRANSLATED_RESPONSES = new Set<string>(['thread/start', 'thread/resume', 'turn/start']);

/**
 * Replay a fixture the way the spawner will: notifications go to `translate()`,
 * successful responses to the requests whose result the translator needs go to
 * `translateResponse()`, and server requests are left for the spawner to answer.
 * `lines` are the `codex exec` lines; Maestro's own live usage lines are kept
 * apart in `callUsage`, so a sequence assertion reads as the exec stream.
 */
function replay(name: string, edit: (fixture: FixtureLine[]) => FixtureLine[] = (f) => f) {
	const translator = new CodexAppServerEventTranslator();
	const userMessages: CodexAppServerUserMessage[] = [];
	translator.onUserMessage((message) => userMessages.push(message));
	const methodsById = new Map<number | string, string>();
	const all: CodexExecLine[] = [];
	const fixture = edit(loadFixture(name));

	for (const { dir, msg } of fixture) {
		if (dir === 'send') {
			if (msg.method && msg.id !== undefined) methodsById.set(msg.id, msg.method);
			continue;
		}
		if (msg.method && msg.id === undefined) {
			all.push(...translator.translate({ ...msg, method: msg.method, id: undefined }));
		} else if (msg.id !== undefined && !msg.method && msg.result !== undefined) {
			const method = methodsById.get(msg.id);
			if (method && TRANSLATED_RESPONSES.has(method)) {
				all.push(
					...translator.translateResponse(method as CodexTranslatedRequestMethod, msg.result)
				);
			}
		}
	}
	const lines = all.filter((line) => line.type !== CODEX_CALL_USAGE_LINE_TYPE);
	const callUsage = all.filter((line) => line.type === CODEX_CALL_USAGE_LINE_TYPE);
	return { translator, lines, callUsage, userMessages, fixture };
}

/** Field-by-field sum of the `usage` objects on a set of lines. */
function sumUsage(lines: CodexExecLine[]): Record<string, number> {
	const sum: Record<string, number> = {};
	for (const line of lines) {
		for (const [field, value] of Object.entries(line.usage as Record<string, number>)) {
			sum[field] = (sum[field] ?? 0) + value;
		}
	}
	return sum;
}

/** The turn id the fixture's `turn/started` names. */
function activeTurnOf(fixture: FixtureLine[]): string | undefined {
	const started = fixture.find(({ dir, msg }) => dir === 'recv' && msg.method === 'turn/started');
	return (started?.msg.params as { turn?: { id?: string } } | undefined)?.turn?.id;
}

const FIXTURE_NAMES = [
	'plain-turn',
	'tool-turn',
	'steered-turn',
	'late-steer',
	'resumed-turn',
	'interrupted-turn',
	'read-only-turn',
	'approval-request',
];

/** `type` plus the item's type and status, the shape a fixture's sequence is asserted on. */
function signature(line: CodexExecLine): string {
	const item = line.item as { type?: string; status?: string } | undefined;
	if (!item) return line.type;
	return [line.type, item.type, item.status].filter(Boolean).join(':');
}

/** Every `item/completed` item of the given type in a fixture, in order. */
function fixtureItems(fixture: FixtureLine[], type: string): Array<Record<string, unknown>> {
	return fixture
		.filter(({ dir, msg }) => dir === 'recv' && msg.method === 'item/completed')
		.map(({ msg }) => (msg.params as { item: Record<string, unknown> }).item)
		.filter((item) => item.type === type);
}

/** The thread total on the last `thread/tokenUsage/updated` of a fixture. */
function lastTotal(fixture: FixtureLine[], index = -1): Record<string, number> {
	const updates = fixture.filter(
		({ dir, msg }) => dir === 'recv' && msg.method === 'thread/tokenUsage/updated'
	);
	const update = updates.at(index)!.msg.params as {
		tokenUsage: { total: Record<string, number> };
	};
	return update.tokenUsage.total;
}

describe('CodexAppServerEventTranslator', () => {
	describe('fixture replay', () => {
		it('plain-turn: thread, turn, one agent message, per-turn usage', () => {
			const { translator, lines, userMessages, fixture } = replay('plain-turn');
			const total = lastTotal(fixture);

			expect(lines).toEqual([
				{ type: 'thread.started', thread_id: '01a129a3-ae2d-7a03-a717-b7374d497e31' },
				{ type: 'turn.started' },
				{
					type: 'item.completed',
					item: {
						id: 'msg_074baebd0cfcfca0016acb2bf66d488194ad0bf29a3a33addb',
						type: 'agent_message',
						text: 'OK',
						phase: 'final_answer',
					},
				},
				{
					type: 'turn.completed',
					usage: {
						input_tokens: total.inputTokens,
						cached_input_tokens: total.cachedInputTokens,
						output_tokens: total.outputTokens,
						reasoning_output_tokens: total.reasoningOutputTokens,
					},
				},
			]);
			expect(translator.outcome).toBe('completed');
			expect(translator.threadId).toBe('01a129a3-ae2d-7a03-a717-b7374d497e31');
			expect(translator.activeTurnId).toBeNull();
			expect(userMessages).toEqual([
				{
					turnId: '01a129a3-aefe-7cd2-9c08-1dd7ca193ad1',
					itemId: '01a129a3-b307-78c1-84b3-ebac9091199f',
					text: 'Reply with the word OK',
				},
			]);
		});

		it('tool-turn: every command start and completion, keyed by item id', () => {
			const { lines, fixture } = replay('tool-turn');

			expect(lines.map(signature)).toEqual([
				'thread.started',
				'turn.started',
				'item.completed:agent_message',
				'item.started:command_execution:in_progress',
				'item.completed:command_execution:completed',
				'item.started:command_execution:in_progress',
				'item.completed:command_execution:completed',
				'item.started:command_execution:in_progress',
				'item.completed:command_execution:completed',
				'item.completed:agent_message',
				'turn.completed',
			]);

			const commands = fixtureItems(fixture, 'commandExecution');
			const completed = lines.filter(
				(line) =>
					line.type === 'item.completed' &&
					(line.item as { type: string }).type === 'command_execution'
			);
			expect(completed.map((line) => line.item)).toEqual(
				commands.map((command) => ({
					id: command.id,
					type: 'command_execution',
					command: command.command,
					aggregated_output: command.aggregatedOutput,
					exit_code: command.exitCode,
					status: 'completed',
				}))
			);
			const started = lines.filter((line) => line.type === 'item.started');
			expect(started.map((line) => (line.item as { id: string }).id)).toEqual(
				commands.map((command) => command.id)
			);
		});

		it('steered-turn: reports the steer as a user message of the running turn', () => {
			const { lines, userMessages } = replay('steered-turn');

			expect(lines.map(signature)).toEqual([
				'thread.started',
				'turn.started',
				'item.completed:agent_message',
				'item.started:command_execution:in_progress',
				'item.completed:command_execution:completed',
				'item.started:command_execution:in_progress',
				'item.completed:command_execution:completed',
				'item.completed:agent_message',
				'turn.completed',
			]);
			expect(userMessages).toHaveLength(2);
			expect(userMessages[1]).toEqual({
				turnId: '01a129a3-f358-7f71-9b55-f179dae9133a',
				itemId: '01a129a4-166b-7e02-8455-0b48f7c203c8',
				text: 'Stop now. Do not run any more commands. Reply with the single word PINEAPPLE.',
			});
			expect(userMessages[0].turnId).toBe(userMessages[1].turnId);
			const last = lines.filter((line) => line.type === 'item.completed').at(-1)!;
			expect((last.item as { text: string }).text).toBe('PINEAPPLE');
		});

		it('late-steer: the turn ends normally and the late steer adds nothing', () => {
			const { translator, lines } = replay('late-steer');
			expect(lines.map(signature)).toEqual([
				'thread.started',
				'turn.started',
				'item.completed:agent_message',
				'turn.completed',
			]);
			expect(translator.outcome).toBe('completed');
			expect(translator.activeTurnId).toBeNull();
		});

		it('resumed-turn: emits thread.started from the resume response and subtracts the prior total', () => {
			const { translator, lines, fixture } = replay('resumed-turn');
			const baseline = lastTotal(fixture, 0);
			const total = lastTotal(fixture);

			expect(lines.map(signature)).toEqual([
				'thread.started',
				'turn.started',
				'item.completed:agent_message',
				'turn.completed',
			]);
			expect(lines[0]).toEqual({
				type: 'thread.started',
				thread_id: '01a129a3-ae2d-7a03-a717-b7374d497e31',
			});
			// The thread total is NEVER forwarded: the first update carries the
			// previous turn's tokens and must be subtracted out.
			expect(lines.at(-1)).toEqual({
				type: 'turn.completed',
				usage: {
					input_tokens: total.inputTokens - baseline.inputTokens,
					cached_input_tokens: total.cachedInputTokens - baseline.cachedInputTokens,
					output_tokens: total.outputTokens - baseline.outputTokens,
					reasoning_output_tokens: total.reasoningOutputTokens - baseline.reasoningOutputTokens,
				},
			});
			expect((lines.at(-1)!.usage as { input_tokens: number }).input_tokens).toBeLessThan(
				total.inputTokens
			);
			expect(translator.threadId).toBe('01a129a3-ae2d-7a03-a717-b7374d497e31');
		});

		it('interrupted-turn: still reports usage and records the interrupted outcome', () => {
			const { translator, lines, fixture } = replay('interrupted-turn');
			const total = lastTotal(fixture);

			expect(lines.map(signature)).toEqual([
				'thread.started',
				'turn.started',
				'item.completed:agent_message',
				'item.started:command_execution:in_progress',
				'item.completed:command_execution:completed',
				'turn.completed',
			]);
			expect((lines.at(-1)!.usage as { input_tokens: number }).input_tokens).toBe(
				total.inputTokens
			);
			expect(translator.outcome).toBe('interrupted');
		});

		it('read-only-turn: a sandbox denial leaves no tool card, only the messages', () => {
			const { lines } = replay('read-only-turn');
			expect(lines.map(signature)).toEqual([
				'thread.started',
				'turn.started',
				'item.completed:agent_message',
				'item.completed:agent_message',
				'turn.completed',
			]);
		});

		it('approval-request: a declined command completes as failed, empty reasoning is skipped', () => {
			const { lines } = replay('approval-request');
			expect(lines.map(signature)).toEqual([
				'thread.started',
				'turn.started',
				'item.completed:agent_message',
				'item.started:command_execution:in_progress',
				'item.completed:command_execution:failed',
				'item.completed:agent_message',
				'turn.completed',
			]);
			const declined = lines.find(
				(line) => line.type === 'item.completed' && (line.item as { status?: string }).status
			)!;
			expect(declined.item).toEqual({
				id: 'exec-878f33c1-8198-4b9f-b28b-f84496f275ea',
				type: 'command_execution',
				command: `/bin/zsh -lc "printf 'hello\\\\n' > out.txt"`,
				exit_code: null,
				status: 'failed',
			});
		});
	});

	describe('live call usage (maestro.call_usage)', () => {
		it.each(FIXTURE_NAMES)(
			'%s: one line per update of the active turn, summing to the turn usage',
			(name) => {
				const { lines, callUsage, fixture } = replay(name);
				const turnId = activeTurnOf(fixture);
				const turnUpdates = fixture.filter(
					({ dir, msg }) =>
						dir === 'recv' &&
						msg.method === 'thread/tokenUsage/updated' &&
						(msg.params as { turnId?: string }).turnId === turnId
				);
				expect(callUsage).toHaveLength(turnUpdates.length);
				expect(sumUsage(callUsage)).toEqual(lines.at(-1)!.usage);
			}
		);

		it('reports the growth since the previous update, not the thread total', () => {
			const translator = new CodexAppServerEventTranslator();
			translator.translateResponse('thread/start', { thread: { id: 'thread-1' } });
			translator.translate({ method: 'turn/started', params: { turn: { id: 'turn-1' } } });
			const update = (total: Record<string, number>, last?: Record<string, number>) =>
				translator.translate({
					method: 'thread/tokenUsage/updated',
					params: {
						threadId: 'thread-1',
						turnId: 'turn-1',
						tokenUsage: { total, ...(last ? { last } : {}) },
					},
				});
			expect(
				update(
					{ inputTokens: 1100, outputTokens: 40, reasoningOutputTokens: 10 },
					{ inputTokens: 100, outputTokens: 40, reasoningOutputTokens: 10 }
				)
			).toEqual([
				{
					type: CODEX_CALL_USAGE_LINE_TYPE,
					usage: {
						input_tokens: 100,
						cached_input_tokens: 0,
						output_tokens: 40,
						reasoning_output_tokens: 10,
					},
				},
			]);
			expect(update({ inputTokens: 1300, cachedInputTokens: 150, outputTokens: 90 })).toEqual([
				{
					type: CODEX_CALL_USAGE_LINE_TYPE,
					usage: {
						input_tokens: 200,
						cached_input_tokens: 150,
						output_tokens: 50,
						reasoning_output_tokens: 0,
					},
				},
			]);
			// A repeat of the same total spent nothing new.
			expect(update({ inputTokens: 1300, cachedInputTokens: 150, outputTokens: 90 })).toEqual([]);
		});

		it('sends nothing for an update outside the active turn', () => {
			const translator = new CodexAppServerEventTranslator();
			translator.translateResponse('thread/start', { thread: { id: 'thread-1' } });
			const update = (turnId: string, total: number, last: number) =>
				translator.translate({
					method: 'thread/tokenUsage/updated',
					params: {
						threadId: 'thread-1',
						turnId,
						tokenUsage: { total: { inputTokens: total }, last: { inputTokens: last } },
					},
				});
			// The previous turn's total, replayed on resume, and an update ahead of the turn id.
			expect(update('turn-0', 100, 100)).toEqual([]);
			expect(update('turn-1', 120, 20)).toEqual([]);
			translator.translateResponse('turn/start', { turn: { id: 'turn-1' } });
			expect(update('turn-1', 150, 30)).toEqual([
				expect.objectContaining({ usage: expect.objectContaining({ input_tokens: 30 }) }),
			]);
		});

		it('sends nothing for a first update that carries no `last`', () => {
			const translator = new CodexAppServerEventTranslator();
			translator.translateResponse('thread/start', { thread: { id: 'thread-1' } });
			translator.translate({ method: 'turn/started', params: { turn: { id: 'turn-1' } } });
			const update = (inputTokens: number) =>
				translator.translate({
					method: 'thread/tokenUsage/updated',
					params: {
						threadId: 'thread-1',
						turnId: 'turn-1',
						tokenUsage: { total: { inputTokens } },
					},
				});
			expect(update(130)).toEqual([]);
			expect(update(175)).toEqual([
				expect.objectContaining({ usage: expect.objectContaining({ input_tokens: 45 }) }),
			]);
		});

		it('parses into callUsage, output counted with reasoning as the turn usage counts it', () => {
			const event = new CodexOutputParser().parseJsonLine(
				JSON.stringify({
					type: CODEX_CALL_USAGE_LINE_TYPE,
					usage: {
						input_tokens: 200,
						cached_input_tokens: 150,
						output_tokens: 50,
						reasoning_output_tokens: 7,
					},
				})
			);
			expect(event).toMatchObject({
				type: 'system',
				callUsage: {
					inputTokens: 200,
					outputTokens: 57,
					cacheReadInputTokens: 150,
					cacheCreationInputTokens: 0,
				},
			});
			expect(event?.usage).toBeUndefined();
		});
	});

	describe('end to end through CodexOutputParser', () => {
		it('tool-turn translates into the same final result text the agent message carries', () => {
			const { lines, fixture } = replay('tool-turn');
			const finalAnswer = fixtureItems(fixture, 'agentMessage').find(
				(item) => item.phase === 'final_answer'
			)!;

			const parser = new CodexOutputParser();
			const events = lines.map((line) => parser.parseJsonLine(JSON.stringify(line)));
			const results = events.filter((event) => event && parser.isResultMessage(event));

			expect(results.at(-1)?.text).toBe(finalAnswer.text);
			expect(results.at(-1)?.responsePhase).toBe('final');
			expect(results).toHaveLength(1);
			expect(events.some((event) => event?.responsePhase === 'commentary')).toBe(true);
			expect(events[0]).toMatchObject({
				type: 'init',
				sessionId: '01a129a3-bb7d-7971-9636-b3013de8faa0',
			});
			const usage = events.at(-1)?.usage;
			expect(usage?.inputTokens).toBe(lastTotal(fixture).inputTokens);
			const tools = events.filter((event) => event?.type === 'tool_use');
			expect(tools).toHaveLength(6);
			expect(tools.at(-1)).toMatchObject({ toolName: 'shell', toolState: { status: 'completed' } });
		});
	});

	describe('synthetic notifications', () => {
		const started = (translator: CodexAppServerEventTranslator, turnId = 'turn-1') => {
			translator.translateResponse('thread/start', { thread: { id: 'thread-1' } });
			translator.translate({ method: 'turn/started', params: { turn: { id: turnId } } });
		};

		it('returns nothing for unknown and noise notifications', () => {
			const translator = new CodexAppServerEventTranslator();
			for (const method of [
				'remoteControl/status/changed',
				'account/rateLimits/updated',
				'mcpServer/startupStatus/updated',
				'warning',
				'item/agentMessage/delta',
				'something/new',
			]) {
				expect(translator.translate({ method, params: {} })).toEqual([]);
			}
		});

		it('emits thread.started once even when the notification follows the response', () => {
			const translator = new CodexAppServerEventTranslator();
			expect(translator.translateResponse('thread/start', { thread: { id: 't' } })).toHaveLength(1);
			expect(
				translator.translate({ method: 'thread/started', params: { thread: { id: 't' } } })
			).toEqual([]);
		});

		it('records the turn id from the turn/start response before turn/started arrives', () => {
			const translator = new CodexAppServerEventTranslator();
			translator.translateResponse('turn/start', { turn: { id: 'turn-early' } });
			expect(translator.activeTurnId).toBe('turn-early');
		});

		it('maps a failed turn to turn.failed with the turn error message', () => {
			const translator = new CodexAppServerEventTranslator();
			started(translator);
			expect(
				translator.translate({
					method: 'turn/completed',
					params: {
						turn: { id: 'turn-1', status: 'failed', error: { message: 'model not found' } },
					},
				})
			).toEqual([{ type: 'turn.failed', error: { message: 'model not found' } }]);
			expect(translator.outcome).toBe('failed');
		});

		it('turns a retrying error into a Reconnecting notice the parser treats as progress', () => {
			const translator = new CodexAppServerEventTranslator();
			const [retry] = translator.translate({
				method: 'error',
				params: { error: { message: 'stream disconnected' }, willRetry: true },
			});
			expect(retry).toEqual({ type: 'error', message: 'Reconnecting... stream disconnected' });
			const parsed = new CodexOutputParser().parseJsonLine(JSON.stringify(retry));
			expect(parsed?.type).not.toBe('error');

			const [fatal] = translator.translate({
				method: 'error',
				params: { error: { message: 'quota exceeded' }, willRetry: false },
			});
			expect(fatal).toEqual({ type: 'error', message: 'quota exceeded' });
		});

		it('only reports user messages that complete inside the active turn', () => {
			const translator = new CodexAppServerEventTranslator();
			const seen: CodexAppServerUserMessage[] = [];
			translator.onUserMessage((message) => seen.push(message));
			const userMessage = (turnId: string, text: string) =>
				translator.translate({
					method: 'item/completed',
					params: {
						turnId,
						item: { type: 'userMessage', id: `u-${text}`, content: [{ type: 'text', text }] },
					},
				});

			userMessage('turn-1', 'before');
			started(translator);
			userMessage('turn-other', 'other');
			userMessage('turn-1', 'during');
			translator.translate({
				method: 'turn/completed',
				params: { turn: { id: 'turn-1', status: 'completed' } },
			});
			userMessage('turn-1', 'after');

			expect(seen).toEqual([{ turnId: 'turn-1', itemId: 'u-during', text: 'during' }]);
		});

		it('joins reasoning summaries and falls back to content', () => {
			const translator = new CodexAppServerEventTranslator();
			const reasoning = (summary: string[], content: string[]) =>
				translator.translate({
					method: 'item/completed',
					params: { item: { type: 'reasoning', id: 'r', summary, content } },
				});
			expect(reasoning(['a', 'b'], ['raw'])).toEqual([
				{ type: 'item.completed', item: { id: 'r', type: 'reasoning', text: 'a\n\nb' } },
			]);
			expect(reasoning([], ['raw'])).toEqual([
				{ type: 'item.completed', item: { id: 'r', type: 'reasoning', text: 'raw' } },
			]);
			expect(reasoning([], [])).toEqual([]);
		});

		it('ignores every notification that names another thread (a sub-agent on the same connection)', () => {
			const translator = new CodexAppServerEventTranslator();
			const seen: CodexAppServerUserMessage[] = [];
			translator.onUserMessage((message) => seen.push(message));
			started(translator);
			const child = 'thread-child';
			const childTurn = 'turn-child';

			// The sub-agent's own thread and turn, then its whole life.
			expect(
				translator.translate({
					method: 'thread/started',
					params: { thread: { id: child, parentThreadId: 'thread-1', agentRole: 'worker' } },
				})
			).toEqual([]);
			expect(translator.threadId).toBe('thread-1');
			translator.translate({
				method: 'turn/started',
				params: { threadId: child, turn: { id: childTurn } },
			});
			expect(translator.activeTurnId).toBe('turn-1');
			const foreign = [
				{
					method: 'item/started',
					params: {
						threadId: child,
						turnId: childTurn,
						item: { type: 'commandExecution', id: 'c', command: 'ls' },
					},
				},
				{
					method: 'item/completed',
					params: {
						threadId: child,
						turnId: 'turn-1',
						item: { type: 'agentMessage', id: 'm', text: 'child says hi' },
					},
				},
				{
					method: 'item/completed',
					params: {
						threadId: child,
						turnId: 'turn-1',
						item: { type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'x' }] },
					},
				},
				{
					method: 'thread/tokenUsage/updated',
					params: {
						threadId: child,
						turnId: 'turn-1',
						tokenUsage: { total: { inputTokens: 999 }, last: { inputTokens: 999 } },
					},
				},
				{ method: 'error', params: { threadId: child, error: { message: 'child failed' } } },
				{
					method: 'turn/completed',
					params: { threadId: child, turn: { id: childTurn, status: 'failed' } },
				},
			];
			for (const notification of foreign) expect(translator.translate(notification)).toEqual([]);
			expect(seen).toEqual([]);
			expect(translator.outcome).toBeNull();
			expect(translator.activeTurnId).toBe('turn-1');

			// Our own thread still drives the turn, and its usage is untouched.
			translator.translate({
				method: 'thread/tokenUsage/updated',
				params: {
					threadId: 'thread-1',
					turnId: 'turn-1',
					tokenUsage: { total: { inputTokens: 10 }, last: { inputTokens: 10 } },
				},
			});
			expect(
				translator.translate({
					method: 'turn/completed',
					params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
				})
			).toEqual([
				{
					type: 'turn.completed',
					usage: {
						input_tokens: 10,
						cached_input_tokens: 0,
						output_tokens: 0,
						reasoning_output_tokens: 0,
					},
				},
			]);
		});

		it('resumed-turn: per-turn usage does not depend on the replayed total', () => {
			// Drop the update the server replays for the PREVIOUS turn on resume:
			// the baseline comes from this turn's own first update (total - last).
			const withReplay = replay('resumed-turn');
			const withoutReplay = replay('resumed-turn', (fixture) => {
				const replayed = fixture.findIndex(({ msg }) => msg.method === 'thread/tokenUsage/updated');
				return fixture.filter((_, index) => index !== replayed);
			});
			const usage = withoutReplay.lines.at(-1)!.usage as Record<string, number>;
			expect(usage).toEqual(withReplay.lines.at(-1)!.usage);
			// 61746-token thread, 32895 of them this turn (the fixture's `last`).
			expect(usage.input_tokens).toBe(32890);
			expect(usage.output_tokens).toBe(5);
		});

		it('falls back to the replayed total when an update carries no `last`', () => {
			const translator = new CodexAppServerEventTranslator();
			const usage = (turnId: string, inputTokens: number) =>
				translator.translate({
					method: 'thread/tokenUsage/updated',
					params: { threadId: 'thread-1', turnId, tokenUsage: { total: { inputTokens } } },
				});
			usage('turn-0', 100);
			started(translator);
			usage('turn-1', 130);
			usage('turn-1', 175);
			const [completed] = translator.translate({
				method: 'turn/completed',
				params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
			});
			expect((completed.usage as { input_tokens: number }).input_tokens).toBe(75);
		});

		it('counts a usage update that lands before the turn id is known', () => {
			const translator = new CodexAppServerEventTranslator();
			translator.translateResponse('thread/start', { thread: { id: 'thread-1' } });
			const usage = (total: number, last: number) =>
				translator.translate({
					method: 'thread/tokenUsage/updated',
					params: {
						threadId: 'thread-1',
						turnId: 'turn-1',
						tokenUsage: { total: { inputTokens: total }, last: { inputTokens: last } },
					},
				});
			usage(120, 20);
			translator.translateResponse('turn/start', { turn: { id: 'turn-1' } });
			usage(150, 30);
			const [completed] = translator.translate({
				method: 'turn/completed',
				params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
			});
			expect((completed.usage as { input_tokens: number }).input_tokens).toBe(50);
		});

		it('omits usage when the turn never reported any', () => {
			const translator = new CodexAppServerEventTranslator();
			started(translator);
			expect(
				translator.translate({
					method: 'turn/completed',
					params: { turn: { id: 'turn-1', status: 'completed' } },
				})
			).toEqual([{ type: 'turn.completed' }]);
		});
	});
});
