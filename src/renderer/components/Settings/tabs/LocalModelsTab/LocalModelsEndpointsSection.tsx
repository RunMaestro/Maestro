/**
 * LocalModelsEndpointsSection - the Endpoints section of the Models tab.
 *
 * The user's configured model servers (Ollama, LM Studio, any OpenAI-compatible
 * URL), each with its kind, base URL, an enabled switch, the models it serves,
 * and Test / Edit / Remove. All state and every edit come from
 * `useLocalModelEndpoints`, which writes through the shared list helpers.
 *
 * "Detect local servers" is an explicit click and probes loopback only. A
 * server it finds is an OFFER with its own Add button, never added on its own:
 * a server listening on a port is not consent to send it prompts.
 *
 * Removing an endpoint a task is assigned to warns first and names those
 * tasks, the same inline confirmation the Models section uses.
 */

import { useCallback, useState } from 'react';
import { Loader2, Pencil, Plug, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';

import type { DetectedEndpoint } from '../../../../../main/local-models/endpoint-client';
import {
	LOCAL_MODEL_ENDPOINT_KIND_LABELS,
	type LocalModelEndpoint,
} from '../../../../../shared/local-models/endpoints';
import { tasksUsingEndpoint } from '../../../../../shared/local-models/tasks';
import { formatSize } from '../../../../../shared/formatters';
import type { EndpointModelsState, LocalModelEndpointsState } from '../../../../hooks/localModels';
import { useSettingsStore } from '../../../../stores/settingsStore';
import type { Theme } from '../../../../types';
import { generateId } from '../../../../utils/ids';
import { HeaderActionButton } from '../../../ui/HeaderActionButton';
import { MiniBadge } from '../../../ui/MiniBadge';
import { ToggleSwitch } from '../../../ui/ToggleSwitch';
import { SectionCard } from '../DisplayTab/components/SectionCard';
import { EndpointTestVerdictLine } from './EndpointTestVerdictLine';
import { LocalModelEndpointForm } from './LocalModelEndpointForm';
import { RemoveInUseWarning } from './RemoveInUseWarning';

export interface LocalModelsEndpointsSectionProps {
	theme: Theme;
	/** The tab's one `useLocalModelEndpoints()` instance, shared with Assignments. */
	state: LocalModelEndpointsState;
}

/** Which form is open: the add form, or the edit form of one endpoint. */
type OpenForm = { mode: 'add' } | { mode: 'edit'; id: string } | null;

export function LocalModelsEndpointsSection({ theme, state }: LocalModelsEndpointsSectionProps) {
	const assignments = useSettingsStore((s) => s.localModelAssignments);
	const utilitySource = useSettingsStore((s) => s.utilitySource);
	const [form, setForm] = useState<OpenForm>(null);
	const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null);
	const [offerError, setOfferError] = useState<string | null>(null);

	const remove = useCallback(
		(id: string) => {
			setConfirmingRemove(null);
			if (form?.mode === 'edit' && form.id === id) setForm(null);
			state.remove(id);
		},
		[form, state]
	);

	const handleRemove = useCallback(
		(id: string) => {
			if (tasksUsingEndpoint(assignments, id, utilitySource).length > 0) {
				setConfirmingRemove(id);
				return;
			}
			remove(id);
		},
		[assignments, remove, utilitySource]
	);

	const addOffer = useCallback(
		(offer: DetectedEndpoint) => {
			const change = state.add(
				{
					id: generateId(),
					name: offer.name,
					kind: offer.kind,
					baseUrl: offer.baseUrl,
					enabled: true,
				},
				offer.models
			);
			setOfferError(change.ok ? null : change.message);
		},
		[state]
	);

	return (
		<div className="select-none space-y-3" data-testid="local-models-endpoints-section">
			<SectionCard theme={theme}>
				<div className="flex flex-wrap items-center gap-2">
					<HeaderActionButton
						theme={theme}
						variant="ghost"
						onClick={() => void state.detect()}
						disabled={state.detecting}
						icon={state.detecting ? <Loader2 className="animate-spin" /> : <Search />}
						testId="local-models-detect-endpoints"
					>
						Detect local servers
					</HeaderActionButton>
					<HeaderActionButton
						theme={theme}
						onClick={() => setForm({ mode: 'add' })}
						disabled={form?.mode === 'add'}
						icon={<Plus />}
						testId="local-models-add-endpoint"
					>
						Add endpoint
					</HeaderActionButton>
				</div>

				{state.detected !== null && (
					<DetectedOffers theme={theme} offers={state.detected} onAdd={addOffer} />
				)}
				{offerError && (
					<p className="text-xs select-text" style={{ color: theme.colors.error }}>
						{offerError}
					</p>
				)}

				{state.endpoints.length === 0 && form?.mode !== 'add' && (
					<p className="text-xs opacity-70" data-testid="local-models-endpoints-empty">
						No endpoints configured. Detect a server running on this machine, or add one by URL.
					</p>
				)}
			</SectionCard>

			{form?.mode === 'add' && (
				<SectionCard theme={theme}>
					<LocalModelEndpointForm
						theme={theme}
						onSave={(endpoint) => {
							const change = state.add(endpoint);
							if (change.ok) setForm(null);
							return change;
						}}
						onCancel={() => setForm(null)}
						onTest={state.testDraft}
					/>
				</SectionCard>
			)}

			{state.endpoints.map((endpoint) => (
				<SectionCard key={endpoint.id} theme={theme}>
					{form?.mode === 'edit' && form.id === endpoint.id ? (
						<LocalModelEndpointForm
							theme={theme}
							initial={endpoint}
							onSave={(next) => {
								const change = state.update(endpoint.id, next);
								if (change.ok) setForm(null);
								return change;
							}}
							onCancel={() => setForm(null)}
							onTest={state.testDraft}
						/>
					) : (
						<EndpointRow
							theme={theme}
							endpoint={endpoint}
							models={state.models[endpoint.id]}
							onToggle={(enabled) => state.setEnabled(endpoint.id, enabled)}
							onRefresh={() => void state.refreshModels(endpoint.id)}
							onTest={() => void state.test(endpoint.id)}
							onEdit={() => setForm({ mode: 'edit', id: endpoint.id })}
							onRemove={() => handleRemove(endpoint.id)}
						/>
					)}
					{state.tests[endpoint.id] && (
						<EndpointTestVerdictLine
							theme={theme}
							state={state.tests[endpoint.id]}
							testId={`local-model-endpoint-verdict-${endpoint.id}`}
						/>
					)}
					{confirmingRemove === endpoint.id && (
						<RemoveInUseWarning
							theme={theme}
							subjectName={endpoint.name}
							taskLabels={tasksUsingEndpoint(assignments, endpoint.id, utilitySource).map(
								(task) => task.label
							)}
							recovery="add it again"
							onConfirm={() => remove(endpoint.id)}
							onKeep={() => setConfirmingRemove(null)}
							testId="local-model-endpoint-remove-warning"
						/>
					)}
				</SectionCard>
			))}
		</div>
	);
}

