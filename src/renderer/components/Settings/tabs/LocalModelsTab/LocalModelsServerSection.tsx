/**
 * LocalModelsServerSection - the Model server card in Models > Sources.
 *
 * The Maestro model server is llama.cpp's own `llama-server`, run and watched by
 * Maestro, serving the Library's text models to agent harnesses (Claude Code,
 * Codex, OpenCode) over HTTP. This card is its one control surface: the state,
 * the engine build with the accelerator it found, the address, Start and Stop,
 * who can reach it, the key, the loaded models, and the log.
 *
 * Opening it reads a report and nothing else. The engine downloads only from
 * Install, the server starts only from Start (or from a task assigned to it),
 * and the key is read from main only when Copy is pressed, so it never sits in
 * renderer state. Every control has a `maestro-cli models server` verb that
 * calls the same main-process function.
 */

import { useCallback, useEffect, useState } from 'react';
import { Download, FileText, Play, RefreshCw, Server, Square } from 'lucide-react';

import { formatSize } from '../../../../../shared/formatters';
import {
	MAX_MODEL_SERVER_MAX_MODELS,
	MODEL_SERVER_BIND_HOSTS,
	type ModelServerBind,
	type ModelServerEngineProgress,
	type ModelServerReport,
	type ModelServerState,
} from '../../../../../shared/local-models/model-server';
import { serverAcceleratorProblemMessage } from '../../../../../shared/local-models/server-accelerator';
import type { ServerBuildChoice } from '../../../../../shared/local-models/server-engine';
import { useModelServer, type ModelServerHookState } from '../../../../hooks/localModels';
import type { Theme } from '../../../../types';
import { safeClipboardWrite } from '../../../../utils/clipboard';
import { flashCopiedToClipboard } from '../../../../utils/flashCopiedToClipboard';
import { ToggleButtonGroup } from '../../../ToggleButtonGroup';
import { CopyIconButton } from '../../../ui/CopyIconButton';
import { MiniBadge } from '../../../ui/MiniBadge';
import { ProgressBar } from '../../../ui/ProgressBar';
import { SettingsSectionHeading } from '../../SettingsSectionHeading';
import { SectionCard } from '../DisplayTab/components/SectionCard';
import { CardRowTitle, CardWarning } from './CardParts';

const STATE_LABELS: Readonly<Record<ModelServerState, string>> = Object.freeze({
	stopped: 'Stopped',
	starting: 'Starting',
	running: 'Running',
	restarting: 'Restarting',
	stopping: 'Stopping',
	failed: 'Failed',
});

const PHASE_LABELS: Readonly<Record<ModelServerEngineProgress['phase'], string>> = Object.freeze({
	downloading: 'Downloading',
	verifying: 'Verifying',
	extracting: 'Installing',
	done: 'Installed',
});

/** Shown in place of the key: the key itself is only ever fetched by Copy. */
export const MODEL_SERVER_KEY_PLACEHOLDER = 'sk-maestro-••••••••••••';

/** Whether Start (rather than Stop) is the button to show. Pure, for the tests. */
export function modelServerCanStart(state: ModelServerState): boolean {
	return state === 'stopped' || state === 'failed';
}

/** The build the picker should select: the installed one, else `default`. */
export function initialBuildChoice(report: ModelServerReport | null): ServerBuildChoice {
	return report?.engine.choice ?? 'default';
}

function stateColor(theme: Theme, state: ModelServerState): string {
	if (state === 'running') return theme.colors.success;
	if (state === 'failed') return theme.colors.error;
	if (state === 'stopped') return theme.colors.textDim;
	return theme.colors.warning;
}

interface CardButtonProps {
	theme: Theme;
	onClick: () => void;
	disabled?: boolean;
	primary?: boolean;
	children: React.ReactNode;
	testId?: string;
}

function CardButton({ theme, onClick, disabled, primary, children, testId }: CardButtonProps) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className="px-2 py-1 rounded border text-xs flex items-center gap-1.5 disabled:opacity-50"
			style={{
				borderColor: primary ? theme.colors.accent : theme.colors.border,
				backgroundColor: primary ? theme.colors.accentDim : 'transparent',
				color: theme.colors.textMain,
			}}
			data-testid={testId}
		>
			{children}
		</button>
	);
}

