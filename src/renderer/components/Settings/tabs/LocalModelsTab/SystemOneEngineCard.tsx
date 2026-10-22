/**
 * SystemOneEngineCard - the engine card at the top of Models > System One.
 *
 * System One answers typed questions (yes or no, pick one, rate on a rubric)
 * for the tasks listed under this card. Here the user chooses WHO answers:
 * TypeSafe's hosted Jev, an OpenJev server they run, or a local model acting as
 * a judge. It is off until they choose.
 *
 * Opening the card reads a report and sends nothing. The sentence under the
 * picker says where task text goes on the engine chosen; for the hosted engine
 * that sentence is the disclosure, and it is always shown. A key is typed into
 * a password field, handed to main, and dropped: no control reads one back, so
 * the card shows where a key comes from and never the key. Test is the only
 * control that calls the engine.
 *
 * Every control has a `maestro-cli s1` verb that calls the same main-process
 * function.
 */

import { useEffect, useState } from 'react';
import { Brain, Check, KeyRound, Trash2, Zap } from 'lucide-react';

import {
	JEV_CLOUD_BASE_URL,
	JEV_DEFAULT_MODEL,
	LOCAL_JUDGE_DEFAULT_TIMEOUT_MS,
	SYSTEM_ONE_DEFAULT_TIMEOUT_MS,
	type SystemOneRemoteEngineId,
} from '../../../../../shared/local-models/system-one';
import {
	SYSTEM_ONE_ENGINE_CHOICES,
	SYSTEM_ONE_MAX_TIMEOUT_MS,
	SYSTEM_ONE_MIN_TIMEOUT_MS,
	TYPESAFE_BASE_URL_ENV_VAR,
	describeSystemOneKey,
	isSystemOneEngineChoice,
	isSystemOneRemoteEngineId,
	systemOneEngineChoiceLabel,
	systemOneKeyProblem,
	systemOneModelProblem,
	systemOneTimeoutProblem,
	systemOneUrlProblem,
	type SystemOneKeyInfo,
	type SystemOneReport,
	type SystemOneTestResult,
} from '../../../../../shared/local-models/system-one-settings';
import { LOCAL_JUDGE_TASK_ID, LOCAL_MODEL_TASKS } from '../../../../../shared/local-models/tasks';
import type { SystemOneHookState } from '../../../../hooks/localModels';
import type { Theme } from '../../../../types';
import { FormInput } from '../../../ui/FormInput';
import { SettingsSectionHeading } from '../../SettingsSectionHeading';
import { SectionCard } from '../DisplayTab/components/SectionCard';
import { CardButton } from './CardButton';
import { CardRowTitle, CardWarning } from './CardParts';

/** Whether a key source is weaker than a sealed key, or cannot be used at all. */
function keyNeedsWarning(info: SystemOneKeyInfo): boolean {
	return info.source === 'stored' && (info.problem !== undefined || info.storage === 'obscured');
}

/** The Test result as one sentence. Pure, for the tests. */
export function describeSystemOneTest(result: SystemOneTestResult): string {
	if (!result.ok) return result.error;
	const said = result.probability >= 0.5 ? 'yes' : 'no';
	const calibrated = result.calibrated ? '' : ', not calibrated';
	return `${result.engineLabel} answered ${said} (P(yes) ${result.probability.toFixed(2)}${calibrated}) in ${result.latencyMs} ms on ${result.model}.`;
}

export interface SystemOneEngineCardProps {
	theme: Theme;
	/** The card's state. The tab passes its one `useSystemOne()`; tests pass a fake. */
	systemOne: SystemOneHookState;
}

