import { memo, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
	ExternalLink,
	Hammer,
	HelpCircle,
	ListEnd,
	Navigation,
	Pause,
	type LucideIcon,
} from 'lucide-react';
import type { Theme } from '../../../types';
import { ToggleSwitch } from '../../ui/ToggleSwitch';
import { Keycap } from '../../ui/Keycap';
import { useClickOutside } from '../../../hooks/ui/useClickOutside';
import { useEventListener } from '../../../hooks/utils/useEventListener';
import { useFocusOnMount } from '../../../hooks/utils/useFocusAfterRender';
import { useActiveSession } from '../../../hooks/session/useActiveSession';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useComposerInputStore, selectAiComposerValue } from '../../../stores/composerInputStore';
import { getModalActions } from '../../../stores/modalStore';
import { FORCED_PARALLEL_SEND_EVENT, HOLD_SEND_EVENT } from '../../../hooks/input/useInputKeyDown';
import { requestSteerSend } from '../../../services/chatSteering';
import { openAgentSettings } from '../../../services/agentNavigation';
import { openUrl } from '../../../utils/openUrl';
import { formatShortcutKeys } from '../../../utils/shortcutFormatter';
import {
	buildSendMenuModel,
	CODEX_TRANSPORT_DOCS_URL,
	STEER_DOCS_URL,
	steerFeatureRequestUrl,
	type SendMenuAction,
	type SendMenuRow,
} from '../../../utils/sendMenu';

/** `data-setting-id` of the Forced Parallel Execution toggle in Settings > General. */
const FORCED_PARALLEL_SETTING_ID = 'general-forced-parallel';

const ROW_META: Record<SendMenuAction, { label: string; icon: LucideIcon }> = {
	queue: { label: 'Queue', icon: ListEnd },
	force: { label: 'Force Send', icon: Hammer },
	hold: { label: 'Queue Held', icon: Pause },
	steer: { label: 'Steer', icon: Navigation },
};

interface SendMenuPopoverProps {
	theme: Theme;
	anchorRef: React.RefObject<HTMLElement | null>;
	onClose: () => void;
	/** The plain send: the same call Enter makes. */
	processInput: () => void;
}

/**
 * What a click on Send offers while the agent is working: Queue, Force Send,
 * Steer, or Queue Held. Each row runs the path its chord already runs (the
 * composer listens for the events), so the menu adds no second send path.
 *
 * Dead rows stay visible and say why in one line. Steer carries a `?` that
 * explains how to get steering on this harness, or how to ask for it.
 */
