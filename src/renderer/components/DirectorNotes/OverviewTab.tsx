import { useRef, useImperativeHandle, forwardRef } from 'react';
import {
	History,
	Sparkles,
	Search,
	Keyboard,
	Layers,
	BarChart2,
	Eye,
	FileText,
	Bot,
	User,
} from 'lucide-react';
import type { Theme, Shortcut } from '../../types';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';

export interface TabFocusHandle {
	focus: () => void;
	/** Return true if the tab consumed the Escape (e.g. closed an inner search bar). */
	onEscape?: () => boolean;
}

interface OverviewTabProps {
	theme: Theme;
	shortcuts: Record<string, Shortcut>;
}

export const OverviewTab = forwardRef<TabFocusHandle, OverviewTabProps>(function OverviewTab(
	{ theme, shortcuts },
	ref
) {
	const containerRef = useRef<HTMLDivElement>(null);

	useImperativeHandle(ref, () => ({
		focus: () => containerRef.current?.focus(),
	}));
	const sectionHeaderClass = 'flex items-center gap-2 mb-3';
	const sectionContentClass = 'text-sm space-y-2 pl-7';
	const codeClass = 'px-1.5 py-0.5 rounded text-[11px] font-mono';

	return (
		<div
			ref={containerRef}
			tabIndex={0}
			className="flex flex-col h-full overflow-y-auto p-6 scrollbar-thin outline-none"
		>
			<div className="max-w-3xl mx-auto space-y-6" style={{ color: theme.colors.textMain }}>
				{/* What it is */}
				<section>
					<div className={sectionHeaderClass}>
						<Layers className="w-5 h-5" style={{ color: theme.colors.accent }} />
						<h3 className="font-bold">What are Director's Notes?</h3>
					</div>
					<div className={sectionContentClass} style={{ color: theme.colors.textDim }}>
						<p>
							Director's Notes aggregates history from{' '}
							<strong style={{ color: theme.colors.textMain }}>all your active agents</strong> into
							a single timeline. Instead of switching between tabs to check what each agent has been
							doing, you get a bird's-eye view of every completed task, decision, and interaction.
						</p>
						<p>
							Think of it as your project logbook — a searchable, filterable record of everything
							that's been accomplished.
						</p>
					</div>
				</section>

				{/* Tabs overview */}
				<section>
					<div className={sectionHeaderClass}>
						<FileText className="w-5 h-5" style={{ color: theme.colors.accent }} />
						<h3 className="font-bold">Tabs</h3>
					</div>
					<div className={sectionContentClass} style={{ color: theme.colors.textDim }}>
						<div className="space-y-3">
							<div className="flex items-start gap-3">
								<div className="flex items-center gap-1.5 shrink-0 mt-0.5">
									<History className="w-4 h-4" style={{ color: theme.colors.accent }} />
									<strong style={{ color: theme.colors.textMain }}>Unified History</strong>
								</div>
								<p>
									Chronological list of all history entries across every agent, with filters and
									search.
								</p>
							</div>
							<div className="flex items-start gap-3">
								<div className="flex items-center gap-1.5 shrink-0 mt-0.5">
									<Sparkles className="w-4 h-4" style={{ color: theme.colors.accent }} />
									<strong style={{ color: theme.colors.textMain }}>AI Overview</strong>
								</div>
								<p>
									An AI-generated synopsis of recent work — auto-generated when you open Director's
									Notes.
								</p>
							</div>
						</div>
					</div>
				</section>

				{/* Entry types */}
				<section>
					<div className={sectionHeaderClass}>
						<Eye className="w-5 h-5" style={{ color: theme.colors.accent }} />
						<h3 className="font-bold">Entry Types</h3>
					</div>
					<div className={sectionContentClass} style={{ color: theme.colors.textDim }}>
						<div className="flex items-start gap-3">
							<span
								className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase shrink-0"
								style={{
									backgroundColor: theme.colors.accent + '20',
									color: theme.colors.accent,
									border: `1px solid ${theme.colors.accent}40`,
								}}
							>
								<User className="w-2.5 h-2.5" />
								USER
							</span>
							<p>
								Interactive work sessions — created via{' '}
								<code className={codeClass} style={{ backgroundColor: theme.colors.bgActivity }}>
									/history
								</code>{' '}
								or{' '}
								<code className={codeClass} style={{ backgroundColor: theme.colors.bgActivity }}>
									/clear
								</code>
								.
							</p>
						</div>
						<div className="flex items-start gap-3">
							<span
								className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase shrink-0"
								style={{
									backgroundColor: theme.colors.warning + '20',
									color: theme.colors.warning,
									border: `1px solid ${theme.colors.warning}40`,
								}}
							>
								<Bot className="w-2.5 h-2.5" />
								AUTO
							</span>
							<p>Automatically generated after each Auto Run task completes.</p>
						</div>
					</div>
				</section>

				{/* Activity graph */}
				<section>
					<div className={sectionHeaderClass}>
						<BarChart2 className="w-5 h-5" style={{ color: theme.colors.accent }} />
						<h3 className="font-bold">Activity Graph</h3>
					</div>
					<div className={sectionContentClass} style={{ color: theme.colors.textDim }}>
						<p>
							The bar graph in the Unified History header visualizes activity over time.
							<strong style={{ color: theme.colors.textMain }}> Right-click</strong> to change the
							lookback period.
							<strong style={{ color: theme.colors.textMain }}> Click a bar</strong> to jump to
							entries in that time range.
						</p>
					</div>
				</section>

				{/* Search */}
				<section>
					<div className={sectionHeaderClass}>
						<Search className="w-5 h-5" style={{ color: theme.colors.accent }} />
						<h3 className="font-bold">Search</h3>
					</div>
					<div className={sectionContentClass} style={{ color: theme.colors.textDim }}>
						<p>
							Press{' '}
							<kbd className={codeClass} style={{ backgroundColor: theme.colors.bgActivity }}>
								{formatShortcutKeys(['Meta', 'f'])}
							</kbd>{' '}
							to search across all entry summaries and agent names. Results filter the list in
							real-time. The search bar shows match count and supports previous/next navigation with{' '}
							<kbd className={codeClass} style={{ backgroundColor: theme.colors.bgActivity }}>
								Enter
							</kbd>{' '}
							/{' '}
							<kbd className={codeClass} style={{ backgroundColor: theme.colors.bgActivity }}>
								Shift+Enter
							</kbd>
							.
						</p>
					</div>
				</section>

				{/* Keyboard shortcuts */}
				<section>
					<div className={sectionHeaderClass}>
						<Keyboard className="w-5 h-5" style={{ color: theme.colors.accent }} />
						<h3 className="font-bold">Keyboard Shortcuts</h3>
					</div>
					<div className={sectionContentClass} style={{ color: theme.colors.textDim }}>
						<div
							className="rounded border overflow-hidden"
							style={{ borderColor: theme.colors.border }}
						>
							{[
								[
									shortcuts.directorNotes ? formatShortcutKeys(shortcuts.directorNotes.keys) : '',
									"Open Director's Notes",
								],
								[`${formatShortcutKeys(['Meta', 'Shift'])} [ / ]`, 'Switch between tabs'],
								[formatShortcutKeys(['Meta', 'f']), 'Search / filter entries'],
								['Arrow Up/Down', 'Navigate entry list'],
								['Enter', 'Open entry detail'],
								['Escape', 'Close search, then close modal'],
							].map(([key, desc], i) => (
								<div
									key={key}
									className="flex items-center gap-3 px-3 py-2 text-sm"
									style={{
										borderTop: i > 0 ? `1px solid ${theme.colors.border}` : undefined,
										backgroundColor: i % 2 === 0 ? 'transparent' : theme.colors.bgActivity + '40',
									}}
								>
									<kbd
										className="px-2 py-0.5 rounded text-[11px] font-mono font-medium shrink-0 min-w-[140px]"
										style={{
											backgroundColor: theme.colors.bgActivity,
											color: theme.colors.textMain,
											border: `1px solid ${theme.colors.border}`,
										}}
									>
										{key}
									</kbd>
									<span>{desc}</span>
								</div>
							))}
						</div>
					</div>
				</section>
			</div>
		</div>
	);
});
