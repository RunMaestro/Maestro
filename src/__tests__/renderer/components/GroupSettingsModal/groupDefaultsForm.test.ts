/**
 * @fileoverview Tests for groupDefaultsForm: a group's stored defaults read
 * into form values, and form values written back with every blank or
 * default-valued field omitted.
 */

import { describe, it, expect } from 'vitest';
import {
	buildGroupDefaults,
	groupDefaultsToForm,
	groupDefaultWorkingDirProblem,
	isSshRemoteChosen,
	PROVIDER_BOUND_DEFAULTS,
	type GroupDefaultsForm,
} from '../../../../renderer/components/GroupSettingsModal/groupDefaultsForm';
import type { GroupAgentDefaults } from '../../../../shared/types';

/** The form of a group with no defaults, with `overrides` on top. */
const form = (overrides: Partial<GroupDefaultsForm> = {}): GroupDefaultsForm => ({
	...groupDefaultsToForm(undefined),
	...overrides,
});

/** The defaults a form builds, for a form that must build. */
const built = (overrides: Partial<GroupDefaultsForm> = {}, context = {}) => {
	const result = buildGroupDefaults(form(overrides), context);
	if (!result.ok) throw new Error(`expected a build, got ${result.field}: ${result.error}`);
	return result.defaults;
};

describe('groupDefaultsToForm', () => {
	it('reads a group with no defaults as an empty form', () => {
		expect(groupDefaultsToForm(undefined)).toEqual({
			projectRoot: '',
			additionalDirectories: [],
			newSessionMessage: '',
			nudgeMessage: '',
			toolType: null,
			customPath: '',
			customArgs: '',
			customModel: undefined,
			customEffort: undefined,
			customContextWindow: undefined,
			enableMaestroP: undefined,
			maestroPMode: 'dynamic',
			maestroPPath: '',
			codexTransport: 'exec',
			retryOnAvailabilityErrors: true,
			retryOnTokenExhaustion: true,
			codexAutoResetOnExhaustion: false,
			runOn: { type: 'provider' },
			tierTargets: {},
			tokenProxyMode: 'off',
			backgroundRequests: undefined,
			gatewayUrl: '',
			systemOneOptOut: false,
			customEnvVars: {},
			customEnvVarsDisabled: {},
			peerAgents: [],
			groupPeerAccess: undefined,
			worktreePeerAccess: undefined,
			sshRemoteConfig: undefined,
		});
	});

	it('reads stored values and clones what a row edit would mutate', () => {
		const defaults: GroupAgentDefaults = {
			toolType: 'claude-code',
			customModel: 'opus',
			customEnvVars: { CLAUDE_CONFIG_DIR: '~/.claude-work' },
			additionalDirectories: [{ path: '/srv/docs', read: true, write: false }],
			peerAgents: [{ sessionId: 'peer-1', read: true, write: false }],
			groupPeerAccess: { read: true, write: false },
			retryOnTokenExhaustion: false,
			enableMaestroP: false,
		};
		const read = groupDefaultsToForm(defaults);

		expect(read.toolType).toBe('claude-code');
		expect(read.customModel).toBe('opus');
		expect(read.customEnvVars).toEqual({ CLAUDE_CONFIG_DIR: '~/.claude-work' });
		expect(read.retryOnAvailabilityErrors).toBe(true);
		expect(read.retryOnTokenExhaustion).toBe(false);
		// The tri-state survives: an explicit `false` is not "never configured".
		expect(read.enableMaestroP).toBe(false);

		expect(read.customEnvVars).not.toBe(defaults.customEnvVars);
		expect(read.additionalDirectories[0]).not.toBe(defaults.additionalDirectories?.[0]);
		expect(read.peerAgents[0]).not.toBe(defaults.peerAgents?.[0]);
		expect(read.groupPeerAccess).not.toBe(defaults.groupPeerAccess);
	});

	it('reads the SSH config in the three shapes a record can hold', () => {
		expect(
			groupDefaultsToForm({
				sessionSshRemoteConfig: { enabled: true, remoteId: 'r1', workingDirOverride: '/srv' },
			}).sshRemoteConfig
		).toEqual({
			enabled: true,
			remoteId: 'r1',
			workingDirOverride: '/srv',
			syncHistory: undefined,
			shareHistoryToProjectDir: undefined,
		});
		// The mirror flag stands without a remote.
		expect(
			groupDefaultsToForm({
				sessionSshRemoteConfig: { enabled: false, remoteId: null, shareHistoryToProjectDir: true },
			}).sshRemoteConfig
		).toEqual({ enabled: false, remoteId: null, shareHistoryToProjectDir: true });
		// Enabled with no remote is not a remote.
		expect(
			groupDefaultsToForm({ sessionSshRemoteConfig: { enabled: true, remoteId: null } })
				.sshRemoteConfig
		).toBeUndefined();
	});

	it('shows a stored Run on target it cannot read as Provider', () => {
		const read = groupDefaultsToForm({ runOn: { type: 'nonsense' } as never });
		expect(read.runOn).toEqual({ type: 'provider' });
	});
});

