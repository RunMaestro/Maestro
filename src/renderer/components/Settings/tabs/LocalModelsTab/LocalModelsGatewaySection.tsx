/**
 * LocalModelsGatewaySection - the Gateway section of the Models tab: a
 * table of agents, each with the gateway its provider traffic goes through.
 *
 * A gateway is an HTTP proxy (Headroom, LiteLLM, or one of your own) set as
 * the provider's base-URL variable when the agent starts. The same value is
 * editable in the agent's own settings; both write through
 * `setAgentGatewayUrl`, which validates the URL and flushes it to the main
 * process, where the desktop spawn reads it.
 *
 * Nothing here decides what a gateway does to a launch. Each row asks
 * `resolveAgentGateway` (through `<GatewayUrlField>`), the function the launch
 * plan runs, so the table cannot describe a launch that will not happen.
 *
 * A row with a gateway can also show the agent's effective environment
 * (`<EnvVarList>` over `resolveAgentEnvironment`), where the base-URL variable
 * is badged "Local Models gateway", or badged with the layer that beat it.
 *
 * The "Maestro proxy" column is the per-agent mode of Maestro's own proxy:
 * Off, Passthrough or Compress. Choosing a mode IS choosing the gateway
 * (`setAgentTokenProxyMode` points the agent at the proxy, or clears it), so
 * the URL field beside it follows. What the proxy carried and shortened is
 * drawn under the table by `<LocalModelsProxyUsage>`.
 *
 * Above the table is the proxy DEFAULT, which covers every agent that can use
 * the proxy (`chooseTokenProxyDefault`). The table lists only the overrides:
 * agents whose routing differs from the default (`followsTokenProxyDefault`).
 * Changing the default moves the agents that follow it and adds no rows, so it
 * reads the same with five agents or a thousand. A row's X puts that agent back
 * on the default (`followTokenProxyDefault`).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Power, Router, X } from 'lucide-react';

import { resolveAgentEnvironment } from '../../../../../shared/agentEnvironment';
import { getAgentDisplayName } from '../../../../../shared/agentMetadata';
import { gatewayEnvVarsFor } from '../../../../../shared/local-models/gateway';
import {
	followsTokenProxyDefault,
	resolveTokenProxyMode,
	TOKEN_PROXY_MODE_LABELS,
	TOKEN_PROXY_MODE_DESCRIPTIONS,
	TOKEN_PROXY_MODES,
	TOKEN_PROXY_NAME,
	type TokenProxyMode,
} from '../../../../../shared/local-models/token-proxy';
import { effectiveAgentCustomEnvVars } from '../../../../../shared/providerProfiles';
import { runOnGatewayEditProblem } from '../../../../../shared/local-models/run-on';
import {
	useAgentLevelEnvVars,
	useSshRemoteNames,
} from '../../../../hooks/stats/useProviderProfiles';
import { useTokenProxyModeChoice } from '../../../../hooks/localModels/useTokenProxyModeChoice';
import { useTokenProxyReport } from '../../../../hooks/localModels/useTokenProxyReport';
import {
	chooseTokenProxyDefault,
	followTokenProxyDefault,
	setAgentGatewayUrl,
	tokenProxyDefaultBlocker,
	type TokenProxyDefaultSyncResult,
} from '../../../../services/agentGateway';
import { useIsLifecycleOwner } from '../../../../contexts/WindowContext';
import { useSessionStore } from '../../../../stores/sessionStore';
import { useSettingsStore } from '../../../../stores/settingsStore';
import type { Session, Theme } from '../../../../types';
import { GatewayUrlField } from '../../../shared/GatewayUrlField';
import { ThemedSelect } from '../../../shared/ThemedSelect';
import { TokenProxyModeField, tokenProxyModeBlocker } from '../../../shared/TokenProxyModeField';
import { EnvVarList } from '../../../ui/EnvVarList';
import { GhostIconButton } from '../../../ui/GhostIconButton';
import { SectionCard } from '../DisplayTab/components/SectionCard';
import { LocalModelsProxyUsage } from './LocalModelsProxyUsage';
import { SegmentedControl } from '../../../ui/SegmentedControl';

export interface LocalModelsGatewaySectionProps {
	theme: Theme;
}

/** The SSH remote an agent runs on, or undefined for a local agent. */
function agentRemoteId(session: Session): string | undefined {
	const ssh = session.sessionSshRemoteConfig;
	return ssh?.enabled && ssh.remoteId ? ssh.remoteId : undefined;
}

