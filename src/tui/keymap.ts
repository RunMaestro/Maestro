/**
 * Every key the TUI answers, in one table (spec section 5.2).
 *
 * The input handler resolves a keypress through `resolveAction`, and the help
 * overlay draws its rows from `KEYMAP` through `formatBindingKeys`. Both read
 * this one table, so the help on screen cannot disagree with what a key does.
 * Adding a binding here is the whole change: it shows up in help by itself.
 */

import type { Key } from 'ink';

/** Where a binding is live: the main view, or one of the overlays. */
export type KeyContext =
	| 'main'
	/** The Conversation pane has focus and a desktop is attached: letters type into the composer. */
	| 'composer'
	/** The composer with the `@` agent picker open: arrows pick a row, Tab or Enter inserts it, other keys still type. */
	| 'composerMention'
	| 'help'
	| 'tabs'
	| 'history'
	| 'palette'
	| 'menu'
	| 'form'
	| 'prompt'
	| 'confirm'
	| 'groupPicker'
	| 'providerPicker'
	/** The Auto Run documents of an agent. */
	| 'autoRun'
	/** The box a new Auto Run document is named in: letters type. */
	| 'autoRunName'
	/** The form that configures an Auto Run: letters type into its text boxes. */
	| 'autoRunLaunch'
	/** The live progress of an Auto Run, with its controls. */
	| 'autoRunProgress'
	/** The list of group chats. */
	| 'groupChats'
	/** The form that creates a group chat: letters type into its text boxes. */
	| 'groupChatForm'
	/** One open group chat: letters type into its message box. */
	| 'groupChat';

export type KeyAction =
	| 'quit'
	| 'help'
	| 'nextPane'
	| 'prevPane'
	| 'moveUp'
	| 'moveDown'
	| 'open'
	| 'tabSwitcher'
	| 'newTab'
	| 'renameTab'
	| 'closeTab'
	| 'history'
	| 'toggleToolCalls'
	| 'toggleAgentsPane'
	| 'palette'
	| 'agentMenu'
	| 'newAgent'
	| 'editAgent'
	| 'submitForm'
	| 'choicePrev'
	| 'choiceNext'
	| 'rename'
	| 'deleteItem'
	| 'moveToGroup'
	| 'switchProvider'
	| 'autoRun'
	| 'newDocument'
	| 'reloadDocuments'
	| 'toggleDocument'
	| 'startRun'
	| 'startGoalRun'
	| 'watchRun'
	| 'stopRun'
	| 'resumeRun'
	| 'skipDocument'
	| 'abortRun'
	| 'groupChats'
	| 'newGroupChat'
	| 'renameGroupChat'
	| 'deleteGroupChat'
	| 'reloadGroupChats'
	| 'stopGroupChat'
	| 'sendGroupChat'
	| 'newGroup'
	| 'confirm'
	| 'send'
	| 'acceptMention'
	| 'dismissMention'
	| 'delegate'
	| 'newline'
	| 'interrupt'
	| 'blurComposer'
	| 'closeOverlay';

/** Keys that arrive as a flag on Ink's `Key` rather than as text. */
export type NamedKey = 'tab' | 'return' | 'escape' | 'up' | 'down' | 'left' | 'right';

export interface KeyChord {
	/** A printable key, as Ink reports it (`j`, `T`, `?`). */
	input?: string;
	/**
	 * How the chord reads in help, for a key Ink reports as a raw character (a
	 * line feed is Ctrl-J, and ESC then CR is Alt-Enter).
	 */
	label?: string;
	named?: NamedKey;
	ctrl?: boolean;
	/** Only meaningful for `Tab`: letters carry their shift in the character itself. */
	shift?: boolean;
}

export interface Binding {
	action: KeyAction;
	chords: readonly KeyChord[];
	contexts: readonly KeyContext[];
	/**
	 * Chords that replace `chords` in a context. The palette types into a text
	 * box, so there a letter like `j` must stay a letter and only arrows and
	 * Ctrl chords may move the cursor.
	 */
	chordsByContext?: Partial<Record<KeyContext, readonly KeyChord[]>>;
	/** One short line. Help draws it beside the keys. */
	description: string;
	/**
	 * Set on an action that acts on the selected agent: this is its row in the
	 * agent menu (`m`). A later phase's agent actions add their own bindings with
	 * a label and show up there by themselves.
	 */
	agentMenu?: string;
}

