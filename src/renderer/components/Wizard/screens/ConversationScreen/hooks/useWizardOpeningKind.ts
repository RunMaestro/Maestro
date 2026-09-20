import { useEffect, useState } from 'react';
import { getWizardSshRemoteId } from '../../DirectorySelectionScreen/utils/sshRemote';
import { projectHasFiles } from '../utils/projectFiles';
import type { WizardSessionSshRemoteConfig } from '../../../WizardContext';
import type { WizardOpeningKind } from './useWizardConversationSend';

interface UseWizardOpeningKindParams {
	existingDocsChoice: 'continue' | 'fresh' | null;
	directoryPath: string;
	sessionSshRemoteConfig: WizardSessionSshRemoteConfig | undefined;
	/** False once the conversation has messages in it - nothing left to open. */
	enabled: boolean;
}

/**
 * Which opening turn this run deserves, or `null` for "none, ask the canned
 * question".
 *
 * The folder read is async and the answer decides whether the user sees a
 * question or a typing indicator, so `null` is also the answer WHILE the read
 * is in flight. The caller only fires once, on the first non-null value.
 */
export function useWizardOpeningKind({
	existingDocsChoice,
	directoryPath,
	sessionSshRemoteConfig,
	enabled,
}: UseWizardOpeningKindParams): WizardOpeningKind | null {
	const [openingKind, setOpeningKind] = useState<WizardOpeningKind | null>(null);

	useEffect(() => {
		if (!enabled) return;

		if (existingDocsChoice === 'continue') {
			setOpeningKind('existing-docs');
			return;
		}

		let cancelled = false;
		const sshRemoteId = getWizardSshRemoteId(sessionSshRemoteConfig);

		void projectHasFiles(directoryPath, sshRemoteId).then((hasFiles) => {
			if (!cancelled && hasFiles) {
				setOpeningKind('survey');
			}
		});

		return () => {
			cancelled = true;
		};
	}, [directoryPath, enabled, existingDocsChoice, sessionSshRemoteConfig]);

	return openingKind;
}
