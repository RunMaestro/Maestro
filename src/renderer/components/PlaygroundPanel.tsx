import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
	X,
	Trophy,
	FlaskConical,
	Play,
	RotateCcw,
	Sparkles,
	Copy,
	Check,
	Music,
} from 'lucide-react';
import confetti from 'canvas-confetti';
import type { Theme, AutoRunStats, ThemeMode } from '../types';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { AchievementCard } from './AchievementCard';
import { StandingOvationOverlay } from './StandingOvationOverlay';
import { KeyboardMasteryCelebration } from './KeyboardMasteryCelebration';
import { CONDUCTOR_BADGES, getBadgeForTime } from '../constants/conductorBadges';
import { KEYBOARD_MASTERY_LEVELS } from '../constants/keyboardMastery';

interface PlaygroundPanelProps {
	theme: Theme;
	themeMode: ThemeMode;
	onClose: () => void;
}

type TabId = 'achievements' | 'confetti';

interface Tab {
	id: TabId;
	label: string;
	icon: React.ReactNode;
}

const TABS: Tab[] = [
	{ id: 'achievements', label: 'Achievements', icon: <Trophy className="w-4 h-4" /> },
	{ id: 'confetti', label: 'Confetti', icon: <Sparkles className="w-4 h-4" /> },
];

// Available confetti shapes
type ConfettiShape = 'square' | 'circle' | 'star';
const CONFETTI_SHAPES: ConfettiShape[] = ['square', 'circle', 'star'];

// Grid position labels
const GRID_LABELS = [
	['Top Left', 'Top Center', 'Top Right'],
	['Middle Left', 'Center', 'Middle Right'],
	['Bottom Left', 'Bottom Center', 'Bottom Right'],
];

