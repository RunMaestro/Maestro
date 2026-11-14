import { useEffect, useMemo, useState } from 'react';
import { Waypoints } from 'lucide-react';
import { LOCAL_MODEL_TASKS } from '../../../../../shared/local-models/tasks';
import {
	formatModelMapSlotSpec,
	MODEL_MAP_ROLE_DESCRIPTIONS,
	MODEL_MAP_ROLE_LABELS,
	MODEL_MAP_ROLES,
	modelMapSlotProblem,
	parseModelMapSlotSpec,
	SESSION_PROVIDER_SLOT,
	tasksInheritingModelMapRole,
	withModelMapSlot,
	type ModelMapRole,
	type ModelMapSlot,
} from '../../../../../shared/local-models/model-map';
import type { LocalModelEndpointsState, LocalModelsState } from '../../../../hooks/localModels';
import { useSettingsStore } from '../../../../stores/settingsStore';
import type { Theme } from '../../../../types';
import { SettingsSectionHeading } from '../../SettingsSectionHeading';
import { SectionCard } from '../DisplayTab/components/SectionCard';
import { AssignmentOptionElements } from './AssignmentOptionElements';
import { buildModelMapSlotOptionGroups } from './assignmentOptions';

export interface ModelMapSettingsProps {
	theme: Theme;
	models: LocalModelsState;
	endpoints: LocalModelEndpointsState;
}

interface DetectedProviders {
	agents: { id: string; name: string }[];
	loaded: boolean;
	failed: boolean;
}

/**
 * The installed provider agents a slot can pick. The tab mounts only while it
 * is the one on screen, so this runs when the user opens it, not at app start.
 */
function useDetectedProviders(): DetectedProviders {
	const [state, setState] = useState<DetectedProviders>({
		agents: [],
		loaded: false,
		failed: false,
	});
	useEffect(() => {
		let cancelled = false;
		window.maestro.agents
			.detect()
			.then((agents) => {
				if (cancelled) return;
				setState({
					agents: agents
						.filter((a) => a.available && !a.hidden && a.id !== 'terminal')
						.map((a) => ({ id: a.id, name: a.name })),
					loaded: true,
					failed: false,
				});
			})
			.catch(() => {
				// Detection failing must not hide a stored provider: the select
				// would fall back to its first option and read "Session provider"
				// while tasks kept routing to the stored agent. Record the failure
				// so the value stays visible, just unverified.
				if (!cancelled) setState((prev) => ({ ...prev, failed: true }));
			});
		return () => {
			cancelled = true;
		};
	}, []);
	return state;
}

/**
 * The Model Map: the Agent model and the Housekeeping model, the two models a
 * System Two task can point at instead of naming one of its own. Each slot is
 * a provider agent, an installed text model, or an endpoint model. The same map
 * `maestro-cli models map` reads and writes.
 */
export function ModelMapSettings({ theme, models, endpoints }: ModelMapSettingsProps) {
	const modelMap = useSettingsStore((s) => s.modelMap);
	const setModelMap = useSettingsStore((s) => s.setModelMap);
	const assignments = useSettingsStore((s) => s.localModelAssignments);
	const providers = useDetectedProviders();

	return (
		<div data-setting-id="local-models-model-map">
			<SettingsSectionHeading
				icon={Waypoints}
				description="The two models the tasks below can point at. A task set to Agent model or Housekeeping model follows the choice here; any task can also pick a model of its own."
			>
				Model Map
			</SettingsSectionHeading>
			<SectionCard theme={theme}>
				{MODEL_MAP_ROLES.map((role) => (
					<ModelMapSlotField
						key={role}
						theme={theme}
						role={role}
						slot={modelMap[role]}
						onChange={(slot) => setModelMap(withModelMapSlot(modelMap, role, slot))}
						providers={providers}
						models={models}
						endpoints={endpoints}
						usedBy={tasksInheritingModelMapRole(assignments, role).map(
							(taskId) => LOCAL_MODEL_TASKS[taskId].label
						)}
					/>
				))}
				<p className="text-xs opacity-70">
					Context grooming and transfer need tools, so they use the Housekeeping model only while it
					is a provider, and the session provider otherwise.
				</p>
			</SectionCard>
		</div>
	);
}

interface ModelMapSlotFieldProps {
	theme: Theme;
	role: ModelMapRole;
	slot: ModelMapSlot;
	onChange: (slot: ModelMapSlot) => void;
	providers: DetectedProviders;
	models: LocalModelsState;
	endpoints: LocalModelEndpointsState;
	usedBy: string[];
}

