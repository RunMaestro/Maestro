/**
 * @file fileCategories.test.ts
 * @description Tests for the shared extension -> category table.
 *
 * The invariant that matters here is that `isPreviewableFile` and
 * `getFileCategory` are two views of ONE answer. If they can disagree, a file
 * either shows up under a pill and refuses to open, or is openable but
 * reachable only through `All`.
 */

import { describe, it, expect } from 'vitest';
import {
	FILE_CATEGORIES,
	LAUNCHABLE_FILE_EXTENSIONS,
	getFileCategory,
	getFileExtension,
	isLaunchableFile,
	isPreviewableFile,
	matchesFileCategory,
} from '../../shared/fileCategories';

describe('getFileExtension', () => {
	it('lowercases the extension', () => {
		expect(getFileExtension('Report.PDF')).toBe('pdf');
	});

	it('ignores dots in parent directories', () => {
		expect(getFileExtension('/a.b.c/dir/Makefile')).toBe('');
	});

	it('treats a leading dot as part of the name, not a separator', () => {
		expect(getFileExtension('.gitignore')).toBe('');
	});

	it('takes the last extension of a multi-part name', () => {
		expect(getFileExtension('archive.tar.gz')).toBe('gz');
	});
});

describe('getFileCategory', () => {
	it.each([
		['App.tsx', 'code'],
		['main.py', 'code'],
		['styles.scss', 'code'],
		['deploy.sh', 'code'],
		['Dockerfile', 'code'],
		['Makefile', 'code'],
		['README.md', 'docs'],
		['spec.rst', 'docs'],
		['contract.pdf', 'docs'],
		['LICENSE', 'docs'],
		['package.json', 'data'],
		['cue.yaml', 'data'],
		['rows.csv', 'data'],
		['events.parquet', 'data'],
		['app.log', 'data'],
		['.gitignore', 'data'],
		['.env', 'data'],
		['diagram.svg', 'media'],
		['shot.PNG', 'media'],
		['theme.mp3', 'media'],
		['demo.mp4', 'media'],
	])('classifies %s as %s', (name, expected) => {
		expect(getFileCategory(name)).toBe(expected);
	});

	it.each(['program.exe', 'data.bin', 'archive.zip', 'raw.mkv', 'lib.so'])(
		'returns null for %s, which Maestro cannot open',
		(name) => {
			expect(getFileCategory(name)).toBeNull();
		}
	);

	it('classifies by basename, not by the path around it', () => {
		expect(getFileCategory('/Users/x/notes.md/actually.ts')).toBe('code');
	});
});

describe('isPreviewableFile', () => {
	it('agrees with getFileCategory on every sample', () => {
		const samples = [
			'App.tsx',
			'README.md',
			'package.json',
			'shot.png',
			'theme.mp3',
			'program.exe',
			'archive.zip',
		];
		for (const name of samples) {
			expect(isPreviewableFile(name)).toBe(getFileCategory(name) !== null);
		}
	});
});

describe('matchesFileCategory', () => {
	it('passes everything under "all"', () => {
		expect(matchesFileCategory('program.exe', 'all')).toBe(true);
		expect(matchesFileCategory('App.tsx', 'all')).toBe(true);
	});

	it('passes only the file’s own bucket', () => {
		const matched = FILE_CATEGORIES.filter((key) => matchesFileCategory('App.tsx', key));
		expect(matched).toEqual(['code']);
	});
});

