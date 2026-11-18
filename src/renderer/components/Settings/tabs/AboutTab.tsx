/**
 * AboutTab - Large-format "About" panel for the Settings modal.
 *
 * Informational (no toggles): a large Maestro glyph + wordmark, the
 * tagline, the version, a Privacy link, and the origin flags. The
 * interactive stats-and-achievements surface lives in the separate About
 * modal.
 */

import { ShieldCheck, Wand2 } from 'lucide-react';
import { Wordmark } from '../../ui/Wordmark';
import type { Theme } from '../../../types';
import { MaestroFlags } from '../../ui/MaestroFlags';
import { buildMaestroUrl, MAESTRO_PRIVACY_URL } from '../../../utils/buildMaestroUrl';
import { openUrl } from '../../../utils/openUrl';
import { launchFromSettings } from '../../../utils/launchFromSettings';
import { transparentize } from '../../../../shared/colorContrast';

export interface AboutTabProps {
	theme: Theme;
}

export function AboutTab({ theme }: AboutTabProps) {
	return (
		<div
			className="flex flex-col items-center justify-center text-center min-h-full"
			data-setting-id="about-maestro"
		>
			{/* Glyph + wordmark */}
			<div className="flex items-center gap-5">
				<Wand2 className="w-20 h-20" style={{ color: theme.colors.accent }} />
				<Wordmark as="h1" className="text-6xl" style={{ color: theme.colors.textMain }} />
			</div>

			{/* Tagline */}
			<p className="text-base mt-3 opacity-70">Agent Orchestration Command Center</p>

			{/* Version */}
			<div className="mt-10 text-3xl font-bold font-mono" style={{ color: theme.colors.textMain }}>
				v{__APP_VERSION__}
			</div>
			{__COMMIT_HASH__ && (
				<div className="mt-1 text-xs font-mono" style={{ color: theme.colors.textDim }}>
					{__COMMIT_HASH__}
				</div>
			)}

			{/* Privacy: closes Settings first, or a Maestro browser tab would open behind it */}
			<button
				type="button"
				onClick={() => launchFromSettings(() => openUrl(buildMaestroUrl(MAESTRO_PRIVACY_URL)))}
				className="mt-6 inline-flex items-center gap-2 px-4 py-1.5 rounded-full border text-sm transition-opacity hover:opacity-80"
				style={{
					borderColor: theme.colors.accent,
					color: theme.colors.textMain,
					backgroundColor: transparentize(theme.colors.accent, theme.colors.bgMain, 0.1),
				}}
			>
				<ShieldCheck className="w-4 h-4" style={{ color: theme.colors.accent }} />
				Privacy
			</button>

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
