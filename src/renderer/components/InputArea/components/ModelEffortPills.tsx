import { memo, useState } from 'react';
import type React from 'react';
import { Gauge, Sparkles } from 'lucide-react';
import type { Theme } from '../../../types';
import { ShortcutHint, shortcutSuffix } from '../../ui/ShortcutHint';
import { isAutoModel } from '../../../../shared/autoModel';
import { modelChoiceLabel } from '../../../../shared/autoTurn';
import { FilterInput } from '../../ui/FilterInput';
import { ResizeHandles } from '../../ui/ResizeHandles';
import { useResizableModal } from '../../../hooks/ui/useResizableModal';
import { elevatedSurfaceStyle } from '../../../utils/elevatedSurface';

interface ModelEffortPillsProps {
	isVisible: boolean;
	theme: Theme;
	/**
	 * Chord for the full-screen model/effort switcher, pinned as a hint row at
	 * the top of both dropdowns ("Try: ⌥ ⌘ .").
	 *
	 * Passed in rather than hardcoded because the chord is a rebindable
	 * shortcut, and because not every surface that shows these pills is one the
	 * shortcut can act on: it retunes the ACTIVE tab, so the composer offers the
	 * hint while the queued-message editor (which edits one pending item, not
	 * the tab) leaves it undefined. Omit it and no header row renders.
	 */
	shortcutKeys?: string[];
	currentModel?: string;
	currentEffort?: string;
	availableModels: string[];
	availableEfforts: string[];
	/**
	 * What the Auto model choice says for this agent (`useAutoModelChoice`):
	 * which axes it acts on and which router decides. The tooltip of the Auto row
	 * and, while Auto is the selection, of the pill. The row itself is in
	 * `availableModels` (`withAutoModelOption`), so a caller that does not offer
	 * Auto passes neither.
	 */
	autoModelTitle?: string;
	onModelChange?: (model: string) => void;
	onEffortChange?: (effort: string) => void;
	modelMenuOpen: boolean;
	setModelMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
	modelMenuRef: React.RefObject<HTMLDivElement>;
	effortMenuOpen: boolean;
	setEffortMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
	effortMenuRef: React.RefObject<HTMLDivElement>;
}

