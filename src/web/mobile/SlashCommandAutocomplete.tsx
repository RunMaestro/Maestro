/**
 * SlashCommandAutocomplete - Autocomplete popup for slash commands on mobile
 *
 * Displays a list of available slash commands when the user types `/` in the
 * command input. Touch-friendly interface optimized for mobile devices.
 *
 * Features:
 * - Shows available commands filtered by current input
 * - Filters by input mode (AI-only or terminal-only commands)
 * - Touch-friendly tap targets
 * - Smooth animations for appearing/disappearing
 * - Scrollable list for many commands
 */

import React, { useEffect, useRef, useCallback } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import type { InputMode } from './CommandInputBar';
import { MIN_TOUCH_TARGET } from './constants';

/**
 * Slash command definition
 */
export interface SlashCommand {
	/** The command string (e.g., '/clear') */
	command: string;
	/** Description of what the command does */
	description: string;
	/** Only available in terminal mode */
	terminalOnly?: boolean;
	/** Only available in AI mode */
	aiOnly?: boolean;
}

/**
 * Default slash commands available in the mobile interface
 * These mirror the desktop app's slash commands
 */
export const DEFAULT_SLASH_COMMANDS: SlashCommand[] = [
	{
		command: '/history',
		description: 'Get a synopsis of work since the last /history and add to history',
		aiOnly: true,
	},
	{
		command: '/clear',
		description: 'Clear output history and start new AI session',
	},
	{
		command: '/jump',
		description: 'Jump to CWD in file tree',
		terminalOnly: true,
	},
];

export interface SlashCommandAutocompleteProps {
	/** Whether the autocomplete is visible */
	isOpen: boolean;
	/** Current input value for filtering */
	inputValue: string;
	/** Current input mode (AI or terminal) */
	inputMode: InputMode;
	/** Available slash commands */
	commands?: SlashCommand[];
	/** Called when a command is selected */
	onSelectCommand: (command: string) => void;
	/** Called when the autocomplete should close */
	onClose: () => void;
	/** Currently selected command index */
	selectedIndex?: number;
	/** Called when selected index changes (for keyboard navigation) */
	onSelectedIndexChange?: (index: number) => void;
	/** Whether the input is expanded (affects max height) */
	isInputExpanded?: boolean;
}

/**
 * SlashCommandAutocomplete component
 *
 * Displays a popup with filtered slash commands based on user input.
 */
