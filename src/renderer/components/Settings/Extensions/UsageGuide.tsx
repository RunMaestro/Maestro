/**
 * "How to use it" block for a first-party feature, rendered under its
 * description in the Extensions details pane.
 *
 * A one-line description says what a feature IS. It does not say that the
 * feature has a hotkey, that the command palette reaches it, or what an agent
 * types to drive it - so a user could turn something on and have no idea how to
 * summon it. This closes that gap for every first-party feature at once: fill in
 * `usage` on the plugin definition and the section appears.
 *
 * Key bindings are resolved from the user's LIVE shortcuts by `shortcutId`, not
 * printed from literal text in the definition. A rebound key would otherwise
 * leave this panel confidently advertising a combination that does nothing.
 */

import { Command, MousePointerClick, Terminal } from 'lucide-react';
import type { Theme } from '../../../types';
import type { FirstPartyUsageGuide } from '../../../../shared/plugins/first-party';
import { useSettingsStore } from '../../../stores/settingsStore';
import { formatShortcutKeys } from '../../../utils/shortcutFormatter';
import { DEFAULT_SHORTCUTS } from '../../../constants/shortcuts';
import { Keycap } from '../../ui/Keycap';
import { buildMaestroUrl } from '../../../utils/buildMaestroUrl';
import { openUrl } from '../../../utils/openUrl';

interface UsageGuideProps {
	theme: Theme;
	usage: FirstPartyUsageGuide;
}

export function UsageGuide({ theme, usage }: UsageGuideProps) {
	// The user's own bindings, falling back to the shipped defaults for a
	// shortcut they have never touched.
	const shortcuts = useSettingsStore((s) => s.shortcuts);

	const keysFor = (shortcutId: string | undefined): string[] | null => {
		if (!shortcutId) return null;
		const defaults = DEFAULT_SHORTCUTS as Record<string, { keys: string[] } | undefined>;
		const shortcut = shortcuts[shortcutId] ?? defaults[shortcutId];
		return shortcut?.keys ?? null;
	};

	return (
		<div className="mt-4" data-testid="extension-usage-guide">
			<h4
				className="text-[11px] font-bold uppercase tracking-wide mb-2"
				style={{ color: theme.colors.textDim }}
			>
				How to use it
			</h4>

			<div className="space-y-2">
				{usage.overview.map((paragraph, index) => (
					<p
						key={index}
						className="text-sm leading-relaxed"
						style={{ color: theme.colors.textMain }}
					>
						{paragraph}
					</p>
				))}
			</div>

			{usage.access && usage.access.length > 0 && (
				<div className="mt-4 space-y-3" data-testid="extension-usage-access">
					{usage.access.map((path) => {
						const keys = keysFor(path.shortcutId);
						return (
							<div key={path.label}>
								<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
									{path.label}
								</div>
								<div className="mt-1 flex flex-col gap-1">
									{keys && (
										<div className="flex items-center gap-2 text-xs">
											<Keycap theme={theme} tone="accent">
												{formatShortcutKeys(keys)}
											</Keycap>
											<span style={{ color: theme.colors.textDim }}>hotkey</span>
										</div>
									)}
									{path.commandPalette && (
										<div
											className="flex items-center gap-1.5 text-xs"
											style={{ color: theme.colors.textDim }}
										>
											<Command className="w-3 h-3 flex-shrink-0" />
											<span>
												Command palette:{' '}
												<span style={{ color: theme.colors.textMain }}>
													&ldquo;{path.commandPalette}&rdquo;
												</span>
											</span>
										</div>
									)}
									{path.menu && (
										<div
											className="flex items-center gap-1.5 text-xs"
											style={{ color: theme.colors.textDim }}
										>
											<MousePointerClick className="w-3 h-3 flex-shrink-0" />
											<span>Click {path.menu}</span>
										</div>
									)}
								</div>
							</div>
						);
					})}
				</div>
			)}

			{usage.agentCommands && usage.agentCommands.length > 0 && (
				<div className="mt-4" data-testid="extension-usage-agent">
					<h4
						className="text-[11px] font-bold uppercase tracking-wide mb-2"
						style={{ color: theme.colors.textDim }}
					>
						How agents drive it
					</h4>
					<div className="space-y-2">
						{usage.agentCommands.map((entry) => (
							<div key={entry.label}>
								<div className="text-xs" style={{ color: theme.colors.textDim }}>
									{entry.label}
								</div>
								<code
									className="mt-0.5 block rounded px-2 py-1 text-[11px] break-all select-text"
									style={{
										backgroundColor: theme.colors.bgMain,
										color: theme.colors.textMain,
										border: `1px solid ${theme.colors.border}`,
									}}
								>
									<Terminal
										className="mr-1.5 inline w-3 h-3 align-[-1px]"
										style={{ color: theme.colors.accent }}
									/>
									{entry.command}
								</code>
							</div>
						))}
					</div>
				</div>
			)}

			{usage.docsSlug && (
				<button
					type="button"
					onClick={() => openUrl(buildMaestroUrl(`https://docs.runmaestro.ai/${usage.docsSlug}`))}
					className="mt-3 text-xs underline underline-offset-2 hover:opacity-80 transition-opacity"
					style={{ color: theme.colors.accent }}
					data-testid="extension-usage-docs"
				>
					Full documentation
				</button>
			)}
		</div>
	);
}
