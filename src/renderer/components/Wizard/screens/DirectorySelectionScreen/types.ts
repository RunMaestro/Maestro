import type { RefObject } from 'react';
import type { Theme } from '../../../../types';

export interface DirectorySelectionScreenProps {
	theme: Theme;
	/**
	 * Creates the agent and closes the wizard. Present so this screen can offer
	 * "skip the playbook" - the same callback the final step uses, just with no
	 * generated documents behind it.
	 */
	onLaunchSession?: (wantsTour: boolean) => Promise<void>;
}

export interface DirectorySelectionRefs {
	inputRef: RefObject<HTMLInputElement | null>;
	browseButtonRef: RefObject<HTMLButtonElement | null>;
	continueButtonRef: RefObject<HTMLButtonElement | null>;
	containerRef: RefObject<HTMLDivElement | null>;
}

export interface DirectoryValidationResult {
	exists: boolean;
	isGitRepo: boolean;
	existingDocsCount: number;
	error: string | null;
}

export interface DirectoryAnnouncementState {
	announcement: string;
	announcementKey: number;
	announce: (message: string) => void;
}
