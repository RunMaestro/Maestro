/**
 * AboutTab - Large-format "About" panel for the Settings modal.
 *
 * Purely informational (no toggles): a large Maestro glyph + wordmark,
 * the tagline, the version, and the origin flags. The interactive
 * stats-and-achievements surface lives in the separate About modal.
 */

import { Wand2 } from 'lucide-react';
import type { Theme } from '../../../types';
import { MaestroFlags } from '../../ui/MaestroFlags';

export interface AboutTabProps {
	theme: Theme;
}

export function AboutTab({ theme }: AboutTabProps) {
	const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'unknown';
	const commitHash = typeof __COMMIT_HASH__ !== 'undefined' ? __COMMIT_HASH__ : '';

	return (
		<div
			className="flex flex-col items-center justify-center text-center min-h-full"
			data-setting-id="about-maestro"
		>
			{/* Glyph + wordmark */}
			<div className="flex items-center gap-5">
				<Wand2 className="w-20 h-20" style={{ color: theme.colors.accent }} />
				<h1 className="text-6xl font-bold tracking-widest" style={{ color: theme.colors.textMain }}>
					MAESTRO
				</h1>
			</div>

			{/* Tagline */}
			<p className="text-base mt-3 opacity-70" style={{ color: theme.colors.textDim }}>
				Agent Orchestration Command Center
			</p>

			{/* Version */}
			<div className="mt-10 text-3xl font-bold font-mono" style={{ color: theme.colors.textMain }}>
				v{appVersion}
			</div>
			{commitHash && (
				<div className="mt-1 text-xs font-mono" style={{ color: theme.colors.textDim }}>
					{commitHash}
				</div>
			)}

			{/* Origin */}
			<div className="flex flex-col items-center gap-3 mt-12">
				<span className="text-sm" style={{ color: theme.colors.textMain }}>
					Born on Nov 26, 2025 in Austin, TX
				</span>
				<MaestroFlags width={56} />
			</div>
		</div>
	);
}
