/**
 * VoiceFlow 0.9.11, a hard rule: whenever a dictation finishes and is not
 * pasted, for any reason, its text is on the clipboard and the notice says
 * so. A field check that can't answer never stops the paste and never keeps
 * the text off the clipboard. A password field or password manager is not
 * pasted into, but the text (the user's own words) still goes on the clipboard.
 *
 * actions.ts and delivery.ts import `$lib` modules that `bun test` cannot
 * resolve, so their paths are checked in the source; the decisions are
 * checked directly.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	COPIED_INSTEAD,
	decidePaste,
	deliveryNotice,
	deliveryResult,
	type PasswordCheckResult,
	type PasteDecision,
	type TargetSnapshot,
} from '../../privacy/policy';

const read = (...path: string[]) => readFileSync(join(import.meta.dir, ...path), 'utf8').replace(/\r\n/g, '\n');
const delivery = read('delivery.ts');
const actions = read('actions.ts');
const rust = read('..', '..', '..', '..', 'src-tauri', 'src', 'lib.rs');

function between(source: string, start: string, end: string): string {
	const from = source.indexOf(start);
	expect(from).toBeGreaterThan(-1);
	const to = source.indexOf(end, from + start.length);
	return source.slice(from, to < 0 ? undefined : to);
}

function target(overrides: Partial<TargetSnapshot> = {}): TargetSnapshot {
	return {
		platform: 'windows',
		resolved: true,
		isSelf: false,
		appName: 'Kite',
		exeName: 'kite.exe',
		exePath: null,
		bundleId: null,
		title: null,
		windowId: '7',
		pid: 70,
		samples: 1,
		identityMs: 1,
		passwordCheck: 'not-password',
		passwordCheckMs: 1,
		error: null,
		windowClass: 'Chrome_WidgetWin_1',
		higherIntegrity: false,
		...overrides,
	};
}

/** Every way a paste can be declined at decision time. */
const DECLINED: Array<[string, Parameters<typeof decidePaste>[0]]> = [
	['nothing in front', { current: target({ resolved: false, windowId: null, pid: null, exeName: null, windowClass: null }) }],
	['VoiceFlow itself', { current: target({ isSelf: true }) }],
	['the desktop', { current: target({ exeName: 'explorer.exe', windowClass: 'Progman' }) }],
	['the taskbar', { current: target({ exeName: 'explorer.exe', windowClass: 'Shell_TrayWnd' }) }],
	// 0.9.23: File Explorer with no text field focused.
	['File Explorer with no text field', { current: target({ exeName: 'explorer.exe', windowClass: 'CabinetWClass', focusField: 'not-editable' }) }],
	['a password manager', { current: target({ exeName: '1password.exe' }) }],
	['a password field', { current: target({ passwordCheck: 'password' }) }],
	['another window than at Stop', { current: target(), atStop: target({ windowId: '8', pid: 80 }) }],
	['an admin window', { current: target({ higherIntegrity: true }) }],
	['an unreadable level', { current: target({ higherIntegrity: null }) }],
	['a closed window', { current: target(), targetGone: true }],
	['a 0.9.10 held dictation', { current: target(), privacy: 'held' }],
];

describe('not pasted means copied (0.9.11 hard rule)', () => {
	for (const [label, input] of DECLINED) {
		test(`${label}: copied, and the notice says so`, () => {
			const decision = decidePaste(input);
			expect(decision.paste).toBe(false);
			// write_text puts the text on the clipboard before anything else.
			const result = deliveryResult(decision, { pasted: false, copied: true });
			expect(result.result).toBe('copied');
			// 0.9.23 wording.
			expect(deliveryNotice(result).title).toBe(COPIED_INSTEAD);
		});
	}

	test('refused just before the keystroke, or keys that failed: copied', () => {
		const allowed = decidePaste({ current: target() });
		for (const native of [
			{ pasted: false, copied: true, reason: 'target-changed' as const },
			{ pasted: false, copied: true, reason: 'password-field' as const },
			{ pasted: false, copied: true, error: 'no keyboard' },
		]) {
			const result = deliveryResult(allowed, native);
			expect(result.result).toBe('copied');
			// The guard stopped it: the same words (0.9.23).
			expect(deliveryNotice(result).title).toBe(COPIED_INSTEAD);
			expect(deliveryNotice(result).description).toContain('Press Ctrl+V to paste.');
		}
	});

	test('an unknown or failed field check never blocks the paste', () => {
		const unanswered: PasswordCheckResult[] = ['unknown', 'unavailable', 'unsupported', 'timed-out', 'not-checked'];
		for (const passwordCheck of unanswered) {
			const decision: PasteDecision = decidePaste({ current: target({ passwordCheck }) });
			expect(decision.paste).toBe(true);
		}
	});

	test('the paste path always writes the clipboard, whatever the decision', () => {
		const place = between(delivery, 'export async function placeText(', '\nexport async function reportDelivered(');
		// No early return between the decision and the clipboard write.
		const beforeWrite = place.slice(0, place.indexOf('rpc.text.writeToCursor.execute'));
		expect(beforeWrite).not.toContain('return');
		// The call itself failed: still copied.
		expect(place).toContain('rpc.text.copyToClipboard.execute({ text })');
		// Rust: the clipboard is written first, and never put back.
		const write = between(rust, 'async fn write_text(', '\n/// Which keys paste.');
		expect(write.indexOf('app.clipboard().write_text(&text)')).toBeLessThan(write.indexOf('verify_paste_binding'));
		expect(write).not.toContain('original_clipboard');
	});

	test('pasting turned off, and a failed tidy-up: always copied', () => {
		const off = between(delivery, '// Pasting is turned off', '\nexport const delivery');
		expect(off).not.toContain('copyToClipboardOnSuccess');
		expect(off).toContain('rpc.text.copyToClipboard.execute({ text })');
		const tidy = between(actions, "// 0.9.11 (hard rule): a dictation that is not", 'const app = paste.target?.appName;');
		expect(tidy).toContain('text.copyToClipboard.execute({ text: rawText })');
		expect(tidy).not.toContain('copyToClipboardOnSuccess');
	});

	test('nothing is held: only a recording with no speech delivers nothing', () => {
		const transcribe = between(actions, 'async function transcribeAndDeliver(', '\nasync function ');
		const empty = transcribe.indexOf('if (!transcribedText.trim())');
		expect(empty).toBeGreaterThan(-1);
		expect(transcribe.indexOf('deliverTranscriptionResult')).toBeGreaterThan(empty);
		expect(transcribe).toContain("'Nothing heard'");
		// A start is never held: the decision has no hold any more.
		expect(read('..', '..', 'privacy', 'policy.ts')).not.toContain("action: 'hold'");
	});
});
