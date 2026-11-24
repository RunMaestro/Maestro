/** Install only the missing files behind a refused voice start, in the HUD. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { formatSize } from '../../../shared/formatters';
import { readinessErrorMessage } from '../../../shared/acappella/readiness';
import { useLocalModels, useLocalRuntimes } from '../../hooks/localModels';
import type { Theme } from '../../types';
import { ProgressBar } from '../ui/ProgressBar';

const readReadiness = () => window.maestro.voice.models.readiness();

export function VoiceSetupRecovery({
	theme,
	fallback,
	onReady,
}: {
	theme: Theme;
	fallback: ReactNode;
	onReady: () => Promise<void>;
}) {
	const models = useLocalModels({ loadExtra: readReadiness });
	const runtimes = useLocalRuntimes();
	const mounted = useRef(true);
	const running = useRef(false);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	const [job, setJob] = useState<{
		kind: 'runtime' | 'model';
		id: string;
		label: string;
		bytes: number;
		completed: number;
		total: number;
	} | null>(null);

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const missing = useMemo(() => {
		const modelIds = new Set<string>();
		const runtimeIds = new Set<string>();
		for (const slot of models.extra?.blocking ?? []) {
			if (!slot.requiredModelId) continue;
			const model = models.listings.find((item) => item.entry.id === slot.requiredModelId);
			if (!model) continue;
			const runtime = runtimes.listings.find((item) => item.id === model.entry.runtime);
			const missingRuntime = runtime?.downloadable && (!runtime.installed || runtime.stale);
			// An installed engine that cannot load is not fixed by fetching weights.
			if (slot.reason === 'runtime-unavailable' && !missingRuntime) continue;
			if (
				!['runtime-unavailable', 'model-not-installed', 'model-corrupt'].includes(slot.reason ?? '')
			)
				continue;
			if (missingRuntime) runtimeIds.add(runtime.id);
			if (model.status.status !== 'installed') modelIds.add(model.entry.id);
		}
		return {
			models: models.listings.filter((item) => modelIds.has(item.entry.id)),
			runtimes: runtimes.listings.filter((item) => runtimeIds.has(item.id)),
		};
	}, [models.extra, models.listings, runtimes.listings]);

	const totalBytes =
		missing.models.reduce((sum, item) => sum + item.entry.bytes, 0) +
		missing.runtimes.reduce((sum, item) => sum + item.bytes, 0);
	const available = missing.models.length + missing.runtimes.length > 0;

	const setup = async () => {
		if (running.current) return;
		running.current = true;
		setBusy(true);
		setFailure(null);
		let completed = 0;
		try {
			for (const runtime of missing.runtimes) {
				setJob({
					kind: 'runtime',
					id: runtime.id,
					label: `Installing ${runtime.label}`,
					bytes: runtime.bytes,
					completed,
					total: totalBytes,
				});
				await window.maestro.localModels.runtimes.install(runtime.id);
				if (!mounted.current) return;
				completed += runtime.bytes;
			}
			for (const model of missing.models) {
				setJob({
					kind: 'model',
					id: model.entry.id,
					label: `Downloading ${model.entry.displayName}`,
					bytes: model.entry.bytes,
					completed,
					total: totalBytes,
				});
				const result = await window.maestro.localModels.download(model.entry.id);
				if (!mounted.current) return;
				if (result.status !== 'complete')
					throw new Error(
						result.error ?? `Download ${result.status}. Press Set up voice to retry.`
					);
				if (result.runtime.status === 'failed' || result.runtime.status === 'unavailable') {
					throw new Error(result.runtime.error ?? 'The speech engine could not be installed.');
				}
				completed += model.entry.bytes;
			}
			await Promise.all([models.refresh(), runtimes.refresh()]);
			if (!mounted.current) return;
			const readiness = await readReadiness();
			if (!mounted.current) return;
			if (!readiness.canStartSession) throw new Error(readinessErrorMessage(readiness));
			await onReady();
		} catch (error) {
			if (mounted.current) setFailure(error instanceof Error ? error.message : String(error));
		} finally {
			running.current = false;
			if (mounted.current) {
				setBusy(false);
				setJob(null);
			}
		}
	};

	if (!available && !busy && !failure) return fallback;
	const received =
		job?.kind === 'runtime'
			? (runtimes.progress[job.id]?.bytes ?? 0)
			: job
				? (models.progress[job.id]?.bytesReceived ?? 0)
				: 0;

	return (
		<div
			data-testid="voice-setup-recovery"
			className="space-y-2"
			style={{ color: theme.colors.textMain }}
		>
			<div className="font-medium">Voice setup needed</div>
			<p>Download the missing speech models and engines, then voice will start here.</p>
			{failure && (
				<p role="alert" style={{ color: theme.colors.error }}>
					{failure}
				</p>
			)}
			{busy && job && (
				<div className="space-y-1">
					<div role="status">{job.label}...</div>
					<ProgressBar
						theme={theme}
						label="Voice setup download"
						height={4}
						value={job.completed + Math.min(job.bytes, received)}
						total={job.total}
					/>
				</div>
			)}
			<button
				type="button"
				onClick={() => void setup()}
				disabled={busy || models.loading || runtimes.loading}
				className="px-2 py-1 rounded border text-xs disabled:opacity-50"
				style={{ borderColor: theme.colors.accent, backgroundColor: theme.colors.accentDim }}
			>
				{busy ? 'Setting up voice...' : `Set up voice (${formatSize(totalBytes)})`}
			</button>
		</div>
	);
}
