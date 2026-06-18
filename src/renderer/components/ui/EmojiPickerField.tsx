/**
 * EmojiPickerField - A themed emoji selector with picker overlay
 *
 * Extracts the common emoji picking pattern used in group modals (CreateGroupModal, RenameGroupModal).
 * Includes:
 * - Emoji button with label that toggles the picker
 * - Full-screen overlay with backdrop blur
 * - Close button and escape key handling
 * - Theme-aware styling
 * - Optional focus restoration after selection/close
 *
 * @example
 * ```tsx
 * const [emoji, setEmoji] = useState('📂');
 * const inputRef = useRef<HTMLInputElement>(null);
 *
 * <EmojiPickerField
 *   theme={theme}
 *   value={emoji}
 *   onChange={setEmoji}
 *   restoreFocusRef={inputRef}
 * />
 * ```
 */

import React, { useState, useRef, useCallback } from 'react';
import { X } from 'lucide-react';
import data from '@emoji-mart/data';
import Picker from '@emoji-mart/react';
import type { Theme } from '../../types';

export interface EmojiPickerFieldProps {
	/** Theme object for styling */
	theme: Theme;
	/** Currently selected emoji */
	value: string;
	/** Callback when emoji is selected */
	onChange: (emoji: string) => void;
	/** Optional label text (default: "Icon") */
	label?: string;
	/** Optional ref to restore focus to after picker closes */
	restoreFocusRef?: React.RefObject<HTMLElement>;
	/** Optional callback when picker opens */
	onOpen?: () => void;
	/** Optional callback when picker closes */
	onClose?: () => void;
	/** Custom button className override */
	buttonClassName?: string;
	/** Whether the field is disabled */
	disabled?: boolean;
	/** Data-testid for testing */
	'data-testid'?: string;
}

export function EmojiPickerField({
	theme,
	value,
	onChange,
	label = 'Icon',
	restoreFocusRef,
	onOpen,
	onClose: onCloseProp,
	buttonClassName,
	disabled = false,
	'data-testid': testId,
}: EmojiPickerFieldProps) {
	const [isOpen, setIsOpen] = useState(false);
	const overlayRef = useRef<HTMLDivElement>(null);

	const handleClose = useCallback(() => {
		setIsOpen(false);
		onCloseProp?.();
		// Restore focus after a brief delay to allow overlay to unmount
		setTimeout(() => {
			restoreFocusRef?.current?.focus();
		}, 0);
	}, [onCloseProp, restoreFocusRef]);

	const handleToggle = useCallback(() => {
		if (disabled) return;

		if (isOpen) {
			handleClose();
		} else {
			setIsOpen(true);
			onOpen?.();
		}
	}, [disabled, isOpen, handleClose, onOpen]);

	const handleEmojiSelect = useCallback(
		(emojiData: { native: string }) => {
			onChange(emojiData.native);
			setIsOpen(false);
			onCloseProp?.();
			// Restore focus after selection
			setTimeout(() => {
				restoreFocusRef?.current?.focus();
			}, 0);
		},
		[onChange, onCloseProp, restoreFocusRef]
	);

	const handleOverlayKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				handleClose();
			}
		},
		[handleClose]
	);

	const handleBackdropClick = useCallback(() => {
		handleClose();
	}, [handleClose]);

	return (
		<div className="flex flex-col gap-2" data-testid={testId}>
			{/* Label */}
			<label
				className="block text-xs font-bold opacity-70 uppercase"
				style={{ color: theme.colors.textMain }}
			>
				{label}
			</label>

			{/* Emoji Button */}
			<button
				onClick={handleToggle}
				className={
					buttonClassName ||
					'p-3 rounded border bg-transparent text-3xl hover:bg-white/5 transition-colors w-16 h-[52px] flex items-center justify-center'
				}
				style={{
					borderColor: theme.colors.border,
					opacity: disabled ? 0.5 : 1,
					cursor: disabled ? 'not-allowed' : 'pointer',
				}}
				type="button"
				disabled={disabled}
				aria-label={`Select emoji, current: ${value}`}
				aria-haspopup="dialog"
				aria-expanded={isOpen}
				data-testid={testId ? `${testId}-button` : undefined}
			>
				{value}
			</button>

			{/* Emoji Picker Overlay */}
			{isOpen && (
				<div
					ref={overlayRef}
					className="fixed inset-0 modal-overlay flex items-center justify-center z-[60]"
					onClick={handleBackdropClick}
					onKeyDown={handleOverlayKeyDown}
					tabIndex={0}
					role="dialog"
					aria-modal="true"
					aria-label="Emoji picker"
					data-testid={testId ? `${testId}-overlay` : undefined}
				>
					<div
						className="rounded-lg border-2 shadow-2xl overflow-visible relative"
						style={{
							borderColor: theme.colors.accent,
							backgroundColor: theme.colors.bgSidebar,
						}}
						onClick={(e) => e.stopPropagation()}
					>
						{/* Close button */}
						<button
							onClick={handleClose}
							className="absolute -top-3 -right-3 z-10 p-2 rounded-full shadow-lg hover:scale-110 transition-transform"
							style={{
								backgroundColor: theme.colors.bgSidebar,
								color: theme.colors.textMain,
								border: `2px solid ${theme.colors.border}`,
							}}
							aria-label="Close emoji picker"
							data-testid={testId ? `${testId}-close` : undefined}
						>
							<X className="w-4 h-4" />
						</button>

						{/* Emoji Picker */}
						<Picker
							data={data}
							onEmojiSelect={handleEmojiSelect}
							theme={theme.mode}
							previewPosition="none"
							searchPosition="sticky"
							perLine={9}
							set="native"
							autoFocus
						/>
					</div>
				</div>
			)}
		</div>
	);
}
