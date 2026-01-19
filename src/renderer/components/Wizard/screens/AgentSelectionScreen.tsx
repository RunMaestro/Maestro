/**
 * AgentSelectionScreen.tsx
 *
 * First screen of the onboarding wizard - displays available AI agents
 * in a tiled grid layout with agent logos. Users can select an agent
 * and optionally provide a project name.
 *
 * Features:
 * - Tiled grid view of agent logos (Claude Code highlighted, others ghosted)
 * - Detection status indicators (checkmark for found, X for not found)
 * - Optional Name field with placeholder "My Project"
 * - Keyboard navigation (arrow keys to move between tiles, Tab to Name field, Enter to proceed)
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { Check, X, Settings, ArrowLeft, AlertTriangle } from 'lucide-react';
import type { Theme, AgentConfig } from '../../../types';
import type { SshRemoteConfig, AgentSshRemoteConfig } from '../../../../shared/types';
import { useWizard } from '../WizardContext';
import { ScreenReaderAnnouncement } from '../ScreenReaderAnnouncement';
import { AgentConfigPanel } from '../../shared/AgentConfigPanel';

interface AgentSelectionScreenProps {
	theme: Theme;
}

/**
 * Agent tile data for display
 */
export interface AgentTile {
	id: string;
	name: string;
	supported: boolean; // Whether Maestro supports this agent (only Claude for now)
	description: string;
	brandColor?: string; // Brand color for the logo
}

/**
 * Define the agents to display in the grid
 * Supported agents: Claude Code, Codex, OpenCode (shown first)
 * Unsupported agents: shown ghosted with "Coming soon" (at bottom)
 */
export const AGENT_TILES: AgentTile[] = [
	// Supported agents first
	{
		id: 'claude-code',
		name: 'Claude Code',
		supported: true,
		description: "Anthropic's AI coding assistant",
		brandColor: '#D97757', // Claude's orange/coral color
	},
	{
		id: 'codex',
		name: 'Codex',
		supported: true,
		description: "OpenAI's AI coding assistant",
		brandColor: '#10A37F', // OpenAI green
	},
	{
		id: 'opencode',
		name: 'OpenCode',
		supported: true,
		description: 'Open-source AI coding assistant',
		brandColor: '#F97316', // Orange
	},
	// Coming soon agents at the bottom
	{
		id: 'aider',
		name: 'Aider',
		supported: false,
		description: 'Coming soon',
		brandColor: '#14B8A6', // Teal
	},
	{
		id: 'gemini-cli',
		name: 'Gemini CLI',
		supported: false,
		description: 'Coming soon',
		brandColor: '#4285F4', // Google blue
	},
	{
		id: 'qwen3-coder',
		name: 'Qwen3 Coder',
		supported: false,
		description: 'Coming soon',
		brandColor: '#6366F1', // Indigo/purple
	},
];

// Grid dimensions for keyboard navigation (3 cols for 5 items)
const GRID_COLS = 3;
const GRID_ROWS = 2;

/**
 * Get SVG logo for an agent with brand colors
 */
export function AgentLogo({
	agentId,
	supported,
	detected,
	brandColor,
	theme,
}: {
	agentId: string;
	supported: boolean;
	detected: boolean;
	brandColor?: string;
	theme: Theme;
}): JSX.Element {
	// Use brand color for supported+detected, dimmed for others
	const color = supported && detected ? brandColor || theme.colors.accent : theme.colors.textDim;
	const opacity = supported ? 1 : 0.35;

	// Return appropriate icon based on agent ID
	switch (agentId) {
		case 'claude-code':
			// Claude Code - Anthropic's iconic spark/A logo
			return (
				<svg
					className="w-12 h-12"
					viewBox="0 0 48 48"
					fill="none"
					xmlns="http://www.w3.org/2000/svg"
					style={{ opacity }}
				>
					{/* Anthropic spark logo - simplified iconic version */}
					<path
						d="M28.5 8L17 40h5.5l2.3-7h10.4l2.3 7H43L31.5 8h-3zm1.5 6.5L34.2 28h-8.4l4.2-13.5z"
						fill={color}
					/>
					<path d="M5 40l8-20h5l-8 20H5z" fill={color} />
				</svg>
			);

		case 'codex':
			// Codex (OpenAI) - hexagonal/circular logo
			return (
				<svg
					className="w-12 h-12"
					viewBox="0 0 48 48"
					fill="none"
					xmlns="http://www.w3.org/2000/svg"
					style={{ opacity }}
				>
					{/* OpenAI hexagon-inspired logo */}
					<path d="M24 6L40 15v18l-16 9-16-9V15l16-9z" stroke={color} strokeWidth="2" fill="none" />
					<path d="M24 6v36M40 15L8 33M8 15l32 18" stroke={color} strokeWidth="2" />
				</svg>
			);

		case 'aider':
			// Aider - chat bubble with code brackets
			return (
				<svg
					className="w-12 h-12"
					viewBox="0 0 48 48"
					fill="none"
					xmlns="http://www.w3.org/2000/svg"
					style={{ opacity }}
				>
					{/* Chat bubble with code brackets */}
					<path
						d="M8 12C8 9.79 9.79 8 12 8H36C38.21 8 40 9.79 40 12V28C40 30.21 38.21 32 36 32H20L12 40V32H12C9.79 32 8 30.21 8 28V12Z"
						stroke={color}
						strokeWidth="2"
						fill="none"
					/>
					<path
						d="M18 16L14 20L18 24M30 16L34 20L30 24"
						stroke={color}
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			);

		case 'gemini-cli':
			// Gemini - Google's sparkle/star logo
			return (
				<svg
					className="w-12 h-12"
					viewBox="0 0 48 48"
					fill="none"
					xmlns="http://www.w3.org/2000/svg"
					style={{ opacity }}
				>
					{/* Gemini sparkle logo */}
					<path
						d="M24 4C24 4 24 20 24 24C24 28 4 24 4 24C4 24 20 24 24 24C28 24 24 44 24 44C24 44 24 28 24 24C24 20 44 24 44 24C44 24 28 24 24 24"
						fill={color}
					/>
				</svg>
			);

		case 'opencode':
			// OpenCode - terminal/code brackets
			return (
				<svg
					className="w-12 h-12"
					viewBox="0 0 48 48"
					fill="none"
					xmlns="http://www.w3.org/2000/svg"
					style={{ opacity }}
				>
					{/* OpenCode - terminal prompt style */}
					<rect
						x="4"
						y="8"
						width="40"
						height="32"
						rx="4"
						stroke={color}
						strokeWidth="2"
						fill="none"
					/>
					<path
						d="M12 20l6 4-6 4M22 28h10"
						stroke={color}
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			);

		case 'qwen3-coder':
			// Qwen - Alibaba cloud inspired
			return (
				<svg
					className="w-12 h-12"
					viewBox="0 0 48 48"
					fill="none"
					xmlns="http://www.w3.org/2000/svg"
					style={{ opacity }}
				>
					{/* Qwen - Q with code element */}
					<circle cx="24" cy="22" r="14" stroke={color} strokeWidth="2.5" fill="none" />
					<path d="M30 30l8 10" stroke={color} strokeWidth="2.5" strokeLinecap="round" />
					<path
						d="M18 22l4 4 6-8"
						stroke={color}
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			);

		default:
			return (
				<div className="w-12 h-12 rounded-full border-2" style={{ borderColor: color, opacity }} />
			);
	}
}

