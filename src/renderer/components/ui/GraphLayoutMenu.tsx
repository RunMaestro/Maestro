import { useCallback, useRef } from 'react';
import { ChevronDown, Network } from 'lucide-react';
import type { Theme } from '../../types';
import { useClickOutside } from '../../hooks/ui/useClickOutside';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import { useListNavigation } from '../../hooks/keyboard/useListNavigation';
import { useFocusAfterRender, useFocusOnClose } from '../../hooks/utils/useFocusAfterRender';
import { elevatedSurfaceStyle } from '../../utils/elevatedSurface';
import { GraphToolbarButton } from './GraphToolbarButton';

interface GraphLayoutMenuProps<T extends string> {
	theme: Theme;
	value: string;
	label: string;
	options: ReadonlyArray<{ value: T; label: string; description: string }>;
	onChange: (value: T) => void;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	priority: number;
	testId?: string;
}

/** Shared layout picker, including Escape layering and keyboard navigation. */
export function GraphLayoutMenu<T extends string>({
	theme,
	value,
	label,
	options,
	onChange,
	open,
	onOpenChange,
	priority,
	testId,
}: GraphLayoutMenuProps<T>) {
	const containerRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const selectedRef = useRef<HTMLButtonElement>(null);
	const close = useCallback(() => onOpenChange(false), [onOpenChange]);
	useClickOutside(containerRef, close, open);
	useModalLayer(priority, 'Graph layout', close, {
		enabled: open,
		capturesFocus: false,
		focusTrap: 'none',
		blocksLowerLayers: false,
	});
	useFocusOnClose(triggerRef, open);
	const select = (index: number) => {
		const option = options[index];
		if (!option) return;
		close();
		onChange(option.value);
	};
	const { selectedIndex, setSelectedIndex, handleKeyDown } = useListNavigation({
		listLength: options.length,
		onSelect: select,
		wrap: true,
		enablePageNavigation: true,
	});
	useFocusAfterRender(selectedRef, open);

	return (
		<div
			ref={containerRef}
			className="relative shrink-0"
			onKeyDown={(event) => {
				if (open) {
					handleKeyDown(event);
					event.stopPropagation();
				}
			}}
		>
			<GraphToolbarButton
				theme={theme}
				ref={triggerRef}
				icon={<Network />}
				onClick={() => {
					setSelectedIndex(
						Math.max(
							0,
							options.findIndex((option) => option.value === value)
						)
					);
					onOpenChange(!open);
				}}
				title={`Layout: ${label} (L to cycle)`}
				aria-label="Layout"
				aria-haspopup="menu"
				aria-expanded={open}
				data-testid={testId}
			>
				{label}
				<ChevronDown className="w-3 h-3" />
			</GraphToolbarButton>
			{open && (
				<div
					role="menu"
					aria-label="Layout"
					className="absolute top-full right-0 mt-2 py-1 rounded-lg z-50 max-w-[calc(90vw-3rem)] overflow-auto"
					style={{ ...elevatedSurfaceStyle(theme), minWidth: 200 }}
				>
					{options.map((option, index) => (
						<button
							key={option.value}
							ref={index === selectedIndex ? selectedRef : undefined}
							type="button"
							role="menuitemradio"
							aria-checked={value === option.value}
							tabIndex={index === selectedIndex ? 0 : -1}
							onFocus={() => setSelectedIndex(index)}
							onClick={() => select(index)}
							className="w-full px-3 py-2 text-left text-sm transition-colors flex items-center justify-between gap-3"
							style={{
								backgroundColor:
									index === selectedIndex
										? `${theme.colors.accent}20`
										: value === option.value
											? `${theme.colors.accent}15`
											: 'transparent',
								color: value === option.value ? theme.colors.accent : theme.colors.textMain,
							}}
						>
							<span className="whitespace-nowrap">{option.label}</span>
							<span className="text-xs whitespace-nowrap" style={{ color: theme.colors.textDim }}>
								{option.description}
							</span>
						</button>
					))}
				</div>
			)}
		</div>
	);
}
