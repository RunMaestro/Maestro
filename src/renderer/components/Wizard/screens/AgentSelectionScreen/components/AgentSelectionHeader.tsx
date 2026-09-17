import type { CSSProperties, RefObject } from 'react';
import { Dices } from 'lucide-react';
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
	onSuggestAgentName: () => void;
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
	onSuggestAgentName,
	onNameFocus,
	onNameBlur,
	onSshRemoteChange,
}: AgentSelectionHeaderProps): JSX.Element {
	return (
		<div className="flex flex-col items-center gap-4">
			<h3 className="text-2xl font-semibold" style={{ color: theme.colors.textMain }}>
				Create a Maestro Agent
			</h3>

			<div className="flex flex-col items-center gap-2">
				<div className="flex items-center gap-3">
					<div className="relative flex items-center">
						<input
							ref={nameInputRef}
							id="project-name"
							type="text"
							value={agentName}
							onChange={(event) => onAgentNameChange(event.target.value)}
							onFocus={onNameFocus}
							onBlur={onNameBlur}
							placeholder="Name your agent..."
							className="w-64 pl-4 pr-10 py-2 rounded-lg border outline-none transition-all"
							style={{
								backgroundColor: theme.colors.bgMain,
								borderColor: isNameFieldFocused ? theme.colors.accent : theme.colors.border,
								color: theme.colors.textMain,
								boxShadow: isNameFieldFocused ? `0 0 0 2px ${theme.colors.accent}40` : 'none',
							}}
							aria-label="Agent name"
						/>
						{/* Re-roll sits INSIDE the field rather than beside it so the row
						    keeps the two controls it had - a third sibling pushes the
						    location select past the edge on a narrow window. */}
						<button
							type="button"
							onClick={onSuggestAgentName}
							className="absolute right-2 p-1 rounded transition-opacity opacity-60 hover:opacity-100 focus:outline-none focus:ring-2"
							style={
								{
									color: theme.colors.textDim,
									'--tw-ring-color': theme.colors.accent,
								} as CSSProperties
							}
							title="Suggest another name"
							aria-label="Suggest another agent name"
						>
							<Dices className="w-4 h-4" />
						</button>
					</div>

					<AgentLocationSelect
						theme={theme}
						sshRemotes={sshRemotes}
						sshRemoteConfig={sshRemoteConfig}
						onSshRemoteChange={onSshRemoteChange}
					/>
				</div>

				{/* The field arrives pre-filled, so this line answers the question the
				    empty box used to raise: what IS this name for? Saying what it is
				    NOT is the load-bearing half - typing the project's name here is
				    what made the next screen address the user as their own project. */}
				<p className="text-xs text-center max-w-md" style={{ color: theme.colors.textDim }}>
					What Maestro calls this agent in the Left Bar and in chat, not your project's name. Keep
					it, re-roll it, or type your own - you can rename it later.
				</p>
			</div>
		</div>
	);
}
