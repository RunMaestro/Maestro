import React, {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
} from 'react';
import type { Theme } from '../../types';
import type { BrowserTab } from '../../../shared/browserPage';
import type { BrowserTabViewHandle } from './BrowserTabView';
import type {
	BrowserRelayAction,
	BrowserRelayFrame,
	BrowserRelayInput,
	BrowserRelayViewport,
} from '../../../shared/browserRelay';
import { useSessionStore } from '../../stores/sessionStore';
import { resolveBrowserTabNavigationTarget } from '../../utils/browserTabPersistence';
import { safeClipboardWrite } from '../../utils/clipboard';

interface RemoteBrowserTabViewProps {
	tab: BrowserTab;
	theme: Theme;
	onUpdateTab: (tabId: string, updates: Partial<BrowserTab>) => void;
	isActive?: boolean;
}

/** Pixels and input only. No iframe/webview on the client ever loads the workload URL. */
export const RemoteBrowserTabView = forwardRef<BrowserTabViewHandle, RemoteBrowserTabViewProps>(
	function RemoteBrowserTabView({ tab, theme, onUpdateTab, isActive = true }, ref) {
		const surface = useRef<HTMLDivElement>(null);
		const keyboardInput = useRef<HTMLTextAreaElement>(null);
		const lease = useRef<string | null>(null);
		const viewport = useRef<BrowserRelayViewport>({ width: 1024, height: 768 });
		const queue = useRef<Promise<unknown>>(Promise.resolve());
		const queued = useRef(0);
		const alive = useRef(false);
		const frameRef = useRef<BrowserRelayFrame | null>(null);
		const updateRef = useRef(onUpdateTab);
		updateRef.current = onUpdateTab;
		const [frame, setFrame] = useState<BrowserRelayFrame | null>(null);
		const [error, setError] = useState<string | null>(null);
		const [bridgeConnected, setBridgeConnected] = useState(true);
		useEffect(() => {
			const listener = (event: Event) => {
				const state = (event as CustomEvent<{ state: string }>).detail.state;
				setBridgeConnected(state === 'connected');
				if (state !== 'connected') setError('Host browser disconnected; input was not replayed');
			};
			window.addEventListener('maestro:bridge-state', listener);
			return () => window.removeEventListener('maestro:bridge-state', listener);
		}, []);
		const [address, setAddress] = useState(tab.url);
		const addressFocused = useRef(false);
		const [findOpen, setFindOpen] = useState(false);
		const [find, setFind] = useState('');
		const [clearArmed, setClearArmed] = useState(false);
		const clearTimer = useRef<number>();

		const enqueue = useCallback(<T,>(operation: (id: string) => Promise<T>): Promise<T> => {
			if (!lease.current || !alive.current)
				return Promise.reject(new Error('Remote browser is not connected'));
			if (queued.current >= 128)
				return Promise.reject(new Error('Remote browser input is waiting for the host'));
			const id = lease.current;
			queued.current++;
			const result = queue.current.then(() => {
				if (!alive.current || lease.current !== id)
					throw new Error('Remote browser connection changed');
				return operation(id);
			});
			queue.current = result
				.catch((err: unknown) => {
					if (alive.current) setError(err instanceof Error ? err.message : String(err));
				})
				.finally(() => {
					queued.current--;
				});
			return result;
		}, []);
		const action = useCallback(
			(value: BrowserRelayAction) =>
				enqueue((id) => window.maestro.browserSession.relayAction(id, value)),
			[enqueue]
		);
		const send = useCallback(
			(input: BrowserRelayInput) => {
				void enqueue((id) => window.maestro.browserSession.relayInput(id, input)).catch(() => {});
			},
			[enqueue]
		);
		const navigate = useCallback(
			(url: string) => {
				const target = resolveBrowserTabNavigationTarget(url);
				if (target.kind === 'error') throw new Error(target.message);
				setAddress(target.url);
				void action({ kind: 'navigate', url: target.url }).catch(() => {});
				return target.url;
			},
			[action]
		);

		useImperativeHandle(
			ref,
			() => ({
				getTabId: () => tab.id,
				getMeta: () => ({
					url: frameRef.current?.url ?? tab.url,
					title: frameRef.current?.title ?? tab.title,
				}),
				getContent: async () => String(await action({ kind: 'extract', format: 'text' })),
				extract: async (format) => String(await action({ kind: 'extract', format })),
				executeJavaScript: (code) => action({ kind: 'eval', code }),
				capturePage: async () => {
					const image = await enqueue((id) =>
						window.maestro.browserSession.relayFrame(id, viewport.current)
					);
					return image.dataUrl;
				},
				navigate,
				goBack: () => {
					void action({ kind: 'back' }).catch(() => {});
				},
				goForward: () => {
					void action({ kind: 'forward' }).catch(() => {});
				},
				reload: () => {
					void action({ kind: 'reload' }).catch(() => {});
				},
				stop: () => {
					void action({ kind: 'stop' }).catch(() => {});
				},
				openFind: () => setFindOpen(true),
				focusWebview: () => keyboardInput.current?.focus(),
			}),
			[action, enqueue, navigate, tab.id, tab.title, tab.url]
		);

		useEffect(() => {
			if (!isActive || !bridgeConnected) return;
			const host = surface.current;
			if (!host) return;
			alive.current = true;
			setError(null);
			let stopped = false;
			let timer: number | undefined;
			let id: string | undefined;
			const measure = () => {
				const rect = host.getBoundingClientRect();
				viewport.current = {
					width: Math.min(2560, Math.max(1, Math.round(rect.width))),
					height: Math.min(1600, Math.max(1, Math.round(rect.height))),
				};
			};
			measure();
			const observer = new ResizeObserver(measure);
			observer.observe(host);
			const preventLocalScroll = (event: WheelEvent) => event.preventDefault();
			host.addEventListener('wheel', preventLocalScroll, { passive: false });
			const api = window.maestro.browserSession;
			const pump = async () => {
				if (stopped || !id) return;
				let delay = 125;
				try {
					const next = await enqueue((current) => api.relayFrame(current, viewport.current));
					if (stopped) return;
					const image = new Image();
					image.src = next.dataUrl;
					await image.decode();
					if (stopped) return;
					frameRef.current = next;
					setFrame(next);
					setError(null);
					if (!addressFocused.current) setAddress(next.url);
					// Host owns metadata persistence. A frame is presentation, not a session write.
				} catch (err) {
					delay = 1000;
					if (!stopped) setError(err instanceof Error ? err.message : String(err));
				} finally {
					if (!stopped)
						timer = window.setTimeout(() => {
							void pump();
						}, delay);
				}
			};
			const session = useSessionStore
				.getState()
				.sessions.find((s) => s.browserTabs?.some((t) => t.id === tab.id));
			void (async () => {
				try {
					if (!session) throw new Error('Browser tab host session is unavailable');
					id = await api.relayOpen({ sessionId: session.id, tabId: tab.id }, viewport.current);
					if (stopped) {
						await api.relayClose(id);
						return;
					}
					lease.current = id;
					await pump();
				} catch (err) {
					if (!stopped) setError(err instanceof Error ? err.message : String(err));
				}
			})();
			return () => {
				stopped = true;
				alive.current = false;
				lease.current = null;
				observer.disconnect();
				if (timer) window.clearTimeout(timer);
				host.removeEventListener('wheel', preventLocalScroll);
				if (id) void api.relayClose(id).catch(() => {});
			};
		}, [tab.id, isActive, bridgeConnected, enqueue]);

		useEffect(() => {
			if (!addressFocused.current) setAddress(tab.url);
		}, [tab.url]);
		useEffect(
			() => () => {
				if (clearTimer.current) window.clearTimeout(clearTimer.current);
			},
			[]
		);
		const point = (event: React.PointerEvent | React.WheelEvent) => {
			const rect = surface.current!.getBoundingClientRect();
			const dimensions = frameRef.current ?? viewport.current;
			return {
				x: Math.min(
					dimensions.width - 1,
					Math.max(0, Math.round(((event.clientX - rect.left) * dimensions.width) / rect.width))
				),
				y: Math.min(
					dimensions.height - 1,
					Math.max(0, Math.round(((event.clientY - rect.top) * dimensions.height) / rect.height))
				),
			};
		};
		const modifiers = (event: React.KeyboardEvent | React.PointerEvent | React.WheelEvent) =>
			[
				event.shiftKey ? 'shift' : '',
				event.ctrlKey ? 'control' : '',
				event.altKey ? 'alt' : '',
				event.metaKey ? 'meta' : '',
			].filter(Boolean);
		const pointer = (event: React.PointerEvent, type: 'mouseDown' | 'mouseUp' | 'mouseMove') => {
			event.preventDefault();
			event.stopPropagation();
			if (type === 'mouseDown') {
				keyboardInput.current?.focus();
				event.currentTarget.setPointerCapture(event.pointerId);
			}
			send({
				type,
				...point(event),
				button: event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left',
				buttons: event.buttons,
				clickCount: Math.min(3, Math.max(1, event.detail)),
				modifiers: modifiers(event),
			});
		};
		const key = (event: React.KeyboardEvent, type: 'keyDown' | 'keyUp') => {
			if (event.defaultPrevented || event.nativeEvent.isComposing) return;
			if (
				(event.ctrlKey || event.metaKey) &&
				!event.altKey &&
				['c', 'x'].includes(event.key.toLowerCase())
			) {
				event.preventDefault();
				event.stopPropagation();
				if (type === 'keyDown')
					void enqueue(async (id) => {
						const api = window.maestro.browserSession;
						const selected = await api.relayAction(id, { kind: 'selection' });
						if (typeof selected !== 'string')
							throw new Error('Host browser returned an invalid selection');
						if (!selected) return;
						if (!(await safeClipboardWrite(selected)))
							throw new Error('Could not copy to the client clipboard');
						if (event.key.toLowerCase() === 'x')
							await api.relayAction(id, { kind: 'deleteSelection' });
					}).catch(() => {});
				return;
			}
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') {
				event.stopPropagation();
				return;
			}
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
				event.preventDefault();
				event.stopPropagation();
				setFindOpen(true);
				return;
			}
			// Application shortcuts belong to this client, never the owning host window.
			if (
				(event.metaKey || event.ctrlKey || event.altKey) &&
				!['Meta', 'Control', 'Alt', 'Shift'].includes(event.key) &&
				!(!event.altKey && 'acvxz'.includes(event.key.toLowerCase()))
			)
				return;
			event.preventDefault();
			event.stopPropagation();
			const keyCode = event.key;
			send({ type, keyCode, modifiers: modifiers(event) });
			if (
				type === 'keyDown' &&
				event.key.length === 1 &&
				!event.ctrlKey &&
				!event.metaKey &&
				!event.altKey &&
				!event.nativeEvent.isComposing
			)
				send({ type: 'char', keyCode: event.key, modifiers: modifiers(event) });
		};

		return (
			<div
				className="flex-1 min-h-0 flex flex-col"
				data-testid="browser-tab-view"
				style={{ color: theme.colors.textMain, backgroundColor: theme.colors.bgMain }}
			>
				<div
					className="flex items-center gap-2 px-3 py-2 border-b"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
				>
					<button
						title="Back"
						disabled={!frame?.canGoBack}
						onClick={() => {
							void action({ kind: 'back' }).catch(() => {});
						}}
					>
						←
					</button>
					<button
						title="Forward"
						disabled={!frame?.canGoForward}
						onClick={() => {
							void action({ kind: 'forward' }).catch(() => {});
						}}
					>
						→
					</button>
					<button
						title={frame?.isLoading ? 'Stop' : 'Reload'}
						onClick={() => {
							void action({ kind: frame?.isLoading ? 'stop' : 'reload' }).catch(() => {});
						}}
					>
						↻
					</button>
					<form
						className="flex-1 min-w-0"
						onSubmit={(event) => {
							event.preventDefault();
							try {
								navigate(address);
							} catch (err) {
								setError(err instanceof Error ? err.message : String(err));
							}
						}}
					>
						<input
							className="w-full bg-transparent border rounded px-2 py-1"
							aria-label="Browser URL"
							value={address}
							onChange={(event) => setAddress(event.target.value)}
							onFocus={(event) => {
								addressFocused.current = true;
								event.target.select();
							}}
							onBlur={() => {
								addressFocused.current = false;
							}}
						/>
					</form>
					<button title="Find in page" onClick={() => setFindOpen(!findOpen)}>
						Find
					</button>
					<button
						title="Open in host external browser"
						onClick={() => {
							void window.maestro.shell.openExternal(frame?.url ?? tab.url);
						}}
					>
						External
					</button>
					<button
						title={
							tab.hiddenFromAgent ? 'Expose to coworking agents' : 'Hide from coworking agents'
						}
						aria-pressed={tab.hiddenFromAgent === true}
						onClick={() => updateRef.current(tab.id, { hiddenFromAgent: !tab.hiddenFromAgent })}
					>
						{tab.hiddenFromAgent ? 'Hidden' : 'Visible'}
					</button>
					<button
						title="Clear host browsing data (click twice)"
						onClick={() => {
							if (!clearArmed) {
								setClearArmed(true);
								clearTimer.current = window.setTimeout(() => setClearArmed(false), 4000);
								return;
							}
							setClearArmed(false);
							if (clearTimer.current) window.clearTimeout(clearTimer.current);
							void action({ kind: 'clearData' })
								.then(() => action({ kind: 'reload' }))
								.catch(() => {});
						}}
					>
						{clearArmed ? 'Confirm clear' : 'Clear'}
					</button>
				</div>
				{error && (
					<div role="alert" className="px-3 py-2 text-sm" style={{ color: theme.colors.error }}>
						{error}
					</div>
				)}
				{findOpen && (
					<form
						className="flex gap-2 px-3 py-1"
						onSubmit={(event) => {
							event.preventDefault();
							void action({ kind: 'find', text: find, findNext: true }).catch(() => {});
						}}
					>
						<input
							autoFocus
							aria-label="Find in page"
							value={find}
							className="bg-transparent border rounded px-2"
							onChange={(event) => {
								setFind(event.target.value);
								void action({ kind: 'find', text: event.target.value }).catch(() => {});
							}}
						/>
						<button
							type="button"
							onClick={() => {
								void action({ kind: 'find', text: find, findNext: true, forward: false }).catch(
									() => {}
								);
							}}
						>
							Previous
						</button>
						<button>Next</button>
						<button
							type="button"
							onClick={() => {
								setFindOpen(false);
								void action({ kind: 'find', text: '' }).catch(() => {});
							}}
						>
							Close
						</button>
					</form>
				)}
				<div
					ref={surface}
					tabIndex={0}
					role="application"
					aria-label="Host browser page"
					className="relative flex-1 min-h-0 overflow-hidden outline-none"
					style={{ touchAction: 'none' }}
					onPointerDown={(event) => pointer(event, 'mouseDown')}
					onPointerUp={(event) => pointer(event, 'mouseUp')}
					onPointerMove={(event) => {
						if (queued.current < 2) pointer(event, 'mouseMove');
					}}
					onContextMenu={(event) => event.preventDefault()}
					onKeyDown={(event) => key(event, 'keyDown')}
					onKeyUp={(event) => key(event, 'keyUp')}
					onCompositionEnd={(event) => {
						send({ type: 'text', text: event.data });
						if (keyboardInput.current) keyboardInput.current.value = '';
					}}
					onPaste={(event) => {
						event.preventDefault();
						send({ type: 'text', text: event.clipboardData.getData('text/plain') });
					}}
					onWheel={(event) => {
						event.preventDefault();
						event.stopPropagation();
						const scale =
							event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.current.height : 1;
						send({
							type: 'mouseWheel',
							...point(event),
							deltaX: event.deltaX * scale,
							deltaY: event.deltaY * scale,
							modifiers: modifiers(event),
						});
					}}
				>
					{frame ? (
						<img
							alt="Host browser page"
							src={frame.dataUrl}
							draggable={false}
							className="w-full h-full pointer-events-none"
						/>
					) : (
						<div className="p-4 text-sm">Connecting to the host browser…</div>
					)}
					<textarea
						ref={keyboardInput}
						aria-label="Host browser keyboard input"
						tabIndex={-1}
						className="absolute w-px h-px opacity-0"
						onChange={(event) => {
							if (!(event.nativeEvent as InputEvent).isComposing && event.target.value) {
								send({ type: 'text', text: event.target.value });
								event.target.value = '';
							}
						}}
					/>
				</div>
			</div>
		);
	}
);
