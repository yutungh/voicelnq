/**
 * VoiceFlow: the Rust side of app identity (spec §4.1), with the web build's
 * stand-in. Every failure here comes back as an unresolved snapshot: a
 * capture error removes information, it never grants anything.
 */
import type { TargetSnapshot } from './policy';

const WEB_SNAPSHOT: TargetSnapshot = {
	platform: 'web',
	resolved: false,
	isSelf: false,
	appName: null,
	exeName: null,
	exePath: null,
	bundleId: null,
	title: null,
	windowId: null,
	pid: null,
	samples: 0,
	identityMs: 0,
	passwordCheck: 'not-checked',
	passwordCheckMs: 0,
	error: null,
};

export function unresolvedTarget(error: string): TargetSnapshot {
	return {
		...WEB_SNAPSHOT,
		platform: 'other',
		error,
	};
}

/**
 * Snapshot of the app in front right now. At the hotkey, call this before
 * VoiceFlow shows anything, so VoiceFlow never becomes the target.
 */
export async function captureTarget({
	checkPassword = true,
	checkField = false,
}: {
	/** False at Stop: identity only, quick (0.9.11). */
	checkPassword?: boolean;
	/**
	 * VoiceFlow 0.9.23: at paste time, also ask whether the focused element
	 * takes text (File Explorer and Finder only; elsewhere it isn't asked).
	 */
	checkField?: boolean;
} = {}): Promise<TargetSnapshot> {
	if (!window.__TAURI_INTERNALS__) return WEB_SNAPSHOT;
	try {
		const { invoke } = await import('@tauri-apps/api/core');
		return await invoke<TargetSnapshot>('capture_target', { checkPassword, checkField });
	} catch (error) {
		return unresolvedTarget(`capture failed: ${String(error)}`);
	}
}

/**
 * Brings the recording's original window back to the front before a paste
 * started from a VoiceFlow button. False when the window is gone.
 */
export async function focusTarget(target: TargetSnapshot): Promise<boolean> {
	if (!window.__TAURI_INTERNALS__) return false;
	if (!target.resolved || target.isSelf) return false;
	try {
		const { invoke } = await import('@tauri-apps/api/core');
		return await invoke<boolean>('focus_target', {
			windowId: target.windowId,
			pid: target.pid,
		});
	} catch {
		return false;
	}
}
