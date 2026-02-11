import React, { useState, useCallback, useEffect } from 'react';
import {
	FileText,
	FolderOpen,
	Activity,
	Cpu,
	Database,
	FileBarChart,
	RefreshCw,
	AlertCircle,
	CheckCircle2,
	Shield,
	Loader2,
	AlertTriangle,
} from 'lucide-react';
import type { Theme } from '../../types';
import type { UseVibesDataReturn } from '../../hooks';
import type { VibesAssuranceLevel } from '../../../shared/vibes-types';
import { VibesLiveMonitor } from './VibesLiveMonitor';

interface VibesDashboardProps {
	theme: Theme;
	projectPath: string | undefined;
	vibesData: UseVibesDataReturn;
	vibesEnabled: boolean;
	vibesAssuranceLevel: VibesAssuranceLevel;
}

/** Color mapping for assurance level badges. */
const ASSURANCE_COLORS: Record<VibesAssuranceLevel, { bg: string; text: string; label: string }> = {
	low: { bg: 'rgba(234, 179, 8, 0.15)', text: '#eab308', label: 'Low' },
	medium: { bg: 'rgba(59, 130, 246, 0.15)', text: '#3b82f6', label: 'Medium' },
	high: { bg: 'rgba(34, 197, 94, 0.15)', text: '#22c55e', label: 'High' },
};

/**
 * VIBES Dashboard — main overview shown when the VIBES tab is opened.
 *
 * Displays a status banner, stats cards row, assurance level indicator,
 * and quick-action buttons for common VIBES operations.
 */
