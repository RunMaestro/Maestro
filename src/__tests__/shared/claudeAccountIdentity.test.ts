/**
 * Tests for src/shared/claudeAccountIdentity.ts
 *
 * The point of this module is that two `CLAUDE_CONFIG_DIR`s can be logged into
 * ONE Anthropic account, in which case they share a quota bucket and their
 * dashboard bars are identical by construction. These tests pin the parsing of
 * `.claude.json`'s `oauthAccount` and the grouping that lets the UI say so.
 */

import { describe, it, expect } from 'vitest';
import {
	accountIdentityFingerprint,
	groupAccountKeysByIdentity,
	parseClaudeAccountIdentity,
} from '../../shared/claudeAccountIdentity';

describe('parseClaudeAccountIdentity', () => {
	it('extracts email, uuid, and org name from a real-shaped oauthAccount', () => {
		const identity = parseClaudeAccountIdentity({
			userID: 'abc123',
			oauthAccount: {
				accountUuid: '2acf84ae-d765-4a12-ae90-296b9f903018',
				emailAddress: 'pedram@smashlabs.com',
				organizationName: "pedram@smashlabs.com's Organization",
				organizationUuid: '69e417ec-08ca-417c-a435-0ae061aee8b3',
			},
		});

		expect(identity).toEqual({
			email: 'pedram@smashlabs.com',
			accountUuid: '2acf84ae-d765-4a12-ae90-296b9f903018',
			organizationName: "pedram@smashlabs.com's Organization",
		});
	});

	it('returns a partial identity when only some fields are present', () => {
		// Older `.claude.json` blobs can carry the email without the uuid.
		// Half an identity still labels the row better than the directory name.
		expect(parseClaudeAccountIdentity({ oauthAccount: { emailAddress: 'a@b.com' } })).toEqual({
			email: 'a@b.com',
		});
	});

	it.each([
		['null', null],
		['undefined', undefined],
		['a string', 'not an object'],
		['an object with no oauthAccount', { userID: 'abc' }],
		['a non-object oauthAccount', { oauthAccount: 'nope' }],
		['an oauthAccount with no readable fields', { oauthAccount: { seatTier: null } }],
		['an oauthAccount with empty-string fields', { oauthAccount: { emailAddress: '' } }],
		['an oauthAccount with wrong-typed fields', { oauthAccount: { emailAddress: 42 } }],
	])('returns null for %s', (_label, input) => {
		expect(parseClaudeAccountIdentity(input)).toBeNull();
	});
});

describe('accountIdentityFingerprint', () => {
	it('prefers the uuid over the email', () => {
		expect(accountIdentityFingerprint({ accountUuid: 'u1', email: 'a@b.com' })).toBe('uuid:u1');
	});

	it('falls back to a case-folded email when there is no uuid', () => {
		expect(accountIdentityFingerprint({ email: 'A@B.com' })).toBe('email:a@b.com');
	});

	it('returns null when there is nothing to match on', () => {
		// Two unknowns are not evidence of a match, so they must not group.
		expect(accountIdentityFingerprint({ organizationName: 'Some Org' })).toBeNull();
		expect(accountIdentityFingerprint(null)).toBeNull();
		expect(accountIdentityFingerprint(undefined)).toBeNull();
	});
});

describe('groupAccountKeysByIdentity', () => {
	it('pairs two config dirs logged into the same account', () => {
		// The real case that started this: ~/.claude-gmail was re-logged into
		// the smashlabs account, so both dirs draw on one quota.
		const shared = groupAccountKeysByIdentity({
			'/Users/pedram/.claude-gmail': { accountUuid: 'smash-uuid', email: 'p@smashlabs.com' },
			'/Users/pedram/.claude-smash': { accountUuid: 'smash-uuid', email: 'p@smashlabs.com' },
			'/Users/pedram/.claude-banaco': { accountUuid: 'banaco-uuid', email: 'p@banaco.com' },
		});

		expect(shared).toEqual({
			'/Users/pedram/.claude-gmail': ['/Users/pedram/.claude-smash'],
			'/Users/pedram/.claude-smash': ['/Users/pedram/.claude-gmail'],
		});
	});

	it('groups three or more dirs and lists every sibling but the key itself', () => {
		const shared = groupAccountKeysByIdentity({
			a: { accountUuid: 'u' },
			b: { accountUuid: 'u' },
			c: { accountUuid: 'u' },
		});

		expect(shared.a).toEqual(['b', 'c']);
		expect(shared.b).toEqual(['a', 'c']);
		expect(shared.c).toEqual(['a', 'b']);
	});

	it('preserves input key order in the sibling lists so rendering is stable', () => {
		const shared = groupAccountKeysByIdentity({
			zeta: { accountUuid: 'u' },
			alpha: { accountUuid: 'u' },
			mid: { accountUuid: 'u' },
		});

		expect(shared.mid).toEqual(['zeta', 'alpha']);
	});

	it('matches on email when the uuid is missing on both sides', () => {
		const shared = groupAccountKeysByIdentity({
			a: { email: 'Same@Example.com' },
			b: { email: 'same@example.com' },
		});

		expect(shared).toEqual({ a: ['b'], b: ['a'] });
	});

	it('does not match a uuid-bearing identity to an email-only one', () => {
		// A uuid fingerprint and an email fingerprint live in different
		// namespaces on purpose - when the uuid exists it is the answer, and
		// silently downgrading to email matching would invent groupings.
		const shared = groupAccountKeysByIdentity({
			a: { accountUuid: 'u', email: 'x@y.com' },
			b: { email: 'x@y.com' },
		});

		expect(shared).toEqual({});
	});

	it('omits keys with no siblings, unknown identities, and null identities', () => {
		const shared = groupAccountKeysByIdentity({
			solo: { accountUuid: 'only-me' },
			unknown: { organizationName: 'No ids here' },
			missing: null,
			absent: undefined,
		});

		expect(shared).toEqual({});
	});

	it('returns an empty map for an empty input', () => {
		expect(groupAccountKeysByIdentity({})).toEqual({});
	});
});
