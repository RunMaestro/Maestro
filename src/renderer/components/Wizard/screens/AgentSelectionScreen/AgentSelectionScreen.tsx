import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ToolType } from '../../../../types';
import { useWizard } from '../../WizardContext';
import { ScreenReaderAnnouncement } from '../../ScreenReaderAnnouncement';
import {
	AgentConfigurationView,
	AgentGrid,
	AgentSelectionFooter,
	AgentSelectionHeader,
	AgentSelectionLoading,
	SshConnectionErrorPanel,
} from './components';
import {
	useAgentConfigurationPanel,
	useAgentDetection,
	useAgentSelectionFocus,
	useAgentSelectionKeyboard,
	useSshRemotes,
} from './hooks';
import type {
	AgentSelectionRefs,
	AgentSelectionScreenProps,
	AgentSelectionViewMode,
	AgentTile,
} from './types';
import { providerLocationLabel } from '../../../../utils/providerAvailability';
import { AGENT_TILES } from './utils/agentTiles';
import { AGENT_GRID_FALLBACK_COLUMNS } from './utils/agentGridLayout';
import {
	buildConfiguringAgent,
	countSelectableAgentTiles,
	findDetectedAgent,
	selectVisibleAgentTiles,
} from './utils/agentAvailability';

export function AgentSelectionScreen({ theme }: AgentSelectionScreenProps): JSX.Element {
	const {
		state,
		setSelectedAgent,
		setAvailableAgents,
		setAgentName,
		setCustomPath: setWizardCustomPath,
		setCustomArgs: setWizardCustomArgs,
		setCustomEnvVars: setWizardCustomEnvVars,
		setAgentConfigValues: setWizardAgentConfigValues,
		setEnableMaestroP,
		setMaestroPMode,
		setMaestroPPath,
		setSessionSshRemoteConfig: setWizardSessionSshRemoteConfig,
		nextStep,
		canProceedToNext,
	} = useWizard();

	const [focusedTileIndex, setFocusedTileIndex] = useState(0);
	const [isNameFieldFocused, setIsNameFieldFocused] = useState(false);
	// Starts on ALL supported providers. The filtered view is the smaller, more
	// surprising list - a user whose provider is installed but undetected (a custom
	// path, a machine detection could not probe) would otherwise open the wizard,
	// not see it, and conclude Maestro does not support it.
	const [showAllProviders, setShowAllProviders] = useState(true);
	// Tiles per row as DRAWN, reported by the grid. Up/down arrow movement steps by
	// this, so an assumed value would jump the focus ring to a tile that is not
	// above or below the one the user is on.
	const [tileColumns, setTileColumns] = useState(AGENT_GRID_FALLBACK_COLUMNS);
	const [viewMode, setViewMode] = useState<AgentSelectionViewMode>('grid');
	const [configuringAgentId, setConfiguringAgentId] = useState<string | null>(null);
	const [isTransitioning, setIsTransitioning] = useState(false);

	const containerRef = useRef<HTMLDivElement>(null);
	const nameInputRef = useRef<HTMLInputElement>(null);
	const tileRefs = useRef<(HTMLButtonElement | null)[]>([]);
	const transitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// Mirrors `visibleTiles` (computed below) for the deferred callbacks that run
	// after a transition timer, by which point a captured list may be stale.
	const visibleTilesRef = useRef<AgentTile[]>(AGENT_TILES);

	const refs = useMemo<AgentSelectionRefs>(
		() => ({
			containerRef,
			nameInputRef,
			tileRefs,
		}),
		[]
	);

	const selectAgent = useCallback(
		(agentId: string) => {
			setSelectedAgent(agentId as ToolType);
		},
		[setSelectedAgent]
	);

	const clearTransitionTimer = useCallback(() => {
		if (transitionTimerRef.current) {
			clearTimeout(transitionTimerRef.current);
			transitionTimerRef.current = null;
		}
	}, []);

	useEffect(() => clearTransitionTimer, [clearTransitionTimer]);

	const { sshRemotes, sshRemoteConfig, handleSshRemoteChange } = useSshRemotes({
		sessionSshRemoteConfig: state.sessionSshRemoteConfig,
		setWizardSessionSshRemoteConfig,
	});

	const {
		isDetecting,
		detectedAgents,
		sshConnectionError,
		announcement,
		announcementKey,
		announce,
		refreshAgentDetection,
	} = useAgentDetection({
		sshRemoteConfig,
		selectedAgent: state.selectedAgent,
		setAvailableAgents,
		setSelectedAgent: selectAgent,
	});

	// What the strip renders, and therefore what every tile index in this screen
	// refers to. Indexing the full registry instead would name the wrong provider
	// the moment the unavailable ones are filtered out.
	const visibleTiles = useMemo(
		() =>
			selectVisibleAgentTiles(AGENT_TILES, detectedAgents, showAllProviders, state.selectedAgent),
		[detectedAgents, showAllProviders, state.selectedAgent]
	);
	visibleTilesRef.current = visibleTiles;

	const availableProviderCount = useMemo(
		() => countSelectableAgentTiles(AGENT_TILES, detectedAgents),
		[detectedAgents]
	);

	// The counts describe whichever machine detection probed, so name that machine.
	// Saying "locally" while the Location dropdown points at a remote is a claim
	// about the wrong host.
	const locationLabel = useMemo(() => {
		if (!sshRemoteConfig?.enabled || !sshRemoteConfig.remoteId) return providerLocationLabel();
		const remote = sshRemotes.find((entry) => entry.id === sshRemoteConfig.remoteId);
		return providerLocationLabel(remote?.name ?? remote?.host ?? 'remote');
	}, [sshRemoteConfig?.enabled, sshRemoteConfig?.remoteId, sshRemotes]);

	useAgentSelectionFocus({
		tiles: visibleTiles,
		isDetecting,
		selectedAgent: state.selectedAgent,
		detectedAgents,
		refs,
		setFocusedTileIndex,
		setIsNameFieldFocused,
	});

	const showConfigView = useCallback(() => {
		clearTransitionTimer();
		setIsTransitioning(true);
		transitionTimerRef.current = setTimeout(() => {
			setViewMode('config');
			setIsTransitioning(false);
			transitionTimerRef.current = null;
		}, 150);
	}, [clearTransitionTimer]);

	const showGridView = useCallback(
		(agentId: string | null) => {
			clearTransitionTimer();
			setIsTransitioning(true);
			transitionTimerRef.current = setTimeout(() => {
				setViewMode('grid');
				setConfiguringAgentId(null);
				setIsTransitioning(false);
				transitionTimerRef.current = null;
				const index = visibleTilesRef.current.findIndex((tile) => tile.id === agentId);
				if (index !== -1) {
					setFocusedTileIndex(index);
					tileRefs.current[index]?.focus({ preventScroll: true });
				}
			}, 150);
		},
		[clearTransitionTimer]
	);

	const customPath = state.customPath ?? '';
	const customArgs = state.customArgs ?? '';
	const customEnvVars = state.customEnvVars ?? {};

	const configPanel = useAgentConfigurationPanel({
		detectedAgents,
		sshRemoteConfig,
		configuringAgentId,
		setConfiguringAgentId,
		setSelectedAgent: selectAgent,
		setWizardCustomPath,
		setWizardCustomArgs,
		setWizardCustomEnvVars,
		setWizardAgentConfigValues,
		setWizardSessionSshRemoteConfig,
		customPath,
		customEnvVars,
		refreshAgentDetection,
		showConfigView,
		showGridView,
		announce,
	});

	const handleKeyDown = useAgentSelectionKeyboard({
		tiles: visibleTiles,
		tileColumns,
		isNameFieldFocused,
		focusedTileIndex,
		detectedAgents,
		nameInputRef,
		tileRefs,
		setIsNameFieldFocused,
		setFocusedTileIndex,
		setSelectedAgent: selectAgent,
		canProceedToNext,
		nextStep,
	});

	/**
	 * Flipping the filter renumbers the strip, so carry the focus ring by PROVIDER
	 * rather than by index - keeping the raw index would slide it onto whichever
	 * unrelated provider inherited that slot.
	 */
	const handleShowAllProvidersChange = useCallback(
		(next: boolean) => {
			const focusedId = visibleTilesRef.current[focusedTileIndex]?.id;
			setShowAllProviders(next);

			const nextTiles = selectVisibleAgentTiles(
				AGENT_TILES,
				detectedAgents,
				next,
				state.selectedAgent
			);
			const nextIndex = focusedId ? nextTiles.findIndex((tile) => tile.id === focusedId) : -1;
			setFocusedTileIndex(nextIndex === -1 ? 0 : nextIndex);

			announce(
				next
					? `Showing all ${nextTiles.length} supported providers`
					: `Showing ${nextTiles.length} available providers`
			);
		},
		[announce, detectedAgents, focusedTileIndex, state.selectedAgent]
	);

	const handleTileClick = useCallback(
		(tile: (typeof AGENT_TILES)[number], index: number) => {
			const detected = findDetectedAgent(detectedAgents, tile.id);
			if (tile.supported && detected?.available) {
				selectAgent(tile.id);
				setFocusedTileIndex(index);
				announce(`${tile.name} selected`);
			}
		},
		[announce, detectedAgents, selectAgent]
	);

	const handleContinue = useCallback(() => {
		if (canProceedToNext()) {
			nextStep();
		}
	}, [canProceedToNext, nextStep]);

	if (isDetecting) {
		return <AgentSelectionLoading theme={theme} />;
	}

	const configuringAgent = buildConfiguringAgent({
		configuringAgentId,
		configuringTile: configPanel.configuringTile,
		detectedAgent: configPanel.detectedConfigAgent,
	});

	if (viewMode === 'config' && configuringAgent && configPanel.configuringTile) {
		return (
			<>
				<ScreenReaderAnnouncement
					message={announcement}
					announceKey={announcementKey}
					politeness="polite"
				/>
				<AgentConfigurationView
					theme={theme}
					containerRef={containerRef}
					isTransitioning={isTransitioning}
					isDetecting={isDetecting}
					configuringAgent={configuringAgent}
					configuringTile={configPanel.configuringTile}
					detectedConfigAgent={configPanel.detectedConfigAgent}
					sshRemotes={sshRemotes}
					sshRemoteConfig={sshRemoteConfig}
					onSshRemoteChange={handleSshRemoteChange}
					onCloseConfig={configPanel.handleCloseConfig}
					customPath={customPath}
					onCustomPathChange={configPanel.setCustomPath}
					onCustomPathBlur={configPanel.handleCustomPathBlur}
					customArgs={customArgs}
					onCustomArgsChange={configPanel.setCustomArgs}
					onCustomArgsBlur={() => {}}
					customEnvVars={customEnvVars}
					onEnvVarKeyChange={configPanel.handleEnvVarKeyChange}
					onEnvVarValueChange={configPanel.handleEnvVarValueChange}
					onEnvVarRemove={configPanel.handleEnvVarRemove}
					onEnvVarAdd={configPanel.handleEnvVarAdd}
					onEnvVarsBlur={() => {}}
					agentConfig={configPanel.agentConfig}
					onConfigChange={configPanel.handleConfigChange}
					onConfigBlur={configPanel.handleConfigBlur}
					availableModels={configPanel.availableModels}
					loadingModels={configPanel.loadingModels}
					onRefreshModels={configPanel.handleRefreshModels}
					onRefreshAgent={configPanel.handleRefreshAgent}
					refreshingAgent={configPanel.refreshingAgent}
					enableMaestroP={state.enableMaestroP}
					onEnableMaestroPChange={setEnableMaestroP}
					maestroPMode={state.maestroPMode}
					onMaestroPModeChange={setMaestroPMode}
					maestroPPath={state.maestroPPath ?? ''}
					onMaestroPPathChange={setMaestroPPath}
					detectedMaestroPPath={configPanel.detectedMaestroPPath}
				/>
			</>
		);
	}

	return (
		<div
			ref={containerRef}
			className={`flex flex-col flex-1 min-h-0 px-8 py-6 overflow-y-auto justify-between transition-opacity duration-150 ${
				isTransitioning ? 'opacity-0' : 'opacity-100'
			}`}
			onKeyDown={handleKeyDown}
			tabIndex={-1}
		>
			<ScreenReaderAnnouncement
				message={announcement}
				announceKey={announcementKey}
				politeness="polite"
			/>

			<AgentSelectionHeader
				theme={theme}
				agentName={state.agentName}
				isNameFieldFocused={isNameFieldFocused}
				nameInputRef={nameInputRef}
				sshRemotes={sshRemotes}
				sshRemoteConfig={sshRemoteConfig}
				onAgentNameChange={setAgentName}
				onNameFocus={() => setIsNameFieldFocused(true)}
				onNameBlur={() => setIsNameFieldFocused(false)}
				onSshRemoteChange={handleSshRemoteChange}
			/>

			{sshConnectionError ? (
				<SshConnectionErrorPanel theme={theme} error={sshConnectionError} />
			) : (
				<AgentGrid
					theme={theme}
					tiles={visibleTiles}
					detectedAgents={detectedAgents}
					selectedAgent={state.selectedAgent}
					focusedTileIndex={focusedTileIndex}
					isNameFieldFocused={isNameFieldFocused}
					totalProviderCount={AGENT_TILES.length}
					availableProviderCount={availableProviderCount}
					providerLocationLabel={locationLabel}
					showAllProviders={showAllProviders}
					tileRefs={tileRefs}
					onTileClick={handleTileClick}
					onOpenConfig={configPanel.handleOpenConfig}
					onShowAllProvidersChange={handleShowAllProvidersChange}
					onColumnsChange={setTileColumns}
					setFocusedTileIndex={setFocusedTileIndex}
					setIsNameFieldFocused={setIsNameFieldFocused}
				/>
			)}

			<AgentSelectionFooter
				theme={theme}
				canProceed={canProceedToNext()}
				onContinue={handleContinue}
			/>
		</div>
	);
}