export const VibesDashboard: React.FC<VibesDashboardProps> = ({
	theme,
	projectPath,
	vibesData,
	vibesEnabled,
	vibesAssuranceLevel,
}) => {
	const { isInitialized, stats, isLoading, error, refresh, initialize } = vibesData;
	const [initProjectName, setInitProjectName] = useState('');
	const [isInitializing, setIsInitializing] = useState(false);
	const [actionStatus, setActionStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
	const [binaryStatus, setBinaryStatus] = useState<'checking' | 'found' | 'not-found'>('checking');

	// Check vibescheck binary availability on mount
	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const path = await window.maestro.vibes.findBinary();
				if (!cancelled) {
					setBinaryStatus(path ? 'found' : 'not-found');
				}
			} catch {
				if (!cancelled) {
					setBinaryStatus('not-found');
				}
			}
		})();
		return () => { cancelled = true; };
	}, []);

	// ========================================================================
	// Quick Actions
	// ========================================================================

	const handleBuildDatabase = useCallback(async () => {
		if (!projectPath) return;
		setActionStatus(null);
		try {
			const result = await window.maestro.vibes.build(projectPath);
			if (result.success) {
				setActionStatus({ type: 'success', message: 'Database built successfully' });
				refresh();
			} else {
				setActionStatus({ type: 'error', message: result.error ?? 'Build failed' });
			}
		} catch (err) {
			setActionStatus({
				type: 'error',
				message: err instanceof Error ? err.message : 'Build failed',
			});
		}
	}, [projectPath, refresh]);

	const handleGenerateReport = useCallback(async () => {
		if (!projectPath) return;
		setActionStatus(null);
		try {
			const result = await window.maestro.vibes.getReport(projectPath, 'markdown');
			if (result.success) {
				setActionStatus({ type: 'success', message: 'Report generated successfully' });
			} else {
				setActionStatus({ type: 'error', message: result.error ?? 'Report generation failed' });
			}
		} catch (err) {
			setActionStatus({
				type: 'error',
				message: err instanceof Error ? err.message : 'Report generation failed',
			});
		}
	}, [projectPath]);

	const handleInitialize = useCallback(async () => {
		const name = initProjectName.trim();
		if (!name) return;
		setIsInitializing(true);
		setActionStatus(null);
		try {
			await initialize(name);
			setInitProjectName('');
			setActionStatus({ type: 'success', message: 'VIBES initialized for this project' });
		} catch (err) {
			setActionStatus({
				type: 'error',
				message: err instanceof Error ? err.message : 'Initialization failed',
			});
		} finally {
			setIsInitializing(false);
		}
	}, [initProjectName, initialize]);

	// ========================================================================
	// Status Banner — disabled / not initialized / error states
	// ========================================================================

	if (!vibesEnabled) {
		return (
			<div className="flex flex-col items-center justify-center gap-3 py-12 px-4 text-center">
				<Shield className="w-8 h-8 opacity-40" style={{ color: theme.colors.textDim }} />
				<span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					VIBES is disabled
				</span>
				<span className="text-xs" style={{ color: theme.colors.textDim }}>
					Enable VIBES in Settings to start tracking AI attribution metadata.
				</span>
			</div>
		);
	}

	if (isLoading && !isInitialized && !stats) {
		return (
			<div className="flex flex-col items-center justify-center gap-3 py-12 px-4 text-center">
				<Loader2 className="w-6 h-6 animate-spin" style={{ color: theme.colors.textDim }} />
				<span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					Initializing...
				</span>
				<span className="text-xs" style={{ color: theme.colors.textDim }}>
					Loading VIBES data for this project.
				</span>
			</div>
		);
	}

	if (!isInitialized && !isLoading) {
		return (
			<div className="flex flex-col items-center justify-center gap-4 py-12 px-4 text-center">
				<Shield className="w-8 h-8 opacity-40" style={{ color: theme.colors.textDim }} />
				<span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					VIBES not initialized
				</span>
				<span className="text-xs max-w-xs" style={{ color: theme.colors.textDim }}>
					No <code>.ai-audit/</code> directory found for this project. Initialize VIBES to start recording AI attribution metadata.
				</span>
				<div className="flex items-center gap-2 mt-2">
					<input
						type="text"
						placeholder="Project name"
						value={initProjectName}
						onChange={(e) => setInitProjectName(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter') handleInitialize();
						}}
						className="px-3 py-1.5 rounded text-xs outline-none"
						style={{
							backgroundColor: theme.colors.bgMain,
							border: `1px solid ${theme.colors.border}`,
							color: theme.colors.textMain,
						}}
					/>
					<button
						onClick={handleInitialize}
						disabled={!initProjectName.trim() || isInitializing}
						className="px-3 py-1.5 rounded text-xs font-medium transition-opacity"
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.accentForeground,
							opacity: !initProjectName.trim() || isInitializing ? 0.5 : 1,
						}}
					>
						{isInitializing ? 'Initializing...' : 'Initialize'}
					</button>
				</div>
				{actionStatus && (
					<StatusMessage theme={theme} status={actionStatus} onDismiss={() => setActionStatus(null)} />
				)}
			</div>
		);
	}

	// ========================================================================
	// Main Dashboard
	// ========================================================================

	const effectiveLevel = stats?.assuranceLevel ?? vibesAssuranceLevel;
	const assurance = ASSURANCE_COLORS[effectiveLevel];

	return (
		<div className="flex flex-col gap-4 py-3">
			{/* Status Banner */}
			<div
				className="flex items-center gap-2 px-3 py-2 rounded text-xs"
				style={{
					backgroundColor: theme.colors.bgActivity,
					border: `1px solid ${theme.colors.border}`,
				}}
			>
				<CheckCircle2 className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.success }} />
				<span style={{ color: theme.colors.textMain }}>
					VIBES is active
				</span>
				<span style={{ color: theme.colors.textDim }}>—</span>
				<span
					className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase"
					style={{
						backgroundColor: assurance.bg,
						color: assurance.text,
					}}
				>
					{assurance.label}
				</span>
				<span className="text-[10px] ml-auto" style={{ color: theme.colors.textDim }}>
					assurance level
				</span>
			</div>

			{/* Binary Not Found Warning */}
			{binaryStatus === 'not-found' && (
				<div
					className="flex flex-col gap-1.5 px-3 py-2.5 rounded text-xs"
					style={{
						backgroundColor: 'rgba(234, 179, 8, 0.1)',
						border: '1px solid rgba(234, 179, 8, 0.3)',
					}}
				>
					<div className="flex items-center gap-2">
						<AlertTriangle className="w-3.5 h-3.5 shrink-0" style={{ color: '#eab308' }} />
						<span className="font-medium" style={{ color: '#eab308' }}>
							vibescheck binary not found
						</span>
					</div>
					<span style={{ color: theme.colors.textDim }}>
						Some features (blame, reports, build) require the vibescheck CLI.
						Install with <code className="font-mono px-1 py-0.5 rounded" style={{ backgroundColor: theme.colors.bgActivity }}>cargo install vibescheck</code> or configure the path in Settings.
					</span>
				</div>
			)}

			{/* Error Banner */}
			{error && (
				<div
					className="flex items-center gap-2 px-3 py-2 rounded text-xs"
					style={{
						backgroundColor: 'rgba(239, 68, 68, 0.1)',
						border: '1px solid rgba(239, 68, 68, 0.3)',
					}}
				>
					<AlertCircle className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.error }} />
					<span style={{ color: theme.colors.error }}>{error}</span>
				</div>
			)}

			{/* Stats Cards */}
			<div className="grid grid-cols-2 gap-2">
				<StatsCard
					theme={theme}
					icon={<FileText className="w-4 h-4" />}
					label="Annotations"
					value={stats?.totalAnnotations ?? 0}
					isLoading={isLoading}
				/>
				<StatsCard
					theme={theme}
					icon={<FolderOpen className="w-4 h-4" />}
					label="Coverage"
					value={
						stats
							? `${stats.filesCovered}/${stats.totalTrackedFiles}`
							: '0/0'
					}
					subtitle={
						stats && stats.totalTrackedFiles > 0
							? `${stats.coveragePercent.toFixed(0)}%`
							: undefined
					}
					isLoading={isLoading}
				/>
				<StatsCard
					theme={theme}
					icon={<Activity className="w-4 h-4" />}
					label="Sessions"
					value={stats?.activeSessions ?? 0}
					isLoading={isLoading}
				/>
				<StatsCard
					theme={theme}
					icon={<Cpu className="w-4 h-4" />}
					label="Models"
					value={stats?.contributingModels ?? 0}
					isLoading={isLoading}
				/>
			</div>

			{/* Quick Actions */}
			<div className="flex flex-col gap-1.5">
				<span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: theme.colors.textDim }}>
					Quick Actions
				</span>
				<div className="flex gap-2">
					<ActionButton
						theme={theme}
						icon={<Database className="w-3.5 h-3.5" />}
						label="Build Database"
						onClick={handleBuildDatabase}
					/>
					<ActionButton
						theme={theme}
						icon={<FileBarChart className="w-3.5 h-3.5" />}
						label="Generate Report"
						onClick={handleGenerateReport}
					/>
					<ActionButton
						theme={theme}
						icon={<RefreshCw className="w-3.5 h-3.5" />}
						label="Refresh"
						onClick={refresh}
					/>
				</div>
			</div>

			{/* Live Monitor */}
			<VibesLiveMonitor theme={theme} projectPath={projectPath} />

			{/* Action Status */}
			{actionStatus && (
				<StatusMessage theme={theme} status={actionStatus} onDismiss={() => setActionStatus(null)} />
			)}
		</div>
	);
};