describe('isLaunchableFile', () => {
	// The app bundles, scripts and installers the open path must reveal, never open.
	const launchable = [
		'/Applications/Calculator.app',
		'/tmp/run.command',
		'/tmp/run.tool',
		'/tmp/install.sh',
		'/tmp/install.zsh',
		'/tmp/install.bash',
		'/tmp/do.scpt',
		'/tmp/do.applescript',
		'/tmp/Do.workflow',
		'/tmp/Installer.pkg',
		'/tmp/Installer.mpkg',
		'/tmp/Disk.dmg',
		'C:\\Users\\me\\setup.exe',
		'C:\\Users\\me\\setup.msi',
		'C:\\Users\\me\\run.bat',
		'C:\\Users\\me\\run.cmd',
		'C:\\Users\\me\\run.ps1',
		'C:\\Users\\me\\run.vbs',
		'C:\\Users\\me\\Desktop\\App.lnk',
		'/home/me/app.desktop',
		'/home/me/Tool.AppImage',
		// Same classes, not in the original list
		'/tmp/Profile.terminal',
		'/tmp/tool.jar',
		'/tmp/Target.fileloc',
		'C:\\Users\\me\\Link.url',
		'C:\\Users\\me\\screensaver.scr',
		'C:\\Users\\me\\page.hta',
		'C:\\Users\\me\\console.msc',
		'C:\\Users\\me\\Downloads\\image.iso',
		'C:\\Users\\me\\Downloads\\disk.vhdx',
	];

	it.each(launchable)('counts %s as launchable', (filePath) => {
		expect(isLaunchableFile(filePath, { windows: false })).toBe(true);
		expect(isLaunchableFile(filePath, { windows: true })).toBe(true);
	});

	it('ignores the case of the extension', () => {
		expect(isLaunchableFile('/tmp/INSTALL.SH', { windows: false })).toBe(true);
		expect(isLaunchableFile('/tmp/Setup.EXE', { windows: false })).toBe(true);
		expect(isLaunchableFile('/home/me/tool.appimage', { windows: false })).toBe(true);
	});

	it('counts Windows scripts, ClickOnce, and App Installer packages only on Windows', () => {
		for (const name of [
			'C:\\Users\\me\\run.js',
			'C:\\Users\\me\\run.jse',
			'C:\\Users\\me\\Launch.appref-ms',
			'C:\\Users\\me\\Setup.application',
			'C:\\Users\\me\\App.appinstaller',
			'C:\\Users\\me\\App.msixbundle',
			'C:\\Users\\me\\App.appxbundle',
		]) {
			expect(isLaunchableFile(name, { windows: true })).toBe(true);
			expect(isLaunchableFile(name, { windows: false })).toBe(false);
		}
	});

	it('counts leading-dot executable basenames such as .exe on Windows without affecting dotfiles like .bashrc', () => {
		for (const name of ['C:\\Temp\\.exe', 'C:\\Temp\\.exe.', 'C:\\Temp\\.exe::$DATA']) {
			expect(isLaunchableFile(name, { windows: true })).toBe(true);
		}
		expect(isLaunchableFile('/tmp/.bashrc', { windows: false })).toBe(false);
		expect(isLaunchableFile('C:\\Users\\me\\.bashrc', { windows: true })).toBe(false);
	});

	it('reads a name the way Windows opens it: no trailing dots, spaces or stream suffix', () => {
		for (const name of [
			'C:\\Users\\me\\setup.exe.',
			'C:\\Users\\me\\setup.exe . .',
			'C:\\Users\\me\\setup.exe ',
			'C:\\Users\\me\\setup.exe::$DATA',
			'C:\\Users\\me\\setup.exe:Zone.Identifier',
			'C:/Users/me/run.js.',
		]) {
			expect(isLaunchableFile(name, { windows: true })).toBe(true);
		}
		// Elsewhere those trailing characters are part of a different name.
		expect(isLaunchableFile('/tmp/setup.exe.', { windows: false })).toBe(false);
		expect(isLaunchableFile('C:\\Users\\me\\report.pdf.', { windows: true })).toBe(false);
		expect(isLaunchableFile('C:\\Users\\me\\report.pdf:Zone.Identifier', { windows: true })).toBe(
			false
		);
	});

	it('defaults the .js rule to the platform it runs on', () => {
		expect(isLaunchableFile('/tmp/run.js')).toBe(process.platform === 'win32');
	});

	it('sees an app bundle named with a trailing separator', () => {
		expect(isLaunchableFile('/Applications/Calculator.app/', { windows: false })).toBe(true);
		expect(isLaunchableFile('C:\\Tools\\Thing.app\\', { windows: true })).toBe(true);
	});

	it.each([
		'/tmp/report.pdf',
		'/tmp/notes.md',
		'/repo/src/App.tsx',
		'/repo/data.json',
		'/tmp/photo.png',
		'/tmp/archive.zip',
		'/repo/Makefile',
		'/home/me/.bashrc',
		'/tmp/song.mp3',
	])('does not count %s', (filePath) => {
		expect(isLaunchableFile(filePath, { windows: true })).toBe(false);
		expect(isLaunchableFile(filePath, { windows: false })).toBe(false);
	});

	it('judges the file name, not a dot in a parent folder', () => {
		expect(isLaunchableFile('/Applications/Calculator.app/Contents/Info.plist')).toBe(false);
		expect(isLaunchableFile('/tmp/build.sh.d/readme.txt')).toBe(false);
	});

	it('keeps scripts previewable: launchable and code are separate questions', () => {
		expect(getFileCategory('/tmp/install.sh')).toBe('code');
		expect(isLaunchableFile('/tmp/install.sh')).toBe(true);
	});

	it('lists every extension in lowercase, without a dot', () => {
		for (const ext of LAUNCHABLE_FILE_EXTENSIONS) {
			expect(ext).toBe(ext.toLowerCase());
			expect(ext.startsWith('.')).toBe(false);
		}
	});
});
