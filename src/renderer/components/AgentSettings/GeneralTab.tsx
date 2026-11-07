/**
 * GeneralTab - who the agent is and where it works: name, group (create only),
 * working directory, additional directories, and the two standing messages.
 *
 * The working directory is a slot because the two modals differ there: New
 * Agent adds the git-repo hint and the directory warning, Edit Agent adds the
 * running-agent blocker. The "Runs on" chip keeps the SSH state visible
 * without a visit to the SSH tab.
 *
 * A form with no agent to name (Group Settings) passes no name props, and the
 * name field is not drawn. `lead` is what such a form shows in its place.
 */

import type { ReactNode, Ref } from 'react';
import { FormInput } from '../ui/FormInput';
import { SshRemotePill } from '../ui/SshRemotePill';
import {
	AdditionalDirectoriesSection,
	type AdditionalDirectoriesSectionProps,
} from '../shared/AdditionalDirectoriesSection';
import { NudgeMessageField } from '../NewInstanceModal/NudgeMessageField';
import { NEW_SESSION_MESSAGE_MAX_LENGTH } from '../NewInstanceModal/types';
import { AgentSettingsPanel, type AgentSettingsPanelBaseProps } from './AgentSettingsPanel';

/** The name field of a form that names an agent. */
interface GeneralTabNameProps {
	name: string;
	onNameChange: (value: string) => void;
	nameError?: string;
	nameInputRef?: Ref<HTMLInputElement>;
	nameInputId: string;
}

/** All of the name props or none of them: half a name field is a mistake. */
type GeneralTabOptionalNameProps =
	| GeneralTabNameProps
	| { [Key in keyof GeneralTabNameProps]?: undefined };

interface GeneralTabBodyProps extends AgentSettingsPanelBaseProps {
	/** Drawn first under the "Runs on" chip, where the name field goes. */
	lead?: ReactNode;
	/** Create mode: the Agent Group `<select>`. */
	groupPicker?: ReactNode;
	/** The working directory input and whatever the modal shows with it. */
	workingDirectory: ReactNode;
	/** Remote path validation, rendered under the working directory. */
	remotePathStatus?: ReactNode;
	additionalDirectories: Omit<AdditionalDirectoriesSectionProps, 'theme'>;
	newSessionMessage: string;
	onNewSessionMessageChange: (value: string) => void;
	nudgeMessage: string;
	onNudgeMessageChange: (value: string) => void;
	/** SSH remote name when the agent runs remote; omitted means local. */
	sshRemoteHost?: string;
	/** Sections after the nudge message, such as the voice wake phrase. */
	extra?: ReactNode;
}

export type GeneralTabProps = GeneralTabBodyProps & GeneralTabOptionalNameProps;

export function GeneralTab({
	theme,
	idPrefix,
	lead,
	name,
	onNameChange,
	nameError,
	nameInputRef,
	nameInputId,
	groupPicker,
	workingDirectory,
	remotePathStatus,
	additionalDirectories,
	newSessionMessage,
	onNewSessionMessageChange,
	nudgeMessage,
	onNudgeMessageChange,
	sshRemoteHost,
	extra,
}: GeneralTabProps) {
	return (
		<AgentSettingsPanel theme={theme} idPrefix={idPrefix} tab="general">
			<div
				className="flex items-center justify-end gap-2 text-xs"
				style={{ color: theme.colors.textDim }}
				data-testid={`${idPrefix}-runs-on`}
			>
				<span>Runs on</span>
				{sshRemoteHost ? (
					<SshRemotePill remoteName={sshRemoteHost} size="sm" />
				) : (
					<span style={{ color: theme.colors.textMain }}>Local</span>
				)}
			</div>

			{lead}

			{onNameChange && (
				<FormInput
					ref={nameInputRef}
					id={nameInputId}
					theme={theme}
					label="Agent Name"
					value={name ?? ''}
					onChange={onNameChange}
					placeholder=""
					error={nameError}
					heightClass="p-2"
				/>
			)}

			{groupPicker}

			<div>
				{workingDirectory}
				{remotePathStatus}
			</div>

			<AdditionalDirectoriesSection theme={theme} {...additionalDirectories} />

			<NudgeMessageField
				theme={theme}
				value={newSessionMessage}
				onChange={onNewSessionMessageChange}
				maxLength={NEW_SESSION_MESSAGE_MAX_LENGTH}
				label="New Session Message"
				description="This text is prefixed to your first message whenever a new session is created (not visible in chat)."
				placeholder="Instructions sent with the first message of every new session..."
				sizeKey="new-session-message"
			/>

			<NudgeMessageField theme={theme} value={nudgeMessage} onChange={onNudgeMessageChange} />

			{extra}
		</AgentSettingsPanel>
	);
}
