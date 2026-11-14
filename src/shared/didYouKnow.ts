/**
 * Shared data model for Did You Know? discovery tips.
 *
 * Tip ids are permanent: renaming one re-shows a tip everyone already dismissed.
 * The pinned list is a deliberate editorial choice, not an accident of array order.
 */
import type { UiSurfaceEncoreFlag } from './uiSurfaces';
import { shuffleWithSeed } from './shuffle';

export interface DidYouKnowTip {
	/** Stable kebab-case id persisted in the seen list. Never rename once shipped. */
	id: string;
	/** Feature name as spelled in the app. */
	title: string;
	/** One-sentence hook that works even if the body is never read. */
	headline: string;
	/** Two to four short paragraphs of plain text, without markdown. */
	body: string[];
	/** lucide-react export name, resolved by the card. */
	icon: string;
	/** Screenshot filename under src/renderer/assets/did-you-know/, cropped to the frame aperture aspect. Omit for an icon plate. */
	art?: string;
	/** Live element CSS selector, reusing data-tour attributes when a static image is less helpful. */
	spotlightSelector?: string;
	/** UiSurface.id used by the primary button. */
	surface?: string;
	/** Key in DEFAULT_SHORTCUTS / TAB_SHORTCUTS / FIXED_SHORTCUTS for the keystroke chip. */
	shortcutId?: string;
	/** Page under docs/ without .md, opened by the in-app Read more action. */
	docsSlug?: string;
	/** Example maestro-cli invocation displayed as a copyable code chip. */
	cli?: string;
	/** When disabled, the card offers Turn it on instead of Open it. */
	encore?: UiSurfaceEncoreFlag;
}

