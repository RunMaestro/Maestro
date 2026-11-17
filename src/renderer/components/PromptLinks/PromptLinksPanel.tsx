/**
 * Prompt Links: create, copy, and revoke `maestro://run/<token>` links.
 *
 * One component, two homes: the Prompt Links window (Opt+Cmd+Shift+L, the
 * palette, the hamburger menu, an AI tab's menu) and the Prompt Links tile in
 * Settings > Encore Features. Both call the `promptLinks:*` IPC channels, which
 * the same main-process service behind `maestro-cli prompt-link` answers.
 *
 * Two things the copy has to keep saying, because both are invisible from the
 * UI and expensive to learn the hard way:
 *
 *  1. The URL is shown ONCE. Maestro stores only a hash of its token, so a lost
 *     URL cannot be recovered, only replaced.
 *  2. A link is a key. Anyone who has it can run its prompt (one-shot links
 *     only once). Calendar events are copied to every attendee.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Copy, Link2, Trash2 } from 'lucide-react';
import type { Theme } from '../../types';
import { MiniBadge } from '../ui/MiniBadge';
import { SegmentedControl } from '../ui/SegmentedControl';
import { notifyToast } from '../../stores/notificationStore';
import { useSessionStore } from '../../stores/sessionStore';
import { safeClipboardWrite } from '../../utils/clipboard';
import { formatRelativeTime } from '../../../shared/formatters';
import { ipcErrorMessage } from '../../../shared/serializeError';
import {
	PROMPT_LINK_EXPIRY_PRESETS,
	PROMPT_LINK_MAX_USES,
	describePromptLinkUses,
	promptLinkStatus,
	validatePromptLinkInput,
	type PromptLinkCreated,
	type PromptLinkOpenMode,
	type PromptLinkPublic,
	type PromptLinkStatus,
} from '../../../shared/promptLinks';

export interface PromptLinksPanelProps {
	theme: Theme;
	/** Agent the create form starts on. */
	initialAgentId?: string;
	/** Prompt the create form starts with (an AI tab's unsent draft). */
	initialPrompt?: string;
}

type UsesMode = 'once' | 'count' | 'unlimited';

const USES_OPTIONS = [
	{ value: 'once', label: 'One-shot', title: 'Runs once, then stops working' },
	{ value: 'count', label: 'Limited', title: 'Runs a set number of times' },
	{ value: 'unlimited', label: 'Unlimited', title: 'Runs every time it is clicked' },
] as const satisfies ReadonlyArray<{ value: UsesMode; label: string; title: string }>;

const OPEN_OPTIONS = [
	{
		value: 'background',
		label: 'Background',
		title: 'Your view stays where it is; a toast reports the run',
	},
	{
		value: 'foreground',
		label: 'Foreground',
		title: 'Maestro comes forward on the new tab',
	},
] as const satisfies ReadonlyArray<{ value: PromptLinkOpenMode; label: string; title: string }>;

interface AgentOption {
	id: string;
	name: string;
}

/** The message a rejected IPC call should show, without the `Error:` wrapper. */
function errorText(err: unknown): string {
	return ipcErrorMessage(err, String(err));
}

