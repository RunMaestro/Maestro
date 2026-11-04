/**
 * Tests for shared/toastClickAction.ts
 *
 * The parser is the gate every externally-fired toast passes through (CLI, web
 * bridge), so a bad shape has to come back as an error rather than becoming a
 * toast whose click silently does nothing.
 */

import { describe, it, expect } from 'vitest';
import { parseToastClickAction, TOAST_CLICK_ACTION_KINDS } from '../../shared/toastClickAction';

describe('parseToastClickAction', () => {
	it('returns nothing for an absent action', () => {
		expect(parseToastClickAction(undefined)).toEqual({});
		expect(parseToastClickAction(null)).toEqual({});
	});

	it('rejects a non-object', () => {
		expect(parseToastClickAction('jump-session').error).toBe('clickAction must be an object');
	});

	it('rejects an unknown kind and lists the valid ones', () => {
		const { error } = parseToastClickAction({ kind: 'open-modal' });
		expect(error).toContain('Invalid clickAction kind: open-modal');
		for (const kind of TOAST_CLICK_ACTION_KINDS) {
			expect(error).toContain(kind);
		}
	});

	describe('jump-session', () => {
		it('accepts a sessionId with an optional tabId', () => {
			expect(parseToastClickAction({ kind: 'jump-session', sessionId: 's1' }).action).toEqual({
				kind: 'jump-session',
				sessionId: 's1',
				tabId: undefined,
			});
			expect(
				parseToastClickAction({ kind: 'jump-session', sessionId: 's1', tabId: 't1' }).action
			).toEqual({ kind: 'jump-session', sessionId: 's1', tabId: 't1' });
		});

		it('requires sessionId', () => {
			expect(parseToastClickAction({ kind: 'jump-session' }).error).toContain('requires sessionId');
			expect(parseToastClickAction({ kind: 'jump-session', sessionId: '' }).error).toContain(
				'requires sessionId'
			);
		});
	});

	describe('open-file', () => {
		it('accepts a sessionId and path', () => {
			expect(
				parseToastClickAction({ kind: 'open-file', sessionId: 's1', path: '/tmp/a.ts' }).action
			).toEqual({ kind: 'open-file', sessionId: 's1', path: '/tmp/a.ts' });
		});

		it('requires both sessionId and path', () => {
			expect(parseToastClickAction({ kind: 'open-file', path: '/tmp/a.ts' }).error).toContain(
				'requires sessionId'
			);
			expect(parseToastClickAction({ kind: 'open-file', sessionId: 's1' }).error).toContain(
				'requires path'
			);
		});
	});

	describe('open-terminal', () => {
		it('accepts a bare agent target (active terminal tab)', () => {
			expect(parseToastClickAction({ kind: 'open-terminal', sessionId: 's1' }).action).toEqual({
				kind: 'open-terminal',
				sessionId: 's1',
				tabRef: undefined,
			});
		});

		it('accepts a tab ref', () => {
			expect(
				parseToastClickAction({ kind: 'open-terminal', sessionId: 's1', tabRef: 'Dev server' })
					.action
			).toEqual({ kind: 'open-terminal', sessionId: 's1', tabRef: 'Dev server' });
		});

		it('requires sessionId', () => {
			expect(parseToastClickAction({ kind: 'open-terminal' }).error).toContain(
				'requires sessionId'
			);
		});
	});

	describe('open-browser', () => {
		it('accepts a url', () => {
			expect(
				parseToastClickAction({ kind: 'open-browser', sessionId: 's1', url: 'https://a.dev' })
					.action
			).toEqual({ kind: 'open-browser', sessionId: 's1', url: 'https://a.dev', tabId: undefined });
		});

		it('accepts a tabId', () => {
			expect(
				parseToastClickAction({ kind: 'open-browser', sessionId: 's1', tabId: 'b1' }).action
			).toEqual({ kind: 'open-browser', sessionId: 's1', tabId: 'b1', url: undefined });
		});

		it('requires sessionId, and one of tabId / url', () => {
			expect(parseToastClickAction({ kind: 'open-browser', url: 'https://a.dev' }).error).toContain(
				'requires sessionId'
			);
			expect(parseToastClickAction({ kind: 'open-browser', sessionId: 's1' }).error).toContain(
				'requires tabId or url'
			);
		});
	});

	describe('open-url', () => {
		it('accepts a url', () => {
			expect(parseToastClickAction({ kind: 'open-url', url: 'https://a.dev' }).action).toEqual({
				kind: 'open-url',
				url: 'https://a.dev',
			});
		});

		it('requires url', () => {
			expect(parseToastClickAction({ kind: 'open-url' }).error).toContain('requires url');
		});
	});
});
