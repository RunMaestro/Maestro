/**
 * AgentRuntimeControls — compact composer affordance for OMP native runtime
 * controls.
 *
 * Deliberately NOT a toolbar row: the composer stays ordinary-Maestro-sized.
 * Live runtime settings collapse into two pills that sit beside the model
 * pill:
 *
 * - a Thinking pill (the one frequently changed setting) opening a true menu
 *   (`role="menu"` of `menuitemradio` levels) with full keyboard support, and
 * - a Runtime pill opening a non-modal popover dialog with grouped form
 *   controls: delivery modes (steering / follow-up / interrupt), automation
 *   toggles (auto-compaction / auto-retry), session actions (new session,
 *   compact, handoff, export…), and a visually separated interrupt group
 *   (abort retry / abort shell).
 *
 * Keyboard contract (both popovers): opening moves focus into the popup,
 * Escape closes and restores focus to the trigger (from the trigger or from
 * inside the popup), and tabbing/clicking outside dismisses. The thinking menu
 * additionally supports ArrowUp/ArrowDown/Home/End roving focus.
 *
 * Model selection is excluded here — it is owned by the ordinary model pill.
 * When the runtime is dormant there are no controls and nothing renders.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Ban, Brain, Settings2 } from 'lucide-react';
import type { AgentControl } from '../../../../shared/agent-runtime-features';
import { isRegisteredOmpControl } from '../../../../shared/omp-command-registry';
import type { Theme } from '../../../types';
import { useClickOutside } from '../../../hooks/ui';

interface AgentRuntimeControlsProps {
	sessionId: string;
	controls: AgentControl[] | null | undefined;
	theme: Theme;
	onSetControl?: (
		sessionId: string,
		controlId: string,
		value: string | boolean
	) => void | Promise<boolean>;
}

const THINKING_CONTROL_ID = 'thinking-level';
/** Interrupt/abort actions — visually separated from ordinary actions. */
const INTERRUPT_ACTION_IDS: Record<string, true> = {
	'abort-retry': true,
	'abort-bash': true,
};

export interface GroupedControls {
	thinking: AgentControl | null;
	delivery: AgentControl[];
	automation: AgentControl[];
	session: AgentControl[];
	interrupt: AgentControl[];
}

export function groupRuntimeControls(controls: AgentControl[] | null | undefined): GroupedControls {
	const grouped: GroupedControls = {
		thinking: null,
		delivery: [],
		automation: [],
		session: [],
		interrupt: [],
	};
	for (const control of controls ?? []) {
		if (!isRegisteredOmpControl(control.id)) continue;
		// The ordinary model pill owns model selection.
		if (control.id === 'model' || control.label.toLowerCase() === 'model') continue;
		if (control.id === THINKING_CONTROL_ID && control.kind === 'select') {
			grouped.thinking = control;
		} else if (control.kind === 'select') {
			grouped.delivery.push(control);
		} else if (control.kind === 'toggle') {
			grouped.automation.push(control);
		} else if (control.kind === 'action') {
			if (INTERRUPT_ACTION_IDS[control.id]) grouped.interrupt.push(control);
			else grouped.session.push(control);
		}
	}
	return grouped;
}