export function SlashCommandAutocomplete({
	isOpen,
	inputValue,
	inputMode,
	commands = DEFAULT_SLASH_COMMANDS,
	onSelectCommand,
	onClose,
	selectedIndex = 0,
	onSelectedIndexChange,
	isInputExpanded = false,
}: SlashCommandAutocompleteProps) {
	const colors = useThemeColors();
	const containerRef = useRef<HTMLDivElement>(null);

	// Filter commands based on input and mode
	const filteredCommands = commands.filter((cmd) => {
		// Check if command is only available in terminal mode
		if (cmd.terminalOnly && inputMode !== 'terminal') return false;
		// Check if command is only available in AI mode
		if (cmd.aiOnly && inputMode === 'terminal') return false;
		// If input is empty or doesn't start with /, show all commands (opened via button)
		if (!inputValue || !inputValue.startsWith('/')) return true;
		// Check if command matches input (case insensitive)
		return cmd.command.toLowerCase().startsWith(inputValue.toLowerCase());
	});

	// Clamp selectedIndex to valid range when filtered list changes
	useEffect(() => {
		if (filteredCommands.length > 0 && selectedIndex >= filteredCommands.length) {
			onSelectedIndexChange?.(0);
		}
	}, [filteredCommands.length, selectedIndex, onSelectedIndexChange]);

	// Handle command selection
	const handleSelectCommand = useCallback(
		(command: string) => {
			onSelectCommand(command);
			onClose();
		},
		[onSelectCommand, onClose]
	);

	// Handle touch start for visual feedback
	const handleTouchStart = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
		e.currentTarget.style.opacity = '0.7';
	}, []);

	// Handle touch end to restore visual state
	const handleTouchEnd = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
		e.currentTarget.style.opacity = '1';
	}, []);

	// Close autocomplete when clicking outside or pressing Escape
	useEffect(() => {
		if (!isOpen) return;

		const handleClickOutside = (e: MouseEvent | TouchEvent) => {
			if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
				onClose();
			}
		};

		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				onClose();
			}
		};

		document.addEventListener('mousedown', handleClickOutside);
		document.addEventListener('touchstart', handleClickOutside);
		document.addEventListener('keydown', handleKeyDown);

		return () => {
			document.removeEventListener('mousedown', handleClickOutside);
			document.removeEventListener('touchstart', handleClickOutside);
			document.removeEventListener('keydown', handleKeyDown);
		};
	}, [isOpen, onClose]);

	// Don't render if not open or no matching commands
	if (!isOpen || filteredCommands.length === 0) {
		return null;
	}

	return (
		<div
			ref={containerRef}
			style={{
				position: 'absolute',
				bottom: '100%',
				left: '16px',
				right: '16px',
				marginBottom: '8px',
				backgroundColor: colors.bgSidebar,
				border: `1px solid ${colors.border}`,
				borderRadius: '12px',
				boxShadow: '0 -4px 20px rgba(0, 0, 0, 0.2)',
				// When input is not expanded, take more screen space (60vh)
				// When input is expanded, use smaller height (250px)
				maxHeight: isInputExpanded ? '250px' : '60vh',
				overflowY: 'auto',
				overflowX: 'hidden',
				zIndex: 110,
				// Smooth appear animation
				animation: 'slideUp 150ms ease-out',
			}}
		>
			{/* Header with title and close button */}
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
					padding: '10px 16px',
					borderBottom: `1px solid ${colors.border}`,
					position: 'sticky',
					top: 0,
					backgroundColor: colors.bgSidebar,
					zIndex: 1,
				}}
			>
				<span
					style={{
						fontSize: '13px',
						fontWeight: 600,
						color: colors.textDim,
						textTransform: 'uppercase',
						letterSpacing: '0.5px',
					}}
				>
					Commands
				</span>
				<button
					onClick={(e) => {
						e.stopPropagation();
						onClose();
					}}
					style={{
						padding: '6px',
						borderRadius: '6px',
						backgroundColor: 'transparent',
						border: 'none',
						cursor: 'pointer',
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						color: colors.textDim,
						transition: 'background-color 150ms ease, color 150ms ease',
					}}
					onMouseEnter={(e) => {
						e.currentTarget.style.backgroundColor = `${colors.textDim}20`;
						e.currentTarget.style.color = colors.textMain;
					}}
					onMouseLeave={(e) => {
						e.currentTarget.style.backgroundColor = 'transparent';
						e.currentTarget.style.color = colors.textDim;
					}}
					aria-label="Close commands"
				>
					<svg
						width="18"
						height="18"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<line x1="18" y1="6" x2="6" y2="18" />
						<line x1="6" y1="6" x2="18" y2="18" />
					</svg>
				</button>
			</div>

			{/* Command list */}
			{filteredCommands.map((cmd, idx) => {
				// Only show as selected if selectedIndex is within valid range
				const isSelected = idx === selectedIndex && selectedIndex < filteredCommands.length;

				return (
					<div
						key={cmd.command}
						onClick={() => handleSelectCommand(cmd.command)}
						onTouchStart={handleTouchStart}
						onTouchEnd={handleTouchEnd}
						onMouseEnter={() => onSelectedIndexChange?.(idx)}
						style={{
							padding: '12px 16px',
							cursor: 'pointer',
							backgroundColor: isSelected ? colors.accent : 'transparent',
							color: isSelected ? '#ffffff' : colors.textMain,
							transition: 'background-color 100ms ease',
							// Touch-friendly minimum height
							minHeight: `${MIN_TOUCH_TARGET}px`,
							display: 'flex',
							flexDirection: 'column',
							justifyContent: 'center',
							// Border between items
							borderBottom:
								idx < filteredCommands.length - 1 ? `1px solid ${colors.border}` : 'none',
						}}
					>
						{/* Command name */}
						<div
							style={{
								fontFamily: 'ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace',
								fontSize: '15px',
								fontWeight: 500,
							}}
						>
							{cmd.command}
						</div>
						{/* Command description */}
						<div
							style={{
								fontSize: '13px',
								opacity: isSelected ? 0.9 : 0.6,
								marginTop: '2px',
							}}
						>
							{cmd.description}
						</div>
					</div>
				);
			})}

			{/* Inline CSS animation */}
			<style>
				{`
          @keyframes slideUp {
            from {
              opacity: 0;
              transform: translateY(8px);
            }
            to {
              opacity: 1;
              transform: translateY(0);
            }
          }
        `}
			</style>
		</div>
	);
}

export default SlashCommandAutocomplete;