describe('buildGroupDefaults', () => {
	it('builds nothing from an untouched form', () => {
		expect(built()).toBeUndefined();
	});

	it('pins one env var and nothing else', () => {
		expect(built({ customEnvVars: { CLAUDE_CONFIG_DIR: '~/.claude-work' } })).toEqual({
			customEnvVars: { CLAUDE_CONFIG_DIR: '~/.claude-work' },
		});
	});

	it('round-trips a stored profile unchanged', () => {
		const defaults: GroupAgentDefaults = {
			projectRoot: '/srv/app',
			additionalDirectories: [{ path: '/srv/docs', read: true, write: false }],
			newSessionMessage: 'Read AGENTS.md first.',
			nudgeMessage: 'Be brief.',
			toolType: 'claude-code',
			customPath: '/opt/claude',
			customArgs: '--verbose',
			customModel: 'opus',
			customEffort: 'high',
			customContextWindow: 1_000_000,
			enableMaestroP: true,
			maestroPMode: 'interactive',
			maestroPPath: '/opt/maestro-p',
			retryOnAvailabilityErrors: false,
			systemOneOptOut: true,
			customEnvVars: { CLAUDE_CONFIG_DIR: '~/.claude-work' },
			customEnvVarsDisabled: { DEBUG: '1' },
			peerAgents: [{ sessionId: 'peer-1', read: true, write: false, description: 'Infra' }],
			groupPeerAccess: { read: true, write: false },
			worktreePeerAccess: { read: true, write: true },
		};
		expect(buildGroupDefaults(groupDefaultsToForm(defaults))).toEqual({ ok: true, defaults });
	});

	it('trims text and omits what is blank', () => {
		expect(
			built({
				projectRoot: '  /srv/app  ',
				newSessionMessage: '   ',
				nudgeMessage: ' Be brief. ',
				additionalDirectories: [{ path: '   ', read: true, write: false }],
				peerAgents: [{ sessionId: ' ', read: true, write: false }],
			})
		).toEqual({ projectRoot: '/srv/app', nudgeMessage: 'Be brief.' });
	});

	it('keeps a peer row with neither square lit, because it is an exclusion', () => {
		expect(built({ peerAgents: [{ sessionId: 'peer-1', read: false, write: false }] })).toEqual({
			peerAgents: [{ sessionId: 'peer-1', read: false, write: false }],
		});
	});

	it('writes provider-bound fields only when the form names a provider', () => {
		const providerBound = {
			customPath: '/opt/claude',
			customArgs: '--verbose',
			customModel: 'opus',
			customEffort: 'high',
			customContextWindow: 200_000,
			gatewayUrl: 'http://127.0.0.1:8787',
		};
		expect(built(providerBound)).toBeUndefined();
		expect(built({ ...providerBound, toolType: 'claude-code' })).toEqual({
			toolType: 'claude-code',
			...providerBound,
		});
	});

	it('omits a model, effort or context window the group has no opinion on', () => {
		expect(
			built({
				toolType: 'claude-code',
				customModel: '',
				customEffort: '  ',
				customContextWindow: 0,
			})
		).toEqual({ toolType: 'claude-code' });
	});

	it('writes a resilience flag only when it is switched off', () => {
		expect(built({ retryOnAvailabilityErrors: false })).toEqual({
			retryOnAvailabilityErrors: false,
		});
		expect(built({ retryOnTokenExhaustion: false })).toEqual({ retryOnTokenExhaustion: false });
	});

	describe('Claude token source', () => {
		const claude = { toolType: 'claude-code' as const };
		const remote = { sshRemoteConfig: { enabled: true, remoteId: 'r1' } };

		it('omits an explicit API choice locally, where it is the default', () => {
			expect(built({ ...claude, enableMaestroP: false })).toEqual({ toolType: 'claude-code' });
		});

		it('keeps an explicit API choice over SSH, where the default is the TUI', () => {
			expect(built({ ...claude, ...remote, enableMaestroP: false })).toMatchObject({
				enableMaestroP: false,
			});
		});

		it('writes the mode and the path only with the TUI on', () => {
			expect(
				built({
					...claude,
					enableMaestroP: true,
					maestroPMode: 'interactive',
					maestroPPath: ' /opt/maestro-p ',
				})
			).toEqual({
				toolType: 'claude-code',
				enableMaestroP: true,
				maestroPMode: 'interactive',
				maestroPPath: '/opt/maestro-p',
			});
			expect(
				built({ ...claude, enableMaestroP: undefined, maestroPPath: '/opt/maestro-p' })
			).toEqual({ toolType: 'claude-code' });
		});

		it('is not written for another provider', () => {
			expect(built({ toolType: 'codex', enableMaestroP: true })).toEqual({ toolType: 'codex' });
		});
	});

	it('writes the Codex transport and auto reset only for Codex, and only when set', () => {
		const codexFields = { codexTransport: 'app-server' as const, codexAutoResetOnExhaustion: true };
		expect(built({ toolType: 'codex', ...codexFields })).toEqual({
			toolType: 'codex',
			...codexFields,
		});
		expect(built({ toolType: 'codex' })).toEqual({ toolType: 'codex' });
		expect(built({ toolType: 'claude-code', ...codexFields })).toEqual({
			toolType: 'claude-code',
		});
	});

	describe('Models', () => {
		it('stores the proxy mode in place of a gateway URL', () => {
			expect(
				built({
					toolType: 'claude-code',
					tokenProxyMode: 'compress',
					gatewayUrl: 'http://127.0.0.1:8787',
				})
			).toEqual({ toolType: 'claude-code', tokenProxyMode: 'compress' });
		});

		it('is off the proxy on an SSH remote, whatever the form still holds', () => {
			const defaults = built(
				{
					toolType: 'claude-code',
					tokenProxyMode: 'compress',
					sshRemoteConfig: { enabled: true, remoteId: 'r1' },
				},
				{ sshRemoteName: 'build-box' }
			);
			expect(defaults).not.toHaveProperty('tokenProxyMode');
		});

		it('refuses a gateway URL that is not one, and names the field', () => {
			const result = buildGroupDefaults(form({ toolType: 'claude-code', gatewayUrl: 'not a url' }));
			expect(result).toMatchObject({ ok: false, field: 'gatewayUrl' });
		});

		it('refuses a Run on source for a provider whose harness cannot use one', () => {
			const result = buildGroupDefaults(
				form({
					toolType: 'factory-droid',
					runOn: { type: 'source', endpointId: 'ollama', model: 'qwen3' } as never,
				})
			);
			expect(result).toMatchObject({ ok: false, field: 'runOn' });
		});

		it('stores the System One opt-out with or without a provider', () => {
			expect(built({ systemOneOptOut: true })).toEqual({ systemOneOptOut: true });
		});
	});

	describe('SSH', () => {
		it('stores a chosen remote with only the options that are set', () => {
			expect(
				built({
					sshRemoteConfig: {
						enabled: true,
						remoteId: 'r1',
						workingDirOverride: '  /srv/app ',
						syncHistory: false,
					},
				})
			).toEqual({
				sessionSshRemoteConfig: { enabled: true, remoteId: 'r1', workingDirOverride: '/srv/app' },
			});
		});

		it('stores the mirror flag without a remote, and nothing for a config that is off', () => {
			expect(
				built({
					sshRemoteConfig: { enabled: false, remoteId: null, shareHistoryToProjectDir: true },
				})
			).toEqual({
				sessionSshRemoteConfig: { enabled: false, remoteId: null, shareHistoryToProjectDir: true },
			});
			expect(built({ sshRemoteConfig: { enabled: false, remoteId: null } })).toBeUndefined();
		});
	});

	it('refuses a relative local working directory, and names the field', () => {
		expect(buildGroupDefaults(form({ projectRoot: 'projects/app' }))).toEqual({
			ok: false,
			field: 'workingDir',
			error: 'Enter an absolute path',
		});
	});
});

