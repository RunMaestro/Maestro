import React, {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	memo,
	type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import {
	FileAudio,
	Maximize,
	Pause,
	Play,
	Repeat,
	RotateCcw,
	RotateCw,
	SkipBack,
	SkipForward,
	Volume2,
	VolumeX,
	ExternalLink,
	AlertTriangle,
} from 'lucide-react';

import { GhostIconButton } from '../ui/GhostIconButton';
import { Spinner } from '../ui/Spinner';
import { formatMediaTime } from '../../utils/mediaItems';
import { MEDIA_PLAYBACK_RATES, isMediaStreamUrl, type MediaKind } from '../../../shared/mediaTypes';
import { useSettingsStore } from '../../stores/settingsStore';
import { useEventListener } from '../../hooks/utils/useEventListener';
import { useAnchoredMenuPosition } from '../../hooks/ui/useAnchoredMenuPosition';

interface MediaViewerProps {
	/** Whether to mount an <audio> or a <video> element. */
	kind: MediaKind;
	/** File name, used for the audio placeholder label. */
	name: string;
	/** Absolute path. Re-resolved into a fresh stream URL, and the "open externally" target. */
	path: string;
	/** Start playing as soon as the file is ready. Set for tabs the user just opened. */
	autoplay?: boolean;
	/**
	 * Seconds to resume from, remembered when the widget last navigated away from
	 * this file. Applied once, on load.
	 */
	resumeTime?: number;
	/**
	 * Drop the big stage so the whole player fits a small floating frame: audio
	 * loses its icon block and video keeps only the picture.
	 */
	compact?: boolean;
	/** Report position so the store can resume this file if the user comes back. */
	onTimeUpdate?: (seconds: number) => void;
	/** Mirror play/pause outward, for the floating widget's own state. */
	onPlayingChange?: (playing: boolean) => void;
	/**
	 * The file played to its end. Drives the hand-off to the next queued item.
	 * Not fired while looping, since a looping element never ends.
	 */
	onEnded?: () => void;
	/**
	 * The video's real shape (`videoWidth / videoHeight`), reported once its
	 * metadata loads. The floating frame sizes itself to this, so a 4:3
	 * recording or a vertical phone clip gets a box that fits it rather than
	 * black bars. Never fired for audio.
	 */
	onAspectChange?: (aspect: number) => void;
	/**
	 * How long the file is, once its metadata says. The queue and history lists
	 * show it, and only the loaded file is ever mounted, so this is the only
	 * chance to learn it.
	 */
	onDurationKnown?: (seconds: number) => void;
	/**
	 * Measured height of the transport strip. The floating frame is chrome plus
	 * picture, and this half of the chrome depends on font metrics, so it is
	 * measured here rather than assumed by the frame.
	 */
	onTransportHeightChange?: (height: number) => void;
	/** Widget navigation. Rendered inside the transport when provided. */
	onPrev?: () => void;
	onNext?: () => void;
	/**
	 * Nonce from the playback store. Every increment toggles play/pause, which is
	 * how the floating frame's minimized pill drives the element without holding
	 * a ref across the component boundary.
	 */
	toggleRequest?: number;
	theme: any;
}

/** Seconds jumped by the skip buttons and the plain arrow keys. */
const SKIP_SECONDS = 10;
/** Seconds jumped by shift+arrow, for fine scrubbing. */
const FINE_SKIP_SECONDS = 5;

interface PlaybackRateMenuProps {
	/** The speed button the list hangs above. */
	anchorRef: RefObject<HTMLElement | null>;
	/** Owned by the parent so its outside-click check can see the portaled list. */
	menuRef: RefObject<HTMLDivElement>;
	rate: number;
	onSelect: (rate: number) => void;
	theme: any;
}

/**
 * Playback speed list, portaled to the body.
 *
 * It cannot be an `absolute bottom-full` child of the transport: the floating
 * media widget clips its own overflow, so an in-flow menu is sliced off at the
 * frame edge and the faster rates become unreachable. Portaling plus
 * `useAnchoredMenuPosition` puts it over everything and keeps it on screen.
 */
const PlaybackRateMenu = memo(function PlaybackRateMenu({
	anchorRef,
	menuRef,
	rate,
	onSelect,
	theme,
}: PlaybackRateMenuProps) {
	const { left, top, ready } = useAnchoredMenuPosition(menuRef, anchorRef, {
		placement: 'above',
		align: 'end',
	});

	return createPortal(
		<div
			ref={menuRef}
			data-testid="playback-rate-menu"
			// Above the floating player (60) and its docked frame (5), far below
			// modals (9999) so it can never cover an overlay.
			className="fixed z-[100] py-1 rounded shadow-xl border max-h-64 overflow-y-auto select-none"
			style={{
				left,
				top,
				opacity: ready ? 1 : 0,
				backgroundColor: theme.colors.bgActivity,
				borderColor: theme.colors.border,
			}}
		>
			{MEDIA_PLAYBACK_RATES.map((option) => (
				<button
					key={option}
					onClick={() => onSelect(option)}
					className="block w-full text-left px-3 py-1 text-xs font-mono hover:bg-white/10 transition-colors"
					style={{ color: option === rate ? theme.colors.accent : theme.colors.textMain }}
				>
					{option}x
				</button>
			))}
		</div>,
		document.body
	);
});

/**
 * Audio/video player for the file preview.
 *
 * Wraps a native <audio>/<video> element - Electron ships Chromium with
 * proprietary codecs, so MP3/AAC/H.264 play without any bundled decoder - and
 * puts a themed transport on top of it. Bytes arrive over the
 * `maestro-media://` protocol with range support, so scrubbing a large file
 * does not load it into memory.
 *
 * Playback speed is read from and written back to the global settings store,
 * so the rate the user picks sticks across files and across restarts.
 *
 * This is mounted by MediaPlaybackHost, not by FilePreview - see that file for
 * why the element has to outlive the tab's render tree.
 */
export const MediaViewer = memo(function MediaViewer({
	kind,
	name,
	path,
	autoplay = false,
	resumeTime = 0,
	compact = false,
	onTimeUpdate,
	onPlayingChange,
	onEnded,
	onAspectChange,
	onDurationKnown,
	onTransportHeightChange,
	onPrev,
	onNext,
	toggleRequest = 0,
	theme,
}: MediaViewerProps) {
	const mediaRef = useRef<HTMLMediaElement | null>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const transportRef = useRef<HTMLDivElement>(null);
	const rateButtonRef = useRef<HTMLButtonElement>(null);
	const rateMenuRef = useRef<HTMLDivElement>(null);

	const playbackRate = useSettingsStore((s) => s.mediaPlaybackRate);
	const setPlaybackRate = useSettingsStore((s) => s.setMediaPlaybackRate);

	const [src, setSrc] = useState<string | null>(null);
	// 'missing' and 'error' are deliberately separate: a deleted file and an
	// undecodable one fail the media element identically, and telling the user
	// their codec is unsupported when the file simply is not there sends them
	// hunting for a build problem that does not exist.
	const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error' | 'missing'>('loading');
	const [playing, setPlaying] = useState(false);
	const [currentTime, setCurrentTime] = useState(0);
	const [duration, setDuration] = useState(0);
	const [volume, setVolume] = useState(1);
	const [muted, setMuted] = useState(false);
	const [looping, setLooping] = useState(false);
	const [rateMenuOpen, setRateMenuOpen] = useState(false);

	const isVideo = kind === 'video';
	// Armed per resolved file, consumed once it becomes playable. Keeping this in
	// a ref (rather than reading the prop at play time) is what stops a return
	// visit to the tab from restarting something the user deliberately paused.
	const autoplayPendingRef = useRef(false);
	// Read inside the path effect without making the effect depend on it: the
	// request is only ever relevant at the moment a new file starts loading.
	const autoplayRequestedRef = useRef(autoplay);
	autoplayRequestedRef.current = autoplay;
	// The end-of-file hand-off, kept in a ref so `mediaProps` stays stable.
	const endedRef = useRef(onEnded);
	endedRef.current = onEnded;
	// Same for the shape report: it fires from 'loadedmetadata', and that handler
	// should not be rebuilt every time the parent re-renders.
	const aspectRef = useRef(onAspectChange);
	aspectRef.current = onAspectChange;
	// Same for the resume position: latched when a file starts loading, consumed
	// on 'loadedmetadata', and never re-applied (so a manual seek back to 0 sticks).
	const resumeRef = useRef(resumeTime);
	const resumeRequestedRef = useRef(resumeTime);
	resumeRequestedRef.current = resumeTime;
	// The file this render is for, so an async classification that lands after
	// the tab moved on cannot stamp its verdict on the new file.
	const pathRef = useRef(path);
	pathRef.current = path;

	// Resolve a fresh stream URL rather than trusting the tab's stored content.
	// Stream URLs carry a per-boot capability token, and file preview tabs are
	// persisted verbatim - so a media tab restored from disk holds a URL the
	// protocol handler will (correctly) reject. Re-reading the path mints a URL
	// valid for this boot, which makes restored media tabs just work.
	useEffect(() => {
		let cancelled = false;
		setSrc(null);
		setLoadState('loading');
		setPlaying(false);
		setCurrentTime(0);
		setDuration(0);
		// Re-arm per file, so repurposing this tab onto a new media file plays it.
		autoplayPendingRef.current = autoplayRequestedRef.current;
		resumeRef.current = resumeRequestedRef.current;

		void (async () => {
			try {
				const resolved = await window.maestro.fs.readFile(path);
				if (cancelled) return;
				if (resolved === null) {
					// Deleted or moved: the read handler returns null for a path that
					// is not on disk.
					setLoadState('missing');
					return;
				}
				if (!isMediaStreamUrl(resolved)) {
					// On disk, but not servable as a stream (an SSH remote file, say).
					setLoadState('error');
					return;
				}
				setSrc(resolved);
			} catch {
				if (!cancelled) setLoadState('error');
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [path]);

	// Mirror playback outward so the floating widget and the palette can tell
	// whether anything is audible.
	useEffect(() => {
		onPlayingChange?.(playing);
	}, [playing, onPlayingChange]);

	// Measure the transport for the floating frame's height math. Measured, not
	// assumed: the strip's height comes out of font metrics, so it differs
	// between platforms and any hard-coded number would letterbox video on the
	// ones it was not tuned on. Observed rather than read once, since the row
	// gains buttons (prev/next, fullscreen) depending on the queue and the file.
	useEffect(() => {
		const element = transportRef.current;
		if (!element || !onTransportHeightChange) return;
		const report = () => {
			const height = element.getBoundingClientRect().height;
			if (height > 0) onTransportHeightChange(height);
		};
		report();
		if (typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver(report);
		observer.observe(element);
		return () => observer.disconnect();
	}, [onTransportHeightChange]);

	// Report position continuously rather than only on unmount: React gives no
	// "about to unmount with fresh DOM state" hook, and the element is gone by
	// cleanup time on a fast switch.
	useEffect(() => {
		if (!onTimeUpdate || currentTime <= 0) return;
		onTimeUpdate(currentTime);
	}, [currentTime, onTimeUpdate]);

	// Watches state rather than firing from 'loadedmetadata': some containers
	// only report a real length on a later 'durationchange', and a live stream
	// never reports one at all.
	useEffect(() => {
		if (duration > 0) onDurationKnown?.(duration);
	}, [duration, onDurationKnown]);

	// Apply the persisted rate to the element on mount and on every change. The
	// element resets playbackRate to 1 whenever a new source loads, so this also
	// has to run after 'loadedmetadata'. preservesPitch keeps a 2x podcast
	// listenable instead of chipmunked.
	useEffect(() => {
		const el = mediaRef.current;
		if (!el) return;
		el.preservesPitch = true;
		el.playbackRate = playbackRate;
	}, [playbackRate, loadState, src]);

	const handleLoadedMetadata = useCallback(() => {
		const el = mediaRef.current;
		if (!el) return;
		// Live/unknown-length streams report Infinity; treat them as unseekable.
		setDuration(Number.isFinite(el.duration) ? el.duration : 0);
		el.playbackRate = playbackRate;
		setLoadState('ready');
		// Hand the frame this video's real shape. Audio has no picture, and a
		// video with no intrinsic size yet (audio-only container, broken stream)
		// leaves the frame on its 16:9 assumption rather than collapsing it.
		const video = el as HTMLVideoElement;
		if (video.videoWidth > 0 && video.videoHeight > 0) {
			aspectRef.current?.(video.videoWidth / video.videoHeight);
		}
		// Pick up where the widget left this file. Guarded against a stale position
		// past the end (file replaced on disk since), which would strand playback.
		if (resumeRef.current > 0 && Number.isFinite(el.duration) && resumeRef.current < el.duration) {
			el.currentTime = resumeRef.current;
			setCurrentTime(resumeRef.current);
		}
		resumeRef.current = 0;
		if (autoplayPendingRef.current) {
			autoplayPendingRef.current = false;
			// Local files with no gesture requirement: Electron's default autoplay
			// policy allows this. A rejection (policy change, torn-down element)
			// just leaves the file paused, which the transport already shows.
			void el.play().catch(() => undefined);
		}
	}, [playbackRate]);

	const handleTimeUpdate = useCallback(() => {
		const el = mediaRef.current;
		if (el) setCurrentTime(el.currentTime);
	}, []);

	// The element reports a file deleted mid-playback and a file it cannot decode
	// with the same failure, so ask the disk which one happened before wording the
	// card. Assume unplayable until the stat says otherwise: that keeps the "Open
	// in Default App" escape hatch on screen for the case where it helps.
	const handleMediaError = useCallback(() => {
		setLoadState('error');
		const forPath = path;
		void window.maestro.fs
			.stat(forPath)
			.then((info) => {
				if (!info && pathRef.current === forPath) setLoadState('missing');
			})
			.catch(() => undefined);
	}, [path]);

	const togglePlay = useCallback(() => {
		const el = mediaRef.current;
		if (!el) return;
		if (el.paused) {
			// play() rejects when the element is torn down mid-request (tab switch)
			// or the source failed; the 'error' handler already surfaces that state.
			void el.play().catch(() => undefined);
		} else {
			el.pause();
		}
	}, []);

	// Honor toggle requests from the floating frame. The initial value is skipped
	// so mounting never counts as a request.
	const lastToggleRef = useRef(toggleRequest);
	useEffect(() => {
		if (toggleRequest === lastToggleRef.current) return;
		lastToggleRef.current = toggleRequest;
		togglePlay();
	}, [toggleRequest, togglePlay]);

	const seekBy = useCallback((delta: number) => {
		const el = mediaRef.current;
		if (!el || !Number.isFinite(el.duration)) return;
		el.currentTime = Math.min(el.duration, Math.max(0, el.currentTime + delta));
	}, []);

	const seekTo = useCallback((seconds: number) => {
		const el = mediaRef.current;
		if (!el) return;
		el.currentTime = seconds;
		setCurrentTime(seconds);
	}, []);

	const changeVolume = useCallback((next: number) => {
		const el = mediaRef.current;
		const clamped = Math.min(1, Math.max(0, next));
		setVolume(clamped);
		setMuted(clamped === 0);
		if (el) {
			el.volume = clamped;
			el.muted = clamped === 0;
		}
	}, []);

	const toggleMute = useCallback(() => {
		const el = mediaRef.current;
		setMuted((prev) => {
			const next = !prev;
			if (el) el.muted = next;
			return next;
		});
	}, []);

	const toggleLoop = useCallback(() => {
		const el = mediaRef.current;
		setLooping((prev) => {
			const next = !prev;
			if (el) el.loop = next;
			return next;
		});
	}, []);

	/** Step to the next/previous rate in the preset ladder. */
	const stepRate = useCallback(
		(direction: 1 | -1) => {
			const index = MEDIA_PLAYBACK_RATES.indexOf(
				playbackRate as (typeof MEDIA_PLAYBACK_RATES)[number]
			);
			// An off-ladder rate (set via CLI) falls back to the nearest 1x anchor.
			const from = index === -1 ? MEDIA_PLAYBACK_RATES.indexOf(1) : index;
			const next = Math.min(MEDIA_PLAYBACK_RATES.length - 1, Math.max(0, from + direction));
			setPlaybackRate(MEDIA_PLAYBACK_RATES[next]);
		},
		[playbackRate, setPlaybackRate]
	);

	const enterFullscreen = useCallback(() => {
		const el = mediaRef.current;
		if (el && 'requestFullscreen' in el) void el.requestFullscreen().catch(() => undefined);
	}, []);

	const openExternally = useCallback(() => {
		void window.maestro.shell.openPath(path);
	}, [path]);

	// Close the speed menu on any outside click. Both the button and the portaled
	// list count as inside - the list is no longer a DOM descendant of the button.
	useEventListener(
		'mousedown',
		(e) => {
			const target = e.target as Node;
			if (rateMenuRef.current?.contains(target) || rateButtonRef.current?.contains(target)) return;
			setRateMenuOpen(false);
		},
		{ enabled: rateMenuOpen }
	);

	/**
	 * Transport keyboard shortcuts. Scoped to the player container and stopped
	 * from bubbling so they never collide with the FilePreview shortcuts.
	 */
	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.metaKey || e.ctrlKey || e.altKey) return;
			// Let the range inputs keep their own arrow-key behavior.
			if ((e.target as HTMLElement)?.tagName === 'INPUT') return;

			switch (e.key) {
				case ' ':
				case 'k':
					togglePlay();
					break;
				case 'ArrowLeft':
					seekBy(e.shiftKey ? -FINE_SKIP_SECONDS : -SKIP_SECONDS);
					break;
				case 'ArrowRight':
					seekBy(e.shiftKey ? FINE_SKIP_SECONDS : SKIP_SECONDS);
					break;
				case 'ArrowUp':
					changeVolume(volume + 0.1);
					break;
				case 'ArrowDown':
					changeVolume(volume - 0.1);
					break;
				case 'm':
					toggleMute();
					break;
				case 'l':
					toggleLoop();
					break;
				case ',':
				case '<':
					stepRate(-1);
					break;
				case '.':
				case '>':
					stepRate(1);
					break;
				case 'f':
					if (isVideo) enterFullscreen();
					break;
				default:
					return;
			}
			e.preventDefault();
			e.stopPropagation();
		},
		[
			togglePlay,
			seekBy,
			changeVolume,
			volume,
			toggleMute,
			toggleLoop,
			stepRate,
			isVideo,
			enterFullscreen,
		]
	);

	const mediaProps = useMemo(
		() => ({
			// Omitted until the stream URL resolves; an empty src would make the
			// element fire a spurious 'error' and flip us to the unplayable card.
			...(src ? { src } : {}),
			preload: 'metadata' as const,
			onLoadedMetadata: handleLoadedMetadata,
			onTimeUpdate: handleTimeUpdate,
			onDurationChange: handleTimeUpdate,
			onPlay: () => setPlaying(true),
			onPause: () => setPlaying(false),
			onEnded: () => {
				setPlaying(false);
				// Read through a ref so a caller that re-creates the handler each
				// render cannot re-create every media event handler with it, which
				// would churn the element's props mid-playback.
				endedRef.current?.();
			},
			onError: handleMediaError,
		}),
		[src, handleLoadedMetadata, handleTimeUpdate, handleMediaError]
	);

	const rateLabel = `${playbackRate}x`;
	const seekable = duration > 0;

	if (loadState === 'missing') {
		return (
			<div className="flex flex-col items-center justify-center h-full gap-4 select-none">
				<AlertTriangle className="w-12 h-12" style={{ color: theme.colors.textDim }} />
				<div className="text-center">
					<p className="text-lg font-medium" style={{ color: theme.colors.textMain }}>
						File Not Found
					</p>
					<p className="text-sm mt-1" style={{ color: theme.colors.textDim }}>
						{name} is no longer on disk. It was moved, renamed, or deleted.
					</p>
				</div>
			</div>
		);
	}

	if (loadState === 'error') {
		return (
			<div className="flex flex-col items-center justify-center h-full gap-4 select-none">
				<AlertTriangle className="w-12 h-12" style={{ color: theme.colors.textDim }} />
				<div className="text-center">
					<p className="text-lg font-medium" style={{ color: theme.colors.textMain }}>
						Cannot Play This File
					</p>
					<p className="text-sm mt-1" style={{ color: theme.colors.textDim }}>
						The codec inside this container is not supported.
					</p>
					<button
						onClick={openExternally}
						className="mt-4 px-3 py-1.5 rounded text-sm inline-flex items-center gap-2 transition-colors hover:opacity-90"
						style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
					>
						<ExternalLink className="w-4 h-4" />
						Open in Default App
					</button>
				</div>
			</div>
		);
	}

	return (
		<div
			ref={containerRef}
			className="flex flex-col h-full select-none outline-none"
			tabIndex={0}
			onKeyDown={handleKeyDown}
			onClick={() => containerRef.current?.focus()}
		>
			{/* Stage. Audio in compact mode contributes no height, so the transport
			    alone is the whole widget. */}
			<div
				className={`${compact && !isVideo ? '' : 'flex-1 min-h-0'} flex items-center justify-center relative`}
				style={{ backgroundColor: isVideo ? '#000' : 'transparent' }}
			>
				{isVideo ? (
					<video
						ref={mediaRef as React.RefObject<HTMLVideoElement>}
						{...mediaProps}
						className="max-w-full max-h-full"
						onDoubleClick={enterFullscreen}
					/>
				) : (
					<>
						<audio ref={mediaRef as React.RefObject<HTMLAudioElement>} {...mediaProps} />
						{/* Audio has no picture. Docked, fill the stage with an icon and the
						    filename; floating, the frame's own title bar already names the
						    file, so the stage collapses away entirely. */}
						{!compact && (
							<div className="flex flex-col items-center gap-3">
								<FileAudio className="w-16 h-16" style={{ color: theme.colors.accent }} />
								<span
									className="text-sm max-w-md truncate px-4"
									style={{ color: theme.colors.textDim }}
								>
									{name}
								</span>
							</div>
						)}
					</>
				)}

				{loadState === 'loading' && (
					<div className="absolute inset-0 flex items-center justify-center pointer-events-none">
						<Spinner size={32} color={theme.colors.accent} />
					</div>
				)}
			</div>

			{/* Transport */}
			<div
				ref={transportRef}
				className="shrink-0 border-t px-3 py-2 flex flex-col gap-1.5"
				style={{ borderColor: theme.colors.border }}
			>
				{/* Scrubber */}
				<div className="flex items-center gap-2">
					<span
						className="text-xs-plus font-mono tabular-nums shrink-0"
						style={{ color: theme.colors.textDim }}
					>
						{formatMediaTime(currentTime)}
					</span>
					<input
						type="range"
						min={0}
						max={seekable ? duration : 1}
						step={0.01}
						value={seekable ? Math.min(currentTime, duration) : 0}
						disabled={!seekable}
						onChange={(e) => seekTo(Number(e.target.value))}
						aria-label="Seek"
						className="flex-1 h-1 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
						style={{ accentColor: theme.colors.accent }}
					/>
					<span
						className="text-xs-plus font-mono tabular-nums shrink-0"
						style={{ color: theme.colors.textDim }}
					>
						{formatMediaTime(duration)}
					</span>
				</div>

				{/* Controls */}
				<div className="flex items-center gap-1">
					{onPrev && (
						<GhostIconButton
							onClick={onPrev}
							title="Previous media file"
							ariaLabel="Previous media file"
							color={theme.colors.textDim}
						>
							<SkipBack className="w-4 h-4" />
						</GhostIconButton>
					)}
					<GhostIconButton
						onClick={() => seekBy(-SKIP_SECONDS)}
						title={`Back ${SKIP_SECONDS}s (Left arrow)`}
						ariaLabel={`Back ${SKIP_SECONDS} seconds`}
						color={theme.colors.textDim}
					>
						<RotateCcw className="w-4 h-4" />
					</GhostIconButton>

					<GhostIconButton
						onClick={togglePlay}
						title={playing ? 'Pause (Space)' : 'Play (Space)'}
						ariaLabel={playing ? 'Pause' : 'Play'}
						color={theme.colors.textMain}
						padding="p-1.5"
					>
						{playing ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
					</GhostIconButton>

					<GhostIconButton
						onClick={() => seekBy(SKIP_SECONDS)}
						title={`Forward ${SKIP_SECONDS}s (Right arrow)`}
						ariaLabel={`Forward ${SKIP_SECONDS} seconds`}
						color={theme.colors.textDim}
					>
						<RotateCw className="w-4 h-4" />
					</GhostIconButton>

					{onNext && (
						<GhostIconButton
							onClick={onNext}
							title="Next media file"
							ariaLabel="Next media file"
							color={theme.colors.textDim}
						>
							<SkipForward className="w-4 h-4" />
						</GhostIconButton>
					)}

					<div className="flex items-center gap-1 ml-2">
						<GhostIconButton
							onClick={toggleMute}
							title={muted ? 'Unmute (M)' : 'Mute (M)'}
							ariaLabel={muted ? 'Unmute' : 'Mute'}
							color={theme.colors.textDim}
						>
							{muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
						</GhostIconButton>
						<input
							type="range"
							min={0}
							max={1}
							step={0.01}
							value={muted ? 0 : volume}
							onChange={(e) => changeVolume(Number(e.target.value))}
							aria-label="Volume"
							className="w-20 h-1 cursor-pointer"
							style={{ accentColor: theme.colors.accent }}
						/>
					</div>

					<div className="flex-1" />

					<GhostIconButton
						onClick={toggleLoop}
						title={looping ? 'Looping on (L)' : 'Loop (L)'}
						ariaLabel="Toggle loop"
						color={looping ? theme.colors.accent : theme.colors.textDim}
					>
						<Repeat className="w-4 h-4" />
					</GhostIconButton>

					{/* Speed - persisted globally, so it carries to the next file */}
					<div className="relative">
						<button
							ref={rateButtonRef}
							onClick={() => setRateMenuOpen((o) => !o)}
							title="Playback speed (, and . to step). Persists across files."
							aria-label="Playback speed"
							className="px-2 py-1 rounded text-xs font-mono hover:bg-white/10 transition-colors min-w-[3rem]"
							style={{
								color: playbackRate === 1 ? theme.colors.textDim : theme.colors.accent,
							}}
						>
							{rateLabel}
						</button>
						{rateMenuOpen && (
							<PlaybackRateMenu
								anchorRef={rateButtonRef}
								menuRef={rateMenuRef}
								rate={playbackRate}
								onSelect={(rate) => {
									setPlaybackRate(rate);
									setRateMenuOpen(false);
								}}
								theme={theme}
							/>
						)}
					</div>

					{isVideo && (
						<GhostIconButton
							onClick={enterFullscreen}
							title="Fullscreen (F)"
							ariaLabel="Fullscreen"
							color={theme.colors.textDim}
						>
							<Maximize className="w-4 h-4" />
						</GhostIconButton>
					)}

					<GhostIconButton
						onClick={openExternally}
						title="Open in default app"
						ariaLabel="Open in default app"
						color={theme.colors.textDim}
					>
						<ExternalLink className="w-4 h-4" />
					</GhostIconButton>
				</div>
			</div>
		</div>
	);
});
