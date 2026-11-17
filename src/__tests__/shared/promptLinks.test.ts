/**
 * Tests for src/shared/promptLinks.ts - the pure Prompt Link rules every
 * process shares.
 */

import { describe, it, expect } from 'vitest';
import {
	PROMPT_LINK_MAX_PROMPT_CHARS,
	PROMPT_LINK_MAX_USES,
	describePromptLinkRefusal,
	describePromptLinkUses,
	parsePromptLinkCommandRequest,
	parsePromptLinkExpiry,
	parsePromptLinkUses,
	promptLinkStatus,
	promptLinkUsesLeft,
	resolvePromptLinkId,
	validatePromptLinkInput,
	type PromptLinkPublic,
	type PromptLinkRefusal,
} from '../../shared/promptLinks';

const NOW = 1_800_000_000_000;

function link(overrides: Partial<PromptLinkPublic> = {}): PromptLinkPublic {
	return {
		id: 'aaaa1111-0000-0000-0000-000000000000',
		agentId: 'agent-1',
		prompt: 'Prep me for the 9am',
		createdAt: NOW - 1000,
		maxUses: 1,
		useCount: 0,
		open: 'background',
		...overrides,
	};
}

describe('promptLinkStatus', () => {
	it('is active while it has uses left and has not expired', () => {
		expect(promptLinkStatus(link(), NOW)).toBe('active');
	});

	it('is spent once a one-shot link has run', () => {
		expect(promptLinkStatus(link({ useCount: 1 }), NOW)).toBe('spent');
	});

	it('never spends an unlimited link', () => {
		expect(promptLinkStatus(link({ maxUses: null, useCount: 500 }), NOW)).toBe('active');
	});

	it('is expired at and after its expiry', () => {
		expect(promptLinkStatus(link({ expiresAt: NOW }), NOW)).toBe('expired');
		expect(promptLinkStatus(link({ expiresAt: NOW + 1 }), NOW)).toBe('active');
	});

	it('reports revoked over expired and spent', () => {
		expect(
			promptLinkStatus(link({ revokedAt: NOW - 5, expiresAt: NOW - 1, useCount: 1 }), NOW)
		).toBe('revoked');
	});

	it('reports expired over spent', () => {
		expect(promptLinkStatus(link({ expiresAt: NOW - 1, useCount: 1 }), NOW)).toBe('expired');
	});
});

describe('uses', () => {
	it('counts down, never below zero, and is null when unlimited', () => {
		expect(promptLinkUsesLeft(link({ maxUses: 5, useCount: 2 }))).toBe(3);
		expect(promptLinkUsesLeft(link({ maxUses: 1, useCount: 3 }))).toBe(0);
		expect(promptLinkUsesLeft(link({ maxUses: null }))).toBeNull();
	});

	it('describes one-shot, limited, and unlimited links', () => {
		expect(describePromptLinkUses(link())).toBe('One-shot, unused');
		expect(describePromptLinkUses(link({ useCount: 1 }))).toBe('One-shot, used');
		expect(describePromptLinkUses(link({ maxUses: 5, useCount: 2 }))).toBe('2 of 5 used');
		expect(describePromptLinkUses(link({ maxUses: null }))).toBe('Unlimited, unused');
		expect(describePromptLinkUses(link({ maxUses: null, useCount: 3 }))).toBe('3 used, unlimited');
	});
});

describe('describePromptLinkRefusal', () => {
	it('has a sentence for every refusal', () => {
		const reasons: PromptLinkRefusal[] = [
			'disabled',
			'not-found',
			'revoked',
			'expired',
			'spent',
			'in-flight',
			'agent-missing',
			'not-ready',
		];
		for (const reason of reasons) {
			expect(describePromptLinkRefusal(reason).length).toBeGreaterThan(10);
		}
	});
});

describe('validatePromptLinkInput', () => {
	const base = { agentId: 'agent-1', prompt: 'Do the thing' };

	it('accepts a minimal input', () => {
		expect(validatePromptLinkInput(base, NOW)).toBeNull();
	});

	it('needs an agent and a non-blank prompt', () => {
		expect(validatePromptLinkInput({ ...base, agentId: '' }, NOW)).toMatch(/agent/i);
		expect(validatePromptLinkInput({ ...base, prompt: '   ' }, NOW)).toMatch(/prompt/i);
	});

	it('caps the prompt and label length', () => {
		expect(
			validatePromptLinkInput(
				{ ...base, prompt: 'x'.repeat(PROMPT_LINK_MAX_PROMPT_CHARS + 1) },
				NOW
			)
		).toMatch(/longer/);
		expect(validatePromptLinkInput({ ...base, label: 'x'.repeat(500) }, NOW)).toMatch(/label/i);
	});

	it('takes whole-number uses in range, or null for unlimited', () => {
		expect(validatePromptLinkInput({ ...base, maxUses: 3 }, NOW)).toBeNull();
		expect(validatePromptLinkInput({ ...base, maxUses: null }, NOW)).toBeNull();
		expect(validatePromptLinkInput({ ...base, maxUses: 0 }, NOW)).toMatch(/Uses/);
		expect(validatePromptLinkInput({ ...base, maxUses: 1.5 }, NOW)).toMatch(/Uses/);
		expect(validatePromptLinkInput({ ...base, maxUses: PROMPT_LINK_MAX_USES + 1 }, NOW)).toMatch(
			/Uses/
		);
	});

	it('refuses an expiry that is not in the future', () => {
		expect(validatePromptLinkInput({ ...base, expiresAt: NOW }, NOW)).toMatch(/past/);
		expect(validatePromptLinkInput({ ...base, expiresAt: NOW + 60_000 }, NOW)).toBeNull();
		expect(validatePromptLinkInput({ ...base, expiresAt: Number.NaN }, NOW)).toMatch(/valid/);
	});

	it('only knows background and foreground', () => {
		expect(validatePromptLinkInput({ ...base, open: 'foreground' }, NOW)).toBeNull();
		expect(
			validatePromptLinkInput({ ...base, open: 'sideways' as unknown as 'background' }, NOW)
		).toMatch(/Open/);
	});
});

