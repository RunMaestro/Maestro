/**
 * The right pane of the Prompt Links window while making a link: the agent,
 * the prompt, an optional label, and the three "when it runs" settings, each a
 * dropdown that reads as a sentence ("Runs once", "Never expires", "Opens in
 * the background"). After a create it swaps to the one screen that ever shows
 * the URL, because only a hash of the token is kept.
 */

import { useCallback, useState } from 'react';
import { CheckCircle, Copy, Check, Link2 } from 'lucide-react';
import type { Theme } from '../../types';
import { ThemedSelect } from '../shared/ThemedSelect';
import { notifyToast } from '../../stores/notificationStore';
import { safeClipboardWrite } from '../../utils/clipboard';
import { ipcErrorMessage } from '../../../shared/serializeError';
import {
	PROMPT_LINK_EXPIRY_PRESETS,
	PROMPT_LINK_MAX_USES,
	describePromptLinkUses,
	validatePromptLinkInput,
	type PromptLinkCreated,
	type PromptLinkOpenMode,
} from '../../../shared/promptLinks';

export type PromptLinkUsesMode = 'once' | 'count' | 'unlimited';

/** Everything the form holds, owned by the parent so Duplicate can prefill all of it. */
export interface PromptLinkDraft {
	agentId: string;
	prompt: string;
	label: string;
	usesMode: PromptLinkUsesMode;
	usesCount: string;
	expiryId: string;
	open: PromptLinkOpenMode;
}

export function emptyPromptLinkDraft(agentId = '', prompt = ''): PromptLinkDraft {
	return {
		agentId,
		prompt,
		label: '',
		usesMode: 'once',
		usesCount: '5',
		expiryId: 'never',
		open: 'background',
	};
}

const USES_OPTIONS = [
	{ value: 'once', label: 'Runs once' },
	{ value: 'count', label: 'Runs a set number of times' },
	{ value: 'unlimited', label: 'Runs every time' },
];

const EXPIRY_OPTIONS = PROMPT_LINK_EXPIRY_PRESETS.map((p) => ({
	value: p.id,
	label: p.ms === null ? 'Never expires' : `Expires in ${p.label}`,
}));

const OPEN_OPTIONS = [
	{ value: 'background', label: 'Opens in the background' },
	{ value: 'foreground', label: 'Opens in the foreground' },
];

interface PromptLinkCreateFormProps {
	theme: Theme;
	agents: ReadonlyArray<{ id: string; name: string }>;
	draft: PromptLinkDraft;
	onDraftChange: (draft: PromptLinkDraft) => void;
	/** Called with the new link once it exists; the parent refreshes its list. */
	onCreated: (created: PromptLinkCreated) => void;
}

