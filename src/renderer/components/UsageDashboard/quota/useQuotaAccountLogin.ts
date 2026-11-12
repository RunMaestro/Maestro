/**
 * useQuotaAccountLogin
 *
 * Sign a quota panel's account back in from the row that says it is logged
 * out. Opens the shared ReauthModal (same embedded login PTY, env disclosure,
 * and account pill as an agent's re-auth), pointed at the ACCOUNT rather than
 * at an agent: a quota row can have zero agents, and the provider's first
 * blocked agent may sit on a different account of the same provider.
 *
 * When the login dialog closes, `onLoginClosed` fires so the panel can
 * re-sample and the row reflects the new login without a manual Refresh.
 */

import { useCallback, useEffect, useRef } from 'react';
import { getModalActions, selectModalOpen, useModalStore } from '../../../stores/modalStore';
import type { ReauthHost } from '../../../stores/modalStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { startAccountReauth } from '../../../stores/authOutageStore';
import {
	getAccountKeyHelpers,
	getProviderProfileConfig,
} from '../../../../shared/providerProfiles';
import { joinPath } from '../../../../shared/formatters';
import { getHomeDir, getHomeDirAsync } from '../../../utils/homeDir';
import type { Session } from '../../../types';
import type { ToolType } from '../../../../shared/types';

/** Whether a sampled auth state is one a provider login repairs. */
export function quotaAuthStateNeedsLogin(authState: string | undefined): boolean {
	return authState === 'unauthenticated' || authState === 'missing_auth';
}

function sameDir(a: string, b: string): boolean {
	const fold = (p: string) => p.replace(/[/\\]+$/, '').toLowerCase();
	return fold(a) === fold(b);
}

/**
 * Describe where an account's login runs.
 *
 * The account dir goes in the agent-level env slot, which the login shell
 * layers over the provider-level set, so it wins even when Settings -> Agents
 * names another account. The DEFAULT account sets nothing: Claude Code keys
 * its keychain entry on whether `CLAUDE_CONFIG_DIR` is set at all, so naming
 * `~/.claude` explicitly would log into a credential slot no unconfigured
 * agent reads.
 *
 * `customPath` is borrowed from a local agent of the provider that sets one,
 * so the login runs the same binary the agents do.
 */
export function buildAccountLoginHost(
	toolType: ToolType,
	accountKey: string,
	homeDir: string | undefined,
	sessions: readonly Session[]
): ReauthHost {
	const config = getProviderProfileConfig(toolType);
	const helpers = getAccountKeyHelpers(toolType);
	const isDefault =
		!!config && !!homeDir && sameDir(accountKey, joinPath(homeDir, config.defaultSubdir));
	const customPath = sessions.find(
		(s) => s.toolType === toolType && !s.sessionSshRemoteConfig?.enabled && s.customPath
	)?.customPath;
	const shortName = helpers?.deriveShortName(accountKey) ?? accountKey;
	return {
		id: `quota-account-${toolType}-${shortName}`,
		name: `${helpers?.deriveDisplayName(accountKey) ?? accountKey} account`,
		toolType,
		cwd: homeDir ?? '',
		projectRoot: homeDir ?? '',
		customEnvVars: config && !isDefault ? { [config.envVar]: accountKey } : undefined,
		customPath,
		sessionSshRemoteConfig: undefined,
		sshRemoteId: undefined,
		remoteCwd: undefined,
	};
}

export function useQuotaAccountLogin(
	toolType: ToolType,
	onLoginClosed: () => void
): (accountKey: string) => void {
	const reauthOpen = useModalStore(selectModalOpen('reauth'));
	const pendingRef = useRef(false);
	const wasOpenRef = useRef(reauthOpen);
	const onClosedRef = useRef(onLoginClosed);
	useEffect(() => {
		onClosedRef.current = onLoginClosed;
	});

	// Fire once on the open -> closed edge of a login THIS panel started, so an
	// unrelated agent re-auth closing elsewhere does not trigger a re-sample.
	useEffect(() => {
		const wasOpen = wasOpenRef.current;
		wasOpenRef.current = reauthOpen;
		if (wasOpen && !reauthOpen && pendingRef.current) {
			pendingRef.current = false;
			onClosedRef.current();
		}
	}, [reauthOpen]);

	return useCallback(
		(accountKey: string) => {
			const open = (homeDir: string | undefined) => {
				const host = buildAccountLoginHost(
					toolType,
					accountKey,
					homeDir,
					useSessionStore.getState().sessions
				);
				const { providerKey } = startAccountReauth(toolType);
				pendingRef.current = true;
				getModalActions().openReauthModal({ providerKey, host });
			};
			const cached = getHomeDir();
			if (cached) {
				open(cached);
				return;
			}
			// The default-account check needs $HOME; without it every account
			// would be treated as non-default and pinned explicitly.
			void (getHomeDirAsync() ?? Promise.resolve(undefined)).then(open);
		},
		[toolType]
	);
}
