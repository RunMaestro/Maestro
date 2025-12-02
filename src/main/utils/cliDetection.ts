import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

let cloudflaredInstalledCache: boolean | null = null;

export async function isCloudflaredInstalled(): Promise<boolean> {
  // Return cached result if available
  if (cloudflaredInstalledCache !== null) {
    return cloudflaredInstalledCache;
  }

  try {
    // Use 'which' on macOS/Linux, 'where' on Windows
    const command = process.platform === 'win32' ? 'where' : 'which';
    await execFileAsync(command, ['cloudflared']);
    cloudflaredInstalledCache = true;
  } catch {
    cloudflaredInstalledCache = false;
  }

  return cloudflaredInstalledCache;
}

export function clearCloudflaredCache(): void {
  cloudflaredInstalledCache = null;
}
