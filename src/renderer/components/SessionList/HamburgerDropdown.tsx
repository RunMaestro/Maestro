/**
 * HamburgerDropdown - positioning shell for the Left Bar hamburger menu.
 *
 * Desktop / tablet: the classic anchored dropdown below the menu button.
 *
 * Phones (xs breakpoint): a full-screen scrollable sheet with its own close
 * header. The sheet renders through a body portal because the left sidebar
 * floats as a CSS-transformed drawer on narrow viewports, and a transformed
 * ancestor turns `position: fixed` into "fixed inside the drawer" - the menu
 * could never cover the screen from in there. SessionList's outside-click
 * closer ignores clicks inside `[data-hamburger-sheet]` for the same reason.
 */

import React from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { Theme } from '../../types';

interface HamburgerDropdownProps {
	theme: Theme;
	/** Full-screen sheet (true, phones) vs anchored dropdown (false). */
	isPhone: boolean;
	onClose: () => void;
	dataTour?: string;
	children: React.ReactNode;
}

export function HamburgerDropdown({
	theme,
	isPhone,
	onClose,
	dataTour,
	children,
}: HamburgerDropdownProps) {
	if (!isPhone) {
		return (
			<div
				className="absolute top-full left-0 -mt-px w-[22rem] max-h-[calc(100vh-120px)] rounded-lg shadow-2xl z-[100] overflow-y-auto scrollbar-thin"
				data-tour={dataTour}
				style={{
					backgroundColor: theme.colors.bgSidebar,
					border: `1px solid ${theme.colors.border}`,
				}}
			>
				{children}
			</div>
		);
	}

	return createPortal(
		<div
			className="fixed inset-0 z-[100] overflow-y-auto scrollbar-thin"
			data-tour={dataTour}
			data-hamburger-sheet
			style={{ backgroundColor: theme.colors.bgSidebar }}
		>
			<div
				className="sticky top-0 z-10 flex items-center justify-between pl-4 pr-2 py-2"
				style={{
					backgroundColor: theme.colors.bgSidebar,
					borderBottom: `1px solid ${theme.colors.border}`,
				}}
			>
				<span
					className="text-xs font-bold uppercase tracking-wider"
					style={{ color: theme.colors.textDim }}
				>
					Menu
				</span>
				<button
					onClick={onClose}
					aria-label="Close menu"
					className="p-2.5 rounded-lg hover:bg-white/5"
					style={{ color: theme.colors.textDim }}
				>
					<X className="w-5 h-5" />
				</button>
			</div>
			{children}
		</div>,
		document.body
	);
}