export const DID_YOU_KNOW_TIPS: readonly DidYouKnowTip[] = [
	{
		id: 'maestro-cue',
		title: 'Maestro Cue',
		headline: 'Your agents can start their own work.',
		body: [
			'Cue watches for things that happen (a file changing, a schedule firing, a GitHub PR opening, an unchecked task being found) and dispatches a prompt to the agent you choose.',
			"Pipelines chain agents together, so one agent's finished work becomes another's trigger.",
			'It is configured per project in .maestro/cue.yaml, and the Pipeline Graph draws the whole topology.',
		],
		icon: 'Zap',
		surface: 'cue',
		shortcutId: 'openCue',
		docsSlug: 'maestro-cue',
		encore: 'maestroCue',
	},
	{
		id: 'auto-run',
		title: 'Auto Run',
		headline: 'Hand an agent a checklist and walk away.',
		body: [
			'Spec-driven Auto Run works through unchecked tasks in Markdown. Choose Task mode for a fresh context per task, or Document mode to carry context through a document.',
			'Goal-driven Auto Run takes an objective instead ("get coverage above 90%") and iterates until it completes, hits a blocker, reaches your iteration limit, or you stop it.',
			'Both launch from the Auto Run panel or the CLI, and the Playbook Exchange has ready-made ones.',
		],
		icon: 'Play',
		docsSlug: 'autorun-playbooks',
		cli: 'maestro-cli auto-run <doc.md> --launch --agent <id>',
	},
	{
		id: 'cross-agent-mentions',
		title: 'Cross-Agent Mentions',
		headline: 'Ask another agent a question without leaving this one.',
		body: [
			'Type @ in the composer and pick another agent. Its answer arrives inline, with a copy saved in a consult tab on that agent and no unread badge.',
			'You share your conversation with a specialist in another project. Ask again from the same tab and the consult carries forward your earlier exchanges.',
		],
		icon: 'AtSign',
		docsSlug: 'cross-agent-mentions',
		spotlightSelector: '[data-tour="input-area"]',
	},
	{
		id: 'group-chat',
		title: 'Group Chat',
		headline: 'Let a moderator agent run the meeting.',
		body: [
			'A mention gets you one answer. A Group Chat appoints a moderator that keeps working on its own: routing the question, judging the replies, pushing back when one is thin.',
			"It threads one agent's answer into another's prompt, and goes as many rounds as the problem needs before handing you a synthesis.",
			'You stop being the router.',
		],
		icon: 'MessagesSquare',
		docsSlug: 'group-chat',
	},
	{
		id: 'remote-agents',
		title: 'Remote Agents',
		headline: 'An agent does not have to run on this machine.',
		body: [
			'Point an agent at an SSH remote and its process, its shell, and its file tree all live on that host, while the transcript stays here.',
			'Run big builds on the big machine while you keep the keyboard. Configure the host in Settings, then select it under SSH Remote Execution for your agent.',
		],
		icon: 'Server',
		docsSlug: 'ssh-remote-execution',
	},
	{
		id: 'remote-control',
		title: 'Remote Control',
		headline: 'You can take Maestro with you.',
		body: [
			'Click the OFFLINE button in the Left Bar header. It flips to LIVE and shows a QR code you can scan from your phone.',
			'You can read transcripts, send prompts, and switch tabs from a mobile browser.',
			'Add a Cloudflare tunnel to reach your agents from outside your network, not just the same WiFi.',
		],
		icon: 'TowerControl',
		docsSlug: 'remote-control',
		spotlightSelector: '[data-tour="remote-control"]',
	},
	{
		id: 'maestro-cli',
		title: 'Maestro CLI',
		headline: 'Your agents can drive Maestro itself.',
		body: [
			'Your agents know about maestro-cli and can use it to open files, browser tabs, or terminals, dispatch work to another agent, create an agent, or launch an Auto Run.',
			'You can let one agent hand a job to the fleet without copying anything between windows.',
		],
		icon: 'Terminal',
		docsSlug: 'cli',
		cli: 'maestro-cli dispatch <agent> "..." --background',
	},
	{
		id: 'git-worktrees',
		title: 'Git Worktrees',
		headline: 'Give every agent its own branch and its own checkout.',
		body: [
			'You can give each worktree agent an isolated checkout on its own branch, so two agents can work in the same repository at once without stepping on each other.',
			"When the work is done, ask your agent to commit it. Use the agent's git pill to review the diff or open a pull request.",
		],
		icon: 'GitBranch',
		docsSlug: 'git-worktrees',
	},
	{
		id: 'command-modes',
		title: 'Command Mode',
		headline: 'The composer is a shell too.',
		body: [
			"Type ! in an empty composer to run a shell command in your agent's working directory without leaving the conversation.",
			'Press ! again on an empty command line for AI command mode: describe what you want and get a command back to review before it runs.',
			'You can complete paths with Tab, exactly like a terminal.',
		],
		icon: 'ChevronRightSquare',
		docsSlug: 'general-usage',
		spotlightSelector: '[data-tour="input-area"]',
	},
	{
		id: 'execution-queue',
		title: 'Execution Queue',
		headline: 'Do not wait for the agent to finish before you type.',
		body: [
			'Send while an agent is busy and your message queues instead of bouncing. Queue several and they run in order, each into the tab you aimed it at.',
			'You can use the queue browser to reorder, hold, or edit queued messages before they reach the model.',
		],
		icon: 'ListOrdered',
		surface: 'queue-browser',
		shortcutId: 'executionQueue',
	},
	{
		id: 'context-transfer',
		title: 'Context Transfer',
		headline: 'Move a conversation to a different agent, or a different provider.',
		body: [
			"You can send a conversation's context to another agent and keep working where you left off, including across providers.",
			'Use it when a conversation outgrows its model, when a run burns context on the wrong thing, or when you need a different specialist.',
		],
		icon: 'ArrowRightLeft',
		docsSlug: 'context-management',
	},
	{
		id: 'director-notes',
		title: "Director's Notes",
		headline: 'Ask what the whole fleet did while you were away.',
		body: [
			"You can ask Director's Notes to read your agents' history over a window you choose and write one narrative: what shipped, what stalled, what needs you.",
			'When you come back to nine agents, you have a place to start instead of opening every conversation.',
		],
		icon: 'ClipboardEdit',
		surface: 'director-notes',
		shortcutId: 'directorNotes',
		docsSlug: 'director-notes',
		encore: 'directorNotes',
	},
	{
		id: 'usage-dashboard',
		title: 'Usage Dashboard',
		headline: 'See exactly where your tokens went.',
		body: [
			'You can explore tokens, cost, and activity by agent and day, compare provider accounts, and review your Auto Runs. Costs are marked as estimates when the provider does not report them.',
			'You can also see which keyboard shortcuts you actually use and find the ones you are missing without reading the whole shortcut list.',
		],
		icon: 'BarChart3',
		surface: 'usage-dashboard',
		shortcutId: 'usageDashboard',
		docsSlug: 'usage-dashboard',
		encore: 'usageStats',
	},
	{
		id: 'symphony',
		title: 'Maestro Symphony',
		headline: 'Your spare tokens can ship open source.',
		body: [
			'You can contribute to open-source projects whose maintainers have written the work they want done as Auto Run documents.',
			'Pick a project and an issue, then choose your agent and model. Maestro clones the repository and starts working through the playbook.',
			'Your first commit triggers a draft pull request so the maintainers can follow and review your contribution.',
			"You need the GitHub CLI signed in with gh auth login and the project's build tools installed before you start.",
		],
		icon: 'Music',
		surface: 'symphony',
		shortcutId: 'openSymphony',
		docsSlug: 'symphony',
		encore: 'symphony',
	},
	{
		id: 'document-graph',
		title: 'Document Graph',
		headline: 'Your markdown is a graph, not a folder.',
		body: [
			'You can explore wiki-links between your specs, notes, or research files as a navigable map of how they reference each other.',
			'Open the graph on one file to see its neighbourhood, or scope it to a whole directory to include documents with no links.',
		],
		icon: 'Workflow',
		docsSlug: 'document-graph',
	},
	{
		id: 'snooze-tabs',
		title: 'Snoozed Tabs',
		headline: 'Hide a tab until it is worth looking at again.',
		body: [
			'Snooze an AI tab and it leaves the tab strip until the time you picked, then comes back with its transcript intact.',
			'Use it for work that is real but not now, instead of closing a tab you will regret closing.',
		],
		icon: 'Clock',
		surface: 'snoozed-tabs',
		shortcutId: 'snoozeTab',
		spotlightSelector: '[data-tour="tab-bar"]',
	},
	{
		id: 'image-annotator',
		title: 'Image Annotator',
		headline: 'Paste a screenshot, circle the bug, send it.',
		body: [
			'You can annotate screenshots before you send them: hover a pasted image and click the pencil to add arrows, boxes, circles, or text.',
			'Pointing at the broken pixel is faster than describing it. Save your annotations and the agent gets the same picture you are looking at.',
		],
		icon: 'Highlighter',
		docsSlug: 'image-annotator',
		shortcutId: 'editClipboardImage',
	},
	{
		id: 'playbook-exchange',
		title: 'Playbook Exchange',
		headline: 'Someone already wrote the playbook you were about to write.',
		body: [
			'You can browse community playbooks in the Playbook Exchange, preview their Auto Run documents, and import them straight into your Auto Run folder.',
			'Pick a playbook for the workflow you need, edit it to fit your project, and run it.',
		],
		icon: 'Store',
		surface: 'marketplace',
		docsSlug: 'playbook-exchange',
	},
	{
		id: 'agent-resilience',
		title: 'Agent Resilience',
		headline: 'A rate limit does not have to cost you the run.',
		body: [
			'When your provider returns an overload or quota error, Maestro can resend the failed prompt for you. You control both retry options in Edit Agent.',
			'Your desktop Auto Runs can wait through the outage and resume automatically. Batches launched by the CLI report the failure instead.',
		],
		icon: 'ShieldCheck',
		docsSlug: 'agent-resilience',
	},
	{
		id: 'keyboard-first',
		title: 'Everything Has a Key',
		headline: 'Maestro is meant to be driven without the mouse.',
		body: [
			'You can search the Command Palette for actions by name, including features you have not found yet.',
			'Open the shortcut list to explore the keys, then rebind customizable shortcuts in Settings. Enable Usage Dashboard in Encore Features to see which shortcuts you actually use.',
		],
		icon: 'Keyboard',
		surface: 'shortcuts',
		shortcutId: 'help',
		docsSlug: 'keyboard-shortcuts',
	},
	{
		id: 'media-player',
		title: 'Media Player',
		headline: 'Maestro plays your audio and video, with a queue.',
		body: [
			'Open a supported local audio or video file and you get a floating player with playback controls, a play queue, and a remembered position.',
			'Right-click media files in the Files pane and choose Add to Play Queue to line up what you want to hear or watch next.',
		],
		icon: 'Headphones',
		docsSlug: 'media-player',
		shortcutId: 'openMediaPlayer',
	},
];

