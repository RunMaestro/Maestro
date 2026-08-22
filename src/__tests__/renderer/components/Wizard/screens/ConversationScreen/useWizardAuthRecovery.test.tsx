import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

import { useWizardAuthRecovery } from '../../../../../../renderer/components/Wizard/screens/ConversationScreen/hooks/useWizardAuthRecovery';
import type { WizardError } from '../../../../../../renderer/components/Wizard/services/wizardErrorDetection';
import type { CredentialIdentity } from '../../../../../../shared/providerAuth';

// The store resolves and records the credential; that resolution is covered by
// providerAuthStore's own tests. Here we care only that the hook marks the
// failure and then routes the right remedy for what came back.
const mockMarkAgentTypeAuthFailure = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock('../../../../../../renderer/stores/providerAuthStore', () => ({
	markAgentTypeAuthFailure: (...args: unknown[]) => mockMarkAgentTypeAuthFailure(...args),
}));

const mockOpenAuthRecovery = vi.fn();
vi.mock('../../../../../../renderer/stores/modalStore', () => ({
	getModalActions: () => ({ openAuthRecovery: mockOpenAuthRecovery }),
}));

function makeError(overrides: Partial<WizardError> = {}): WizardError {
	return {
		type: 'auth_expired',
		title: 'Authentication Required',
		message: 'OAuth token has expired. Sign in again to continue.',
		recoveryHint: 'The provider rejected the credentials for this agent.',
		canRetry: false,
		...overrides,
	};
}

const oauthIdentity: CredentialIdentity = {
	key: 'claude-code::oauth::/Users/x/.claude::local',
	provider: 'claude-code',
	kind: 'oauth',
	scope: '/Users/x/.claude',
	host: 'local',
	configDir: '/Users/x/.claude',
	label: '.claude',
};

const apiKeyIdentity: CredentialIdentity = {
	key: 'claude-code::api-key::sha256:abcd1234::local',
	provider: 'claude-code',
	kind: 'api-key',
	scope: 'sha256:abcd1234',
	host: 'local',
	envVarName: 'ANTHROPIC_AUTH_TOKEN',
	label: 'Claude Code key abcd1234',
};

beforeEach(() => {
	vi.clearAllMocks();
	mockMarkAgentTypeAuthFailure.mockResolvedValue(null);
});

