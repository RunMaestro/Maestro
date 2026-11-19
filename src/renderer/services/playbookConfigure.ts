/**
 * Opening the Playbook Configure modal: a saved playbook's parameter form.
 *
 * Every way in goes through here: Opt+Cmd+Shift+P, "Configure Playbook" in
 * the command palette, the Left Bar hamburger menu, the sliders icon on a row
 * of the Auto Run playbook list, the Configure action on a paused run's
 * banner, and `maestro-cli open playbook-configure`. The CLI half of the
 * action itself is `maestro-cli playbook configure <id> --set NAME=VALUE`.
 */

import type { AgentErrorType } from '../../shared/types';
import type { PlaybookConfigureModalData } from '../stores/modalStore';
import { useModalStore } from '../stores/modalStore';
import { useSessionStore } from '../stores/sessionStore';

/**
 * Open the form. Without a `sessionId` it opens on the active agent; without
 * a `playbookId` it opens on a picker of that agent's playbooks.
 */
export function openPlaybookConfigure(data: PlaybookConfigureModalData = {}): void {
	const sessionId = data.sessionId ?? (useSessionStore.getState().activeSessionId || undefined);
	useModalStore.getState().openModal('playbookConfigure', {
		...data,
		...(sessionId ? { sessionId } : {}),
	});
}

export function closePlaybookConfigure(): void {
	useModalStore.getState().closeModal('playbookConfigure');
}

/**
 * Whether an Auto Run pause is about the playbook's parameters: a required
 * one has no answer, or a `[NAME]` token survived substitution. Configuring
 * the playbook is the fix, so the paused-run banner offers it.
 */
export function isPlaybookParamsPause(type: AgentErrorType): boolean {
	return type === 'missing_parameters' || type === 'parameter_substitution';
}
