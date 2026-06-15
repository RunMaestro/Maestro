import type { KeyboardEvent, RefObject } from 'react';
import type { Theme, AgentConfig } from '../../../../types';
import type { AgentSshRemoteConfig, SshRemoteConfig } from '../../../../../shared/types';

export interface AgentSelectionScreenProps {
	theme: Theme;
}

export interface AgentTile {
	id: string;
	name: string;
	supported: boolean;
	description: string;
	brandColor?: string;
}

export type AgentSelectionViewMode = 'grid' | 'config';

export interface AgentSelectionRefs {
	containerRef: RefObject<HTMLDivElement>;
	nameInputRef: RefObject<HTMLInputElement>;
	tileRefs: RefObject<(HTMLButtonElement | null)[]>;
}

export interface AgentLocationSelectProps {
	theme: Theme;
	sshRemotes: SshRemoteConfig[];
	sshRemoteConfig: AgentSshRemoteConfig | undefined;
	onSshRemoteChange: (remoteId: string) => void;
	compact?: boolean;
}

export interface AgentSelectionKeyboardArgs {
	isNameFieldFocused: boolean;
	focusedTileIndex: number;
	detectedAgents: AgentConfig[];
	nameInputRef: RefObject<HTMLInputElement>;
	tileRefs: RefObject<(HTMLButtonElement | null)[]>;
	setIsNameFieldFocused: (focused: boolean) => void;
	setFocusedTileIndex: (index: number) => void;
	setSelectedAgent: (agentId: string) => void;
	canProceedToNext: () => boolean;
	nextStep: () => void;
}

export type AgentSelectionKeyDown = (event: KeyboardEvent<HTMLDivElement>) => void;
