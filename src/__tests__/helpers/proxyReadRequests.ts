/**
 * Request bodies and read events for the token proxy's read analyzer and the
 * previews built on it (`read-opportunities.test.ts`, `read-previews.test.ts`).
 *
 * A body is built in the shape of each of the three provider APIs from one list
 * of steps, so a case is written once and runs against all of them.
 */

import type { ReadEvent } from '../../main/local-models/proxy/read-opportunities';
import type { TokenProxyRequestKind } from '../../shared/local-models/token-proxy';

export type ApiKind = Exclude<TokenProxyRequestKind, 'other'>;

export const ROOT = '/work/app';
export const FILE = `${ROOT}/src/a.ts`;
export const LINES = ['export const a = 1;', 'export const b = 2;', 'export const c = 3;'];
export const EDITED = ['export const a = 1;', 'export const b = 22;', 'export const c = 3;'];

/** What Claude Code's Read prints: right-aligned number, an arrow, the line. */
export function numbered(lines: readonly string[], from = 1, separator = '→'): string {
	return lines
		.map((line, index) => `${String(from + index).padStart(6)}${separator}${line}`)
		.join('\n');
}

/** One tool call and its result. `output` is whatever the result carries. */
export interface Step {
	id?: string;
	tool?: string;
	/** An object, or a raw string for arguments that are not JSON. */
	input: Record<string, unknown> | string;
	output: unknown;
	isError?: boolean;
}

/**
 * A step, several steps the model called in one turn (their results arrive
 * together), or the marker a provider writes where it replaced the history
 * before it.
 */
export type Item = Step | Step[] | 'compaction';

export function read(
	output: string,
	input: Record<string, unknown> = { file_path: FILE },
	tool = 'Read'
) {
	return { tool, input, output } satisfies Step;
}

export function body(kind: ApiKind, items: Item[], extra: Record<string, unknown> = {}): string {
	/** The steps of one turn with the id each answers under. */
	const turn = (item: Step | Step[], index: number, prefix: string) => {
		const steps = Array.isArray(item) ? item : [item];
		return steps.map((step, at) => ({
			step,
			id: step.id ?? (Array.isArray(item) ? `${prefix}_${index}_${at}` : `${prefix}_${index}`),
		}));
	};
	const args = (input: Step['input']) =>
		typeof input === 'string' ? input : JSON.stringify(input);
	if (kind === 'anthropic-messages') {
		const messages: unknown[] = [{ role: 'user', content: 'Look at the file.' }];
		items.forEach((item, index) => {
			if (item === 'compaction') {
				messages.push({ role: 'assistant', content: [{ type: 'compaction', content: 'summary' }] });
				return;
			}
			const calls = turn(item, index, 'toolu');
			messages.push({
				role: 'assistant',
				content: calls.map(({ step, id }) => ({
					type: 'tool_use',
					id,
					name: step.tool,
					input: step.input,
				})),
			});
			messages.push({
				role: 'user',
				content: calls.map(({ step, id }) => ({
					type: 'tool_result',
					tool_use_id: id,
					content: step.output,
					...(step.isError ? { is_error: true } : {}),
				})),
			});
		});
		return JSON.stringify({ model: 'claude-test', max_tokens: 64, messages, ...extra });
	}
	if (kind === 'openai-chat-completions') {
		const messages: unknown[] = [{ role: 'user', content: 'Look at the file.' }];
		items.forEach((item, index) => {
			if (item === 'compaction') return;
			const calls = turn(item, index, 'call');
			messages.push({
				role: 'assistant',
				tool_calls: calls.map(({ step, id }) => ({
					id,
					type: 'function',
					function: { name: step.tool, arguments: args(step.input) },
				})),
			});
			for (const { step, id } of calls) {
				messages.push({ role: 'tool', tool_call_id: id, content: step.output });
			}
		});
		return JSON.stringify({ model: 'gpt-test', messages, ...extra });
	}
	const input: unknown[] = [{ role: 'user', content: 'Look at the file.' }];
	items.forEach((item, index) => {
		if (item === 'compaction') {
			input.push({ type: 'compaction', id: 'cmp_1', encrypted_content: 'opaque' });
			return;
		}
		const calls = turn(item, index, 'call');
		for (const { step, id } of calls) {
			input.push({
				type: 'function_call',
				call_id: id,
				name: step.tool,
				arguments: args(step.input),
			});
		}
		for (const { step, id } of calls) {
			input.push({ type: 'function_call_output', call_id: id, output: step.output });
		}
	});
	return JSON.stringify({ model: 'gpt-test', input, ...extra });
}

/** A directly supplied event, for the cases the descriptor path cannot produce. */
export function event(
	order: number,
	over: Partial<Extract<ReadEvent, { status: 'read' }>> = {}
): ReadEvent {
	return {
		status: 'read',
		order,
		context: 'main',
		epoch: 0,
		callId: `c${order}`,
		tool: 'Read',
		path: FILE,
		offset: null,
		limit: null,
		text: numbered(LINES),
		...over,
	};
}

export function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
	if (typeof value === 'object' && value !== null && !seen.has(value)) {
		seen.add(value);
		Object.values(value).forEach((child) => deepFreeze(child, seen));
		Object.freeze(value);
	}
	return value;
}
