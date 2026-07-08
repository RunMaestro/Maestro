import { Info, Wand2 } from 'lucide-react';
import type { RefObject } from 'react';
import type { AgentSshRemoteConfig, SshRemoteConfig } from '../../../../../../shared/types';
import type { Theme } from '../../../../../types';
import { AgentLocationSelect } from './AgentLocationSelect';

interface AgentSelectionHeaderProps {
	theme: Theme;
	agentName: string;
	isNameFieldFocused: boolean;
	nameInputRef: RefObject<HTMLInputElement>;
	sshRemotes: SshRemoteConfig[];
	sshRemoteConfig: AgentSshRemoteConfig | undefined;
	onAgentNameChange: (value: string) => void;
	onNameFocus: () => void;
	onNameBlur: () => void;
	onSshRemoteChange: (remoteId: string) => void;
}

export function AgentSelectionHeader({
	theme,
	agentName,
	isNameFieldFocused,
	nameInputRef,
	sshRemotes,
	sshRemoteConfig,
	onAgentNameChange,
	onNameFocus,
	onNameBlur,
	onSshRemoteChange,
}: AgentSelectionHeaderProps): JSX.Element {
	return (
		<div className="flex flex-col items-center gap-4">
			<h3 className="text-2xl font-semibold" style={{ color: theme.colors.textMain }}>
				Create a Maestro Agent
			</h3>

			<div className="flex items-center gap-3">
				<input
					ref={nameInputRef}
					id="project-name"
					type="text"
					value={agentName}
					onChange={(event) => onAgentNameChange(event.target.value)}
					onFocus={onNameFocus}
					onBlur={onNameBlur}
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

				<AgentLocationSelect
					theme={theme}
					sshRemotes={sshRemotes}
					sshRemoteConfig={sshRemoteConfig}
					onSshRemoteChange={onSshRemoteChange}
				/>
			</div>

			<div
				className="flex items-start gap-2.5 px-4 py-3 rounded-lg max-w-lg text-xs"
				style={{
					backgroundColor: `${theme.colors.accent}15`,
					border: `1px solid ${theme.colors.accent}30`,
				}}
			>
				<Info className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: theme.colors.accent }} />
				<span style={{ color: theme.colors.textDim }}>
					This wizard captures keyboard input until complete. For a lighter touch, skip this and use{' '}
					<code
						className="px-1 py-0.5 rounded text-[11px]"
						style={{ backgroundColor: theme.colors.border }}
					>
						/wizard
					</code>{' '}
					or click the{' '}
					<Wand2
						className="inline w-3.5 h-3.5 align-text-bottom"
						style={{ color: theme.colors.accent }}
					/>{' '}
					button in the Auto Run panel after creating an agent.
				</span>
			</div>
		</div>
	);
}
