import { Check, Copy, RotateCcw, Wand2 } from 'lucide-react';
import { EASING_OPTIONS } from '../utils/batonCss';
import type { Theme } from '../../../types';
import type { BatonPlaygroundState } from '../types';

interface BatonViewProps {
	theme: Theme;
	baton: BatonPlaygroundState;
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
						<Wand2
							className={`w-20 h-20${baton.batonActive ? ' baton-sparkle-active' : ''}`}
							style={{ color: theme.colors.accent }}
						/>
						<div className="flex flex-col gap-1">
							<span
								className="font-bold tracking-widest text-3xl"
								style={{ color: theme.colors.textMain }}
							>
								MAESTRO
							</span>
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
								<Wand2
									className={`w-5 h-5${baton.batonActive ? ' baton-sparkle-active' : ''}`}
									style={{ color: theme.colors.accent }}
								/>
								<span
									className="font-bold tracking-widest text-lg"
									style={{ color: theme.colors.textMain }}
								>
									MAESTRO
								</span>
							</div>
						</div>
						<div className="flex items-center gap-3">
							<span className="text-xs w-20 shrink-0" style={{ color: theme.colors.textDim }}>
								Collapsed:
							</span>
							<div className="p-2 rounded-lg" style={{ backgroundColor: theme.colors.bgSidebar }}>
								<Wand2
									className={`w-6 h-6${baton.batonActive ? ' baton-sparkle-active' : ''}`}
									style={{ color: theme.colors.accent }}
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
										<Wand2
											className={`w-${size} h-${size}${baton.batonActive ? ' baton-sparkle-active' : ''}`}
											style={{ color: theme.colors.accent }}
										/>
										<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
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
								<span>Fade-out start</span>
								<span>{baton.fadeOutStart}%</span>
							</label>
							<input
								type="range"
								min={10}
								max={49}
								step={1}
								value={baton.fadeOutStart}
								onChange={(e) => baton.setFadeOutStart(Number(e.target.value))}
								className="w-full"
							/>
						</div>
						<div>
							<label
								className="text-xs flex justify-between"
								style={{ color: theme.colors.textDim }}
							>
								<span>Fade-in start</span>
								<span>{baton.fadeInStart}%</span>
							</label>
							<input
								type="range"
								min={51}
								max={90}
								step={1}
								value={baton.fadeInStart}
								onChange={(e) => baton.setFadeInStart(Number(e.target.value))}
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
