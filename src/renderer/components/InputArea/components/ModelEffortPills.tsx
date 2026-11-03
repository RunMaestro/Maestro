import { memo, useState } from 'react';
import type React from 'react';
import { Gauge, RefreshCw, Sparkles } from 'lucide-react';
import type { Theme } from '../../../types';
import { ShortcutHint, shortcutSuffix } from '../../ui/ShortcutHint';
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
	onModelChange?: (model: string) => void;
	onEffortChange?: (effort: string) => void;
	/**
	 * Re-run model discovery past the cache, for a model added since the list
	 * loaded (a fresh `ollama pull`). Drawn at the right end of the model
	 * dropdown's header row; omit it and no Refresh is offered.
	 */
	onRefreshModels?: () => void;
	/** Spins the Refresh icon and blocks a second click while one is running. */
	refreshingModels?: boolean;
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
	onModelChange,
	onEffortChange,
	onRefreshModels,
	refreshingModels = false,
	modelMenuOpen,
	setModelMenuOpen,
	modelMenuRef,
	effortMenuOpen,
	setEffortMenuOpen,
	effortMenuRef,
}: ModelEffortPillsProps) {
	const [typedModel, setTypedModel] = useState('');

	if (!isVisible) {
		return null;
	}

	return (
		<>
			{onModelChange && availableModels.length > 0 && (
				<div className="relative" ref={modelMenuRef} data-tour="model-selector">
					<button
						onClick={() => {
							setModelMenuOpen(!modelMenuOpen);
							setEffortMenuOpen(false);
						}}
						className="flex items-center gap-1 text-2xs px-2 py-1 rounded-full cursor-pointer transition-all opacity-60 hover:opacity-100"
						style={{
							backgroundColor: `${theme.colors.accent}10`,
							color: theme.colors.accent,
							border: `1px solid ${theme.colors.accent}25`,
						}}
						title={`Change model${shortcutSuffix(shortcutKeys)}`}
					>
						<Sparkles className="w-3 h-3" />
						<span>{currentModel || 'default'}</span>
					</button>
					{modelMenuOpen && (
						<div
							className="absolute bottom-full left-0 mb-1 rounded z-50"
							style={{
								...elevatedSurfaceStyle(theme),
							}}
						>
							<ShortcutHint
								theme={theme}
								keys={shortcutKeys ?? []}
								label="Try:"
								variant="row"
								trailing={
									onRefreshModels && (
										<button
											type="button"
											onClick={onRefreshModels}
											disabled={refreshingModels}
											className="flex items-center gap-1 font-sans rounded px-1 transition-opacity opacity-80 hover:opacity-100 disabled:cursor-default"
											style={{ color: theme.colors.accent }}
											title="Re-read the model list (picks up newly installed models)"
											aria-label="Refresh model list"
											aria-busy={refreshingModels}
										>
											<RefreshCw className={`w-3 h-3 ${refreshingModels ? 'animate-spin' : ''}`} />
											<span>Refresh</span>
										</button>
									)
								}
							/>
							<div className="max-h-48 overflow-y-auto scrollbar-thin">
								{(availableModels.includes('') ? availableModels : ['', ...availableModels]).map(
									(model) => (
										<button
											key={model || '__default__'}
											onClick={() => {
												onModelChange(model);
												setModelMenuOpen(false);
											}}
											className="w-full text-left px-3 py-1.5 text-xs font-mono whitespace-nowrap hover:bg-white/10 transition-colors"
											style={{
												color: model === currentModel ? theme.colors.accent : theme.colors.textMain,
												backgroundColor:
													model === currentModel ? 'rgba(255,255,255,0.05)' : undefined,
											}}
										>
											{model || '(default)'}
										</button>
									)
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
							<div className="border-t px-3 py-1.5" style={{ borderColor: theme.colors.border }}>
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
						</div>
					)}
				</div>
			)}
			{onEffortChange && availableEfforts.some((e) => e !== '') && (
				<div className="relative" ref={effortMenuRef} data-tour="effort-selector">
					<button
						onClick={() => {
							setEffortMenuOpen(!effortMenuOpen);
							setModelMenuOpen(false);
						}}
						className="flex items-center gap-1 text-2xs px-2 py-1 rounded-full cursor-pointer transition-all opacity-60 hover:opacity-100"
						style={{
							backgroundColor: `${theme.colors.warning}10`,
							color: theme.colors.warning,
							border: `1px solid ${theme.colors.warning}25`,
						}}
						title={`Change effort level${shortcutSuffix(shortcutKeys)}`}
					>
						<Gauge className="w-3 h-3" />
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