export function LocalModelsGatewaySection({ theme }: LocalModelsGatewaySectionProps) {
	const sessions = useSessionStore((s) => s.sessions);
	const defaultMode = useSettingsStore((s) => s.defaultTokenProxyMode);
	// A terminal is a shell, not an agent: it has no provider traffic to route.
	const agents = useMemo(
		() =>
			sessions
				.filter((s) => s.toolType !== 'terminal')
				.sort((a, b) => a.name.localeCompare(b.name)),
		[sessions]
	);
	const toolTypes = useMemo(() => [...new Set(agents.map((s) => s.toolType))].sort(), [agents]);
	const { envByToolType } = useAgentLevelEnvVars(toolTypes);
	const remoteNames = useSshRemoteNames(agents.some((s) => agentRemoteId(s) !== undefined));
	const proxy = useTokenProxyReport();
	const proxyPort = proxy.report?.status.port ?? null;
	const agentNames = useMemo(
		() => Object.fromEntries(sessions.map((s) => [s.id, s.name])),
		[sessions]
	);
	const isLifecycleOwner = useIsLifecycleOwner();
	const [defaultBusy, setDefaultBusy] = useState(false);
	const [defaultResult, setDefaultResult] = useState<TokenProxyDefaultSyncResult | null>(null);
	const [defaultError, setDefaultError] = useState<string | null>(null);
	const [addedAgentIds, setAddedAgentIds] = useState<string[]>([]);
	// Whether an agent's routing differs from the default. Telling a proxy
	// gateway from another needs the proxy's port, so while an "on" default
	// waits for the report nothing is called an override: listing every agent
	// for a moment is the flood this table exists to avoid.
	const portKnown = defaultMode === 'off' || proxy.report !== null || proxy.error !== null;
	const isOverride = useCallback(
		(agent: Session) =>
			tokenProxyDefaultBlocker(agent)
				? Boolean(agent.gatewayUrl?.trim())
				: !followsTokenProxyDefault(agent, defaultMode, proxyPort),
		[defaultMode, proxyPort]
	);
	const listedAgents = agents.filter(
		(agent) => addedAgentIds.includes(agent.id) || (portKnown && isOverride(agent))
	);
	const availableAgents = agents.filter((agent) => !listedAgents.includes(agent));
	const directAgentCount = useMemo(
		() => agents.filter((agent) => tokenProxyDefaultBlocker(agent) !== null).length,
		[agents]
	);
	const chooseDefault = useCallback(
		async (mode: TokenProxyMode) => {
			setDefaultBusy(true);
			setDefaultResult(null);
			setDefaultError(null);
			try {
				// Only the window that owns app-wide effects moves the agents; any
				// other window's choice reaches it as a settings change.
				setDefaultResult(await chooseTokenProxyDefault(mode, { sync: isLifecycleOwner }));
			} catch (err: unknown) {
				setDefaultError(
					`Could not save proxy default: ${err instanceof Error ? err.message : String(err)}`
				);
			} finally {
				setDefaultBusy(false);
				proxy.refresh();
			}
		},
		[isLifecycleOwner, proxy.refresh]
	);
	const defaultStatus = defaultBusy
		? 'Applying the default...'
		: defaultResult
			? `Moved ${defaultResult.moved} agent${defaultResult.moved === 1 ? '' : 's'} to ${TOKEN_PROXY_MODE_LABELS[defaultResult.mode]}.${
					defaultResult.failed.length
						? ` ${defaultResult.failed.length} could not move and ${defaultResult.failed.length === 1 ? 'is' : 'are'} listed below as ${defaultResult.failed.length === 1 ? 'an override' : 'overrides'}.`
						: ''
				}`
			: '';

	return (
		<div className="space-y-3" data-testid="local-models-gateway-section">
			<SectionCard theme={theme} className="space-y-3">
				<p className="text-xs opacity-70 select-text">
					A gateway is an HTTP proxy, such as Headroom or LiteLLM, that an agent's requests go
					through on the way to its provider. Maestro sets it as the provider's base-URL variable
					when the agent starts. A variable you set in the agent's own environment wins over the
					gateway. If a gateway cannot be used, the agent does not start and says why: it is never
					sent to another endpoint.
				</p>
				<p className="text-xs opacity-70 select-text">
					An agent on a subscription login (Claude or Codex) saves quota, not dollars. Sending its
					traffic through a proxy is your choice for each agent, and you are responsible for your
					provider's terms.
				</p>
				<p className="text-xs opacity-70 select-text">
					Maestro has a proxy of its own. Passthrough forwards every request unchanged and counts
					it. Compress also shortens large tool results (file reads, command output) in the requests
					an agent sends, keeps every original on this machine, and marks each block it changed.
					Choosing either one sets the agent's gateway to the proxy; Off clears it.
				</p>
				<div>
					<div className="text-sm font-medium">Maestro proxy default</div>
					<p className="text-xs opacity-70 mt-0.5 mb-2 select-text">
						Every agent follows this default unless it is listed below as an override. Changing it
						moves every agent that follows it, and new agents start on it.
						{directAgentCount > 0 &&
							` ${directAgentCount} agent${directAgentCount === 1 ? '' : 's'} cannot use the proxy (SSH remote, model source, or a provider without gateway support) and ${directAgentCount === 1 ? 'goes' : 'go'} direct.`}
					</p>
					<fieldset disabled={defaultBusy} className="min-w-0">
						<SegmentedControl
							theme={theme}
							value={defaultMode}
							onChange={(mode) => {
								if (mode !== defaultMode) void chooseDefault(mode);
							}}
							options={TOKEN_PROXY_MODES.map((mode) => ({
								value: mode,
								label: TOKEN_PROXY_MODE_LABELS[mode],
								icon: mode === 'off' ? Power : Router,
							}))}
							ariaLabel="Maestro proxy default for all agents"
							testId="gateway-proxy-default"
						/>
					</fieldset>
					<p className="text-xs opacity-70 mt-1 select-text">
						{TOKEN_PROXY_MODE_DESCRIPTIONS[defaultMode]}
					</p>
					<p className="text-xs opacity-70 mt-1" role="status">
						{defaultStatus}
					</p>
					{defaultError && (
						<p className="text-xs select-text" style={{ color: theme.colors.error }} role="alert">
							{defaultError}
						</p>
					)}
				</div>
				{agents.length === 0 ? (
					<p className="text-xs opacity-70" data-testid="local-models-gateway-empty">
						No agents yet.
					</p>
				) : (
					<>
						<fieldset disabled={defaultBusy} className="space-y-3">
							<div>
								<div className="text-sm font-medium">Overrides</div>
								<p className="text-xs opacity-70 mt-0.5 select-text">
									{listedAgents.length === 0
										? 'No overrides. Every agent follows the default.'
										: 'Agents set differently from the default. Remove a row to put that agent back on the default.'}
								</p>
							</div>
							<ThemedSelect
								theme={theme}
								value=""
								placeholder="Add override"
								aria-label="Add agent override"
								options={availableAgents.map((agent) => ({ value: agent.id, label: agent.name }))}
								onChange={(id) => setAddedAgentIds((ids) => [...ids, id])}
								disabled={defaultBusy || availableAgents.length === 0}
								filterable
								filterPlaceholder="Filter agents..."
							/>
							{listedAgents.length > 0 && (
								<table className="w-full text-xs" data-testid="local-models-gateway-table">
									<thead>
										<tr>
											<th className="text-left font-medium opacity-70 pb-2 pr-3">Agent</th>
											<th className="text-left font-medium opacity-70 pb-2 pr-3">Provider</th>
											<th className="text-left font-medium opacity-70 pb-2 pr-3">Maestro proxy</th>
											<th className="text-left font-medium opacity-70 pb-2 w-2/5">Gateway URL</th>
											<th className="w-6">
												<span className="sr-only">Use the default</span>
											</th>
										</tr>
									</thead>
									<tbody>
										{listedAgents.map((agent) => {
											const remoteId = agentRemoteId(agent);
											return (
												<GatewayRow
													key={agent.id}
													theme={theme}
													agent={agent}
													providerEnvVars={envByToolType[agent.toolType]}
													// The id stands in until the name loads: the row must
													// know the agent is remote either way.
													sshRemoteName={remoteId ? (remoteNames[remoteId] ?? remoteId) : undefined}
													proxyPort={proxyPort}
													isOverride={isOverride(agent)}
													onProxyModeChanged={proxy.refresh}
													onEdit={() =>
														setAddedAgentIds((ids) =>
															ids.includes(agent.id) ? ids : [...ids, agent.id]
														)
													}
													onRemove={() =>
														setAddedAgentIds((ids) => ids.filter((id) => id !== agent.id))
													}
												/>
											);
										})}
									</tbody>
								</table>
							)}
						</fieldset>
					</>
				)}
			</SectionCard>
			<LocalModelsProxyUsage
				theme={theme}
				report={proxy.report}
				loading={proxy.loading}
				error={proxy.error}
				onRefresh={proxy.refresh}
				agentNames={agentNames}
			/>
		</div>
	);
}

