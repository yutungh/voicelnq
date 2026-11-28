/**
 * VoiceFlow 0.9.11: the bar's "Copied" notice says what to press and why,
 * hides itself, and a paste never shows "Not pasted".
 */
import { describe, expect, test } from 'bun:test';
import { type BarStyleOption } from './contract';
import { COPIED_MS, createBarMachine } from './machine';
import { noticeFor } from './notice';

const WORK: BarStyleOption = { id: 's-work', name: 'Work', kind: 'business' };

function setup() {
	let t = 1_000_000;
	const machine = createBarMachine({ now: () => t });
	machine.begin({
		recordingId: 'r',
		purpose: 'dictation',
		app: { name: null, icon: null },
		style: WORK,
		styles: [WORK],
	});
	machine.stop('r');
	return { machine, advance: (ms: number) => (t += ms) };
}

describe('Copied notice (nowhere to paste)', () => {
	// 0.9.23: "Couldn't paste · transcription copied to clipboard".
	test('says it couldn\'t paste, that it was copied, what to press and why', () => {
		const { machine } = setup();
		machine.delivered('r', 'copied', {
			app: null,
			text: 'hello there',
			copied: { keys: 'Ctrl+V', why: 'The desktop was in front.' },
		});
		const view = machine.view()!;
		expect(view.phase).toBe('copied');
		const notice = noticeFor(view)!;
		expect(notice.title).toBe("Couldn't paste");
		expect(notice.aside).toBe('transcription copied to clipboard');
		expect(notice.detail).toBe(
			"Couldn't paste — transcription copied to clipboard. The desktop was in front. Press Ctrl+V to paste. It is also in History.",
		);
		expect(notice.tone).toBe('warn');
	});

	test('hides itself', () => {
		const { machine, advance } = setup();
		machine.delivered('r', 'copied', { app: null, text: 'x', copied: { keys: 'Ctrl+V', why: null } });
		expect(machine.view()?.hidesAt).not.toBeNull();
		advance(COPIED_MS + 1);
		expect(machine.view()).toBeNull();
	});

	test('a copy with pasting off keeps the old words', () => {
		const { machine } = setup();
		machine.delivered('r', 'copied', { app: null, text: 'x' });
		const notice = noticeFor(machine.view()!)!;
		expect(notice.aside).toBe('ready to paste');
		expect(notice.title).toBe('Copied');
		expect(notice.title).not.toContain("Couldn't paste");
		expect(machine.view()!.copied).toBeNull();
	});

	test('a paste after a copy shows "Pasted" and forgets the copy', () => {
		const { machine } = setup();
		machine.delivered('r', 'copied', { app: null, text: 'x', copied: { keys: 'Ctrl+V', why: null } });
		machine.delivered('r', 'pasted', { app: 'Kite', text: 'x' });
		const view = machine.view()!;
		expect(view.copied).toBeNull();
		const notice = noticeFor(view)!;
		expect(notice.title).toBe('Pasted');
		expect(notice.aside).toBe('Kite');
		expect(notice.title).not.toContain('Not pasted');
	});
});

describe('Nothing heard (no speech)', () => {
	test('a quiet notice with no buttons that hides itself quickly', () => {
		const { machine, advance } = setup();
		machine.failed('r', 'empty', 'Nothing heard', 'No speech was heard, so there was nothing to paste.');
		const notice = noticeFor(machine.view()!)!;
		expect(notice).toMatchObject({ tone: 'quiet', title: 'Nothing heard', buttons: [] });
		advance(COPIED_MS + 1);
		expect(machine.view()).toBeNull();
	});
});

describe('a failed tidy-up still leaves the words on the clipboard', () => {
	test('the visible line says Copied when they were copied', () => {
		const { machine } = setup();
		machine.failed('r', 'tidy-up', 'Copied. Press Ctrl+V to paste.', 'Tidy-up timed out.');
		const notice = noticeFor(machine.view()!)!;
		expect(notice.title).toBe('Copied');
		expect(notice.aside).toBe('press Ctrl+V');
		expect(notice.buttons.map((b) => b.label)).toContain('Retry');
	});

	test('and Not pasted only when they were not', () => {
		const { machine } = setup();
		machine.failed('r', 'tidy-up', 'Nothing was pasted', 'Tidy-up timed out.');
		expect(noticeFor(machine.view()!)!.title).toBe('Not pasted');
	});
});
