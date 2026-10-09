import { Check, Copy, RotateCcw, Wand2 } from 'lucide-react';
import { Wordmark } from '../../ui/Wordmark';
import { BATON_GLINT_COUNT, EASING_OPTIONS } from '../utils/batonCss';
import type { Theme } from '../../../types';
import type { BatonPlaygroundState } from '../types';

interface BatonViewProps {
	theme: Theme;
	baton: BatonPlaygroundState;
}

/**
 * One preview wand, structured exactly like the shipped `BusyWand`: a wrapper
 * carrying the color, the icon, and N absolutely-positioned glint overlays.
 *
 * The glints have to be real elements here, not a painted approximation, or the
 * panel would be tuning something the app does not render. They use `baton-*`
 * class names so the panel's injected stylesheet drives them without the Left
 * Bar wand twitching along while you drag a slider.
 *
 * Positions are duplicated from `.wand-glint-N` in index.css rather than shared,
 * because those rules are production CSS keyed to production class names. If you
 * move a glint there, move it here.
 */
function BatonPreviewWand({
	sizeClass,
	color,
	active,
}: {
	sizeClass: string;
	color: string;
	active: boolean;
}) {
	const GLINT_POSITIONS = [
		{ top: '0%', left: '4%' },
		{ top: '16%', right: '0%' },
		{ bottom: '8%', right: '20%' },
	];

	return (
		<span className="wand-glints" style={{ color }}>
			<Wand2 className={`${sizeClass}${active ? ' baton-sparkle-active' : ''}`} />
			{active &&
				GLINT_POSITIONS.slice(0, BATON_GLINT_COUNT).map((pos, i) => (
					<span
						key={i}
						className={`wand-glint baton-glint baton-glint-${i + 1}`}
						style={pos}
						aria-hidden="true"
					/>
				))}
		</span>
	);
}