// Grid position coordinates (x, y)
const GRID_POSITIONS: [number, number][][] = [
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

// Default confetti colors
const DEFAULT_CONFETTI_COLORS = [
	'#FFD700', // Gold
	'#FF6B6B', // Red
	'#4ECDC4', // Teal
	'#45B7D1', // Blue
	'#FFA726', // Orange
	'#BA68C8', // Purple
	'#F48FB1', // Pink
	'#FFEAA7', // Yellow
];

export function PlaygroundPanel({ theme, themeMode, onClose }: PlaygroundPanelProps) {
	const { registerLayer, unregisterLayer, updateLayerHandler } = useLayerStack();
	const layerIdRef = useRef<string>();
	const containerRef = useRef<HTMLDivElement>(null);
	const onCloseRef = useRef(onClose);

	// Keep ref up to date
	onCloseRef.current = onClose;

	const [activeTab, setActiveTab] = useState<TabId>('achievements');

	// Achievement playground state
	const [mockCumulativeTime, setMockCumulativeTime] = useState(0);
	const [mockLongestRun, setMockLongestRun] = useState(0);
	const [mockTotalRuns, setMockTotalRuns] = useState(0);
	const [mockBadgeHistory, setMockBadgeHistory] = useState<{ level: number; unlockedAt: number }[]>(
		[]
	);
	const [showStandingOvation, setShowStandingOvation] = useState(false);
	const [ovationBadgeLevel, setOvationBadgeLevel] = useState(1);
	const [ovationIsNewRecord, setOvationIsNewRecord] = useState(false);

	// Keyboard mastery playground state
	const [showKeyboardMasteryCelebration, setShowKeyboardMasteryCelebration] = useState(false);
	const [keyboardMasteryLevel, setKeyboardMasteryLevel] = useState(1);

	// Confetti playground state
	const [confettiParticleCount, setConfettiParticleCount] = useState(100);
	const [confettiAngle, setConfettiAngle] = useState(90);
	const [confettiSpread, setConfettiSpread] = useState(45);
	const [confettiStartVelocity, setConfettiStartVelocity] = useState(45);
	const [confettiGravity, setConfettiGravity] = useState(1);
	const [confettiDecay, setConfettiDecay] = useState(0.9);
	const [confettiDrift, setConfettiDrift] = useState(0);
	const [confettiScalar, setConfettiScalar] = useState(1);
	const [confettiTicks, setConfettiTicks] = useState(200);
	const [confettiFlat, setConfettiFlat] = useState(false);
	const [confettiShapes, setConfettiShapes] = useState<ConfettiShape[]>(['square', 'circle']);
	const [confettiColors, setConfettiColors] = useState<string[]>(DEFAULT_CONFETTI_COLORS);
	const [selectedOrigins, setSelectedOrigins] = useState<Set<string>>(new Set(['2-1'])); // Default: bottom center
	const [copySuccess, setCopySuccess] = useState(false);

	// Handle keyboard shortcuts for tab switching
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			// Cmd+Shift+[ or Cmd+Shift+] to switch tabs
			if (e.metaKey && e.shiftKey) {
				if (e.key === '[' || e.key === '{') {
					e.preventDefault();
					setActiveTab((prev) => {
						const currentIdx = TABS.findIndex((t) => t.id === prev);
						const newIdx = currentIdx <= 0 ? TABS.length - 1 : currentIdx - 1;
						return TABS[newIdx].id;
					});
				} else if (e.key === ']' || e.key === '}') {
					e.preventDefault();
					setActiveTab((prev) => {
						const currentIdx = TABS.findIndex((t) => t.id === prev);
						const newIdx = currentIdx >= TABS.length - 1 ? 0 : currentIdx + 1;
						return TABS[newIdx].id;
					});
				}
			}
		};

		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, []);

	// Register layer on mount
	useEffect(() => {
		const id = registerLayer({
			type: 'modal',
			priority: MODAL_PRIORITIES.STANDING_OVATION - 1, // Just below standing ovation
			blocksLowerLayers: true,
			capturesFocus: true,
			focusTrap: 'strict',
			ariaLabel: 'Developer Playground',
			onEscape: () => onCloseRef.current(),
		});
		layerIdRef.current = id;
		containerRef.current?.focus();

		return () => {
			if (layerIdRef.current) {
				unregisterLayer(layerIdRef.current);
			}
		};
	}, [registerLayer, unregisterLayer]);

	// Update handler when dependencies change
	useEffect(() => {
		if (layerIdRef.current) {
			updateLayerHandler(layerIdRef.current, () => onCloseRef.current());
		}
	}, [updateLayerHandler]);

	// Build mock AutoRunStats
	const mockAutoRunStats: AutoRunStats = {
		cumulativeTimeMs: mockCumulativeTime,
		longestRunMs: mockLongestRun,
		longestRunTimestamp: Date.now(),
		totalRuns: mockTotalRuns,
		currentBadgeLevel: getBadgeForTime(mockCumulativeTime)?.level || 0,
		lastBadgeUnlockLevel:
			mockBadgeHistory.length > 0 ? mockBadgeHistory[mockBadgeHistory.length - 1].level : 0,
		lastAcknowledgedBadgeLevel:
			mockBadgeHistory.length > 0 ? mockBadgeHistory[mockBadgeHistory.length - 1].level : 0,
		badgeHistory: mockBadgeHistory,
	};

	// Set time to a specific badge level
	const setToBadgeLevel = (level: number) => {
		const badge = CONDUCTOR_BADGES.find((b) => b.level === level);
		if (badge) {
			setMockCumulativeTime(badge.requiredTimeMs);
			// Build history up to this level
			const history = CONDUCTOR_BADGES.filter((b) => b.level <= level).map((b) => ({
				level: b.level,
				unlockedAt: Date.now() - (level - b.level) * 86400000,
			}));
			setMockBadgeHistory(history);
		}
	};

	// Trigger standing ovation
	const triggerOvation = () => {
		const badge = CONDUCTOR_BADGES.find((b) => b.level === ovationBadgeLevel);
		if (badge) {
			setShowStandingOvation(true);
		}
	};

	// Reset all mock data
	const resetMockData = () => {
		setMockCumulativeTime(0);
		setMockLongestRun(0);
		setMockTotalRuns(0);
		setMockBadgeHistory([]);
	};

	// Format time for display
	const formatMs = (ms: number): string => {
		const seconds = Math.floor(ms / 1000);
		const minutes = Math.floor(seconds / 60);
		const hours = Math.floor(minutes / 60);
		const days = Math.floor(hours / 24);

		if (days > 0) return `${days}d ${hours % 24}h`;
		if (hours > 0) return `${hours}h ${minutes % 60}m`;
		if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
		return `${seconds}s`;
	};

	// Logarithmic scale for time slider - matches badge progression
	// Maps 0-100 slider value to 0-10years using logarithmic scale
	const MIN_TIME = 1000; // 1 second minimum
	const MAX_TIME = 315360000000; // 10 years in ms
	const LOG_MIN = Math.log(MIN_TIME);
	const LOG_MAX = Math.log(MAX_TIME);

	const sliderToTime = (sliderValue: number): number => {
		if (sliderValue === 0) return 0;
		// Map 0-100 to logarithmic scale
		const logValue = LOG_MIN + (sliderValue / 100) * (LOG_MAX - LOG_MIN);
		return Math.round(Math.exp(logValue));
	};

	const timeToSlider = (timeMs: number): number => {
		if (timeMs <= 0) return 0;
		if (timeMs < MIN_TIME) return 0;
		// Map logarithmic time back to 0-100
		const logValue = Math.log(timeMs);
		return Math.round(((logValue - LOG_MIN) / (LOG_MAX - LOG_MIN)) * 100);
	};

	// Toggle origin grid selection
	const toggleOrigin = (row: number, col: number) => {
		const key = `${row}-${col}`;
		setSelectedOrigins((prev) => {
			const newSet = new Set(prev);
			if (newSet.has(key)) {
				newSet.delete(key);
			} else {
				newSet.add(key);
			}
			return newSet;
		});
	};

	// Toggle confetti shape
	const toggleShape = (shape: ConfettiShape) => {
		setConfettiShapes((prev) => {
			if (prev.includes(shape)) {
				// Don't allow removing last shape
				if (prev.length === 1) return prev;
				return prev.filter((s) => s !== shape);
			}
			return [...prev, shape];
		});
	};

	// Fire confetti with current settings
	const firePlaygroundConfetti = useCallback(() => {
		if (selectedOrigins.size === 0) return;

		const origins: { x: number; y: number }[] = [];
		selectedOrigins.forEach((key) => {
			const [row, col] = key.split('-').map(Number);
			const [x, y] = GRID_POSITIONS[row][col];
			origins.push({ x, y });
		});

		origins.forEach((origin) => {
			confetti({
				particleCount: Math.round(confettiParticleCount / origins.length),
				angle: confettiAngle,
				spread: confettiSpread,
				startVelocity: confettiStartVelocity,
				gravity: confettiGravity,
				decay: confettiDecay,
				drift: confettiDrift,
				scalar: confettiScalar,
				ticks: confettiTicks,
				flat: confettiFlat,
				shapes: confettiShapes,
				colors: confettiColors,
				origin,
				zIndex: 99999,
				disableForReducedMotion: false,
			});
		});
	}, [
		selectedOrigins,
		confettiParticleCount,
		confettiAngle,
		confettiSpread,
		confettiStartVelocity,
		confettiGravity,
		confettiDecay,
		confettiDrift,
		confettiScalar,
		confettiTicks,
		confettiFlat,
		confettiShapes,
		confettiColors,
	]);

	// Reset confetti settings to defaults
	const resetConfettiSettings = () => {
		setConfettiParticleCount(100);
		setConfettiAngle(90);
		setConfettiSpread(45);
		setConfettiStartVelocity(45);
		setConfettiGravity(1);
		setConfettiDecay(0.9);
		setConfettiDrift(0);
		setConfettiScalar(1);
		setConfettiTicks(200);
		setConfettiFlat(false);
		setConfettiShapes(['square', 'circle']);
		setConfettiColors(DEFAULT_CONFETTI_COLORS);
		setSelectedOrigins(new Set(['2-1']));
	};

	// Copy confetti settings to clipboard
	const copyConfettiSettings = useCallback(async () => {
		// Build origins array from selected grid positions
		const origins: { x: number; y: number }[] = [];
		selectedOrigins.forEach((key) => {
			const [row, col] = key.split('-').map(Number);
			const [x, y] = GRID_POSITIONS[row][col];
			origins.push({ x, y });
		});

		const settings = {
			particleCount: confettiParticleCount,
			angle: confettiAngle,
			spread: confettiSpread,
			startVelocity: confettiStartVelocity,
			gravity: confettiGravity,
			decay: confettiDecay,
			drift: confettiDrift,
			scalar: confettiScalar,
			ticks: confettiTicks,
			flat: confettiFlat,
			shapes: confettiShapes,
			colors: confettiColors,
			origins,
		};

		// Format as readable code snippet
		const codeSnippet = `// Confetti Settings
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
		settings.origins.length === 1
			? `{ x: ${settings.origins[0].x}, y: ${settings.origins[0].y} }`
			: `// Multiple origins:\n  // ${settings.origins.map((o) => `{ x: ${o.x}, y: ${o.y} }`).join('\n  // ')}`
	},
});`;

		try {
			await navigator.clipboard.writeText(codeSnippet);
			setCopySuccess(true);
			setTimeout(() => setCopySuccess(false), 2000);
		} catch (err) {
			console.error('Failed to copy settings:', err);
		}
	}, [
		selectedOrigins,
		confettiParticleCount,
		confettiAngle,
		confettiSpread,
		confettiStartVelocity,
		confettiGravity,
		confettiDecay,
		confettiDrift,
		confettiScalar,
		confettiTicks,
		confettiFlat,
		confettiShapes,
		confettiColors,
	]);

	return (
		<>
			<div
				ref={containerRef}
				className="fixed inset-0 modal-overlay flex items-center justify-center z-[9998] animate-in fade-in duration-200"
				role="dialog"
				aria-modal="true"
				aria-label="Developer Playground"
				tabIndex={-1}
			>
				<div
					className="w-[90vw] h-[90vh] max-w-5xl border rounded-lg shadow-2xl overflow-hidden flex flex-col"
					style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}
				>
					{/* Header */}
					<div
						className="p-4 border-b flex items-center justify-between"
						style={{ borderColor: theme.colors.border }}
					>
						<div className="flex items-center gap-2">
							<FlaskConical className="w-5 h-5" style={{ color: theme.colors.accent }} />
							<h2 className="text-lg font-bold" style={{ color: theme.colors.textMain }}>
								Developer Playground
							</h2>
						</div>
						<button
							onClick={onClose}
							className="p-1 rounded hover:bg-white/10 transition-colors"
							style={{ color: theme.colors.textDim }}
						>
							<X className="w-5 h-5" />
						</button>
					</div>

					{/* Tabs */}
					<div className="flex border-b" style={{ borderColor: theme.colors.border }}>
						{TABS.map((tab) => (
							<button
								key={tab.id}
								onClick={() => setActiveTab(tab.id)}
								className={`flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
									activeTab === tab.id ? 'border-b-2' : ''
								}`}
								style={{
									color: activeTab === tab.id ? theme.colors.accent : theme.colors.textDim,
									borderColor: activeTab === tab.id ? theme.colors.accent : 'transparent',
									backgroundColor:
										activeTab === tab.id ? `${theme.colors.accent}10` : 'transparent',
								}}
							>
								{tab.icon}
								{tab.label}
							</button>
						))}
					</div>

					{/* Content */}
					<div className="flex-1 overflow-auto p-6">
						{activeTab === 'achievements' && (
							<div className="grid grid-cols-2 gap-6">
								{/* Controls */}
								<div className="space-y-6">
									<div
										className="p-4 rounded-lg border"
										style={{
											borderColor: theme.colors.border,
											backgroundColor: theme.colors.bgActivity,
										}}
									>
										<h3 className="text-sm font-bold mb-4" style={{ color: theme.colors.textMain }}>
											Quick Set Badge Level
										</h3>
										<div className="grid grid-cols-4 gap-2">
											{[0, ...CONDUCTOR_BADGES.map((b) => b.level)].map((level) => (
												<button
													key={level}
													onClick={() => setToBadgeLevel(level)}
													className="px-3 py-2 rounded text-sm font-medium transition-colors hover:opacity-80"
													style={{
														backgroundColor:
															mockAutoRunStats.currentBadgeLevel === level
																? theme.colors.accent
																: theme.colors.bgMain,
														color:
															mockAutoRunStats.currentBadgeLevel === level
																? '#fff'
																: theme.colors.textMain,
													}}
												>
													{level === 0 ? 'None' : `Lv ${level}`}
												</button>
											))}
										</div>
									</div>

									<div
										className="p-4 rounded-lg border"
										style={{
											borderColor: theme.colors.border,
											backgroundColor: theme.colors.bgActivity,
										}}
									>
										<h3 className="text-sm font-bold mb-4" style={{ color: theme.colors.textMain }}>
											Manual Time Controls
										</h3>
										<div className="space-y-3">
											<div>
												<label className="text-xs" style={{ color: theme.colors.textDim }}>
													Cumulative Time: {formatMs(mockCumulativeTime)}
												</label>
												<input
													type="range"
													min={0}
													max={100}
													value={timeToSlider(mockCumulativeTime)}
													onChange={(e) =>
														setMockCumulativeTime(sliderToTime(Number(e.target.value)))
													}
													className="w-full"
												/>
											</div>
											<div>
												<label className="text-xs" style={{ color: theme.colors.textDim }}>
													Longest Run: {formatMs(mockLongestRun)}
												</label>
												<input
													type="range"
													min={0}
													max={100}
													value={timeToSlider(mockLongestRun)}
													onChange={(e) => setMockLongestRun(sliderToTime(Number(e.target.value)))}
													className="w-full"
												/>
											</div>
											<div>
												<label className="text-xs" style={{ color: theme.colors.textDim }}>
													Total Runs: {mockTotalRuns}
												</label>
												<input
													type="range"
													min={0}
													max={1000}
													value={mockTotalRuns}
													onChange={(e) => setMockTotalRuns(Number(e.target.value))}
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
										<h3 className="text-sm font-bold mb-4" style={{ color: theme.colors.textMain }}>
											Standing Ovation Test
										</h3>
										<div className="space-y-3">
											<div>
												<label
													className="text-xs block mb-2"
													style={{ color: theme.colors.textDim }}
												>
													Badge Level to Show
												</label>
												<select
													value={ovationBadgeLevel}
													onChange={(e) => setOvationBadgeLevel(Number(e.target.value))}
													className="w-full px-3 py-2 rounded text-sm"
													style={{
														backgroundColor: theme.colors.bgMain,
														color: theme.colors.textMain,
														border: `1px solid ${theme.colors.border}`,
													}}
												>
													{CONDUCTOR_BADGES.map((badge) => (
														<option key={badge.level} value={badge.level}>
															Level {badge.level}: {badge.name}
														</option>
													))}
												</select>
											</div>
											<div className="flex items-center gap-2">
												<input
													type="checkbox"
													id="isNewRecord"
													checked={ovationIsNewRecord}
													onChange={(e) => setOvationIsNewRecord(e.target.checked)}
												/>
												<label
													htmlFor="isNewRecord"
													className="text-xs"
													style={{ color: theme.colors.textDim }}
												>
													Show as New Record
												</label>
											</div>
											<button
												onClick={triggerOvation}
												className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded font-medium transition-colors"
												style={{
													backgroundColor: theme.colors.accent,
													color: '#fff',
												}}
											>
												<Play className="w-4 h-4" />
												Trigger Standing Ovation
											</button>
										</div>
									</div>

									<button
										onClick={resetMockData}
										className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded font-medium transition-colors border"
										style={{
											borderColor: theme.colors.border,
											color: theme.colors.textDim,
										}}
									>
										<RotateCcw className="w-4 h-4" />
										Reset All Mock Data
									</button>
								</div>

								{/* Preview */}
								<div className="space-y-6">
									<div>
										<h3 className="text-sm font-bold mb-4" style={{ color: theme.colors.textMain }}>
											Achievement Card Preview
										</h3>
										<AchievementCard theme={theme} autoRunStats={mockAutoRunStats} />
									</div>

									<div
										className="p-4 rounded-lg border"
										style={{
											borderColor: theme.colors.border,
											backgroundColor: theme.colors.bgActivity,
										}}
									>
										<h3 className="text-sm font-bold mb-4" style={{ color: theme.colors.textMain }}>
											Keyboard Mastery Test
										</h3>
										<div className="space-y-3">
											<div>
												<label
													className="text-xs block mb-2"
													style={{ color: theme.colors.textDim }}
												>
													Mastery Level to Show
												</label>
												<select
													value={keyboardMasteryLevel}
													onChange={(e) => setKeyboardMasteryLevel(Number(e.target.value))}
													className="w-full px-3 py-2 rounded text-sm"
													style={{
														backgroundColor: theme.colors.bgMain,
														color: theme.colors.textMain,
														border: `1px solid ${theme.colors.border}`,
													}}
												>
													{KEYBOARD_MASTERY_LEVELS.map((level, idx) => (
														<option key={level.id} value={idx}>
															Level {idx}: {level.name} ({level.threshold}%)
														</option>
													))}
												</select>
											</div>
											<button
												onClick={() => setShowKeyboardMasteryCelebration(true)}
												className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded font-medium transition-colors"
												style={{
													backgroundColor: '#9B59B6',
													color: '#fff',
												}}
											>
												<Music className="w-4 h-4" />
												Trigger Keyboard Mastery Celebration
											</button>
										</div>
									</div>
								</div>
							</div>
						)}

						{activeTab === 'confetti' && (
							<div className="grid grid-cols-2 gap-6">
								{/* Left column - Controls */}
								<div className="space-y-4">
									{/* Origin Grid */}
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
													const isSelected = selectedOrigins.has(key);
													return (
														<button
															key={key}
															onClick={() => toggleOrigin(rowIdx, colIdx)}
															className="w-16 h-16 rounded-lg text-xs font-medium transition-all hover:scale-105"
															style={{
																backgroundColor: isSelected
																	? theme.colors.accent
																	: theme.colors.bgMain,
																color: isSelected ? '#fff' : theme.colors.textDim,
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
											{selectedOrigins.size === 0
												? 'Select at least one origin'
												: `${selectedOrigins.size} origin${selectedOrigins.size > 1 ? 's' : ''} selected`}
										</p>
									</div>

									{/* Basic Parameters */}
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
													<span>{confettiParticleCount}</span>
												</label>
												<input
													type="range"
													min={10}
													max={500}
													value={confettiParticleCount}
													onChange={(e) => setConfettiParticleCount(Number(e.target.value))}
													className="w-full"
												/>
											</div>
											<div>
												<label
													className="text-xs flex justify-between"
													style={{ color: theme.colors.textDim }}
												>
													<span>Angle (degrees)</span>
													<span>{confettiAngle}°</span>
												</label>
												<input
													type="range"
													min={0}
													max={360}
													value={confettiAngle}
													onChange={(e) => setConfettiAngle(Number(e.target.value))}
													className="w-full"
												/>
											</div>
											<div>
												<label
													className="text-xs flex justify-between"
													style={{ color: theme.colors.textDim }}
												>
													<span>Spread (degrees)</span>
													<span>{confettiSpread}°</span>
												</label>
												<input
													type="range"
													min={0}
													max={360}
													value={confettiSpread}
													onChange={(e) => setConfettiSpread(Number(e.target.value))}
													className="w-full"
												/>
											</div>
											<div>
												<label
													className="text-xs flex justify-between"
													style={{ color: theme.colors.textDim }}
												>
													<span>Start Velocity</span>
													<span>{confettiStartVelocity}</span>
												</label>
												<input
													type="range"
													min={1}
													max={100}
													value={confettiStartVelocity}
													onChange={(e) => setConfettiStartVelocity(Number(e.target.value))}
													className="w-full"
												/>
											</div>
										</div>
									</div>

									{/* Shapes */}
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
													onClick={() => toggleShape(shape)}
													className="flex-1 px-3 py-2 rounded text-sm font-medium transition-colors"
													style={{
														backgroundColor: confettiShapes.includes(shape)
															? theme.colors.accent
															: theme.colors.bgMain,
														color: confettiShapes.includes(shape) ? '#fff' : theme.colors.textMain,
													}}
												>
													{shape === 'square' ? '■' : shape === 'circle' ? '●' : '★'} {shape}
												</button>
											))}
										</div>
									</div>
								</div>

								{/* Right column - More Controls */}
								<div className="space-y-4">
									{/* Physics Parameters */}
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
													<span>{confettiGravity.toFixed(2)}</span>
												</label>
												<input
													type="range"
													min={0}
													max={3}
													step={0.1}
													value={confettiGravity}
													onChange={(e) => setConfettiGravity(Number(e.target.value))}
													className="w-full"
												/>
											</div>
											<div>
												<label
													className="text-xs flex justify-between"
													style={{ color: theme.colors.textDim }}
												>
													<span>Decay</span>
													<span>{confettiDecay.toFixed(2)}</span>
												</label>
												<input
													type="range"
													min={0.1}
													max={1}
													step={0.01}
													value={confettiDecay}
													onChange={(e) => setConfettiDecay(Number(e.target.value))}
													className="w-full"
												/>
											</div>
											<div>
												<label
													className="text-xs flex justify-between"
													style={{ color: theme.colors.textDim }}
												>
													<span>Drift</span>
													<span>{confettiDrift.toFixed(1)}</span>
												</label>
												<input
													type="range"
													min={-3}
													max={3}
													step={0.1}
													value={confettiDrift}
													onChange={(e) => setConfettiDrift(Number(e.target.value))}
													className="w-full"
												/>
											</div>
											<div>
												<label
													className="text-xs flex justify-between"
													style={{ color: theme.colors.textDim }}
												>
													<span>Scalar (size)</span>
													<span>{confettiScalar.toFixed(1)}</span>
												</label>
												<input
													type="range"
													min={0.1}
													max={3}
													step={0.1}
													value={confettiScalar}
													onChange={(e) => setConfettiScalar(Number(e.target.value))}
													className="w-full"
												/>
											</div>
											<div>
												<label
													className="text-xs flex justify-between"
													style={{ color: theme.colors.textDim }}
												>
													<span>Ticks (duration)</span>
													<span>{confettiTicks}</span>
												</label>
												<input
													type="range"
													min={50}
													max={500}
													value={confettiTicks}
													onChange={(e) => setConfettiTicks(Number(e.target.value))}
													className="w-full"
												/>
											</div>
											<div className="flex items-center gap-2 pt-1">
												<input
													type="checkbox"
													id="confettiFlat"
													checked={confettiFlat}
													onChange={(e) => setConfettiFlat(e.target.checked)}
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

									{/* Colors */}
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
											{confettiColors.map((color, idx) => (
												<div key={idx} className="relative group">
													<input
														type="color"
														value={color}
														onChange={(e) => {
															const newColors = [...confettiColors];
															newColors[idx] = e.target.value;
															setConfettiColors(newColors);
														}}
														className="w-8 h-8 rounded cursor-pointer border-2"
														style={{ borderColor: theme.colors.border }}
													/>
													{confettiColors.length > 1 && (
														<button
															onClick={() =>
																setConfettiColors(confettiColors.filter((_, i) => i !== idx))
															}
															className="absolute -top-1 -right-1 w-4 h-4 rounded-full text-xs bg-red-500 text-white opacity-0 group-hover:opacity-100 transition-opacity"
														>
															×
														</button>
													)}
												</div>
											))}
											{confettiColors.length < 12 && (
												<button
													onClick={() => setConfettiColors([...confettiColors, '#FFFFFF'])}
													className="w-8 h-8 rounded border-2 border-dashed flex items-center justify-center text-lg"
													style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
												>
													+
												</button>
											)}
										</div>
									</div>

									{/* Action Buttons */}
									<button
										onClick={firePlaygroundConfetti}
										disabled={selectedOrigins.size === 0}
										className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg font-bold text-lg transition-all hover:scale-[1.02] disabled:opacity-50 disabled:cursor-not-allowed"
										style={{
											backgroundColor: theme.colors.accent,
											color: '#fff',
										}}
									>
										<Sparkles className="w-5 h-5" />
										Fire Confetti!
									</button>

									<button
										onClick={copyConfettiSettings}
										className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded font-medium transition-colors"
										style={{
											backgroundColor: copySuccess ? theme.colors.success : theme.colors.bgMain,
											color: copySuccess ? '#fff' : theme.colors.textMain,
											border: `1px solid ${copySuccess ? theme.colors.success : theme.colors.border}`,
										}}
									>
										{copySuccess ? (
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
										onClick={resetConfettiSettings}
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
						)}
					</div>
				</div>
			</div>

			{/* Standing Ovation Overlay */}
			{showStandingOvation && (
				<StandingOvationOverlay
					theme={theme}
					themeMode={themeMode}
					badge={CONDUCTOR_BADGES.find((b) => b.level === ovationBadgeLevel)!}
					cumulativeTimeMs={mockCumulativeTime}
					recordTimeMs={mockLongestRun}
					isNewRecord={ovationIsNewRecord}
					onClose={() => setShowStandingOvation(false)}
				/>
			)}

			{/* Keyboard Mastery Celebration */}
			{showKeyboardMasteryCelebration && (
				<KeyboardMasteryCelebration
					theme={theme}
					level={keyboardMasteryLevel}
					onClose={() => setShowKeyboardMasteryCelebration(false)}
				/>
			)}
		</>
	);
}

export default PlaygroundPanel;