export function PromptLinkCreateForm({
	theme,
	agents,
	draft,
	onDraftChange,
	onCreated,
}: PromptLinkCreateFormProps) {
	const { usesMode, usesCount, expiryId, open } = draft;
	const [creating, setCreating] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const set = (patch: Partial<PromptLinkDraft>) => onDraftChange({ ...draft, ...patch });

	const create = useCallback(async () => {
		const maxUses =
			usesMode === 'once' ? 1 : usesMode === 'unlimited' ? null : Number(usesCount.trim());
		const preset = PROMPT_LINK_EXPIRY_PRESETS.find((p) => p.id === expiryId);
		const now = Date.now();
		const input = {
			agentId: draft.agentId,
			prompt: draft.prompt,
			maxUses,
			open,
			...(draft.label.trim() ? { label: draft.label.trim() } : {}),
			...(preset?.ms ? { expiresAt: now + preset.ms } : {}),
		};
		// Validate here first so the common mistakes answer instantly, in the
		// same words the store would have used.
		const problem = validatePromptLinkInput(input, now);
		if (problem) {
			setError(problem);
			return;
		}
		setCreating(true);
		try {
			const result = await window.maestro.promptLinks.create(input);
			setError(null);
			onCreated(result);
		} catch (err) {
			setError(ipcErrorMessage(err, String(err)));
		} finally {
			setCreating(false);
		}
	}, [draft, usesMode, usesCount, expiryId, open, onCreated]);

	const fieldLabel = 'block text-2xs uppercase tracking-wide font-medium mb-1.5';
	const inputStyle = {
		backgroundColor: theme.colors.bgActivity,
		borderColor: theme.colors.border,
		color: theme.colors.textMain,
	};

	if (agents.length === 0) {
		return (
			<div className="p-5 text-xs" style={{ color: theme.colors.textDim }}>
				Create an AI agent first: a link runs in one.
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-4 p-5 h-full" data-testid="prompt-link-form">
			<h3 className="text-base font-semibold" style={{ color: theme.colors.textMain }}>
				New prompt link
			</h3>

			<div>
				<span className={fieldLabel} style={{ color: theme.colors.textDim }}>
					Agent
				</span>
				<ThemedSelect
					value={draft.agentId}
					options={agents.map((a) => ({ value: a.id, label: a.name }))}
					onChange={(agentId) => set({ agentId })}
					theme={theme}
					aria-label="Agent"
					filterable={agents.length > 8}
					filterPlaceholder="Find an agent..."
					style={{ maxWidth: 280 }}
				/>
			</div>

			<div className="flex flex-col flex-1 min-h-[7rem]">
				<label
					htmlFor="prompt-link-prompt"
					className={fieldLabel}
					style={{ color: theme.colors.textDim }}
				>
					Prompt
				</label>
				<textarea
					id="prompt-link-prompt"
					data-testid="prompt-link-prompt"
					placeholder="What should the agent do when the link is clicked?"
					value={draft.prompt}
					onChange={(e) => set({ prompt: e.target.value })}
					className="flex-1 w-full min-h-[7rem] px-3 py-2 rounded-lg border text-xs font-mono outline-none resize-none focus:border-current"
					style={inputStyle}
				/>
			</div>

			<div>
				<label
					htmlFor="prompt-link-label"
					className={fieldLabel}
					style={{ color: theme.colors.textDim }}
				>
					Label <span className="normal-case tracking-normal">(optional)</span>
				</label>
				<input
					id="prompt-link-label"
					type="text"
					data-testid="prompt-link-label"
					placeholder="Standup prep"
					value={draft.label}
					onChange={(e) => set({ label: e.target.value })}
					className="w-full px-3 py-1.5 rounded-lg border text-xs outline-none focus:border-current"
					style={inputStyle}
				/>
			</div>

			<div>
				<span className={fieldLabel} style={{ color: theme.colors.textDim }}>
					When it runs
				</span>
				<div className="flex flex-wrap items-center gap-2">
					<ThemedSelect
						value={usesMode}
						options={USES_OPTIONS}
						onChange={(v) => set({ usesMode: v as PromptLinkUsesMode })}
						theme={theme}
						aria-label="Uses"
						style={{ minWidth: 150 }}
					/>
					{usesMode === 'count' && (
						<input
							type="number"
							min={1}
							max={PROMPT_LINK_MAX_USES}
							data-testid="prompt-link-uses-count-input"
							aria-label="Number of uses"
							value={usesCount}
							onChange={(e) => set({ usesCount: e.target.value })}
							className="w-16 px-2 py-1 rounded border text-xs outline-none"
							style={inputStyle}
						/>
					)}
					<ThemedSelect
						value={expiryId}
						options={EXPIRY_OPTIONS}
						onChange={(expiryId) => set({ expiryId })}
						theme={theme}
						aria-label="Expires"
						style={{ minWidth: 150 }}
					/>
					<ThemedSelect
						value={open}
						options={OPEN_OPTIONS}
						onChange={(v) => set({ open: v as PromptLinkOpenMode })}
						theme={theme}
						aria-label="Opens in"
						style={{ minWidth: 180 }}
					/>
				</div>
			</div>

			<div className="flex items-center justify-between gap-3 pt-1">
				<p
					className="text-xs min-w-0"
					data-testid={error ? 'prompt-link-create-error' : undefined}
					style={{ color: error ? theme.colors.error : theme.colors.textDim }}
				>
					{error ?? 'The URL is shown once, right after you create it.'}
				</p>
				<button
					type="button"
					data-testid="prompt-link-create"
					disabled={creating}
					onClick={() => void create()}
					className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold flex-shrink-0 transition-opacity hover:opacity-90 disabled:opacity-50"
					style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
				>
					<Link2 className="w-3.5 h-3.5" /> Create link
				</button>
			</div>
		</div>
	);
}

interface PromptLinkCreatedViewProps {
	theme: Theme;
	created: PromptLinkCreated;
	agentName: string | undefined;
	onViewLink: () => void;
	onCreateAnother: () => void;
}

/** The one screen that ever shows a link's URL. */
export function PromptLinkCreatedView({
	theme,
	created,
	agentName,
	onViewLink,
	onCreateAnother,
}: PromptLinkCreatedViewProps) {
	const [copied, setCopied] = useState(false);

	const copy = useCallback(async () => {
		const ok = await safeClipboardWrite(created.url);
		setCopied(ok);
		if (!ok) {
			notifyToast({
				color: 'red',
				title: 'Prompt Links',
				message: 'Could not copy the link. Select it and copy it by hand.',
			});
		}
	}, [created.url]);

	return (
		<div
			className="flex flex-col items-center justify-center text-center gap-4 p-8 h-full"
			data-testid="prompt-link-created"
		>
			<CheckCircle className="w-10 h-10" style={{ color: theme.colors.success }} />
			<div>
				<h3 className="text-base font-semibold" style={{ color: theme.colors.textMain }}>
					Your link is ready
				</h3>
				<p className="text-xs mt-1" style={{ color: theme.colors.textDim }}>
					{agentName ? `Runs in ${agentName}. ` : ''}
					{describePromptLinkUses(created.link)}.
				</p>
			</div>

			<div className="w-full max-w-md flex flex-col gap-2">
				<input
					type="text"
					readOnly
					data-testid="prompt-link-created-url"
					aria-label="New prompt link URL"
					value={created.url}
					onFocus={(e) => e.currentTarget.select()}
					className="w-full px-3 py-2.5 rounded-lg border text-xs font-mono text-center outline-none select-all"
					style={{
						backgroundColor: theme.colors.bgActivity,
						borderColor: theme.colors.success,
						color: theme.colors.textMain,
					}}
				/>
				<button
					type="button"
					data-testid="prompt-link-copy"
					onClick={() => void copy()}
					className="flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg text-sm font-semibold transition-opacity hover:opacity-90"
					style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
				>
					{copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
					{copied ? 'Copied' : 'Copy link'}
				</button>
			</div>

			<p className="text-2xs max-w-sm" style={{ color: theme.colors.warning }}>
				Copy it now. Maestro keeps only a fingerprint of this URL, so it cannot be shown again.
			</p>

			<div className="flex items-center gap-4 text-xs">
				<button
					type="button"
					data-testid="prompt-link-view-created"
					onClick={onViewLink}
					className="underline-offset-2 hover:underline"
					style={{ color: theme.colors.textDim }}
				>
					View link details
				</button>
				<button
					type="button"
					data-testid="prompt-link-create-another"
					onClick={onCreateAnother}
					className="underline-offset-2 hover:underline"
					style={{ color: theme.colors.accent }}
				>
					Create another
				</button>
			</div>
		</div>
	);
}