/**
 * AgentSelectionScreen - Agent selection with tiled grid view
 */
export function AgentSelectionScreen({ theme }: AgentSelectionScreenProps): JSX.Element {
	const {
		state,
		setSelectedAgent,
		setAvailableAgents,
		setAgentName,
		setCustomPath: setWizardCustomPath,
		setCustomArgs: setWizardCustomArgs,
		setCustomEnvVars: setWizardCustomEnvVars,
		setSessionSshRemoteConfig: setWizardSessionSshRemoteConfig,
		nextStep,
		canProceedToNext,
	} = useWizard();

	// Local state
	const [focusedTileIndex, setFocusedTileIndex] = useState<number>(0);
	const [isNameFieldFocused, setIsNameFieldFocused] = useState(false);
	const [isDetecting, setIsDetecting] = useState(true);
	const [detectedAgents, setDetectedAgents] = useState<AgentConfig[]>([]);

	// Screen reader announcement state
	const [announcement, setAnnouncement] = useState('');
	const [announcementKey, setAnnouncementKey] = useState(0);

	// Configuration panel state
	const [viewMode, setViewMode] = useState<'grid' | 'config'>('grid');
	const [configuringAgentId, setConfiguringAgentId] = useState<string | null>(null);
	const [isTransitioning, setIsTransitioning] = useState(false);

	// Configuration form state (uses wizard state for customPath/Args/EnvVars)
	const customPath = state.customPath ?? '';
	const customArgs = state.customArgs ?? '';
	const customEnvVars = state.customEnvVars ?? {};
	const setCustomPath = (val: string) => setWizardCustomPath(val || undefined);
	const setCustomArgs = (val: string) => setWizardCustomArgs(val || undefined);
	const setCustomEnvVars = (val: Record<string, string>) =>
		setWizardCustomEnvVars(Object.keys(val).length > 0 ? val : undefined);
	const [agentConfig, setAgentConfig] = useState<Record<string, any>>({});
	const [availableModels, setAvailableModels] = useState<string[]>([]);
	const [loadingModels, setLoadingModels] = useState(false);
	const [refreshingAgent, setRefreshingAgent] = useState(false);

	// SSH Remote configuration state
	// Initialize from wizard context if already set (e.g., when SSH was configured before opening wizard)
	const [sshRemotes, setSshRemotes] = useState<SshRemoteConfig[]>([]);
	const [sshRemoteConfig, setSshRemoteConfig] = useState<AgentSshRemoteConfig | undefined>(
		state.sessionSshRemoteConfig?.enabled
			? {
					enabled: true,
					remoteId: state.sessionSshRemoteConfig.remoteId ?? null,
					workingDirOverride: state.sessionSshRemoteConfig.workingDirOverride,
				}
			: undefined
	);

	// Sync local sshRemoteConfig state with wizard context when navigating back to this screen
	// This ensures the dropdown reflects the saved SSH config when returning from later steps
	useEffect(() => {
		if (state.sessionSshRemoteConfig?.enabled && state.sessionSshRemoteConfig?.remoteId) {
			setSshRemoteConfig({
				enabled: true,
				remoteId: state.sessionSshRemoteConfig.remoteId,
				workingDirOverride: state.sessionSshRemoteConfig.workingDirOverride,
			});
		} else if (state.sessionSshRemoteConfig?.enabled === false) {
			setSshRemoteConfig(undefined);
		}
	}, [
		state.sessionSshRemoteConfig?.enabled,
		state.sessionSshRemoteConfig?.remoteId,
		state.sessionSshRemoteConfig?.workingDirOverride,
	]);

	// SSH connection error state - shown when we can't connect to the selected remote
	const [sshConnectionError, setSshConnectionError] = useState<string | null>(null);

	// Refs
	const containerRef = useRef<HTMLDivElement>(null);
	const nameInputRef = useRef<HTMLInputElement>(null);
	const tileRefs = useRef<(HTMLButtonElement | null)[]>([]);

	// Detect available agents on mount and when SSH remote config changes
	// Note: We use a ref to track selectedAgent to avoid re-running detection when user clicks tiles
	const selectedAgentRef = useRef(state.selectedAgent);
	selectedAgentRef.current = state.selectedAgent;

	useEffect(() => {
		let mounted = true;

		async function detectAgents() {
			// Set detecting state when re-detecting due to SSH remote change
			setIsDetecting(true);
			// Clear any previous connection error
			setSshConnectionError(null);

			try {
				// Pass SSH remote ID if configured for remote agent detection
				const sshRemoteId = sshRemoteConfig?.enabled ? sshRemoteConfig.remoteId : undefined;
				const agents = await window.maestro.agents.detect(sshRemoteId ?? undefined);
				if (mounted) {
					// Filter out hidden agents (like terminal)
					const visibleAgents = agents.filter((a: AgentConfig) => !a.hidden);

					// Check if all agents have connection errors (indicates SSH connection failure)
					 
					const connectionErrors = visibleAgents
						.filter((a: any) => a.error)
						.map((a: any) => a.error);
					const allHaveErrors =
						sshRemoteConfig?.enabled &&
						connectionErrors.length > 0 &&
						visibleAgents.every((a: any) => a.error || !a.available);

					if (allHaveErrors && connectionErrors.length > 0) {
						// Extract the first meaningful error message
						const errorMsg = connectionErrors[0];
						setSshConnectionError(errorMsg);
						setAnnouncement(`Unable to connect to remote host: ${errorMsg}`);
						setAnnouncementKey((prev) => prev + 1);
						setIsDetecting(false);
						return;
					}

					setDetectedAgents(visibleAgents);
					setAvailableAgents(visibleAgents);

					// Count available agents for announcement
					const availableCount = visibleAgents.filter((a: AgentConfig) => a.available).length;
					const totalCount = visibleAgents.length;

					// Build announcement with SSH remote context
					const remoteContext = sshRemoteConfig?.enabled ? ' on remote host' : '';

					// Auto-select Claude Code if it's available and nothing is selected
					// Use ref to get current value without adding to dependencies
					if (!selectedAgentRef.current) {
						const claudeCode = visibleAgents.find(
							(a: AgentConfig) => a.id === 'claude-code' && a.available
						);
						if (claudeCode) {
							setSelectedAgent('claude-code');
							// Announce detection complete with auto-selection
							setAnnouncement(
								`Agent detection complete${remoteContext}. ${availableCount} of ${totalCount} agents available. Claude Code automatically selected.`
							);
						} else {
							// Announce detection complete without auto-selection
							setAnnouncement(
								`Agent detection complete${remoteContext}. ${availableCount} of ${totalCount} agents available.`
							);
						}
					} else {
						// Announce detection complete (agent already selected from restore)
						setAnnouncement(
							`Agent detection complete${remoteContext}. ${availableCount} of ${totalCount} agents available.`
						);
					}
					setAnnouncementKey((prev) => prev + 1);

					setIsDetecting(false);
				}
			} catch (error) {
				console.error('Failed to detect agents:', error);
				if (mounted) {
					if (sshRemoteConfig?.enabled) {
						setSshConnectionError(
							error instanceof Error ? error.message : 'Unknown connection error'
						);
					}
					setAnnouncement('Failed to detect available agents. Please try again.');
					setAnnouncementKey((prev) => prev + 1);
					setIsDetecting(false);
				}
			}
		}

		detectAgents();

		return () => {
			mounted = false;
		};
		// Only re-run detection when SSH remote config changes, not when selected agent changes
		// Using JSON.stringify with 'null' fallback to ensure the effect runs when switching
		// between remote and local (JSON.stringify(undefined) returns undefined, not 'null',
		// so we need the fallback to ensure React sees it as a real string change)
		 
	}, [setAvailableAgents, setSelectedAgent, JSON.stringify(sshRemoteConfig) ?? 'null']);

	// Load SSH remote configurations on mount
	useEffect(() => {
		let mounted = true;

		async function loadSshRemotes() {
			try {
				const configsResult = await window.maestro.sshRemote.getConfigs();
				if (mounted && configsResult.success && configsResult.configs) {
					setSshRemotes(configsResult.configs);
				}
			} catch (error) {
				console.error('Failed to load SSH remotes:', error);
			}
		}
		loadSshRemotes();

		return () => {
			mounted = false;
		};
	}, []);

	// Focus on mount - currently focus name field since only Claude is supported
	// TODO: When multiple agents are supported, focus the tiles instead
	useEffect(() => {
		if (!isDetecting) {
			// Count how many agents are both supported AND detected
			const supportedAndDetectedCount = AGENT_TILES.filter((tile) => {
				if (!tile.supported) return false;
				const detected = detectedAgents.find((a) => a.id === tile.id);
				return detected?.available;
			}).length;

			// If only one agent is selectable, focus the name field
			// Otherwise focus the tiles for selection
			if (supportedAndDetectedCount <= 1) {
				// Focus name field since there's only one choice
				setIsNameFieldFocused(true);
				nameInputRef.current?.focus();
			} else {
				// Multiple agents available - focus the tiles
				let focusIndex = 0;
				if (state.selectedAgent) {
					const selectedIndex = AGENT_TILES.findIndex((t) => t.id === state.selectedAgent);
					if (selectedIndex !== -1) {
						focusIndex = selectedIndex;
						setFocusedTileIndex(selectedIndex);
					}
				} else {
					// Find first supported and available agent
					const firstAvailableIndex = AGENT_TILES.findIndex((tile) => {
						if (!tile.supported) return false;
						const detected = detectedAgents.find((a) => a.id === tile.id);
						return detected?.available;
					});
					if (firstAvailableIndex !== -1) {
						focusIndex = firstAvailableIndex;
						setFocusedTileIndex(firstAvailableIndex);
					}
				}
				tileRefs.current[focusIndex]?.focus();
			}
		}
	}, [isDetecting, state.selectedAgent, detectedAgents]);

	/**
	 * Handle keyboard navigation
	 */
	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			// If name field is focused, only handle Tab and Enter
			if (isNameFieldFocused) {
				if (e.key === 'Tab' && e.shiftKey) {
					// Shift+Tab goes back to last tile
					e.preventDefault();
					setIsNameFieldFocused(false);
					const lastIndex = AGENT_TILES.length - 1;
					setFocusedTileIndex(lastIndex);
					tileRefs.current[lastIndex]?.focus();
				} else if (e.key === 'Enter' && canProceedToNext()) {
					e.preventDefault();
					nextStep();
				}
				return;
			}

			const currentIndex = focusedTileIndex;
			const currentRow = Math.floor(currentIndex / GRID_COLS);
			const currentCol = currentIndex % GRID_COLS;

			switch (e.key) {
				case 'ArrowUp':
					e.preventDefault();
					if (currentRow > 0) {
						const newIndex = (currentRow - 1) * GRID_COLS + currentCol;
						setFocusedTileIndex(newIndex);
						tileRefs.current[newIndex]?.focus();
					}
					break;

				case 'ArrowDown':
					e.preventDefault();
					if (currentRow < GRID_ROWS - 1) {
						const newIndex = (currentRow + 1) * GRID_COLS + currentCol;
						if (newIndex < AGENT_TILES.length) {
							setFocusedTileIndex(newIndex);
							tileRefs.current[newIndex]?.focus();
						}
					}
					break;

				case 'ArrowLeft':
					e.preventDefault();
					if (currentCol > 0) {
						const newIndex = currentIndex - 1;
						setFocusedTileIndex(newIndex);
						tileRefs.current[newIndex]?.focus();
					}
					break;

				case 'ArrowRight':
					e.preventDefault();
					if (currentCol < GRID_COLS - 1 && currentIndex + 1 < AGENT_TILES.length) {
						const newIndex = currentIndex + 1;
						setFocusedTileIndex(newIndex);
						tileRefs.current[newIndex]?.focus();
					}
					break;

				case 'Tab':
					if (!e.shiftKey) {
						// Tab goes to name field
						e.preventDefault();
						setIsNameFieldFocused(true);
						nameInputRef.current?.focus();
					}
					break;

				case 'Enter':
				case ' ': {
					e.preventDefault();
					// Select the focused tile if supported and detected
					const tile = AGENT_TILES[currentIndex];
					const detected = detectedAgents.find((a) => a.id === tile.id);
					if (tile.supported && detected?.available) {
						setSelectedAgent(tile.id as any);
						// If Enter, also proceed to next step if valid
						if (e.key === 'Enter' && canProceedToNext()) {
							nextStep();
						}
					}
					break;
				}
			}
		},
		[
			isNameFieldFocused,
			focusedTileIndex,
			detectedAgents,
			setSelectedAgent,
			nextStep,
			canProceedToNext,
		]
	);

	/**
	 * Handle tile click
	 */
	const handleTileClick = useCallback(
		(tile: AgentTile, index: number) => {
			const detected = detectedAgents.find((a) => a.id === tile.id);
			// Only allow selection if agent is both supported by Maestro AND detected on system
			if (tile.supported && detected?.available) {
				setSelectedAgent(tile.id as any);
				setFocusedTileIndex(index);
				// Announce agent selection
				setAnnouncement(`${tile.name} selected`);
				setAnnouncementKey((prev) => prev + 1);
			}
		},
		[detectedAgents, setSelectedAgent]
	);

	/**
	 * Handle Continue button click
	 */
	const handleContinue = useCallback(() => {
		if (canProceedToNext()) {
			nextStep();
		}
	}, [canProceedToNext, nextStep]);

	// Check if an agent is available from detection
	const isAgentAvailable = useCallback(
		(agentId: string): boolean => {
			const detected = detectedAgents.find((a) => a.id === agentId);
			return detected?.available ?? false;
		},
		[detectedAgents]
	);

	/**
	 * Open the configuration panel for an agent
	 * Uses wizard state for customPath/Args/EnvVars - no provider-level storage
	 */
	const handleOpenConfig = useCallback(
		async (agentId: string) => {
			// Load agent config (model selection only - per-agent path/args/envVars are in wizard state)
			const config = await window.maestro.agents.getConfig(agentId);
			setAgentConfig(config || {});
			setConfiguringAgentId(agentId);

			// Load models if agent supports it
			const agent = detectedAgents.find((a) => a.id === agentId);
			if (agent?.capabilities?.supportsModelSelection) {
				setLoadingModels(true);
				try {
					const models = await window.maestro.agents.getModels(agentId);
					setAvailableModels(models);
				} catch (err) {
					console.error('Failed to load models:', err);
				} finally {
					setLoadingModels(false);
				}
			}

			// Auto-select this agent when opening config
			setSelectedAgent(agentId as any);

			// Trigger transition
			setIsTransitioning(true);
			setTimeout(() => {
				setViewMode('config');
				setIsTransitioning(false);
			}, 150);

			// Announce opening config panel
			const tile = AGENT_TILES.find((t) => t.id === agentId);
			setAnnouncement(`Configuring ${tile?.name || agentId}`);
			setAnnouncementKey((prev) => prev + 1);
		},
		[detectedAgents, setSelectedAgent]
	);

	/**
	 * Close the configuration panel and return to grid
	 */
	const handleCloseConfig = useCallback(async () => {
		// Save SSH remote config to wizard state (per-session, not per-agent)
		// ALWAYS pass explicitly to override any agent-level config
		if (sshRemoteConfig?.enabled && sshRemoteConfig?.remoteId) {
			setWizardSessionSshRemoteConfig({
				enabled: true,
				remoteId: sshRemoteConfig.remoteId,
				workingDirOverride: sshRemoteConfig.workingDirOverride,
			});
		} else {
			// Explicitly disable SSH to override any agent-level config
			setWizardSessionSshRemoteConfig({ enabled: false, remoteId: null });
		}

		setIsTransitioning(true);
		setTimeout(() => {
			setViewMode('grid');
			setConfiguringAgentId(null);
			setIsTransitioning(false);
			// Focus the tile that was being configured
			const index = AGENT_TILES.findIndex((t) => t.id === configuringAgentId);
			if (index !== -1) {
				setFocusedTileIndex(index);
				tileRefs.current[index]?.focus();
			}
		}, 150);

		setAnnouncement('Returned to agent selection');
		setAnnouncementKey((prev) => prev + 1);
	}, [configuringAgentId, sshRemoteConfig, setWizardSessionSshRemoteConfig]);

	/**
	 * Refresh agent detection after config changes
	 */
	const refreshAgentDetection = useCallback(async () => {
		const agents = await window.maestro.agents.detect();
		const visibleAgents = agents.filter((a: AgentConfig) => !a.hidden);
		setDetectedAgents(visibleAgents);
		setAvailableAgents(visibleAgents);
	}, [setAvailableAgents]);

	/**
	 * Handle refresh for single agent in config panel
	 */
	const handleRefreshAgent = useCallback(async () => {
		if (!configuringAgentId) return;
		setRefreshingAgent(true);
		try {
			await refreshAgentDetection();
		} finally {
			setRefreshingAgent(false);
		}
	}, [configuringAgentId, refreshAgentDetection]);

	/**
	 * Handle model refresh in config panel
	 */
	const handleRefreshModels = useCallback(async () => {
		if (!configuringAgentId) return;
		setLoadingModels(true);
		try {
			const models = await window.maestro.agents.getModels(configuringAgentId, true);
			setAvailableModels(models);
		} catch (err) {
			console.error('Failed to refresh models:', err);
		} finally {
			setLoadingModels(false);
		}
	}, [configuringAgentId]);

	// Get the agent being configured
	// When SSH detection is in progress, detectedAgents may be stale or empty.
	// Create a fallback agent config from AGENT_TILES to prevent undefined state.
	const configuringTile = AGENT_TILES.find((t) => t.id === configuringAgentId);
	const detectedConfigAgent = detectedAgents.find((a) => a.id === configuringAgentId);

	// If agent not in detectedAgents but we have a tile, create a placeholder
	// This handles the race condition when SSH detection is slow/pending
	const configuringAgent: AgentConfig | undefined =
		detectedConfigAgent ??
		(configuringAgentId && configuringTile
			? {
					id: configuringAgentId,
					name: configuringTile.name,
					available: false, // Will be updated when detection completes
					path: undefined,
					hidden: false,
					capabilities: undefined, // Will be populated when detection completes
				}
			: undefined);

	// Loading state
	if (isDetecting) {
		return (
			<div
				className="flex-1 flex flex-col items-center justify-center p-8"
				style={{ color: theme.colors.textMain }}
			>
				<div
					className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin mb-4"
					style={{ borderColor: theme.colors.accent, borderTopColor: 'transparent' }}
				/>
				<p className="text-sm" style={{ color: theme.colors.textDim }}>
					Detecting available agents...
				</p>
			</div>
		);
	}

	// Render configuration panel view
	if (viewMode === 'config' && configuringAgent && configuringTile) {
		return (
			<div
				ref={containerRef}
				className={`flex flex-col flex-1 min-h-0 px-8 py-6 overflow-y-auto transition-opacity duration-150 ${
					isTransitioning ? 'opacity-0' : 'opacity-100'
				}`}
				tabIndex={-1}
			>
				{/* Screen reader announcements */}
				<ScreenReaderAnnouncement
					message={announcement}
					announceKey={announcementKey}
					politeness="polite"
				/>

				{/* Header with Back button */}
				<div className="flex items-center justify-between mb-6">
					<button
						onClick={handleCloseConfig}
						className="flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-white/10 transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1"
						style={{
							color: theme.colors.textDim,
							['--tw-ring-color' as any]: theme.colors.accent,
							['--tw-ring-offset-color' as any]: theme.colors.bgMain,
						}}
					>
						<ArrowLeft className="w-4 h-4" />
						Back
					</button>
					<h3 className="text-xl font-semibold" style={{ color: theme.colors.textMain }}>
						Configure {configuringTile.name}
					</h3>
					<div className="w-20" /> {/* Spacer for centering */}
				</div>

				{/* Detection in progress banner - show when using placeholder agent during SSH detection */}
				{isDetecting && !detectedConfigAgent && (
					<div
						className="flex items-center gap-2 p-3 mb-4 rounded-lg text-sm"
						style={{ backgroundColor: theme.colors.warning + '20', color: theme.colors.warning }}
					>
						<div
							className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin"
							style={{ borderColor: theme.colors.warning, borderTopColor: 'transparent' }}
						/>
						Detecting agent on remote host...
					</div>
				)}

				{/* Configuration Panel */}
				<div className="flex-1 flex justify-center overflow-y-auto">
					<div className="w-full max-w-xl">
						<AgentConfigPanel
							theme={theme}
							agent={configuringAgent}
							customPath={customPath}
							onCustomPathChange={setCustomPath}
							onCustomPathBlur={async () => {
								// Sync custom path to agent detector before refreshing detection
								// This ensures the detector uses the custom path when checking availability
								if (configuringAgentId) {
									const pathToSet = customPath.trim() || null;
									await window.maestro.agents.setCustomPath(configuringAgentId, pathToSet);
								}
								await refreshAgentDetection();
							}}
							onCustomPathClear={async () => {
								setCustomPath('');
								// Clear custom path in agent detector before refreshing
								if (configuringAgentId) {
									await window.maestro.agents.setCustomPath(configuringAgentId, null);
								}
								await refreshAgentDetection();
							}}
							customArgs={customArgs}
							onCustomArgsChange={setCustomArgs}
							onCustomArgsBlur={() => {
								// Wizard state is already updated via setCustomArgs - no provider-level save
							}}
							onCustomArgsClear={() => {
								setCustomArgs('');
							}}
							customEnvVars={customEnvVars}
							onEnvVarKeyChange={(oldKey, newKey, value) => {
								const newVars = { ...customEnvVars };
								delete newVars[oldKey];
								newVars[newKey] = value;
								setCustomEnvVars(newVars);
							}}
							onEnvVarValueChange={(key, value) => {
								setCustomEnvVars({ ...customEnvVars, [key]: value });
							}}
							onEnvVarRemove={(key) => {
								const newVars = { ...customEnvVars };
								delete newVars[key];
								setCustomEnvVars(newVars);
							}}
							onEnvVarAdd={() => {
								let newKey = 'NEW_VAR';
								let counter = 1;
								while (customEnvVars[newKey]) {
									newKey = `NEW_VAR_${counter}`;
									counter++;
								}
								setCustomEnvVars({ ...customEnvVars, [newKey]: '' });
							}}
							onEnvVarsBlur={() => {
								// Wizard state is already updated via setCustomEnvVars - no provider-level save
							}}
							agentConfig={agentConfig}
							onConfigChange={(key, value) => {
								setAgentConfig((prev) => ({ ...prev, [key]: value }));
							}}
							onConfigBlur={async () => {
								await window.maestro.agents.setConfig(configuringAgentId!, agentConfig);
							}}
							availableModels={availableModels}
							loadingModels={loadingModels}
							onRefreshModels={handleRefreshModels}
							onRefreshAgent={handleRefreshAgent}
							refreshingAgent={refreshingAgent}
							compact
							showBuiltInEnvVars
						/>
					</div>
				</div>

				{/* Done button */}
				<div className="flex justify-center mt-6">
					<button
						onClick={handleCloseConfig}
						className="px-8 py-2.5 rounded-lg font-medium transition-all focus:outline-none focus:ring-2 focus:ring-offset-2"
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.accentForeground,
							['--tw-ring-color' as any]: theme.colors.accent,
							['--tw-ring-offset-color' as any]: theme.colors.bgMain,
						}}
					>
						Done
					</button>
				</div>
			</div>
		);
	}

	// Render grid view
	return (
		<div
			ref={containerRef}
			className={`flex flex-col flex-1 min-h-0 px-8 py-6 overflow-y-auto justify-between transition-opacity duration-150 ${
				isTransitioning ? 'opacity-0' : 'opacity-100'
			}`}
			onKeyDown={handleKeyDown}
			tabIndex={-1}
		>
			{/* Screen reader announcements */}
			<ScreenReaderAnnouncement
				message={announcement}
				announceKey={announcementKey}
				politeness="polite"
			/>

			{/* Section 1: Header + Name/Location Row */}
			<div className="flex flex-col items-center gap-4">
				<h3 className="text-2xl font-semibold" style={{ color: theme.colors.textMain }}>
					Create a Maestro Agent
				</h3>

				{/* Name + Location Row */}
				<div className="flex items-center gap-3">
					<input
						ref={nameInputRef}
						id="project-name"
						type="text"
						value={state.agentName}
						onChange={(e) => setAgentName(e.target.value)}
						onFocus={() => setIsNameFieldFocused(true)}
						onBlur={() => setIsNameFieldFocused(false)}
						placeholder="Name your agent..."
						className="w-64 px-4 py-2 rounded-lg border outline-none transition-all"
						style={{
							backgroundColor: theme.colors.bgMain,
							borderColor: isNameFieldFocused ? theme.colors.accent : theme.colors.border,
							color: theme.colors.textMain,
							boxShadow: isNameFieldFocused ? `0 0 0 2px ${theme.colors.accent}40` : 'none',
						}}
						aria-label="Agent name"
					/>

					{/* SSH Remote Location Dropdown - only shown if remotes are configured */}
					{sshRemotes.length > 0 && (
						<div className="flex items-center gap-2">
							<span className="text-sm" style={{ color: theme.colors.textDim }}>
								on
							</span>
							<select
								value={sshRemoteConfig?.enabled ? sshRemoteConfig.remoteId || '' : ''}
								onChange={(e) => {
									const remoteId = e.target.value;
									if (remoteId === '') {
										// Local machine selected
										setSshRemoteConfig(undefined);
										// Also update wizard context immediately
										setWizardSessionSshRemoteConfig({ enabled: false, remoteId: null });
									} else {
										// Remote selected
										setSshRemoteConfig({
											enabled: true,
											remoteId,
										});
										// Also update wizard context immediately
										setWizardSessionSshRemoteConfig({
											enabled: true,
											remoteId,
										});
									}
								}}
								className="px-3 py-2 rounded-lg border outline-none transition-all cursor-pointer"
								style={{
									backgroundColor: theme.colors.bgMain,
									borderColor: theme.colors.border,
									color: theme.colors.textMain,
									minWidth: '160px',
								}}
								aria-label="Agent location"
							>
								<option value="">Local Machine</option>
								{sshRemotes.map((remote) => (
									<option key={remote.id} value={remote.id}>
										{remote.name || remote.host}
									</option>
								))}
							</select>
						</div>
					)}
				</div>

				<p className="text-sm" style={{ color: theme.colors.textDim }}>
					Select the provider that will power your agent.
				</p>
			</div>

			{/* Section 2: Agent Grid or Connection Error */}
			{sshConnectionError ? (
				/* SSH Connection Error State */
				<div className="flex justify-center">
					<div
						className="flex flex-col items-center justify-center p-8 rounded-xl border-2 max-w-lg text-center"
						style={{
							backgroundColor: `${theme.colors.error}10`,
							borderColor: theme.colors.error,
						}}
					>
						<AlertTriangle className="w-12 h-12 mb-4" style={{ color: theme.colors.error }} />
						<h4 className="text-lg font-semibold mb-2" style={{ color: theme.colors.textMain }}>
							Unable to Connect
						</h4>
						<p className="text-sm mb-4" style={{ color: theme.colors.textDim }}>
							{sshConnectionError}
						</p>
						<p className="text-sm" style={{ color: theme.colors.textDim }}>
							Please select a different remote host or switch to Local Machine.
						</p>
					</div>
				</div>
			) : (
				/* Agent Grid */
				<div className="flex justify-center">
					<div className="grid grid-cols-3 gap-4 max-w-3xl">
						{AGENT_TILES.map((tile, index) => {
							const isDetected = isAgentAvailable(tile.id);
							const isSupported = tile.supported;
							const canSelect = isSupported && isDetected;
							const isSelected = state.selectedAgent === tile.id;
							const isFocused = focusedTileIndex === index && !isNameFieldFocused;

							return (
								<button
									key={tile.id}
									ref={(el) => {
										tileRefs.current[index] = el;
									}}
									onClick={() => handleTileClick(tile, index)}
									onFocus={() => {
										setFocusedTileIndex(index);
										setIsNameFieldFocused(false);
									}}
									disabled={!canSelect}
									className={`
                    relative flex flex-col items-center justify-center pt-6 px-6 pb-10 rounded-xl
                    border-2 transition-all duration-200 outline-none min-w-[160px]
                    ${canSelect ? 'cursor-pointer' : 'cursor-not-allowed'}
                  `}
									style={{
										backgroundColor: isSelected
											? `${tile.brandColor || theme.colors.accent}15`
											: theme.colors.bgSidebar,
										borderColor: isSelected
											? tile.brandColor || theme.colors.accent
											: isFocused && canSelect
												? theme.colors.accent
												: theme.colors.border,
										opacity: isSupported ? 1 : 0.5,
										boxShadow: isSelected
											? `0 0 0 3px ${tile.brandColor || theme.colors.accent}30`
											: isFocused && canSelect
												? `0 0 0 2px ${theme.colors.accent}40`
												: 'none',
									}}
									aria-label={`${tile.name}${canSelect ? '' : isSupported ? ' (not installed)' : ' (coming soon)'}`}
									aria-pressed={isSelected}
								>
									{/* Selection indicator */}
									{isSelected && (
										<div
											className="absolute top-2 right-2 w-5 h-5 rounded-full flex items-center justify-center"
											style={{ backgroundColor: tile.brandColor || theme.colors.accent }}
										>
											<Check className="w-3 h-3" style={{ color: '#fff' }} />
										</div>
									)}

									{/* Detection status indicator for supported agents */}
									{isSupported && !isSelected && (
										<div
											className="absolute top-2 right-2 w-5 h-5 rounded-full flex items-center justify-center"
											style={{
												backgroundColor: isDetected ? '#22c55e20' : '#ef444420',
											}}
											title={isDetected ? 'Installed' : 'Not found'}
										>
											{isDetected ? (
												<Check className="w-3 h-3" style={{ color: '#22c55e' }} />
											) : (
												<X className="w-3 h-3" style={{ color: '#ef4444' }} />
											)}
										</div>
									)}

									{/* Agent Logo */}
									<div className="mb-3">
										<AgentLogo
											agentId={tile.id}
											supported={isSupported}
											detected={isDetected}
											brandColor={tile.brandColor}
											theme={theme}
										/>
									</div>

									{/* Agent Name */}
									<h4
										className="text-base font-medium mb-0.5"
										style={{ color: isSupported ? theme.colors.textMain : theme.colors.textDim }}
									>
										{tile.name}
									</h4>

									{/* Description / Status */}
									<p className="text-xs text-center" style={{ color: theme.colors.textDim }}>
										{isSupported
											? isDetected
												? tile.description
												: 'Not installed'
											: 'Coming soon'}
									</p>

									{/* "Soon" badge for unsupported agents */}
									{!isSupported && (
										<span
											className="absolute top-2 left-2 px-1.5 py-0.5 text-[10px] rounded-full font-medium"
											style={{
												backgroundColor: theme.colors.border,
												color: theme.colors.textDim,
											}}
										>
											Soon
										</span>
									)}

									{/* "Beta" badge for Codex and OpenCode */}
									{isSupported && (tile.id === 'codex' || tile.id === 'opencode') && (
										<span
											className="absolute top-2 left-2 px-1.5 py-0.5 text-[9px] rounded font-bold uppercase"
											style={{
												backgroundColor: theme.colors.warning + '30',
												color: theme.colors.warning,
											}}
										>
											Beta
										</span>
									)}

									{/* Customize button for supported agents (shown even if not detected, so user can set custom path) */}
									{/* Note: Using div with role="button" to avoid nested button warning */}
									{isSupported && (
										<div
											role="button"
											onClick={(e) => {
												e.stopPropagation();
												handleOpenConfig(tile.id);
											}}
											onKeyDown={(e) => {
												if (e.key === 'Enter' || e.key === ' ') {
													e.stopPropagation();
													handleOpenConfig(tile.id);
												}
											}}
											className="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-1 px-2 py-1 mt-2 rounded text-[10px] hover:bg-white/10 transition-colors cursor-pointer"
											style={{ color: theme.colors.textDim }}
											title="Customize agent settings"
											tabIndex={-1}
										>
											<Settings className="w-3 h-3" />
											Customize
										</div>
									)}
								</button>
							);
						})}
					</div>
				</div>
			)}

			{/* Section 3: Continue Button + Keyboard hints */}
			<div className="flex flex-col items-center gap-4">
				<button
					onClick={handleContinue}
					disabled={!canProceedToNext()}
					className="px-8 py-2.5 rounded-lg font-medium transition-all focus:outline-none focus:ring-2 focus:ring-offset-2 whitespace-nowrap"
					style={{
						backgroundColor: canProceedToNext() ? theme.colors.accent : theme.colors.border,
						color: canProceedToNext() ? theme.colors.accentForeground : theme.colors.textDim,
						cursor: canProceedToNext() ? 'pointer' : 'not-allowed',
						opacity: canProceedToNext() ? 1 : 0.6,
						['--tw-ring-color' as any]: theme.colors.accent,
						['--tw-ring-offset-color' as any]: theme.colors.bgMain,
					}}
				>
					Continue
				</button>

				{/* Keyboard hints */}
				<div className="flex justify-center gap-6">
					<span className="text-xs flex items-center gap-1" style={{ color: theme.colors.textDim }}>
						<kbd
							className="px-1.5 py-0.5 rounded text-xs"
							style={{ backgroundColor: theme.colors.border }}
						>
							← → ↑ ↓
						</kbd>
						Navigate
					</span>
					<span className="text-xs flex items-center gap-1" style={{ color: theme.colors.textDim }}>
						<kbd
							className="px-1.5 py-0.5 rounded text-xs"
							style={{ backgroundColor: theme.colors.border }}
						>
							Tab
						</kbd>
						Fields
					</span>
					<span className="text-xs flex items-center gap-1" style={{ color: theme.colors.textDim }}>
						<kbd
							className="px-1.5 py-0.5 rounded text-xs"
							style={{ backgroundColor: theme.colors.border }}
						>
							Enter
						</kbd>
						Continue
					</span>
				</div>
			</div>
		</div>
	);
}
