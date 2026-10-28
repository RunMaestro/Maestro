import { useEffect, useMemo, useState } from 'react';
import { Bot } from 'lucide-react';
import {
	formatLocalModelAssignmentSpec,
	LOCAL_MODEL_TASKS,
	localModelAssignmentProblem,
	parseLocalModelAssignmentSpec,
	parseUtilitySource,
	UTILITY_AGENT_ASSIGNMENT,
} from '../../../../../shared/local-models/tasks';
import type { LocalModelEndpointsState, LocalModelsState } from '../../../../hooks/localModels';
import { useSettingsStore } from '../../../../stores/settingsStore';
import type { Theme } from '../../../../types';
import { SettingsSectionHeading } from '../../SettingsSectionHeading';
import { SectionCard } from '../DisplayTab/components/SectionCard';
import { AssignmentOptionElements } from './AssignmentOptionElements';
import { buildAssignmentOptionGroups } from './assignmentOptions';

export interface UtilityAgentSettingsProps {
	theme: Theme;
	models: LocalModelsState;
	endpoints: LocalModelEndpointsState;
}

/**
 * One shared source for inherited text tasks. Local and endpoint choices use
 * the same assignment picker as task overrides. Provider choices retain the
 * existing utilityAgentId / utilityModelId configuration.
 */
