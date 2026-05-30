import { memo } from 'react';
import type React from 'react';
import { Gauge, Sparkles } from 'lucide-react';
import type { Theme } from '../../../types';

interface ModelEffortPillsProps {
	isVisible: boolean;
	theme: Theme;
	currentModel?: string;
	currentEffort?: string;
	availableModels: string[];
	availableEfforts: string[];
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
	currentModel,
	currentEffort,
	availableModels,
	availableEfforts,
	onModelChange,
	onEffortChange,
	modelMenuOpen,
	setModelMenuOpen,
	modelMenuRef,
	effortMenuOpen,
	setEffortMenuOpen,
	effortMenuRef,
}: ModelEffortPillsProps) {
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
						className="flex items-center gap-1 text-[10px] px-2 py-1 rounded-full cursor-pointer transition-all opacity-60 hover:opacity-100"
						style={{
							backgroundColor: `${theme.colors.accent}10`,
							color: theme.colors.accent,
							border: `1px solid ${theme.colors.accent}25`,
						}}
						title="Change model"
					>
						<Sparkles className="w-3 h-3" />
						<span>{currentModel || 'default'}</span>
					</button>
					{modelMenuOpen && (
						<div
							className="absolute bottom-full left-0 mb-1 max-h-48 overflow-y-auto rounded border shadow-lg z-50 scrollbar-thin"
							style={{
								backgroundColor: theme.colors.bgMain,
								borderColor: theme.colors.border,
							}}
						>
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
						className="flex items-center gap-1 text-[10px] px-2 py-1 rounded-full cursor-pointer transition-all opacity-60 hover:opacity-100"
						style={{
							backgroundColor: `${theme.colors.warning}10`,
							color: theme.colors.warning,
							border: `1px solid ${theme.colors.warning}25`,
						}}
						title="Change effort level"
					>
						<Gauge className="w-3 h-3" />
						<span>{currentEffort || 'default'}</span>
					</button>
					{effortMenuOpen && (
						<div
							className="absolute bottom-full left-0 mb-1 max-h-48 overflow-y-auto rounded border shadow-lg z-50 scrollbar-thin"
							style={{
								backgroundColor: theme.colors.bgMain,
								borderColor: theme.colors.border,
							}}
						>
							{availableEfforts.map((effort) => (
								<button
									key={effort}
									onClick={() => {
										onEffortChange(effort);
										setEffortMenuOpen(false);
									}}
									className="w-full text-left px-3 py-1.5 text-xs whitespace-nowrap hover:bg-white/10 transition-colors"
									style={{
										color: effort === currentEffort ? theme.colors.warning : theme.colors.textMain,
										backgroundColor:
											effort === currentEffort ? 'rgba(255,255,255,0.05)' : undefined,
									}}
								>
									{effort || '(default)'}
								</button>
							))}
						</div>
					)}
				</div>
			)}
		</>
	);
});
