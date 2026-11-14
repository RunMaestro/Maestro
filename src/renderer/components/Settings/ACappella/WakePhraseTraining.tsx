/**
 * Teaching the wake word a phrase by saying it.
 *
 * Two pieces. The ROW sits in the Wake word card and answers the only question
 * that card cannot otherwise answer for a phrase of the user's own: is there
 * anything that will fire on it. The DIALOG is the flow that makes one: say the
 * phrase a couple of dozen times, read a short passage, press Train.
 *
 * The dialog is one screen, not a wizard. The three steps are visible together
 * because they are not really sequential: after a first training the useful
 * thing to do is usually to go back and add recordings, and a flow that only
 * runs forward hides that.
 *
 * A take is never something the user has to click for. The microphone stays
 * open and each burst of speech becomes a recording, so the gesture is the one
 * the phrase will be used with: say it, breathe, say it again.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioLines, Check, Mic, Square, Trash2, AlertTriangle, Undo2 } from 'lucide-react';

import {
	WAKE_ENROLLMENT_BACKGROUND_MIN_MS,
	WAKE_ENROLLMENT_BACKGROUND_TARGET_MS,
	WAKE_ENROLLMENT_MIN_CLIPS,
	WAKE_ENROLLMENT_TARGET_CLIPS,
	canTrainWakePhrase,
	describeWakeEnrollmentReport,
	wakeEnrollmentPassage,
	type WakeEnrollmentQuality,
	type WakeTrainingPhase,
} from '../../../../shared/acappella/wake-enrollment';
import type { WakeEngine } from '../../../../shared/acappella/voice-controls';
import { MODAL_PRIORITIES } from '../../../constants/modalPriorities';
import { useModalStore } from '../../../stores/modalStore';
import type { Theme } from '../../../types';
import { Modal } from '../../ui/Modal';
import { ProgressBar } from '../../ui/ProgressBar';
import type { WakeEnrollment } from './useWakeEnrollment';

/** RMS that fills the level meter. Conversational speech at a laptop sits around here. */
const METER_FULL_LEVEL = 0.2;

const QUALITY_LABELS: Record<WakeEnrollmentQuality, string> = {
	strong: 'Stands well apart from other speech',
	fair: 'Usable. Expect to adjust sensitivity',
	weak: 'Too close to other speech',
};

const TRAINING_LABELS: Record<WakeTrainingPhase, string> = {
	listening: 'Listening to your recordings...',
	comparing: 'Comparing them with other speech...',
	saving: 'Saving...',
};

function qualityColor(theme: Theme, quality: WakeEnrollmentQuality): string {
	if (quality === 'strong') return theme.colors.success;
	if (quality === 'fair') return theme.colors.warning;
	return theme.colors.error;
}

// ---------------------------------------------------------------------------
// The row in the Wake word card
// ---------------------------------------------------------------------------

/**
 * The Wake word card's Test run, lent to the dialog so a freshly trained phrase
 * can be tried without closing it. One run, owned by the card: the dialog only
 * gets the button.
 */
export interface WakePhraseTestControl {
	running: boolean;
	/** What the run last heard, or why it would not start. */
	message: string | null;
	toggle: () => void;
}

export interface WakePhraseTrainingRowProps {
	theme: Theme;
	/** Mirror of the A Cappella Encore flag. */
	enabled: boolean;
	phrase: string;
	/** The Detection setting. A trained phrase only runs under `classifier`. */
	engine: WakeEngine;
	enrollment: WakeEnrollment;
	test: WakePhraseTestControl;
}

