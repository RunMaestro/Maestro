/**
 * AgentResilienceSection — the two "Agent Resilience" auto-retry toggles shared
 * by the create (NewInstanceModal) and edit (EditAgentModal) agent dialogs.
 *
 * Both toggles default ON. See `resilienceEnabled` in shared/agentConstants and
 * the retry engine in stores/retryStore.
 */

import React from 'react';
import { ShieldCheck } from 'lucide-react';

import { ToggleSwitch } from '../ui/ToggleSwitch';
import type { Theme } from '../../types';

interface AgentResilienceSectionProps {
	theme: Theme;
	retryOnAvailabilityErrors: boolean;
	retryOnTokenExhaustion: boolean;
	onChangeAvailability: (value: boolean) => void;
	onChangeTokenExhaustion: (value: boolean) => void;
}

export function AgentResilienceSection({
	theme,
	retryOnAvailabilityErrors,
	retryOnTokenExhaustion,
	onChangeAvailability,
	onChangeTokenExhaustion,
}: AgentResilienceSectionProps): React.ReactElement {
	return (
		<div
			className="rounded-lg border p-3"
			style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
		>
			<div className="flex items-center gap-2 mb-1">
				<ShieldCheck className="w-4 h-4" style={{ color: theme.colors.accent }} />
				<span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					Agent Resilience
				</span>
			</div>
			<p className="text-xs mb-3" style={{ color: theme.colors.textDim }}>
				Automatically resend the last prompt when the provider fails, instead of making you re-send
				it. Applies to interactive turns and Auto Run batches.
			</p>

			<label className="flex items-start justify-between gap-3 py-1.5 cursor-pointer">
				<span className="min-w-0">
					<span className="block text-sm" style={{ color: theme.colors.textMain }}>
						Retry on availability errors
					</span>
					<span className="block text-xs" style={{ color: theme.colors.textDim }}>
						Overloaded / 529 / server errors. Backs off 30s → 30m, then keeps trying.
					</span>
				</span>
				<ToggleSwitch
					theme={theme}
					checked={retryOnAvailabilityErrors}
					onChange={onChangeAvailability}
					ariaLabel="Retry on availability errors"
				/>
			</label>

			<label className="flex items-start justify-between gap-3 py-1.5 cursor-pointer">
				<span className="min-w-0">
					<span className="block text-sm" style={{ color: theme.colors.textMain }}>
						Retry on token exhaustion
					</span>
					<span className="block text-xs" style={{ color: theme.colors.textDim }}>
						Plan/quota limit reached. Waits until reset (or hourly), then keeps trying.
					</span>
				</span>
				<ToggleSwitch
					theme={theme}
					checked={retryOnTokenExhaustion}
					onChange={onChangeTokenExhaustion}
					ariaLabel="Retry on token exhaustion"
				/>
			</label>
		</div>
	);
}
