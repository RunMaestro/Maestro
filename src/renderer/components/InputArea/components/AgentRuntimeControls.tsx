import { memo, useCallback } from 'react';
import type { AgentControl } from '../../../../shared/agent-runtime-features';
import { isRegisteredOmpControl } from '../../../../shared/omp-command-registry';
import type { Theme } from '../../../types';

interface AgentRuntimeControlsProps {
	sessionId: string;
	controls: AgentControl[] | null | undefined;
	theme: Theme;
	onSetControl?: (
		sessionId: string,
		controlId: string,
		value: string | boolean
	) => void | Promise<boolean>;
}

export const AgentRuntimeControls = memo(function AgentRuntimeControls({
	sessionId,
	controls,
	theme,
	onSetControl = (activeSessionId, controlId, value) =>
		window.maestro.process.setAgentControl(activeSessionId, controlId, value),
}: AgentRuntimeControlsProps) {
	const visibleControls = controls?.filter(
		(control) =>
			isRegisteredOmpControl(control.id) &&
			control.id.toLowerCase() !== 'model' &&
			control.label.toLowerCase() !== 'model' &&
			(control.kind === 'select' || control.kind === 'toggle' || control.kind === 'action')
	);
	const setControl = useCallback(
		(controlId: string, value: string | boolean) => {
			void onSetControl(sessionId, controlId, value);
		},
		[onSetControl, sessionId]
	);

	if (!visibleControls?.length) {
		return null;
	}

	return (
		<div
			className="flex min-w-0 flex-1 flex-wrap items-center gap-1"
			aria-label="Native runtime controls"
		>
			{visibleControls.map((control) => {
				if (control.kind === 'select') {
					const value = typeof control.value === 'string' ? control.value : '';
					return (
						<label
							key={control.id}
							className="flex items-center gap-1 text-[10px] whitespace-nowrap opacity-80 hover:opacity-100"
							style={{ color: theme.colors.textDim }}
						>
							<span>{control.label}</span>
							<select
								aria-label={control.label}
								value={value}
								onChange={(event) => setControl(control.id, event.target.value)}
								className="rounded-full border px-2 py-1 text-[10px] outline-none"
								style={{
									backgroundColor: `${theme.colors.accent}10`,
									borderColor: `${theme.colors.accent}25`,
									color: theme.colors.accent,
								}}
							>
								{control.options?.map((option) => (
									<option key={option.id} value={option.id}>
										{option.label}
									</option>
								))}
							</select>
						</label>
					);
				}

				if (control.kind === 'action') {
					return (
						<button
							key={control.id}
							type="button"
							onClick={() => setControl(control.id, true)}
							className="rounded-full border px-2 py-1 text-[10px] transition-all hover:opacity-100"
							style={{
								borderColor: theme.colors.border,
								color: theme.colors.textDim,
							}}
						>
							{control.label}
						</button>
					);
				}

				const enabled = control.value === true;
				return (
					<button
						key={control.id}
						type="button"
						aria-pressed={enabled}
						onClick={() => setControl(control.id, !enabled)}
						className={`rounded-full border px-2 py-1 text-[10px] transition-all ${
							enabled ? '' : 'opacity-60 hover:opacity-100'
						}`}
						style={{
							backgroundColor: enabled ? `${theme.colors.accent}25` : 'transparent',
							borderColor: enabled ? `${theme.colors.accent}50` : theme.colors.border,
							color: enabled ? theme.colors.accent : theme.colors.textDim,
						}}
					>
						{control.label}
					</button>
				);
			})}
		</div>
	);
});