export function WakePhraseTrainingRow({
	theme,
	enabled,
	phrase,
	engine,
	enrollment,
	test,
}: WakePhraseTrainingRowProps) {
	const [open, setOpen] = useState(false);
	const { status } = enrollment;
	const trimmed = phrase.trim();
	const report = status?.model?.report;

	return (
		<div className="space-y-1" data-testid="wake-phrase-training-row">
			<div className="flex items-center justify-between gap-3">
				<div className="min-w-0">
					<div className="text-xs opacity-70">Your own voice</div>
					<p className="text-xs-plus opacity-55">
						{report
							? `Trained from ${report.clipsUsed} recordings. ${describeWakeEnrollmentReport(report)}`
							: status && status.clips > 0
								? `${status.clips} recording${status.clips === 1 ? '' : 's'} so far, not trained yet.`
								: 'Say the phrase a couple of dozen times and Maestro learns to wake on it. Works for any phrase, and stays on this machine.'}
					</p>
				</div>
				<button
					type="button"
					data-testid="wake-phrase-train-open"
					disabled={!enabled || !trimmed}
					onClick={() => setOpen(true)}
					className="shrink-0 px-2 py-1 rounded border text-xs disabled:opacity-50 flex items-center gap-1.5"
					style={{ borderColor: theme.colors.accent, color: theme.colors.textMain }}
				>
					<AudioLines size={13} />
					{report ? 'Improve' : 'Train'}
				</button>
			</div>
			{report && (
				<p
					className="text-xs-plus"
					data-testid="wake-phrase-quality"
					style={{ color: qualityColor(theme, report.quality) }}
				>
					{QUALITY_LABELS[report.quality]}.
				</p>
			)}
			{open && (
				<WakePhraseTrainingModal
					theme={theme}
					phrase={trimmed}
					engine={engine}
					enrollment={enrollment}
					test={test}
					onClose={() => setOpen(false)}
				/>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------

export interface WakePhraseTrainingModalProps {
	theme: Theme;
	phrase: string;
	engine: WakeEngine;
	enrollment: WakeEnrollment;
	test: WakePhraseTestControl;
	onClose: () => void;
}

export function WakePhraseTrainingModal({
	theme,
	phrase,
	engine,
	enrollment,
	test,
	onClose,
}: WakePhraseTrainingModalProps) {
	const { status, level, notice, training, error } = enrollment;
	const { stop } = enrollment;
	const clips = status?.clips ?? 0;
	const backgroundMs = status?.backgroundMs ?? 0;
	const recording = status?.recording ?? null;
	const busy = training !== null || status?.training === true;
	const report = status?.model?.report ?? null;
	const trainable = status ? canTrainWakePhrase(status) : false;

	// A capture run holds a real microphone, so it ends with the dialog rather
	// than running on behind a closed one. Read through a ref: the cleanup must
	// see whether a run is live NOW, not when the effect was set up.
	const recordingRef = useRef(recording);
	recordingRef.current = recording;
	useEffect(
		() => () => {
			if (recordingRef.current) void stop();
		},
		[stop]
	);

	const confirmRemove = useCallback(() => {
		useModalStore.getState().openModal('confirm', {
			title: 'Delete Wake Phrase Training',
			message: `Delete every recording of "${phrase}" and the model trained from them? This cannot be undone.`,
			destructive: true,
			onConfirm: () => void enrollment.remove(),
		});
	}, [enrollment, phrase]);

	const toggle = (kind: 'phrase' | 'background') =>
		void (recording === kind ? enrollment.stop() : enrollment.record(kind));

	const meter = (
		<ProgressBar
			theme={theme}
			value={Math.min(METER_FULL_LEVEL, level)}
			total={METER_FULL_LEVEL}
			label="Microphone level"
			height={4}
			testId="wake-training-level"
		/>
	);

	return (
		<Modal
			theme={theme}
			onClose={onClose}
			title={`Train "${phrase}"`}
			priority={MODAL_PRIORITIES.WAKE_PHRASE_TRAINING}
			resizeKey="wakePhraseTrainingModal"
			defaultSize={{ width: 560, height: 640 }}
			minSize={{ width: 440, height: 460 }}
			testId="wake-phrase-training-modal"
		>
			<div className="space-y-4 select-none">
				<p className="text-xs opacity-75" style={{ color: theme.colors.textMain }}>
					Maestro learns this phrase from your own voice. The recordings stay on this machine and
					are only ever compared with what the microphone hears. It will mostly respond to you, not
					to other people saying the same words.
				</p>

				{error && (
					<p
						className="text-xs flex items-start gap-1.5"
						data-testid="wake-training-error"
						style={{ color: theme.colors.error }}
					>
						<AlertTriangle size={13} className="shrink-0 mt-0.5" />
						{error}
					</p>
				)}

				{/* -- 1. The phrase ------------------------------------------- */}
				<section
					className="rounded p-3 space-y-2"
					style={{ backgroundColor: theme.colors.bgActivity }}
				>
					<div className="flex items-center justify-between gap-3">
						<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
							1. Say the phrase
						</div>
						<span
							className="text-xs tabular-nums opacity-70"
							data-testid="wake-training-clip-count"
						>
							{clips} of {WAKE_ENROLLMENT_TARGET_CLIPS}
						</span>
					</div>
					<ProgressBar
						theme={theme}
						value={clips}
						total={WAKE_ENROLLMENT_TARGET_CLIPS}
						label="Recordings of the phrase"
					/>
					<p className="text-xs-plus opacity-70 select-text">
						Press Record, say &ldquo;{phrase}&rdquo;, wait a second, and say it again. Each time you
						say it is one recording. Vary it the way you really would: nearer and further from the
						microphone, quicker, quieter.
					</p>
					{recording === 'phrase' && meter}
					<div className="flex items-center gap-2">
						<button
							type="button"
							data-testid="wake-training-record-phrase"
							disabled={busy || recording === 'background'}
							onClick={() => toggle('phrase')}
							className="px-2.5 py-1.5 rounded border text-xs disabled:opacity-50 flex items-center gap-1.5"
							style={{ borderColor: theme.colors.accent, color: theme.colors.textMain }}
						>
							{recording === 'phrase' ? <Square size={12} /> : <Mic size={12} />}
							{recording === 'phrase' ? 'Stop' : clips > 0 ? 'Record more' : 'Record'}
						</button>
						<button
							type="button"
							data-testid="wake-training-undo"
							disabled={busy || clips === 0}
							onClick={() => void enrollment.removeLastClip()}
							className="px-2 py-1.5 rounded text-xs opacity-75 hover:opacity-100 disabled:opacity-40 flex items-center gap-1.5"
							style={{ color: theme.colors.textMain }}
						>
							<Undo2 size={12} />
							Remove last
						</button>
						<span className="text-xs-plus opacity-70" aria-live="polite">
							{notice ?? (recording === 'phrase' ? 'Listening. Say the phrase.' : '')}
						</span>
					</div>
				</section>

				{/* -- 2. Other speech ----------------------------------------- */}
				<section
					className="rounded p-3 space-y-2"
					style={{ backgroundColor: theme.colors.bgActivity }}
				>
					<div className="flex items-center justify-between gap-3">
						<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
							2. Read this aloud
						</div>
						<span
							className="text-xs tabular-nums opacity-70"
							data-testid="wake-training-background"
						>
							{Math.floor(backgroundMs / 1000)} of {WAKE_ENROLLMENT_BACKGROUND_TARGET_MS / 1000} s
						</span>
					</div>
					<ProgressBar
						theme={theme}
						value={backgroundMs}
						total={WAKE_ENROLLMENT_BACKGROUND_TARGET_MS}
						label="Other speech recorded"
					/>
					<p className="text-xs-plus opacity-70">
						This is how Maestro learns what is NOT the phrase. Read it in your normal voice and do
						not say the whole phrase. Any talking works if you would rather improvise.
					</p>
					<p
						className="text-xs select-text rounded p-2 border"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					>
						{wakeEnrollmentPassage(phrase)}
					</p>
					{recording === 'background' && meter}
					<div className="flex items-center gap-2">
						<button
							type="button"
							data-testid="wake-training-record-background"
							disabled={busy || recording === 'phrase'}
							onClick={() => toggle('background')}
							className="px-2.5 py-1.5 rounded border text-xs disabled:opacity-50 flex items-center gap-1.5"
							style={{ borderColor: theme.colors.accent, color: theme.colors.textMain }}
						>
							{recording === 'background' ? <Square size={12} /> : <Mic size={12} />}
							{recording === 'background' ? 'Stop' : backgroundMs > 0 ? 'Record more' : 'Record'}
						</button>
						<button
							type="button"
							data-testid="wake-training-clear-background"
							disabled={busy || backgroundMs === 0}
							onClick={() => void enrollment.clearBackground()}
							className="px-2 py-1.5 rounded text-xs opacity-75 hover:opacity-100 disabled:opacity-40 flex items-center gap-1.5"
							style={{ color: theme.colors.textMain }}
						>
							<Undo2 size={12} />
							Start over
						</button>
					</div>
				</section>

				{/* -- 3. Train ------------------------------------------------ */}
				<section
					className="rounded p-3 space-y-2"
					style={{ backgroundColor: theme.colors.bgActivity }}
				>
					<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
						3. Train
					</div>
					{!trainable && (
						<p className="text-xs-plus opacity-70">
							Needs at least {WAKE_ENROLLMENT_MIN_CLIPS} recordings of the phrase and{' '}
							{WAKE_ENROLLMENT_BACKGROUND_MIN_MS / 1000} seconds of other speech.
						</p>
					)}
					{training && (
						<>
							<ProgressBar
								theme={theme}
								value={training.progress}
								total={1}
								label="Training progress"
								testId="wake-training-progress"
							/>
							<p className="text-xs-plus opacity-70">{TRAINING_LABELS[training.phase]}</p>
						</>
					)}
					{report && !training && (
						<div className="space-y-1" data-testid="wake-training-report">
							<p
								className="text-xs flex items-center gap-1.5"
								style={{ color: qualityColor(theme, report.quality) }}
							>
								{report.quality === 'weak' ? <AlertTriangle size={13} /> : <Check size={13} />}
								{QUALITY_LABELS[report.quality]}.
							</p>
							<p className="text-xs-plus opacity-70">{describeWakeEnrollmentReport(report)}</p>
							{report.clipsUsed < report.clipsTotal && (
								<p className="text-xs-plus opacity-70">
									{report.clipsTotal - report.clipsUsed} recording
									{report.clipsTotal - report.clipsUsed === 1 ? ' was' : 's were'} left out for
									sounding unlike the rest.
								</p>
							)}
							{report.advice && <p className="text-xs-plus opacity-70">{report.advice}</p>}
							{engine !== 'classifier' && (
								<p className="text-xs-plus" style={{ color: theme.colors.warning }}>
									Detection is set to Transcription, which does not use this. Switch it to Trained
									model in Voice Controls.
								</p>
							)}
						</div>
					)}
					<div className="flex items-center gap-2">
						<button
							type="button"
							data-testid="wake-training-train"
							disabled={!trainable || busy || recording !== null || test.running}
							onClick={() => void enrollment.train()}
							className="px-3 py-1.5 rounded border text-xs font-medium disabled:opacity-50 flex items-center gap-1.5"
							style={{
								borderColor: theme.colors.accent,
								backgroundColor: theme.colors.accentDim,
								color: theme.colors.textMain,
							}}
						>
							<AudioLines size={13} />
							{busy ? 'Training...' : report ? 'Train again' : 'Train'}
						</button>
						{report && engine === 'classifier' && (
							<button
								type="button"
								data-testid="wake-training-test"
								disabled={busy || recording !== null}
								onClick={test.toggle}
								className="px-2.5 py-1.5 rounded border text-xs disabled:opacity-50"
								style={{ borderColor: theme.colors.accent, color: theme.colors.textMain }}
							>
								{test.running ? 'Stop test' : 'Test'}
							</button>
						)}
						<span className="text-xs-plus opacity-70" aria-live="polite">
							{report && engine === 'classifier'
								? (test.message ?? (test.running ? 'Listening. Say the phrase.' : ''))
								: ''}
						</span>
					</div>
				</section>

				<div className="flex items-center justify-between gap-3 pt-1">
					<button
						type="button"
						data-testid="wake-training-delete"
						disabled={busy || (clips === 0 && backgroundMs === 0 && !report)}
						onClick={confirmRemove}
						className="px-2 py-1.5 rounded text-xs opacity-75 hover:opacity-100 disabled:opacity-40 flex items-center gap-1.5"
						style={{ color: theme.colors.error }}
					>
						<Trash2 size={12} />
						Delete recordings and model
					</button>
					<button
						type="button"
						data-testid="wake-training-done"
						onClick={onClose}
						className="px-3 py-1.5 rounded border text-xs"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					>
						Done
					</button>
				</div>
			</div>
		</Modal>
	);
}