export function UtilityAgentSettings({ theme, models, endpoints }: UtilityAgentSettingsProps) {
	const utilitySource = useSettingsStore((s) => s.utilitySource);
	const setUtilitySource = useSettingsStore((s) => s.setUtilitySource);
	const utilityAgentId = useSettingsStore((s) => s.utilityAgentId);
	const setUtilityAgentId = useSettingsStore((s) => s.setUtilityAgentId);
	const utilityModelId = useSettingsStore((s) => s.utilityModelId);
	const setUtilityModelId = useSettingsStore((s) => s.setUtilityModelId);
	const [availableAgents, setAvailableAgents] = useState<{ id: string; name: string }[]>([]);
	const [agentsLoaded, setAgentsLoaded] = useState(false);
	const [detectionFailed, setDetectionFailed] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	const source = parseUtilitySource(utilitySource);
	const providerSource = source.type === 'utility-agent';
	const groups = useMemo(
		() =>
			buildAssignmentOptionGroups(LOCAL_MODEL_TASKS['tab-naming'], source, {
				listings: models.listings,
				endpoints: endpoints.endpoints,
				endpointModels: endpoints.models,
			})
				.map((group) => ({
					...group,
					options: group.options.filter(
						(option) => option.value !== 'off' && option.value !== 'utility-agent'
					),
				}))
				.filter((group) => group.options.length > 0),
		[source, models.listings, endpoints.endpoints, endpoints.models]
	);
	const selected = providerSource
		? utilityAgentId
			? `provider:${utilityAgentId}`
			: 'utility-agent'
		: formatLocalModelAssignmentSpec(source);

	function choose(spec: string) {
		setProblem(null);
		if (spec === 'utility-agent' || spec.startsWith('provider:')) {
			setUtilityAgentId(spec === 'utility-agent' ? null : spec.slice('provider:'.length));
			setUtilitySource(UTILITY_AGENT_ASSIGNMENT);
			return;
		}
		const assignment = parseLocalModelAssignmentSpec(spec);
		const invalid = localModelAssignmentProblem('tab-naming', assignment);
		if (invalid) {
			setProblem(invalid);
			return;
		}
		setUtilitySource(parseUtilitySource(assignment));
	}

	// Detect available agents for the dropdown. The tab mounts only while it is
	// the one on screen, so this runs when the user opens it, not at app start.
	useEffect(() => {
		if (agentsLoaded) return;
		let cancelled = false;
		window.maestro.agents
			.detect()
			.then((agents) => {
				if (cancelled) return;
				setAvailableAgents(
					agents
						.filter((a) => a.available && !a.hidden && a.id !== 'terminal')
						.map((a) => ({ id: a.id, name: a.name }))
				);
				setAgentsLoaded(true);
			})
			.catch(() => {
				// Detection failing must not silently hide a persisted selection: the
				// dropdown would fall back to its first option and read "Default" while
				// auxiliary tasks kept routing to the stored agent. Record the failure
				// so the value stays visible, just unverified.
				if (!cancelled) setDetectionFailed(true);
			});
		return () => {
			cancelled = true;
		};
	}, [agentsLoaded]);

	// A persisted id that matches no <option> makes the select render as its
	// FIRST option, so the UI would read "Default" while the stored agent is what
	// actually runs. Two different causes, two different messages:
	//  - detection succeeded and the agent is genuinely gone -> it is missing.
	//  - detection failed -> we simply do not know, so do not claim it is missing.
	const selectionKnown = availableAgents.some((a) => a.id === utilityAgentId);
	const missingAgentId = agentsLoaded && utilityAgentId && !selectionKnown ? utilityAgentId : null;
	const unverifiedAgentId =
		detectionFailed && utilityAgentId && !selectionKnown ? utilityAgentId : null;
	const unmatchedAgentId = missingAgentId ?? unverifiedAgentId;

	return (
		<div data-setting-id="local-models-utility-agent">
			<SettingsSectionHeading
				icon={Bot}
				description="Choose the default for tasks set to Utility source below. Use a provider, an installed text model, or an endpoint. Each task can override this choice."
			>
				Utility source
			</SettingsSectionHeading>
			<SectionCard theme={theme}>
				<div>
					<label
						className="text-sm block mb-1"
						style={{ color: theme.colors.textMain }}
						htmlFor="utility-agent-select"
					>
						Source
					</label>
					<select
						id="utility-agent-select"
						value={selected}
						onChange={(e) => choose(e.target.value)}
						className="w-full p-2 rounded border bg-transparent outline-none text-sm"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					>
						<option value="utility-agent">Default (same as session)</option>
						<optgroup label="Providers">
							{availableAgents.map((agent) => (
								<option key={agent.id} value={`provider:${agent.id}`}>
									{agent.name}
								</option>
							))}
							{/*
							 * A persisted id that matches no option makes the <select> render
							 * as its FIRST option - so the UI would read "Default" while
							 * auxiliary tasks kept routing to the stored agent. Surface it
							 * either way, so the setting the user is running is the setting
							 * they can see.
							 */}
							{unmatchedAgentId && (
								<option value={`provider:${unmatchedAgentId}`}>
									{unmatchedAgentId} {missingAgentId ? '(not installed)' : '(unverified)'}
								</option>
							)}
						</optgroup>
						<AssignmentOptionElements groups={groups} />
					</select>
					{providerSource && missingAgentId && (
						<div className="text-xs mt-1" style={{ color: theme.colors.warning }}>
							This agent is no longer available. Auxiliary tasks will fail until you pick another
							agent or return to Default.
						</div>
					)}
					{providerSource && !missingAgentId && unverifiedAgentId && (
						<div className="text-xs mt-1" style={{ color: theme.colors.warning }}>
							Could not check installed agents. This selection is still in use.
						</div>
					)}
				</div>
				{problem && (
					<p className="text-xs" style={{ color: theme.colors.error }}>
						{problem}
					</p>
				)}
				{!providerSource && (
					<p className="text-xs opacity-70">
						Context grooming and transfer need tools, so they keep using the session provider.
					</p>
				)}
				{providerSource && utilityAgentId && (
					<div>
						<label
							className="text-sm block mb-1"
							style={{ color: theme.colors.textMain }}
							htmlFor="utility-model-input"
						>
							Model override
						</label>
						<input
							id="utility-model-input"
							type="text"
							value={utilityModelId || ''}
							onChange={(e) => setUtilityModelId(e.target.value || null)}
							placeholder="e.g., haiku, gpt-4o-mini (leave empty for agent default)"
							className="w-full p-2 rounded border bg-transparent outline-none text-sm"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
						/>
					</div>
				)}
			</SectionCard>
		</div>
	);
}
