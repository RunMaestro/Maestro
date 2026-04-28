/**
 * AutoRunSetupSheet component for Maestro mobile web interface
 *
 * Uses `ResponsiveModal` so it renders as a bottom sheet on phones and a
 * centered dialog at tablet+. The "Launch Auto Run" primary action lives in
 * the modal footer — always visible above the scrolling document list and
 * thumb-reachable on mobile.
 */

import { useState, useCallback, useEffect } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import { ResponsiveModal, Button } from '../components';
import { triggerHaptic, HAPTIC_PATTERNS } from './constants';
import type { AutoRunDocument, LaunchConfig } from '../hooks/useAutoRun';

/**
 * Props for AutoRunSetupSheet component
 */
export interface AutoRunSetupSheetProps {
	isOpen: boolean;
	sessionId: string;
	documents: AutoRunDocument[];
	onLaunch: (config: LaunchConfig) => void;
	onClose: () => void;
}

/**
 * AutoRunSetupSheet component
 *
 * Modal for document selection, optional prompt, and loop configuration
 * before launching Auto Run.
 */
export function AutoRunSetupSheet({
	isOpen,
	sessionId: _sessionId,
	documents,
	onLaunch,
	onClose,
}: AutoRunSetupSheetProps) {
	const colors = useThemeColors();
	const [selectedFiles, setSelectedFiles] = useState<Set<string>>(
		() => new Set(documents.map((d) => d.filename))
	);
	const [prompt, setPrompt] = useState('');
	const [loopEnabled, setLoopEnabled] = useState(false);
	const [maxLoops, setMaxLoops] = useState(3);

	// Reinitialize draft when sessionId or documents change
	useEffect(() => {
		setSelectedFiles(new Set(documents.map((d) => d.filename)));
		setPrompt('');
		setLoopEnabled(false);
		setMaxLoops(3);
	}, [_sessionId, documents]);

	const handleToggleFile = useCallback((filename: string) => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		setSelectedFiles((prev) => {
			const next = new Set(prev);
			if (next.has(filename)) {
				next.delete(filename);
			} else {
				next.add(filename);
			}
			return next;
		});
	}, []);

	const handleToggleAll = useCallback(() => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		if (selectedFiles.size === documents.length) {
			setSelectedFiles(new Set());
		} else {
			setSelectedFiles(new Set(documents.map((d) => d.filename)));
		}
	}, [selectedFiles.size, documents]);

	const handleLoopToggle = useCallback(() => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		setLoopEnabled((prev) => !prev);
	}, []);

	const handleMaxLoopsChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
		const value = parseInt(e.target.value, 10);
		if (!isNaN(value)) {
			setMaxLoops(Math.max(1, Math.min(100, value)));
		}
	}, []);

	const handleLaunch = useCallback(() => {
		if (selectedFiles.size === 0) return;
		triggerHaptic(HAPTIC_PATTERNS.success);
		const config: LaunchConfig = {
			documents: Array.from(selectedFiles).map((filename) => ({ filename })),
			prompt: prompt.trim() || undefined,
			loopEnabled: loopEnabled || undefined,
			maxLoops: loopEnabled ? maxLoops : undefined,
		};
		onLaunch(config);
	}, [selectedFiles, prompt, loopEnabled, maxLoops, onLaunch]);

	const allSelected = selectedFiles.size === documents.length && documents.length > 0;
	const launchDisabled = selectedFiles.size === 0;

	return (
		<ResponsiveModal
			isOpen={isOpen}
			onClose={onClose}
			title="Configure Auto Run"
			zIndex={220}
			footer={
				<Button
					variant="primary"
					fullWidth
					size="lg"
					onClick={handleLaunch}
					disabled={launchDisabled}
					aria-label="Launch Auto Run"
				>
					Launch Auto Run
				</Button>
			}
		>
			{/* Document selector section */}
			<div style={{ marginBottom: '20px' }}>
				{/* Section label + Select All toggle */}
				<div
					style={{
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'space-between',
						marginBottom: '10px',
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
						Documents
					</span>
					<button
						onClick={handleToggleAll}
						style={{
							background: 'none',
							border: 'none',
							color: colors.accent,
							fontSize: '13px',
							fontWeight: 500,
							cursor: 'pointer',
							padding: '4px 8px',
							touchAction: 'manipulation',
							WebkitTapHighlightColor: 'transparent',
						}}
					>
						{allSelected ? 'Deselect All' : 'Select All'}
					</button>
				</div>

				{/* Document checkbox list */}
				<div
					style={{
						display: 'flex',
						flexDirection: 'column',
						gap: '6px',
					}}
				>
					{documents.map((doc) => {
						const isSelected = selectedFiles.has(doc.filename);
						return (
							<button
								key={doc.filename}
								onClick={() => handleToggleFile(doc.filename)}
								style={{
									display: 'flex',
									alignItems: 'center',
									gap: '12px',
									padding: '12px 14px',
									borderRadius: '10px',
									border: `1px solid ${isSelected ? colors.accent : colors.border}`,
									backgroundColor: isSelected ? `${colors.accent}10` : colors.bgSidebar,
									color: colors.textMain,
									width: '100%',
									textAlign: 'left',
									cursor: 'pointer',
									touchAction: 'manipulation',
									WebkitTapHighlightColor: 'transparent',
									outline: 'none',
									minHeight: '44px',
								}}
								aria-label={`${isSelected ? 'Deselect' : 'Select'} ${doc.filename}`}
								aria-pressed={isSelected}
							>
								{/* Checkbox */}
								<div
									style={{
										width: '22px',
										height: '22px',
										borderRadius: '6px',
										border: `2px solid ${isSelected ? colors.accent : colors.textDim}`,
										backgroundColor: isSelected ? colors.accent : 'transparent',
										display: 'flex',
										alignItems: 'center',
										justifyContent: 'center',
										flexShrink: 0,
										transition: 'all 0.15s ease',
									}}
								>
									{isSelected && (
										<svg
											width="14"
											height="14"
											viewBox="0 0 24 24"
											fill="none"
											stroke="white"
											strokeWidth="3"
											strokeLinecap="round"
											strokeLinejoin="round"
										>
											<polyline points="20 6 9 17 4 12" />
										</svg>
									)}
								</div>

								{/* File info */}
								<div style={{ flex: 1, minWidth: 0 }}>
									<div
										style={{
											fontSize: '14px',
											fontWeight: 500,
											overflow: 'hidden',
											textOverflow: 'ellipsis',
											whiteSpace: 'nowrap',
										}}
									>
										{doc.filename}
									</div>
									<div
										style={{
											fontSize: '12px',
											color: colors.textDim,
											marginTop: '2px',
										}}
									>
										{doc.taskCount} {doc.taskCount === 1 ? 'task' : 'tasks'}
									</div>
								</div>
							</button>
						);
					})}
				</div>
			</div>

			{/* Prompt input section */}
			<div style={{ marginBottom: '20px' }}>
				<label
					style={{
						display: 'block',
						fontSize: '13px',
						fontWeight: 600,
						color: colors.textDim,
						textTransform: 'uppercase',
						letterSpacing: '0.5px',
						marginBottom: '8px',
					}}
				>
					Custom Prompt (optional)
				</label>
				<textarea
					value={prompt}
					onChange={(e) => setPrompt(e.target.value)}
					placeholder="Additional instructions for the agent..."
					rows={3}
					style={{
						width: '100%',
						padding: '12px 14px',
						borderRadius: '10px',
						border: `1px solid ${colors.border}`,
						backgroundColor: colors.bgSidebar,
						color: colors.textMain,
						fontSize: '14px',
						lineHeight: 1.5,
						resize: 'vertical',
						outline: 'none',
						fontFamily: 'inherit',
						WebkitAppearance: 'none',
						boxSizing: 'border-box',
					}}
					onFocus={(e) => {
						(e.target as HTMLTextAreaElement).style.borderColor = colors.accent;
					}}
					onBlur={(e) => {
						(e.target as HTMLTextAreaElement).style.borderColor = colors.border;
					}}
				/>
			</div>

			{/* Loop settings section */}
			<div>
				<label
					style={{
						display: 'block',
						fontSize: '13px',
						fontWeight: 600,
						color: colors.textDim,
						textTransform: 'uppercase',
						letterSpacing: '0.5px',
						marginBottom: '10px',
					}}
				>
					Loop Settings
				</label>

				{/* Loop toggle */}
				<button
					onClick={handleLoopToggle}
					style={{
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'space-between',
						width: '100%',
						padding: '12px 14px',
						borderRadius: '10px',
						border: `1px solid ${colors.border}`,
						backgroundColor: colors.bgSidebar,
						color: colors.textMain,
						cursor: 'pointer',
						touchAction: 'manipulation',
						WebkitTapHighlightColor: 'transparent',
						outline: 'none',
						minHeight: '44px',
					}}
					role="switch"
					aria-checked={loopEnabled}
					aria-label="Loop on completion"
				>
					<span style={{ fontSize: '14px', fontWeight: 500 }}>Loop on completion</span>
					{/* Toggle switch */}
					<div
						style={{
							width: '44px',
							height: '26px',
							borderRadius: '13px',
							backgroundColor: loopEnabled ? colors.accent : `${colors.textDim}30`,
							padding: '2px',
							transition: 'background-color 0.2s ease',
							flexShrink: 0,
						}}
					>
						<div
							style={{
								width: '22px',
								height: '22px',
								borderRadius: '11px',
								backgroundColor: 'white',
								transition: 'transform 0.2s ease',
								transform: loopEnabled ? 'translateX(18px)' : 'translateX(0)',
								boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
							}}
						/>
					</div>
				</button>

				{/* Max loops input (visible when loop enabled) */}
				{loopEnabled && (
					<div
						style={{
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'space-between',
							padding: '12px 14px',
							borderRadius: '10px',
							border: `1px solid ${colors.border}`,
							backgroundColor: colors.bgSidebar,
							marginTop: '8px',
						}}
					>
						<span
							style={{
								fontSize: '14px',
								color: colors.textMain,
								fontWeight: 500,
							}}
						>
							Max loops
						</span>
						<input
							type="number"
							value={maxLoops}
							onChange={handleMaxLoopsChange}
							min={1}
							max={100}
							style={{
								width: '70px',
								padding: '8px 10px',
								borderRadius: '8px',
								border: `1px solid ${colors.border}`,
								backgroundColor: colors.bgMain,
								color: colors.textMain,
								fontSize: '14px',
								textAlign: 'center',
								outline: 'none',
								WebkitAppearance: 'none',
								MozAppearance: 'textfield' as never,
							}}
						/>
					</div>
				)}
			</div>
		</ResponsiveModal>
	);
}

export default AutoRunSetupSheet;
