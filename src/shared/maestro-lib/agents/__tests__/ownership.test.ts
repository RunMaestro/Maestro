import { describe, expect, it } from 'vitest';
import {
	AGENT_DOMAIN_KEYS,
	GROUP_DOMAIN_KEYS,
	isAgentDomainKey,
	isGroupDomainKey,
	isTabDomainKey,
	PROVIDER_SCOPED_TAB_KEYS,
	splitByOwnership,
	TAB_DOMAIN_KEYS,
} from '../ownership';
import { PROVIDER_OVERRIDE_KEYS } from '../providerSwap';

describe('ownership', () => {
	it('lists every provider override and the parked overrides as agent domain', () => {
		for (const key of PROVIDER_OVERRIDE_KEYS) expect(isAgentDomainKey(key)).toBe(true);
		expect(isAgentDomainKey('providerOverrides')).toBe(true);
	});

	it('treats view, workspace, and turn state as desktop-owned', () => {
		for (const key of [
			'state',
			'activeTabId',
			'inputMode',
			'filePreviewTabs',
			'executionQueue',
			'aiTabs',
			'unifiedTabOrder',
			'someFieldAddedLater',
		]) {
			expect(isAgentDomainKey(key)).toBe(false);
		}
		expect(isTabDomainKey('logs')).toBe(false);
		expect(isTabDomainKey('hasUnread')).toBe(false);
		expect(isGroupDomainKey('collapsed')).toBe(false);
	});

	it('keeps the provider-scoped tab keys out of the tab domain list', () => {
		for (const key of PROVIDER_SCOPED_TAB_KEYS) expect(TAB_DOMAIN_KEYS.has(key)).toBe(false);
		expect(TAB_DOMAIN_KEYS.has('providerSessions')).toBe(true);
	});

	it('exports closed lists', () => {
		expect(AGENT_DOMAIN_KEYS.has('id')).toBe(true);
		expect(GROUP_DOMAIN_KEYS.has('parentGroupId')).toBe(true);
	});

	it('splits a record into its domain and desktop parts, keeping order and values', () => {
		const shared = { deep: true };
		const { domain, desktop } = splitByOwnership(
			{ name: 'A', inputMode: 'ai', cwd: '/x', scrollTop: 4, workLog: shared },
			isAgentDomainKey
		);
		expect(Object.keys(domain)).toEqual(['name', 'cwd']);
		expect(Object.keys(desktop)).toEqual(['inputMode', 'scrollTop', 'workLog']);
		expect(desktop.workLog).toBe(shared);
	});
});