/** The card body: the engine, its address, key, model and budget, and the Test. */
export function SystemOneEngineCard({ theme, systemOne }: SystemOneEngineCardProps) {
	const { report, busy, error, test } = systemOne;

	if (!report) {
		return (
			<SectionCard theme={theme}>
				<p className="text-xs opacity-70 select-text">{error ?? 'Reading System One...'}</p>
			</SectionCard>
		);
	}

	const { engine } = report.settings;
	const remote = isSystemOneRemoteEngineId(engine) ? engine : null;
	const acting = busy !== null;

	return (
		<SectionCard theme={theme}>
			{/* Engine and where the text goes */}
			<div className="space-y-2" data-testid="system-one-engine">
				<div className="flex items-start justify-between gap-3">
					<div className="min-w-0">
						<label htmlFor="system-one-engine-select">
							<CardRowTitle theme={theme}>Engine</CardRowTitle>
						</label>
						<p className="text-xs opacity-70 mt-0.5">
							Who answers the typed questions a System One task asks. Off until you choose.
						</p>
					</div>
					<select
						id="system-one-engine-select"
						value={engine}
						onChange={(event) => {
							const choice = event.target.value;
							if (isSystemOneEngineChoice(choice) && choice !== engine) {
								void systemOne.set({ engine: choice });
							}
						}}
						disabled={acting}
						className="w-56 flex-shrink-0 p-1.5 rounded border bg-transparent outline-none text-xs"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
						data-testid="system-one-engine-select"
					>
						{SYSTEM_ONE_ENGINE_CHOICES.map((choice) => (
							<option key={choice} value={choice}>
								{systemOneEngineChoiceLabel(choice)}
							</option>
						))}
					</select>
				</div>
				<p
					className="text-xs select-text"
					style={{ color: engine === 'jev-cloud' ? theme.colors.warning : theme.colors.textDim }}
					data-testid="system-one-disclosure"
				>
					{report.disclosure}
				</p>
				{/* The sentence above names TypeSafe. An override sends the text, and the key, elsewhere. */}
				{engine === 'jev-cloud' && report.baseUrl && report.baseUrl !== JEV_CLOUD_BASE_URL && (
					<div data-testid="system-one-address-override">
						<CardWarning theme={theme}>
							{TYPESAFE_BASE_URL_ENV_VAR} is set, so requests and the key go to {report.baseUrl}{' '}
							instead.
						</CardWarning>
					</div>
				)}
				{report.problem && <CardWarning theme={theme}>{report.problem}</CardWarning>}
				{error && (
					<p className="text-xs select-text" style={{ color: theme.colors.error }}>
						{error}
					</p>
				)}
			</div>

			{engine === 'openjev' && (
				<OpenJevUrlRow theme={theme} report={report} systemOne={systemOne} disabled={acting} />
			)}

			{remote && (
				<KeyRow
					theme={theme}
					engine={remote}
					info={report.keys[remote]}
					systemOne={systemOne}
					disabled={acting}
				/>
			)}

			{remote && (
				<PinnedModelRow
					theme={theme}
					engine={remote}
					report={report}
					systemOne={systemOne}
					disabled={acting}
				/>
			)}

			{engine === 'local-judge' && (
				<div className="space-y-1" data-testid="system-one-judge-model">
					<CardRowTitle theme={theme}>Model</CardRowTitle>
					<p className="text-xs opacity-70 select-text">
						{report.modelLabel ? `${report.modelLabel}. ` : 'No model is assigned yet. '}
						Choose it on the {LOCAL_MODEL_TASKS[LOCAL_JUDGE_TASK_ID].label} row below.
					</p>
				</div>
			)}

			{remote && (
				<TimeoutRow theme={theme} report={report} systemOne={systemOne} disabled={acting} />
			)}
			{engine === 'local-judge' && (
				<p className="text-xs opacity-70">
					The local judge gets {LOCAL_JUDGE_DEFAULT_TIMEOUT_MS / 1000} seconds for a request: its
					first answer after an idle spell loads the model.
				</p>
			)}

			{/* Test */}
			{engine !== 'off' && (
				<div className="space-y-2" data-testid="system-one-test">
					<CardRowTitle theme={theme}>Test</CardRowTitle>
					<p className="text-xs opacity-70">
						Asks one fixed yes or no question about a fixed sentence. Nothing of yours is sent.
					</p>
					<div className="flex flex-wrap items-center gap-2">
						<CardButton
							theme={theme}
							icon={Zap}
							label={busy === 'test' ? 'Testing...' : 'Test'}
							onClick={() => void systemOne.runTest()}
							disabled={acting}
							testId="system-one-test-run"
						/>
					</div>
					{test && (
						<p
							className="text-xs select-text"
							style={{ color: test.ok ? theme.colors.success : theme.colors.error }}
							data-testid="system-one-test-result"
							data-test-ok={test.ok}
						>
							{describeSystemOneTest(test)}
						</p>
					)}
					{test?.ok && test.probability < 0.5 && (
						<CardWarning theme={theme}>The right answer to the test question is yes.</CardWarning>
					)}
				</div>
			)}
		</SectionCard>
	);
}

