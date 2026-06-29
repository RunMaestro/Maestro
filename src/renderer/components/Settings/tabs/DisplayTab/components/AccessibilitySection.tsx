import { Accessibility, Eye, HelpCircle } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import { ToggleButtonGroup } from '../../../../ToggleButtonGroup';
import type { Theme } from '../../../../../types';
import { DEFAULT_BIONIFY_ALGORITHM } from '../../../../../utils/bionifyReadingMode';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';
import type { BionifyAlgorithmState } from '../types';
import { SectionCard } from './SectionCard';
import { ToggleSettingRow } from './ToggleSettingRow';

interface AccessibilitySectionProps {
	theme: Theme;
	colorBlindMode: boolean;
	setColorBlindMode: (enabled: boolean) => void;
	bionifyReadingMode: boolean;
	setBionifyReadingMode: (enabled: boolean) => void;
	bionifyIntensity: number;
	setBionifyIntensity: (value: number) => void;
	bionifyAlgorithmState: BionifyAlgorithmState;
}

export function AccessibilitySection({
	theme,
	colorBlindMode,
	setColorBlindMode,
	bionifyReadingMode,
	setBionifyReadingMode,
	bionifyIntensity,
	setBionifyIntensity,
	bionifyAlgorithmState,
}: AccessibilitySectionProps) {
	const handleAlgorithmKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === 'Enter') {
			event.currentTarget.blur();
		}
	};

	return (
		<div>
			<SettingsSectionHeading icon={Accessibility}>Accessibility</SettingsSectionHeading>
			<p className="text-xs opacity-50 mb-2">
				Visual options that adapt the interface for color vision deficiencies and long-form reading.
			</p>

			<div data-setting-id="display-colorblind-mode" className="mb-3">
				<SectionCard theme={theme}>
					<ToggleSettingRow
						theme={theme}
						title={
							<span className="font-medium flex items-center gap-2">
								<Eye className="w-4 h-4" />
								<span>Color Blind Mode</span>
							</span>
						}
						description={
							<span style={{ color: theme.colors.textDim }}>
								Swap red/green/yellow semantics for Wong&apos;s colorblind-safe palette across agent
								status dots, diff add/remove, git status, the activity graph, Usage Dashboard
								charts, and file extension badges.
							</span>
						}
						checked={colorBlindMode}
						onChange={setColorBlindMode}
						ariaLabel="Color blind mode"
						clickableRow
					/>
				</SectionCard>
			</div>

			<div data-setting-id="display-bionify-reading-mode">
				<SectionCard theme={theme}>
					<ToggleSettingRow
						theme={theme}
						title={
							<span className="font-medium flex items-center gap-2">
								<span>Bionify Emphasis</span>
								<button
									type="button"
									onClick={(event) => {
										event.stopPropagation();
										bionifyAlgorithmState.openInfoModal();
									}}
									className="inline-flex items-center justify-center rounded transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30"
									style={{ width: '20px', height: '20px', color: theme.colors.textDim }}
									aria-label="Info"
									title="Bionify algorithm info"
								>
									<HelpCircle className="w-3.5 h-3.5" />
								</button>
							</span>
						}
						checked={bionifyReadingMode}
						onChange={setBionifyReadingMode}
						ariaLabel="Bionify reading mode"
						clickableRow
					/>

					<div
						className="space-y-4 pt-3 border-t"
						style={{
							borderColor: theme.colors.border,
							opacity: bionifyReadingMode ? 1 : 0.4,
							pointerEvents: bionifyReadingMode ? 'auto' : 'none',
						}}
					>
						<div>
							<div
								className="block text-xs font-bold opacity-70 uppercase mb-2"
								style={{ color: theme.colors.textDim }}
							>
								Intensity
							</div>
							<ToggleButtonGroup
								options={[
									{ value: 0.85, label: 'Soft' },
									{ value: 1, label: 'Default' },
									{ value: 1.35, label: 'Strong' },
								]}
								value={bionifyIntensity}
								onChange={setBionifyIntensity}
								theme={theme}
								disabled={!bionifyReadingMode}
							/>
							<p className="text-xs opacity-50 mt-2">
								Controls how hard the emphasis hits. Strong increases emphasis weight and fades the
								remaining characters more aggressively.
							</p>
						</div>

						<div>
							<label
								htmlFor="bionify-algorithm-input"
								className="block text-xs font-bold opacity-70 uppercase mb-2"
							>
								Bionify Algorithm
							</label>
							<input
								id="bionify-algorithm-input"
								aria-label="Bionify algorithm"
								type="text"
								value={bionifyAlgorithmState.algorithmDraft}
								onChange={(event) => bionifyAlgorithmState.setAlgorithmDraft(event.target.value)}
								onBlur={bionifyAlgorithmState.commitAlgorithmDraft}
								onKeyDown={handleAlgorithmKeyDown}
								className="w-full px-3 py-2 rounded text-sm outline-none focus-visible:ring-1 focus-visible:ring-white/30"
								style={{
									backgroundColor: theme.colors.bgMain,
									color: theme.colors.textMain,
									border: `1px solid ${
										bionifyAlgorithmState.isAlgorithmValid
											? theme.colors.border
											: theme.colors.warning
									}`,
								}}
								placeholder={DEFAULT_BIONIFY_ALGORITHM}
								spellCheck={false}
								disabled={!bionifyReadingMode}
							/>
							<p className="text-xs opacity-50 mt-2">
								Format: sign, four fixed word-length rules, then a fallback fraction. Example: `- 0
								1 1 2 0.4`
							</p>
							{!bionifyAlgorithmState.isAlgorithmValid && (
								<p className="text-xs mt-2" style={{ color: theme.colors.warning }}>
									Enter `+|- len1 len2 len3 len4 fraction`, for example `- 0 1 1 2 0.4`.
								</p>
							)}
						</div>
					</div>
				</SectionCard>
			</div>
		</div>
	);
}
