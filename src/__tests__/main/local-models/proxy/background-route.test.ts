/**
 * @file background-route.test.ts
 *
 * The decision behind per-request routing, on request bodies shaped like the
 * ones Claude Code sends: a side request on the small model is routed, while
 * every sign of a turn, and a probe of the provider, keeps the request on the
 * provider. Then the rewrite: the model's name is the only thing that changes,
 * byte for byte.
 */

import { describe, it, expect } from 'vitest';
import {
	planBackgroundRoute,
	withRequestModel,
	type BackgroundRoutePlan,
} from '../../../../main/local-models/proxy/background-route';

const HAIKU = 'claude-haiku-4-5-20251001';

/** A title request: the small model, a system prompt, one user message, no tools. */
function sideRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		model: HAIKU,
		max_tokens: 512,
		system: [{ type: 'text', text: 'Write a 5 word title.', cache_control: { type: 'ephemeral' } }],
		messages: [{ role: 'user', content: [{ type: 'text', text: 'fix the login bug' }] }],
		stream: true,
		...overrides,
	};
}

function plan(body: Record<string, unknown>, toolType = 'claude-code'): BackgroundRoutePlan {
	return planBackgroundRoute(JSON.stringify(body), toolType);
}

function skipReason(body: Record<string, unknown>, toolType?: string): string {
	const result = plan(body, toolType);
	if (result.route) throw new Error('expected the request to stay on the provider');
	return result.reason;
}

describe('planBackgroundRoute: a background request', () => {
	it('routes a small-model request that shows no sign of a turn', () => {
		expect(plan(sideRequest())).toMatchObject({ route: true, model: HAIKU });
	});

	it('allows a cache breakpoint on the system prompt, as a string or as blocks', () => {
		expect(plan(sideRequest({ system: 'Write a title.' })).route).toBe(true);
		expect(plan(sideRequest()).route).toBe(true);
	});

	it('routes a plain string message, an assistant prefill, and an empty tools list', () => {
		expect(
			plan(
				sideRequest({
					messages: [
						{ role: 'user', content: 'is this a new topic?' },
						{ role: 'assistant', content: '{' },
					],
					tools: [],
				})
			).route
		).toBe(true);
	});

	it('reads the small model by family, whatever the dated id is', () => {
		for (const model of ['haiku', 'claude-3-5-haiku-20241022', 'claude-haiku-4-5']) {
			expect(plan(sideRequest({ model })).route, model).toBe(true);
		}
	});
});

