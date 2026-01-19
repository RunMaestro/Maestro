import React, { forwardRef } from 'react';
import type { Theme } from '../types';
import type { AutocompleteState } from '../hooks';

interface TemplateAutocompleteDropdownProps {
	theme: Theme;
	state: AutocompleteState;
	onSelect: (variable: string) => void;
}

/**
 * Dropdown component that displays template variable suggestions.
 * Used by both AgentPromptComposerModal and AutoRun document editor.
 */
export const TemplateAutocompleteDropdown = forwardRef<
	HTMLDivElement,
	TemplateAutocompleteDropdownProps
>(function TemplateAutocompleteDropdown({ theme, state, onSelect }, ref) {
	if (!state.isOpen || state.filteredVariables.length === 0) {
		return null;
	}

	return (
		<div
			ref={ref}
			className="absolute z-50 rounded-lg border shadow-xl overflow-hidden"
			style={{
				top: state.position.top,
				left: state.position.left,
				backgroundColor: theme.colors.bgSidebar,
				borderColor: theme.colors.border,
				minWidth: '280px',
				maxWidth: '380px',
				maxHeight: '240px',
			}}
		>
			<div className="overflow-y-auto scrollbar-thin" style={{ maxHeight: '240px' }}>
				{state.filteredVariables.map((item, index) => (
					<div
						key={item.variable}
						data-index={index}
						className="flex items-center gap-3 px-3 py-2 cursor-pointer transition-colors"
						style={{
							backgroundColor:
								index === state.selectedIndex ? theme.colors.bgActivity : 'transparent',
						}}
						onClick={() => onSelect(item.variable)}
						onMouseEnter={(e) => {
							// Update visual selection on hover
							const target = e.currentTarget;
							target.style.backgroundColor = theme.colors.bgActivity;
						}}
						onMouseLeave={(e) => {
							// Reset unless this is the selected item
							const target = e.currentTarget;
							if (index !== state.selectedIndex) {
								target.style.backgroundColor = 'transparent';
							}
						}}
					>
						<code
							className="text-xs font-mono px-1.5 py-0.5 rounded shrink-0"
							style={{
								backgroundColor: theme.colors.bgMain,
								color: theme.colors.accent,
							}}
						>
							{item.variable}
						</code>
						<span className="text-xs truncate" style={{ color: theme.colors.textDim }}>
							{item.description}
						</span>
					</div>
				))}
			</div>
			<div
				className="px-3 py-1.5 border-t text-xs"
				style={{
					borderColor: theme.colors.border,
					color: theme.colors.textDim,
					backgroundColor: theme.colors.bgMain,
				}}
			>
				<kbd
					className="px-1 py-0.5 rounded text-[10px]"
					style={{ backgroundColor: theme.colors.bgActivity }}
				>
					↑↓
				</kbd>{' '}
				navigate{' '}
				<kbd
					className="px-1 py-0.5 rounded text-[10px]"
					style={{ backgroundColor: theme.colors.bgActivity }}
				>
					Tab
				</kbd>{' '}
				select{' '}
				<kbd
					className="px-1 py-0.5 rounded text-[10px]"
					style={{ backgroundColor: theme.colors.bgActivity }}
				>
					Esc
				</kbd>{' '}
				close
			</div>
		</div>
	);
});