export const SendMenuPopover = memo(function SendMenuPopover({
	theme,
	anchorRef,
	onClose,
	processInput,
}: SendMenuPopoverProps) {
	const popoverRef = useRef<HTMLDivElement>(null);
	const firstRowRef = useRef<HTMLButtonElement>(null);
	const [helpOpen, setHelpOpen] = useState(false);

	const session = useActiveSession();
	const draftText = useComposerInputStore(selectAiComposerValue);
	const forcedParallelEnabled = useSettingsStore((s) => s.forcedParallelExecution);
	const shortcuts = useSettingsStore((s) => s.shortcuts);
	const enterToSendAI = useSettingsStore((s) => s.enterToSendAI);
	const sendButtonMenu = useSettingsStore((s) => s.sendButtonMenu);
	const setSendButtonMenu = useSettingsStore((s) => s.setSendButtonMenu);

	const activeTab = session?.aiTabs?.find((tab) => tab.id === session.activeTabId);
	const imageCount = activeTab?.stagedImages?.length ?? 0;
	const model = useMemo(
		() =>
			session
				? buildSendMenuModel(session, { text: draftText, imageCount }, { forcedParallelEnabled })
				: null,
		[session, draftText, imageCount, forcedParallelEnabled]
	);

	useClickOutside([popoverRef, anchorRef] as React.RefObject<HTMLElement | null>[], onClose, true, {
		delay: true,
	});

	useEventListener(
		'keydown',
		(e) => {
			const ke = e as KeyboardEvent;
			if (ke.key === 'Escape') {
				ke.stopPropagation();
				onClose();
				return;
			}
			if (ke.key !== 'ArrowDown' && ke.key !== 'ArrowUp') return;
			const rows = Array.from(
				popoverRef.current?.querySelectorAll<HTMLButtonElement>('[data-send-menu-row]') ?? []
			);
			if (rows.length === 0) return;
			ke.preventDefault();
			const at = rows.indexOf(document.activeElement as HTMLButtonElement);
			const step = ke.key === 'ArrowDown' ? 1 : -1;
			rows[(at + step + rows.length) % rows.length]?.focus();
		},
		{ target: document }
	);

	useFocusOnMount(firstRowRef, 0);

	const anchorRect = anchorRef.current?.getBoundingClientRect();
	if (!anchorRect || !session || !model) return null;

	const enterToSend = activeTab?.enterToSend ?? enterToSendAI;
	const shortcutFor: Record<SendMenuAction, string[] | undefined> = {
		queue: enterToSend ? ['Enter'] : ['Meta', 'Enter'],
		force: shortcuts.forcedParallelSend?.keys,
		hold: undefined,
		steer: shortcuts.steerSend?.keys,
	};

	const run = (row: SendMenuRow) => {
		if (!row.enabled) {
			if (row.opensSetting) {
				onClose();
				getModalActions().openSettings('general', FORCED_PARALLEL_SETTING_ID);
			}
			return;
		}
		onClose();
		switch (row.action) {
			case 'queue':
				processInput();
				return;
			case 'force':
				window.dispatchEvent(new CustomEvent(FORCED_PARALLEL_SEND_EVENT));
				return;
			case 'hold':
				window.dispatchEvent(new CustomEvent(HOLD_SEND_EVENT));
				return;
			case 'steer':
				requestSteerSend();
				return;
		}
	};

	const support = model.steerSupport;
	const helpText =
		support.kind === 'supported'
			? 'Steer hands this message to the turn already running, so the agent can change course without waiting for the turn to end.'
			: support.detail;
	const docsUrl =
		support.kind === 'fixable' && support.reason === 'codex-exec'
			? CODEX_TRANSPORT_DOCS_URL
			: STEER_DOCS_URL;

	const style: React.CSSProperties = {
		position: 'fixed',
		// Above and to the left of the Send button, bottom edges aligned.
		bottom: window.innerHeight - anchorRect.bottom,
		right: window.innerWidth - anchorRect.left + 8,
		width: 300,
		zIndex: 9999,
		backgroundColor: theme.colors.bgMain,
		borderColor: theme.colors.border,
		color: theme.colors.textMain,
	};

	return createPortal(
		<div
			ref={popoverRef}
			role="menu"
			aria-label="Send options"
			className="rounded-lg border shadow-lg p-1.5 select-none"
			style={style}
			tabIndex={-1}
			data-testid="send-menu-popover"
		>
			<div
				className="flex items-center gap-1.5 px-2 pt-1 pb-1.5 text-2xs uppercase tracking-wider"
				style={{ color: theme.colors.textDim }}
			>
				<span
					className="inline-block w-1.5 h-1.5 rounded-full"
					style={{ backgroundColor: theme.colors.warning }}
				/>
				{model.activeTabWorking ? 'This tab is working' : 'Another tab is working'}
			</div>
			{model.rows.map((row, index) => {
				const { label, icon: Icon } = ROW_META[row.action];
				const keys = shortcutFor[row.action];
				const isDefault = row.action === 'queue';
				const live = row.enabled || row.opensSetting;
				return (
					<div key={row.action}>
						<div
							className={`flex items-start gap-1.5 pr-2 rounded-md transition-colors ${
								live ? 'hover:bg-white/5 focus-within:bg-white/5' : ''
							}`}
							style={{
								backgroundColor: isDefault ? `${theme.colors.accent}26` : undefined,
							}}
						>
							<button
								ref={index === 0 ? firstRowRef : undefined}
								type="button"
								role="menuitem"
								data-send-menu-row={row.action}
								aria-disabled={!row.enabled}
								onClick={() => run(row)}
								className={`flex-1 min-w-0 flex items-start gap-2.5 pl-2 py-1.5 text-left outline-none ${
									live ? 'cursor-pointer' : 'cursor-default'
								}`}
								title={row.reason}
							>
								<Icon
									className="w-3.5 h-3.5 mt-0.5 flex-shrink-0"
									style={{ color: row.enabled ? theme.colors.textMain : theme.colors.textDim }}
								/>
								<span className="flex-1 min-w-0">
									<span
										className="block text-xs"
										style={{
											color: row.enabled ? theme.colors.textMain : theme.colors.textDim,
											opacity: row.enabled ? 1 : 0.6,
										}}
									>
										{label}
									</span>
									{row.reason && (
										<span
											className="block text-xs-plus leading-snug mt-0.5"
											style={{ color: theme.colors.textDim }}
										>
											{row.reason}
										</span>
									)}
								</span>
							</button>
							{/* The ? sits left of the hotkey, outside the row button so it
							    never runs the row. */}
							{row.action === 'steer' && (
								<button
									type="button"
									onClick={() => setHelpOpen((open) => !open)}
									className="mt-1.5 p-0.5 rounded-full flex-shrink-0"
									style={{ color: helpOpen ? theme.colors.accent : theme.colors.textDim }}
									title="How steering works on this agent"
									aria-label="How steering works on this agent"
									aria-expanded={helpOpen}
								>
									<HelpCircle className="w-3.5 h-3.5" />
								</button>
							)}
							{keys && keys.length > 0 && (
								<span
									data-shortcut-hint
									aria-hidden
									className={`flex-shrink-0 mt-1 ${live ? 'cursor-pointer' : 'cursor-default'}`}
									onClick={() => run(row)}
								>
									<Keycap theme={theme} style={{ opacity: row.enabled ? 1 : 0.45 }}>
										{formatShortcutKeys(keys)}
									</Keycap>
								</span>
							)}
						</div>
						{row.action === 'steer' && helpOpen && (
							<div
								className="mx-2 mt-1 mb-1.5 p-2.5 rounded-md border text-xs-plus leading-relaxed select-text"
								style={{
									borderColor: theme.colors.border,
									backgroundColor: theme.colors.bgSidebar,
								}}
								data-testid="steer-help"
							>
								<p style={{ color: theme.colors.textMain }}>{helpText}</p>
								<div className="flex flex-wrap items-center gap-3 mt-2">
									{support.kind === 'fixable' && (
										<button
											type="button"
											onClick={() => {
												onClose();
												openAgentSettings(session);
											}}
											className="px-2 py-0.5 rounded-full border"
											style={{ borderColor: theme.colors.accent, color: theme.colors.accent }}
										>
											Open agent settings
										</button>
									)}
									{support.kind === 'unsupported' && support.reason === 'not-claude' && (
										<button
											type="button"
											onClick={() => openUrl(steerFeatureRequestUrl(session.toolType))}
											className="inline-flex items-center gap-1"
											style={{ color: theme.colors.accent }}
										>
											Open a feature request
											<ExternalLink className="w-3 h-3" />
										</button>
									)}
									<button
										type="button"
										onClick={() => openUrl(docsUrl)}
										className="inline-flex items-center gap-1"
										style={{ color: theme.colors.accent }}
									>
										Docs
										<ExternalLink className="w-3 h-3" />
									</button>
								</div>
							</div>
						)}
					</div>
				);
			})}
			<div className="mt-1.5 pt-2 px-2 pb-1 border-t" style={{ borderColor: theme.colors.border }}>
				<div className="flex items-center justify-between gap-3">
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						Show this menu on click
					</span>
					<ToggleSwitch
						checked={sendButtonMenu}
						onChange={setSendButtonMenu}
						theme={theme}
						ariaLabel="Show this menu on click"
					/>
				</div>
				<p className="text-xs-plus leading-snug mt-1.5" style={{ color: theme.colors.textDim }}>
					{sendButtonMenu
						? 'Off: a click sends at once. Turn it back on in Settings > General, or ask your agent.'
						: 'A click now sends at once. Turn this back on in Settings > General, or ask your agent.'}
				</p>
			</div>
		</div>,
		document.body
	);
});
