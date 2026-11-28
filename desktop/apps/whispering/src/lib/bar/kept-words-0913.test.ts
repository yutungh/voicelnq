/**
 * VoiceFlow 0.9.13: when the language guard keeps the user's own words, the bar
 * says so quietly ("Kept your words") with Use cleaned and Feedback, for as
 * long as a problem stays; History keeps Use cleaned after. Never a
 * question that blocks. Also the word lists' new style fields on the bar:
 * kind, the expression override, hidden styles and shared pins.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProfileSnapshot, ProfileStyle } from '$lib/profile/types';
import { chipRow, preferredStyleIds } from './chips';
import { RAW_STYLE_ID, type BarStyleOption } from './contract';
import { expressionBlock, isFunKind, presetKindOfProfileStyle } from './expression';
import { createBarMachine } from './machine';
import { noticeFor } from './notice';
import { barStyleChoice, profilePinnedIds, profileStyleOptions } from './styles';

const WORK: BarStyleOption = { id: 's-work', name: 'Work', kind: 'business' };
const RAW: BarStyleOption = { id: RAW_STYLE_ID, name: 'Raw', kind: 'raw' };

function setup() {
	let t = 1_000_000;
	const machine = createBarMachine({ now: () => t, noticeMs: 3000, problemMs: 8000 });
	machine.begin({ recordingId: 'a', purpose: 'dictation', app: { name: 'Kite', icon: null }, style: WORK, styles: [WORK, RAW] });
	machine.stop('a');
	return {
		machine,
		advance: (ms: number) => {
			t += ms;
		},
		now: () => t,
	};
}

describe('Kept your words', () => {
	test('pasted with his own words: Use cleaned and Feedback, for as long as a problem', () => {
		const { machine, now } = setup();
		machine.delivered('a', 'pasted', { app: 'Kite', text: 'his words', keptWords: { reason: 'han-added', styleName: 'Clean' } });
		const view = machine.view()!;
		expect(view.actions).toEqual(['use-cleaned', 'feedback', 'dismiss']);
		expect(view.hidesAt).toBe(now() + 8000);
		const notice = noticeFor(view)!;
		expect(notice.title).toBe('Kept your words');
		expect(notice.aside).toBe('mixed languages: tidy-up held back');
		expect(notice.buttons.map((b) => b.label)).toEqual(['Use cleaned', 'Feedback']);
		expect(notice.detail).toContain('into Chinese');
		expect(notice.detail).toContain('Pasted into Kite.');
		expect(notice.tone).toBe('warn');
		expect(machine.command({ type: 'use-cleaned', recordingId: 'a' }).accepted).toBe(true);
	});

	test('copied with his own words says how to paste', () => {
		const { machine } = setup();
		machine.delivered('a', 'copied', {
			app: null,
			text: 'his words',
			copied: { keys: 'Ctrl+V', why: null },
			keptWords: { reason: 'swapped', styleName: 'Casual' },
		});
		expect(noticeFor(machine.view()!)!.detail).toContain(
			"Couldn't paste — transcription copied to clipboard. Press Ctrl+V to paste.",
		);
	});

	test('an ordinary delivery offers no Use cleaned, and Use cleaned clears it', () => {
		const { machine } = setup();
		machine.delivered('a', 'pasted', { app: 'Kite', text: 'tidied' });
		expect(machine.view()!.actions).toEqual(['feedback', 'dismiss']);
		expect(machine.command({ type: 'use-cleaned', recordingId: 'a' })).toEqual({ accepted: false, reason: 'not-allowed' });
		expect(noticeFor(machine.view()!)!.title).toBe('Pasted');
	});

	test('the bar page and History offer Use cleaned; nothing asks a question first', () => {
		const root = join(import.meta.dir, '../..');
		const history = readFileSync(join(root, 'routes/(app)/(config)/history/+page.svelte'), 'utf8');
		expect(history).toContain('recovery.useCleaned(selected.id)');
		expect(history).toContain('Tidied version');
		const actions = readFileSync(join(root, 'lib/query/isomorphic/actions.ts'), 'utf8');
		expect(actions).toContain("useCleaned: (recordingId: string) => recovery.useCleaned(recordingId)");
		// Copied, never pasted over the user's words.
		const useCleaned = actions.slice(actions.indexOf('async function useCleanedNow'), actions.indexOf('async function retryTranscriptionNow'));
		expect(useCleaned).toContain('copyToClipboard');
		// History then says it was copied, and an earlier problem is cleared (Codex review).
		expect(useCleaned).toContain("result: 'copied'");
		expect(useCleaned).toContain('problem: undefined');
		// Copy-only delivery (pasting off) says why too, with Use cleaned.
		const delivery = readFileSync(join(root, 'lib/query/isomorphic/delivery.ts'), 'utf8');
		expect(delivery).toContain("title: 'Kept your words (copied)'");
		expect(useCleaned).not.toContain('placeText');
		expect(useCleaned).not.toContain('confirm(');
	});
});

describe('word-list style fields on the bar (v2)', () => {
	const style = (s: Partial<ProfileStyle> & { id: string }): ProfileStyle => ({ label: s.id, prompt: 'p', layer: 'personal', ...s });
	const snapshot = (styles: ProfileStyle[], pinnedStyles?: string[]): ProfileSnapshot =>
		({
			id: 'snap',
			user: 'sam',
			terms: [],
			corrections: [],
			styles,
			defaults: { promptCharsEffective: 600, promptTermsEffective: 40, fromLayer: {}, ...(pinnedStyles ? { pinnedStyles } : {}) },
			privacy: {},
			apps: [],
			issues: [],
		}) as ProfileSnapshot;

	test('kind comes first; a fun kind this app does not know counts as custom', () => {
		expect(presetKindOfProfileStyle({ id: 'partner', label: 'Partner', kind: 'business' })).toBe('business');
		expect(presetKindOfProfileStyle({ id: 'x', label: 'x', kind: 'fun_limerick' })).toBe('custom');
		expect(presetKindOfProfileStyle({ id: 'x', label: 'x', kind: 'fun_pirate' })).toBe('fun_pirate');
		expect(presetKindOfProfileStyle({ id: 'partner', label: 'Partner' })).toBe('partner');
		expect(isFunKind('fun_noir')).toBe(true);
		expect(isFunKind('casual')).toBe(false);
	});

	test("the style's expression override follows the guidance it overrides", () => {
		const block = expressionBlock('casual', 3, 'Never use emoji.');
		expect(block).toContain('Selected expression level: Lively');
		expect(block.endsWith('takes precedence over conflicting guidance above):\nNever use emoji.')).toBe(true);
		expect(expressionBlock('casual', 3, '  ')).toBe(expressionBlock('casual', 3));
		expect(expressionBlock('raw', 3, 'x')).toBe('');
	});

	test('a hidden style is not offered, but still starts a dictation when it is the default', () => {
		const snap = snapshot([style({ id: 'clean', label: 'Clean', hidden: true }), style({ id: 'work', label: 'Work' })]);
		expect(profileStyleOptions(snap).map((s) => s.id)).toEqual(['profile:work']);
		const choice = barStyleChoice({
			target: { exeName: 'kite.exe', bundleId: null },
			snapshot: { ...snap, defaults: { ...snap.defaults, cleanupStyle: 'clean' } },
			deviceStyles: [],
			deviceDefaultId: null,
		});
		expect(choice.style).toMatchObject({ id: 'profile:clean', name: 'Clean' });
	});

	test('shared pins, in order, only styles that are there and offered', () => {
		const snap = snapshot(
			[style({ id: 'clean' }), style({ id: 'work' }), style({ id: 'secret', hidden: true })],
			['work', 'ghost', 'secret', 'clean'],
		);
		expect(profilePinnedIds(snap)).toEqual(['profile:work', 'profile:clean']);
		expect(profilePinnedIds(null)).toEqual([]);
	});

	test('shared pins keep their order on the chips, then this PC pins (Codex review)', () => {
		const opts: BarStyleOption[] = ['clean', 'work', 'notes', 'a', 'b', 'c', 'd'].map((id) => ({ id, name: id, kind: 'custom' }));
		const preferred = preferredStyleIds(opts, new Set(['notes', 'clean']), new Map(), 5, ['work', 'clean', 'ghost']);
		expect(preferred).toEqual(['work', 'clean', 'notes']);
		expect(chipRow(opts, 'work', null, 5, preferred).chips.map((c) => c.id)).toEqual(['work', 'clean', 'notes']);
		// Without shared pins: as before (the page order).
		expect(preferredStyleIds(opts, new Set(['notes', 'clean']), new Map())).toEqual(['clean', 'notes']);
	});
});
