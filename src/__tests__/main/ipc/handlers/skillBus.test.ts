import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ipcMain } from 'electron';
import { registerSkillBusHandlers } from '../../../../main/ipc/handlers/skillBus';

const mockGetSkillBusStatus = vi.fn();
const mockRecordSkillBusRun = vi.fn();

vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
	},
}));

vi.mock('../../../../main/skill-bus', () => ({
	getSkillBusStatus: (...args: unknown[]) => mockGetSkillBusStatus(...args),
	recordSkillBusRun: (...args: unknown[]) => mockRecordSkillBusRun(...args),
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

describe('skill bus IPC handlers', () => {
	let handlers: Map<string, Function>;

	beforeEach(() => {
		vi.clearAllMocks();
		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: Function) => {
			handlers.set(channel, handler);
		});
		registerSkillBusHandlers();
	});

	it('registers status and recordRun handlers', () => {
		expect(handlers.has('skillBus:status')).toBe(true);
		expect(handlers.has('skillBus:recordRun')).toBe(true);
	});

	it('returns skill bus status', async () => {
		mockGetSkillBusStatus.mockReturnValue({
			available: true,
			scriptPath: '/tmp/skill-bus-record.sh',
		});

		const result = await handlers.get('skillBus:status')!({} as never);

		expect(mockGetSkillBusStatus).toHaveBeenCalled();
		expect(result).toEqual({
			available: true,
			scriptPath: '/tmp/skill-bus-record.sh',
		});
	});

	it('records a skill bus run', async () => {
		mockRecordSkillBusRun.mockResolvedValue({ success: true });
		const payload = {
			skillName: 'maestro-autorun',
			result: 'partial',
			score: 0.7,
			task: 'Desktop Auto Run: [Agent] [WARN] summary',
		};

		const result = await handlers.get('skillBus:recordRun')!({} as never, payload);

		expect(mockRecordSkillBusRun).toHaveBeenCalledWith(payload);
		expect(result).toEqual({ success: true });
	});
});