// ============================================================================
// Sub-components
// ============================================================================

interface StatsCardProps {
	theme: Theme;
	icon: React.ReactNode;
	label: string;
	value: number | string;
	subtitle?: string;
	isLoading: boolean;
}

const StatsCard: React.FC<StatsCardProps> = ({ theme, icon, label, value, subtitle, isLoading }) => (
	<div
		className="flex flex-col gap-1 px-3 py-2.5 rounded"
		style={{
			backgroundColor: theme.colors.bgActivity,
			border: `1px solid ${theme.colors.border}`,
		}}
	>
		<div className="flex items-center gap-1.5">
			<span style={{ color: theme.colors.textDim }}>{icon}</span>
			<span className="text-[10px] uppercase tracking-wider font-medium" style={{ color: theme.colors.textDim }}>
				{label}
			</span>
		</div>
		<div className="flex items-baseline gap-1.5">
			<span
				className="text-lg font-bold tabular-nums"
				style={{ color: isLoading ? theme.colors.textDim : theme.colors.textMain }}
			>
				{isLoading ? '—' : value}
			</span>
			{subtitle && (
				<span className="text-[10px]" style={{ color: theme.colors.accent }}>
					{subtitle}
				</span>
			)}
		</div>
	</div>
);

interface ActionButtonProps {
	theme: Theme;
	icon: React.ReactNode;
	label: string;
	onClick: () => void;
}

const ActionButton: React.FC<ActionButtonProps> = ({ theme, icon, label, onClick }) => (
	<button
		onClick={onClick}
		className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs transition-colors hover:opacity-80"
		style={{
			backgroundColor: theme.colors.bgActivity,
			border: `1px solid ${theme.colors.border}`,
			color: theme.colors.textMain,
		}}
	>
		{icon}
		{label}
	</button>
);

interface StatusMessageProps {
	theme: Theme;
	status: { type: 'success' | 'error'; message: string };
	onDismiss: () => void;
}

const StatusMessage: React.FC<StatusMessageProps> = ({ theme, status, onDismiss }) => (
	<div
		className="flex items-center gap-2 px-3 py-2 rounded text-xs cursor-pointer"
		onClick={onDismiss}
		style={{
			backgroundColor:
				status.type === 'success'
					? 'rgba(34, 197, 94, 0.1)'
					: 'rgba(239, 68, 68, 0.1)',
			border: `1px solid ${
				status.type === 'success'
					? 'rgba(34, 197, 94, 0.3)'
					: 'rgba(239, 68, 68, 0.3)'
			}`,
		}}
	>
		{status.type === 'success' ? (
			<CheckCircle2 className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.success }} />
		) : (
			<AlertCircle className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.error }} />
		)}
		<span
			style={{
				color: status.type === 'success' ? theme.colors.success : theme.colors.error,
			}}
		>
			{status.message}
		</span>
		<span className="text-[10px] ml-auto" style={{ color: theme.colors.textDim }}>
			click to dismiss
		</span>
	</div>
);
