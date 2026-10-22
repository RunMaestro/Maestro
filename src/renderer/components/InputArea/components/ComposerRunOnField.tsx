import { useRef, useState } from 'react';
import type { Session } from '../../../types';
import { useTabStore } from '../../../stores/tabStore';
import { RunOnField } from '../../shared/RunOnField';
import { getSessionSshRemoteId } from '../../../utils/sessionHelpers';
import type { Theme } from '../../../types';
import { useSessionStore } from '../../../stores/sessionStore';
import { resolveTabProvider } from '../../../utils/providerTabSessions';

/** Save the existing Run on control to the selected tab, never the agent. */
export function ComposerRunOnField({
	theme,
	agent,
	tabId,
}: {
	theme: Theme;
	agent: Session;
	tabId: string;
}) {
	const [error, setError] = useState<string>();
	const saving = useRef(false);
	return (
		<RunOnField
			theme={theme}
			toolType={agent.toolType}
			value={agent.runOn ?? { type: 'provider' }}
			userEnvVars={agent.customEnvVars}
			sshRemoteName={getSessionSshRemoteId(agent) ?? undefined}
			error={error}
			testId="composer-run-on"
			onChange={(target) => {
				if (saving.current) return;
				const live = useSessionStore.getState().sessions.find((session) => session.id === agent.id);
				const tab = live?.aiTabs.find((item) => item.id === tabId);
				if (!live || !tab || resolveTabProvider(tab, live) !== agent.toolType) {
					setError('Tab provider changed; reopen the model menu.');
					return;
				}
				saving.current = true;
				setError(undefined);
				void useTabStore
					.getState()
					.setTabSettings(agent.id, tabId, { runOn: target })
					.catch((failure: unknown) => {
						setError(failure instanceof Error ? failure.message : String(failure));
					})
					.finally(() => {
						saving.current = false;
					});
			}}
		/>
	);
}
