import { describe, expect, test } from 'bun:test';
import {
	classifyVerb,
	isDispatchVerb,
	isLiveVerb,
	parseBridgeRequest,
	parseDiscovery,
	parseIssueRequest,
	parseNotify,
	parseResponse,
	parseSessionEnd,
	parseSessionEvent,
	parseSessionRegister,
} from '../protocol';

describe('verb classification', () => {
	test('classifies live, dispatch, unknown', () => {
		expect(classifyVerb('sessions.list')).toBe('live');
		expect(classifyVerb('agent.dispatch')).toBe('dispatch');
		expect(classifyVerb('bogus')).toBe('unknown');
		expect(isLiveVerb('notify.toast')).toBe(true);
		expect(isDispatchVerb('playbook.run')).toBe(true);
		expect(isDispatchVerb('sessions.list')).toBe(false);
	});
});

describe('request guards', () => {
	test('parseBridgeRequest accepts known verbs, rejects junk', () => {
		expect(parseBridgeRequest({ verb: 'sessions.list' })?.verb).toBe('sessions.list');
		expect(parseBridgeRequest({ verb: 'agent.dispatch' })?.verb).toBe('agent.dispatch');
		expect(parseBridgeRequest({ verb: 'nope' })).toBeUndefined();
		expect(parseBridgeRequest(null)).toBeUndefined();
	});

	test('parseSessionRegister requires the core fields + engine', () => {
		const valid = parseSessionRegister({
			runId: 'r',
			ompSessionId: 'o',
			cwd: '/c',
			engine: 'omp',
			startedAt: 1,
		});
		expect(valid?.engine).toBe('omp');
		expect(parseSessionRegister({ runId: 'r' })).toBeUndefined();
		expect(
			parseSessionRegister({ runId: 'r', ompSessionId: 'o', cwd: '/c', engine: 'x', startedAt: 1 })
		).toBeUndefined();
	});

	test('parseSessionEvent validates kind', () => {
		expect(
			parseSessionEvent({ runId: 'r', ompSessionId: 'o', kind: 'turn_start', at: 1 })?.kind
		).toBe('turn_start');
		expect(
			parseSessionEvent({ runId: 'r', ompSessionId: 'o', kind: 'weird', at: 1 })
		).toBeUndefined();
	});

	test('parseSessionEnd validates status + optional usage/cost', () => {
		const ended = parseSessionEnd({
			runId: 'r',
			ompSessionId: 'o',
			at: 1,
			status: 'completed',
			usage: { totalTokens: 9 },
			cost: 0.1,
		});
		expect(ended?.status).toBe('completed');
		expect(ended?.usage?.totalTokens).toBe(9);
		expect(ended?.cost).toBe(0.1);
		expect(
			parseSessionEnd({ runId: 'r', ompSessionId: 'o', at: 1, status: 'nope' })
		).toBeUndefined();
	});

	test('parseNotify requires title + message', () => {
		expect(parseNotify({ title: 't', message: 'm' })?.title).toBe('t');
		expect(parseNotify({ title: 't' })).toBeUndefined();
	});

	test('parseIssueRequest + parseDiscovery', () => {
		expect(parseIssueRequest({ secret: 's', runId: 'r', cwd: '/c' })?.runId).toBe('r');
		expect(parseIssueRequest({ secret: 's' })).toBeUndefined();
		expect(parseDiscovery({ url: 'http://x', secret: 's' })?.url).toBe('http://x');
		expect(parseDiscovery({ url: 'http://x' })).toBeUndefined();
	});
});

describe('parseResponse', () => {
	test('handles ok, err, unknown code, and malformed', () => {
		const okResp = parseResponse({ ok: true, result: 5 });
		expect(okResp.ok).toBe(true);

		const errResp = parseResponse({ ok: false, error: { code: 'unauthorized', message: 'no' } });
		expect(errResp.ok).toBe(false);
		if (!errResp.ok) expect(errResp.error.code).toBe('unauthorized');

		const unknownCode = parseResponse({ ok: false, error: { code: 'weird', message: 'x' } });
		expect(unknownCode.ok).toBe(false);
		if (!unknownCode.ok) expect(unknownCode.error.code).toBe('internal');

		const malformed = parseResponse('garbage');
		expect(malformed.ok).toBe(false);
	});
});