export function BatonView({ theme, baton }: BatonViewProps) {
	return (
		<div className="grid grid-cols-2 gap-6">
			<div className="space-y-6">
				<div
					className="p-6 rounded-lg border flex flex-col items-center gap-4"
					style={{
						borderColor: theme.colors.border,
						backgroundColor: theme.colors.bgActivity,
					}}
				>
					<h3 className="text-sm font-bold self-start" style={{ color: theme.colors.textMain }}>
						Large Preview (4x)
					</h3>
					<div
						className="flex items-center gap-4 p-6 rounded-lg"
						style={{ backgroundColor: theme.colors.bgSidebar }}
					>
						<BatonPreviewWand
							sizeClass="w-20 h-20"
							color={theme.colors.accent}
							active={baton.batonActive}
						/>
						<div className="flex flex-col gap-1">
							<Wordmark className="text-3xl" style={{ color: theme.colors.textMain }} />
							<span className="text-xs" style={{ color: theme.colors.textDim }}>
								{baton.batonActive ? 'Animation active' : 'Animation paused'}
							</span>
						</div>
					</div>
				</div>

				<div
					className="p-6 rounded-lg border"
					style={{
						borderColor: theme.colors.border,
						backgroundColor: theme.colors.bgActivity,
					}}
				>
					<h3 className="text-sm font-bold mb-4" style={{ color: theme.colors.textMain }}>
						Real Size Preview
					</h3>
					<div className="flex flex-col gap-4">
						<div className="flex items-center gap-3">
							<span className="text-xs w-20 shrink-0" style={{ color: theme.colors.textDim }}>
								Expanded:
							</span>
							<div
								className="flex items-center gap-2 px-4 py-3 rounded-lg"
								style={{ backgroundColor: theme.colors.bgSidebar }}
							>
								<BatonPreviewWand
									sizeClass="w-5 h-5"
									color={theme.colors.accent}
									active={baton.batonActive}
								/>
								<Wordmark className="text-lg" style={{ color: theme.colors.textMain }} />
							</div>
						</div>
						<div className="flex items-center gap-3">
							<span className="text-xs w-20 shrink-0" style={{ color: theme.colors.textDim }}>
								Collapsed:
							</span>
							<div className="p-2 rounded-lg" style={{ backgroundColor: theme.colors.bgSidebar }}>
								<BatonPreviewWand
									sizeClass="w-6 h-6"
									color={theme.colors.accent}
									active={baton.batonActive}
								/>
							</div>
						</div>
						<div className="flex items-center gap-3">
							<span className="text-xs w-20 shrink-0" style={{ color: theme.colors.textDim }}>
								Sizes:
							</span>
							<div className="flex items-center gap-4">
								{[3, 4, 5, 6, 8].map((size) => (
									<div key={size} className="flex flex-col items-center gap-1">
										<BatonPreviewWand
											sizeClass={`w-${size} h-${size}`}
											color={theme.colors.accent}
											active={baton.batonActive}
										/>
										<span className="text-2xs" style={{ color: theme.colors.textDim }}>
											{size * 4}px
										</span>
									</div>
								))}
							</div>
						</div>
					</div>
				</div>
			</div>

			<div className="space-y-4">
				<div
					className="p-4 rounded-lg border"
					style={{
						borderColor: theme.colors.border,
						backgroundColor: theme.colors.bgActivity,
					}}
				>
					<div className="flex items-center justify-between mb-3">
						<h3 className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
							Animation
						</h3>
						<button
							onClick={baton.toggleBatonActive}
							className="px-3 py-1 rounded text-sm font-medium transition-colors"
							style={{
								backgroundColor: baton.batonActive ? theme.colors.accent : theme.colors.bgMain,
								color: baton.batonActive ? theme.colors.accentForeground : theme.colors.textMain,
							}}
						>
							{baton.batonActive ? 'Active' : 'Paused'}
						</button>
					</div>
				</div>

				<div
					className="p-4 rounded-lg border"
					style={{
						borderColor: theme.colors.border,
						backgroundColor: theme.colors.bgActivity,
					}}
				>
					<h3 className="text-sm font-bold mb-3" style={{ color: theme.colors.textMain }}>
						Timing
					</h3>
					<div className="space-y-3">
						<div>
							<label
								className="text-xs flex justify-between"
								style={{ color: theme.colors.textDim }}
							>
								<span>Duration (cycle)</span>
								<span>{baton.duration.toFixed(1)}s</span>
							</label>
							<input
								type="range"
								min={0.5}
								max={8}
								step={0.1}
								value={baton.duration}
								onChange={(e) => baton.setDuration(Number(e.target.value))}
								className="w-full"
							/>
						</div>
						<div>
							<label
								className="text-xs flex justify-between"
								style={{ color: theme.colors.textDim }}
							>
								<span>Peak brightness</span>
								<span>{baton.peakAt}%</span>
							</label>
							<input
								type="range"
								min={10}
								max={49}
								step={1}
								value={baton.peakAt}
								onChange={(e) => baton.setPeakAt(Number(e.target.value))}
								className="w-full"
							/>
						</div>
						<div>
							<label
								className="text-xs flex justify-between"
								style={{ color: theme.colors.textDim }}
							>
								<span>Faded back out by</span>
								<span>{baton.settleAt}%</span>
							</label>
							<input
								type="range"
								min={51}
								max={90}
								step={1}
								value={baton.settleAt}
								onChange={(e) => baton.setSettleAt(Number(e.target.value))}
								className="w-full"
							/>
						</div>
						<div>
							<label
								className="text-xs flex justify-between"
								style={{ color: theme.colors.textDim }}
							>
								<span>Stagger offset</span>
								<span>{baton.staggerOffset.toFixed(2)}s</span>
							</label>
							<input
								type="range"
								min={0}
								max={2}
								step={0.05}
								value={baton.staggerOffset}
								onChange={(e) => baton.setStaggerOffset(Number(e.target.value))}
								className="w-full"
							/>
						</div>
					</div>
				</div>

				<div
					className="p-4 rounded-lg border"
					style={{
						borderColor: theme.colors.border,
						backgroundColor: theme.colors.bgActivity,
					}}
				>
					<h3 className="text-sm font-bold mb-3" style={{ color: theme.colors.textMain }}>
						Movement
					</h3>
					<div className="space-y-3">
						<div>
							<label
								className="text-xs flex justify-between"
								style={{ color: theme.colors.textDim }}
							>
								<span>Translate amount</span>
								<span>{baton.translateAmount.toFixed(1)}px</span>
							</label>
							<input
								type="range"
								min={0}
								max={3}
								step={0.1}
								value={baton.translateAmount}
								onChange={(e) => baton.setTranslateAmount(Number(e.target.value))}
								className="w-full"
							/>
						</div>
						<div>
							<label className="text-xs mb-1 block" style={{ color: theme.colors.textDim }}>
								Easing
							</label>
							<div className="flex flex-wrap gap-1">
								{EASING_OPTIONS.map((easing) => (
									<button
										key={easing}
										onClick={() => baton.setEasing(easing)}
										className="px-2 py-1 rounded text-xs font-medium transition-colors"
										style={{
											backgroundColor:
												baton.easing === easing ? theme.colors.accent : theme.colors.bgMain,
											color:
												baton.easing === easing
													? theme.colors.accentForeground
													: theme.colors.textMain,
										}}
									>
										{easing.startsWith('cubic') ? 'material' : easing}
									</button>
								))}
							</div>
						</div>
					</div>
				</div>

				<div className="space-y-2">
					<button
						onClick={baton.copyBatonSettings}
						className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded font-medium transition-colors"
						style={{
							backgroundColor: baton.batonCopySuccess ? theme.colors.success : theme.colors.bgMain,
							color: baton.batonCopySuccess ? theme.colors.accentForeground : theme.colors.textMain,
							border: `1px solid ${baton.batonCopySuccess ? theme.colors.success : theme.colors.border}`,
						}}
					>
						{baton.batonCopySuccess ? (
							<>
								<Check className="w-4 h-4" />
								Copied CSS!
							</>
						) : (
							<>
								<Copy className="w-4 h-4" />
								Copy CSS Settings
							</>
						)}
					</button>

					<button
						onClick={baton.resetBatonDefaults}
						className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded font-medium transition-colors border"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textDim,
						}}
					>
						<RotateCcw className="w-4 h-4" />
						Reset to Defaults
					</button>
				</div>
			</div>
		</div>
	);
}
