import type { DidYouKnowTip } from '../../../shared/didYouKnow';
import {
	resolveEncoreFeatures,
	type EncoreFeatureDefaults,
} from '../../../shared/encoreFeatureDefaults';
import { FIXED_SHORTCUTS } from '../../constants/shortcuts';
import type { Shortcut, Theme } from '../../types';
import { resolveFixedPitchFontFamily } from '../../utils/fixedPitchFont';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';
import { CopyIconButton } from '../ui/CopyIconButton';

interface TipCardProps {
	tip: DidYouKnowTip;
	theme: Theme;
	// The shell supplies live settings; the placard never subscribes to the store.
	shortcuts?: Record<string, Shortcut>;
	tabShortcuts?: Record<string, Shortcut>;
	encoreFeatures?: Partial<EncoreFeatureDefaults>;
	fontFamily?: string;
}

/** Selectable gallery copy beneath the artwork, independent of settings persistence. */
export function TipCard({
	tip,
	theme,
	shortcuts,
	tabShortcuts,
	encoreFeatures,
	fontFamily = '',
}: TipCardProps) {
	const shortcut = tip.shortcutId
		? (shortcuts?.[tip.shortcutId] ??
			tabShortcuts?.[tip.shortcutId] ??
			FIXED_SHORTCUTS[tip.shortcutId])
		: undefined;
	const keys = shortcut?.keys;
	const showEncore = tip.encore && !resolveEncoreFeatures(encoreFeatures)[tip.encore];

	return (
		<div className="select-text space-y-4 text-sm" style={{ color: theme.colors.textMain }}>
			<div className="flex flex-wrap items-center gap-2">
				<h2 className="text-lg font-semibold">{tip.title}</h2>
				{showEncore && (
					<span
						className="rounded-full border px-2 py-0.5 text-xs font-medium"
						style={{ color: theme.colors.accent, borderColor: theme.colors.accent }}
					>
						Encore
					</span>
				)}
			</div>
			<p className="text-base leading-relaxed">{tip.headline}</p>
			<div className="space-y-3 leading-relaxed" style={{ color: theme.colors.textDim }}>
				{tip.body.map((paragraph, index) => (
					<p key={index}>{paragraph}</p>
				))}
			</div>
			{(!!keys?.length || tip.cli) && (
				<div className="flex flex-wrap items-center gap-3">
					{!!keys?.length && (
						<kbd
							data-shortcut-hint
							className="rounded border px-2 py-1 text-xs"
							style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgActivity }}
						>
							{formatShortcutKeys(keys)}
						</kbd>
					)}
					{tip.cli && (
						<div
							className="flex min-w-0 max-w-full items-center gap-2 rounded border px-2 py-1"
							style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgActivity }}
						>
							<code
								className="min-w-0 break-words text-xs"
								style={{ fontFamily: resolveFixedPitchFontFamily(fontFamily) }}
							>
								{tip.cli}
							</code>
							<CopyIconButton
								value={tip.cli}
								theme={theme}
								title="Copy CLI command"
								className="shrink-0"
							/>
						</div>
					)}
				</div>
			)}
		</div>
	);
}