describe('useWizardAuthRecovery', () => {
	// `null` is the LOCAL host throughout the identity model, so an enabled remote
	// that names nothing must not collapse into it - that would mark the local
	// credential as failed and offer a local sign-in for a remote run.
	it('does not treat an enabled but unresolved SSH remote as local', async () => {
		mockMarkAgentTypeAuthFailure.mockResolvedValue(oauthIdentity);

		const { result } = renderHook(() =>
			useWizardAuthRecovery(makeError(), 'claude-code', { enabled: true, remoteId: null })
		);

		await waitFor(() => expect(result.current).not.toBeNull());
		expect(mockMarkAgentTypeAuthFailure).not.toHaveBeenCalled();
		// Nothing honest to offer, so the panel keeps its generic hint.
		expect(result.current?.action).toBeNull();
	});

	it('still resolves normally once that remote names an id', async () => {
		mockMarkAgentTypeAuthFailure.mockResolvedValue(oauthIdentity);

		const { result } = renderHook(() =>
			useWizardAuthRecovery(makeError(), 'claude-code', { enabled: true, remoteId: 'box-1' })
		);

		await waitFor(() => expect(result.current?.action).not.toBeNull());
		expect(mockMarkAgentTypeAuthFailure).toHaveBeenCalledWith(
			'claude-code',
			'box-1',
			expect.any(String)
		);
	});

	// The resolved identity belongs to the request that asked for it. While a new
	// one is in flight the old credential must not still be on offer: cancelling a
	// late write says nothing about the value already in state.
	it('drops the previous credential while a new request resolves', async () => {
		mockMarkAgentTypeAuthFailure.mockResolvedValue(oauthIdentity);

		const { result, rerender } = renderHook(
			({ agentType }: { agentType: 'claude-code' | 'codex' }) =>
				useWizardAuthRecovery(makeError(), agentType),
			{ initialProps: { agentType: 'claude-code' as const } }
		);

		await waitFor(() => expect(result.current?.action).not.toBeNull());

		// Never resolves, so the hook stays in the in-flight window.
		mockMarkAgentTypeAuthFailure.mockReturnValue(new Promise(() => {}));
		rerender({ agentType: 'codex' as const });

		expect(result.current?.action).toBeNull();
	});

	it('returns null for a non-auth error and records nothing', () => {
		const { result } = renderHook(() =>
			useWizardAuthRecovery(makeError({ type: 'rate_limited' }), 'claude-code')
		);
		expect(result.current).toBeNull();
		expect(mockMarkAgentTypeAuthFailure).not.toHaveBeenCalled();
	});

	it('returns null when there is no error at all', () => {
		const { result } = renderHook(() => useWizardAuthRecovery(null, 'claude-code'));
		expect(result.current).toBeNull();
	});

	it('records the failure against the credential, with the SSH remote when one is selected', async () => {
		mockMarkAgentTypeAuthFailure.mockResolvedValue(oauthIdentity);
		renderHook(() =>
			useWizardAuthRecovery(makeError(), 'claude-code', { enabled: true, remoteId: 'box-1' })
		);
		await waitFor(() =>
			expect(mockMarkAgentTypeAuthFailure).toHaveBeenCalledWith(
				'claude-code',
				'box-1',
				'OAuth token has expired. Sign in again to continue.'
			)
		);
	});

	it('treats a disabled SSH config as local', async () => {
		mockMarkAgentTypeAuthFailure.mockResolvedValue(oauthIdentity);
		renderHook(() =>
			useWizardAuthRecovery(makeError(), 'claude-code', { enabled: false, remoteId: 'box-1' })
		);
		await waitFor(() =>
			expect(mockMarkAgentTypeAuthFailure).toHaveBeenCalledWith(
				'claude-code',
				null,
				expect.any(String)
			)
		);
	});

	it('offers a login button for an oauth credential, opening the recovery modal on that identity', async () => {
		mockMarkAgentTypeAuthFailure.mockResolvedValue(oauthIdentity);
		const { result } = renderHook(() => useWizardAuthRecovery(makeError(), 'claude-code'));

		await waitFor(() => expect(result.current?.action).not.toBeNull());
		expect(result.current?.action?.label).toBe('Sign in to Claude Code (.claude)');
		expect(result.current?.hint).toMatch(/Maestro runs the login for you/);

		result.current?.action?.onClick();
		expect(mockOpenAuthRecovery).toHaveBeenCalledWith(oauthIdentity.key);
	});

	it('offers no login button for a credential a login cannot repair, and names the env var', async () => {
		mockMarkAgentTypeAuthFailure.mockResolvedValue(apiKeyIdentity);
		const { result } = renderHook(() => useWizardAuthRecovery(makeError(), 'claude-code'));

		await waitFor(() => expect(result.current?.hint).toContain('ANTHROPIC_AUTH_TOKEN'));
		expect(result.current?.action).toBeNull();
	});

	it('keeps the generic hint and no button when no credential resolves', async () => {
		mockMarkAgentTypeAuthFailure.mockResolvedValue(null);
		const { result } = renderHook(() => useWizardAuthRecovery(makeError(), 'claude-code'));

		await waitFor(() => expect(mockMarkAgentTypeAuthFailure).toHaveBeenCalled());
		expect(result.current?.hint).toBe('The provider rejected the credentials for this agent.');
		expect(result.current?.action).toBeNull();
	});

	it('does nothing when the wizard has not picked an agent yet', () => {
		const { result } = renderHook(() => useWizardAuthRecovery(makeError(), null));
		expect(mockMarkAgentTypeAuthFailure).not.toHaveBeenCalled();
		expect(result.current?.action).toBeNull();
	});
});