interface GatewayRowProps {
	theme: Theme;
	agent: Session;
	/** Settings -> Agents vars for this agent's provider, once loaded. */
	providerEnvVars?: Record<string, string>;
	sshRemoteName?: string;
	/** The Maestro proxy's port, or null when none has been chosen yet. */
	proxyPort: number | null;
	/** Whether the agent's routing differs from the proxy default. */
	isOverride: boolean;
	/** The proxy's picture changed: an agent joined or left it. */
	onProxyModeChanged: () => void;
	onEdit: () => void;
	/** The row leaves the table: the agent is back on the default. */
	onRemove: () => void;
}

function GatewayRow({
	theme,
	agent,
	providerEnvVars,
	sshRemoteName,
	proxyPort,
	isOverride,
	onProxyModeChanged,
	onEdit,
	onRemove,
}: GatewayRowProps) {
	const stored = agent.gatewayUrl ?? '';
	const [draft, setDraft] = useState(stored);
	const [error, setError] = useState<string | undefined>();
	const [removing, setRemoving] = useState(false);
	const proxyMode = resolveTokenProxyMode({
		gatewayUrl: stored,
		storedMode: agent.tokenProxyMode,
		port: proxyPort,
	});
	const runOnBlocker = runOnGatewayEditProblem(agent.runOn, { tokenProxyMode: 'compress' });
	const modeBlocker =
		tokenProxyModeBlocker(agent.toolType, sshRemoteName) ?? runOnBlocker ?? undefined;
	const modeChoice = useTokenProxyModeChoice(agent.id, { onSettled: onProxyModeChanged });
	const [envOpen, setEnvOpen] = useState(false);
	const globalEnvVars = useSettingsStore((s) => s.shellEnvVars);
	// The agent's own vars replace the provider-level set; the gateway yields to
	// whichever of the two is in force.
	const userEnvVars = useMemo(
		() => effectiveAgentCustomEnvVars(agent.customEnvVars, providerEnvVars),
		[agent.customEnvVars, providerEnvVars]
	);
	// Built only while open: the merge is cheap, but most rows never show it.
	const effectiveEnv = useMemo(
		() =>
			envOpen
				? resolveAgentEnvironment({
						global: globalEnvVars,
						agent: providerEnvVars,
						session: agent.customEnvVars,
						gateway: gatewayEnvVarsFor(agent.toolType, stored),
					})
				: [],
		[envOpen, globalEnvVars, providerEnvVars, agent.customEnvVars, agent.toolType, stored]
	);

	// The stored value can change under the row (Edit Agent, the CLI, another
	// window). Follow it, which also puts the normalized URL back after a save.
	useEffect(() => {
		setDraft(stored);
		setError(undefined);
	}, [stored]);

	const commit = useCallback(() => {
		if (draft.trim() === stored) {
			setError(undefined);
			return;
		}
		void setAgentGatewayUrl(agent.id, draft).then((result) => {
			if (!result.ok) {
				setError(result.error);
				return;
			}
			setError(undefined);
			setDraft(result.gatewayUrl ?? '');
		});
	}, [agent.id, draft, stored]);

	return (
		<tr data-testid="local-models-gateway-row" data-agent-id={agent.id}>
			<td
				className="align-top py-1.5 pr-3 font-medium select-text"
				style={{ color: theme.colors.textMain }}
			>
				{agent.name}
			</td>
			<td className="align-top py-1.5 pr-3 opacity-70">
				{getAgentDisplayName(agent.toolType)}
				{sshRemoteName && <span className="block">on {sshRemoteName}</span>}
			</td>
			<td className="align-top py-1.5 pr-3">
				<TokenProxyModeField
					theme={theme}
					value={proxyMode}
					onChange={(mode) => {
						onEdit();
						void modeChoice.choose(mode);
					}}
					disabledReason={modeBlocker}
					busy={modeChoice.busy || removing}
					error={modeChoice.error}
					ariaLabel={`${TOKEN_PROXY_NAME} mode for ${agent.name}`}
					testId={`gateway-proxy-mode-${agent.id}`}
					compact
				/>
			</td>
			<td className="align-top py-1.5">
				<GatewayUrlField
					theme={theme}
					toolType={agent.toolType}
					value={draft}
					onChange={(value) => {
						onEdit();
						setDraft(value);
						setError(undefined);
					}}
					onCommit={commit}
					disabledReason={removing ? 'Applying the default...' : (runOnBlocker ?? undefined)}
					userEnvVars={userEnvVars}
					sshRemoteName={sshRemoteName}
					error={error}
					testId={`gateway-url-${agent.id}`}
				/>
				{stored !== '' && (
					<div className="mt-1">
						<button
							type="button"
							className="text-xs underline"
							style={{ color: theme.colors.textDim }}
							onClick={() => setEnvOpen((open) => !open)}
							aria-expanded={envOpen}
							data-testid={`gateway-env-toggle-${agent.id}`}
						>
							{envOpen ? 'Hide environment' : 'Show environment'}
						</button>
						{envOpen && (
							<div className="mt-1.5">
								<EnvVarList theme={theme} vars={effectiveEnv} testId={`gateway-env-${agent.id}`} />
							</div>
						)}
					</div>
				)}
			</td>
			<td className="align-top py-1.5 pl-2">
				<GhostIconButton
					ariaLabel={`Use the default for ${agent.name}`}
					title="Use the default"
					color={theme.colors.textDim}
					disabled={removing || modeChoice.busy}
					onMouseDown={(event) => event.preventDefault()}
					onClick={() => {
						// Added to the table but never changed: it already follows.
						if (!isOverride) {
							onRemove();
							return;
						}
						setRemoving(true);
						void followTokenProxyDefault(agent.id)
							.then((result) => {
								if (!result.ok) {
									setError(result.error);
									return;
								}
								onRemove();
								onProxyModeChanged();
							})
							.catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
							.finally(() => setRemoving(false));
					}}
				>
					<X size={14} />
				</GhostIconButton>
			</td>
		</tr>
	);
}