export const KEYMAP: readonly Binding[] = [
	{
		action: 'nextPane',
		chords: [{ named: 'tab' }],
		contexts: ['main', 'composer'],
		description: 'Next pane',
	},
	{
		action: 'prevPane',
		chords: [{ named: 'tab', shift: true }],
		contexts: ['main', 'composer'],
		description: 'Previous pane',
	},
	{
		action: 'moveDown',
		chords: [{ input: 'j' }, { named: 'down' }],
		contexts: [
			'main',
			'help',
			'tabs',
			'history',
			'palette',
			'menu',
			'form',
			'prompt',
			'groupPicker',
			'providerPicker',
			'autoRun',
			'autoRunLaunch',
			'groupChats',
			'groupChatForm',
			'composerMention',
		],
		chordsByContext: {
			palette: [{ named: 'down' }, { input: 'n', ctrl: true }],
			composerMention: [{ named: 'down' }, { input: 'n', ctrl: true }],
			groupChatForm: [{ named: 'down' }, { named: 'tab' }, { input: 'n', ctrl: true }],
			// A form is a text box: letters type, so the cursor moves on arrows, Tab, and Ctrl-N.
			form: [{ named: 'down' }, { named: 'tab' }, { input: 'n', ctrl: true }],
			autoRunLaunch: [{ named: 'down' }, { named: 'tab' }, { input: 'n', ctrl: true }],
			prompt: [{ named: 'down' }, { named: 'tab' }, { input: 'n', ctrl: true }],
		},
		description: 'Move down',
	},
	{
		action: 'moveUp',
		chords: [{ input: 'k' }, { named: 'up' }],
		contexts: [
			'main',
			'help',
			'tabs',
			'history',
			'palette',
			'menu',
			'form',
			'prompt',
			'groupPicker',
			'providerPicker',
			'autoRun',
			'autoRunLaunch',
			'groupChats',
			'groupChatForm',
			'composerMention',
		],
		chordsByContext: {
			palette: [{ named: 'up' }, { input: 'p', ctrl: true }],
			composerMention: [{ named: 'up' }, { input: 'p', ctrl: true }],
			groupChatForm: [{ named: 'up' }, { named: 'tab', shift: true }, { input: 'p', ctrl: true }],
			form: [{ named: 'up' }, { named: 'tab', shift: true }, { input: 'p', ctrl: true }],
			autoRunLaunch: [{ named: 'up' }, { named: 'tab', shift: true }, { input: 'p', ctrl: true }],
			prompt: [{ named: 'up' }, { named: 'tab', shift: true }, { input: 'p', ctrl: true }],
		},
		description: 'Move up',
	},
	{
		action: 'open',
		chords: [{ named: 'return' }],
		contexts: [
			'main',
			'tabs',
			'palette',
			'menu',
			'form',
			'prompt',
			'groupPicker',
			'providerPicker',
			'autoRun',
			'autoRunName',
			'autoRunLaunch',
			'groupChats',
			'groupChatForm',
		],
		description: 'Open agent, fold group, pick, next field, save, edit',
		agentMenu: 'Open conversation',
	},
	{
		action: 'tabSwitcher',
		chords: [{ input: 'T' }],
		contexts: ['main'],
		description: 'Tab switcher for the selected agent',
		agentMenu: 'Switch tab',
	},
	{
		action: 'newTab',
		chords: [{ input: 't' }],
		contexts: ['main', 'tabs'],
		description: 'New tab for the selected agent',
		agentMenu: 'New tab',
	},
	{
		action: 'renameTab',
		chords: [{ input: 'r' }],
		contexts: ['main', 'tabs'],
		description: 'Rename the open or highlighted tab',
		agentMenu: 'Rename tab',
	},
	{
		action: 'closeTab',
		chords: [{ input: 'x' }],
		contexts: ['main', 'tabs'],
		description: 'Close the open tab into closed-tab history',
		agentMenu: 'Close tab',
	},
	{
		action: 'history',
		chords: [{ input: 'H' }],
		contexts: ['main'],
		description: 'History of the selected agent',
		agentMenu: 'History',
	},
	{
		action: 'newAgent',
		chords: [{ input: 'n' }],
		contexts: ['main'],
		description: 'New agent',
	},
	{
		action: 'editAgent',
		chords: [{ input: 'E' }],
		contexts: ['main'],
		description: 'Edit the selected agent',
		agentMenu: 'Edit agent',
	},
	{
		action: 'rename',
		chords: [{ input: 'R' }],
		contexts: ['main'],
		description: 'Rename the selected agent or group',
		agentMenu: 'Rename agent',
	},
	{
		action: 'deleteItem',
		chords: [{ input: 'X' }],
		contexts: ['main'],
		description: 'Delete the selected agent or group',
		agentMenu: 'Delete agent',
	},
	{
		action: 'moveToGroup',
		chords: [{ input: 'g' }],
		contexts: ['main'],
		description: 'Move the selected agent to a group',
		agentMenu: 'Move to group',
	},
	{
		action: 'switchProvider',
		chords: [{ input: 'p' }],
		contexts: ['main'],
		description: "Change the selected agent's provider",
		agentMenu: 'Change provider',
	},
	{
		action: 'autoRun',
		chords: [{ input: 'a' }],
		contexts: ['main'],
		description: 'Auto Run documents of the selected agent',
		agentMenu: 'Auto Run documents',
	},
	{
		action: 'newDocument',
		chords: [{ input: 'n' }],
		contexts: ['autoRun'],
		description: 'New Auto Run document, opened in $EDITOR',
	},
	{
		action: 'reloadDocuments',
		chords: [{ input: 'r' }],
		contexts: ['autoRun'],
		description: 'Reload the Auto Run documents',
	},
	{
		action: 'toggleDocument',
		chords: [{ input: ' ', label: 'Space' }],
		contexts: ['autoRun'],
		description: 'Pick a document; pick order is run order',
	},
	{
		action: 'startRun',
		chords: [{ input: 's' }],
		contexts: ['autoRun'],
		description: 'Start an Auto Run over the picked documents',
		agentMenu: 'Start Auto Run',
	},
	{
		action: 'startGoalRun',
		chords: [{ input: 'g' }],
		contexts: ['autoRun'],
		description: 'Start a goal-driven Auto Run',
		agentMenu: 'Start goal run',
	},
	{
		action: 'watchRun',
		chords: [{ input: 'w' }],
		contexts: ['autoRun'],
		description: 'Watch the Auto Run: progress, output, controls',
		agentMenu: 'Auto Run progress',
	},
	{
		action: 'stopRun',
		chords: [{ input: 's' }],
		contexts: ['autoRunProgress'],
		description: 'Stop the Auto Run after the current task',
	},
	{
		action: 'resumeRun',
		chords: [{ input: 'r' }],
		contexts: ['autoRunProgress'],
		description: 'Resume a paused run, or approve its gate',
	},
	{
		action: 'skipDocument',
		chords: [{ input: 'n' }],
		contexts: ['autoRunProgress'],
		description: 'Skip the failing document and go on',
	},
	{
		action: 'abortRun',
		chords: [{ input: 'a' }],
		contexts: ['autoRunProgress'],
		description: 'Abort a paused Auto Run',
	},
	{
		action: 'groupChats',
		chords: [{ input: 'c' }],
		contexts: ['main'],
		description: 'Group chats',
	},
	{
		action: 'newGroupChat',
		chords: [{ input: 'n' }],
		contexts: ['groupChats'],
		description: 'New group chat',
	},
	{
		action: 'renameGroupChat',
		chords: [{ input: 'R' }],
		contexts: ['groupChats'],
		description: 'Rename the highlighted group chat',
	},
	{
		action: 'deleteGroupChat',
		chords: [{ input: 'X' }],
		contexts: ['groupChats'],
		description: 'Delete the highlighted group chat',
	},
	{
		action: 'reloadGroupChats',
		chords: [{ input: 'r' }],
		contexts: ['groupChats'],
		description: 'Reload the group chats',
	},
	{
		action: 'sendGroupChat',
		chords: [{ named: 'return' }],
		contexts: ['groupChat'],
		description: 'Send to the moderator (one round at a time)',
	},
	{
		action: 'stopGroupChat',
		chords: [{ input: 'x', ctrl: true }],
		contexts: ['groupChat'],
		description: 'Stop the round: moderator and participants',
	},
	{
		action: 'newGroup',
		chords: [{ input: 'N' }],
		contexts: ['main'],
		description: 'New group',
	},
	{
		action: 'send',
		chords: [{ named: 'return' }],
		contexts: ['composer'],
		description: 'Send the message (queued while busy)',
	},
	{
		action: 'acceptMention',
		chords: [{ named: 'tab' }, { named: 'return' }],
		contexts: ['composerMention'],
		description: 'Insert the agent; a group inserts its members',
	},
	{
		action: 'dismissMention',
		chords: [{ named: 'escape' }],
		contexts: ['composerMention'],
		description: 'Close the agent picker, keep the text',
	},
	{
		action: 'delegate',
		chords: [{ input: 'd', ctrl: true }],
		contexts: ['composer', 'composerMention'],
		description: 'Hand the message to the @agent as work (can edit)',
	},
	{
		action: 'newline',
		// Terminals send a plain Enter for Shift-Enter, so the line feed (Ctrl-J) is the reliable key;
		// ESC then CR is what most terminals send for Alt-Enter, or for Shift-Enter when mapped.
		chords: [
			{ input: '\n', label: 'Ctrl-J' },
			{ input: '\r', label: 'Alt-Enter' },
		],
		contexts: ['composer', 'composerMention', 'groupChat'],
		description: 'New line in the message',
	},
	{
		action: 'interrupt',
		chords: [{ input: 'c', ctrl: true }],
		contexts: [
			'main',
			'composer',
			'composerMention',
			'help',
			'tabs',
			'history',
			'palette',
			'menu',
			'form',
			'prompt',
			'confirm',
			'groupPicker',
			'providerPicker',
			'autoRun',
			'autoRunName',
			'autoRunLaunch',
			'autoRunProgress',
			'groupChats',
			'groupChatForm',
			'groupChat',
		],
		description: 'Interrupt the turn; twice in 1s quits',
		agentMenu: 'Interrupt turn',
	},
	{
		action: 'blurComposer',
		chords: [{ named: 'escape' }],
		contexts: ['composer'],
		description: 'Leave the composer',
	},
	{
		action: 'confirm',
		chords: [{ input: 'y' }, { named: 'return' }],
		contexts: ['confirm'],
		description: 'Confirm a delete',
	},
	{
		action: 'submitForm',
		chords: [{ input: 's', ctrl: true }],
		contexts: ['form', 'groupChatForm'],
		description: 'Save the agent or group chat form',
	},
	{
		action: 'choicePrev',
		chords: [{ named: 'left' }],
		contexts: ['form', 'autoRunLaunch', 'groupChatForm'],
		description: 'Previous choice in a form field',
	},
	{
		action: 'choiceNext',
		chords: [{ named: 'right' }],
		contexts: ['form', 'autoRunLaunch', 'groupChatForm'],
		description: 'Next choice, or accept the path completion',
	},
	{
		action: 'toggleToolCalls',
		chords: [{ input: 'e' }],
		contexts: ['main'],
		description: 'Expand or collapse tool calls',
	},
	{
		action: 'toggleAgentsPane',
		chords: [{ input: 'b', ctrl: true }],
		contexts: ['main', 'composer', 'composerMention'],
		description: 'Show or hide the Agents pane',
	},
	{
		action: 'palette',
		chords: [{ input: 'k', ctrl: true }],
		contexts: ['main', 'composer', 'composerMention', 'palette'],
		description: 'Command palette',
	},
	{
		action: 'agentMenu',
		chords: [{ input: 'm' }],
		contexts: ['main'],
		description: 'Menu for the selected agent',
	},
	{
		action: 'help',
		chords: [{ input: '?' }],
		contexts: ['main', 'help'],
		description: 'Key help',
	},
	{
		action: 'quit',
		chords: [{ input: 'q' }],
		contexts: ['main'],
		description: 'Quit',
	},
	{
		action: 'closeOverlay',
		chords: [{ named: 'escape' }],
		contexts: [
			'help',
			'tabs',
			'history',
			'palette',
			'menu',
			'form',
			'prompt',
			'confirm',
			'groupPicker',
			'providerPicker',
			'autoRun',
			'autoRunName',
			'autoRunLaunch',
			'autoRunProgress',
			'groupChats',
			'groupChatForm',
			'groupChat',
		],
		// A confirmation also takes `n`: "no" is the answer a hand reaches for next to `y`.
		chordsByContext: { confirm: [{ named: 'escape' }, { input: 'n' }] },
		description: 'Close the overlay',
	},
];

