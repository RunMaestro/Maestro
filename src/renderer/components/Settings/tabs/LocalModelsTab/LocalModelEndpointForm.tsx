/**
 * LocalModelEndpointForm - add or edit one model server.
 *
 * Validation is the shared `validateLocalModelEndpoint`, the same rules the
 * settings reader and the CLI apply, with every bad field marked at once. The
 * API key is never typed here: the form takes the NAME of a variable in
 * Settings -> Environment, offered through the shared `EnvVarKeyInput`, because
 * a key written into the endpoint record would leak through every settings
 * export (see `LocalModelEndpoint.apiKeyEnvVar`).
 *
 * Test works before Save, on the record as typed, so a user can find the right
 * URL without saving a wrong one first.
 */

import { useMemo, useState } from 'react';
import { Check, Plug, X } from 'lucide-react';

import {
	DEFAULT_ENDPOINT_BASE_URLS,
	LOCAL_MODEL_ENDPOINT_KINDS,
	LOCAL_MODEL_ENDPOINT_KIND_LABELS,
	validateLocalModelEndpoint,
	type LocalModelEndpoint,
	type LocalModelEndpointField,
	type LocalModelEndpointKind,
	type LocalModelEndpointListChange,
} from '../../../../../shared/local-models/endpoints';
import { useKnownEnvVarKeys } from '../../../../hooks/agent/useKnownEnvVarKeys';
import type { EndpointTestState, EndpointTestVerdict } from '../../../../hooks/localModels';
import type { Theme } from '../../../../types';
import { generateId } from '../../../../utils/ids';
import { EnvVarKeyInput } from '../../../shared/EnvVarKeyInput';
import { FormFieldLabel } from '../../../ui/FormFieldLabel';
import { FormInput } from '../../../ui/FormInput';
import { SegmentedControl } from '../../../ui/SegmentedControl';
import { EndpointTestVerdictLine } from './EndpointTestVerdictLine';

export interface LocalModelEndpointFormProps {
	theme: Theme;
	/** The record being edited. Omit to add a new endpoint. */
	initial?: LocalModelEndpoint;
	/** Persist the record; a refusal (duplicate server, ...) is shown in the form. */
	onSave: (endpoint: LocalModelEndpoint) => LocalModelEndpointListChange;
	onCancel: () => void;
	onTest: (endpoint: LocalModelEndpoint) => Promise<EndpointTestVerdict>;
}

const KIND_OPTIONS = LOCAL_MODEL_ENDPOINT_KINDS.map((kind) => ({
	value: kind,
	label: LOCAL_MODEL_ENDPOINT_KIND_LABELS[kind],
}));

const OPENAI_COMPATIBLE_PLACEHOLDER = 'https://llm.example.com/v1';

