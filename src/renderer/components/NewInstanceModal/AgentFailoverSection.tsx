/**
 * AgentFailoverSection - Provider Failover editor for the agent edit dialog.
 *
 * Lets a user give an agent an ordered list of Anthropic-compatible backup
 * endpoints (local vLLM/Ollama, Z.AI, an enterprise proxy, or simply a second
 * account). When Agent Resilience would otherwise wait out the primary's reset
 * window, Maestro hands the turn to the next endpoint instead. See
 * `shared/providerFailover.ts` for the model and `stores/failoverStore.ts` for
 * the runtime.
 *
 * Styled to match AgentResilienceSection (uppercase heading + checkbox rows),
 * with each endpoint on a card that reuses the shared EnvVarsEditor.
 */

import React, { useCallback } from 'react';
import { Plus, Trash2, ChevronUp, ChevronDown, AlertTriangle } from 'lucide-react';

import { GhostIconButton } from '../ui/GhostIconButton';
import { EnvVarsEditor } from '../Settings/EnvVarsEditor';
import { generateId } from '../../utils/ids';
import {
	DEFAULT_RETURN_TO_PRIMARY_MINUTES,
	validateEndpoint,
	type FailoverConfig,
	type FailoverEndpoint,
} from '../../../shared/providerFailover';
import type { Theme } from '../../types';

interface AgentFailoverSectionProps {
	theme: Theme;
	config: FailoverConfig | undefined;
	onChange: (config: FailoverConfig | undefined) => void;
}

/** A fresh endpoint pre-seeded with the two vars every backup needs. */
function newEndpoint(index: number): FailoverEndpoint {
	return {
		id: generateId(),
		label: `Backup ${index + 1}`,
		env: { ANTHROPIC_BASE_URL: '', ANTHROPIC_AUTH_TOKEN: '' },
	};
}

