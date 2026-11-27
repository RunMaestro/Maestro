/**
 * Prompt Links: create, inspect, and revoke `maestro://run/<token>` links.
 *
 * A split pane: the links down the left (`PromptLinkList`), and on the right
 * either the selected link (`PromptLinkDetail`), the create form
 * (`PromptLinkCreateForm`), or - right after a create - the one screen that
 * shows the URL (`PromptLinkCreatedView`). Narrower than SPLIT_MIN_WIDTH (the
 * Encore tile's settings pane) the two stack instead.
 *
 * One component, two homes: the Prompt Links window and the Prompt Links tile
 * in Settings > Encore Features. Both call the `promptLinks:*` IPC channels,
 * which the same main-process service behind `maestro-cli prompt-link` answers.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Theme } from '../../types';
import { notifyToast } from '../../stores/notificationStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useElementWidth } from '../../hooks/ui/useElementWidth';
import { ipcErrorMessage } from '../../../shared/serializeError';
import {
	PROMPT_LINK_EXPIRY_PRESETS,
	promptLinkStatus,
	type PromptLinkCreated,
	type PromptLinkPublic,
} from '../../../shared/promptLinks';
import { PromptLinkList, type PromptLinkSelection } from './PromptLinkList';
import { PromptLinkDetail } from './PromptLinkDetail';
import {
	PromptLinkCreateForm,
	PromptLinkCreatedView,
	emptyPromptLinkDraft,
	type PromptLinkDraft,
} from './PromptLinkCreateForm';

/** Below this the list stacks above the pane instead of beside it. */
const SPLIT_MIN_WIDTH = 620;

export interface PromptLinksPanelProps {
	theme: Theme;
	/** Agent the create form starts on. */
	initialAgentId?: string;
	/** Prompt the create form starts with (an AI tab's unsent draft). */
	initialPrompt?: string;
	/** Open on the create form rather than on the first link. */
	compose?: boolean;
}

/**
 * Agents a link can target, as one comparable string so the subscription only
 * re-renders when an agent is added, removed, or renamed - never on the token
 * and state churn a whole-session subscription would see.
 */
function selectAgentKey(state: { sessions: { id: string; name: string; toolType: string }[] }) {
	return state.sessions
		.filter((s) => s.toolType !== 'terminal')
		.map((s) => `${s.id}\u0000${s.name}`)
		.join('\u0001');
}