export interface LocalModelsServerCardProps {
	theme: Theme;
	/** The card's state. The section passes its own `useModelServer()`; tests pass a fake. */
	server: ModelServerHookState;
}

/** The card body: every row of the Model server card. */
export function LocalModelsServerCard({ theme, server }: LocalModelsServerCardProps) {
	const { report, progress, busy, error } = server;
	const [build, setBuild] = useState<ServerBuildChoice>(() => initialBuildChoice(report));
	const [confirmingRotate, setConfirmingRotate] = useState(false);

	// The installed build arrives with the first report, after the first render.
	const installedChoice = report?.engine.choice ?? null;
	useEffect(() => {
		if (installedChoice) setBuild(installedChoice);
	}, [installedChoice]);

	const { readKey } = server;
	const copyKey = useCallback(async () => {
		const key = await readKey();
		if (key && (await safeClipboardWrite(key))) flashCopiedToClipboard(undefined, 'Key copied');
	}, [readKey]);

	if (!report) {
		return (
			<SectionCard theme={theme}>
				<p className="text-xs opacity-70">{error ?? 'Reading the model server...'}</p>
			</SectionCard>
		);
	}

	const { status, engine, loaded } = report;
	const canStart = modelServerCanStart(status.state);
	const acting = busy !== null;
	const installing = progress !== null || busy === 'install';
	const selectedBuild = engine.builds.find((option) => option.choice === build);
	const acceleratorProblem = engine.accelerator
		? serverAcceleratorProblemMessage(engine.accelerator)
		: null;
	const cpuBuild = engine.builds.find((option) => option.choice === 'cpu');

	return (
		<SectionCard theme={theme}>
			{/* State, Start / Stop, log */}
			<div className="space-y-2" data-testid="model-server-status">
				<div className="flex items-center gap-2">
					<CardRowTitle theme={theme}>Maestro model server</CardRowTitle>
					<MiniBadge
						theme={theme}
						label={STATE_LABELS[status.state]}
						color={stateColor(theme, status.state)}
						testId="model-server-state"
					/>
				</div>
				<p className="text-xs opacity-70">
					Serves your downloaded text models to agent harnesses (Claude Code, Codex, OpenCode) over
					HTTP. It starts only when you press Start or when a task assigned to it needs it, and it
					stops when Maestro quits.
				</p>
				{status.lastError && (
					<p className="text-xs select-text" style={{ color: theme.colors.error }}>
						{status.lastError}
					</p>
				)}
				{error && (
					<p className="text-xs select-text" style={{ color: theme.colors.error }}>
						{error}
					</p>
				)}
				<div className="flex items-center gap-2">
					{canStart ? (
						<CardButton
							theme={theme}
							primary
							onClick={() => void server.start()}
							disabled={acting || !engine.installed}
							testId="model-server-start"
						>
							<Play className="w-3 h-3" />
							{busy === 'start' ? 'Starting...' : 'Start'}
						</CardButton>
					) : (
						<CardButton
							theme={theme}
							onClick={() => void server.stop()}
							disabled={acting || status.state === 'stopping'}
							testId="model-server-stop"
						>
							<Square className="w-3 h-3" />
							{busy === 'stop' ? 'Stopping...' : 'Stop'}
						</CardButton>
					)}
					<CardButton
						theme={theme}
						onClick={() => void window.maestro.shell.openPath(status.logPath)}
						testId="model-server-open-log"
					>
						<FileText className="w-3 h-3" />
						Open log
					</CardButton>
				</div>
			</div>

			{/* Engine and build */}
			<div className="space-y-2" data-testid="model-server-engine">
				<CardRowTitle theme={theme}>Engine</CardRowTitle>
				<p className="text-xs opacity-70">
					{engine.installed
						? `${engine.label} build of llama-server ${engine.release}, ${formatSize(engine.bytes)} on disk. Runs on: ${engine.accelerator?.label ?? 'not checked'}.`
						: engine.builds.length > 0
							? 'llama-server is not installed. Choose a build and install it before starting the server.'
							: 'No llama-server build is published for this platform, so the model server cannot run here.'}
				</p>
				{engine.stale && (
					<CardWarning theme={theme}>
						This build is older than the one Maestro expects. Install it again to update it.
					</CardWarning>
				)}
				{acceleratorProblem && (
					<div className="space-y-2" data-testid="model-server-accelerator-problem">
						<CardWarning theme={theme}>{acceleratorProblem}</CardWarning>
						{engine.accelerator?.offerCpuBuild && cpuBuild && engine.choice !== 'cpu' && (
							<CardButton
								theme={theme}
								onClick={() => void server.installEngine('cpu')}
								disabled={acting || installing}
								testId="model-server-install-cpu"
							>
								<Download className="w-3 h-3" />
								Install the CPU build ({formatSize(cpuBuild.downloadBytes)})
							</CardButton>
						)}
					</div>
				)}
				{installing && progress ? (
					<div className="space-y-1" data-testid="model-server-install-progress">
						<p className="text-xs opacity-70">
							{PHASE_LABELS[progress.phase]} the {progress.choice} build
						</p>
						<ProgressBar
							theme={theme}
							value={progress.bytes}
							total={progress.totalBytes}
							label={`${PHASE_LABELS[progress.phase]} llama-server`}
						/>
					</div>
				) : (
					engine.builds.length > 0 && (
						<div className="flex items-center gap-2">
							<select
								aria-label="Engine build"
								value={build}
								onChange={(event) => setBuild(event.target.value as ServerBuildChoice)}
								className="flex-1 p-1.5 rounded border bg-transparent outline-none text-xs"
								style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
								data-testid="model-server-build"
							>
								{engine.builds.map((option) => (
									<option key={option.choice} value={option.choice}>
										{`${option.choice === 'default' ? `Default (${option.label})` : option.label}, ${formatSize(option.downloadBytes)}`}
									</option>
								))}
							</select>
							<CardButton
								theme={theme}
								primary={!engine.installed || engine.stale}
								onClick={() => void server.installEngine(build)}
								disabled={acting || !selectedBuild}
								testId="model-server-install"
							>
								{engine.installed ? (
									<RefreshCw className="w-3 h-3" />
								) : (
									<Download className="w-3 h-3" />
								)}
								{engine.installed ? 'Install again' : 'Install'}
							</CardButton>
						</div>
					)
				)}
				{!installing && (build === 'cuda' || build === 'rocm') && (
					<p className="text-xs-plus opacity-55">
						The {build === 'cuda' ? 'CUDA' : 'ROCm'} build is large and needs a matching driver.
						Default works on any GPU.
					</p>
				)}
			</div>

			{/* Address */}
			<div className="space-y-1" data-testid="model-server-address">
				<CardRowTitle theme={theme}>Address</CardRowTitle>
				{status.baseUrl ? (
					<div className="flex items-center gap-1">
						<code className="text-xs select-text">{status.baseUrl}</code>
						<CopyIconButton
							value={status.baseUrl}
							theme={theme}
							title="Copy address"
							iconClassName="w-3.5 h-3.5"
							flash
						/>
					</div>
				) : (
					<p className="text-xs opacity-70">
						A port is chosen the first time the server starts, and kept.
					</p>
				)}
			</div>

			{/* Who can reach it */}
			<div className="space-y-2" data-testid="model-server-bind">
				<CardRowTitle theme={theme}>Who can reach it</CardRowTitle>
				<p className="text-xs opacity-70">
					{status.bind === 'network'
						? `Listening on every interface (${MODEL_SERVER_BIND_HOSTS.network}).`
						: `This computer only (${MODEL_SERVER_BIND_HOSTS.local}).`}{' '}
					Every request must send the key, in both modes.
				</p>
				{status.bind === 'network' && (
					<CardWarning theme={theme}>
						Other machines on your network can reach the server. Anyone with the key can use your
						models.
					</CardWarning>
				)}
				<ToggleButtonGroup<ModelServerBind>
					theme={theme}
					options={[
						{ value: 'local', label: 'Local only' },
						{ value: 'network', label: 'Network' },
					]}
					value={status.bind}
					onChange={(bind) => {
						if (bind !== status.bind) void server.setBind(bind);
					}}
					disabled={acting}
				/>
			</div>

			{/* Models loaded at once */}
			<div className="space-y-2">
				<CardRowTitle theme={theme}>Models loaded at once</CardRowTitle>
				<p className="text-xs opacity-70">
					Loading one more unloads the least recently used. Each loaded model holds its weights in
					memory.
				</p>
				<select
					aria-label="Models loaded at once"
					value={status.maxModels}
					onChange={(event) => void server.setMaxModels(Number(event.target.value))}
					disabled={acting}
					className="w-full p-1.5 rounded border bg-transparent outline-none text-xs"
					style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					data-testid="model-server-max-models"
				>
					{Array.from({ length: MAX_MODEL_SERVER_MAX_MODELS }, (_, index) => index + 1).map(
						(count) => (
							<option key={count} value={count}>
								{count}
							</option>
						)
					)}
				</select>
			</div>

			{/* API key */}
			<div className="space-y-2" data-testid="model-server-key">
				<CardRowTitle theme={theme}>API key</CardRowTitle>
				<p className="text-xs opacity-70">
					A harness sends it as <code>Authorization: Bearer</code> or <code>x-api-key</code>.{' '}
					{status.keyStorage === 'os'
						? 'Stored sealed by the system key store.'
						: status.keyStorage === null
							? 'Made the first time you copy it or start the server.'
							: ''}
				</p>
				{status.keyStorage === 'obscured' && (
					<CardWarning theme={theme}>
						This system has no key store, so the key is stored obscured, not encrypted.
					</CardWarning>
				)}
				{confirmingRotate && (
					<CardWarning theme={theme}>
						Rotating makes the current key stop working. Anything set up with it needs the new key.
					</CardWarning>
				)}
				<div className="flex items-center gap-2">
					<code className="text-xs opacity-70 flex-1">{MODEL_SERVER_KEY_PLACEHOLDER}</code>
					<CardButton theme={theme} onClick={() => void copyKey()} testId="model-server-copy-key">
						Copy
					</CardButton>
					{confirmingRotate ? (
						<>
							<CardButton
								theme={theme}
								primary
								onClick={() => {
									setConfirmingRotate(false);
									void server.rotateKey();
								}}
								disabled={acting}
								testId="model-server-rotate-confirm"
							>
								Rotate
							</CardButton>
							<CardButton theme={theme} onClick={() => setConfirmingRotate(false)}>
								Keep
							</CardButton>
						</>
					) : (
						<CardButton
							theme={theme}
							onClick={() => setConfirmingRotate(true)}
							disabled={acting}
							testId="model-server-rotate"
						>
							<RefreshCw className="w-3 h-3" />
							{busy === 'rotate' ? 'Rotating...' : 'Rotate'}
						</CardButton>
					)}
				</div>
			</div>

			{/* Loaded models */}
			{status.state === 'running' && (
				<div className="space-y-1" data-testid="model-server-loaded">
					<CardRowTitle theme={theme}>Loaded</CardRowTitle>
					{loaded.length === 0 ? (
						<p className="text-xs opacity-70">
							No model is loaded. A model loads when a request names it
							{status.models.length > 0 ? ` (${status.models.join(', ')})` : ''}.
						</p>
					) : (
						loaded.map((model) => (
							<p key={model.id} className="text-xs">
								{model.displayName}{' '}
								<span className="opacity-70">
									about {formatSize(model.approxBytes)} of weights in memory
								</span>
							</p>
						))
					)}
				</div>
			)}
		</SectionCard>
	);
}

export interface LocalModelsServerSectionProps {
	theme: Theme;
}

/** The section: heading plus card, with its own `useModelServer()`. */
export function LocalModelsServerSection({ theme }: LocalModelsServerSectionProps) {
	const server = useModelServer();
	return (
		<div data-setting-id="local-models-model-server">
			<SettingsSectionHeading
				icon={Server}
				description="Maestro's own model server, for pointing an agent harness at a downloaded model."
			>
				Model server
			</SettingsSectionHeading>
			<LocalModelsServerCard theme={theme} server={server} />
		</div>
	);
}