export const PINNED_TIP_IDS: readonly string[] = [
	'maestro-cue',
	'auto-run',
	'cross-agent-mentions',
	'group-chat',
	'remote-agents',
];

/** Keep the editorial pins first, then shuffle the remaining tips reproducibly. */
export function buildTipOrder(
	seed: number,
	tips: readonly DidYouKnowTip[] = DID_YOU_KNOW_TIPS
): DidYouKnowTip[] {
	const pinned = PINNED_TIP_IDS.flatMap((id) => {
		const tip = getTipById(id, tips);
		return tip ? [tip] : [];
	});
	const rest = tips.filter((tip) => !PINNED_TIP_IDS.includes(tip.id));
	return [...pinned, ...shuffleWithSeed(rest, seed)];
}

/** Prefer the first unseen tip; after a full rotation, continue after the last tip. */
export function pickNextTip(
	order: readonly DidYouKnowTip[],
	seenIds: readonly string[],
	afterId?: string
): DidYouKnowTip | null {
	if (order.length === 0) return null;
	const seen = new Set(seenIds);
	const unseen = order.find((tip) => !seen.has(tip.id));
	if (unseen) return unseen;
	const afterIndex = order.findIndex((tip) => tip.id === afterId);
	return order[(afterIndex + 1) % order.length];
}

/** Pick uniformly from unseen tips, or all tips when none remain unseen. */
export function pickRandomTip(
	order: readonly DidYouKnowTip[],
	seenIds: readonly string[],
	random: () => number = Math.random
): DidYouKnowTip | null {
	if (order.length === 0) return null;
	const seen = new Set(seenIds);
	const unseen = order.filter((tip) => !seen.has(tip.id));
	const candidates = unseen.length > 0 ? unseen : order;
	return candidates[Math.floor(random() * candidates.length)];
}

/** Resolve a permanent tip id in the registry or an explicitly supplied catalog. */
export function getTipById(
	id: string,
	tips: readonly DidYouKnowTip[] = DID_YOU_KNOW_TIPS
): DidYouKnowTip | undefined {
	return tips.find((tip) => tip.id === id);
}
