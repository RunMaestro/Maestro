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

import React, { useState, useCallback } from 'react';
import { X } from 'lucide-react';
import data from '@emoji-mart/data';
import Picker from '@emoji-mart/react';
import type { Theme } from '../../types';
import type { IconPackContribution } from '../../../shared/plugins/contributions';
import { SafeSvgIcon } from './SafeSvgIcon';
import {
	GROUP_ICON_OPTIONS,
	GROUP_LABEL_COLORS,
	resolveGroupAppearance,
} from './groupAppearanceOptions';

export interface EmojiPickerOverlayProps {
	/** Theme object for styling */
	theme: Theme;
	/** Called with the selected emoji's native glyph. The overlay closes after. */
	onSelect: (emoji: string) => void;
	/** Dismiss the overlay (backdrop click, close button, or Escape). */
	onClose: () => void;
	/** Optional ref to restore focus to after the overlay closes. */
	restoreFocusRef?: React.RefObject<HTMLElement>;
	/** Data-testid for testing */
	'data-testid'?: string;
}

/**
 * The full-screen emoji-mart picker overlay: backdrop blur, close button, Escape
 * and backdrop-click dismissal, and focus restoration. Shared by both the labeled
 * `EmojiPickerField` (group modals) and the tab-group chip's "Change icon" flow so
 * every emoji selection surface uses the exact same picker.
 */
export function EmojiPickerOverlay({
	theme,
	onSelect,
	onClose,
	restoreFocusRef,
	'data-testid': testId,
}: EmojiPickerOverlayProps) {
	const restoreFocus = useCallback(() => {
		// Restore focus after a tick so the overlay has unmounted first.
		setTimeout(() => {
			restoreFocusRef?.current?.focus();
		}, 0);
	}, [restoreFocusRef]);

	const handleClose = useCallback(() => {
		onClose();
		restoreFocus();
	}, [onClose, restoreFocus]);

	const handleEmojiSelect = useCallback(
		(emojiData: { native: string }) => {
			onSelect(emojiData.native);
			onClose();
			restoreFocus();
		},
		[onSelect, onClose, restoreFocus]
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

	return (
		<div
			className="fixed inset-0 modal-overlay flex items-center justify-center z-[60]"
			onClick={handleClose}
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
	);
}

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

export interface GroupAppearancePickerProps {
	theme: Theme;
	emoji: string;
	icon?: string;
	color?: string;
	onEmojiChange: (emoji: string) => void;
	onIconChange: (icon: string | undefined) => void;
	onColorChange: (color: string | undefined) => void;
	/** Enables the Groups+ icon and label-color controls. */
	groupsPlusEnabled?: boolean;
	/** Enabled tier-0 plugin icon packs to display after host-built-in options. */
	iconPacks?: readonly IconPackContribution[];
	restoreFocusRef?: React.RefObject<HTMLElement>;
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

	const handleClose = useCallback(() => {
		setIsOpen(false);
		onCloseProp?.();
	}, [onCloseProp]);

	const handleToggle = useCallback(() => {
		if (disabled) return;

		if (isOpen) {
			handleClose();
		} else {
			setIsOpen(true);
			onOpen?.();
		}
	}, [disabled, isOpen, handleClose, onOpen]);

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
				<EmojiPickerOverlay
					theme={theme}
					onSelect={onChange}
					onClose={handleClose}
					restoreFocusRef={restoreFocusRef}
					data-testid={testId}
				/>
			)}
		</div>
	);
}

