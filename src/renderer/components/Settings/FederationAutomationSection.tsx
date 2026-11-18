/**
 * FederationAutomationSection - Settings > SSH Hosts: the switch for automatic Federation, and
 * what it did, waits on, or could not do, per remote and per SSH agent, each with the one thing a
 * person has to do. "Run Now" runs a pass at once (`maestro-cli federation auto run`).
 */

import { useState } from 'react';
import { Network, Play } from 'lucide-react';
import type { Theme } from '../../types';
import type {
	AutoFederationAgentStatus,
	AutoFederationRemoteStatus,
} from '../../../shared/federationAuto';
import { useSettingsStore } from '../../stores/settingsStore';
import { useFederationAutoStore } from '../../stores/federationAutoStore';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { notifyToast } from '../../stores/notificationStore';
import { formatRelativeTime } from '../../../shared/formatters';
import { SettingsSectionHeading } from './SettingsSectionHeading';
import { SectionCard } from './tabs/DisplayTab/components/SectionCard';
import { ToggleSettingRow } from './tabs/DisplayTab/components/ToggleSettingRow';
import { Spinner } from '../ui/Spinner';

const REMOTE_STATE_LABEL: Record<AutoFederationRemoteStatus['state'], string> = {
	ready: 'Host running',
	'setting-up': 'Setting up',
	waiting: 'Waiting',
	blocked: 'Needs you',
	off: 'Off',
};

const AGENT_STATE_LABEL: Record<AutoFederationAgentStatus['state'], string> = {
	moved: 'Moved',
	pending: 'Pending',
	waiting: 'Waiting',
	blocked: 'Needs you',
	manual: 'Manual',
};

function StatusRow({
	theme,
	name,
	state,
	blocked,
	lines,
	fix,
}: {
	theme: Theme;
	name: string;
	state: string;
	blocked: boolean;
	lines: Array<string | undefined>;
	fix?: string;
}) {
	return (
		<div className="text-xs py-1.5 border-t" style={{ borderColor: theme.colors.border }}>
			<div className="flex items-center justify-between gap-2">
				<span className="font-medium truncate" style={{ color: theme.colors.textMain }}>
					{name}
				</span>
				<span
					className="shrink-0 font-semibold"
					style={{ color: blocked ? theme.colors.error : theme.colors.textMain }}
				>
					{state}
				</span>
			</div>
			{lines.filter(Boolean).map((line) => (
				<p key={line} className="opacity-70 mt-0.5 select-text">
					{line}
				</p>
			))}
			{fix && (
				<p className="mt-0.5 select-text" style={{ color: theme.colors.textMain }}>
					<span className="font-semibold">To fix: </span>
					{fix}
				</p>
			)}
		</div>
	);
}

export function FederationAutomationSection({ theme }: { theme: Theme }) {
	const autoMove = useSettingsStore((s) => s.federationAutoMove);
	const setAutoMove = useSettingsStore((s) => s.setFederationAutoMove);
	const snapshot = useFederationAutoStore((s) => s.snapshot);
	const [runningNow, setRunningNow] = useState(false);

	const runNow = async () => {
		const api = window.maestro?.federation;
		if (!api?.autoRun) return;
		setRunningNow(true);
		try {
			useFederationAutoStore.getState().applySnapshot(await api.autoRun());
		} catch (error) {
			notifyToast({
				color: 'red',
				title: 'Automatic Federation did not run',
				message: ipcErrorMessage(error),
			});
		} finally {
			setRunningNow(false);
		}
	};

	const agents = snapshot.agents.filter((agent) => agent.state !== 'manual' || !autoMove);
	const busy = runningNow || snapshot.running;
	// The browser build has no Federation API: automatic Federation runs in the desktop app.
	const available = typeof window !== 'undefined' && Boolean(window.maestro?.federation?.autoRun);

	return (
		<div>
			<SettingsSectionHeading
				icon={Network}
				description="Every SSH remote is checked for a Maestro host. Maestro keeps those hosts running across reboots, starts a stopped one, and, with the switch on, installs a host where an SSH agent needs one and moves the agent onto it once every check passes."
			>
				Federation automation
			</SettingsSectionHeading>
			<SectionCard theme={theme}>
				<ToggleSettingRow
					theme={theme}
					title="Move SSH agents to their host automatically"
					description="Off: Move to Host stays a right-click. Hosts are kept running either way."
					checked={autoMove}
					onChange={setAutoMove}
					ariaLabel="Move SSH agents to their host automatically"
				/>
				<div
					className="flex items-center justify-between gap-2 pt-3 border-t"
					style={{ borderColor: theme.colors.border }}
				>
					<span className="text-xs opacity-70">
						{!available
							? 'Runs in the desktop app'
							: snapshot.lastPassAt
								? `Last checked ${formatRelativeTime(snapshot.lastPassAt)}`
								: 'Not checked yet'}
					</span>
					<button
						type="button"
						onClick={() => void runNow()}
						disabled={busy || !available}
						title={available ? undefined : 'Automatic Federation runs in the desktop app'}
						className="flex items-center gap-1.5 px-2.5 py-1 rounded border text-xs disabled:opacity-50"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
						data-testid="federation-auto-run-now"
					>
						{busy ? <Spinner size={12} /> : <Play className="w-3 h-3" />}
						{busy ? 'Checking...' : 'Run Now'}
					</button>
				</div>
				{snapshot.remotes.map((remote) => (
					<StatusRow
						key={remote.remoteId}
						theme={theme}
						name={remote.name}
						state={
							remote.needsYou && remote.state !== 'blocked'
								? 'Running, needs you'
								: REMOTE_STATE_LABEL[remote.state]
						}
						blocked={remote.state === 'blocked' || remote.needsYou === true}
						lines={[remote.reason, remote.service]}
						fix={remote.fix}
					/>
				))}
				{agents.map((agent) => (
					<StatusRow
						key={agent.agentId}
						theme={theme}
						name={`Agent: ${agent.agentName}`}
						state={AGENT_STATE_LABEL[agent.state]}
						blocked={agent.state === 'blocked'}
						lines={[agent.reason, agent.target ? `Now ${agent.target}` : undefined]}
						fix={agent.fix}
					/>
				))}
			</SectionCard>
		</div>
	);
}