describe('planBackgroundRoute: every sign of a turn keeps the request on the provider', () => {
	it('not the small model', () => {
		expect(skipReason(sideRequest({ model: 'claude-sonnet-4-5-20250929' }))).toBe(
			'not-small-model'
		);
		expect(skipReason(sideRequest({ model: 'claude-opus-4-8' }))).toBe('not-small-model');
	});

	it('a provider Maestro knows no small model for', () => {
		expect(skipReason(sideRequest(), 'opencode')).toBe('not-small-model');
		expect(skipReason(sideRequest(), '')).toBe('not-small-model');
	});

	it('a thinking block, signed or redacted', () => {
		for (const type of ['thinking', 'redacted_thinking']) {
			const body = sideRequest({
				messages: [
					{ role: 'user', content: 'hello' },
					{ role: 'assistant', content: [{ type, thinking: '...', signature: 'sig' }] },
					{ role: 'user', content: 'and now?' },
				],
			});
			expect(skipReason(body), type).toBe('thinking');
		}
	});

	it('a cache breakpoint on a message block', () => {
		const body = sideRequest({
			messages: [
				{
					role: 'user',
					content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }],
				},
			],
		});
		expect(skipReason(body)).toBe('cache-control');
	});

	it('a cache breakpoint nested inside a block, and one set to null does not count', () => {
		const nested = sideRequest({
			messages: [
				{
					role: 'user',
					content: [
						{
							type: 'document',
							source: { type: 'content', content: [{ type: 'text', text: 'x' }] },
							cache_control: { type: 'ephemeral', ttl: '1h' },
						},
					],
				},
			],
		});
		expect(skipReason(nested)).toBe('cache-control');

		const cleared = sideRequest({
			messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: null }] }],
		});
		expect(plan(cleared).route).toBe(true);
	});

	it('the request-level cache marker, which lands on the last message', () => {
		expect(skipReason(sideRequest({ cache_control: { type: 'ephemeral' } }))).toBe('cache-control');
	});

	it('a cache breakpoint on a tool definition', () => {
		const body = sideRequest({
			tools: [
				{
					name: 'Read',
					input_schema: { type: 'object' },
					cache_control: { type: 'ephemeral' },
				},
			],
		});
		expect(skipReason(body)).toBe('cache-control');
	});

	it('a tool result, including a server tool result and one nested in content', () => {
		const loop = sideRequest({
			messages: [
				{ role: 'user', content: 'list the files' },
				{ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'LS', input: {} }] },
				{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.ts' }] },
			],
		});
		expect(skipReason(loop)).toBe('tool-result');

		const serverTool = sideRequest({
			messages: [
				{ role: 'user', content: 'search' },
				{
					role: 'assistant',
					content: [{ type: 'web_search_tool_result', tool_use_id: 's1', content: [] }],
				},
				{ role: 'user', content: 'thanks' },
			],
		});
		expect(skipReason(serverTool)).toBe('tool-result');
	});

	it('declared tools: the first request of a loop that marks nothing for caching', () => {
		const body = sideRequest({
			system: 'You are an agent.',
			tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object' } }],
		});
		expect(skipReason(body)).toBe('tools');
	});

	it('a probe: a request for at most one token is a question about the provider', () => {
		// The TUI's quota probe, as Claude Code 2.1.296 sends it before a turn.
		const quota = { model: HAIKU, max_tokens: 1, messages: [{ role: 'user', content: 'quota' }] };
		expect(skipReason(quota)).toBe('probe');
		expect(skipReason(sideRequest({ max_tokens: 0 }))).toBe('probe');
		// Two tokens is work, and so is a request that states no limit or a
		// value that is not a number.
		expect(plan(sideRequest({ max_tokens: 2 })).route).toBe(true);
		for (const max_tokens of [undefined, null, '1', true]) {
			expect(plan(sideRequest({ max_tokens })).route, String(max_tokens)).toBe(true);
		}
		// A probe on another model is already not a small-model request.
		expect(skipReason({ ...quota, model: 'claude-opus-4-8' })).toBe('not-small-model');
	});

	it('reports the strongest sign when a request shows several', () => {
		const body = sideRequest({
			tools: [{ name: 'Read', input_schema: { type: 'object' } }],
			messages: [
				{ role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: 's' }] },
				{
					role: 'user',
					content: [
						{
							type: 'tool_result',
							tool_use_id: 't',
							content: 'out',
							cache_control: { type: 'ephemeral' },
						},
					],
				},
			],
		});
		expect(skipReason(body)).toBe('thinking');
	});

	it('a body that is not a Messages request', () => {
		expect(planBackgroundRoute('not json', 'claude-code')).toEqual({
			route: false,
			reason: 'unreadable',
		});
		expect(planBackgroundRoute('[]', 'claude-code')).toEqual({
			route: false,
			reason: 'unreadable',
		});
		expect(skipReason({ messages: [] })).toBe('unreadable');
		expect(skipReason({ model: 7, messages: [] })).toBe('unreadable');
		expect(skipReason({ model: HAIKU })).toBe('unreadable');
		expect(skipReason({ model: HAIKU, messages: 'hello' })).toBe('unreadable');
	});
});

describe('withRequestModel', () => {
	function routed(body: string): Extract<BackgroundRoutePlan, { route: true }> {
		const result = planBackgroundRoute(body, 'claude-code');
		if (!result.route) throw new Error(`not routed: ${result.reason}`);
		return result;
	}

	it('changes the model name and no other byte', () => {
		// Spacing, key order, an escaped string, a number past 2^53 and a
		// duplicate-looking nested `model` key: all of it must survive.
		const body =
			'{ "max_tokens":12345678901234567890 ,\n\t"model" : "claude-haiku-4-5-20251001",' +
			'"metadata":{"user_id":"u\\u00e9\\n","model":"claude-haiku-4-5-20251001"},' +
			'"messages":[{"role":"user","content":"say \\"hi\\" / \\u2028"}],"10":1,"2":2}';

		const out = withRequestModel(body, routed(body), 'qwen3.5-4b');

		expect(out).toBe(
			body.replace('"model" : "claude-haiku-4-5-20251001"', '"model" : "qwen3.5-4b"')
		);
		// The nested key is somebody else's field.
		expect(out).toContain(
			'"metadata":{"user_id":"u\\u00e9\\n","model":"claude-haiku-4-5-20251001"}'
		);
	});

	it('writes the target model as a JSON string, whatever its name holds', () => {
		const body = JSON.stringify(sideRequest());

		const out = withRequestModel(body, routed(body), 'hf.co/org/model:Q4_K_M "quoted"');

		expect(JSON.parse(out).model).toBe('hf.co/org/model:Q4_K_M "quoted"');
		expect({ ...JSON.parse(out), model: HAIKU }).toEqual(JSON.parse(body));
	});

	it('leaves no copy of the provider model at the top level when the key repeats', () => {
		const body = `{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"hi"}],"model":"${HAIKU}"}`;

		const out = withRequestModel(body, routed(body), 'local');

		expect(out).toBe(
			'{"model":"local","messages":[{"role":"user","content":"hi"}],"model":"local"}'
		);
	});
});