describe('groupDefaultWorkingDirProblem', () => {
	it('accepts blank, an absolute path and a home path', () => {
		for (const path of ['', '   ', '/srv/app', 'C:\\work\\app', '~', '~/app']) {
			expect(groupDefaultWorkingDirProblem(path, false)).toBeUndefined();
		}
	});

	it('refuses a relative local path', () => {
		expect(groupDefaultWorkingDirProblem('app', false)).toBe('Enter an absolute path');
		expect(groupDefaultWorkingDirProblem('~other/app', false)).toBe('Enter an absolute path');
	});

	it('leaves the shape of a remote path to the remote', () => {
		expect(groupDefaultWorkingDirProblem('app', true)).toBeUndefined();
	});
});

describe('isSshRemoteChosen', () => {
	it('needs both the switch and a remote', () => {
		expect(isSshRemoteChosen(undefined)).toBe(false);
		expect(isSshRemoteChosen({ enabled: true, remoteId: null })).toBe(false);
		expect(isSshRemoteChosen({ enabled: false, remoteId: 'r1' })).toBe(false);
		expect(isSshRemoteChosen({ enabled: true, remoteId: 'r1' })).toBe(true);
	});
});

describe('PROVIDER_BOUND_DEFAULTS', () => {
	it('resets what names one provider, and leaves the env vars and the Run on target', () => {
		const before = form({
			toolType: 'claude-code',
			customModel: 'opus',
			tierTargets: { low: { type: 'model', model: 'haiku' } } as never,
			tokenProxyMode: 'compress',
			gatewayUrl: 'http://127.0.0.1:8787',
			enableMaestroP: true,
			customEnvVars: { CLAUDE_CONFIG_DIR: '~/.claude-work' },
			nudgeMessage: 'Be brief.',
		});
		const after = { ...before, ...PROVIDER_BOUND_DEFAULTS };

		expect(after.customModel).toBeUndefined();
		expect(after.tierTargets).toEqual({});
		expect(after.tokenProxyMode).toBe('off');
		expect(after.gatewayUrl).toBe('');
		expect(after.enableMaestroP).toBeUndefined();
		expect(after.customEnvVars).toEqual({ CLAUDE_CONFIG_DIR: '~/.claude-work' });
		expect(after.nudgeMessage).toBe('Be brief.');
		expect(PROVIDER_BOUND_DEFAULTS).not.toHaveProperty('runOn');
		expect(PROVIDER_BOUND_DEFAULTS).not.toHaveProperty('customEnvVars');
	});
});