export function GroupAppearancePicker({
	theme,
	emoji,
	icon,
	color,
	onEmojiChange,
	onIconChange,
	onColorChange,
	restoreFocusRef,
	groupsPlusEnabled = false,
	iconPacks = [],
}: GroupAppearancePickerProps) {
	const appearance = groupsPlusEnabled
		? resolveGroupAppearance(icon, color, iconPacks)
		: resolveGroupAppearance(undefined, undefined, []);
	const previewColor = appearance.color || theme.colors.textDim;
	const hasStoredColor = color !== undefined;
	const hasUnavailableColor = hasStoredColor && appearance.color === undefined;
	return (
		<div className="space-y-4">
			<div className="flex gap-4 items-start">
				<EmojiPickerField
					theme={theme}
					value={emoji || '🙂'}
					onChange={(nextEmoji) => {
						onEmojiChange(nextEmoji);
						onIconChange(undefined);
					}}
					label="Emoji"
					restoreFocusRef={restoreFocusRef}
				/>
				{groupsPlusEnabled && appearance.icon && (
					<div
						className="w-16 flex flex-col gap-2 items-center"
						aria-label="Selected group appearance preview"
						style={{ color: previewColor }}
					>
						<span
							className="text-xs font-bold opacity-70 uppercase"
							style={{ color: theme.colors.textMain }}
						>
							Preview
						</span>
						<div
							className="p-3 rounded border w-16 h-[52px] flex items-center justify-center"
							style={{ borderColor: theme.colors.border }}
						>
							{appearance.icon.kind === 'plugin' ? (
								<SafeSvgIcon
									className="w-5 h-5"
									path={appearance.icon.path}
									viewBox={appearance.icon.viewBox}
								/>
							) : (
								<appearance.icon.Icon className="w-5 h-5" />
							)}
						</div>
					</div>
				)}
				{groupsPlusEnabled && (
					<div className="flex-1">
						<label
							className="block text-xs font-bold opacity-70 uppercase mb-2"
							style={{ color: theme.colors.textMain }}
						>
							Standard icon
						</label>
						<div className="grid grid-cols-8 gap-1">
							{GROUP_ICON_OPTIONS.map((option) => {
								const Icon = option.Icon;
								const selected = icon === option.id;

								return (
									<button
										key={option.id}
										type="button"
										className="p-1.5 rounded border hover:bg-white/5 transition-colors"
										style={{
											borderColor: selected ? theme.colors.accent : theme.colors.border,
											backgroundColor: selected ? `${theme.colors.accent}1A` : 'transparent',
											color: selected
												? appearance.color || theme.colors.accent
												: theme.colors.textDim,
										}}
										onClick={() => {
											onIconChange(option.id);
											onEmojiChange('');
										}}
										aria-label={`Use ${option.label} icon`}
										aria-pressed={selected}
										title={option.label}
									>
										{Icon && <Icon className="w-4 h-4" />}
									</button>
								);
							})}
						</div>
					</div>
				)}
			</div>
			{groupsPlusEnabled && (
				<>
					<label
						className="block text-xs font-bold opacity-70 uppercase mb-2"
						style={{ color: theme.colors.textMain }}
					>
						Label color
					</label>
					<div className="flex items-center gap-2">
						<button
							type="button"
							className="w-5 h-5 rounded border hover:bg-white/5 transition-colors"
							style={{
								borderColor: hasStoredColor ? theme.colors.border : theme.colors.accent,
							}}
							onClick={() => onColorChange(undefined)}
							aria-label="Clear label color"
							aria-pressed={!hasStoredColor}
							title="No color"
						/>
						{hasUnavailableColor && (
							<span
								className="w-5 h-5 rounded-full border opacity-40"
								aria-label="Stored label color unavailable"
								role="img"
								style={{
									backgroundColor: theme.colors.textDim,
									borderColor: theme.colors.border,
								}}
								title="Stored label color is unavailable because its icon pack is disabled"
							/>
						)}
						{GROUP_LABEL_COLORS.map((option) => (
							<button
								key={option.value}
								type="button"
								className="w-5 h-5 rounded-full border-2 transition-colors"
								style={{
									backgroundColor: option.value,
									borderColor: color === option.value ? theme.colors.textMain : 'transparent',
								}}
								onClick={() => onColorChange(option.value)}
								aria-label={`Use ${option.label} label color`}
								aria-pressed={color === option.value}
								title={option.label}
							/>
						))}
					</div>
					{iconPacks.map((pack) => (
						<section key={pack.id}>
							<label
								className="block text-xs font-bold opacity-70 uppercase mb-2"
								style={{ color: theme.colors.textMain }}
							>
								{pack.label}
							</label>
							{pack.icons.length > 0 && (
								<div className="grid grid-cols-8 gap-1">
									{pack.icons.map((option) => {
										const selected = icon === option.id;
										return (
											<button
												key={option.id}
												type="button"
												className="p-1.5 rounded border hover:bg-white/5 transition-colors"
												style={{
													borderColor: selected ? theme.colors.accent : theme.colors.border,
													backgroundColor: selected ? `${theme.colors.accent}1A` : 'transparent',
													color: selected ? previewColor : theme.colors.textDim,
												}}
												onClick={() => {
													onIconChange(option.id);
													onEmojiChange('');
												}}
												aria-label={`Use ${option.label} icon`}
												aria-pressed={selected}
												title={option.label}
											>
												<SafeSvgIcon
													className="w-4 h-4"
													path={option.path}
													viewBox={option.viewBox}
												/>
											</button>
										);
									})}
								</div>
							)}
							{pack.colors.length > 0 && (
								<div className="flex items-center gap-2 mt-2">
									{pack.colors.map((option) => (
										<button
											key={option.id}
											type="button"
											className="w-5 h-5 rounded-full border-2 transition-colors"
											style={{
												backgroundColor: option.value,
												borderColor: color === option.id ? theme.colors.textMain : 'transparent',
											}}
											onClick={() => onColorChange(option.id)}
											aria-label={`Use ${option.label} label color`}
											aria-pressed={color === option.id}
											title={option.label}
										/>
									))}
								</div>
							)}
						</section>
					))}
				</>
			)}
		</div>
	);
}