function DetectedOffers({
	theme,
	offers,
	onAdd,
}: {
	theme: Theme;
	offers: DetectedEndpoint[];
	onAdd: (offer: DetectedEndpoint) => void;
}) {
	if (offers.length === 0) {
		return (
			<p className="text-xs opacity-70" data-testid="local-models-detect-none">
				No new Ollama or LM Studio server is running on this machine.
			</p>
		);
	}
	return (
		<div className="space-y-2" data-testid="local-models-detected">
			{offers.map((offer) => (
				<div
					key={offer.baseUrl}
					className="flex items-center gap-2 text-xs"
					data-testid={`local-models-detected-${offer.kind}`}
				>
					<span className="font-medium" style={{ color: theme.colors.textMain }}>
						{offer.name}
					</span>
					<span className="font-mono opacity-70 truncate select-text">{offer.baseUrl}</span>
					<span className="opacity-70 shrink-0">{modelCountLabel(offer.models.length)}</span>
					<button
						type="button"
						onClick={() => onAdd(offer)}
						className="ml-auto px-2 py-1 rounded border text-xs flex items-center gap-1.5 shrink-0"
						style={{ borderColor: theme.colors.accent, color: theme.colors.accent }}
						data-testid={`local-models-detected-add-${offer.kind}`}
					>
						<Plus className="w-3 h-3" />
						Add
					</button>
				</div>
			))}
		</div>
	);
}