describe('parsePromptLinkUses', () => {
	it('parses whole numbers and unlimited', () => {
		expect(parsePromptLinkUses('1')).toBe(1);
		expect(parsePromptLinkUses(' 12 ')).toBe(12);
		expect(parsePromptLinkUses('unlimited')).toBeNull();
		expect(parsePromptLinkUses('Unlimited')).toBeNull();
	});

	it('rejects everything else', () => {
		expect(parsePromptLinkUses('0')).toBeUndefined();
		expect(parsePromptLinkUses('-1')).toBeUndefined();
		expect(parsePromptLinkUses('2.5')).toBeUndefined();
		expect(parsePromptLinkUses('lots')).toBeUndefined();
		expect(parsePromptLinkUses(String(PROMPT_LINK_MAX_USES + 1))).toBeUndefined();
	});
});

describe('parsePromptLinkExpiry', () => {
	it('turns a duration into an absolute time', () => {
		expect(parsePromptLinkExpiry('30d', NOW)).toBe(NOW + 30 * 86_400_000);
		expect(parsePromptLinkExpiry('12h', NOW)).toBe(NOW + 12 * 3_600_000);
	});

	it('maps never to null and rejects junk or zero', () => {
		expect(parsePromptLinkExpiry('never', NOW)).toBeNull();
		expect(parsePromptLinkExpiry('0d', NOW)).toBeUndefined();
		expect(parsePromptLinkExpiry('soon', NOW)).toBeUndefined();
	});
});

describe('resolvePromptLinkId', () => {
	const links = [
		link({ id: 'aaaa1111-x' }),
		link({ id: 'aaaa2222-y' }),
		link({ id: 'bbbb3333-z' }),
	];

	it('matches an exact id or a unique prefix', () => {
		expect(resolvePromptLinkId(links, 'aaaa2222-y')).toEqual({ link: links[1] });
		expect(resolvePromptLinkId(links, 'bbbb')).toEqual({ link: links[2] });
	});

	it('refuses an ambiguous prefix, an unknown one, and a blank one', () => {
		expect(resolvePromptLinkId(links, 'aaaa')).toEqual({
			error: expect.stringMatching(/2 prompt/),
		});
		expect(resolvePromptLinkId(links, 'cccc')).toEqual({
			error: expect.stringMatching(/No prompt/),
		});
		expect(resolvePromptLinkId(links, '  ')).toEqual({ error: expect.any(String) });
	});
});

describe('parsePromptLinkCommandRequest', () => {
	it('parses list and revoke', () => {
		expect(parsePromptLinkCommandRequest({ action: 'list' })).toEqual({
			ok: true,
			request: { action: 'list' },
		});
		expect(parsePromptLinkCommandRequest({ action: 'revoke', id: ' abc ' })).toEqual({
			ok: true,
			request: { action: 'revoke', id: 'abc' },
		});
		expect(parsePromptLinkCommandRequest({ action: 'revoke' }).ok).toBe(false);
	});

	it('parses create and drops fields it does not know', () => {
		const parsed = parsePromptLinkCommandRequest({
			action: 'create',
			input: {
				agentId: 'a',
				prompt: 'p',
				maxUses: null,
				expiresAt: 5,
				open: 'foreground',
				label: '  Standup ',
				evil: 'x',
			},
		});
		expect(parsed).toEqual({
			ok: true,
			request: {
				action: 'create',
				input: {
					agentId: 'a',
					prompt: 'p',
					maxUses: null,
					expiresAt: 5,
					open: 'foreground',
					label: 'Standup',
				},
			},
		});
	});

	it('rejects mistyped create fields and unknown actions', () => {
		expect(
			parsePromptLinkCommandRequest({ action: 'create', input: { agentId: 'a', maxUses: '3' } }).ok
		).toBe(false);
		expect(
			parsePromptLinkCommandRequest({ action: 'create', input: { agentId: 'a', open: 'up' } }).ok
		).toBe(false);
		expect(parsePromptLinkCommandRequest({ action: 'create' }).ok).toBe(false);
		expect(parsePromptLinkCommandRequest({ action: 'fire' }).ok).toBe(false);
	});
});
