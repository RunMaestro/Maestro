/**
 * The one-time playbook telemetry consent (PROPOSAL D17): the first time a run
 * of an official Exchange playbook finishes while telemetry is off and the
 * question was never asked, the completion modal leads with a step that shows
 * the literal `run_completed` event and asks once.
 *
 * Consent is an affirmative act, so `playbookTelemetryEnabled` stays false
 * until the user picks "Share anonymous usage". Whether the step was shown
 * lives in `onboardingStats.playbookTelemetryPromptShownAt`: stamped when the
 * step appears, so dismissing it without an answer also ends the asking (the
 * setting keeps its default, off). Settings > General > Privacy changes the
 * answer later.
 */

import type { PlaybookTelemetryRunCompletedEvent } from '../../shared/playbookTelemetry';
import { useSettingsStore } from '../stores/settingsStore';

/**
 * Whether a finished run should open with the consent step: it produced a
 * telemetry event (an official playbook), the user did not stop it, telemetry
 * is off, and the step was never shown before.
 */
export function shouldOfferPlaybookTelemetryConsent(
	event: PlaybookTelemetryRunCompletedEvent | undefined
): boolean {
	if (!event || event.status === 'stopped') return false;
	const { playbookTelemetryEnabled, onboardingStats } = useSettingsStore.getState();
	if (playbookTelemetryEnabled) return false;
	return !(onboardingStats.playbookTelemetryPromptShownAt > 0);
}

/** Record that the consent step appeared, so it never appears again. */
export function notePlaybookTelemetryConsentShown(): void {
	useSettingsStore.getState().recordPlaybookTelemetryPromptShown();
}

/** The user's answer: "Share anonymous usage" (true) or "No thanks" (false). */
export function answerPlaybookTelemetryConsent(share: boolean): void {
	const settings = useSettingsStore.getState();
	settings.setPlaybookTelemetryEnabled(share);
	settings.recordPlaybookTelemetryPromptShown();
}
