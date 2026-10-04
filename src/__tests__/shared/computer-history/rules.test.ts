import { describe, expect, it } from 'vitest';
import {
	dropReason,
	hostMatchesDomain,
	isPrivateWindowTitle,
	validateRuleInput,
} from '../../../shared/computer-history/rules';
import {
	applyConfigPatch,
	defaultComputerHistoryConfig,
	isPausedAt,
	normalizeConfig,
	normalizeRuleValue,
	ruleIdFor,
} from '../../../shared/computer-history/config';
import { builtInBlockedApps } from '../../../shared/computer-history/exclusions';
import { parseDurationInput, parseTimeInput } from '../../../shared/computer-history/timeRange';
import { resolveKindInput } from '../../../shared/computer-history/status';
import type { CaptureRule, ObservedEvent } from '../../../shared/computer-history/types';

function ev(partial: Partial<ObservedEvent>): ObservedEvent {
	return {
		v: 1,
		ts: '2026-10-03T14:10:00.000Z',
		kind: 'text.committed',
		app: { id: 'com.tinyspeck.slackmacgap', name: 'Slack', pid: 42 },
		...partial,
	};
}

const rules: CaptureRule[] = [
	{ id: 'a', match: 'app', value: 'com.apple.mobilesms', action: 'ignore' },
	{ id: 'b', match: 'domain', value: 'bank.example.com', action: 'ignore' },
];

describe('dropReason', () => {
	it('keeps an ordinary event', () => {
		expect(dropReason(ev({}), { rules })).toBeNull();
	});

	it('drops built-in password managers and Maestro on every platform, case-insensitively', () => {
		expect(
			dropReason(ev({ app: { id: 'com.1password.1password', name: '1P', pid: 1 } }), { rules: [] })
		).toBe('built-in-app');
		expect(dropReason(ev({ app: { id: 'KeePassXC.exe', name: 'K', pid: 1 } }), { rules: [] })).toBe(
			'built-in-app'
		);
		expect(
			dropReason(ev({ app: { id: 'com.maestro.app', name: 'Maestro', pid: 1 } }), { rules: [] })
		).toBe('built-in-app');
		expect(
			dropReason(ev({ app: { id: 'com.apple.keychainaccess', name: 'K', pid: 1 } }), { rules: [] })
		).toBe('built-in-app');
	});

	it('drops app rules (case-insensitive) and blocked pids', () => {
		expect(
			dropReason(ev({ app: { id: 'com.apple.MobileSMS', name: 'Messages', pid: 7 } }), { rules })
		).toBe('app-rule');
		expect(dropReason(ev({}), { rules: [], blockPids: [42] })).toBe('blocked-pid');
	});

	it('drops private windows', () => {
		expect(
			dropReason(ev({ window: { title: 'New Incognito Tab - Google Chrome' } }), { rules })
		).toBe('private-window');
		expect(
			dropReason(ev({ window: { title: 'Mozilla Firefox Private Browsing' } }), { rules })
		).toBe('private-window');
		expect(isPrivateWindowTitle('InPrivate - Microsoft Edge')).toBe(true);
		expect(isPrivateWindowTitle('Privacy policy')).toBe(false);
	});

	it('drops blocked domains and their subdomains only', () => {
		const at = (url: string) => ev({ window: { title: 't', url } });
		expect(dropReason(at('https://bank.example.com/login'), { rules })).toBe('domain-rule');
		expect(dropReason(at('https://www.bank.example.com/'), { rules })).toBe('domain-rule');
		expect(dropReason(at('https://notbank.example.com/'), { rules })).toBeNull();
		expect(dropReason(at('https://example.com/'), { rules })).toBeNull();
		expect(dropReason(at('not a url'), { rules })).toBeNull();
	});

	it('hostMatchesDomain', () => {
		expect(hostMatchesDomain('a.b.c', 'b.c')).toBe(true);
		expect(hostMatchesDomain('ab.c', 'b.c')).toBe(false);
		expect(hostMatchesDomain('B.C.', '*.b.c')).toBe(true);
	});
});