function namedKeyPressed(named: NamedKey, key: Key): boolean {
	switch (named) {
		case 'tab':
			return key.tab;
		case 'return':
			return key.return;
		case 'escape':
			return key.escape;
		case 'up':
			return key.upArrow;
		case 'down':
			return key.downArrow;
		case 'left':
			return key.leftArrow;
		case 'right':
			return key.rightArrow;
	}
}

/** The chords that mean `binding` in `context`: its override there, else its usual keys. */
export function chordsIn(binding: Binding, context: KeyContext): readonly KeyChord[] {
	return binding.chordsByContext?.[context] ?? binding.chords;
}

export function chordMatches(chord: KeyChord, input: string, key: Key): boolean {
	// Ink reports a bare Esc with `meta` set too (it reads the leading ESC byte as an Alt prefix).
	if (key.meta && chord.named !== 'escape') return false;
	if (chord.named) {
		if (!namedKeyPressed(chord.named, key)) return false;
		// Only Tab has a shifted form; the other named keys ignore the flag.
		return chord.named !== 'tab' || Boolean(chord.shift) === key.shift;
	}
	return chord.input === input && Boolean(chord.ctrl) === key.ctrl;
}

/** The action a keypress means in `context`, or undefined when it means nothing there. */
export function resolveAction(
	context: KeyContext,
	input: string,
	key: Key,
	keymap: readonly Binding[] = KEYMAP
): KeyAction | undefined {
	for (const binding of keymap) {
		if (!binding.contexts.includes(context)) continue;
		if (chordsIn(binding, context).some((chord) => chordMatches(chord, input, key)))
			return binding.action;
	}
	return undefined;
}

const NAMED_KEY_LABELS: Record<NamedKey, string> = {
	tab: 'Tab',
	return: 'Enter',
	escape: 'Esc',
	up: '↑',
	down: '↓',
	left: '←',
	right: '→',
};

export function formatChord(chord: KeyChord): string {
	if (chord.label) return chord.label;
	if (chord.named) {
		const label = NAMED_KEY_LABELS[chord.named];
		return chord.shift ? `Shift-${label}` : label;
	}
	const input = chord.input ?? '';
	return chord.ctrl ? `Ctrl-${input.toUpperCase()}` : input;
}

/** `j / ↓`: how a binding's keys read in help and in hints. */
export function formatBindingKeys(binding: Binding): string {
	return binding.chords.map(formatChord).join(' / ');
}

export function bindingFor(action: KeyAction, keymap: readonly Binding[] = KEYMAP): Binding {
	const binding = keymap.find((candidate) => candidate.action === action);
	if (!binding) throw new Error(`no binding for ${action}`);
	return binding;
}

/** The keys for one action, ready to print in a hint line. */
export function keysFor(action: KeyAction): string {
	return formatBindingKeys(bindingFor(action));
}
