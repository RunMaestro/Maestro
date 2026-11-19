// Source: src/__tests__/renderer/stores/federationAutoStore.test.ts
// Source: src/__tests__/renderer/stores/autoRunSteeringStore.test.ts
// Source: src/__tests__/renderer/stores/codexResetCreditsStore.test.ts
// Source: src/__tests__/renderer/stores/mediaPlaybackStore.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { beforeEach } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import { autoFederationAnnouncements } from '../../../renderer/stores/federationAutoStore';
import { useFederationAutoStore } from '../../../renderer/stores/federationAutoStore';
import { notifyToast } from '../../../renderer/stores/notificationStore';
import { emptyAutoFederationSnapshot } from '../../../shared/federationAuto';
import type { AutoFederationSnapshot } from '../../../shared/federationAuto';
import { useAutoRunSteeringStore } from '../../../renderer/stores/autoRunSteeringStore';
import { groupSteeringDeliveries } from '../../../renderer/stores/autoRunSteeringStore';
import { selectDeliveredSteeringNotes } from '../../../renderer/stores/autoRunSteeringStore';
import { selectPendingSteeringNotes } from '../../../renderer/stores/autoRunSteeringStore';
import { MAX_DELIVERED_STEERING_NOTES } from '../../../renderer/stores/autoRunSteeringStore';
import { MAX_STEERING_RESPONSE_LENGTH } from '../../../renderer/stores/autoRunSteeringStore';
import { MAX_PENDING_STEERING_NOTES } from '../../../shared/autorunSteering';
import { useCodexResetCreditsStore } from '../../../renderer/stores/codexResetCreditsStore';
import { useCodexUsageStore } from '../../../renderer/stores/codexUsageStore';
import type { CodexResetCredit } from '../../../shared/codexResetCredits';
import { afterEach } from 'vitest';
import { flushMediaQueuePersist } from '../../../renderer/stores/mediaPlaybackStore';
import { selectActiveMediaItem } from '../../../renderer/stores/mediaPlaybackStore';
import { selectCanOpenMediaPlayer } from '../../../renderer/stores/mediaPlaybackStore';
import { selectCanRestoreFloatingPlayer } from '../../../renderer/stores/mediaPlaybackStore';
import { selectShowNowPlayingIndicator } from '../../../renderer/stores/mediaPlaybackStore';
import { useMediaPlaybackStore } from '../../../renderer/stores/mediaPlaybackStore';
import { MEDIA_HISTORY_LIMIT } from '../../../renderer/stores/mediaPlaybackStore';
import { MEDIA_QUEUE_LIMIT } from '../../../renderer/stores/mediaPlaybackStore';
import { MEDIA_FLOAT_SETTINGS_KEY } from '../../../renderer/stores/mediaPlaybackStore';
import { MEDIA_QUEUE_SETTINGS_KEY } from '../../../renderer/stores/mediaPlaybackStore';
import type { MediaOpenRequest } from '../../../renderer/stores/mediaPlaybackStore';
import { mediaItemId } from '../../../renderer/utils/mediaItems';
vi.mock('../../../renderer/stores/notificationStore', () => ({ notifyToast: vi.fn() }));
describeSourceSuite('federationAutoStore', () => {
	const snap = (patch: Partial<AutoFederationSnapshot>): AutoFederationSnapshot => ({
		...emptyAutoFederationSnapshot(),
		...patch,
	});

	const agent = (state: 'moved' | 'blocked' | 'waiting', reason = 'r') => ({
		agentId: 'a1',
		agentName: 'Docs',
		remoteId: 'r1',
		state,
		reason,
		fix: 'Do the thing.',
		target: 'r1:h1',
		at: 1,
	});

	describe('autoFederationAnnouncements', () => {
		it('announces a move once, and a blocker when it is new or its reason changed', () => {
			const empty = snap({});
			expect(autoFederationAnnouncements(empty, snap({ agents: [agent('moved')] }))).toEqual([
				expect.objectContaining({ color: 'green', title: 'Moved "Docs" to its host' }),
			]);
			expect(
				autoFederationAnnouncements(
					snap({ agents: [agent('moved')] }),
					snap({ agents: [agent('moved')] })
				)
			).toEqual([]);
			const blocked = autoFederationAnnouncements(
				empty,
				snap({ agents: [agent('blocked', 'No CLI')] })
			);
			expect(blocked).toEqual([
				expect.objectContaining({
					color: 'yellow',
					title: 'Could not move "Docs" automatically',
					message: 'No CLI Do the thing.',
				}),
			]);
			expect(
				autoFederationAnnouncements(
					snap({ agents: [agent('blocked', 'No CLI')] }),
					snap({ agents: [agent('blocked', 'No CLI')] })
				)
			).toEqual([]);
			expect(autoFederationAnnouncements(empty, snap({ agents: [agent('waiting')] }))).toEqual([]);
		});

		it('announces a remote whose setup became blocked', () => {
			const next = snap({
				remotes: [
					{
						remoteId: 'r1',
						name: 'box',
						state: 'blocked',
						reason: 'No Node.',
						fix: 'Install it.',
						at: 1,
					},
				],
			});
			expect(autoFederationAnnouncements(snap({}), next)).toEqual([
				expect.objectContaining({
					title: 'Could not set up the host on box',
					message: 'No Node. Install it.',
				}),
			]);
		});
	});

	describe('autoFederationAnnouncements: a running host that needs you', () => {
		it('announces a new required fix once', () => {
			const ready = (fix?: string) =>
				snap({
					remotes: [
						{
							remoteId: 'r1',
							name: 'box',
							state: 'ready',
							needsYou: Boolean(fix),
							...(fix ? { fix } : {}),
							at: 1,
						},
					],
				});
			expect(
				autoFederationAnnouncements(snap({}), ready('Run sudo loginctl enable-linger u.'))
			).toEqual([expect.objectContaining({ title: 'The host on box needs one step from you' })]);
			expect(autoFederationAnnouncements(ready('Run it.'), ready('Run it.'))).toEqual([]);
			expect(autoFederationAnnouncements(snap({}), ready())).toEqual([]);
		});
	});

	describe('useFederationAutoStore', () => {
		beforeEach(() => {
			useFederationAutoStore.getState().reset();
			vi.mocked(notifyToast).mockClear();
		});

		it('loads the first snapshot quietly and toasts later changes', () => {
			const { applySnapshot } = useFederationAutoStore.getState();
			applySnapshot(snap({ agents: [agent('blocked')] }), false);
			expect(notifyToast).not.toHaveBeenCalled();
			applySnapshot(snap({ agents: [agent('moved')] }));
			expect(notifyToast).toHaveBeenCalledTimes(1);
			expect(useFederationAutoStore.getState().snapshot.agents[0].state).toBe('moved');
		});
	});
});
describeSourceSuite('autoRunSteeringStore', () => {
	const SESSION = 'session-1';

	describe('autoRunSteeringStore', () => {
		beforeEach(() => {
			useAutoRunSteeringStore.setState({ notes: {}, delivered: {} });
		});

		it('parks a note against its session', () => {
			const note = useAutoRunSteeringStore.getState().addNote(SESSION, '  steer left  ');
			expect(note).not.toBeNull();
			expect(note!.text).toBe('steer left');
			expect(useAutoRunSteeringStore.getState().notes[SESSION]).toHaveLength(1);
		});

		it('rejects an empty note so the caller can report the refusal', () => {
			expect(useAutoRunSteeringStore.getState().addNote(SESSION, '   ')).toBeNull();
			expect(useAutoRunSteeringStore.getState().notes[SESSION]).toBeUndefined();
		});

		it('rejects a note past the pending cap', () => {
			for (let i = 0; i < MAX_PENDING_STEERING_NOTES; i++) {
				expect(useAutoRunSteeringStore.getState().addNote(SESSION, `note ${i}`)).not.toBeNull();
			}
			expect(useAutoRunSteeringStore.getState().addNote(SESSION, 'one too many')).toBeNull();
			expect(useAutoRunSteeringStore.getState().notes[SESSION]).toHaveLength(
				MAX_PENDING_STEERING_NOTES
			);
		});

		it('takeNotes reads and clears in one step so a note is never delivered twice', () => {
			useAutoRunSteeringStore.getState().addNote(SESSION, 'first');
			useAutoRunSteeringStore.getState().addNote(SESSION, 'second');

			const taken = useAutoRunSteeringStore.getState().takeNotes(SESSION);
			expect(taken.map((n) => n.text)).toEqual(['first', 'second']);
			expect(useAutoRunSteeringStore.getState().notes[SESSION]).toBeUndefined();
			expect(useAutoRunSteeringStore.getState().takeNotes(SESSION)).toEqual([]);
		});

		it('takeNotes moves the notes onto the delivered list so the panel keeps the record', () => {
			useAutoRunSteeringStore.getState().addNote(SESSION, 'first');
			useAutoRunSteeringStore.getState().takeNotes(SESSION);
			useAutoRunSteeringStore.getState().addNote(SESSION, 'second');
			useAutoRunSteeringStore.getState().takeNotes(SESSION);

			expect(useAutoRunSteeringStore.getState().delivered[SESSION].map((n) => n.text)).toEqual([
				'first',
				'second',
			]);
		});

		it('caps the delivered list, keeping the newest notes', () => {
			for (let i = 0; i < MAX_DELIVERED_STEERING_NOTES + 5; i++) {
				useAutoRunSteeringStore.getState().addNote(SESSION, `note ${i}`);
				useAutoRunSteeringStore.getState().takeNotes(SESSION);
			}
			const history = useAutoRunSteeringStore.getState().delivered[SESSION];
			expect(history).toHaveLength(MAX_DELIVERED_STEERING_NOTES);
			expect(history[history.length - 1].text).toBe(`note ${MAX_DELIVERED_STEERING_NOTES + 4}`);
		});

		it('keeps sessions independent', () => {
			useAutoRunSteeringStore.getState().addNote(SESSION, 'mine');
			useAutoRunSteeringStore.getState().addNote('session-2', 'theirs');

			useAutoRunSteeringStore.getState().takeNotes(SESSION);
			expect(useAutoRunSteeringStore.getState().notes['session-2']).toHaveLength(1);
			expect(useAutoRunSteeringStore.getState().delivered['session-2']).toBeUndefined();
		});

		it('removes one pending note and leaves the rest', () => {
			const first = useAutoRunSteeringStore.getState().addNote(SESSION, 'first')!;
			useAutoRunSteeringStore.getState().addNote(SESSION, 'second');

			useAutoRunSteeringStore.getState().removeNote(SESSION, first.id);
			expect(useAutoRunSteeringStore.getState().notes[SESSION]).toHaveLength(1);
			expect(useAutoRunSteeringStore.getState().notes[SESSION][0].text).toBe('second');
		});

		it('removeNote cannot un-send a note a task already took', () => {
			const note = useAutoRunSteeringStore.getState().addNote(SESSION, 'gone')!;
			useAutoRunSteeringStore.getState().takeNotes(SESSION);

			useAutoRunSteeringStore.getState().removeNote(SESSION, note.id);
			expect(useAutoRunSteeringStore.getState().delivered[SESSION]).toHaveLength(1);
		});

		it('clearNotes drops both lists for a session', () => {
			useAutoRunSteeringStore.getState().addNote(SESSION, 'first');
			useAutoRunSteeringStore.getState().takeNotes(SESSION);
			useAutoRunSteeringStore.getState().addNote(SESSION, 'second');

			useAutoRunSteeringStore.getState().clearNotes(SESSION);
			expect(useAutoRunSteeringStore.getState().notes[SESSION]).toBeUndefined();
			expect(useAutoRunSteeringStore.getState().delivered[SESSION]).toBeUndefined();
		});

		it('clearPendingNotes keeps the delivered record, since a reply lands as the run ends', () => {
			const taken = useAutoRunSteeringStore.getState().addNote(SESSION, 'stop after this doc')!;
			useAutoRunSteeringStore.getState().takeNotes(SESSION);
			useAutoRunSteeringStore.getState().recordResponse(SESSION, [taken.id], {
				summary: '[steered] Halting after this document.',
				text: '[steered] Halting after this document.',
				success: true,
			});
			useAutoRunSteeringStore.getState().addNote(SESSION, 'never taken');

			useAutoRunSteeringStore.getState().clearPendingNotes(SESSION);

			expect(useAutoRunSteeringStore.getState().notes[SESSION]).toBeUndefined();
			const [kept] = useAutoRunSteeringStore.getState().delivered[SESSION];
			expect(kept.response?.summary).toBe('[steered] Halting after this document.');
		});

		describe('replies', () => {
			const reply = (text: string, success = true) => ({ summary: text, text, success });

			it('stamps every note one task took with the same delivery', () => {
				useAutoRunSteeringStore.getState().addNote(SESSION, 'first');
				useAutoRunSteeringStore.getState().addNote(SESSION, 'second');
				useAutoRunSteeringStore.getState().takeNotes(SESSION);
				useAutoRunSteeringStore.getState().addNote(SESSION, 'third');
				useAutoRunSteeringStore.getState().takeNotes(SESSION);

				const [a, b, c] = useAutoRunSteeringStore.getState().delivered[SESSION];
				expect(a.deliveryId).toBe(b.deliveryId);
				expect(c.deliveryId).not.toBe(a.deliveryId);
			});

			it('attaches a reply only to the notes that task took', () => {
				useAutoRunSteeringStore.getState().addNote(SESSION, 'first');
				const first = useAutoRunSteeringStore.getState().takeNotes(SESSION);
				useAutoRunSteeringStore.getState().addNote(SESSION, 'second');
				useAutoRunSteeringStore.getState().takeNotes(SESSION);

				useAutoRunSteeringStore.getState().recordResponse(
					SESSION,
					first.map((n) => n.id),
					reply('  [steered] switched endpoints  ')
				);

				const [a, b] = useAutoRunSteeringStore.getState().delivered[SESSION];
				expect(a.response).toMatchObject({
					summary: '[steered] switched endpoints',
					text: '[steered] switched endpoints',
					success: true,
				});
				expect(a.response!.timestamp).toBeGreaterThan(0);
				expect(b.response).toBeUndefined();
			});

			it('keeps a failed task as a reply rather than leaving the note waiting', () => {
				const note = useAutoRunSteeringStore.getState().addNote(SESSION, 'first')!;
				useAutoRunSteeringStore.getState().takeNotes(SESSION);

				useAutoRunSteeringStore
					.getState()
					.recordResponse(SESSION, [note.id], reply('context limit reached', false));

				expect(useAutoRunSteeringStore.getState().delivered[SESSION][0].response?.success).toBe(
					false
				);
			});

			it('does not resurrect a note a new run already cleared', () => {
				const note = useAutoRunSteeringStore.getState().addNote(SESSION, 'first')!;
				useAutoRunSteeringStore.getState().takeNotes(SESSION);
				useAutoRunSteeringStore.getState().clearNotes(SESSION);

				useAutoRunSteeringStore.getState().recordResponse(SESSION, [note.id], reply('late'));

				expect(useAutoRunSteeringStore.getState().delivered[SESSION]).toBeUndefined();
			});

			it('caps a runaway reply', () => {
				const note = useAutoRunSteeringStore.getState().addNote(SESSION, 'first')!;
				useAutoRunSteeringStore.getState().takeNotes(SESSION);

				useAutoRunSteeringStore.getState().recordResponse(SESSION, [note.id], {
					summary: 'short',
					text: 'x'.repeat(MAX_STEERING_RESPONSE_LENGTH + 500),
					success: true,
				});

				expect(
					useAutoRunSteeringStore.getState().delivered[SESSION][0].response!.text
				).toHaveLength(MAX_STEERING_RESPONSE_LENGTH);
			});

			it("groups notes by the task that took them, with that task's one reply", () => {
				useAutoRunSteeringStore.getState().addNote(SESSION, 'first');
				useAutoRunSteeringStore.getState().addNote(SESSION, 'second');
				const batch = useAutoRunSteeringStore.getState().takeNotes(SESSION);
				useAutoRunSteeringStore.getState().recordResponse(
					SESSION,
					batch.map((n) => n.id),
					reply('[steered] did both')
				);
				useAutoRunSteeringStore.getState().addNote(SESSION, 'third');
				useAutoRunSteeringStore.getState().takeNotes(SESSION);

				const deliveries = groupSteeringDeliveries(
					useAutoRunSteeringStore.getState().delivered[SESSION]
				);

				expect(deliveries.map((d) => d.notes.map((n) => n.text))).toEqual([
					['first', 'second'],
					['third'],
				]);
				expect(deliveries[0].response?.summary).toBe('[steered] did both');
				// The second task is still running: delivered, not yet answered.
				expect(deliveries[1].response).toBeUndefined();
			});

			it('groups nothing into nothing', () => {
				expect(groupSteeringDeliveries([])).toEqual([]);
			});
		});

		it('hands back a stable empty array so the selectors never churn subscribers', () => {
			const state = useAutoRunSteeringStore.getState();
			expect(selectPendingSteeringNotes(SESSION)(state)).toBe(
				selectPendingSteeringNotes('other')(state)
			);
			expect(selectDeliveredSteeringNotes(SESSION)(state)).toBe(
				selectDeliveredSteeringNotes('other')(state)
			);
		});
	});
});
describeSourceSuite('codexResetCreditsStore', () => {
	/**
	 * The store is the only path that spends a reset credit, and a credit is
	 * finite, expires, and cannot be refunded. So the behaviours pinned here are
	 * the ones whose failure costs the user something real: a second spend landing
	 * for one click, a spend aimed at the wrong credit, and a failed read making a
	 * stocked account look empty.
	 */

	const CODEX_HOME = '/home/tester/.codex';

	function credit(overrides: Partial<CodexResetCredit> = {}): CodexResetCredit {
		return {
			id: 'credit-1',
			supportedByPlan: true,
			status: 'available',
			...overrides,
		};
	}

	let getCredits: ReturnType<typeof vi.fn>;
	let consumeCredit: ReturnType<typeof vi.fn>;

	describe('codexResetCreditsStore', () => {
		beforeEach(() => {
			useCodexResetCreditsStore.getState().__resetForTests();
			getCredits = vi.fn().mockResolvedValue({
				ok: true,
				detail: { credits: [credit()], available: 1, applicable: 1 },
			});
			consumeCredit = vi.fn().mockResolvedValue({ ok: true, windowsReset: 2 });
			(globalThis as { window?: unknown }).window = {
				maestro: {
					agents: {
						getCodexResetCredits: getCredits,
						consumeCodexResetCredit: consumeCredit,
					},
				},
			};
			// The usage bars are re-read after a spend; stub it so the store's
			// invalidation can be asserted without a second IPC surface.
			useCodexUsageStore.setState({ refresh: vi.fn().mockResolvedValue(undefined) });
		});

		describe('load', () => {
			it('stores the credits and both counts from a successful read', async () => {
				await useCodexResetCreditsStore.getState().load(CODEX_HOME);

				const entry = useCodexResetCreditsStore.getState().entries[CODEX_HOME];
				expect(entry?.credits).toHaveLength(1);
				expect(entry?.counts).toEqual({ available: 1, applicable: 1 });
				expect(entry?.error).toBeUndefined();
			});

			it('passes an absent applicable count through as undefined', async () => {
				// Unknown and zero drive different verdicts: coercing here would make
				// every spend on this account report as wasteful.
				getCredits.mockResolvedValue({
					ok: true,
					detail: { credits: [credit()], available: 1 },
				});

				await useCodexResetCreditsStore.getState().load(CODEX_HOME);

				expect(useCodexResetCreditsStore.getState().entries[CODEX_HOME]?.counts).toEqual({
					available: 1,
					applicable: undefined,
				});
			});

			it('keeps the last known credits when a read fails', async () => {
				await useCodexResetCreditsStore.getState().load(CODEX_HOME);
				getCredits.mockResolvedValue({ ok: false, error: 'Codex auth token was rejected.' });

				await useCodexResetCreditsStore.getState().load(CODEX_HOME);

				const entry = useCodexResetCreditsStore.getState().entries[CODEX_HOME];
				// Blanking the list would tell a user holding credits that they have
				// none, which is the one wrong answer that stops them redeeming.
				expect(entry?.credits).toHaveLength(1);
				expect(entry?.error).toBe('Codex auth token was rejected.');
			});

			it('never leaves the account stuck loading when the bridge throws', async () => {
				getCredits.mockRejectedValue(new Error('bridge is gone'));

				await useCodexResetCreditsStore.getState().load(CODEX_HOME);

				expect(useCodexResetCreditsStore.getState().loading[CODEX_HOME]).toBe(false);
			});
		});

		describe('redeem', () => {
			it('spends the soonest-to-expire credit when none is named', async () => {
				useCodexResetCreditsStore.setState({
					entries: {
						[CODEX_HOME]: {
							credits: [
								credit({ id: 'later', expiresAt: '2026-11-01T00:00:00.000Z' }),
								credit({ id: 'soon', expiresAt: '2026-09-20T00:00:00.000Z' }),
							],
							counts: { available: 2, applicable: 2 },
						},
					},
				});

				await useCodexResetCreditsStore.getState().redeem(CODEX_HOME);

				expect(consumeCredit).toHaveBeenCalledWith(CODEX_HOME, 'soon', expect.any(String));
			});

			it('redeems the named credit when the caller picks one', async () => {
				useCodexResetCreditsStore.setState({
					entries: {
						[CODEX_HOME]: {
							credits: [credit({ id: 'a' }), credit({ id: 'b' })],
							counts: { available: 2, applicable: 2 },
						},
					},
				});

				await useCodexResetCreditsStore.getState().redeem(CODEX_HOME, 'b');

				expect(consumeCredit).toHaveBeenCalledWith(CODEX_HOME, 'b', expect.any(String));
			});

			it('refuses a second spend while one is in flight', async () => {
				useCodexResetCreditsStore.setState({
					entries: { [CODEX_HOME]: { credits: [credit()], counts: { available: 1 } } },
				});
				let release: (value: { ok: boolean; windowsReset: number }) => void = () => {};
				consumeCredit.mockReturnValue(
					new Promise<{ ok: boolean; windowsReset: number }>((resolve) => {
						release = resolve;
					})
				);

				const first = useCodexResetCreditsStore.getState().redeem(CODEX_HOME);
				const second = await useCodexResetCreditsStore.getState().redeem(CODEX_HOME);

				// The guard is claimed synchronously, so a double click cannot land two
				// spends for one credit.
				expect(second.attempted).toBe(false);
				expect(consumeCredit).toHaveBeenCalledTimes(1);

				release({ ok: true, windowsReset: 1 });
				await first;
				expect(useCodexResetCreditsStore.getState().redeeming[CODEX_HOME]).toBe(false);
			});

			it('leaves a different account free to redeem concurrently', async () => {
				const other = '/home/tester/.codex-work';
				useCodexResetCreditsStore.setState({
					entries: {
						[CODEX_HOME]: { credits: [credit()], counts: { available: 1 } },
						[other]: { credits: [credit({ id: 'credit-2' })], counts: { available: 1 } },
					},
					redeeming: { [CODEX_HOME]: true },
				});

				const result = await useCodexResetCreditsStore.getState().redeem(other);

				expect(result.attempted).toBe(true);
				expect(consumeCredit).toHaveBeenCalledWith(other, 'credit-2', expect.any(String));
			});

			it('reports no attempt when the account holds nothing spendable', async () => {
				useCodexResetCreditsStore.setState({
					entries: {
						[CODEX_HOME]: {
							credits: [credit({ status: 'redeemed' })],
							counts: { available: 0 },
						},
					},
				});

				const result = await useCodexResetCreditsStore.getState().redeem(CODEX_HOME);

				expect(result.attempted).toBe(false);
				expect(consumeCredit).not.toHaveBeenCalled();
			});

			it('re-reads the credits and the usage bars after a successful spend', async () => {
				useCodexResetCreditsStore.setState({
					entries: { [CODEX_HOME]: { credits: [credit()], counts: { available: 1 } } },
				});

				const result = await useCodexResetCreditsStore.getState().redeem(CODEX_HOME);

				expect(result).toMatchObject({ ok: true, windowsReset: 2, attempted: true });
				// Otherwise the panel keeps showing the exhausted windows the user just
				// paid to reopen, which reads as the redemption having failed.
				expect(getCredits).toHaveBeenCalledWith(CODEX_HOME);
				expect(useCodexUsageStore.getState().refresh).toHaveBeenCalled();
			});

			it('still re-reads after a refused spend, so a dead credit leaves the list', async () => {
				useCodexResetCreditsStore.setState({
					entries: { [CODEX_HOME]: { credits: [credit()], counts: { available: 1 } } },
				});
				consumeCredit.mockResolvedValue({
					ok: false,
					windowsReset: 0,
					code: 'no_credit',
					message: 'That reset credit is no longer available.',
				});

				const result = await useCodexResetCreditsStore.getState().redeem(CODEX_HOME);

				expect(result).toMatchObject({ ok: false, attempted: true, code: 'no_credit' });
				expect(getCredits).toHaveBeenCalledWith(CODEX_HOME);
			});

			it('reports an undecided outcome and clears the guard when the bridge throws', async () => {
				useCodexResetCreditsStore.setState({
					entries: { [CODEX_HOME]: { credits: [credit()], counts: { available: 1 } } },
				});
				consumeCredit.mockRejectedValue(new Error('bridge is gone'));

				const result = await useCodexResetCreditsStore.getState().redeem(CODEX_HOME);

				// The request may have landed, so never claim the credit was preserved.
				expect(result).toMatchObject({ ok: false, attempted: true });
				expect(result.message).toContain('may or may not have been spent');
				expect(useCodexResetCreditsStore.getState().redeeming[CODEX_HOME]).toBe(false);
			});
		});
	});
});
describeSourceSuite('mediaPlaybackStore', () => {
	const FLOAT = { top: 40, left: 50, width: 400 };

	const initial = useMediaPlaybackStore.getState();

	/** A queueable file. Defaults to a local audio file on agent `s1`. */
	function request(overrides: Partial<MediaOpenRequest> = {}): MediaOpenRequest {
		return {
			path: '/files/a.mp3',
			name: 'a.mp3',
			kind: 'audio',
			sessionId: 's1',
			sessionName: 'Agent One',
			...overrides,
		};
	}

	const idOf = (r: MediaOpenRequest) => mediaItemId(r.sessionId, r.path);

	function reset() {
		useMediaPlaybackStore.setState({
			items: [],
			activeItemId: null,
			history: [],
			playing: false,
			dismissed: false,
			dormant: false,
			pendingAutoplay: false,
			toggleRequest: 0,
			focusRequest: 0,
			resumeTimes: {},
			durations: {},
			floatPosition: null,
			floatWidths: {},
			aspects: {},
		});
	}

	describe('mediaPlaybackStore', () => {
		beforeEach(() => {
			reset();
			(window as unknown as { maestro?: unknown }).maestro = { settings: { set: vi.fn() } };
		});

		describe('openMedia', () => {
			it('queues a file, makes it active, and plays it', () => {
				const r = request();
				initial.openMedia(r);

				const state = useMediaPlaybackStore.getState();
				expect(state.items).toHaveLength(1);
				expect(state.activeItemId).toBe(idOf(r));
				expect(state.pendingAutoplay).toBe(true);
				// The track you are listening to is not "recently played" - it is named
				// in the title bar, and listing it in both places at once is what made a
				// single open file appear twice.
				expect(state.history).toEqual([]);
			});

			it('re-opening the same file reuses its entry instead of stacking a duplicate', () => {
				initial.openMedia(request());
				initial.rememberTime(idOf(request()), 30);
				initial.openMedia(request());

				const state = useMediaPlaybackStore.getState();
				expect(state.items).toHaveLength(1);
				// The remembered position survives, so re-opening resumes.
				expect(state.resumeTimes[idOf(request())]).toBe(30);
			});

			it('keys on agent and path, so the same file in two agents is two entries', () => {
				initial.openMedia(request());
				initial.openMedia(request({ sessionId: 's2', sessionName: 'Agent Two' }));
				expect(useMediaPlaybackStore.getState().items).toHaveLength(2);
			});

			it('refreshes metadata on re-open, so a renamed agent is not stale', () => {
				initial.openMedia(request());
				initial.openMedia(request({ sessionName: 'Renamed' }));

				const state = useMediaPlaybackStore.getState();
				expect(state.items).toHaveLength(1);
				expect(state.items[0].sessionName).toBe('Renamed');
			});

			it('keeps queue position on re-open, so prev/next order stays open order', () => {
				const a = request();
				const b = request({ path: '/files/b.mp3', name: 'b.mp3' });
				initial.openMedia(a);
				initial.openMedia(b);
				initial.openMedia(a);

				expect(useMediaPlaybackStore.getState().items.map((i) => i.id)).toEqual([idOf(a), idOf(b)]);
			});

			it('un-hides the player, so opening a file always shows controls', () => {
				initial.openMedia(request());
				initial.dismiss();
				initial.openMedia(request({ path: '/files/b.mp3', name: 'b.mp3' }));
				expect(useMediaPlaybackStore.getState().dismissed).toBe(false);
			});

			it('switching files clears playing, since only one element is ever mounted', () => {
				initial.openMedia(request());
				initial.setPlaying(true);
				initial.openMedia(request({ path: '/files/b.mp3', name: 'b.mp3' }));
				expect(useMediaPlaybackStore.getState().playing).toBe(false);
			});
		});

		describe('history', () => {
			it('records a track when it leaves the player, newest departure first', () => {
				const a = request();
				const b = request({ path: '/files/b.mp3', name: 'b.mp3' });
				const c = request({ path: '/files/c.mp3', name: 'c.mp3' });
				initial.openMedia(a);
				initial.openMedia(b); // a departs
				initial.openMedia(c); // b departs

				const state = useMediaPlaybackStore.getState();
				expect(state.history.map((h) => h.id)).toEqual([idOf(b), idOf(a)]);
				// c is loaded, so it is not in its own history.
				expect(state.history.some((h) => h.id === idOf(c))).toBe(false);
			});

			it('leaves history empty while the first track is still playing', () => {
				initial.openMedia(request());
				expect(useMediaPlaybackStore.getState().history).toEqual([]);
			});

			it('re-opening the loaded track is not a departure', () => {
				const a = request();
				initial.openMedia(a);
				initial.openMedia(a);
				expect(useMediaPlaybackStore.getState().history).toEqual([]);
			});

			it('replaying a track pulls it back out of history', () => {
				// Otherwise it sits at the top of "recently played" while audibly
				// playing - the same double-listing, one step removed.
				const a = request();
				const b = request({ path: '/files/b.mp3', name: 'b.mp3' });
				initial.openMedia(a);
				initial.openMedia(b); // a departs to history
				expect(useMediaPlaybackStore.getState().history.map((h) => h.id)).toEqual([idOf(a)]);

				initial.openMedia(a); // a comes back; b departs
				expect(useMediaPlaybackStore.getState().history.map((h) => h.id)).toEqual([idOf(b)]);
			});

			it('re-opening a closed track clears its history entry', () => {
				const a = request();
				initial.openMedia(a);
				initial.closeItem(idOf(a)); // player idle, a is history
				expect(useMediaPlaybackStore.getState().history.map((h) => h.id)).toEqual([idOf(a)]);

				initial.openMedia(a);
				expect(useMediaPlaybackStore.getState().history).toEqual([]);
			});

			it('never lists the same item twice', () => {
				const a = request();
				const b = request({ path: '/files/b.mp3', name: 'b.mp3' });
				initial.openMedia(a);
				initial.openMedia(b); // a departs
				initial.openMedia(a); // b departs, a is loaded again
				initial.openMedia(b); // a departs again

				const history = useMediaPlaybackStore.getState().history;
				expect(history.filter((entry) => entry.id === idOf(a))).toHaveLength(1);
			});

			it('caps at the limit so the menu stays scannable', () => {
				// Each open departs the previous track, so N opens leave N-1 entries.
				for (let i = 0; i < MEDIA_HISTORY_LIMIT + 5; i++) {
					initial.openMedia(request({ path: `/files/${i}.mp3`, name: `${i}.mp3` }));
				}
				expect(useMediaPlaybackStore.getState().history).toHaveLength(MEDIA_HISTORY_LIMIT);
			});
		});

		describe('setActiveItem', () => {
			it('ignores an item that is not queued', () => {
				initial.openMedia(request());
				const before = useMediaPlaybackStore.getState();
				initial.setActiveItem('nope', { autoplay: true });
				expect(useMediaPlaybackStore.getState()).toBe(before);
			});

			it('does not autoplay by default', () => {
				const a = request();
				const b = request({ path: '/files/b.mp3', name: 'b.mp3' });
				initial.openMedia(a);
				initial.openMedia(b);
				initial.consumeAutoplay();
				initial.setActiveItem(idOf(a));
				expect(useMediaPlaybackStore.getState().pendingAutoplay).toBe(false);
			});

			it('re-activating the active item is a no-op when nothing would change', () => {
				initial.openMedia(request());
				initial.consumeAutoplay();
				const before = useMediaPlaybackStore.getState();
				initial.setActiveItem(idOf(request()));
				expect(useMediaPlaybackStore.getState()).toBe(before);
			});

			it('re-activating the active item still un-hides and can re-arm autoplay', () => {
				initial.openMedia(request());
				initial.consumeAutoplay();
				initial.dismiss();
				initial.setActiveItem(idOf(request()), { autoplay: true });

				const state = useMediaPlaybackStore.getState();
				expect(state.dismissed).toBe(false);
				expect(state.pendingAutoplay).toBe(true);
			});
		});

		describe('autoplay one-shot', () => {
			it('is consumed exactly once', () => {
				initial.openMedia(request());
				initial.consumeAutoplay();
				expect(useMediaPlaybackStore.getState().pendingAutoplay).toBe(false);
				const before = useMediaPlaybackStore.getState();
				initial.consumeAutoplay();
				expect(useMediaPlaybackStore.getState()).toBe(before);
			});
		});

		describe('dismiss and restore', () => {
			it('dismissing does not stop playback', () => {
				initial.openMedia(request());
				initial.setPlaying(true);
				initial.dismiss();

				const state = useMediaPlaybackStore.getState();
				expect(state.dismissed).toBe(true);
				// Hiding a control must not have the side effect of stopping media.
				expect(state.playing).toBe(true);
				expect(state.activeItemId).toBe(idOf(request()));
			});

			it('restore clears the dismissal', () => {
				initial.openMedia(request());
				initial.dismiss();
				initial.restore();
				expect(useMediaPlaybackStore.getState().dismissed).toBe(false);
			});

			it('wakes a dormant queue on the first thing the user opens or queues', () => {
				const dormant = () => useMediaPlaybackStore.getState().dormant;

				initial.openMedia(request());
				useMediaPlaybackStore.setState({ dormant: true });
				initial.openMedia(request({ path: '/files/b.mp3', name: 'b.mp3' }));
				expect(dormant()).toBe(false);

				useMediaPlaybackStore.setState({ dormant: true });
				initial.enqueueMedia([request({ path: '/files/c.mp3', name: 'c.mp3' })]);
				expect(dormant()).toBe(false);

				useMediaPlaybackStore.setState({ dormant: true });
				initial.setActiveItem(idOf(request()));
				expect(dormant()).toBe(false);
			});

			it('selectShowNowPlayingIndicator hides the header pill for a dormant queue', () => {
				// The state a restart lands in: loaded, hidden, untouched. The palette
				// can still reach it; the Left Bar must not advertise it.
				initial.openMedia(request());
				useMediaPlaybackStore.setState({ dismissed: true, dormant: true, playing: false });
				expect(selectCanRestoreFloatingPlayer(useMediaPlaybackStore.getState())).toBe(true);
				expect(selectShowNowPlayingIndicator(useMediaPlaybackStore.getState())).toBe(false);

				initial.restore();
				useMediaPlaybackStore.setState({ dismissed: true });
				expect(selectShowNowPlayingIndicator(useMediaPlaybackStore.getState())).toBe(true);
			});

			it('selectCanRestoreFloatingPlayer needs both a dismissal and loaded media', () => {
				expect(selectCanRestoreFloatingPlayer(useMediaPlaybackStore.getState())).toBe(false);
				initial.openMedia(request());
				expect(selectCanRestoreFloatingPlayer(useMediaPlaybackStore.getState())).toBe(false);
				initial.dismiss();
				expect(selectCanRestoreFloatingPlayer(useMediaPlaybackStore.getState())).toBe(true);
			});
		});

		describe('focusRequest', () => {
			const focus = () => useMediaPlaybackStore.getState().focusRequest;

			it('rises on the two gestures that mean "show me the player"', () => {
				initial.openMedia(request());
				const before = focus();

				initial.restore();
				expect(focus()).toBe(before + 1);

				initial.openPlayer();
				expect(focus()).toBe(before + 2);
			});

			it('rises on restore even when the widget was already up', () => {
				// The header pill and the palette are the only callers, and both are the
				// user asking to be put in the player - not a state reconciliation.
				initial.openMedia(request());
				const before = focus();
				initial.restore();
				expect(focus()).toBe(before + 1);
			});

			it('stays put when a file is opened or queued', () => {
				// Opening media is a request to HEAR something, often from a file tree
				// the user is still navigating. Stealing the caret there would be a
				// keystroke landing somewhere they were not looking.
				const before = focus();
				initial.openMedia(request());
				initial.enqueueMedia([request({ path: '/files/b.mp3', name: 'b.mp3' })]);
				initial.setActiveItem(mediaItemId('s1', '/files/b.mp3'));
				expect(focus()).toBe(before);
			});
		});

		describe('openPlayer', () => {
			it('re-queues a target that only survives in history', () => {
				const r = request();
				initial.openMedia(r);
				initial.rememberTime(idOf(r), 12);
				initial.closeItem(idOf(r));

				// The palette still offers the command, so it has to do something.
				expect(selectCanOpenMediaPlayer(useMediaPlaybackStore.getState())).toBe(true);

				initial.openPlayer();

				const state = useMediaPlaybackStore.getState();
				expect(state.activeItemId).toBe(idOf(r));
				expect(state.items.map((i) => i.id)).toEqual([idOf(r)]);
				// Back where the user stopped, and paused: opening is not "play".
				expect(state.resumeTimes[idOf(r)]).toBe(12);
				expect(state.pendingAutoplay).toBe(false);
				expect(state.dismissed).toBe(false);
				expect(state.dormant).toBe(false);
				// The loaded track is never in history.
				expect(state.history.map((h) => h.id)).not.toContain(idOf(r));
			});

			it('wakes a dormant restored queue without restarting it', () => {
				const r = request();
				useMediaPlaybackStore.setState({
					items: [{ ...r, id: idOf(r) }],
					activeItemId: idOf(r),
					resumeTimes: { [idOf(r)]: 30 },
					dismissed: true,
					dormant: true,
				});

				initial.openPlayer();

				const state = useMediaPlaybackStore.getState();
				expect(state.dismissed).toBe(false);
				expect(state.dormant).toBe(false);
				expect(state.activeItemId).toBe(idOf(r));
				expect(state.resumeTimes[idOf(r)]).toBe(30);
				expect(state.pendingAutoplay).toBe(false);
			});

			it('does nothing when there is nothing to open', () => {
				initial.openPlayer();
				const state = useMediaPlaybackStore.getState();
				expect(state.activeItemId).toBeNull();
				expect(state.items).toHaveLength(0);
			});
		});

		describe('toggle requests', () => {
			it('increments a nonce so the pill can drive the element', () => {
				initial.requestToggle();
				initial.requestToggle();
				expect(useMediaPlaybackStore.getState().toggleRequest).toBe(2);
			});
		});

		describe('resume positions', () => {
			it('remembers where a file was left', () => {
				initial.rememberTime('a', 42.5);
				expect(useMediaPlaybackStore.getState().resumeTimes.a).toBe(42.5);
			});
		});

		describe('closeItem', () => {
			it('releases the player when the playing item is closed', () => {
				const r = request();
				initial.openMedia(r);
				initial.setPlaying(true);
				initial.rememberTime(idOf(r), 10);

				initial.closeItem(idOf(r));

				const state = useMediaPlaybackStore.getState();
				expect(state.items).toHaveLength(0);
				expect(state.activeItemId).toBeNull();
				expect(state.playing).toBe(false);
				expect(state.pendingAutoplay).toBe(false);
				// Closing drops it from the queue but not from what was played: history
				// is a record, not a view onto the queue.
				expect(state.history.map((h) => h.id)).toEqual([idOf(r)]);
				// And it keeps its position, because history is how the user gets back
				// to it - reopening from "recently played" must resume, not restart.
				expect(state.resumeTimes[idOf(r)]).toBe(10);
			});

			it('forgets the position of an item that leaves the queue without entering history', () => {
				const a = request();
				const b = request({ path: '/files/b.mp3', name: 'b.mp3' });
				initial.openMedia(a);
				initial.enqueueMedia([b]);
				initial.rememberTime(idOf(b), 42);

				// `b` was never loaded, so closing it drops it from both lists.
				initial.closeItem(idOf(b));

				const state = useMediaPlaybackStore.getState();
				expect(state.history.map((h) => h.id)).not.toContain(idOf(b));
				expect(state.resumeTimes[idOf(b)]).toBeUndefined();
			});

			it('closing is stop, not skip - it does not auto-advance', () => {
				const a = request();
				const b = request({ path: '/files/b.mp3', name: 'b.mp3' });
				initial.openMedia(a);
				initial.openMedia(b);
				initial.closeItem(idOf(b));
				expect(useMediaPlaybackStore.getState().activeItemId).toBeNull();
			});

			it('leaves the active item alone when a different one closes', () => {
				const a = request();
				const b = request({ path: '/files/b.mp3', name: 'b.mp3' });
				initial.openMedia(a);
				initial.openMedia(b);
				initial.closeItem(idOf(a));
				expect(useMediaPlaybackStore.getState().activeItemId).toBe(idOf(b));
			});

			it('closing an unknown item is a no-op', () => {
				const before = useMediaPlaybackStore.getState();
				initial.closeItem('nope');
				expect(useMediaPlaybackStore.getState()).toBe(before);
			});
		});

		describe('float geometry', () => {
			it('persists the position and the width, filed under the kind', () => {
				const set = vi.fn();
				(window as unknown as { maestro: unknown }).maestro = { settings: { set } };
				initial.setFloatGeometry('video', FLOAT);

				const state = useMediaPlaybackStore.getState();
				expect(state.floatPosition).toEqual({ top: FLOAT.top, left: FLOAT.left });
				expect(state.floatWidths).toEqual({ video: FLOAT.width });
				expect(set).toHaveBeenCalledWith(MEDIA_FLOAT_SETTINGS_KEY, {
					top: FLOAT.top,
					left: FLOAT.left,
					widths: { video: FLOAT.width },
				});
			});

			it('keeps a width per kind, so one does not overwrite the other', () => {
				initial.setFloatGeometry('video', { top: 0, left: 0, width: 900 });
				initial.setFloatGeometry('audio', { top: 10, left: 10, width: 380 });

				const state = useMediaPlaybackStore.getState();
				expect(state.floatWidths).toEqual({ video: 900, audio: 380 });
				// Position is shared: the widget should not move when the queue advances.
				expect(state.floatPosition).toEqual({ top: 10, left: 10 });
			});

			it('never stores a height, because the media decides it', () => {
				const set = vi.fn();
				(window as unknown as { maestro: unknown }).maestro = { settings: { set } };
				initial.setFloatGeometry('audio', FLOAT);
				expect(set.mock.calls[0][1]).not.toHaveProperty('height');
			});

			it('survives a missing settings bridge', () => {
				(window as unknown as { maestro?: unknown }).maestro = undefined;
				expect(() => initial.setFloatGeometry('audio', FLOAT)).not.toThrow();
				expect(useMediaPlaybackStore.getState().floatPosition).toEqual({ top: 40, left: 50 });
			});
		});

		describe('float footprint', () => {
			const FOOTPRINT = { fromBottom: 156, fromRight: 24, width: 380, viewportHeight: 900 };

			it('publishes where the widget landed, for the toast lane to step over', () => {
				initial.setFloatFootprint(FOOTPRINT);
				expect(useMediaPlaybackStore.getState().floatFootprint).toEqual(FOOTPRINT);
			});

			it('ignores a repeat of the same rect', () => {
				// A drag republishes on every mousemove, and the toast stack subscribes
				// to this - an unchanged rect must not re-render it.
				initial.setFloatFootprint(FOOTPRINT);
				const first = useMediaPlaybackStore.getState().floatFootprint;
				initial.setFloatFootprint({ ...FOOTPRINT });
				expect(useMediaPlaybackStore.getState().floatFootprint).toBe(first);
			});

			it('takes a rect that actually moved', () => {
				initial.setFloatFootprint(FOOTPRINT);
				initial.setFloatFootprint({ ...FOOTPRINT, fromBottom: 300 });
				expect(useMediaPlaybackStore.getState().floatFootprint?.fromBottom).toBe(300);
			});

			it('clears when the widget leaves the screen', () => {
				initial.setFloatFootprint(FOOTPRINT);
				initial.setFloatFootprint(null);
				expect(useMediaPlaybackStore.getState().floatFootprint).toBeNull();
			});
		});

		describe('durations', () => {
			it('remembers how long a file is', () => {
				initial.rememberDuration('a', 266.7);
				expect(useMediaPlaybackStore.getState().durations.a).toBe(266.7);
			});

			it('ignores a live stream, which has no length to show', () => {
				initial.rememberDuration('a', Number.POSITIVE_INFINITY);
				initial.rememberDuration('b', 0);
				expect(useMediaPlaybackStore.getState().durations).toEqual({});
			});

			it('re-reporting the same length does not churn state', () => {
				initial.rememberDuration('a', 100);
				const before = useMediaPlaybackStore.getState();
				initial.rememberDuration('a', 100);
				expect(useMediaPlaybackStore.getState()).toBe(before);
			});

			it('survives its file leaving the queue, so history can still show it', () => {
				const r = request();
				initial.openMedia(r);
				initial.rememberDuration(idOf(r), 100);
				initial.closeItem(idOf(r));
				expect(useMediaPlaybackStore.getState().durations[idOf(r)]).toBe(100);
			});
		});

		describe('aspect ratios', () => {
			it('remembers a video shape per item, so returning to it fits at once', () => {
				initial.rememberAspect('vid', 4 / 3);
				expect(useMediaPlaybackStore.getState().aspects.vid).toBeCloseTo(4 / 3);
			});

			it('rejects nonsense rather than shaping the widget like a ruler', () => {
				initial.rememberAspect('vid', 0);
				expect(useMediaPlaybackStore.getState().aspects.vid).toBeCloseTo(16 / 9);
			});

			it('re-reporting the same shape does not churn state', () => {
				initial.rememberAspect('vid', 16 / 9);
				const before = useMediaPlaybackStore.getState();
				initial.rememberAspect('vid', 16 / 9);
				expect(useMediaPlaybackStore.getState()).toBe(before);
			});
		});

		describe('enqueueMedia', () => {
			it('appends without interrupting what is playing', () => {
				const a = request();
				const b = request({ path: '/files/b.mp4', name: 'b.mp4', kind: 'video' });
				initial.openMedia(a);
				initial.consumeAutoplay();
				initial.setPlaying(true);

				expect(initial.enqueueMedia([b])).toBe(1);

				const state = useMediaPlaybackStore.getState();
				expect(state.items.map((i) => i.id)).toEqual([idOf(a), idOf(b)]);
				// The whole point of queueing: the mp3 keeps playing.
				expect(state.activeItemId).toBe(idOf(a));
				expect(state.playing).toBe(true);
				expect(state.pendingAutoplay).toBe(false);
			});

			it('brings a hidden player back, without disturbing what is loaded', () => {
				const a = request();
				initial.openMedia(a);
				initial.consumeAutoplay();
				initial.setPlaying(true);
				// Minimized to the header, or restored from disk and never touched:
				// either way there is no widget on screen to queue into.
				useMediaPlaybackStore.setState({ dismissed: true, dormant: true });

				initial.enqueueMedia([request({ path: '/files/b.mp4', name: 'b.mp4', kind: 'video' })]);

				const state = useMediaPlaybackStore.getState();
				expect(state.dismissed).toBe(false);
				expect(state.dormant).toBe(false);
				// Un-hiding is not interrupting.
				expect(state.activeItemId).toBe(idOf(a));
				expect(state.playing).toBe(true);
				expect(state.pendingAutoplay).toBe(false);
			});

			it('shows the player even when every file was already queued', () => {
				// The retry case: queueing did nothing visible, so the user does it
				// again with the same files. Nothing is added the second time, and
				// bailing on that is what made the command look permanently broken.
				const a = request();
				const b = request({ path: '/files/b.mp4', name: 'b.mp4', kind: 'video' });
				initial.openMedia(a);
				initial.enqueueMedia([b]);
				useMediaPlaybackStore.setState({ dismissed: true, dormant: true });

				expect(initial.enqueueMedia([b])).toBe(0);

				const state = useMediaPlaybackStore.getState();
				expect(state.dismissed).toBe(false);
				expect(state.dormant).toBe(false);
				expect(state.items.map((i) => i.id)).toEqual([idOf(a), idOf(b)]);
			});

			it('re-queueing into a visible player changes nothing at all', () => {
				const a = request();
				initial.openMedia(a);
				initial.consumeAutoplay();
				const before = useMediaPlaybackStore.getState();

				expect(initial.enqueueMedia([a])).toBe(0);
				expect(useMediaPlaybackStore.getState()).toBe(before);
			});

			it('loads a requested file the queue already holds when the player is idle', () => {
				// Closing the loaded track leaves the rest of the queue behind with
				// nothing active. Queueing one of those files again must put it in the
				// player rather than reporting "already queued" and showing nothing.
				const a = request();
				const b = request({ path: '/files/b.mp4', name: 'b.mp4', kind: 'video' });
				initial.enqueueMedia([a, b]);
				initial.closeItem(idOf(a));

				expect(initial.enqueueMedia([b])).toBe(0);
				expect(useMediaPlaybackStore.getState().activeItemId).toBe(idOf(b));
				expect(useMediaPlaybackStore.getState().dismissed).toBe(false);
			});

			it('loads the first file when the player is idle, so the queue is reachable', () => {
				const a = request();
				expect(initial.enqueueMedia([a])).toBe(1);

				const state = useMediaPlaybackStore.getState();
				expect(state.activeItemId).toBe(idOf(a));
				expect(state.dismissed).toBe(false);
				// Queueing is not a request to listen, so it does not start itself.
				expect(state.pendingAutoplay).toBe(false);
			});

			it('leaves an already-queued file where it is', () => {
				const a = request();
				const b = request({ path: '/files/b.mp3', name: 'b.mp3' });
				initial.enqueueMedia([a, b]);
				expect(initial.enqueueMedia([a])).toBe(0);
				expect(useMediaPlaybackStore.getState().items.map((i) => i.id)).toEqual([idOf(a), idOf(b)]);
			});

			it('loads the track just queued when idle, not a leftover queue entry', () => {
				// After closing the loaded track the queue can still hold others. Queueing
				// something new must load THAT, not whatever happens to sit at index 0.
				const old = request({ path: '/files/old.mp3', name: 'old.mp3' });
				const fresh = request({ path: '/files/fresh.mp4', name: 'fresh.mp4', kind: 'video' });
				initial.enqueueMedia([old]);
				initial.closeItem(idOf(old));
				initial.enqueueMedia([request({ path: '/files/leftover.mp3', name: 'leftover.mp3' })]);
				initial.closeItem(mediaItemId('s1', '/files/leftover.mp3'));
				// Queue two so there is a leftover ahead of the new one.
				initial.enqueueMedia([old]);
				initial.closeItem(idOf(old));

				initial.enqueueMedia([fresh]);
				expect(useMediaPlaybackStore.getState().activeItemId).toBe(idOf(fresh));
			});

			it('never starts playback, whatever the loaded track is doing', () => {
				const a = request();
				const b = request({ path: '/files/b.mp4', name: 'b.mp4', kind: 'video' });
				initial.openMedia(a);
				initial.consumeAutoplay();

				// Paused is still "the track the user is on" - queueing behind it must
				// not yank the player away.
				initial.setPlaying(false);
				initial.enqueueMedia([b]);
				expect(useMediaPlaybackStore.getState().activeItemId).toBe(idOf(a));
				expect(useMediaPlaybackStore.getState().pendingAutoplay).toBe(false);
			});

			it('does not touch history - nothing has been played', () => {
				initial.enqueueMedia([request({ path: '/files/b.mp3', name: 'b.mp3' })]);
				expect(useMediaPlaybackStore.getState().history).toEqual([]);
			});

			it('un-hides a minimized player without interrupting it', () => {
				const a = request();
				initial.openMedia(a);
				initial.consumeAutoplay();
				initial.setPlaying(true);
				initial.dismiss();

				initial.enqueueMedia([request({ path: '/files/b.mp3', name: 'b.mp3' })]);

				const state = useMediaPlaybackStore.getState();
				expect(state.dismissed).toBe(false);
				expect(state.activeItemId).toBe(idOf(a));
				expect(state.playing).toBe(true);
			});

			it('shows the player even when every file was already queued', () => {
				// Re-running "queue these" must still answer by showing the player,
				// or the retry looks exactly like the command doing nothing.
				const a = request();
				initial.enqueueMedia([a]);
				initial.dismiss();

				expect(initial.enqueueMedia([a])).toBe(0);
				expect(useMediaPlaybackStore.getState().dismissed).toBe(false);
			});

			it('loads the requested file paused when idle, even if it was already queued', () => {
				const a = request();
				const b = request({ path: '/files/b.mp3', name: 'b.mp3' });
				initial.enqueueMedia([a, b]);
				// Closing the loaded track releases the player; b is still queued.
				initial.closeItem(idOf(a));
				expect(useMediaPlaybackStore.getState().activeItemId).toBeNull();

				expect(initial.enqueueMedia([b])).toBe(0);

				const state = useMediaPlaybackStore.getState();
				expect(state.activeItemId).toBe(idOf(b));
				expect(state.pendingAutoplay).toBe(false);
			});

			it('queues nothing for an empty list', () => {
				const before = useMediaPlaybackStore.getState();
				expect(initial.enqueueMedia([])).toBe(0);
				expect(useMediaPlaybackStore.getState()).toBe(before);
			});

			it('caps the queue, keeping the loaded file', () => {
				const first = request({ path: '/files/first.mp3', name: 'first.mp3' });
				initial.openMedia(first);
				initial.enqueueMedia(
					Array.from({ length: MEDIA_QUEUE_LIMIT + 5 }, (_, i) =>
						request({ path: `/files/q${i}.mp3`, name: `q${i}.mp3` })
					)
				);

				const state = useMediaPlaybackStore.getState();
				expect(state.items).toHaveLength(MEDIA_QUEUE_LIMIT + 1);
				expect(state.items.some((i) => i.id === idOf(first))).toBe(true);
			});
		});

		describe('advanceAfterEnded', () => {
			it('hands off to the next queued item and plays it', () => {
				const a = request();
				const b = request({ path: '/files/b.mp4', name: 'b.mp4', kind: 'video' });
				initial.openMedia(a);
				initial.enqueueMedia([b]);

				initial.advanceAfterEnded();

				const state = useMediaPlaybackStore.getState();
				expect(state.activeItemId).toBe(idOf(b));
				expect(state.pendingAutoplay).toBe(true);
			});

			it('rewinds the finished file, so coming back to it plays something', () => {
				const a = request();
				initial.openMedia(a);
				initial.rememberTime(idOf(a), 300);
				initial.advanceAfterEnded();
				expect(useMediaPlaybackStore.getState().resumeTimes[idOf(a)]).toBe(0);
			});

			it('stays put at the end of the queue rather than going blank', () => {
				const a = request();
				initial.openMedia(a);
				initial.advanceAfterEnded();
				expect(useMediaPlaybackStore.getState().activeItemId).toBe(idOf(a));
			});

			it('does nothing with no loaded item', () => {
				expect(() => initial.advanceAfterEnded()).not.toThrow();
				expect(useMediaPlaybackStore.getState().activeItemId).toBeNull();
			});
		});

		describe('list maintenance', () => {
			it('clearQueue drops what is queued and keeps the track playing', () => {
				const a = request();
				const b = request({ path: '/files/b.mp3', name: 'b.mp3' });
				initial.openMedia(a);
				initial.enqueueMedia([b]);
				initial.setPlaying(true);
				initial.clearQueue();

				const state = useMediaPlaybackStore.getState();
				// "Clear" empties what plays NEXT. Stopping the music is what the close
				// button does, and it is one button away.
				expect(state.items.map((i) => i.id)).toEqual([idOf(a)]);
				expect(state.activeItemId).toBe(idOf(a));
				expect(state.playing).toBe(true);
			});

			it('clearQueue keeps the loaded track resume position, drops the rest', () => {
				const a = request();
				const b = request({ path: '/files/b.mp3', name: 'b.mp3' });
				initial.openMedia(a);
				initial.enqueueMedia([b]);
				initial.rememberTime(idOf(a), 42);
				initial.rememberTime(idOf(b), 10);
				initial.clearQueue();

				const state = useMediaPlaybackStore.getState();
				expect(state.resumeTimes[idOf(a)]).toBe(42);
				expect(state.resumeTimes[idOf(b)]).toBeUndefined();
			});

			it('clearQueue with nothing queued behind is a no-op', () => {
				initial.openMedia(request());
				const before = useMediaPlaybackStore.getState();
				initial.clearQueue();
				expect(useMediaPlaybackStore.getState()).toBe(before);
			});

			it('closing the loaded track records it as played', () => {
				// It left the player, same as if the next one had started. Without this,
				// playing something and then closing it vanishes from "recently played".
				const a = request();
				initial.openMedia(a);
				initial.closeItem(idOf(a));
				expect(useMediaPlaybackStore.getState().history.map((h) => h.id)).toEqual([idOf(a)]);
			});

			it('closing a queued track that never played leaves history alone', () => {
				const a = request();
				const b = request({ path: '/files/b.mp3', name: 'b.mp3' });
				initial.openMedia(a);
				initial.enqueueMedia([b]);
				initial.closeItem(idOf(b));
				expect(useMediaPlaybackStore.getState().history).toEqual([]);
			});

			it('removing a history entry leaves the queue alone', () => {
				const a = request();
				initial.openMedia(a);
				initial.removeHistoryItem(idOf(a));

				const state = useMediaPlaybackStore.getState();
				expect(state.history).toEqual([]);
				expect(state.items).toHaveLength(1);
			});

			it('clearHistory forgets everything played', () => {
				initial.openMedia(request());
				initial.clearHistory();
				expect(useMediaPlaybackStore.getState().history).toEqual([]);
				expect(useMediaPlaybackStore.getState().items).toHaveLength(1);
			});

			it('selectActiveMediaItem resolves the loaded entry', () => {
				expect(selectActiveMediaItem(useMediaPlaybackStore.getState())).toBeNull();
				initial.openMedia(request());
				expect(selectActiveMediaItem(useMediaPlaybackStore.getState())?.name).toBe('a.mp3');
			});
		});

		describe('queue persistence', () => {
			beforeEach(() => {
				vi.useFakeTimers();
			});

			afterEach(() => {
				vi.useRealTimers();
			});

			it('writes the queue, the loaded item, and remembered positions', () => {
				const set = vi.fn();
				(window as unknown as { maestro: unknown }).maestro = { settings: { set } };

				const r = request();
				initial.openMedia(r);
				initial.rememberTime(idOf(r), 12);
				initial.rememberDuration(idOf(r), 266);
				vi.advanceTimersByTime(600);

				expect(set).toHaveBeenCalledTimes(1);
				const [key, payload] = set.mock.calls[0];
				expect(key).toBe(MEDIA_QUEUE_SETTINGS_KEY);
				expect(payload.activeItemId).toBe(idOf(r));
				expect(payload.items).toHaveLength(1);
				expect(payload.resumeTimes[idOf(r)]).toBe(12);
				// Lengths are stored too: only the loaded file is ever mounted, so a
				// restored queue would otherwise show `--:--` for every other row.
				expect(payload.durations[idOf(r)]).toBe(266);
				// History is per-boot, so it must never reach disk.
				expect(payload).not.toHaveProperty('history');
			});

			it('prunes stored lengths to the queue, so disk does not grow forever', () => {
				const set = vi.fn();
				(window as unknown as { maestro: unknown }).maestro = { settings: { set } };

				const r = request();
				initial.openMedia(r);
				initial.rememberDuration(idOf(r), 266);
				initial.closeItem(idOf(r));
				vi.advanceTimersByTime(600);

				const payload = set.mock.calls[set.mock.calls.length - 1][1];
				expect(payload.durations).toEqual({});
				// Still in memory, so the history row keeps its time.
				expect(useMediaPlaybackStore.getState().durations[idOf(r)]).toBe(266);
			});

			it('collapses a burst of position updates into one write', () => {
				const set = vi.fn();
				(window as unknown as { maestro: unknown }).maestro = { settings: { set } };

				initial.openMedia(request());
				for (let i = 1; i <= 10; i++) initial.rememberTime(idOf(request()), i);
				vi.advanceTimersByTime(600);

				expect(set).toHaveBeenCalledTimes(1);
			});

			it('flushes on demand, so a closing window does not lose the queue', () => {
				const set = vi.fn();
				(window as unknown as { maestro: unknown }).maestro = { settings: { set } };

				initial.openMedia(request());
				flushMediaQueuePersist();
				expect(set).toHaveBeenCalledTimes(1);

				// Nothing pending: a second flush must not write again.
				flushMediaQueuePersist();
				expect(set).toHaveBeenCalledTimes(1);
			});
		});
	});
});