interface RowProps {
	theme: Theme;
	report: SystemOneReport;
	systemOne: SystemOneHookState;
	disabled: boolean;
}

function OpenJevUrlRow({ theme, report, systemOne, disabled }: RowProps) {
	const saved = report.settings.openJevUrl ?? '';
	const [draft, setDraft] = useState(saved);
	// A change from outside (`maestro-cli s1 set engine openjev --url`) replaces the field.
	useEffect(() => setDraft(saved), [saved]);

	const problem = draft.trim() === '' ? null : systemOneUrlProblem(draft);
	const changed = problem === null && draft.trim() !== saved;
	const save = () => {
		if (changed) void systemOne.set({ openJevUrl: draft.trim() });
	};

	return (
		<div className="space-y-2" data-testid="system-one-openjev-url">
			<FormInput
				theme={theme}
				label="OpenJev server URL"
				value={draft}
				onChange={setDraft}
				onSubmit={save}
				submitEnabled={changed && !disabled}
				placeholder="https://jev.example.com"
				error={problem ?? undefined}
				helperText="OpenJev needs a CUDA GPU, so on a Mac this is a server on another machine."
				monospace
				disabled={disabled}
				testId="system-one-openjev-url-input"
			/>
			<CardButton
				theme={theme}
				icon={Check}
				label="Save"
				onClick={save}
				disabled={!changed || disabled}
				primary
				testId="system-one-openjev-url-save"
			/>
		</div>
	);
}

interface KeyRowProps {
	theme: Theme;
	engine: SystemOneRemoteEngineId;
	info: SystemOneKeyInfo;
	systemOne: SystemOneHookState;
	disabled: boolean;
}

function KeyRow({ theme, engine, info, systemOne, disabled }: KeyRowProps) {
	const [draft, setDraft] = useState('');
	// A key typed for one engine is not offered to another.
	useEffect(() => setDraft(''), [engine]);

	const stored = info.source === 'stored';
	const problem = draft === '' ? null : systemOneKeyProblem(draft);
	const ready = draft !== '' && problem === null;
	const save = async () => {
		if (!ready) return;
		// The field is emptied only once main has the key, so a refused key can be fixed in place.
		if (await systemOne.setKey(engine, draft.trim())) setDraft('');
	};

	return (
		<div className="space-y-2" data-testid="system-one-key">
			<CardRowTitle theme={theme}>API key</CardRowTitle>
			{keyNeedsWarning(info) ? (
				<CardWarning theme={theme}>{describeSystemOneKey(info)}</CardWarning>
			) : (
				<p className="text-xs opacity-70 select-text" data-testid="system-one-key-source">
					{describeSystemOneKey(info)}
					{info.source === 'none' && engine === 'openjev'
						? ' Only a server that asks for one needs it.'
						: ''}
					{info.source === 'env' || info.source === 'file'
						? ' Store a key here to use that one instead.'
						: ''}
				</p>
			)}
			<FormInput
				theme={theme}
				type="password"
				value={draft}
				onChange={setDraft}
				onSubmit={() => void save()}
				submitEnabled={ready && !disabled}
				placeholder={stored ? 'Paste a new key to replace the stored one' : 'Paste a key'}
				error={problem ?? undefined}
				monospace
				disabled={disabled}
				testId="system-one-key-input"
			/>
			<div className="flex flex-wrap gap-2">
				<CardButton
					theme={theme}
					icon={KeyRound}
					label={stored ? 'Replace' : 'Save'}
					onClick={() => void save()}
					disabled={!ready || disabled}
					primary
					testId="system-one-key-save"
				/>
				{stored && (
					<CardButton
						theme={theme}
						icon={Trash2}
						label="Clear"
						onClick={() => void systemOne.clearKey(engine)}
						disabled={disabled}
						testId="system-one-key-clear"
					/>
				)}
			</div>
		</div>
	);
}