export const AgentRuntimeControls = memo(function AgentRuntimeControls({
	sessionId,
	controls,
	theme,
	onSetControl = (activeSessionId, controlId, value) =>
		window.maestro.process.setAgentControl(activeSessionId, controlId, value),
}: AgentRuntimeControlsProps) {
	const [thinkingOpen, setThinkingOpen] = useState(false);
	const [runtimeOpen, setRuntimeOpen] = useState(false);
	const thinkingRef = useRef<HTMLDivElement>(null);
	const thinkingTriggerRef = useRef<HTMLButtonElement>(null);
	const thinkingMenuRef = useRef<HTMLDivElement>(null);
	const runtimeRef = useRef<HTMLDivElement>(null);
	const runtimeTriggerRef = useRef<HTMLButtonElement>(null);
	const runtimeDialogRef = useRef<HTMLDivElement>(null);

	useClickOutside(thinkingRef, () => setThinkingOpen(false), thinkingOpen);
	useClickOutside(runtimeRef, () => setRuntimeOpen(false), runtimeOpen);

	// Opening a popup moves focus into it — required for keyboard users since
	// neither popup is rendered until open.
	useEffect(() => {
		if (!thinkingOpen) return;
		const items =
			thinkingMenuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
		if (!items?.length) return;
		const selected = Array.from(items).find((item) => item.getAttribute('aria-checked') === 'true');
		(selected ?? items[0]).focus();
	}, [thinkingOpen]);

	useEffect(() => {
		if (!runtimeOpen) return;
		runtimeDialogRef.current
			?.querySelector<HTMLElement>('select, button, input, [tabindex]')
			?.focus();
	}, [runtimeOpen]);

	const closeThinking = useCallback((restoreFocus: boolean) => {
		setThinkingOpen(false);
		if (restoreFocus) thinkingTriggerRef.current?.focus();
	}, []);

	const closeRuntime = useCallback((restoreFocus: boolean) => {
		setRuntimeOpen(false);
		if (restoreFocus) runtimeTriggerRef.current?.focus();
	}, []);

	const setControl = useCallback(
		(controlId: string, value: string | boolean) => {
			void onSetControl(sessionId, controlId, value);
		},
		[onSetControl, sessionId]
	);

	const grouped = groupRuntimeControls(controls);
	const hasMenuContent =
		grouped.delivery.length > 0 ||
		grouped.automation.length > 0 ||
		grouped.session.length > 0 ||
		grouped.interrupt.length > 0;

	if (!grouped.thinking && !hasMenuContent) {
		return null;
	}

	const menuSurface = {
		backgroundColor: theme.colors.bgSidebar,
		borderColor: theme.colors.border,
	};

	const groupCaption = (caption: string) => (
		<div
			className="px-2 pb-0.5 pt-1.5 text-[9px] font-semibold uppercase tracking-wider"
			style={{ color: theme.colors.textDim }}
		>
			{caption}
		</div>
	);

	const onThinkingMenuKeyDown = (event: React.KeyboardEvent) => {
		const menu = thinkingMenuRef.current;
		if (!menu) return;
		const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
		if (!items.length) return;
		const index = items.indexOf(document.activeElement as HTMLButtonElement);
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			items[(index + 1) % items.length].focus();
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			items[(index - 1 + items.length) % items.length].focus();
		} else if (event.key === 'Home') {
			event.preventDefault();
			items[0].focus();
		} else if (event.key === 'End') {
			event.preventDefault();
			items[items.length - 1].focus();
		} else if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			closeThinking(true);
		} else if (event.key === 'Tab') {
			// Tabbing away dismisses the menu; focus continues naturally.
			closeThinking(false);
		}
	};

	/** Dismiss a popup when focus tabs out of it (without stealing focus back). */
	const closeOnFocusOut =
		(container: React.RefObject<HTMLDivElement | null>, close: (restore: boolean) => void) =>
		(event: React.FocusEvent) => {
			const next = event.relatedTarget as Node | null;
			if (next && container.current?.contains(next)) return;
			close(false);
		};

	return (
		<div className="flex min-w-0 items-center gap-1" data-testid="omp-runtime-controls">
			{/* Thinking level pill */}
			{grouped.thinking && (
				<div className="relative" ref={thinkingRef}>
					<button
						ref={thinkingTriggerRef}
						type="button"
						aria-haspopup="menu"
						aria-expanded={thinkingOpen}
						onClick={() => {
							setThinkingOpen((open) => !open);
							setRuntimeOpen(false);
						}}
						onKeyDown={(event) => {
							if (event.key === 'ArrowDown' && !thinkingOpen) {
								event.preventDefault();
								setThinkingOpen(true);
								setRuntimeOpen(false);
							} else if (event.key === 'Escape' && thinkingOpen) {
								event.preventDefault();
								closeThinking(true);
							}
						}}
						className="flex items-center gap-1 rounded-full px-2 py-1 text-[10px] opacity-60 transition-all hover:opacity-100"
						style={{
							backgroundColor: `${theme.colors.warning}10`,
							color: theme.colors.warning,
							border: `1px solid ${theme.colors.warning}25`,
						}}
						title="Thinking level"
					>
						<Brain className="h-3 w-3" aria-hidden="true" />
						<span>
							{typeof grouped.thinking.value === 'string' && grouped.thinking.value
								? grouped.thinking.value
								: 'thinking'}
						</span>
					</button>
					{thinkingOpen && (
						<div
							ref={thinkingMenuRef}
							role="menu"
							aria-label="Thinking level"
							onKeyDown={onThinkingMenuKeyDown}
							onBlur={closeOnFocusOut(thinkingRef, closeThinking)}
							className="absolute bottom-full left-0 z-50 mb-1 max-h-48 overflow-y-auto rounded border shadow-lg scrollbar-thin"
							style={menuSurface}
						>
							{grouped.thinking.options?.map((option) => {
								const selected = grouped.thinking?.value === option.id;
								return (
									<button
										key={option.id}
										type="button"
										role="menuitemradio"
										aria-checked={selected}
										tabIndex={-1}
										onClick={() => {
											setControl(THINKING_CONTROL_ID, option.id);
											closeThinking(true);
										}}
										className="w-full whitespace-nowrap px-3 py-1.5 text-left text-xs transition-colors hover:bg-white/10 focus:bg-white/10 focus:outline-none"
										style={{
											color: selected ? theme.colors.warning : theme.colors.textMain,
											backgroundColor: selected ? 'rgba(255,255,255,0.05)' : undefined,
										}}
									>
										{option.label}
									</button>
								);
							})}
						</div>
					)}
				</div>
			)}

			{/* Runtime settings pill */}
			{hasMenuContent && (
				<div className="relative" ref={runtimeRef}>
					<button
						ref={runtimeTriggerRef}
						type="button"
						aria-haspopup="dialog"
						aria-expanded={runtimeOpen}
						aria-label="OMP runtime settings"
						onClick={() => {
							setRuntimeOpen((open) => !open);
							setThinkingOpen(false);
						}}
						onKeyDown={(event) => {
							if (event.key === 'Escape' && runtimeOpen) {
								event.preventDefault();
								closeRuntime(true);
							}
						}}
						className="flex items-center gap-1 rounded-full px-2 py-1 text-[10px] opacity-60 transition-all hover:opacity-100"
						style={{
							color: theme.colors.textDim,
							border: `1px solid ${theme.colors.border}`,
						}}
						title="OMP runtime settings"
					>
						<Settings2 className="h-3 w-3" aria-hidden="true" />
						<span>Runtime</span>
					</button>
					{runtimeOpen && (
						<div
							ref={runtimeDialogRef}
							role="dialog"
							aria-label="Native runtime controls"
							onKeyDown={(event) => {
								if (event.key === 'Escape') {
									event.preventDefault();
									event.stopPropagation();
									closeRuntime(true);
								}
							}}
							onBlur={closeOnFocusOut(runtimeRef, closeRuntime)}
							className="absolute bottom-full left-0 z-50 mb-1 max-h-80 w-60 overflow-y-auto rounded-md border pb-1.5 shadow-lg scrollbar-thin"
							style={menuSurface}
						>
							{grouped.delivery.length > 0 && (
								<>
									{groupCaption('Delivery')}
									{grouped.delivery.map((control) => (
										<label
											key={control.id}
											className="flex items-center justify-between gap-2 px-2 py-1 text-[11px]"
											style={{ color: theme.colors.textDim }}
										>
											<span className="min-w-0 truncate">{control.label}</span>
											<select
												aria-label={control.label}
												value={typeof control.value === 'string' ? control.value : ''}
												onChange={(event) => setControl(control.id, event.target.value)}
												className="max-w-[120px] rounded border px-1.5 py-0.5 text-[11px] outline-none"
												style={{
													backgroundColor: theme.colors.bgMain,
													borderColor: theme.colors.border,
													color: theme.colors.textMain,
												}}
											>
												{control.options?.map((option) => (
													<option key={option.id} value={option.id}>
														{option.label}
													</option>
												))}
											</select>
										</label>
									))}
								</>
							)}
							{grouped.automation.length > 0 && (
								<>
									{groupCaption('Automation')}
									{grouped.automation.map((control) => {
										const enabled = control.value === true;
										return (
											<button
												key={control.id}
												type="button"
												role="switch"
												aria-checked={enabled}
												onClick={() => setControl(control.id, !enabled)}
												className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-[11px] transition-colors hover:bg-white/5 focus:bg-white/5"
												style={{ color: theme.colors.textMain }}
											>
												<span className="min-w-0 truncate">{control.label}</span>
												<span
													aria-hidden="true"
													className="rounded-full border px-1.5 py-px text-[9px] font-medium"
													style={{
														borderColor: enabled ? `${theme.colors.accent}50` : theme.colors.border,
														backgroundColor: enabled ? `${theme.colors.accent}25` : 'transparent',
														color: enabled ? theme.colors.accent : theme.colors.textDim,
													}}
												>
													{enabled ? 'On' : 'Off'}
												</span>
											</button>
										);
									})}
								</>
							)}
							{grouped.session.length > 0 && (
								<>
									{groupCaption('Session')}
									{grouped.session.map((control) => (
										<button
											key={control.id}
											type="button"
											onClick={() => {
												setControl(control.id, true);
												closeRuntime(true);
											}}
											className="w-full px-2 py-1.5 text-left text-[11px] transition-colors hover:bg-white/5 focus:bg-white/5"
											style={{ color: theme.colors.textMain }}
										>
											{control.label}
										</button>
									))}
								</>
							)}
							{grouped.interrupt.length > 0 && (
								<div
									role="group"
									aria-label="Interrupt actions"
									className="mt-1 border-t pt-0.5"
									style={{ borderColor: theme.colors.border }}
								>
									{grouped.interrupt.map((control) => (
										<button
											key={control.id}
											type="button"
											onClick={() => {
												setControl(control.id, true);
												closeRuntime(true);
											}}
											className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[11px] transition-colors hover:bg-white/5 focus:bg-white/5"
											style={{ color: theme.colors.warning }}
										>
											<Ban className="h-3 w-3 shrink-0" aria-hidden="true" />
											<span>{control.label}</span>
										</button>
									))}
								</div>
							)}
						</div>
					)}
				</div>
			)}
		</div>
	);
});
