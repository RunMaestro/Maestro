/**
 * ThemedSelect — Themed custom dropdown replacement for native <select>.
 *
 * Renders a button that opens a positioned dropdown menu matching Maestro's
 * standard context menu aesthetic (bgSidebar, border, hover bgActivity).
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { ChevronDown } from 'lucide-react';
import type { Theme } from '../../types';
import { useClickOutside } from '../../hooks/ui';

export interface ThemedSelectOption {
	value: string;
	label: string;
}

interface ThemedSelectProps {
	value: string;
	options: ThemedSelectOption[];
	onChange: (value: string) => void;
	theme: Theme;
	style?: React.CSSProperties;
	/** Optional CSS class for the trigger button */
	className?: string;
}

export function ThemedSelect({
	value,
	options,
	onChange,
	theme,
	style,
	className,
}: ThemedSelectProps) {
	const [open, setOpen] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);
	const [dropUp, setDropUp] = useState(false);

	useClickOutside(containerRef, () => setOpen(false));

	useEffect(() => {
		if (!open) return;
		const handleKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.stopPropagation();
				setOpen(false);
			}
		};
		document.addEventListener('keydown', handleKey, true);
		return () => document.removeEventListener('keydown', handleKey, true);
	}, [open]);

	const handleOpen = useCallback(() => {
		if (!containerRef.current) {
			setOpen((v) => !v);
			return;
		}
		const rect = containerRef.current.getBoundingClientRect();
		const spaceBelow = window.innerHeight - rect.bottom;
		setDropUp(spaceBelow < 120);
		setOpen((v) => !v);
	}, []);

	const handleSelect = useCallback(
		(optValue: string) => {
			onChange(optValue);
			setOpen(false);
		},
		[onChange]
	);

	const selectedLabel = options.find((o) => o.value === value)?.label ?? value;

	return (
		<div ref={containerRef} style={{ position: 'relative', ...style }}>
			<button
				type="button"
				onClick={handleOpen}
				className={className}
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
					width: '100%',
					backgroundColor: theme.colors.bgActivity,
					border: `1px solid ${theme.colors.border}`,
					borderRadius: 4,
					color: theme.colors.textMain,
					padding: '4px 8px',
					fontSize: 12,
					outline: 'none',
					cursor: 'pointer',
					textAlign: 'left',
					gap: 4,
				}}
			>
				<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
					{selectedLabel}
				</span>
				<ChevronDown
					size={12}
					style={{
						flexShrink: 0,
						color: theme.colors.textDim,
						transform: open ? 'rotate(180deg)' : undefined,
						transition: 'transform 0.15s',
					}}
				/>
			</button>

			{open && (
				<div
					style={{
						position: 'absolute',
						left: 0,
						right: 0,
						...(dropUp ? { bottom: '100%', marginBottom: 4 } : { top: '100%', marginTop: 4 }),
						zIndex: 10000,
						backgroundColor: theme.colors.bgSidebar,
						border: `1px solid ${theme.colors.border}`,
						borderRadius: 6,
						boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
						overflow: 'hidden',
						maxHeight: 200,
						overflowY: 'auto',
					}}
				>
					{options.map((opt) => (
						<button
							key={opt.value}
							type="button"
							onClick={() => handleSelect(opt.value)}
							onMouseEnter={(e) => {
								e.currentTarget.style.backgroundColor = theme.colors.bgActivity;
							}}
							onMouseLeave={(e) => {
								e.currentTarget.style.backgroundColor = 'transparent';
							}}
							style={{
								display: 'block',
								width: '100%',
								padding: '6px 10px',
								fontSize: 12,
								color: opt.value === value ? theme.colors.textMain : theme.colors.textDim,
								fontWeight: opt.value === value ? 500 : 400,
								backgroundColor: 'transparent',
								border: 'none',
								cursor: 'pointer',
								textAlign: 'left',
								transition: 'background-color 0.1s',
							}}
						>
							{opt.label}
						</button>
					))}
				</div>
			)}
		</div>
	);
}
