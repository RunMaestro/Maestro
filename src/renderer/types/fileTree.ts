export interface FileNode {
	name: string;
	type: 'file' | 'folder';
	children?: FileNode[];
	fullPath?: string;
	isFolder?: boolean;
}
