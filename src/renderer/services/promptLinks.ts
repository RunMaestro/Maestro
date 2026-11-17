/**
 * Renderer entry points for Prompt Links (`maestro://run/<token>`).
 *
 * The hotkey, the command palette, the hamburger menu and an AI tab's menu all
 * open the one Prompt Links window through `openPromptLinks`, so they agree on
 * the gate and on which agent the create form starts on. The links themselves
 * live in the main process (`src/main/prompt-links/`).
 */

import { useModalStore, type PromptLinksModalData } from '../stores/modalStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useSessionStore } from '../stores/sessionStore';
import { notifyToast } from '../stores/notificationStore';
import { isWebDesktop } from '../utils/runtimeContext';

/**
 * Whether Prompt Links exists on THIS surface. Off when the Encore Feature is
 * off, and always off in the web interface: the bridge refuses every
 * `promptLinks:*` channel, so a browser could only show a window that fails.
 */
export function promptLinksAvailable(enabled: boolean | undefined): boolean {
	return enabled === true && !isWebDesktop();
}

export function isPromptLinksEnabled(): boolean {
	return promptLinksAvailable(useSettingsStore.getState().encoreFeatures.promptLinks);
}

/**
 * Open the Prompt Links window. `data` prefills the create form; without an
 * agent it starts on the active one. Does nothing while the feature is off, so
 * a stale binding or palette entry can never surface it.
 */
export function openPromptLinks(data: PromptLinksModalData = {}): void {
	if (!isPromptLinksEnabled()) return;
	const agentId = data.agentId ?? (useSessionStore.getState().activeSessionId || undefined);
	useModalStore.getState().openModal('promptLinks', {
		...data,
		...(agentId ? { agentId } : {}),
	});
}

/**
 * A `maestro://run` link clicked INSIDE Maestro (agent output, a markdown
 * preview) does not run. Links fire from outside the app, through the OS, where
 * the click is the user's; in a transcript the link may have been written by
 * the very agent it would prompt. Say so rather than doing nothing silently.
 */
export function explainInAppPromptLinkClick(): void {
	notifyToast({
		color: 'yellow',
		title: 'Prompt links run from outside Maestro',
		message:
			'Open this link from a calendar, a browser, a note, or `open` in a terminal. Clicking it inside Maestro does nothing, so a link in an agent reply cannot run by accident.',
	});
}
