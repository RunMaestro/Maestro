/**
 * The model source half of an agent's model picker: which Local Models sources
 * the Model field also lists, and what a source model needs under the field.
 *
 * The agent's Model field (`AgentConfigOptions`, the `model` option) lists the
 * provider's own models first and then, grouped by source, every model the
 * Maestro model server and each enabled source serves. Picking a source model
 * sets the agent's model source (stored as `runOn`); picking a provider model
 * sets it back to the provider. This file supplies both halves of that:
 *
 * - {@link useModelSourceChoices} builds the source groups from the same option
 *   builder the tests read (`buildRunOnOptionGroups`). A model on the Maestro
 *   server carries what the Library says about it: its fit on this computer and
 *   the "Agent-ready" badge when it qualified with this agent's harness.
 * - {@link ModelSourceDetails} says what the launch will do with the choice,
 *   from the same `resolveRunOnLaunch` the launch plan runs: a source that is
 *   gone or disabled, a loopback source for an agent on an SSH remote, a recipe
 *   variable the agent sets itself, and a model that has not passed the agent
 *   qualification. It holds the context size and the Test button, which sends
 *   one short read-only turn through the real harness (`onTest`).
 *
 * A provider with no verified recipe offers no sources at all.
 *
 * Controlled, and it stores nothing: the host decides when a value is saved.
 */

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, FlaskConical, Loader2 } from 'lucide-react';

import { MODEL_FIT_LABELS } from '../../../shared/local-models/model-fit';
import {
	MODEL_SERVER_ENDPOINT_ID,
	MODEL_SERVER_LOOPBACK_HOST,
	modelServerEndpoint,
} from '../../../shared/local-models/model-server';
import {
	agentRunOnSupport,
	formatRunOnSpec,
	parseRunOnSpec,
	resolveRunOnLaunch,
	runOnContextChoices,
	runOnContextProblem,
	RUN_ON_MIN_CONTEXT_TOKENS,
	RUN_ON_PROVIDER_SPEC,
	type RunOnLaunchResolution,
	type RunOnSourceTarget,
	type RunOnTarget,
	type RunOnTestResult,
} from '../../../shared/local-models/run-on';
import {
	buildRunOnOptionGroups,
	reportedRunOnContextTokens,
	runOnModelFacts,
	RUN_ON_UNTESTED_WARNING,
	type RunOnOptionGroup,
} from '../../../shared/local-models/run-on-picker';
import { formatCount } from '../../../shared/formatters';
import { useLocalModelsHardware, useRunOnSources } from '../../hooks/localModels';
import type { Theme } from '../../types';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { CardButton } from '../Settings/tabs/LocalModelsTab/CardButton';
import { FormFieldLabel } from '../ui/FormFieldLabel';
import { FormInput } from '../ui/FormInput';

/** How a form binds an agent's model source to the Model field. */
export interface ModelSourceBinding {
	value: RunOnTarget;
	onChange: (target: RunOnTarget) => void;
	/**
	 * The agent's effective custom vars (its own, or the provider-level set
	 * when it has none), so the details can say when one of them wins.
	 */
	userEnvVars?: Record<string, string>;
	/** Name of the SSH remote the agent runs on, when it runs on one. */
	sshRemoteName?: string;
	/** A save error from the host, shown in place of the status line. */
	error?: string;
	/** Runs one test turn on the target shown. Omit to draw no Test button. */
	onTest?: (target: RunOnSourceTarget) => Promise<RunOnTestResult>;
	/** Why a test cannot run yet (no working directory chosen, for example). */
	testBlockedReason?: string;
	testId?: string;
}

/** What the Model field offers beyond the provider's own models. */
export interface ModelSourceChoices {
	/** One group per source, each labeled with the source's name. Empty while none lists a model. */
	groups: readonly ModelSourceGroup[];
	/** The source model the agent runs on, or null while it runs on its provider. */
	selected: { spec: string; sourceName: string; model: string } | null;
	/** Run on the source model a spec names (`<source id>:<model>`). */
	onSelect: (spec: string) => void;
	/** Run on the provider again. The provider model is the field's own value. */
	onProvider: () => void;
}

