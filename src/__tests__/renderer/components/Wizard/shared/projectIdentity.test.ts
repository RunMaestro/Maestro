import { describe, expect, it } from 'vitest';
import {
	defaultAgentNameForPath,
	projectNameFromPath,
} from '../../../../../renderer/components/Wizard/shared/projectIdentity';

describe('projectNameFromPath', () => {
	it('names the project after its folder', () => {
		expect(projectNameFromPath('/Users/pedram/Projects/Maestro')).toBe('Maestro');
	});

	it('ignores a trailing separator', () => {
		expect(projectNameFromPath('/Users/pedram/Projects/Maestro/')).toBe('Maestro');
	});

	it('reads a Windows path', () => {
		expect(projectNameFromPath('C:\\Users\\pedram\\Projects\\Maestro')).toBe('Maestro');
	});

	it('falls back when there is no folder name', () => {
		expect(projectNameFromPath('')).toBe('this project');
		expect(projectNameFromPath('   ')).toBe('this project');
	});
});

describe('defaultAgentNameForPath', () => {
	it('suggests the folder name when it is free', () => {
		expect(defaultAgentNameForPath('/Projects/Maestro', ['Something Else'])).toBe('Maestro');
	});

	it('avoids a name already in use, case-insensitively', () => {
		expect(defaultAgentNameForPath('/Projects/Maestro', ['maestro'])).toBe('Maestro 2');
	});

	it('keeps counting past the first collision', () => {
		expect(defaultAgentNameForPath('/Projects/Maestro', ['Maestro', 'Maestro 2'])).toBe(
			'Maestro 3'
		);
	});

	it('returns an empty string when the path yields no name', () => {
		expect(defaultAgentNameForPath('', [])).toBe('');
	});
});
