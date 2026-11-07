/**
 * RunOnField - the one control for where an agent's model runs.
 *
 * It lists "Provider (default)" and then, grouped by source, every model the
 * Maestro model server and each enabled source serves, from the same option
 * builder the tests read (`buildRunOnOptionGroups`). A model on the Maestro
 * server carries what the Library says about it: its fit on this computer and
 * the "Agent-ready" badge when it qualified with this agent's harness.
 *
 * Under the picker it says what the launch will do with the choice, from the
 * same `resolveRunOnLaunch` the launch plan runs:
 *
 * - a provider with no verified recipe shows the picker DISABLED with the reason;
 * - a source that is gone or disabled, and a loopback source for an agent on an
 *   SSH remote, are flagged before the launch refuses them;
 * - a recipe variable the agent sets itself is named, because it wins;
 * - a model that has not passed the agent qualification carries a warning.
 *
 * Test sends one short read-only turn through the real harness (`onTest`) and
 * shows the reply or the reason it failed.
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
	runOnContextProblem,
	RUN_ON_MIN_CONTEXT_TOKENS,
	type RunOnLaunchResolution,
	type RunOnSourceTarget,
	type RunOnTarget,
	type RunOnTestResult,
} from '../../../shared/local-models/run-on';
import {
	buildRunOnOptionGroups,
	runOnModelFacts,
	RUN_ON_UNTESTED_WARNING,
} from '../../../shared/local-models/run-on-picker';
import { formatCount } from '../../../shared/formatters';
import { modelsSettingsLocation } from '../../../shared/local-models/settings-location';
import { useLocalModelsHardware, useRunOnSources } from '../../hooks/localModels';
import type { Theme } from '../../types';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { AssignmentOptionElements } from '../Settings/tabs/LocalModelsTab/AssignmentOptionElements';
import { CardButton } from '../Settings/tabs/LocalModelsTab/CardButton';
import { FormFieldLabel } from '../ui/FormFieldLabel';
import { FormInput } from '../ui/FormInput';

export interface RunOnFieldProps {
	theme: Theme;
	/** The agent's provider, e.g. `claude-code`. */
	toolType: string;
	value: RunOnTarget;
	onChange: (target: RunOnTarget) => void;
	/**
	 * The agent's effective custom vars (its own, or the provider-level set
	 * when it has none), so the field can say when one of them wins.
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
 * The settings a source target takes out of force, per provider: an agent on a
 * source keeps to the mode its recipe was measured in (`runOnHarnessMode`).
 */
const HARNESS_MODE_NOTES: Readonly<Record<string, string>> = {
	'claude-code':
		'While a source is chosen, Claude Code runs as claude --print. The token source on the Provider tab does not apply.',
	codex:
		'While a source is chosen, Codex runs as codex exec. The transport on the Provider tab does not apply.',
};

type TestState =
	| { status: 'idle' }
	| { status: 'testing' }
	| { status: 'done'; result: RunOnTestResult };

export function RunOnField({
	theme,
	toolType,
	value,
	onChange,
	userEnvVars,
	sshRemoteName,
	error,
	onTest,
	testBlockedReason,
	testId = 'run-on-field',
}: RunOnFieldProps) {
	const support = agentRunOnSupport(toolType);
	const { sources, endpoints, loading, problems } = useRunOnSources();
	const hardware = useLocalModelsHardware();

	const groups = useMemo(
		() =>
			buildRunOnOptionGroups({
				toolType,
				current: value,
				sources,
				endpoints,
				hardware: hardware.profile,
			}),
		[toolType, value, sources, endpoints, hardware.profile]
	);

	const source = value.type === 'source' ? value : null;
	const facts = useMemo(
		() => (source ? runOnModelFacts(toolType, source, hardware.profile) : null),
		[toolType, source, hardware.profile]
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

	const [test, setTest] = useState<TestState>({ status: 'idle' });
	const targetKey = source ? `${formatRunOnSpec(source)}@${source.contextTokens ?? ''}` : '';
	// A verdict describes the target it ran on. Any other target has none yet.
	useEffect(() => {
		setTest({ status: 'idle' });
	}, [targetKey, toolType]);

	const choose = (spec: string) => {
		const parsed = parseRunOnSpec(spec);
		if (!parsed.ok) return;
		if (parsed.target.type === 'provider') {
			onChange(parsed.target);
			return;
		}
		// The context starts at what the Library runs this model at, stated on the
		// target so the harness and the server are told the same size.
		onChange({
			...parsed.target,
			contextTokens: runOnModelFacts(toolType, parsed.target, hardware.profile)
				.defaultContextTokens,
		});
	};

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

	const line: StatusLine | null = error
		? { tone: 'error', text: error }
		: !support.supported
			? { tone: 'dim', text: support.reason }
			: status;
	const toneColor = (tone: StatusTone) =>
		tone === 'error'
			? theme.colors.error
			: tone === 'warning'
				? theme.colors.warning
				: theme.colors.textDim;
	const selectId = `${testId}-select`;
	const testBlocked =
		testBlockedReason ?? (contextProblem ? 'Fix the context size first.' : undefined);

	return (
		<div className="w-full space-y-2" data-testid={testId}>
			<div>
				<FormFieldLabel theme={theme} htmlFor={selectId}>
					Run on
				</FormFieldLabel>
				<select
					id={selectId}
					value={formatRunOnSpec(value)}
					onChange={(e) => choose(e.target.value)}
					disabled={!support.supported}
					className="w-full p-2 text-sm rounded border bg-transparent outline-none disabled:opacity-40"
					style={{
						borderColor: theme.colors.border,
						color: theme.colors.textMain,
						backgroundColor: theme.colors.bgMain,
					}}
					data-testid={selectId}
				>
					<AssignmentOptionElements groups={groups} />
				</select>
				{line && (
					<p
						className="mt-1 text-xs select-text"
						style={{ color: toneColor(line.tone) }}
						data-testid={`${testId}-status`}
						data-tone={line.tone}
					>
						{line.text}
					</p>
				)}
				{support.supported && !source && (
					<p className="mt-1 text-xs" style={{ color: theme.colors.textDim }}>
						The agent keeps its harness. Choose a model to run it on a source from{' '}
						{modelsSettingsLocation('sources')} or on the Maestro model server.
						{loading ? ' Listing models...' : ''}
					</p>
				)}
				{support.supported &&
					problems.map((problem) => (
						<p
							key={problem.endpointId}
							className="mt-1 text-xs select-text"
							style={{ color: theme.colors.textDim }}
							data-testid={`${testId}-source-problem`}
						>
							{problem.name}: {problem.message}
						</p>
					))}
			</div>

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

					{/* Text that is not a number is never handed up, so leaving the field
					    puts back the size the target holds: what is shown is what is saved. */}
					<div onBlur={() => setContextDraft(String(storedContext ?? ''))}>
						<FormInput
							theme={theme}
							label="Context size (tokens)"
							value={contextDraft}
							onChange={commitContext}
							placeholder={String(facts.defaultContextTokens)}
							error={contextProblem ?? undefined}
							helperText={`What the harness is told it has. At least ${formatCount(RUN_ON_MIN_CONTEXT_TOKENS)}; a project with large instruction files needs more, because the harness sends them on every turn.`}
							monospace
							heightClass="!p-2"
							testId={`${testId}-context`}
						/>
					</div>

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

export default RunOnField;
