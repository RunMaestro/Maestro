/** Slash command discovery belongs to a provider, account and execution host. */
import type { AITab, Session, ToolType } from '../types';
import { canonicalJson } from '../../shared/canonicalJson';
import { resolveAgentAccountKey } from '../../shared/providerProfiles';
import { providerOverridesFor, resolveTabProvider } from './providerTabSessions';
import { getSessionSshRemoteId, isSessionRemote } from './sessionHelpers';
import { useSettingsStore } from '../stores/settingsStore';

export function agentCommandScope(session: Session, tab?: AITab, provider?: ToolType): string {
	const selectedProvider = provider ?? resolveTabProvider(tab, session);
	const overrides = providerOverridesFor(session, selectedProvider);
	return canonicalJson({
		provider: selectedProvider,
		account:
			resolveAgentAccountKey(
				selectedProvider,
				{
					...useSettingsStore.getState().shellEnvVars,
					...overrides.customEnvVars,
				},
				undefined
			) ?? 'provider-default',
		host: isSessionRemote(session) ? getSessionSshRemoteId(session) : undefined,
		cwd: session.cwd,
		projectRoot: session.projectRoot,
		customPath: overrides.customPath,
	});
}

/** Unknown legacy ownership is rediscovered rather than borrowed by another tab. */
export function getAgentCommands(
	session: Session | null | undefined,
	tab?: AITab,
	provider?: ToolType
): Session['agentCommands'] {
	return session && session.agentCommandsScope === agentCommandScope(session, tab, provider)
		? session.agentCommands
		: undefined;
}
