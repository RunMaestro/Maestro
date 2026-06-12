export type ConfettiShape = 'square' | 'circle' | 'star';

export interface ConfettiOrigin {
	x: number;
	y: number;
}

export interface ConfettiSettings {
	particleCount: number;
	angle: number;
	spread: number;
	startVelocity: number;
	gravity: number;
	decay: number;
	drift: number;
	scalar: number;
	ticks: number;
	flat: boolean;
	shapes: ConfettiShape[];
	colors: string[];
}

export interface ConfettiLaunchOptions extends ConfettiSettings {
	origin: ConfettiOrigin;
	zIndex: number;
	disableForReducedMotion: boolean;
}

export const CONFETTI_SHAPES: ConfettiShape[] = ['square', 'circle', 'star'];

export const GRID_LABELS = [
	['Top Left', 'Top Center', 'Top Right'],
	['Middle Left', 'Center', 'Middle Right'],
	['Bottom Left', 'Bottom Center', 'Bottom Right'],
];

export const GRID_POSITIONS: [number, number][][] = [
	[
		[0, 0],
		[0.5, 0],
		[1, 0],
	],
	[
		[0, 0.5],
		[0.5, 0.5],
		[1, 0.5],
	],
	[
		[0, 1],
		[0.5, 1],
		[1, 1],
	],
];

export const DEFAULT_CONFETTI_COLORS = [
	'#FFD700',
	'#FF6B6B',
	'#4ECDC4',
	'#45B7D1',
	'#FFA726',
	'#BA68C8',
	'#F48FB1',
	'#FFEAA7',
];

export const DEFAULT_CONFETTI_SETTINGS: ConfettiSettings = {
	particleCount: 100,
	angle: 90,
	spread: 45,
	startVelocity: 45,
	gravity: 1,
	decay: 0.9,
	drift: 0,
	scalar: 1,
	ticks: 200,
	flat: false,
	shapes: ['square', 'circle'],
	colors: DEFAULT_CONFETTI_COLORS,
};

export const DEFAULT_SELECTED_ORIGINS = new Set(['2-1']);

export function originKeysToOrigins(selectedOrigins: Set<string>): ConfettiOrigin[] {
	const origins: ConfettiOrigin[] = [];
	selectedOrigins.forEach((key) => {
		const keyParts = key.split('-');
		if (keyParts.length !== 2) return;

		const [row, col] = keyParts.map(Number);
		if (!Number.isFinite(row) || !Number.isFinite(col)) return;
		if (row < 0 || row >= GRID_POSITIONS.length) return;

		const rowPositions = GRID_POSITIONS[row];
		if (!rowPositions || col < 0 || col >= rowPositions.length) return;

		const position = rowPositions[col];
		if (!position) return;

		const [x, y] = position;
		origins.push({ x, y });
	});
	return origins;
}

export function toggleShapeSelection(
	currentShapes: ConfettiShape[],
	shape: ConfettiShape
): ConfettiShape[] {
	if (currentShapes.includes(shape)) {
		if (currentShapes.length === 1) return currentShapes;
		return currentShapes.filter((currentShape) => currentShape !== shape);
	}
	return [...currentShapes, shape];
}

export function buildConfettiLaunchOptions(
	settings: ConfettiSettings,
	selectedOrigins: Set<string>
): ConfettiLaunchOptions[] {
	const origins = originKeysToOrigins(selectedOrigins);
	if (origins.length === 0) return [];

	return origins.map((origin) => ({
		...settings,
		particleCount: Math.round(settings.particleCount / origins.length),
		origin,
		zIndex: 99999,
		disableForReducedMotion: false,
	}));
}

export function buildConfettiSettingsSnippet(
	settings: ConfettiSettings,
	selectedOrigins: Set<string>
): string {
	const origins = originKeysToOrigins(selectedOrigins);

	return `// Confetti Settings
confetti({
  particleCount: ${settings.particleCount},
  angle: ${settings.angle},
  spread: ${settings.spread},
  startVelocity: ${settings.startVelocity},
  gravity: ${settings.gravity},
  decay: ${settings.decay},
  drift: ${settings.drift},
  scalar: ${settings.scalar},
  ticks: ${settings.ticks},
  flat: ${settings.flat},
  shapes: ${JSON.stringify(settings.shapes)},
  colors: ${JSON.stringify(settings.colors, null, 2).replace(/\n/g, '\n  ')},
  origin: ${
		origins.length === 1
			? `{ x: ${origins[0].x}, y: ${origins[0].y} }`
			: `// Multiple origins:\n  // ${origins.map((origin) => `{ x: ${origin.x}, y: ${origin.y} }`).join('\n  // ')}`
	},
});`;
}