export const ModelEffortPills = memo(function ModelEffortPills({
	isVisible,
	theme,
	shortcutKeys,
	currentModel,
	currentEffort,
	availableModels,
	availableEfforts,
	autoModelTitle,
	onModelChange,
	onEffortChange,
	modelMenuOpen,
	setModelMenuOpen,
	modelMenuRef,
	effortMenuOpen,
	setEffortMenuOpen,
	effortMenuRef,
}: ModelEffortPillsProps) {
	const [typedModel, setTypedModel] = useState('');
	const [modelFilter, setModelFilter] = useState('');
	const modelMenu = useResizableModal({
		resizeKey: 'composer-model-picker',
		defaultSize: { width: 420, height: 320 },
		minSize: { width: 260, height: 180 },
		anchor: 'bottom-left',
		enabled: isVisible && modelMenuOpen,
	});
	const modelOptions = availableModels.includes('') ? availableModels : ['', ...availableModels];
	const query = modelFilter.trim().toLowerCase();
	const filteredModels = modelOptions.filter((model) =>
		(model ? modelChoiceLabel(model) : '(default)').toLowerCase().includes(query)
	);

	if (!isVisible) {
		return null;
	}

	return (
		<>
			{onModelChange && availableModels.length > 0 && (
				<div className="relative min-w-0 max-w-full" ref={modelMenuRef} data-tour="model-selector">
					<button
						onClick={() => {
							setModelFilter('');
							setModelMenuOpen(!modelMenuOpen);
							setEffortMenuOpen(false);
						}}
						className="flex max-w-full items-center gap-1 whitespace-nowrap text-2xs px-2 py-1 rounded-full cursor-pointer transition-all opacity-60 hover:opacity-100"
						style={{
							backgroundColor: `${theme.colors.accent}10`,
							color: theme.colors.accent,
							border: `1px solid ${theme.colors.accent}25`,
						}}
						title={
							isAutoModel(currentModel) && autoModelTitle
								? `${autoModelTitle} Click to change${shortcutSuffix(shortcutKeys)}`
								: `Change model${shortcutSuffix(shortcutKeys)}`
						}
					>
						<Sparkles className="w-3 h-3 shrink-0" />
						<span className="max-w-48 truncate">
							{currentModel ? modelChoiceLabel(currentModel) : 'default'}
						</span>
					</button>
					{modelMenuOpen && (
						<div
							ref={modelMenu.modalRef}
							data-testid="model-picker"
							className="absolute bottom-full left-0 mb-1 flex flex-col rounded z-50"
							style={{
								...modelMenu.style,
								...elevatedSurfaceStyle(theme),
							}}
						>
							<ShortcutHint theme={theme} keys={shortcutKeys ?? []} label="Try:" variant="row" />
							<div className="shrink-0 flex p-2">
								<FilterInput
									theme={theme}
									value={modelFilter}
									onChange={setModelFilter}
									placeholder="Filter models..."
									width={0}
									className="flex-1 min-w-0"
									autoFocus
									onKeyDown={(event) => {
										event.stopPropagation();
										if (event.key === 'Escape') setModelMenuOpen(false);
									}}
								/>
							</div>
							<div className="flex-1 min-h-0 overflow-auto scrollbar-thin">
								{filteredModels.map((model) => (
									<button
										key={model || '__default__'}
										onClick={() => {
											onModelChange(model);
											setModelMenuOpen(false);
										}}
										title={isAutoModel(model) ? autoModelTitle : undefined}
										className="w-full text-left px-3 py-1.5 text-xs font-mono whitespace-nowrap hover:bg-white/10 transition-colors"
										style={{
											color: model === currentModel ? theme.colors.accent : theme.colors.textMain,
											backgroundColor:
												model === currentModel ? 'rgba(255,255,255,0.05)' : undefined,
										}}
									>
										{model ? modelChoiceLabel(model) : '(default)'}
									</button>
								))}
								{filteredModels.length === 0 && (
									<div className="px-3 py-2 text-xs" style={{ color: theme.colors.textDim }}>
										No matching models
									</div>
								)}
							</div>
							{/*
							 * Escape hatch for a model discovery cannot know about: a preview or
							 * limited-access model that the CLI's published catalog does not list
							 * and that this machine has never run. The typed ID is applied like
							 * any other selection, so it persists as the tab's model.
							 *
							 * It reaches this dropdown only once the CLI records a run of it in
							 * `lastModelUsage`, which the interactive (maestro-p) spawn path does
							 * and `claude --print` does not - so on an API-mode tab this field
							 * stays the way in.
							 */}
							<div
								className="shrink-0 border-t px-3 py-1.5"
								style={{ borderColor: theme.colors.border }}
							>
								<input
									type="text"
									value={typedModel}
									onChange={(e) => setTypedModel(e.target.value)}
									onKeyDown={(e) => {
										// The composer and the global shortcuts both listen for plain
										// keys; typing a model ID must not reach them. That includes
										// Escape, which elsewhere interrupts the turn - but swallowing
										// it outright left the field with no way out, so it closes the
										// menu here instead of doing nothing.
										e.stopPropagation();
										if (e.key === 'Escape') {
											setTypedModel('');
											setModelMenuOpen(false);
											return;
										}
										if (e.key !== 'Enter') {
											return;
										}
										// Enter confirms an IME candidate mid-composition; committing
										// there would apply half a model ID and close the menu.
										if (e.nativeEvent.isComposing) {
											return;
										}
										const next = typedModel.trim();
										if (!next) {
											return;
										}
										onModelChange(next);
										setTypedModel('');
										setModelMenuOpen(false);
									}}
									placeholder="Or type a model ID"
									aria-label="Use a model ID that is not listed"
									className="w-full bg-transparent text-xs font-mono outline-none placeholder:opacity-50"
									style={{ color: theme.colors.textMain }}
								/>
							</div>
							<ResizeHandles
								onResizeStart={modelMenu.onResizeStart}
								onResetSize={modelMenu.onResetSize}
								canReset={modelMenu.canReset}
								accentColor={theme.colors.accent}
								directions={['n', 'e', 'ne']}
							/>
						</div>
					)}
				</div>
			)}
			{onEffortChange && availableEfforts.some((e) => e !== '') && (
				<div className="relative shrink-0" ref={effortMenuRef} data-tour="effort-selector">
					<button
						onClick={() => {
							setEffortMenuOpen(!effortMenuOpen);
							setModelMenuOpen(false);
						}}
						className="flex items-center gap-1 whitespace-nowrap text-2xs px-2 py-1 rounded-full cursor-pointer transition-all opacity-60 hover:opacity-100"
						style={{
							backgroundColor: `${theme.colors.warning}10`,
							color: theme.colors.warning,
							border: `1px solid ${theme.colors.warning}25`,
						}}
						title={`Change effort level${shortcutSuffix(shortcutKeys)}`}
					>
						<Gauge className="w-3 h-3 shrink-0" />
						<span>{currentEffort || 'default'}</span>
					</button>
					{effortMenuOpen && (
						<div
							className="absolute bottom-full left-0 mb-1 rounded z-50"
							style={{
								...elevatedSurfaceStyle(theme),
							}}
						>
							<ShortcutHint theme={theme} keys={shortcutKeys ?? []} label="Try:" variant="row" />
							<div className="max-h-48 overflow-y-auto scrollbar-thin">
								{availableEfforts.map((effort) => (
									<button
										key={effort}
										onClick={() => {
											onEffortChange(effort);
											setEffortMenuOpen(false);
										}}
										className="w-full text-left px-3 py-1.5 text-xs whitespace-nowrap hover:bg-white/10 transition-colors"
										style={{
											color:
												effort === currentEffort ? theme.colors.warning : theme.colors.textMain,
											backgroundColor:
												effort === currentEffort ? 'rgba(255,255,255,0.05)' : undefined,
										}}
									>
										{effort || '(default)'}
									</button>
								))}
							</div>
						</div>
					)}
				</div>
			)}
		</>
	);
});
