import { Check, Copy, RotateCcw, Sparkles } from 'lucide-react';
import { CONFETTI_SHAPES, GRID_LABELS, type ConfettiShape } from '../utils/confettiSettings';
import type { Theme } from '../../../types';
import type { ConfettiPlaygroundState } from '../types';

interface ConfettiViewProps {
	theme: Theme;
	confetti: ConfettiPlaygroundState;
}

function shapeLabel(shape: ConfettiShape): string {
	if (shape === 'square') return '■ square';
	if (shape === 'circle') return '● circle';
	return '★ star';
}

export function ConfettiView({ theme, confetti }: ConfettiViewProps) {
	return (
		<div className="grid grid-cols-2 gap-6">
			<div className="space-y-4">
				<div
					className="p-4 rounded-lg border"
					style={{
						borderColor: theme.colors.border,
						backgroundColor: theme.colors.bgActivity,
					}}
				>
					<h3 className="text-sm font-bold mb-3" style={{ color: theme.colors.textMain }}>
						Launch Origins (click to toggle)
					</h3>
					<div className="grid grid-cols-3 gap-2 w-fit mx-auto">
						{GRID_LABELS.map((row, rowIdx) =>
							row.map((label, colIdx) => {
								const key = `${rowIdx}-${colIdx}`;
								const isSelected = confetti.selectedOrigins.has(key);
								return (
									<button
										key={key}
										onClick={() => confetti.toggleOrigin(rowIdx, colIdx)}
										className="w-16 h-16 rounded-lg text-xs font-medium transition-all hover:scale-105"
										style={{
											backgroundColor: isSelected ? theme.colors.accent : theme.colors.bgMain,
											color: isSelected ? theme.colors.accentForeground : theme.colors.textDim,
											border: `2px solid ${isSelected ? theme.colors.accent : theme.colors.border}`,
										}}
										title={label}
									>
										{label.split(' ').map((word, i) => (
											<div key={i}>{word}</div>
										))}
									</button>
								);
							})
						)}
					</div>
					<p className="text-xs mt-3 text-center" style={{ color: theme.colors.textDim }}>
						{confetti.selectedOrigins.size === 0
							? 'Select at least one origin'
							: `${confetti.selectedOrigins.size} origin${confetti.selectedOrigins.size > 1 ? 's' : ''} selected`}
					</p>
				</div>

				<div
					className="p-4 rounded-lg border"
					style={{
						borderColor: theme.colors.border,
						backgroundColor: theme.colors.bgActivity,
					}}
				>
					<h3 className="text-sm font-bold mb-3" style={{ color: theme.colors.textMain }}>
						Basic Parameters
					</h3>
					<div className="space-y-3">
						<div>
							<label
								className="text-xs flex justify-between"
								style={{ color: theme.colors.textDim }}
							>
								<span>Particle Count</span>
								<span>{confetti.particleCount}</span>
							</label>
							<input
								type="range"
								min={10}
								max={500}
								value={confetti.particleCount}
								onChange={(e) => confetti.setParticleCount(Number(e.target.value))}
								className="w-full"
							/>
						</div>
						<div>
							<label
								className="text-xs flex justify-between"
								style={{ color: theme.colors.textDim }}
							>
								<span>Angle (degrees)</span>
								<span>{confetti.angle}°</span>
							</label>
							<input
								type="range"
								min={0}
								max={360}
								value={confetti.angle}
								onChange={(e) => confetti.setAngle(Number(e.target.value))}
								className="w-full"
							/>
						</div>
						<div>
							<label
								className="text-xs flex justify-between"
								style={{ color: theme.colors.textDim }}
							>
								<span>Spread (degrees)</span>
								<span>{confetti.spread}°</span>
							</label>
							<input
								type="range"
								min={0}
								max={360}
								value={confetti.spread}
								onChange={(e) => confetti.setSpread(Number(e.target.value))}
								className="w-full"
							/>
						</div>
						<div>
							<label
								className="text-xs flex justify-between"
								style={{ color: theme.colors.textDim }}
							>
								<span>Start Velocity</span>
								<span>{confetti.startVelocity}</span>
							</label>
							<input
								type="range"
								min={1}
								max={100}
								value={confetti.startVelocity}
								onChange={(e) => confetti.setStartVelocity(Number(e.target.value))}
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
						Shapes
					</h3>
					<div className="flex gap-2">
						{CONFETTI_SHAPES.map((shape) => (
							<button
								key={shape}
								onClick={() => confetti.toggleShape(shape)}
								className="flex-1 px-3 py-2 rounded text-sm font-medium transition-colors"
								style={{
									backgroundColor: confetti.shapes.includes(shape)
										? theme.colors.accent
										: theme.colors.bgMain,
									color: confetti.shapes.includes(shape)
										? theme.colors.accentForeground
										: theme.colors.textMain,
								}}
							>
								{shapeLabel(shape)}
							</button>
						))}
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
					<h3 className="text-sm font-bold mb-3" style={{ color: theme.colors.textMain }}>
						Physics
					</h3>
					<div className="space-y-3">
						<div>
							<label
								className="text-xs flex justify-between"
								style={{ color: theme.colors.textDim }}
							>
								<span>Gravity</span>
								<span>{confetti.gravity.toFixed(2)}</span>
							</label>
							<input
								type="range"
								min={0}
								max={3}
								step={0.1}
								value={confetti.gravity}
								onChange={(e) => confetti.setGravity(Number(e.target.value))}
								className="w-full"
							/>
						</div>
						<div>
							<label
								className="text-xs flex justify-between"
								style={{ color: theme.colors.textDim }}
							>
								<span>Decay</span>
								<span>{confetti.decay.toFixed(2)}</span>
							</label>
							<input
								type="range"
								min={0.1}
								max={1}
								step={0.01}
								value={confetti.decay}
								onChange={(e) => confetti.setDecay(Number(e.target.value))}
								className="w-full"
							/>
						</div>
						<div>
							<label
								className="text-xs flex justify-between"
								style={{ color: theme.colors.textDim }}
							>
								<span>Drift</span>
								<span>{confetti.drift.toFixed(1)}</span>
							</label>
							<input
								type="range"
								min={-3}
								max={3}
								step={0.1}
								value={confetti.drift}
								onChange={(e) => confetti.setDrift(Number(e.target.value))}
								className="w-full"
							/>
						</div>
						<div>
							<label
								className="text-xs flex justify-between"
								style={{ color: theme.colors.textDim }}
							>
								<span>Scalar (size)</span>
								<span>{confetti.scalar.toFixed(1)}</span>
							</label>
							<input
								type="range"
								min={0.1}
								max={3}
								step={0.1}
								value={confetti.scalar}
								onChange={(e) => confetti.setScalar(Number(e.target.value))}
								className="w-full"
							/>
						</div>
						<div>
							<label
								className="text-xs flex justify-between"
								style={{ color: theme.colors.textDim }}
							>
								<span>Ticks (duration)</span>
								<span>{confetti.ticks}</span>
							</label>
							<input
								type="range"
								min={50}
								max={500}
								value={confetti.ticks}
								onChange={(e) => confetti.setTicks(Number(e.target.value))}
								className="w-full"
							/>
						</div>
						<div className="flex items-center gap-2 pt-1">
							<input
								type="checkbox"
								id="confettiFlat"
								checked={confetti.flat}
								onChange={(e) => confetti.setFlat(e.target.checked)}
							/>
							<label
								htmlFor="confettiFlat"
								className="text-xs"
								style={{ color: theme.colors.textDim }}
							>
								Flat (disable 3D wobble)
							</label>
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
						Colors
					</h3>
					<div className="flex flex-wrap gap-2">
						{confetti.colors.map((color, idx) => (
							<div key={idx} className="relative group">
								<input
									type="color"
									value={color}
									onChange={(e) => confetti.setColorAt(idx, e.target.value)}
									className="w-8 h-8 rounded cursor-pointer border-2"
									style={{ borderColor: theme.colors.border }}
								/>
								{confetti.colors.length > 1 && (
									<button
										onClick={() => confetti.removeColor(idx)}
										className="absolute -top-1 -right-1 w-4 h-4 rounded-full text-xs opacity-0 group-hover:opacity-100 transition-opacity"
										style={{
											backgroundColor: theme.colors.error,
											color: theme.colors.accentForeground,
										}}
										aria-label={`Remove color ${idx + 1}`}
									>
										×
									</button>
								)}
							</div>
						))}
						{confetti.colors.length < 12 && (
							<button
								onClick={confetti.addColor}
								className="w-8 h-8 rounded border-2 border-dashed flex items-center justify-center text-lg"
								style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
							>
								+
							</button>
						)}
					</div>
				</div>

				<button
					onClick={confetti.firePlaygroundConfetti}
					disabled={confetti.selectedOrigins.size === 0}
					className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg font-bold text-lg transition-all hover:scale-[1.02] disabled:opacity-50 disabled:cursor-not-allowed"
					style={{
						backgroundColor: theme.colors.accent,
						color: theme.colors.accentForeground,
					}}
				>
					<Sparkles className="w-5 h-5" />
					Fire Confetti!
				</button>

				<button
					onClick={confetti.copyConfettiSettings}
					className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded font-medium transition-colors"
					style={{
						backgroundColor: confetti.copySuccess ? theme.colors.success : theme.colors.bgMain,
						color: confetti.copySuccess ? theme.colors.accentForeground : theme.colors.textMain,
						border: `1px solid ${confetti.copySuccess ? theme.colors.success : theme.colors.border}`,
					}}
				>
					{confetti.copySuccess ? (
						<>
							<Check className="w-4 h-4" />
							Copied!
						</>
					) : (
						<>
							<Copy className="w-4 h-4" />
							Copy Settings
						</>
					)}
				</button>

				<button
					onClick={confetti.resetConfettiSettings}
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
	);
}