describe('rule input', () => {
	it('normalizes domains from URLs and wildcards', () => {
		expect(normalizeRuleValue('domain', 'https://Bank.Example.com:443/path?q=1')).toBe(
			'bank.example.com'
		);
		expect(normalizeRuleValue('domain', '*.example.com')).toBe('example.com');
		expect(normalizeRuleValue('app', ' Com.Apple.MobileSMS ')).toBe('com.apple.mobilesms');
	});

	it('validates', () => {
		expect(validateRuleInput('domain', 'bank.example.com')).toBeNull();
		expect(validateRuleInput('domain', 'not a domain')).toMatch(/not a domain/);
		expect(validateRuleInput('app', '   ')).toMatch(/needs a value/);
	});

	it('rule ids are deterministic', () => {
		expect(ruleIdFor('app', 'x')).toBe(ruleIdFor('app', 'x'));
		expect(ruleIdFor('app', 'x')).not.toBe(ruleIdFor('domain', 'x'));
	});
});

describe('config', () => {
	it('defaults: 90 days, 25 GB, snapshots on, digests off', () => {
		const d = defaultComputerHistoryConfig();
		expect(d.retentionDays).toBe(90);
		expect(d.maxBytes).toBe(25 * 1024 ** 3);
		expect(d.snapshots).toBe(true);
		expect(d.digests).toEqual({ enabled: false, agentId: null });
		expect(d.pausedUntil).toBeNull();
	});

	it('normalizes junk field by field', () => {
		const c = normalizeConfig({
			retentionDays: -4,
			maxBytes: 'big',
			snapshots: 'yes',
			rules: [
				{ match: 'app', value: 'A' },
				{ match: 'app', value: 'a' },
				{ match: 'bogus', value: 'x' },
				{ match: 'domain', value: '' },
			],
			pausedUntil: 'not a date',
			digests: { enabled: true, agentId: '  ' },
		});
		expect(c.retentionDays).toBe(1);
		expect(c.maxBytes).toBe(25 * 1024 ** 3);
		expect(c.snapshots).toBe(true);
		expect(c.rules).toHaveLength(1);
		expect(c.rules[0]).toMatchObject({ match: 'app', value: 'a', action: 'ignore' });
		expect(c.pausedUntil).toBeNull();
		expect(c.digests).toEqual({ enabled: true, agentId: null });
		expect(normalizeConfig('garbage')).toEqual(defaultComputerHistoryConfig());
	});

	it('applyConfigPatch merges digests and clamps', () => {
		const next = applyConfigPatch(defaultComputerHistoryConfig(), {
			retentionDays: 30,
			digests: { agentId: 'agent-1' },
		});
		expect(next.retentionDays).toBe(30);
		expect(next.digests).toEqual({ enabled: false, agentId: 'agent-1' });
	});

	it('isPausedAt', () => {
		expect(isPausedAt(null, 0)).toBe(false);
		expect(isPausedAt('forever', 0)).toBe(true);
		expect(isPausedAt('2026-10-03T15:00:00.000Z', Date.parse('2026-10-03T14:00:00Z'))).toBe(true);
		expect(isPausedAt('2026-10-03T13:00:00.000Z', Date.parse('2026-10-03T14:00:00Z'))).toBe(false);
	});
});

describe('exclusions, time parsing, kinds', () => {
	it('built-ins per platform include the platform Maestro id', () => {
		expect(builtInBlockedApps('macos')).toContain('com.maestro.app');
		expect(builtInBlockedApps('windows')).toContain('maestro.exe');
		expect(builtInBlockedApps('linux')).toContain('maestro');
		expect(builtInBlockedApps('linux')).toContain('seahorse');
	});

	it('parses durations including weeks, ISO, and epoch', () => {
		const now = Date.parse('2026-10-03T14:00:00Z');
		expect(parseDurationInput('1w')).toBe(7 * 86_400_000);
		expect(parseDurationInput('30m')).toBe(30 * 60_000);
		expect(parseTimeInput('2h', now)).toBe(now - 2 * 3_600_000);
		expect(parseTimeInput('2026-10-03T13:00:00Z', now)).toBe(Date.parse('2026-10-03T13:00:00Z'));
		expect(parseTimeInput('1759500000', now)).toBe(1759500000 * 1000);
		expect(parseTimeInput('yesterday-ish', now)).toBeNull();
	});

	it('resolves kind aliases', () => {
		expect(resolveKindInput('text')).toBe('text.committed');
		expect(resolveKindInput('content.snapshot')).toBe('content.snapshot');
		expect(resolveKindInput('nope')).toBeNull();
	});
});
