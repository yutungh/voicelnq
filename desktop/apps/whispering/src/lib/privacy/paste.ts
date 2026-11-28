/**
 * VoiceFlow: paste-time authorization (spec §4.3). When the text is ready,
 * the app in front NOW is checked: since 0.9.11 the hotkey's snapshot no
 * longer decides where the text goes, it can start anywhere.
 */
import {
	decidePaste,
	type PasteDecision,
	type RecordingPrivacy,
	type TargetSnapshot,
} from './policy';
import { captureTarget, focusTarget } from './target';

export type PasteContext = {
	/** The recording's target, captured at the hotkey. */
	target: TargetSnapshot | null;
	/** How the recording was authorized. */
	privacy?: RecordingPrivacy;
	/**
	 * True when the paste was started from a VoiceFlow button (Retry, Paste
	 * raw text, Send anyway, History). If VoiceFlow itself is in front, the
	 * recording's window is brought back first; if it isn't (the recording
	 * bar never takes focus), the window in front is used.
	 */
	restoreFocus: boolean;
	/**
	 * 0.9.11: the window in front when the recording stopped. The text is
	 * pasted only if that window is in front when it is ready (for a retry:
	 * after VoiceFlow brought it back, or at the click).
	 */
	atStop?: TargetSnapshot | null;
};

export async function authorizePaste(
	context: PasteContext | undefined,
): Promise<PasteDecision> {
	const target = context?.target ?? null;
	const sendingAnyway =
		context?.privacy === 'sent-anyway' || context?.privacy === 'held';
	// 0.9.23: with the field check, so File Explorer or Finder with no text
	// field focused counts as nowhere to paste.
	let current = await captureTarget({ checkField: true });
	let targetGone = false;
	if (
		context?.restoreFocus &&
		current.isSelf &&
		!sendingAnyway &&
		target &&
		target.resolved &&
		!target.isSelf
	) {
		targetGone = !(await focusTarget(target));
		if (!targetGone) current = await captureTarget({ checkField: true });
	}
	return decidePaste({
		current,
		atStop: context?.atStop ?? null,
		privacy: context?.privacy,
		targetGone,
	});
}
