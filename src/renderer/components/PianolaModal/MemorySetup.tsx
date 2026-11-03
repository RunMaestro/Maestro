import { useState } from 'react';
import type { CSSProperties } from 'react';
import type { Theme } from '../../types';
import type {
	MemoryConfig,
	MemoryQualificationConfig,
	MemoryState,
} from '../../../shared/pianola/memory';
import {
	MEMORY_PROVIDER_PRESETS,
	memoryProviderId,
	memoryProviderPreset,
	withMemoryProvider,
	type MemoryProviderId,
} from '../../../shared/pianola/memory-providers';

const HISTORY_PROVIDERS = [
	['claude-code', 'Claude Code'],
	['codex', 'Codex'],
	['opencode', 'OpenCode'],
	['factory-droid', 'Factory Droid'],
	['copilot-cli', 'Copilot CLI'],
	['omp', 'Oh My Pi'],
	['grok', 'Grok'],
] as const;

interface MemorySetupProps {
	theme: Theme;
	config: MemoryConfig;
	progress: MemoryState['progress'];
	cliProviders?: MemoryState['cliProviders'];
	apiCredentials?: MemoryState['apiCredentials'];
	busy: boolean;
	onChange: (config: MemoryConfig) => void;
	onSave: () => void;
	onStart: () => void;
	onPause: () => void;
}