function ModelMapSlotField({
	theme,
	role,
	slot,
	onChange,
	providers,
	models,
	endpoints,
	usedBy,
}: ModelMapSlotFieldProps) {
	const [problem, setProblem] = useState<string | null>(null);
	const groups = useMemo(
		() =>
			buildModelMapSlotOptionGroups(role, slot, {
				listings: models.listings,
				endpoints: endpoints.endpoints,
				endpointModels: endpoints.models,
			}),
		[role, slot, models.listings, endpoints.endpoints, endpoints.models]
	);
	const agentId = slot.type === 'provider' ? slot.agentId : undefined;
	// The provider option's value drops the model override, so the select still
	// matches an option while the override is set below it.
	const selected =
		slot.type === 'provider'
			? formatModelMapSlotSpec({ type: 'provider', agentId })
			: formatModelMapSlotSpec(slot);

	// A stored agent that matches no option would make the <select> render its
	// FIRST option ("Session provider") while tasks route to the stored agent.
	// Two causes, two messages: detection succeeded and the agent is gone, or
	// detection failed and nothing is known.
	const known = providers.agents.some((agent) => agent.id === agentId);
	const missingAgentId = providers.loaded && agentId && !known ? agentId : null;
	const unverifiedAgentId = providers.failed && agentId && !known ? agentId : null;
	const unmatchedAgentId = missingAgentId ?? unverifiedAgentId;

	function choose(spec: string) {
		setProblem(null);
		const next = parseModelMapSlotSpec(spec);
		const invalid = next ? modelMapSlotProblem(next) : `"${spec}" is not a model choice.`;
		if (!next || invalid) {
			setProblem(invalid);
			return;
		}
		onChange(next);
	}

	const selectId = `model-map-${role}-select`;
	const label = MODEL_MAP_ROLE_LABELS[role];
	return (
		<div className="space-y-1" data-testid={`model-map-${role}`}>
			<label className="text-sm block" style={{ color: theme.colors.textMain }} htmlFor={selectId}>
				{label}
			</label>
			<p className="text-xs opacity-70">{MODEL_MAP_ROLE_DESCRIPTIONS[role]}</p>
			<select
				id={selectId}
				value={selected}
				onChange={(e) => choose(e.target.value)}
				className="w-full p-2 rounded border bg-transparent outline-none text-sm"
				style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
			>
				<option value={formatModelMapSlotSpec(SESSION_PROVIDER_SLOT)}>
					Session provider (same as the tab)
				</option>
				<optgroup label="Providers">
					{providers.agents.map((agent) => (
						<option key={agent.id} value={`provider:${agent.id}`}>
							{agent.name}
						</option>
					))}
					{unmatchedAgentId && (
						<option value={`provider:${unmatchedAgentId}`}>
							{unmatchedAgentId} {missingAgentId ? '(not installed)' : '(unverified)'}
						</option>
					)}
				</optgroup>
				<AssignmentOptionElements groups={groups} />
			</select>
			{missingAgentId && (
				<div className="text-xs" style={{ color: theme.colors.warning }}>
					This agent is no longer available. Tasks on the {label} will fail until you pick another.
				</div>
			)}
			{!missingAgentId && unverifiedAgentId && (
				<div className="text-xs" style={{ color: theme.colors.warning }}>
					Could not check installed agents. This selection is still in use.
				</div>
			)}
			{problem && (
				<p className="text-xs" style={{ color: theme.colors.error }}>
					{problem}
				</p>
			)}
			{slot.type === 'provider' && agentId && (
				<input
					aria-label={`${label} model override`}
					type="text"
					value={slot.modelId ?? ''}
					onChange={(e) =>
						onChange({
							type: 'provider',
							agentId,
							...(e.target.value.trim() ? { modelId: e.target.value } : {}),
						})
					}
					placeholder="Model override, e.g. haiku or gpt-4o-mini (empty for the agent default)"
					className="w-full p-2 rounded border bg-transparent outline-none text-sm"
					style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
				/>
			)}
			<p className="text-xs opacity-70" data-testid={`model-map-${role}-used-by`}>
				{usedBy.length > 0 ? `Used by: ${usedBy.join(', ')}` : 'No task uses it yet.'}
			</p>
		</div>
	);
}
