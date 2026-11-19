/**
 * PlaybookTelemetryConsentStep - the one-time "Share anonymous usage" ask on
 * the playbook completion modal (PROPOSAL D17).
 *
 * Shows the literal `run_completed` event this run produced, so the user sees
 * every field before agreeing to anything. The answer buttons live in the
 * modal footer; this is only the disclosure. Shown at most once
 * (`services/playbookTelemetryConsent`).
 */

import type { PlaybookTelemetryRunCompletedEvent } from '../../../shared/playbookTelemetry';
import type { Theme } from '../../types';

export interface PlaybookTelemetryConsentStepProps {
	theme: Theme;
	event: PlaybookTelemetryRunCompletedEvent;
}

export function PlaybookTelemetryConsentStep({ theme, event }: PlaybookTelemetryConsentStepProps) {
	return (
		<div className="flex flex-col gap-3" data-testid="playbook-telemetry-consent-step">
			<div className="text-sm font-semibold" style={{ color: theme.colors.textMain }}>
				Share anonymous playbook usage?
			</div>
			<p className="text-sm" style={{ color: theme.colors.textMain }}>
				When a run of an official Exchange playbook ends, Maestro can send one small event like this
				to runmaestro.ai, so the Exchange can show which playbooks are popular and which are broken.
				This is the exact event this run would have sent:
			</p>
			<pre
				className="text-xs font-mono whitespace-pre-wrap break-words rounded border p-3 select-text"
				style={{
					borderColor: theme.colors.border,
					backgroundColor: theme.colors.bgActivity,
					color: theme.colors.textMain,
				}}
				data-testid="playbook-telemetry-consent-payload"
			>
				{JSON.stringify(event, null, 2)}
			</pre>
			<p className="text-sm" style={{ color: theme.colors.textDim }}>
				Installs, run starts, and the task a failed run stopped on are sent the same way. Each batch
				carries a random installation id, the Maestro version, and the platform. Project paths,
				parameter values, agent names, and who you are are never sent. Only official Exchange
				playbooks are counted. You can change this later in Settings, General, Privacy.
			</p>
		</div>
	);
}