export function AgentFailoverSection({
	theme,
	config,
	onChange,
}: AgentFailoverSectionProps): React.ReactElement {
	const endpoints = config?.endpoints ?? [];
	const enabled = !!config?.enabled;
	const returnMinutes = config?.returnToPrimaryMinutes ?? DEFAULT_RETURN_TO_PRIMARY_MINUTES;

	/**
	 * Emit the next config, collapsing "no endpoints and disarmed" back to
	 * `undefined` so an agent the user only poked at doesn't persist an empty
	 * failover block forever.
	 */
	const emit = useCallback(
		(next: Partial<FailoverConfig>) => {
			const merged: FailoverConfig = {
				endpoints,
				enabled,
				returnToPrimaryMinutes: returnMinutes,
				...next,
			};
			if (merged.endpoints.length === 0 && !merged.enabled) {
				onChange(undefined);
				return;
			}
			onChange(merged);
		},
		[endpoints, enabled, returnMinutes, onChange]
	);

	const updateEndpoint = useCallback(
		(id: string, patch: Partial<FailoverEndpoint>) => {
			emit({ endpoints: endpoints.map((e) => (e.id === id ? { ...e, ...patch } : e)) });
		},
		[endpoints, emit]
	);

	const removeEndpoint = useCallback(
		(id: string) => {
			const remaining = endpoints.filter((e) => e.id !== id);
			// Disarm when the last endpoint goes: an armed config with nothing to fail
			// over to is a trap that reads as protection but silently does nothing.
			emit({ endpoints: remaining, enabled: remaining.length > 0 && enabled });
		},
		[endpoints, enabled, emit]
	);

	/** Move an endpoint up or down; order IS the failover priority. */
	const moveEndpoint = useCallback(
		(index: number, delta: number) => {
			const target = index + delta;
			if (target < 0 || target >= endpoints.length) return;
			const next = [...endpoints];
			[next[index], next[target]] = [next[target], next[index]];
			emit({ endpoints: next });
		},
		[endpoints, emit]
	);

	return (
		<div>
			<div
				className="block text-xs font-bold opacity-70 uppercase mb-2"
				style={{ color: theme.colors.textMain }}
			>
				Provider Failover
			</div>
			<p className="text-xs mb-2" style={{ color: theme.colors.textDim }}>
				Anthropic-compatible backup endpoints to hand off to when the primary hits a rate limit or
				runs out of quota, instead of waiting for the reset window. Tried in order. Requires Agent
				Resilience to be on.
			</p>

			{endpoints.length > 0 && (
				<label
					className="flex items-start gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors hover:bg-white/5 mb-2"
					style={{ backgroundColor: theme.colors.bgActivity }}
				>
					<input
						type="checkbox"
						checked={enabled}
						onChange={(e) => emit({ enabled: e.target.checked })}
						className="mt-0.5 accent-current"
						style={{ accentColor: theme.colors.accent }}
						aria-label="Enable provider failover"
					/>
					<div className="flex flex-col min-w-0">
						<span className="text-xs font-medium" style={{ color: theme.colors.textMain }}>
							Fail over to backup endpoints
						</span>
						<span className="text-2xs" style={{ color: theme.colors.textDim }}>
							Off by default. Your prompts go to a different provider while a backup is live.
						</span>
					</div>
				</label>
			)}

			<div className="space-y-3">
				{endpoints.map((endpoint, index) => {
					const problem = validateEndpoint(endpoint);
					return (
						<div
							key={endpoint.id}
							className="rounded p-2 space-y-2"
							style={{ backgroundColor: theme.colors.bgActivity }}
						>
							<div className="flex items-center gap-2">
								<span
									className="text-2xs font-mono px-1.5 py-0.5 rounded shrink-0"
									style={{ backgroundColor: theme.colors.bgMain, color: theme.colors.textDim }}
									title="Failover order"
								>
									{index + 1}
								</span>
								<input
									type="text"
									value={endpoint.label}
									onChange={(e) => updateEndpoint(endpoint.id, { label: e.target.value })}
									placeholder="Endpoint name"
									className="flex-1 min-w-0 px-2 py-1 text-xs rounded outline-none"
									style={{
										backgroundColor: theme.colors.bgMain,
										color: theme.colors.textMain,
										border: `1px solid ${theme.colors.border}`,
									}}
									aria-label={`Endpoint ${index + 1} name`}
								/>
								<GhostIconButton
									color={theme.colors.textDim}
									onClick={() => moveEndpoint(index, -1)}
									disabled={index === 0}
									title="Move up (higher priority)"
									ariaLabel={`Move endpoint ${index + 1} up`}
								>
									<ChevronUp size={14} />
								</GhostIconButton>
								<GhostIconButton
									color={theme.colors.textDim}
									onClick={() => moveEndpoint(index, 1)}
									disabled={index === endpoints.length - 1}
									title="Move down (lower priority)"
									ariaLabel={`Move endpoint ${index + 1} down`}
								>
									<ChevronDown size={14} />
								</GhostIconButton>
								<GhostIconButton
									color={theme.colors.textDim}
									onClick={() => removeEndpoint(endpoint.id)}
									title="Remove endpoint"
									ariaLabel={`Remove endpoint ${index + 1}`}
								>
									<Trash2 size={14} />
								</GhostIconButton>
							</div>

							<input
								type="text"
								value={endpoint.model ?? ''}
								onChange={(e) => updateEndpoint(endpoint.id, { model: e.target.value })}
								placeholder="Model for this endpoint (optional, e.g. glm-4.6)"
								className="w-full px-2 py-1 text-xs rounded outline-none"
								style={{
									backgroundColor: theme.colors.bgMain,
									color: theme.colors.textMain,
									border: `1px solid ${theme.colors.border}`,
								}}
								aria-label={`Endpoint ${index + 1} model override`}
							/>

							<EnvVarsEditor
								envVars={endpoint.env}
								setEnvVars={(env) => updateEndpoint(endpoint.id, { env })}
								theme={theme}
								label={null}
								description={null}
							/>

							{problem && (
								<div
									className="flex items-start gap-1.5 text-2xs"
									style={{ color: theme.colors.warning ?? theme.colors.textDim }}
								>
									<AlertTriangle size={12} className="mt-px shrink-0" />
									<span>{problem}</span>
								</div>
							)}
						</div>
					);
				})}
			</div>

			<button
				type="button"
				onClick={() => emit({ endpoints: [...endpoints, newEndpoint(endpoints.length)] })}
				className="flex items-center gap-1.5 mt-2 px-2 py-1 text-xs rounded transition-colors hover:bg-white/5"
				style={{ color: theme.colors.accent }}
			>
				<Plus size={14} />
				Add backup endpoint
			</button>

			{endpoints.length > 0 && (
				<div className="flex items-center gap-2 mt-2">
					<label className="text-xs" style={{ color: theme.colors.textDim }}>
						Return to primary after
					</label>
					<input
						type="number"
						min={1}
						value={returnMinutes}
						onChange={(e) => {
							const parsed = Number(e.target.value);
							emit({
								returnToPrimaryMinutes: Number.isFinite(parsed) && parsed > 0 ? parsed : undefined,
							});
						}}
						className="w-20 px-2 py-1 text-xs rounded outline-none"
						style={{
							backgroundColor: theme.colors.bgMain,
							color: theme.colors.textMain,
							border: `1px solid ${theme.colors.border}`,
						}}
						aria-label="Minutes on a backup before probing the primary again"
					/>
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						minutes
					</span>
				</div>
			)}
		</div>
	);
}