function PinnedModelRow({
	theme,
	engine,
	report,
	systemOne,
	disabled,
}: RowProps & { engine: SystemOneRemoteEngineId }) {
	const saved = report.settings.models[engine] ?? '';
	const [draft, setDraft] = useState(saved);
	useEffect(() => setDraft(saved), [saved, engine]);

	const trimmed = draft.trim();
	const problem = trimmed === '' ? null : systemOneModelProblem(trimmed);
	const changed = problem === null && trimmed !== saved;
	const save = () => {
		if (changed) void systemOne.set({ model: trimmed === '' ? null : trimmed });
	};

	return (
		<div className="space-y-2" data-testid="system-one-model">
			<FormInput
				theme={theme}
				label="Pinned model (optional)"
				value={draft}
				onChange={setDraft}
				onSubmit={save}
				submitEnabled={changed && !disabled}
				placeholder={
					engine === 'jev-cloud' ? JEV_DEFAULT_MODEL : 'the one the server was started with'
				}
				error={problem ?? undefined}
				helperText={
					engine === 'jev-cloud'
						? `Empty uses ${JEV_DEFAULT_MODEL}, which moves to each new release. Pin a version where a threshold was tuned against one.`
						: 'Empty sends no model, and the server answers on the one it was started with.'
				}
				monospace
				disabled={disabled}
				testId="system-one-model-input"
			/>
			<CardButton
				theme={theme}
				icon={Check}
				label="Save"
				onClick={save}
				disabled={!changed || disabled}
				primary
				testId="system-one-model-save"
			/>
		</div>
	);
}

function TimeoutRow({ theme, report, systemOne, disabled }: RowProps) {
	const saved = String(report.settings.timeoutMs);
	const [draft, setDraft] = useState(saved);
	useEffect(() => setDraft(saved), [saved]);

	const value = draft.trim() === '' ? Number.NaN : Number(draft);
	const problem = systemOneTimeoutProblem(value);
	const changed = problem === null && String(value) !== saved;
	const save = () => {
		if (changed) void systemOne.set({ timeoutMs: value });
	};

	return (
		<div className="space-y-2" data-testid="system-one-timeout">
			<FormInput
				theme={theme}
				label="Timeout (ms)"
				type="number"
				value={draft}
				onChange={setDraft}
				onSubmit={save}
				submitEnabled={changed && !disabled}
				placeholder={String(SYSTEM_ONE_DEFAULT_TIMEOUT_MS)}
				error={draft.trim() === saved ? undefined : (problem ?? undefined)}
				helperText={`How long one request may take, from ${SYSTEM_ONE_MIN_TIMEOUT_MS} to ${SYSTEM_ONE_MAX_TIMEOUT_MS}. With no answer in time, the task applies its fail policy.`}
				disabled={disabled}
				testId="system-one-timeout-input"
			/>
			<CardButton
				theme={theme}
				icon={Check}
				label="Save"
				onClick={save}
				disabled={!changed || disabled}
				primary
				testId="system-one-timeout-save"
			/>
		</div>
	);
}

export interface SystemOneEngineSectionProps {
	theme: Theme;
	systemOne: SystemOneHookState;
}

/** The section: heading plus card. */
export function SystemOneEngineSection({ theme, systemOne }: SystemOneEngineSectionProps) {
	return (
		<div data-setting-id="local-models-system-one-engine" className="select-none">
			<SettingsSectionHeading
				icon={Brain}
				description="The engine System One tasks ask: TypeSafe's Jev, an OpenJev server you run, or a local model acting as a judge."
			>
				System One engine
			</SettingsSectionHeading>
			<SystemOneEngineCard theme={theme} systemOne={systemOne} />
		</div>
	);
}