function parseAgentKey(key: string): Array<{ id: string; name: string }> {
	if (!key) return [];
	return key
		.split('\u0001')
		.map((pair) => {
			const [id, name] = pair.split('\u0000');
			return { id, name };
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** The draft a Duplicate starts from: the same agent, prompt, and settings. */
function draftFromLink(link: PromptLinkPublic): PromptLinkDraft {
	const ms = link.expiresAt !== undefined ? link.expiresAt - link.createdAt : null;
	// The original preset, when the lifetime matches one; otherwise the nearest longer.
	const preset =
		ms === null
			? undefined
			: (PROMPT_LINK_EXPIRY_PRESETS.find((p) => p.ms !== null && p.ms >= ms - 60_000) ??
				PROMPT_LINK_EXPIRY_PRESETS[PROMPT_LINK_EXPIRY_PRESETS.length - 1]);
	return {
		agentId: link.agentId,
		prompt: link.prompt,
		label: link.label ?? '',
		usesMode: link.maxUses === null ? 'unlimited' : link.maxUses === 1 ? 'once' : 'count',
		usesCount: link.maxUses && link.maxUses > 1 ? String(link.maxUses) : '5',
		expiryId: preset?.id ?? 'never',
		open: link.open,
	};
}

export function PromptLinksPanel({
	theme,
	initialAgentId,
	initialPrompt,
	compose,
}: PromptLinksPanelProps) {
	const agentKey = useSessionStore(selectAgentKey);
	const agents = useMemo(() => parseAgentKey(agentKey), [agentKey]);
	const agentNames = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents]);

	const rootRef = useRef<HTMLDivElement>(null);
	const width = useElementWidth(rootRef);
	// 0 = not measured yet (and always, in jsdom): lay out as a split.
	const split = width === 0 || width >= SPLIT_MIN_WIDTH;

	const [links, setLinks] = useState<PromptLinkPublic[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [showInactive, setShowInactive] = useState(false);
	const [selection, setSelection] = useState<PromptLinkSelection | null>(
		compose || initialPrompt ? { kind: 'new' } : null
	);
	const [draft, setDraft] = useState<PromptLinkDraft>(() =>
		emptyPromptLinkDraft(initialAgentId ?? '', initialPrompt ?? '')
	);
	const [created, setCreated] = useState<PromptLinkCreated | null>(null);
	const [busyId, setBusyId] = useState<string | null>(null);

	// Fall back to the first agent when the prefill names none (or one that is gone).
	useEffect(() => {
		if (agents.length === 0) return;
		if (!draft.agentId || !agentNames.has(draft.agentId)) {
			setDraft((d) => ({ ...d, agentId: agents[0].id }));
		}
	}, [agents, agentNames, draft.agentId]);

	const refresh = useCallback(async (): Promise<PromptLinkPublic[]> => {
		try {
			const list = await window.maestro.promptLinks.list();
			setLinks(list);
			setLoadError(null);
			return list;
		} catch (err) {
			setLinks([]);
			setLoadError(ipcErrorMessage(err, String(err)));
			return [];
		}
	}, []);

	// First load decides where the pane starts: the newest active link, else the form.
	useEffect(() => {
		void refresh().then((list) => {
			setSelection((current) => {
				if (current) return current;
				const now = Date.now();
				const first = list.find((l) => promptLinkStatus(l, now) === 'active');
				return first ? { kind: 'link', id: first.id } : { kind: 'new' };
			});
		});
	}, [refresh]);

	const select = useCallback((next: PromptLinkSelection) => {
		setCreated(null);
		setSelection(next);
	}, []);

	const handleCreated = useCallback(
		(result: PromptLinkCreated) => {
			setCreated(result);
			setDraft((d) => emptyPromptLinkDraft(d.agentId));
			void refresh();
		},
		[refresh]
	);

	const revoke = useCallback(
		async (link: PromptLinkPublic) => {
			setBusyId(link.id);
			try {
				await window.maestro.promptLinks.revoke(link.id);
				await refresh();
				notifyToast({
					color: 'green',
					title: 'Prompt Links',
					message: `Revoked ${link.label ? `"${link.label}"` : 'the link'}. It can never run again.`,
				});
			} catch (err) {
				notifyToast({
					color: 'red',
					title: 'Prompt Links',
					message: ipcErrorMessage(err, String(err)),
				});
			} finally {
				setBusyId(null);
			}
		},
		[refresh]
	);

	const duplicate = useCallback((link: PromptLinkPublic) => {
		setCreated(null);
		setDraft(draftFromLink(link));
		setSelection({ kind: 'new' });
	}, []);

	const now = Date.now();
	const selectedLink =
		selection?.kind === 'link' ? (links ?? []).find((l) => l.id === selection.id) : undefined;
	// A selected link that went inactive stays visible in the list while selected.
	const inactiveSelected =
		selectedLink !== undefined && promptLinkStatus(selectedLink, now) !== 'active';

	let pane: React.ReactNode = null;
	if (created) {
		pane = (
			<PromptLinkCreatedView
				theme={theme}
				created={created}
				agentName={agentNames.get(created.link.agentId)}
				onViewLink={() => select({ kind: 'link', id: created.link.id })}
				onCreateAnother={() => select({ kind: 'new' })}
			/>
		);
	} else if (selection?.kind === 'new') {
		pane = (
			<PromptLinkCreateForm
				theme={theme}
				agents={agents}
				draft={draft}
				onDraftChange={setDraft}
				onCreated={handleCreated}
			/>
		);
	} else if (selectedLink) {
		pane = (
			<PromptLinkDetail
				key={selectedLink.id}
				theme={theme}
				link={selectedLink}
				agentName={agentNames.get(selectedLink.agentId)}
				now={now}
				busy={busyId === selectedLink.id}
				onRevoke={(l) => void revoke(l)}
				onDuplicate={duplicate}
			/>
		);
	}

	return (
		<div
			ref={rootRef}
			data-testid="prompt-links-panel"
			data-layout={split ? 'split' : 'stacked'}
			className={split ? 'flex h-full min-h-0' : 'flex flex-col'}
		>
			<div
				className={split ? 'w-64 flex-shrink-0 border-r min-h-0' : 'border-b max-h-72'}
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
			>
				<PromptLinkList
					theme={theme}
					links={links}
					loadError={loadError}
					agentNames={agentNames}
					selection={selection}
					onSelect={select}
					showInactive={showInactive || inactiveSelected}
					onToggleInactive={() => setShowInactive((v) => !v)}
					now={now}
				/>
			</div>
			<div className={split ? 'flex-1 min-w-0 min-h-0 overflow-y-auto' : ''}>{pane}</div>
		</div>
	);
}
