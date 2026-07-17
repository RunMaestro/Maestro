import type React from 'react';
import type { TabCompletionFilter, TabCompletionSuggestion } from '../../hooks';
import type { MentionPickerItem, MentionCategory } from '../../hooks/input/useMentionPicker';
import type {
	BatchRunState,
	Shortcut,
	Session,
	Theme,
	ThinkingItem,
	ThinkingMode,
} from '../../types';
import type {
	GroomingProgress,
	MergeResult,
	SummarizeProgress,
	SummarizeResult,
} from '../../types/contextMerge';
import type { OmpDeliveryIntent } from '../../../shared/omp-native-session';

export interface SlashCommand {
	command: string;
	description: string;
	terminalOnly?: boolean;
	aiOnly?: boolean;
}

export interface AtMentionSuggestion {
	value: string;
	type: 'file' | 'folder';
	displayText: string;
	fullPath: string;
	source?: 'project' | 'autorun';
}

export interface InputAreaProps {
	session: Session;
	theme: Theme;
	setInputValue: (value: string) => void;
	enterToSend: boolean;
	setEnterToSend: (value: boolean) => void;
	stagedImages: string[];
	setStagedImages: React.Dispatch<React.SetStateAction<string[]>>;
	setLightboxImage: (
		image: string | null,
		contextImages?: string[],
		source?: 'staged' | 'history'
	) => void;
	commandHistoryOpen: boolean;
	setCommandHistoryOpen: (open: boolean) => void;
	commandHistoryFilter: string;
	setCommandHistoryFilter: (filter: string) => void;
	commandHistorySelectedIndex: number;
	setCommandHistorySelectedIndex: (index: number) => void;
	slashCommandOpen: boolean;
	setSlashCommandOpen: (open: boolean) => void;
	slashCommands: SlashCommand[];
	selectedSlashCommandIndex: number;
	setSelectedSlashCommandIndex: (index: number) => void;
	inputRef: React.RefObject<HTMLTextAreaElement>;
	handleInputKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
	handlePaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
	handleDrop: (e: React.DragEvent<HTMLElement>) => void;
	toggleInputMode: () => void;
	processInput: (
		text?: string,
		options?: { forceParallel?: boolean; images?: string[]; ompDeliveryIntent?: OmpDeliveryIntent }
	) => void;
	handleInterrupt: () => void;
	onInputFocus: () => void;
	onInputBlur?: () => void;
	isAutoModeActive?: boolean;
	tabCompletionOpen?: boolean;
	setTabCompletionOpen?: (open: boolean) => void;
	tabCompletionSuggestions?: TabCompletionSuggestion[];
	selectedTabCompletionIndex?: number;
	setSelectedTabCompletionIndex?: (index: number) => void;
	tabCompletionFilter?: TabCompletionFilter;
	setTabCompletionFilter?: (filter: TabCompletionFilter) => void;
	atMentionOpen?: boolean;
	setAtMentionOpen?: (open: boolean) => void;
	atMentionFilter?: string;
	setAtMentionFilter?: (filter: string) => void;
	atMentionStartIndex?: number;
	setAtMentionStartIndex?: (index: number) => void;
	// Unified `@` picker: files + directories + agents + groups in one dropdown
	atMentionItems?: MentionPickerItem[];
	atMentionCounts?: Record<MentionCategory, number>;
	atMentionCategory?: MentionCategory;
	setAtMentionCategory?: (category: MentionCategory) => void;
	selectedAtMentionIndex?: number;
	setSelectedAtMentionIndex?: (index: number) => void;
	thinkingItems?: ThinkingItem[];
	namedSessions?: Record<string, string>;
	onSessionClick?: (sessionId: string, tabId?: string) => void;
	autoRunState?: BatchRunState;
	onStopAutoRun?: () => void;
	onOpenQueueBrowser?: () => void;
	tabReadOnlyMode?: boolean;
	onToggleTabReadOnlyMode?: () => void;
	tabSaveToHistory?: boolean;
	onToggleTabSaveToHistory?: () => void;
	onOpenPromptComposer?: () => void;
	shortcuts?: Record<string, Shortcut>;
	showFlashNotification?: (message: string) => void;
	tabShowThinking?: ThinkingMode;
	onToggleTabShowThinking?: () => void;
	supportsThinking?: boolean;
	contextUsage?: number;
	contextWarningsEnabled?: boolean;
	contextWarningYellowThreshold?: number;
	contextWarningRedThreshold?: number;
	onSummarizeAndContinue?: () => void;
	summarizeProgress?: SummarizeProgress | null;
	summarizeResult?: SummarizeResult | null;
	summarizeStartTime?: number;
	isSummarizing?: boolean;
	onCancelSummarize?: () => void;
	mergeProgress?: GroomingProgress | null;
	mergeResult?: MergeResult | null;
	mergeStartTime?: number;
	isMerging?: boolean;
	mergeSourceName?: string;
	mergeTargetName?: string;
	onCancelMerge?: () => void;
	onExitWizard?: () => void;
	wizardShowThinking?: boolean;
	onToggleWizardShowThinking?: () => void;
	currentModel?: string;
	currentEffort?: string;
	availableModels?: string[];
	availableEfforts?: string[];
	onModelChange?: (model: string) => void;
	onEffortChange?: (effort: string) => void;
}
