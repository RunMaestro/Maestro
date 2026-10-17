/**
 * @file wake-enrollment-store.test.ts
 *
 * Where a user's own wake phrase lives on disk: the recordings, the trained
 * model, and the one number the always-on listener reads synchronously.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
	ENROLLED_WAKE_MODEL_VERSION,
	type EnrolledWakeModel,
} from '../../../../main/acappella/wake/enrolled-wake-model';
import {
	addWakeBackground,
	addWakeClip,
	clearWakeBackground,
	deleteEnrolledWakeModel,
	deleteWakeEnrollment,
	enrolledWakeRevision,
	hasEnrolledWakeModel,
	listWakeEnrollments,
	loadEnrolledWakeModel,
	readWakeBackground,
	readWakeClips,
	readWakeEnrollmentSummary,
	removeLastWakeClip,
	saveEnrolledWakeModel,
	setWakeEnrollmentRoot,
} from '../../../../main/acappella/wake/wake-enrollment-store';
import { wakePhraseKey } from '../../../../shared/acappella/wake-enrollment';

const PHRASE = 'Hey Scout';

function model(overrides: Partial<EnrolledWakeModel> = {}): EnrolledWakeModel {
	return {
		version: ENROLLED_WAKE_MODEL_VERSION,
		phrase: PHRASE,
		key: wakePhraseKey(PHRASE),
		trainedAt: 1_700_000_000_000,
		frames: 2,
		width: 3,
		mean: Float32Array.from([0.5, -0.25, 1]),
		templates: Float32Array.from([
			0.1, 0.2, 0.3, 0.4, 0.5, 0.6, -0.1, -0.2, -0.3, -0.4, -0.5, -0.6,
		]),
		count: 2,
		midpoint: 0.75,
		steepness: 20,
		report: {
			clipsUsed: 9,
			clipsTotal: 10,
			recognized: 9,
			falseAlarms: 0,
			backgroundMs: 30_000,
			quality: 'strong',
		},
		...overrides,
	};
}

let root: string;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), 'wake-enrollment-'));
	setWakeEnrollmentRoot(root);
});

afterEach(async () => {
	setWakeEnrollmentRoot(null);
	await fs.rm(root, { recursive: true, force: true });
});

describe('recordings', () => {
	it('keeps each take as its own file and reads them back in order', async () => {
		await addWakeClip(PHRASE, Int16Array.from([1, 2, 3]));
		await addWakeClip(PHRASE, Int16Array.from([4, 5]));

		const clips = await readWakeClips(PHRASE);
		expect(clips.map((clip) => Array.from(clip))).toEqual([
			[1, 2, 3],
			[4, 5],
		]);
		// Filed under the phrase's key, whatever the spelling.
		expect(await readWakeClips('hey, scout!')).toHaveLength(2);
		expect(await fs.readdir(path.join(root, wakePhraseKey(PHRASE), 'clips'))).toEqual([
			'0001.wav',
			'0002.wav',
		]);
	});

	it('removes the newest take and never reuses its number', async () => {
		await addWakeClip(PHRASE, Int16Array.from([1]));
		await addWakeClip(PHRASE, Int16Array.from([2]));

		expect(await removeLastWakeClip(PHRASE)).toBe(true);
		expect((await readWakeClips(PHRASE)).map((clip) => clip[0])).toEqual([1]);
		await addWakeClip(PHRASE, Int16Array.from([3]));
		expect((await readWakeClips(PHRASE)).map((clip) => clip[0])).toEqual([1, 3]);

		await removeLastWakeClip(PHRASE);
		await removeLastWakeClip(PHRASE);
		expect(await removeLastWakeClip(PHRASE)).toBe(false);
	});

	it('joins the other speech across runs and can drop it', async () => {
		await addWakeBackground(PHRASE, new Int16Array(16000).fill(7));
		await addWakeBackground(PHRASE, new Int16Array(8000).fill(9));

		const background = await readWakeBackground(PHRASE);
		expect(background.length).toBe(24000);
		expect(background[0]).toBe(7);
		expect(background[23999]).toBe(9);

		await clearWakeBackground(PHRASE);
		expect((await readWakeBackground(PHRASE)).length).toBe(0);
	});

	it('summarises what is on disk without a model', async () => {
		expect(await readWakeEnrollmentSummary(PHRASE)).toEqual({
			clips: 0,
			backgroundMs: 0,
			model: null,
		});

		await addWakeClip(PHRASE, new Int16Array(4000));
		await addWakeBackground(PHRASE, new Int16Array(16000 * 3));
		expect(await readWakeEnrollmentSummary(PHRASE)).toEqual({
			clips: 1,
			backgroundMs: 3000,
			model: null,
		});
	});

	it('refuses a phrase with nothing sayable in it', async () => {
		await expect(addWakeClip(' ... ', new Int16Array(10))).rejects.toThrow(/nothing sayable/);
		expect(await readWakeClips(' ... ')).toEqual([]);
		expect(await removeLastWakeClip(' ... ')).toBe(false);
	});
});

describe('the trained model', () => {
	it('round-trips every number', async () => {
		const saved = model();
		await saveEnrolledWakeModel(saved);

		const loaded = await loadEnrolledWakeModel('hey scout');
		expect(loaded).not.toBeNull();
		expect(Array.from(loaded!.templates)).toEqual(Array.from(saved.templates));
		expect(Array.from(loaded!.mean)).toEqual(Array.from(saved.mean));
		expect({ ...loaded!, templates: null, mean: null }).toEqual({
			...saved,
			templates: null,
			mean: null,
		});
		expect((await readWakeEnrollmentSummary(PHRASE)).model).toEqual({
			trainedAt: saved.trainedAt,
			report: saved.report,
		});
	});

	it('answers the revision synchronously, and keeps it current', async () => {
		expect(enrolledWakeRevision(PHRASE)).toBeNull();
		expect(hasEnrolledWakeModel(PHRASE)).toBe(false);

		await saveEnrolledWakeModel(model());
		expect(enrolledWakeRevision('HEY SCOUT')).toBe(1_700_000_000_000);
		expect(hasEnrolledWakeModel(PHRASE)).toBe(true);

		await saveEnrolledWakeModel(model({ trainedAt: 1_700_000_000_999 }));
		expect(enrolledWakeRevision(PHRASE)).toBe(1_700_000_000_999);
	});

	it('reads the revision from disk in a process that did not write it', async () => {
		await saveEnrolledWakeModel(model());
		// A fresh process has no memory of the save: same directory, cold cache.
		setWakeEnrollmentRoot(root);

		expect(enrolledWakeRevision(PHRASE)).toBe(1_700_000_000_000);
	});

	it('treats a model whose examples are missing or mismatched as untrained', async () => {
		await saveEnrolledWakeModel(model());
		const dir = path.join(root, wakePhraseKey(PHRASE));

		await fs.writeFile(path.join(dir, 'templates.f32'), new Uint8Array(8));
		expect(await loadEnrolledWakeModel(PHRASE)).toBeNull();

		await fs.rm(path.join(dir, 'templates.f32'));
		expect(await loadEnrolledWakeModel(PHRASE)).toBeNull();
	});

	it('ignores a model from a version this build cannot score', async () => {
		await saveEnrolledWakeModel(model({ version: 99 as never }));
		setWakeEnrollmentRoot(root);

		expect(await loadEnrolledWakeModel(PHRASE)).toBeNull();
		expect(enrolledWakeRevision(PHRASE)).toBeNull();
	});

	it('forgets the model and keeps the recordings', async () => {
		await addWakeClip(PHRASE, new Int16Array(100));
		await saveEnrolledWakeModel(model());

		await deleteEnrolledWakeModel(PHRASE);
		expect(await loadEnrolledWakeModel(PHRASE)).toBeNull();
		expect(hasEnrolledWakeModel(PHRASE)).toBe(false);
		expect(await readWakeClips(PHRASE)).toHaveLength(1);
	});
});

describe('whole phrases', () => {
	it('lists phrases as they were typed and deletes one entirely', async () => {
		await addWakeClip('Hey Scout', new Int16Array(100));
		await addWakeClip('okay maestro', new Int16Array(100));
		await saveEnrolledWakeModel(model());

		expect((await listWakeEnrollments()).sort()).toEqual(['Hey Scout', 'okay maestro']);

		await deleteWakeEnrollment('hey scout');
		expect(await listWakeEnrollments()).toEqual(['okay maestro']);
		expect(hasEnrolledWakeModel('Hey Scout')).toBe(false);
		expect(await readWakeEnrollmentSummary('Hey Scout')).toEqual({
			clips: 0,
			backgroundMs: 0,
			model: null,
		});
	});

	it('lists nothing before anything was recorded', async () => {
		setWakeEnrollmentRoot(path.join(root, 'never-created'));
		expect(await listWakeEnrollments()).toEqual([]);
	});
});
