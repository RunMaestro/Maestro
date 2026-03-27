import React, { RefObject } from 'react';
import { List, ChevronUp, ChevronDown } from 'lucide-react';
import type { TocEntry } from './types';

interface FilePreviewTocProps {
	theme: any;
	tocEntries: TocEntry[];
	tocWidth: number;
	showTocOverlay: boolean;
	setShowTocOverlay: (v: boolean) => void;
	scrollMarkdownToBoundary: (direction: 'top' | 'bottom') => void;
	markdownContainerRef: RefObject<HTMLDivElement>;
	tocButtonRef: RefObject<HTMLButtonElement>;
	tocOverlayRef: RefObject<HTMLDivElement>;
	isMarkdown: boolean;
	markdownEditMode: boolean;
}

export const FilePreviewToc = React.memo(function FilePreviewToc({
	theme,
	tocEntries,
	tocWidth,
	showTocOverlay,
	setShowTocOverlay,
	scrollMarkdownToBoundary,
	markdownContainerRef,
	tocButtonRef,
	tocOverlayRef,
	isMarkdown,
	markdownEditMode,
}: FilePreviewTocProps) {
	if (!isMarkdown || markdownEditMode || tocEntries.length === 0) {
		return null;
	}

	return (
		<>
			{/* Floating TOC Button */}
			<button
				ref={tocButtonRef}
				onClick={() => setShowTocOverlay(!showTocOverlay)}
				className="absolute bottom-4 right-4 p-2.5 rounded-full shadow-lg transition-all duration-200 hover:scale-105 z-10"
				style={{
					backgroundColor: showTocOverlay ? theme.colors.accent : theme.colors.bgSidebar,
					color: showTocOverlay ? theme.colors.accentForeground : theme.colors.textMain,
					border: `1px solid ${theme.colors.border}`,
				}}
				title="Table of Contents"
			>
				<List className="w-5 h-5" />
			</button>

			{/* TOC Overlay - click outside handled by useClickOutside hook */}
			{showTocOverlay && (
				<div
					ref={tocOverlayRef}
					className="absolute bottom-16 right-4 rounded-lg shadow-xl overflow-hidden z-20 animate-in fade-in slide-in-from-bottom-2 duration-200 flex flex-col"
					style={{
						backgroundColor: theme.colors.bgSidebar,
						border: `1px solid ${theme.colors.border}`,
						maxHeight: 'calc(70vh - 80px)',
						width: `${tocWidth}px`,
					}}
					onWheel={(e) => e.stopPropagation()}
				>
					{/* TOC Header */}
					<div
						className="px-3 py-2 border-b flex items-center justify-between flex-shrink-0"
						style={{ borderColor: theme.colors.border }}
					>
						<span
							className="text-xs font-medium uppercase tracking-wide"
							style={{ color: theme.colors.textDim }}
						>
							Contents
						</span>
						<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
							{tocEntries.length} headings
						</span>
					</div>
					{/* Top Navigation Sash */}
					<button
						data-testid="toc-top-button"
						onClick={() => {
							scrollMarkdownToBoundary('top');
						}}
						className="w-full px-3 py-2 text-left text-xs border-b transition-colors flex items-center gap-2 hover:brightness-110 flex-shrink-0"
						style={{
							backgroundColor: `${theme.colors.accent}15`,
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
						title="Jump to top"
					>
						<ChevronUp className="w-3 h-3" style={{ color: theme.colors.accent }} />
						<span>Top</span>
					</button>

					{/* TOC Entries - scrollable middle section */}
					<div
						className="overflow-y-auto px-1 py-1 flex-1 min-h-0"
						style={{ overscrollBehavior: 'contain' }}
						onWheel={(e) => e.stopPropagation()}
					>
						{tocEntries.map((entry, index) => {
							// Get color based on heading level (match the prose styles)
							const levelColors: Record<number, string> = {
								1: theme.colors.accent,
								2: theme.colors.success,
								3: theme.colors.warning,
								4: theme.colors.textMain,
								5: theme.colors.textMain,
								6: theme.colors.textDim,
							};
							const headingColor = levelColors[entry.level] || theme.colors.textMain;

							return (
								<button
									key={`${entry.slug}-${index}`}
									onClick={() => {
										// Find and scroll to the heading
										const targetElement = markdownContainerRef.current?.querySelector(
											`#${CSS.escape(entry.slug)}`
										);
										if (targetElement) {
											targetElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
										}
										// ToC stays open so user can click multiple items
										// Dismiss with click outside or Escape key
									}}
									className="w-full px-2 py-1.5 text-left text-sm rounded hover:bg-white/10 transition-colors flex items-center gap-1"
									style={{
										color: headingColor,
										paddingLeft: `${(entry.level - 1) * 12 + 8}px`,
										opacity: entry.level > 3 ? 0.85 : 1,
										fontSize:
											entry.level === 1 ? '0.875rem' : entry.level === 2 ? '0.8125rem' : '0.75rem',
									}}
									title={entry.text}
								>
									<span>{entry.text}</span>
								</button>
							);
						})}
					</div>

					{/* Bottom Navigation Sash */}
					<button
						data-testid="toc-bottom-button"
						onClick={() => {
							scrollMarkdownToBoundary('bottom');
						}}
						className="w-full px-3 py-2 text-left text-xs border-t transition-colors flex items-center gap-2 hover:brightness-110 flex-shrink-0"
						style={{
							backgroundColor: `${theme.colors.accent}15`,
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
						title="Jump to bottom"
					>
						<ChevronDown className="w-3 h-3" style={{ color: theme.colors.accent }} />
						<span>Bottom</span>
					</button>
				</div>
			)}
		</>
	);
});
