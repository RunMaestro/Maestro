import { describe, expect, it } from 'vitest';
import { editorInvocation, resolveEditorCommand, runEditor } from '../editor';

describe('the editor command (AR-2)', () => {
	it('prefers VISUAL, then EDITOR, then vi', () => {
		expect(resolveEditorCommand({ VISUAL: 'nvim', EDITOR: 'nano' })).toBe('nvim');
		expect(resolveEditorCommand({ EDITOR: 'nano' })).toBe('nano');
		expect(resolveEditorCommand({ VISUAL: '  ', EDITOR: '' })).toBe('vi');
		expect(resolveEditorCommand({})).toBe('vi');
	});

	it('keeps the editor words and quotes the path', () => {
		expect(editorInvocation("/p/it's here.md", { EDITOR: 'code -w' })).toBe(
			`code -w ${"'/p/it'\\''s here.md'"}`
		);
	});

	it('resolves ok when the editor exits cleanly and says why when it does not', async () => {
		expect(await runEditor('/tmp/x.md', { EDITOR: 'true' })).toEqual({ ok: true });
		const failed = await runEditor('/tmp/x.md', { EDITOR: 'false' });
		expect(failed.ok).toBe(false);
		expect(!failed.ok && failed.message).toContain('exited with code 1');
		const missing = await runEditor('/tmp/x.md', { EDITOR: 'maestro-no-such-editor-xyz' });
		expect(missing.ok).toBe(false);
		expect(!missing.ok && missing.message).toContain('code 127');
	});
});