/** Present the provider, privacy, and history choices needed to start learning safely. */
export function MemorySetup({
	theme,
	config,
	progress,
	cliProviders = [],
	apiCredentials,
	busy,
	onChange,
	onSave,
	onStart,
	onPause,
}: MemorySetupProps) {
	const [rootPath, setRootPath] = useState('');
	const [rootProvider, setRootProvider] = useState('claude-code');
	const provider = memoryProviderPreset(memoryProviderId(config));
	const offDevice = config.mode !== 'local';
	const api = config.mode === 'hosted' || config.mode === 'batch';
	const cli = config.mode === 'cli';
	const selectedCli = cliProviders.find((candidate) => candidate.id === config.cliProvider);
	const credentialDetected = provider.credentialEnv.some((name) => apiCredentials?.[name]);
	const credentialsMissing = api && apiCredentials !== undefined && !credentialDetected;
	const style: CSSProperties = {
		color: theme.colors.textMain,
		backgroundColor: theme.colors.bgMain,
		borderColor: theme.colors.border,
	};
	const button = 'px-3 py-1.5 rounded border text-xs font-medium disabled:opacity-50';
	const input = 'w-full rounded border px-2 py-1.5 text-sm';
	const updateRoot = (index: number, update: Partial<MemoryConfig['roots'][number]>) =>
		onChange({
			...config,
			roots: config.roots.map((root, i) => (i === index ? { ...root, ...update } : root)),
		});

	return (
		<div className="space-y-5">
			<section className="space-y-3">
				<div className="flex flex-wrap items-end justify-between gap-3">
					<label className="flex gap-2 items-start">
						<input
							type="checkbox"
							className="mt-0.5"
							checked={config.enabled}
							onChange={(e) => onChange({ ...config, enabled: e.target.checked })}
						/>
						<span>
							<span className="block font-medium">Enable memory</span>
							<span className="block text-xs" style={{ color: theme.colors.textDim }}>
								Learn useful context from the history you select below.
							</span>
						</span>
					</label>
					<label className="w-full sm:w-80 space-y-1">
						<span className="font-medium">Processing provider</span>
						<select
							aria-label="Processing provider"
							className={input}
							style={style}
							value={provider.id}
							onChange={(e) =>
								onChange(
									withMemoryProvider(config, e.target.value as MemoryProviderId, cliProviders)
								)
							}
						>
							{MEMORY_PROVIDER_PRESETS.filter(
								(preset) =>
									preset.mode !== 'cli' ||
									preset.id === provider.id ||
									cliProviders.some((candidate) => candidate.id === preset.cliProvider)
							).map((preset) => (
								<option key={preset.id} value={preset.id}>
									{preset.label}
								</option>
							))}
						</select>
						<span className="block text-xs" style={{ color: theme.colors.textDim }}>
							{provider.description}
						</span>
						{cli && selectedCli && (
							<span
								className="block truncate text-xs"
								style={{ color: theme.colors.textDim }}
								title={selectedCli.path}
							>
								Detected: {selectedCli.model || 'CLI default model'} · {selectedCli.path}
							</span>
						)}
						{cli && !selectedCli && (
							<span className="block text-xs" style={{ color: theme.colors.error }}>
								This CLI is no longer detected. Choose another provider or reinstall it.
							</span>
						)}
					</label>
				</div>
				{offDevice && (
					<div className="space-y-2 border-l-2 pl-3" style={{ borderColor: theme.colors.border }}>
						<label className="flex gap-2 items-start">
							<input
								type="checkbox"
								className="mt-0.5"
								checked={config.hostedConsent}
								onChange={(e) => onChange({ ...config, hostedConsent: e.target.checked })}
							/>
							<span>Allow {provider.label} to process selected transcript excerpts</span>
						</label>
						<p className="text-xs" style={{ color: theme.colors.textDim }}>
							{cli
								? 'Uses the detected CLI and its configured account. '
								: credentialDetected
									? 'API credential detected in Maestro’s environment. '
									: `Requires ${provider.credentialEnv.join(' or ')} in Maestro's environment. `}
							Selected excerpts leave this device; secret filtering is not a privacy guarantee.
						</p>
						{api && (
							<label className="flex flex-wrap items-center gap-2 text-xs">
								<span>Spending limit (USD)</span>
								<input
									aria-label="Spending limit (USD)"
									type="number"
									min="0"
									step="1"
									className="w-24 rounded border px-2 py-1 text-sm"
									style={style}
									value={config.dollarBudget}
									onChange={(e) => onChange({ ...config, dollarBudget: Number(e.target.value) })}
								/>
								<span style={{ color: theme.colors.textDim }}>0 blocks additional spend</span>
							</label>
						)}
					</div>
				)}
			</section>

			<section className="space-y-3">
				<div>
					<h3 className="font-medium">History to learn from</h3>
					<p className="text-xs" style={{ color: theme.colors.textDim }}>
						Only enabled sources attributed to you are eligible. Automated history cannot establish
						your preferences.
					</p>
				</div>
				<div
					className="overflow-hidden rounded border"
					style={{ borderColor: theme.colors.border }}
				>
					{config.roots.map((root, index) => (
						<div
							key={root.provider + root.path}
							className="flex flex-col gap-2 border-b px-3 py-2 last:border-b-0 sm:flex-row sm:items-center"
							style={{ borderColor: theme.colors.border }}
						>
							<label className="flex min-w-0 flex-1 items-start gap-2">
								<input
									type="checkbox"
									className="mt-0.5"
									checked={root.enabled}
									onChange={(e) => updateRoot(index, { enabled: e.target.checked })}
								/>
								<span className="min-w-0">
									<span className="block">
										{HISTORY_PROVIDERS.find(([id]) => id === root.provider)?.[1] ?? root.provider}
									</span>
									<span
										className="block truncate font-mono text-xs"
										style={{ color: theme.colors.textDim }}
										title={root.path}
									>
										{root.path}
									</span>
								</span>
							</label>
							<select
								aria-label={'Ownership of ' + root.path}
								className="w-full rounded border px-2 py-1 text-xs sm:w-60 sm:shrink-0"
								style={style}
								value={root.userId === config.userId ? root.authorship : 'unassigned'}
								onChange={(e) =>
									updateRoot(index, {
										userId: e.target.value === 'unassigned' ? null : config.userId,
										authorship:
											e.target.value === 'human'
												? 'human'
												: e.target.value === 'automated'
													? 'automated'
													: 'unknown',
									})
								}
							>
								<option value="unassigned">Not my history</option>
								<option value="human">My conversations</option>
								<option value="unknown">My account (mixed/unknown)</option>
								<option value="automated">Automated or delegated history</option>
							</select>
						</div>
					))}
				</div>
				<label className="block space-y-1">
					<span>Privacy exclusions</span>
					<textarea
						aria-label="Privacy exclusions"
						className={input}
						style={style}
						rows={2}
						value={config.exclusions.join('\n')}
						placeholder="Absolute paths to exclude, one per line"
						onChange={(e) =>
							onChange({ ...config, exclusions: e.target.value.split('\n').filter(Boolean) })
						}
					/>
				</label>
				<label className="flex gap-2">
					<input
						type="checkbox"
						checked={config.ongoing}
						onChange={(e) => onChange({ ...config, ongoing: e.target.checked })}
					/>
					Keep learning from new activity in selected history
				</label>
			</section>

			<details className="border-t pt-3" style={{ borderColor: theme.colors.border }}>
				<summary className="cursor-pointer select-none text-xs font-medium">
					Advanced settings
				</summary>
				<div className="pt-4 space-y-5">
					<section className="space-y-3">
						<h3 className="text-sm font-medium">Extraction</h3>
						<div className="grid grid-cols-2 gap-3">
							<label>
								Extraction model
								<input
									aria-label="Extraction model"
									className={input}
									style={style}
									value={config.model}
									placeholder={cli ? 'CLI default (automatic)' : undefined}
									onChange={(e) => onChange({ ...config, model: e.target.value })}
								/>
								{cli && (
									<span className="block text-xs" style={{ color: theme.colors.textDim }}>
										Auto-filled from CLI settings. Leave blank to use the CLI default.
									</span>
								)}
							</label>
							{config.mode === 'local' && (
								<label>
									Local endpoint
									<input
										aria-label="Local endpoint"
										className={input}
										style={style}
										value={config.endpoint}
										onChange={(e) => onChange({ ...config, endpoint: e.target.value })}
									/>
								</label>
							)}
							<label>
								Total token cap
								<input
									type="number"
									min="0"
									className={input}
									style={style}
									value={config.tokenBudget}
									onChange={(e) => onChange({ ...config, tokenBudget: Number(e.target.value) })}
								/>
							</label>
							{!api && (
								<label>
									Lifetime dollar cap (USD)
									<input
										aria-label="Lifetime dollar cap (USD)"
										type="number"
										min="0"
										step="1"
										className={input}
										style={style}
										value={config.dollarBudget}
										onChange={(e) => onChange({ ...config, dollarBudget: Number(e.target.value) })}
									/>
								</label>
							)}
							{api && (
								<>
									<label>
										Input $ / million tokens
										<input
											type="number"
											min="0"
											step="0.01"
											className={input}
											style={style}
											value={config.inputPrice}
											onChange={(e) => onChange({ ...config, inputPrice: Number(e.target.value) })}
										/>
									</label>
									<label>
										Output $ / million tokens
										<input
											type="number"
											min="0"
											step="0.01"
											className={input}
											style={style}
											value={config.outputPrice}
											onChange={(e) => onChange({ ...config, outputPrice: Number(e.target.value) })}
										/>
									</label>
								</>
							)}
						</div>
					</section>

					<section className="space-y-3">
						<div>
							<h3 className="text-sm font-medium">Recall qualification</h3>
							<p className="text-xs" style={{ color: theme.colors.textDim }}>
								Optional model review of whether recalled evidence answers a question.
							</p>
						</div>
						<div className="grid grid-cols-2 gap-2">
							<label>
								Qualification provider
								<select
									className={input}
									style={style}
									value={config.qualification?.provider ?? 'local'}
									onChange={(e) =>
										onChange({
											...config,
											qualification: {
												provider: e.target.value as MemoryQualificationConfig['provider'],
												model: config.qualification?.model ?? 'qwen3:8b',
												endpoint: config.qualification?.endpoint ?? 'http://127.0.0.1:11434',
											},
										})
									}
								>
									<option value="local">Local Ollama</option>
									<option value="hosted">Hosted API</option>
								</select>
							</label>
							<label>
								Qualification model
								<input
									className={input}
									style={style}
									value={config.qualification?.model ?? 'qwen3:8b'}
									onChange={(e) =>
										onChange({
											...config,
											qualification: {
												provider: config.qualification?.provider ?? 'local',
												model: e.target.value,
												endpoint: config.qualification?.endpoint ?? 'http://127.0.0.1:11434',
											},
										})
									}
								/>
							</label>
							<label className="col-span-2">
								Qualification endpoint
								<input
									className={input}
									style={style}
									value={config.qualification?.endpoint ?? 'http://127.0.0.1:11434'}
									onChange={(e) =>
										onChange({
											...config,
											qualification: {
												provider: config.qualification?.provider ?? 'local',
												model: config.qualification?.model ?? 'qwen3:8b',
												endpoint: e.target.value,
											},
										})
									}
								/>
							</label>
						</div>
						<p className="text-xs" style={{ color: theme.colors.textDim }}>
							{config.qualification?.provider === 'hosted'
								? 'Hosted qualification sends the question and candidate assertions to the configured API and requires its environment credential.'
								: 'Local qualification keeps the question and candidate assertions on this device.'}
						</p>
					</section>

					<section className="space-y-3">
						<div>
							<h3 className="text-sm font-medium">Recall reranking</h3>
							<p className="text-xs" style={{ color: theme.colors.textDim }}>
								Optional hosted ordering of a recall shortlist. It does not change evidence
								eligibility.
							</p>
						</div>
						<div className="grid grid-cols-2 gap-2">
							<label>
								Reranker model
								<input
									className={input}
									style={style}
									value={config.rerank?.model ?? 'rerank'}
									onChange={(e) =>
										onChange({
											...config,
											rerank: {
												...config.rerank,
												provider: 'hosted',
												model: e.target.value,
												endpoint: config.rerank?.endpoint ?? 'https://api.nan.builders',
											},
										})
									}
								/>
							</label>
							<label>
								Reranker endpoint
								<input
									className={input}
									style={style}
									value={config.rerank?.endpoint ?? 'https://api.nan.builders'}
									onChange={(e) =>
										onChange({
											...config,
											rerank: {
												...config.rerank,
												provider: 'hosted',
												model: config.rerank?.model ?? 'rerank',
												endpoint: e.target.value,
											},
										})
									}
								/>
							</label>
						</div>
						<p className="text-xs" style={{ color: theme.colors.textDim }}>
							Hosted reranking sends the question and shortlisted assertions to the configured API.
							Local recall remains available without it.
						</p>
					</section>

					<section className="space-y-2">
						<h3 className="text-sm font-medium">Custom history source</h3>
						<div className="flex gap-2">
							<select
								aria-label="Custom root provider"
								style={style}
								value={rootProvider}
								onChange={(e) => setRootProvider(e.target.value)}
							>
								{HISTORY_PROVIDERS.map(([id, label]) => (
									<option key={id} value={id}>
										{label}
									</option>
								))}
							</select>
							<input
								aria-label="Custom account root"
								className={input}
								style={style}
								value={rootPath}
								onChange={(e) => setRootPath(e.target.value)}
								placeholder="Absolute account/data root"
							/>
							<button
								className={button}
								style={style}
								disabled={!rootPath}
								onClick={() => {
									onChange({
										...config,
										roots: [
											...config.roots,
											{
												provider: rootProvider,
												path: rootPath,
												userId: null,
												authorship: 'unknown',
												enabled: false,
											},
										],
									});
									setRootPath('');
								}}
							>
								Add source
							</button>
						</div>
					</section>
				</div>
			</details>

			<div
				className="sticky bottom-0 z-10 -mx-4 -mb-4 flex flex-wrap items-center gap-2 border-t px-4 py-3"
				style={{ backgroundColor: theme.colors.bgMain, borderColor: theme.colors.border }}
			>
				<button
					className={button}
					style={{ ...style, borderColor: theme.colors.accent }}
					disabled={
						busy ||
						!config.enabled ||
						(offDevice && !config.hostedConsent) ||
						credentialsMissing ||
						(cli && !selectedCli)
					}
					onClick={onStart}
				>
					{progress.paused ? 'Save & resume learning' : 'Save & start learning'}
				</button>
				<button className={button} style={style} disabled={busy} onClick={onSave}>
					Save settings
				</button>
				{(progress.running || progress.paused) && (
					<button className={button} style={style} disabled={busy} onClick={onPause}>
						Pause learning
					</button>
				)}
				<span className="ml-auto text-xs" style={{ color: theme.colors.textDim }}>
					{config.roots.filter((root) => root.enabled && root.userId === config.userId).length} of{' '}
					{config.roots.length} sources eligible
				</span>
			</div>
		</div>
	);
}