export interface ModelSourceGroup {
	label: string;
	options: RunOnOptionGroup['options'];
	/** The group of a current target no source lists, not a source of its own. */
	unlisted?: true;
}

/** The group a current target no source lists falls into, so it still shows. */
const UNLISTED_GROUP_LABEL = 'Not listed by any source';

type StatusTone = 'dim' | 'warning' | 'error';
interface StatusLine {
	tone: StatusTone;
	text: string;
}

/** What the launch will do with this target, as one line for the user. */
export function describeRunOnStatus(resolution: RunOnLaunchResolution): StatusLine | null {
	switch (resolution.kind) {
		case 'none':
			return null;
		case 'refused':
			return {
				tone: resolution.code === 'run-on-loopback-on-remote' ? 'warning' : 'error',
				text: resolution.message,
			};
		case 'inject':
			if (resolution.userOverrides.length === 0) return null;
			return {
				tone: 'warning',
				text: `Not applied in full: ${resolution.userOverrides.join(', ')} ${
					resolution.userOverrides.length === 1 ? 'is' : 'are'
				} set in this agent's environment variables, and that value wins.`,
			};
	}
}

/**
 * The source groups of the Model field, split out of the option builder's
 * output: its ungrouped head holds the provider entry (the Model field lists
 * the provider's models itself) and a current target no source lists, which
 * gets a group of its own so the field can still show and highlight it.
 */
export function modelSourceGroups(groups: readonly RunOnOptionGroup[]): ModelSourceGroup[] {
	const result: ModelSourceGroup[] = [];
	for (const group of groups) {
		if (group.label !== null) {
			result.push({ label: group.label, options: group.options });
			continue;
		}
		const unlisted = group.options.filter((option) => option.value !== RUN_ON_PROVIDER_SPEC);
		if (unlisted.length > 0) {
			result.push({ label: UNLISTED_GROUP_LABEL, options: unlisted, unlisted: true });
		}
	}
	return result;
}

/**
 * The settings a source target takes out of force, per provider: an agent on a
 * source keeps to the mode its recipe was measured in (`runOnHarnessMode`).
 */
const HARNESS_MODE_NOTES: Readonly<Record<string, string>> = {
	'claude-code':
		'While a source model is chosen, Claude Code runs as claude --print. The token source on the Provider tab does not apply.',
	codex:
		'While a source model is chosen, Codex runs as codex exec. The transport on the Provider tab does not apply.',
};

/** The context dropdown's last option, which opens the number field. */
const CUSTOM_CONTEXT_VALUE = 'custom';

/** What the context size is for, and how much the model holds when that is known. */
function contextHelpText(maxContextTokens: number | undefined): string {
	const holds =
		maxContextTokens !== undefined
			? ` This model holds up to ${formatCount(maxContextTokens)} tokens.`
			: '';
	return `What the harness is told it has. At least ${formatCount(RUN_ON_MIN_CONTEXT_TOKENS)}; a project with large instruction files needs more, because the harness sends them on every turn.${holds}`;
}

/** The source listings behind the field, shared by the choices and the details. */
export interface ModelSourceState {
	choices: ModelSourceChoices | undefined;
	sources: ReturnType<typeof useRunOnSources>['sources'];
	endpoints: ReturnType<typeof useRunOnSources>['endpoints'];
	loading: boolean;
	problems: ReturnType<typeof useRunOnSources>['problems'];
	hardware: ReturnType<typeof useLocalModelsHardware>['profile'];
	/** Why this provider is offered no sources, when it is not. */
	unsupportedReason?: string;
}

/**
 * What the Model field offers beyond the provider for an agent on `toolType`,
 * bound to its model source. `choices` is undefined for a provider with no
 * verified recipe: it runs on its own models only.
 */