function EndpointRow({
	theme,
	endpoint,
	models,
	onToggle,
	onRefresh,
	onTest,
	onEdit,
	onRemove,
}: {
	theme: Theme;
	endpoint: LocalModelEndpoint;
	models: EndpointModelsState | undefined;
	onToggle: (enabled: boolean) => void;
	onRefresh: () => void;
	onTest: () => void;
	onEdit: () => void;
	onRemove: () => void;
}) {
	const buttonStyle = { borderColor: theme.colors.border, color: theme.colors.textMain };
	return (
		<div className="space-y-2" data-testid={`local-model-endpoint-${endpoint.id}`}>
			<div className="flex items-center gap-2">
				<span className="font-medium truncate" style={{ color: theme.colors.textMain }}>
					{endpoint.name}
				</span>
				<MiniBadge theme={theme} label={LOCAL_MODEL_ENDPOINT_KIND_LABELS[endpoint.kind]} />
				<div className="ml-auto">
					<ToggleSwitch
						theme={theme}
						checked={endpoint.enabled}
						onChange={onToggle}
						size="sm"
						ariaLabel={`${endpoint.enabled ? 'Disable' : 'Enable'} ${endpoint.name}`}
					/>
				</div>
			</div>
			<div className="text-xs font-mono opacity-70 truncate select-text">{endpoint.baseUrl}</div>
			{endpoint.apiKeyEnvVar && (
				<div className="text-xs opacity-70">
					API key from <span className="font-mono select-text">{endpoint.apiKeyEnvVar}</span>
				</div>
			)}
			<EndpointModelList theme={theme} enabled={endpoint.enabled} models={models} />
			<div className="flex flex-wrap gap-2">
				<button
					type="button"
					onClick={onTest}
					className="px-2 py-1 rounded border text-xs flex items-center gap-1.5"
					style={buttonStyle}
					data-testid={`local-model-endpoint-test-${endpoint.id}`}
				>
					<Plug className="w-3 h-3" />
					Test
				</button>
				<button
					type="button"
					onClick={onRefresh}
					className="px-2 py-1 rounded border text-xs flex items-center gap-1.5"
					style={buttonStyle}
					title="List the models this server serves now"
				>
					<RefreshCw className="w-3 h-3" />
					Refresh models
				</button>
				<button
					type="button"
					onClick={onEdit}
					className="px-2 py-1 rounded border text-xs flex items-center gap-1.5"
					style={buttonStyle}
					data-testid={`local-model-endpoint-edit-${endpoint.id}`}
				>
					<Pencil className="w-3 h-3" />
					Edit
				</button>
				<button
					type="button"
					onClick={onRemove}
					className="px-2 py-1 rounded border text-xs flex items-center gap-1.5"
					style={{ borderColor: theme.colors.border, color: theme.colors.error }}
					data-testid={`local-model-endpoint-remove-${endpoint.id}`}
				>
					<Trash2 className="w-3 h-3" />
					Remove
				</button>
			</div>
		</div>
	);
}

function EndpointModelList({
	theme,
	enabled,
	models,
}: {
	theme: Theme;
	enabled: boolean;
	models: EndpointModelsState | undefined;
}) {
	if (!models) {
		return (
			<p className="text-xs opacity-70">
				{enabled ? 'Models not listed yet.' : 'Disabled. Maestro does not call it.'}
			</p>
		);
	}
	if ('status' in models) {
		return (
			<div className="flex items-center gap-1.5 text-xs opacity-70">
				<Loader2 className="w-3 h-3 animate-spin" />
				<span>Listing models...</span>
			</div>
		);
	}
	if (!models.ok) {
		return (
			<p className="text-xs select-text" style={{ color: theme.colors.error }}>
				{models.error.message}
			</p>
		);
	}
	if (models.models.length === 0) {
		return <p className="text-xs opacity-70">The server lists no models.</p>;
	}
	return (
		<div className="flex flex-wrap gap-1.5" data-testid="local-model-endpoint-models">
			{models.models.map((model) => (
				<span
					key={model.id}
					className="px-1.5 py-0.5 rounded text-xs font-mono select-text"
					style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textMain }}
				>
					{model.id}
					{model.sizeBytes !== undefined && (
						<span className="opacity-70"> {formatSize(model.sizeBytes)}</span>
					)}
				</span>
			))}
		</div>
	);
}

function modelCountLabel(count: number): string {
	return count === 1 ? '1 model' : `${count} models`;
}
