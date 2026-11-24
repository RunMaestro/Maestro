import { describe, expect, it } from 'vitest';
import {
	describeSelectionChange,
	requiresNativeOwnership,
	resumeSelectionKey,
} from '../../../renderer/services/resumableSession';
import { createMockSession } from '../../helpers';

describe('describeSelectionChange', () => {
	const base = createMockSession({
		id: 'a',
		toolType: 'claude-code',
		cwd: '/project',
		projectRoot: '/project',
		customEnvVars: { CLAUDE_CONFIG_DIR: '/accounts/smash', API_TOKEN: 'secret-one' },
	});
	const key = resumeSelectionKey(base);

	it('is null when nothing changed', () => {
		expect(describeSelectionChange(key, { ...base })).toBeNull();
	});

	it("names the provider's account variable as the account", () => {
		const moved = {
			...base,
			customEnvVars: { ...base.customEnvVars, CLAUDE_CONFIG_DIR: '/accounts/gmail' },
		};
		expect(describeSelectionChange(key, moved)).toBe('account (CLAUDE_CONFIG_DIR)');
	});

	it('names other variables by name and never shows a value', () => {
		const changed = describeSelectionChange(key, {
			...base,
			customEnvVars: { CLAUDE_CONFIG_DIR: '/accounts/smash', API_TOKEN: 'secret-two', NEW: 'x' },
		})!;
		expect(changed).toBe('environment (API_TOKEN, NEW)');
		expect(changed).not.toMatch(/secret|\/accounts/);
	});

	it('names each changed field once', () => {
		expect(describeSelectionChange(key, { ...base, cwd: '/other', projectRoot: '/other' })).toBe(
			'working directory'
		);
		expect(
			describeSelectionChange(key, {
				...base,
				customArgs: '--verbose',
				sessionSshRemoteConfig: { enabled: true, remoteId: 'host' },
			})
		).toBe('SSH host, launch arguments');
	});

	it('reads an unreadable key as changed settings rather than no change', () => {
		expect(describeSelectionChange('not json', base)).toBe('settings');
	});
});

describe('requiresNativeOwnership', () => {
	it('scopes Grok always and other providers only once a binding was observed', () => {
		expect(requiresNativeOwnership('grok', undefined)).toBe(true);
		expect(requiresNativeOwnership('claude-code', undefined)).toBe(false);
		expect(requiresNativeOwnership('claude-code', null)).toBe(true);
	});
});