export function LocalModelEndpointForm({
	theme,
	initial,
	onSave,
	onCancel,
	onTest,
}: LocalModelEndpointFormProps) {
	const knownEnvVarKeys = useKnownEnvVarKeys();
	const [kind, setKind] = useState<LocalModelEndpointKind>(initial?.kind ?? 'ollama');
	const [name, setName] = useState(initial?.name ?? LOCAL_MODEL_ENDPOINT_KIND_LABELS.ollama);
	const [baseUrl, setBaseUrl] = useState(
		initial?.baseUrl ?? DEFAULT_ENDPOINT_BASE_URLS.ollama ?? ''
	);
	const [apiKeyEnvVar, setApiKeyEnvVar] = useState(initial?.apiKeyEnvVar ?? '');
	const [issues, setIssues] = useState<Partial<Record<LocalModelEndpointField, string>>>({});
	const [saveError, setSaveError] = useState<string | null>(null);
	const [testState, setTestState] = useState<EndpointTestState | null>(null);
	// Minted once, so a Test before Save and the saved record name one endpoint.
	const id = useMemo(() => initial?.id ?? generateId(), [initial?.id]);

	const draft = (): LocalModelEndpoint => ({
		id,
		name,
		kind,
		baseUrl,
		...(apiKeyEnvVar.trim() ? { apiKeyEnvVar } : {}),
		enabled: initial?.enabled ?? true,
	});

	/** Validate the draft, marking every bad field; the normalized record when valid. */
	const validated = (): LocalModelEndpoint | null => {
		const result = validateLocalModelEndpoint(draft());
		if (result.ok) {
			setIssues({});
			return result.endpoint;
		}
		const byField: Partial<Record<LocalModelEndpointField, string>> = {};
		for (const issue of result.issues) byField[issue.field] ??= issue.message;
		setIssues(byField);
		return null;
	};

	// Switching kind carries the defaults along, but never over something the
	// user typed: a URL or name still equal to the previous kind's default is
	// ours to replace, anything else is theirs.
	const changeKind = (next: LocalModelEndpointKind) => {
		if (baseUrl.trim() === '' || baseUrl === DEFAULT_ENDPOINT_BASE_URLS[kind]) {
			setBaseUrl(DEFAULT_ENDPOINT_BASE_URLS[next] ?? '');
		}
		if (name.trim() === '' || name === LOCAL_MODEL_ENDPOINT_KIND_LABELS[kind]) {
			setName(LOCAL_MODEL_ENDPOINT_KIND_LABELS[next]);
		}
		setKind(next);
	};

	const handleSave = () => {
		setSaveError(null);
		const endpoint = validated();
		if (!endpoint) return;
		const change = onSave(endpoint);
		if (!change.ok) setSaveError(change.message);
	};

	const handleTest = async () => {
		const endpoint = validated();
		if (!endpoint) return;
		setTestState({ status: 'testing' });
		setTestState(await onTest(endpoint));
	};

	return (
		<div className="space-y-3" data-testid="local-model-endpoint-form">
			<SegmentedControl
				theme={theme}
				value={kind}
				onChange={changeKind}
				options={KIND_OPTIONS}
				ariaLabel="Endpoint kind"
				testId="local-model-endpoint-kind"
			/>
			<FormInput
				theme={theme}
				label="Name"
				value={name}
				onChange={setName}
				onSubmit={handleSave}
				error={issues.name}
				testId="local-model-endpoint-name"
			/>
			<FormInput
				theme={theme}
				label="Base URL"
				value={baseUrl}
				onChange={setBaseUrl}
				onSubmit={handleSave}
				placeholder={DEFAULT_ENDPOINT_BASE_URLS[kind] ?? OPENAI_COMPATIBLE_PLACEHOLDER}
				error={issues.baseUrl}
				monospace
				testId="local-model-endpoint-url"
			/>
			<div>
				<FormFieldLabel theme={theme}>API key variable (optional)</FormFieldLabel>
				<EnvVarKeyInput
					theme={theme}
					value={apiKeyEnvVar}
					onChange={setApiKeyEnvVar}
					knownEnvVarKeys={knownEnvVarKeys}
					placeholder="OPENAI_API_KEY"
					containerClassName="relative w-full"
					className="w-full p-3 rounded border bg-transparent outline-none font-mono text-sm"
					style={{
						borderColor: issues.apiKeyEnvVar ? theme.colors.error : theme.colors.border,
						color: theme.colors.textMain,
					}}
					data-testid="local-model-endpoint-api-key-var"
				/>
				<p
					className="text-xs mt-1"
					style={{ color: issues.apiKeyEnvVar ? theme.colors.error : theme.colors.textDim }}
				>
					{issues.apiKeyEnvVar ??
						'The name of a variable in Settings > Environment that holds the key. A local server usually needs none.'}
				</p>
			</div>

			{testState && <EndpointTestVerdictLine theme={theme} state={testState} />}
			{saveError && (
				<p
					className="text-xs select-text"
					style={{ color: theme.colors.error }}
					data-testid="local-model-endpoint-save-error"
				>
					{saveError}
				</p>
			)}

			<div className="flex flex-wrap gap-2">
				<button
					type="button"
					onClick={handleSave}
					className="px-2 py-1 rounded text-xs flex items-center gap-1.5"
					style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
					data-testid="local-model-endpoint-save"
				>
					<Check className="w-3 h-3" />
					{initial ? 'Save' : 'Add endpoint'}
				</button>
				<button
					type="button"
					onClick={() => void handleTest()}
					disabled={testState !== null && 'status' in testState}
					className="px-2 py-1 rounded border text-xs flex items-center gap-1.5 disabled:opacity-50"
					style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					data-testid="local-model-endpoint-form-test"
				>
					<Plug className="w-3 h-3" />
					Test
				</button>
				<button
					type="button"
					onClick={onCancel}
					className="px-2 py-1 rounded border text-xs flex items-center gap-1.5"
					style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
				>
					<X className="w-3 h-3" />
					Cancel
				</button>
			</div>
		</div>
	);
}