export function useModelSourceChoices(
	toolType: string,
	binding: Pick<ModelSourceBinding, 'value' | 'onChange'>
): ModelSourceState {
	const support = agentRunOnSupport(toolType);
	const { sources, endpoints, loading, problems } = useRunOnSources();
	const hardware = useLocalModelsHardware();
	const { value, onChange } = binding;

	const groups = useMemo(
		() =>
			modelSourceGroups(
				buildRunOnOptionGroups({
					toolType,
					current: value,
					sources,
					endpoints,
					hardware: hardware.profile,
				})
			),
		[toolType, value, sources, endpoints, hardware.profile]
	);

	const choices = useMemo<ModelSourceChoices | undefined>(() => {
		if (!support.supported) return undefined;
		const selected =
			value.type === 'source'
				? {
						spec: formatRunOnSpec(value),
						sourceName: sourceName(value, endpoints, groups),
						model: value.model,
					}
				: null;
		return {
			groups,
			selected,
			onSelect: (spec) => {
				const parsed = parseRunOnSpec(spec);
				if (!parsed.ok || parsed.target.type !== 'source') return;
				// The context starts at what the Library runs this model at, stated on
				// the target so the harness and the server are told the same size.
				onChange({
					...parsed.target,
					contextTokens: runOnModelFacts(
						toolType,
						parsed.target,
						hardware.profile,
						reportedRunOnContextTokens(sources, parsed.target)
					).defaultContextTokens,
				});
			},
			onProvider: () => {
				if (value.type !== 'provider') onChange({ type: 'provider' });
			},
		};
	}, [support.supported, value, endpoints, groups, onChange, toolType, hardware.profile, sources]);

	return {
		choices,
		sources,
		endpoints,
		loading,
		problems,
		hardware: hardware.profile,
		unsupportedReason: support.supported ? undefined : support.reason,
	};
}

/** The name a person knows a target's source by. */
function sourceName(
	target: RunOnSourceTarget,
	endpoints: readonly { id: string; name: string }[],
	groups: readonly ModelSourceGroup[]
): string {
	const spec = formatRunOnSpec(target);
	const listed = groups.find(
		(group) => !group.unlisted && group.options.some((option) => option.value === spec)
	);
	if (listed) return listed.label;
	return endpoints.find((endpoint) => endpoint.id === target.endpointId)?.name ?? target.endpointId;
}

type TestState =
	| { status: 'idle' }
	| { status: 'testing' }
	| { status: 'done'; result: RunOnTestResult };

export interface ModelSourceDetailsProps extends ModelSourceBinding {
	theme: Theme;
	/** The agent's provider, e.g. `claude-code`. */
	toolType: string;
	/** The listings `useModelSourceChoices` read for the same agent. */
	state: ModelSourceState;
}

/**
 * Everything under the Model field that is about the model source: why a
 * source cannot list its models, and for a source model its status, context
 * size and Test button. Draws nothing while the agent runs on its provider
 * with every source listing cleanly.
 */