function firstLine(text: string, max = 90): string {
	const line = text.trim().split('\n')[0] ?? '';
	return line.length > max ? `${line.slice(0, max - 3)}...` : line;
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

function parseAgentKey(key: string): AgentOption[] {
	if (!key) return [];
	return key
		.split('\u0001')
		.map((pair) => {
			const [id, name] = pair.split('\u0000');
			return { id, name };
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

export function PromptLinksPanel({ theme, initialAgentId, initialPrompt }: PromptLinksPanelProps) {
	const agentKey = useSessionStore(selectAgentKey);
	const agents = useMemo(() => parseAgentKey(agentKey), [agentKey]);
	const agentNames = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents]);

	const [links, setLinks] = useState<PromptLinkPublic[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [showInactive, setShowInactive] = useState(false);

	// Create form.
	const [agentId, setAgentId] = useState(initialAgentId ?? '');
	const [prompt, setPrompt] = useState(initialPrompt ?? '');
	const [label, setLabel] = useState('');
	const [usesMode, setUsesMode] = useState<UsesMode>('once');
	const [usesCount, setUsesCount] = useState('5');
	const [expiryId, setExpiryId] = useState('never');
	const [open, setOpen] = useState<PromptLinkOpenMode>('background');
	const [creating, setCreating] = useState(false);
	const [createError, setCreateError] = useState<string | null>(null);
	const [created, setCreated] = useState<PromptLinkCreated | null>(null);
	const [copied, setCopied] = useState(false);

	// One row at a time may await a revoke confirmation.
	const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
	const [rowBusyId, setRowBusyId] = useState<string | null>(null);

	// Fall back to the first agent when the prefill names none (or one that is gone).
	useEffect(() => {
		if (agents.length === 0) return;
		if (!agentId || !agentNames.has(agentId)) setAgentId(agents[0].id);
	}, [agents, agentNames, agentId]);

	const refresh = useCallback(async () => {
		try {
			setLinks(await window.maestro.promptLinks.list());
			setLoadError(null);
		} catch (err) {
			setLinks([]);
			setLoadError(errorText(err));
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const createLink = useCallback(async () => {
		const maxUses =
			usesMode === 'once' ? 1 : usesMode === 'unlimited' ? null : Number(usesCount.trim());
		const preset = PROMPT_LINK_EXPIRY_PRESETS.find((p) => p.id === expiryId);
		const now = Date.now();
		const input = {
			agentId,
			prompt,
			maxUses,
			open,
			...(label.trim() ? { label: label.trim() } : {}),
			...(preset?.ms ? { expiresAt: now + preset.ms } : {}),
		};
		// Validate locally first so the common mistakes answer instantly and in
		// the same words the store would have used.
		const problem = validatePromptLinkInput(input, now);
		if (problem) {
			setCreateError(problem);
			return;
		}
		setCreating(true);
		try {
			const result = await window.maestro.promptLinks.create(input);
			setCreated(result);
			setCopied(false);
			setCreateError(null);
			setPrompt('');
			setLabel('');
			await refresh();
		} catch (err) {
			setCreateError(errorText(err));
		} finally {
			setCreating(false);
		}
	}, [agentId, prompt, label, usesMode, usesCount, expiryId, open, refresh]);

	const copyCreatedUrl = useCallback(async () => {
		if (!created) return;
		const ok = await safeClipboardWrite(created.url);
		setCopied(ok);
		if (!ok) {
			notifyToast({
				color: 'red',
				title: 'Prompt Links',
				message: 'Could not copy the link. Select it and copy it by hand.',
			});
		}
	}, [created]);

	const revoke = useCallback(
		async (link: PromptLinkPublic) => {
			setRowBusyId(link.id);
			try {
				await window.maestro.promptLinks.revoke(link.id);
				setConfirmRevokeId(null);
				await refresh();
				notifyToast({
					color: 'green',
					title: 'Prompt Links',
					message: `Revoked ${link.label ? `"${link.label}"` : 'the link'}. It can never run again.`,
				});
			} catch (err) {
				notifyToast({ color: 'red', title: 'Prompt Links', message: errorText(err) });
			} finally {
				setRowBusyId(null);
			}
		},
		[refresh]
	);

	const now = Date.now();
	const visibleLinks = (links ?? []).filter(
		(l) => showInactive || promptLinkStatus(l, now) === 'active'
	);
	const inactiveCount =
		(links ?? []).length -
		(links ?? []).filter((l) => promptLinkStatus(l, now) === 'active').length;

	const statusColor = (status: PromptLinkStatus): string =>
		status === 'active'
			? theme.colors.success
			: status === 'revoked'
				? theme.colors.error
				: status === 'expired'
					? theme.colors.warning
					: theme.colors.textDim;

	const inputStyle = {
		backgroundColor: theme.colors.bgActivity,
		borderColor: theme.colors.border,
		color: theme.colors.textMain,
	};
	const inputClass =
		'w-full px-2 py-1.5 rounded-lg border text-xs outline-none focus:border-current';
	const sectionTitle = 'text-xs font-bold uppercase opacity-70';
	const fieldLabel = 'text-2xs uppercase tracking-wide opacity-70 mb-1';

	return (
		<div data-testid="prompt-links-panel" className="select-text">
			<div
				className="flex items-start gap-1.5 text-xs mb-4"
				data-testid="prompt-links-warning"
				style={{ color: theme.colors.warning }}
			>
				<AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
				<span>
					A prompt link is a key: anyone who has it can run its prompt on this computer. A link in a
					calendar event is copied to every attendee. Keep one-shot as the default, and revoke a
					link you no longer need.
				</span>
			</div>

			{/* ---------------- Create ---------------- */}
			<div className={sectionTitle} style={{ color: theme.colors.textMain }}>
				New link
			</div>
			<div className="flex flex-col gap-2.5 mt-2">
				<div>
					<div className={fieldLabel} style={{ color: theme.colors.textMain }}>
						Agent
					</div>
					{agents.length === 0 ? (
						<p className="text-xs opacity-70">Create an AI agent first: a link runs in one.</p>
					) : (
						<select
							data-testid="prompt-link-agent"
							aria-label="Agent"
							value={agentId}
							onChange={(e) => setAgentId(e.target.value)}
							className={inputClass}
							style={inputStyle}
						>
							{agents.map((a) => (
								<option key={a.id} value={a.id}>
									{a.name}
								</option>
							))}
						</select>
					)}
				</div>

				<div>
					<div className={fieldLabel} style={{ color: theme.colors.textMain }}>
						Prompt
					</div>
					<textarea
						data-testid="prompt-link-prompt"
						aria-label="Prompt"
						placeholder="What the agent should do when the link is clicked"
						value={prompt}
						onChange={(e) => setPrompt(e.target.value)}
						rows={4}
						className={`${inputClass} resize-y font-mono`}
						style={inputStyle}
					/>
				</div>

				<div>
					<div className={fieldLabel} style={{ color: theme.colors.textMain }}>
						Label (optional)
					</div>
					<input
						type="text"
						data-testid="prompt-link-label"
						aria-label="Label"
						placeholder="Shown in this list and in the toast when it runs"
						value={label}
						onChange={(e) => setLabel(e.target.value)}
						className={inputClass}
						style={inputStyle}
					/>
				</div>

				<div className="flex flex-wrap items-end gap-4">
					<div>
						<div className={fieldLabel} style={{ color: theme.colors.textMain }}>
							Uses
						</div>
						<div className="flex items-center gap-2">
							<SegmentedControl
								value={usesMode}
								onChange={setUsesMode}
								options={USES_OPTIONS}
								theme={theme}
								ariaLabel="How many times the link may run"
								testId="prompt-link-uses"
							/>
							{usesMode === 'count' && (
								<input
									type="number"
									min={1}
									max={PROMPT_LINK_MAX_USES}
									data-testid="prompt-link-uses-count-input"
									aria-label="Number of uses"
									value={usesCount}
									onChange={(e) => setUsesCount(e.target.value)}
									className="w-20 px-2 py-1 rounded-lg border text-xs outline-none"
									style={inputStyle}
								/>
							)}
						</div>
					</div>

					<div>
						<div className={fieldLabel} style={{ color: theme.colors.textMain }}>
							Expires
						</div>
						<select
							data-testid="prompt-link-expiry"
							aria-label="Expires"
							value={expiryId}
							onChange={(e) => setExpiryId(e.target.value)}
							className="px-2 py-1 rounded-lg border text-xs outline-none"
							style={inputStyle}
						>
							{PROMPT_LINK_EXPIRY_PRESETS.map((p) => (
								<option key={p.id} value={p.id}>
									{p.label}
								</option>
							))}
						</select>
					</div>

					<div>
						<div className={fieldLabel} style={{ color: theme.colors.textMain }}>
							Opens in
						</div>
						<SegmentedControl
							value={open}
							onChange={setOpen}
							options={OPEN_OPTIONS}
							theme={theme}
							ariaLabel="Where the tab opens when the link runs"
							testId="prompt-link-open"
						/>
					</div>
				</div>

				{createError && (
					<p
						className="text-xs"
						data-testid="prompt-link-create-error"
						style={{ color: theme.colors.error }}
					>
						{createError}
					</p>
				)}

				<div>
					<button
						type="button"
						data-testid="prompt-link-create"
						disabled={creating || agents.length === 0}
						onClick={() => void createLink()}
						className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
						style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}
					>
						<Link2 className="w-3.5 h-3.5" /> Create link
					</button>
				</div>

				{created && (
					<div
						data-testid="prompt-link-created"
						className="rounded-lg border p-3 flex flex-col gap-2"
						style={{ borderColor: theme.colors.success }}
					>
						<div className="text-xs font-medium" style={{ color: theme.colors.success }}>
							Link created ({describePromptLinkUses(created.link)}). Copy it now: Maestro keeps only
							a hash, so this URL cannot be shown again.
						</div>
						<div className="flex items-center gap-2">
							<input
								type="text"
								readOnly
								data-testid="prompt-link-created-url"
								aria-label="New prompt link URL"
								value={created.url}
								onFocus={(e) => e.currentTarget.select()}
								className={`${inputClass} font-mono`}
								style={inputStyle}
							/>
							<button
								type="button"
								data-testid="prompt-link-copy"
								onClick={() => void copyCreatedUrl()}
								className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-xs flex-shrink-0 transition-colors hover:bg-white/5"
								style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
							>
								{copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
								{copied ? 'Copied' : 'Copy'}
							</button>
						</div>
					</div>
				)}
			</div>

			{/* ---------------- Existing links ---------------- */}
			<div className="flex items-center justify-between mt-6">
				<div className={sectionTitle} style={{ color: theme.colors.textMain }}>
					{showInactive ? 'All links' : 'Active links'}
				</div>
				{inactiveCount > 0 && (
					<button
						type="button"
						data-testid="prompt-links-toggle-inactive"
						onClick={() => setShowInactive((v) => !v)}
						className="text-2xs underline opacity-70 hover:opacity-100"
						style={{ color: theme.colors.textMain }}
					>
						{showInactive ? 'Hide used, expired, and revoked' : `Show ${inactiveCount} inactive`}
					</button>
				)}
			</div>

			{loadError && (
				<p
					className="text-xs mt-1"
					data-testid="prompt-links-load-error"
					style={{ color: theme.colors.error }}
				>
					{loadError}
				</p>
			)}

			{links === null ? (
				<p className="text-xs opacity-70 mt-1">Loading links...</p>
			) : visibleLinks.length === 0 ? (
				<p className="text-xs opacity-70 mt-1" data-testid="prompt-links-empty">
					{links.length === 0 ? 'No prompt links yet.' : 'No active prompt links.'}
				</p>
			) : (
				<div
					className="flex flex-col gap-1 mt-2 rounded-lg border p-1.5"
					style={{ borderColor: theme.colors.border }}
				>
					{visibleLinks.map((link) => {
						const status = promptLinkStatus(link, now);
						const busy = rowBusyId === link.id;
						const agentName = agentNames.get(link.agentId) ?? 'a deleted agent';
						const expiry =
							link.expiresAt === undefined
								? 'never expires'
								: status === 'expired'
									? `expired ${formatRelativeTime(link.expiresAt)}`
									: `expires ${new Date(link.expiresAt).toLocaleDateString()}`;
						return (
							<div
								key={link.id}
								data-testid="prompt-link-row"
								data-link-id={link.id}
								className="rounded px-2 py-1.5"
							>
								<div className="flex items-center gap-2">
									<div className="min-w-0 flex-1">
										<div
											className="text-xs font-medium truncate flex items-center gap-1.5"
											style={{ color: theme.colors.textMain }}
											title={link.prompt}
										>
											<span className="truncate">{link.label ?? firstLine(link.prompt)}</span>
											<MiniBadge
												label={status}
												theme={theme}
												color={statusColor(status)}
												testId="prompt-link-status"
											/>
										</div>
										<div className="text-2xs truncate opacity-70">
											{agentName} · {link.open} · {describePromptLinkUses(link)} · {expiry}
											{link.lastUsedAt ? ` · last run ${formatRelativeTime(link.lastUsedAt)}` : ''}
										</div>
									</div>
									{status !== 'revoked' &&
										(confirmRevokeId === link.id ? (
											<div className="flex items-center gap-1 flex-shrink-0">
												<button
													type="button"
													data-testid="prompt-link-revoke-confirm"
													disabled={busy}
													onClick={() => void revoke(link)}
													className="flex items-center gap-1 px-2 py-1 rounded text-2xs font-medium transition-colors disabled:opacity-50"
													style={{
														backgroundColor: theme.colors.error,
														color: theme.colors.bgMain,
													}}
												>
													<Trash2 className="w-3 h-3" /> Confirm revoke
												</button>
												<button
													type="button"
													data-testid="prompt-link-revoke-cancel"
													onClick={() => setConfirmRevokeId(null)}
													className="px-2 py-1 rounded border text-2xs transition-colors hover:bg-white/5"
													style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
												>
													Cancel
												</button>
											</div>
										) : (
											<button
												type="button"
												data-testid="prompt-link-revoke"
												disabled={busy}
												onClick={() => setConfirmRevokeId(link.id)}
												className="flex items-center gap-1 px-2 py-1 rounded border text-2xs flex-shrink-0 transition-colors hover:bg-white/5 disabled:opacity-50"
												style={{ borderColor: theme.colors.border, color: theme.colors.error }}
											>
												<Trash2 className="w-3 h-3" /> Revoke
											</button>
										))}
								</div>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}