export function ModelSourceDetails({
	theme,
	toolType,
	state,
	value,
	onChange,
	userEnvVars,
	sshRemoteName,
	error,
	onTest,
	testBlockedReason,
	testId = 'model-source',
}: ModelSourceDetailsProps) {
	const { sources, endpoints, loading, problems, hardware } = state;
	const supported = state.choices !== undefined;
	const source = value.type === 'source' ? value : null;
	// What the source's listing says the model holds, so the picker starts there
	// and offers no size past it.
	const reportedContext = source ? reportedRunOnContextTokens(sources, source) : undefined;
	const facts = useMemo(
		() => (source ? runOnModelFacts(toolType, source, hardware, reportedContext) : null),
		[toolType, source, hardware, reportedContext]
	);

	const status = useMemo(() => {
		if (!source) return null;
		// The server's port is chosen at its first start; its host is not in doubt,
		// and the host is all the launch checks read from its record.
		const endpoint =
			source.endpointId === MODEL_SERVER_ENDPOINT_ID
				? modelServerEndpoint(`http://${MODEL_SERVER_LOOPBACK_HOST}`)
				: (endpoints.find((candidate) => candidate.id === source.endpointId) ?? null);
		return describeRunOnStatus(
			resolveRunOnLaunch({
				toolType,
				target: source,
				endpoint,
				userEnvVars,
				remote: sshRemoteName ? { name: sshRemoteName } : null,
			})
		);
	}, [toolType, source, endpoints, userEnvVars, sshRemoteName]);

	// The context field holds text while it is typed; the target takes a number.
	const storedContext = source?.contextTokens ?? facts?.defaultContextTokens;
	const [contextDraft, setContextDraft] = useState(String(storedContext ?? ''));
	useEffect(() => {
		setContextDraft(String(storedContext ?? ''));
	}, [storedContext, source?.endpointId, source?.model]);

	// The sizes the dropdown offers. "Custom" opens the number field, and a size
	// no choice names (one typed earlier, or set from the CLI) shows there too.
	const contextChoices = useMemo(
		() => runOnContextChoices(facts?.maxContextTokens),
		[facts?.maxContextTokens]
	);
	const [customContextChosen, setCustomContextChosen] = useState(false);
	useEffect(() => {
		setCustomContextChosen(false);
	}, [source?.endpointId, source?.model]);
	const customContext =
		customContextChosen || !contextChoices.some((choice) => choice.tokens === storedContext);

	const [test, setTest] = useState<TestState>({ status: 'idle' });
	const targetKey = source ? `${formatRunOnSpec(source)}@${source.contextTokens ?? ''}` : '';
	// A verdict describes the target it ran on. Any other target has none yet.
	useEffect(() => {
		setTest({ status: 'idle' });
	}, [targetKey, toolType]);

	const commitContext = (text: string) => {
		setContextDraft(text);
		if (!source) return;
		const tokens = Number(text.trim());
		// Any whole number is handed up, so the host refuses a size under the
		// minimum at Save with the launch's own rule instead of saving the last
		// value that happened to be valid.
		if (text.trim() !== '' && Number.isInteger(tokens) && tokens > 0) {
			onChange({ ...source, contextTokens: tokens });
		}
	};

	const contextNumber = Number(contextDraft.trim());
	const contextProblem = source
		? runOnContextProblem(contextDraft.trim() === '' ? undefined : contextNumber)
		: null;
	const contextPastModel =
		facts?.maxContextTokens !== undefined &&
		contextProblem === null &&
		contextNumber > facts.maxContextTokens;

	const chooseContext = (choice: string) => {
		if (choice === CUSTOM_CONTEXT_VALUE) {
			setCustomContextChosen(true);
			return;
		}
		setCustomContextChosen(false);
		commitContext(choice);
	};
	const contextSelectId = `${testId}-context-select`;

	const runTest = async () => {
		if (!source || !onTest) return;
		setTest({ status: 'testing' });
		let result: RunOnTestResult;
		try {
			result = await onTest(source);
		} catch (err) {
			result = { ok: false, code: 'run-on-test-not-startable', message: ipcErrorMessage(err) };
		}
		setTest({ status: 'done', result });
	};

	// A provider with no verified recipe says why it lists no sources.
	const line: StatusLine | null = error
		? { tone: 'error', text: error }
		: state.unsupportedReason
			? { tone: 'dim', text: state.unsupportedReason }
			: status;
	const toneColor = (tone: StatusTone) =>
		tone === 'error'
			? theme.colors.error
			: tone === 'warning'
				? theme.colors.warning
				: theme.colors.textDim;
	const testBlocked =
		testBlockedReason ?? (contextProblem ? 'Fix the context size first.' : undefined);

	if (!supported && !line) return null;

	return (
		<div className="w-full space-y-2" data-testid={testId}>
			{line && (
				<p
					className="text-xs select-text"
					style={{ color: toneColor(line.tone) }}
					data-testid={`${testId}-status`}
					data-tone={line.tone}
				>
					{line.text}
				</p>
			)}
			{supported && loading && (
				<p className="text-xs" style={{ color: theme.colors.textDim }}>
					Listing source models...
				</p>
			)}
			{supported &&
				problems.map((problem) => (
					<p
						key={problem.endpointId}
						className="text-xs select-text"
						style={{ color: theme.colors.textDim }}
						data-testid={`${testId}-source-problem`}
					>
						{problem.name}: {problem.message}
					</p>
				))}

			{source && facts && (
				<>
					{!facts.qualified && (
						<p
							className="flex items-start gap-1.5 text-xs"
							style={{ color: theme.colors.warning }}
							data-testid={`${testId}-untested`}
						>
							<AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
							<span>{RUN_ON_UNTESTED_WARNING}</span>
						</p>
					)}
					{facts.fit && facts.fit.fit !== 'fits' && (
						<p
							className="text-xs select-text"
							style={{ color: theme.colors.warning }}
							data-testid={`${testId}-fit`}
						>
							{MODEL_FIT_LABELS[facts.fit.fit]}: {facts.fit.reason}
						</p>
					)}

					<div>
						<FormFieldLabel theme={theme} htmlFor={contextSelectId}>
							Context size
						</FormFieldLabel>
						<select
							id={contextSelectId}
							value={customContext ? CUSTOM_CONTEXT_VALUE : String(storedContext)}
							onChange={(e) => chooseContext(e.target.value)}
							className="w-full p-2 text-sm rounded border bg-transparent outline-none"
							style={{
								borderColor: theme.colors.border,
								color: theme.colors.textMain,
								backgroundColor: theme.colors.bgMain,
							}}
							data-testid={contextSelectId}
						>
							{contextChoices.map((choice) => (
								<option key={choice.tokens} value={String(choice.tokens)}>
									{choice.label}
								</option>
							))}
							<option value={CUSTOM_CONTEXT_VALUE}>Custom...</option>
						</select>
						{!customContext && (
							<p className="mt-1 text-xs" style={{ color: theme.colors.textDim }}>
								{contextHelpText(facts.maxContextTokens)}
							</p>
						)}
					</div>

					{/* Text that is not a number is never handed up, so leaving the field
					    puts back the size the target holds: what is shown is what is saved. */}
					{customContext && (
						<div onBlur={() => setContextDraft(String(storedContext ?? ''))}>
							<FormInput
								theme={theme}
								label="Custom context size (tokens)"
								value={contextDraft}
								onChange={commitContext}
								placeholder={String(facts.defaultContextTokens)}
								error={contextProblem ?? undefined}
								helperText={contextHelpText(facts.maxContextTokens)}
								monospace
								heightClass="!p-2"
								testId={`${testId}-context`}
							/>
						</div>
					)}
					{contextPastModel && (
						<p
							className="flex items-start gap-1.5 text-xs"
							style={{ color: theme.colors.warning }}
							data-testid={`${testId}-context-past-model`}
						>
							<AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
							<span>
								More than the {formatCount(facts.maxContextTokens ?? 0)} tokens this model holds. A
								turn past that fails.
							</span>
						</p>
					)}

					{HARNESS_MODE_NOTES[toolType] && (
						<p className="text-xs" style={{ color: theme.colors.textDim }}>
							{HARNESS_MODE_NOTES[toolType]}
						</p>
					)}

					{onTest && (
						<div className="space-y-1.5">
							<div className="flex items-center gap-2">
								<CardButton
									theme={theme}
									icon={test.status === 'testing' ? Loader2 : FlaskConical}
									label={test.status === 'testing' ? 'Testing...' : 'Test'}
									onClick={() => void runTest()}
									disabled={test.status === 'testing' || testBlocked !== undefined}
									testId={`${testId}-test`}
								/>
								<span className="text-xs" style={{ color: theme.colors.textDim }}>
									{testBlocked ??
										'Sends one short read-only turn through the real harness. A cold model can take a few minutes.'}
								</span>
							</div>
							{test.status === 'done' &&
								(test.result.ok ? (
									<p
										className="flex items-start gap-1.5 text-xs select-text"
										style={{ color: theme.colors.success }}
										data-testid={`${testId}-test-result`}
										data-ok="true"
									>
										<CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
										<span>
											{test.result.label} answered in {(test.result.durationMs / 1000).toFixed(1)}{' '}
											s: {test.result.reply}
										</span>
									</p>
								) : (
									<p
										className="flex items-start gap-1.5 text-xs select-text"
										style={{ color: theme.colors.error }}
										data-testid={`${testId}-test-result`}
										data-ok="false"
									>
										<AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
										<span>{test.result.message}</span>
									</p>
								))}
						</div>
					)}
				</>
			)}
		</div>
	);
}
