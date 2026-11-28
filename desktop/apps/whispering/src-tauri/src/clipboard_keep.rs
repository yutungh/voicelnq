//! VoiceFlow 0.9.23: keep the person's clipboard across a paste.
//!
//! A paste needs the text on the clipboard for a moment. With "Keep my
//! clipboard after pasting" on, `write_text` (lib.rs) saves what was there
//! first, writes the transcript marked as transient (kept out of Windows
//! clipboard history, the cloud clipboard and clipboard managers), sends the
//! paste keys, and a little later puts the saved clipboard back.
//!
//! Putting it back is best effort and never changes what the paste reports:
//! - Only a clipboard saved completely is ever put back. One that can't be
//!   (a format that can't be copied, a remote or promised clipboard, one an
//!   app marked private such as a password manager's copy, too slow or too
//!   large to save, or an empty one) is left alone and the transcript is
//!   written plainly, as before 0.9.23.
//! - Only after the paste keys were sent, once the app answers (Windows),
//!   after `RESTORE_DELAY`, and only when nothing else has written the
//!   clipboard since the transcript: the sequence number (Windows), checked
//!   while the clipboard is held, or `changeCount` (macOS).
//! - If nothing could be written back, the transcript goes back: never an
//!   empty clipboard.
//!
//! The rules are pure functions, unit tested below; the platform code only
//! reads and writes. Nothing here logs clipboard contents: counts, sizes and
//! reasons only.

use std::time::Duration;

/// How long after the paste keys the clipboard is put back. Apps read the
/// clipboard when they handle Ctrl/Cmd+V, almost always within a few tens of
/// milliseconds; this leaves a wide margin for a slow or busy app.
pub const RESTORE_DELAY: Duration = Duration::from_millis(1000);

/// Windows: how long the app pasted into may take to answer before the
/// restore is given up (it is busy or hung: it may not have read the text).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const RESPONSIVE_TIMEOUT: Duration = Duration::from_millis(2000);

/// Saving the clipboard stops (and the old behaviour applies) past this
/// time: an app that renders its formats on request (a large spreadsheet
/// copy) must not hold up the paste. Checked between formats.
pub const SNAPSHOT_BUDGET: Duration = Duration::from_millis(300);

/// ...or past this many bytes in all.
pub const SNAPSHOT_MAX_BYTES: usize = 64 * 1024 * 1024;

/// The person's clipboard, as saved before the transcript went on it.
pub enum Snapshot {
    /// Everything that matters was copied; it can be put back.
    Saved(Saved),
    /// The clipboard held nothing: there is nothing of theirs to lose.
    Empty,
    /// It can't (or mustn't) be put back faithfully.
    Unrestorable(String),
}

/// A saved clipboard (the platform's own representation).
pub struct Saved {
    pub(crate) contents: platform::Contents,
    /// Formats (Windows) or item types (macOS) saved.
    pub formats: usize,
    pub bytes: usize,
}

impl Snapshot {
    /// One log line: what was saved, never what it says.
    pub fn describe(&self) -> String {
        match self {
            Snapshot::Saved(s) => format!("saved ({} formats, {} bytes)", s.formats, s.bytes),
            Snapshot::Empty => "empty".into(),
            Snapshot::Unrestorable(why) => format!("not saved: {why}"),
        }
    }
}

/// VoiceFlow 0.9.23: when a paste's clipboard may be put back, as the
/// paste rule (`decidePaste`) decided. No mode at all is an unsure paste:
/// the text stays on the clipboard so a paste that silently failed can still
/// be pasted by hand.
#[derive(serde::Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RestoreWhen {
    /// The field check said "editable": put back only if the guard's own
    /// field check, right before the keystroke, still says so.
    IfEditable,
    /// A known terminal, or "Paste last transcription": always put back.
    Always,
}

/// Pure: may this paste's clipboard be put back, given the guard's field
/// answer right before the keystroke?
pub fn restore_allowed(mode: RestoreWhen, field_at_keystroke: Option<crate::context::FocusField>) -> bool {
    match mode {
        RestoreWhen::Always => true,
        RestoreWhen::IfEditable => field_at_keystroke == Some(crate::context::FocusField::Editable),
    }
}

/// What happens to a saved clipboard after the paste attempt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AfterPaste {
    /// Put the saved clipboard back (if the sequence still matches then).
    Restore,
    /// Leave the transcript, rewritten as an ordinary clipboard entry (if
    /// the sequence still matches then): it is staying.
    KeepTranscript(&'static str),
}

/// Pure: after the paste attempt, is the saved clipboard put back?
pub fn after_paste(
    keys_sent: bool,
    allowed: bool,
    seq_after_write: Option<u64>,
    target_answered: bool,
) -> AfterPaste {
    if !keys_sent {
        return AfterPaste::KeepTranscript("nothing was pasted");
    }
    if !allowed {
        return AfterPaste::KeepTranscript("the field was no longer sure to take text");
    }
    if seq_after_write.is_none() {
        return AfterPaste::KeepTranscript("the clipboard's sequence number couldn't be read");
    }
    if !target_answered {
        return AfterPaste::KeepTranscript("the app didn't answer, so it may not have read the text yet");
    }
    AfterPaste::Restore
}

/// How putting the clipboard back (or rewriting the transcript) went.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Restored {
    /// Every saved format went back.
    All,
    /// Some went back; the rest couldn't be written.
    Partly { written: usize, failed: usize },
    /// Something else wrote the clipboard after the transcript (the person
    /// copied something, an app or a clipboard manager changed it): left alone.
    ChangedSince,
    /// No content could be written back, so the transcript was put back.
    TranscriptBack,
    /// The clipboard couldn't be opened or cleared: nothing was changed.
    NotOpened(String),
}

/// Pure: whether the clipboard still holds what we wrote.
pub fn still_ours(seq_after_write: u64, seq_now: Option<u64>) -> bool {
    seq_now == Some(seq_after_write)
}

/// Pure: the outcome from how many saved content formats were written back
/// (bookkeeping such as a locale or a marker doesn't count as content).
pub fn restore_result(content_written: usize, failed: usize) -> Restored {
    match (content_written, failed) {
        (0, _) => Restored::TranscriptBack,
        (_, 0) => Restored::All,
        _ => Restored::Partly { written: content_written, failed },
    }
}

/// Saves the clipboard (blocking; the budget is checked between formats).
pub fn snapshot() -> Snapshot {
    platform::snapshot(SNAPSHOT_BUDGET, SNAPSHOT_MAX_BYTES)
}

/// Puts the transcript on the clipboard marked as transient, and returns the
/// clipboard's sequence number read before letting go of it.
pub fn write_transient(text: &str) -> Result<Option<u64>, String> {
    platform::write_text(text, true)
}

/// The clipboard's sequence number (Windows) or change count (macOS) now.
pub fn sequence() -> Option<u64> {
    platform::sequence()
}

/// Rewrites the transcript as an ordinary clipboard entry, only if the
/// clipboard still holds what we wrote.
pub fn keep_transcript(text: &str, seq_after_write: Option<u64>) -> Restored {
    platform::rewrite_plain(text, seq_after_write)
}

/// Puts the saved clipboard back, only if the clipboard is still at
/// `seq_after_write`. `transcript` goes back if no content could be written.
pub fn restore(saved: &Saved, seq_after_write: u64, transcript: &str) -> Restored {
    platform::restore(&saved.contents, seq_after_write, transcript)
}

/// Windows: waits until the window pasted into handles messages again
/// (it has taken its input), up to `RESPONSIVE_TIMEOUT`. False when it is
/// hung or busy past that. Elsewhere true.
pub fn target_answers(window_id: Option<&str>) -> bool {
    platform::target_answers(window_id)
}

/// Bounded wait for the clipboard: other apps (clipboard managers, the app
/// just pasted into) may hold it for a moment.
#[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
fn with_retries<T>(tries: u32, gap: Duration, mut attempt: impl FnMut() -> Option<T>) -> Option<T> {
    for i in 0..tries {
        if let Some(v) = attempt() {
            return Some(v);
        }
        if i + 1 < tries {
            std::thread::sleep(gap);
        }
    }
    None
}

/// How a Windows clipboard format is treated when saving.
#[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WinFormat {
    /// GDI handles and owner-drawn or private formats: not memory that can
    /// be copied. Bitmaps and old metafiles come back on their own (Windows
    /// makes CF_BITMAP from CF_DIB, CF_METAFILEPICT from the EMF).
    Skip,
    /// OLE's own bookkeeping: copying it would point a paste at an OLE object
    /// that no longer owns the clipboard. Apps use the plain formats beside it.
    SkipOle,
    /// The clipboard can't be saved faithfully with this format on it: file
    /// contents held as streams (virtual files from mail or zip folders).
    Unrestorable,
    /// An app marked the content private or transient (a password manager's
    /// copy, which it clears itself later): never put it back.
    Private,
    /// Saved as an enhanced metafile.
    Emf,
    /// Memory saved as bytes: text, HTML, RTF, images, file lists...
    Content,
    /// Saved as bytes, but not content on its own (a locale, a marker).
    Bookkeeping,
}

/// The marker VoiceLnq adds to a clipboard it put back, so the next save
/// doesn't take its history markers for a private copy.
#[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
pub(crate) const RESTORED_MARKER: &str = "VoiceLnq Restored Clipboard";

/// Pure: how a Windows clipboard format is saved, by id and registered name.
#[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
pub(crate) fn win_format(format: u32, name: Option<&str>) -> WinFormat {
    const CF_BITMAP: u32 = 2;
    const CF_METAFILEPICT: u32 = 3;
    const CF_PALETTE: u32 = 9;
    const CF_ENHMETAFILE: u32 = 14;
    const CF_LOCALE: u32 = 16;
    const CF_OWNERDISPLAY: u32 = 0x0080;
    const CF_DSPBITMAP: u32 = 0x0082;
    const CF_DSPMETAFILEPICT: u32 = 0x0083;
    const CF_DSPENHMETAFILE: u32 = 0x008E;
    match format {
        CF_BITMAP | CF_METAFILEPICT | CF_PALETTE | CF_OWNERDISPLAY | CF_DSPBITMAP
        | CF_DSPMETAFILEPICT | CF_DSPENHMETAFILE => WinFormat::Skip,
        // CF_PRIVATEFIRST..=CF_PRIVATELAST: the system doesn't own them.
        0x0200..=0x02FF => WinFormat::Skip,
        CF_ENHMETAFILE => WinFormat::Emf,
        CF_LOCALE => WinFormat::Bookkeeping,
        _ => match name {
            Some(
                "DataObject" | "Ole Private Data" | "OleClipboardPersistOnFlush" | "Embed Source"
                | "Embedded Object" | "Link Source" | "Link Source Descriptor" | "Object Descriptor"
                | "ObjectLink" | "OwnerLink" | "Native",
            ) => WinFormat::SkipOle,
            Some("FileContents" | "FileGroupDescriptor" | "FileGroupDescriptorW") => WinFormat::Unrestorable,
            Some("ExcludeClipboardContentFromMonitorProcessing" | "Clipboard Viewer Ignore") => WinFormat::Private,
            Some("CanIncludeInClipboardHistory" | "CanUploadToCloudClipboard" | RESTORED_MARKER) => {
                WinFormat::Bookkeeping
            }
            _ => WinFormat::Content,
        },
    }
}

/// Pure: an app's "CanIncludeInClipboardHistory" value, when the clipboard
/// isn't one VoiceLnq put back: 0 (or unreadable) means the app kept it out
/// of history on purpose, so it is treated as private; 1 asks to include it.
#[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
pub(crate) fn history_flag_is_private(value: Option<u32>, restored_by_us: bool) -> bool {
    !restored_by_us && value != Some(1)
}

/// Pure (macOS): item types that mean the clipboard can't, or mustn't, be
/// put back: Universal Clipboard (fetched from another device when read),
/// file promises (written by the source app on drop), and content an app
/// marked concealed or transient (a password manager's copy).
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
pub(crate) fn mac_type_blocks_restore(t: &str) -> bool {
    matches!(
        t,
        "com.apple.is-remote-clipboard"
            | "com.apple.NSFilePromiseItemMetaData"
            | "com.apple.pasteboard.promised-file-url"
            | "com.apple.pasteboard.promised-file-content-type"
            | "com.apple.pasteboard.promised-suggested-file-name"
            | "NSPromiseContentsPboardType"
            | "org.nspasteboard.ConcealedType"
            | "org.nspasteboard.TransientType"
            | "org.nspasteboard.AutoGeneratedType"
    )
}

#[cfg(target_os = "windows")]
mod platform {
    use super::*;
    use std::time::Instant;
    use windows_sys::Win32::Foundation::{GlobalFree, HANDLE, HWND};
    use windows_sys::Win32::Graphics::Gdi::{
        DeleteEnhMetaFile, GetEnhMetaFileBits, SetEnhMetaFileBits, HENHMETAFILE,
    };
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData,
        GetClipboardFormatNameW, GetClipboardOwner, GetClipboardSequenceNumber, OpenClipboard,
        RegisterClipboardFormatW, SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        IsHungAppWindow, IsWindow, SendMessageTimeoutW, SMTO_ABORTIFHUNG, WM_NULL,
    };

    const CF_UNICODETEXT: u32 = 13;
    const CF_ENHMETAFILE: u32 = 14;

    pub enum Payload {
        Global(Vec<u8>),
        Emf(Vec<u8>),
    }

    /// Formats in the order they were on the clipboard (a reader takes the
    /// first it understands, so order matters), each marked content or not.
    pub struct Contents(Vec<(u32, Payload, bool)>);

    /// Holds the clipboard open; closes it when dropped.
    struct Open;

    impl Open {
        fn new() -> Option<Self> {
            // No owner window, as arboard (the app's clipboard writer) does:
            // nothing VoiceLnq writes is rendered late.
            with_retries(20, Duration::from_millis(10), || {
                (unsafe { OpenClipboard(std::ptr::null_mut()) } != 0).then_some(Open)
            })
        }
    }

    impl Drop for Open {
        fn drop(&mut self) {
            unsafe { CloseClipboard() };
        }
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn register(name: &str) -> Option<u32> {
        let id = unsafe { RegisterClipboardFormatW(wide(name).as_ptr()) };
        (id != 0).then_some(id)
    }

    fn format_name(format: u32) -> Option<String> {
        if format < 0xC000 {
            return None;
        }
        let mut buf = [0u16; 256];
        let len = unsafe { GetClipboardFormatNameW(format, buf.as_mut_ptr(), buf.len() as i32) };
        (len > 0).then(|| String::from_utf16_lossy(&buf[..len as usize]))
    }

    pub fn sequence() -> Option<u64> {
        // 0 means it couldn't be read (no access to the clipboard).
        let n = unsafe { GetClipboardSequenceNumber() };
        (n != 0).then_some(n as u64)
    }

    /// Copies a global memory block, if it fits in `room` bytes (checked
    /// before copying). None: it can't be locked. Some(None): too large.
    unsafe fn read_global(handle: HANDLE, room: usize) -> Option<Option<Vec<u8>>> {
        let size = GlobalSize(handle);
        if size > room {
            return Some(None);
        }
        let ptr = GlobalLock(handle) as *const u8;
        if ptr.is_null() {
            return None;
        }
        let bytes = std::slice::from_raw_parts(ptr, size).to_vec();
        GlobalUnlock(handle);
        Some(Some(bytes))
    }

    unsafe fn read_emf(handle: HANDLE, room: usize) -> Option<Option<Vec<u8>>> {
        let emf = handle as HENHMETAFILE;
        let size = GetEnhMetaFileBits(emf, 0, std::ptr::null_mut());
        if size == 0 {
            return None;
        }
        if size as usize > room {
            return Some(None);
        }
        let mut bytes = vec![0u8; size as usize];
        let read = GetEnhMetaFileBits(emf, size, bytes.as_mut_ptr());
        (read == size).then_some(Some(bytes))
    }

    pub fn snapshot(budget: Duration, max_bytes: usize) -> Snapshot {
        let started = Instant::now();
        let Some(_open) = Open::new() else {
            return Snapshot::Unrestorable("the clipboard was busy".into());
        };
        // Reading a format the owner renders on request waits for the owner:
        // a hung owner is never asked.
        let owner = unsafe { GetClipboardOwner() };
        if !owner.is_null() && unsafe { IsHungAppWindow(owner) } != 0 {
            return Snapshot::Unrestorable("the app that owns it isn't responding".into());
        }
        // Names first: a private marker anywhere means nothing is read.
        let mut listed: Vec<(u32, Option<String>)> = Vec::new();
        let mut format = 0u32;
        loop {
            format = unsafe { EnumClipboardFormats(format) };
            if format == 0 {
                break;
            }
            listed.push((format, format_name(format)));
        }
        if listed.is_empty() {
            return Snapshot::Empty;
        }
        let restored = listed.iter().any(|(_, n)| n.as_deref() == Some(RESTORED_MARKER));
        for (format, name) in &listed {
            if name.as_deref() == Some("CanIncludeInClipboardHistory") {
                let handle = unsafe { GetClipboardData(*format) };
                let value = (!handle.is_null())
                    .then(|| unsafe { read_global(handle, 64) })
                    .flatten()
                    .flatten()
                    .and_then(|b| b.get(..4).map(|d| u32::from_ne_bytes([d[0], d[1], d[2], d[3]])));
                if history_flag_is_private(value, restored) {
                    return Snapshot::Unrestorable("an app kept it out of clipboard history".into());
                }
            }
            match win_format(*format, name.as_deref()) {
                WinFormat::Private => return Snapshot::Unrestorable("an app marked it private".into()),
                WinFormat::Unrestorable => {
                    return Snapshot::Unrestorable("it holds file contents as streams".into())
                }
                _ => {}
            }
        }
        let mut saved: Vec<(u32, Payload, bool)> = Vec::new();
        let (mut bytes, mut content) = (0usize, 0usize);
        for (format, name) in &listed {
            if started.elapsed() > budget {
                return Snapshot::Unrestorable("saving it took too long".into());
            }
            let kind = win_format(*format, name.as_deref());
            let payload = match kind {
                WinFormat::Skip | WinFormat::SkipOle => continue,
                WinFormat::Private | WinFormat::Unrestorable => unreachable!("checked above"),
                WinFormat::Emf => {
                    let handle = unsafe { GetClipboardData(*format) };
                    match (!handle.is_null()).then(|| unsafe { read_emf(handle, max_bytes - bytes) }).flatten() {
                        Some(Some(b)) => Payload::Emf(b),
                        Some(None) => return Snapshot::Unrestorable("it is too large".into()),
                        None => return Snapshot::Unrestorable("a picture couldn't be read".into()),
                    }
                }
                WinFormat::Content | WinFormat::Bookkeeping => {
                    // Asks the owner to render a delayed format, if it is one.
                    let handle = unsafe { GetClipboardData(*format) };
                    match (!handle.is_null()).then(|| unsafe { read_global(handle, max_bytes - bytes) }).flatten() {
                        Some(Some(b)) => Payload::Global(b),
                        Some(None) => return Snapshot::Unrestorable("it is too large".into()),
                        None => {
                            return Snapshot::Unrestorable(format!("format {format} couldn't be read"))
                        }
                    }
                }
            };
            bytes += match &payload {
                Payload::Global(b) | Payload::Emf(b) => b.len(),
            };
            if bytes > max_bytes {
                return Snapshot::Unrestorable("it is too large".into());
            }
            let is_content = kind != WinFormat::Bookkeeping;
            content += usize::from(is_content);
            saved.push((*format, payload, is_content));
        }
        if content == 0 {
            return Snapshot::Unrestorable("none of its formats can be copied".into());
        }
        let formats = saved.len();
        Snapshot::Saved(Saved { contents: Contents(saved), formats, bytes })
    }

    /// Global memory holding a copy of `bytes`; freed when dropped unless it
    /// was handed to the clipboard.
    struct Global(HANDLE);

    impl Global {
        unsafe fn new(bytes: &[u8]) -> Option<Self> {
            let handle = GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1));
            if handle.is_null() {
                return None;
            }
            let ptr = GlobalLock(handle) as *mut u8;
            if ptr.is_null() {
                GlobalFree(handle);
                return None;
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len());
            GlobalUnlock(handle);
            Some(Self(handle))
        }

        unsafe fn text(text: &str) -> Option<Self> {
            let units: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
            Self::new(std::slice::from_raw_parts(units.as_ptr() as *const u8, units.len() * 2))
        }

        /// Hands it to the clipboard; the system owns it on success.
        unsafe fn set(self, format: u32) -> bool {
            let handle = self.0;
            std::mem::forget(self);
            if SetClipboardData(format, handle).is_null() {
                GlobalFree(handle);
                return false;
            }
            true
        }
    }

    impl Drop for Global {
        fn drop(&mut self) {
            unsafe { GlobalFree(self.0) };
        }
    }

    /// Sets one format from bytes. The system owns the memory on success.
    unsafe fn set_global(format: u32, bytes: &[u8]) -> bool {
        Global::new(bytes).is_some_and(|g| g.set(format))
    }

    unsafe fn set_emf(bytes: &[u8]) -> bool {
        let emf = SetEnhMetaFileBits(bytes.len() as u32, bytes.as_ptr());
        if emf.is_null() {
            return false;
        }
        if SetClipboardData(CF_ENHMETAFILE, emf as HANDLE).is_null() {
            DeleteEnhMetaFile(emf);
            return false;
        }
        true
    }

    /// Sets the named formats with a DWORD 0 (Clipboard Formats, "Cloud
    /// Clipboard and Clipboard History Formats"). A marker that can't be set
    /// is logged: the text then reaches clipboard history, as before 0.9.23.
    unsafe fn set_markers(names: &[&str]) {
        let zero = 0u32.to_ne_bytes();
        for name in names {
            let ok = register(name).is_some_and(|format| set_global(format, &zero));
            if !ok {
                log::warn!("[paste] clipboard marker {name} couldn't be set");
            }
        }
    }

    /// The transcript: out of clipboard history, the cloud clipboard and
    /// clipboard monitors altogether.
    const TRANSIENT: &[&str] = &[
        "ExcludeClipboardContentFromMonitorProcessing",
        "CanIncludeInClipboardHistory",
        "CanUploadToCloudClipboard",
    ];
    /// A restored clipboard: already in history from when it was copied, so
    /// not added again, and not synced again.
    const RESTORED: &[&str] = &["CanIncludeInClipboardHistory", "CanUploadToCloudClipboard", RESTORED_MARKER];

    pub fn write_text(text: &str, transient: bool) -> Result<Option<u64>, String> {
        let Some(_open) = Open::new() else {
            return Err("the clipboard is busy".into());
        };
        unsafe {
            // Allocated before clearing, so a failure leaves the clipboard as it was.
            let Some(text) = Global::text(text) else {
                return Err("no memory for the text".into());
            };
            if EmptyClipboard() == 0 {
                return Err("the clipboard couldn't be cleared".into());
            }
            if !text.set(CF_UNICODETEXT) {
                return Err("the text couldn't be put on the clipboard".into());
            }
            if transient {
                set_markers(TRANSIENT);
            }
        }
        // Read before closing: nothing else can have written in between.
        Ok(sequence())
    }

    pub fn rewrite_plain(text: &str, seq_after_write: Option<u64>) -> Restored {
        let Some(_open) = Open::new() else {
            return Restored::NotOpened("the clipboard was busy".into());
        };
        if let Some(seq) = seq_after_write {
            if !still_ours(seq, sequence()) {
                return Restored::ChangedSince;
            }
        }
        unsafe {
            let Some(text) = Global::text(text) else {
                return Restored::NotOpened("no memory for the text".into());
            };
            if EmptyClipboard() == 0 || !text.set(CF_UNICODETEXT) {
                return Restored::NotOpened("the clipboard couldn't be written".into());
            }
        }
        Restored::All
    }

    pub fn restore(contents: &Contents, seq_after_write: u64, transcript: &str) -> Restored {
        let Some(_open) = Open::new() else {
            return Restored::NotOpened("the clipboard was busy".into());
        };
        // Checked while the clipboard is held, so nothing can write between
        // this check and the restore.
        if !still_ours(seq_after_write, sequence()) {
            return Restored::ChangedSince;
        }
        unsafe {
            // The fallback is allocated before clearing.
            let Some(fallback) = Global::text(transcript) else {
                return Restored::NotOpened("no memory to restore with".into());
            };
            if EmptyClipboard() == 0 {
                return Restored::NotOpened("the clipboard couldn't be cleared".into());
            }
            let (mut content, mut failed) = (0usize, 0usize);
            for (format, payload, is_content) in &contents.0 {
                let ok = match payload {
                    Payload::Global(b) => set_global(*format, b),
                    Payload::Emf(b) => set_emf(b),
                };
                match (ok, is_content) {
                    (true, true) => content += 1,
                    (true, false) => {}
                    (false, _) => failed += 1,
                }
            }
            let result = restore_result(content, failed);
            if result == Restored::TranscriptBack {
                // Never an empty clipboard: the transcript goes back, in the
                // same open session.
                EmptyClipboard();
                if !fallback.set(CF_UNICODETEXT) {
                    return Restored::NotOpened("nothing could be written back".into());
                }
            } else {
                drop(fallback);
                set_markers(RESTORED);
            }
            result
        }
    }

    pub fn target_answers(window_id: Option<&str>) -> bool {
        let Some(raw) = window_id.and_then(|w| w.parse::<usize>().ok()) else {
            return true;
        };
        let hwnd = raw as HWND;
        unsafe {
            if IsWindow(hwnd) == 0 {
                // Closed right after the paste: nothing left to read it.
                return true;
            }
            let mut out: usize = 0;
            SendMessageTimeoutW(
                hwnd,
                WM_NULL,
                0,
                0,
                SMTO_ABORTIFHUNG,
                RESPONSIVE_TIMEOUT.as_millis() as u32,
                &mut out,
            ) != 0
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use objc2::rc::{autoreleasepool, Retained};
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{
        NSPasteboard, NSPasteboardContentsOptions, NSPasteboardItem, NSPasteboardTypeString,
        NSPasteboardWriting,
    };
    use objc2_foundation::{NSArray, NSData, NSString};
    use std::time::Instant;

    /// Items in order, each with its types in order.
    pub struct Contents(Vec<Vec<(String, Vec<u8>)>>);

    fn general() -> Retained<NSPasteboard> {
        NSPasteboard::generalPasteboard()
    }

    fn change_count(pasteboard: &NSPasteboard) -> u64 {
        pasteboard.changeCount() as u64
    }

    pub fn sequence() -> Option<u64> {
        autoreleasepool(|_| Some(change_count(&general())))
    }

    pub fn snapshot(budget: Duration, max_bytes: usize) -> Snapshot {
        autoreleasepool(|_| {
            let started = Instant::now();
            let pasteboard = general();
            let before = change_count(&pasteboard);
            let Some(items) = pasteboard.pasteboardItems() else {
                return Snapshot::Unrestorable("the clipboard couldn't be read".into());
            };
            if items.count() == 0 {
                return Snapshot::Empty;
            }
            // Every type first: reading a remote one would fetch it.
            for item in items.iter() {
                for t in item.types().iter() {
                    if mac_type_blocks_restore(&t.to_string()) {
                        return Snapshot::Unrestorable(
                            "it is on another device, a file promise, or marked private".into(),
                        );
                    }
                }
            }
            let mut saved = Vec::new();
            let (mut bytes, mut formats) = (0usize, 0usize);
            for item in items.iter() {
                let mut types = Vec::new();
                for t in item.types().iter() {
                    if started.elapsed() > budget {
                        return Snapshot::Unrestorable("saving it took too long".into());
                    }
                    let Some(data) = item.dataForType(&t) else {
                        return Snapshot::Unrestorable("a type gave no data".into());
                    };
                    if bytes + data.len() > max_bytes {
                        return Snapshot::Unrestorable("it is too large".into());
                    }
                    let data = data.to_vec();
                    bytes += data.len();
                    formats += 1;
                    types.push((t.to_string(), data));
                }
                saved.push(types);
            }
            if change_count(&pasteboard) != before {
                return Snapshot::Unrestorable("it changed while being saved".into());
            }
            if formats == 0 {
                return Snapshot::Empty;
            }
            Snapshot::Saved(Saved { contents: Contents(saved), formats, bytes })
        })
    }

    /// Clears the pasteboard and writes the items. Returns the change count
    /// that clearing gave this write (Apple: the count to compare later to
    /// know whether we still own the pasteboard), or None if it failed.
    fn write_items(pasteboard: &NSPasteboard, items: Vec<Retained<NSPasteboardItem>>) -> Option<u64> {
        // This Mac only: what VoiceLnq writes is never sent to other devices
        // (Universal Clipboard).
        let owned = pasteboard.prepareForNewContentsWithOptions(NSPasteboardContentsOptions::CurrentHostOnly);
        let objects: Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>> =
            items.into_iter().map(ProtocolObject::from_retained).collect();
        let array = NSArray::from_retained_slice(&objects);
        pasteboard.writeObjects(&array).then_some(owned as u64)
    }

    fn text_item(text: &str, transient: bool) -> Retained<NSPasteboardItem> {
        let item = NSPasteboardItem::new();
        item.setString_forType(&NSString::from_str(text), unsafe { NSPasteboardTypeString });
        if transient {
            // nspasteboard.org: on the clipboard only for a moment, and not
            // copied by the person; clipboard managers don't record it.
            let empty = NSData::with_bytes(&[]);
            for marker in ["org.nspasteboard.TransientType", "org.nspasteboard.AutoGeneratedType"] {
                item.setData_forType(&empty, &NSString::from_str(marker));
            }
        }
        item
    }

    pub fn write_text(text: &str, transient: bool) -> Result<Option<u64>, String> {
        autoreleasepool(|_| {
            let pasteboard = general();
            match write_items(&pasteboard, vec![text_item(text, transient)]) {
                Some(owned) => Ok(Some(owned)),
                None => Err("the text couldn't be put on the clipboard".into()),
            }
        })
    }

    pub fn rewrite_plain(text: &str, seq_after_write: Option<u64>) -> Restored {
        autoreleasepool(|_| {
            let pasteboard = general();
            if let Some(seq) = seq_after_write {
                if !still_ours(seq, Some(change_count(&pasteboard))) {
                    return Restored::ChangedSince;
                }
            }
            if write_items(&pasteboard, vec![text_item(text, false)]).is_some() {
                Restored::All
            } else {
                Restored::NotOpened("the clipboard couldn't be written".into())
            }
        })
    }

    pub fn restore(contents: &Contents, seq_after_write: u64, transcript: &str) -> Restored {
        autoreleasepool(|_| {
            let pasteboard = general();
            // New items every time: an item that was on a pasteboard can't be
            // written again.
            let (mut written, mut failed) = (0usize, 0usize);
            let mut items = Vec::new();
            for types in &contents.0 {
                let item = NSPasteboardItem::new();
                for (t, data) in types {
                    if item.setData_forType(&NSData::with_bytes(data), &NSString::from_str(t)) {
                        written += 1;
                    } else {
                        failed += 1;
                    }
                }
                items.push(item);
            }
            // As close to the write as possible (macOS has no way to hold
            // the pasteboard between the two).
            if !still_ours(seq_after_write, Some(change_count(&pasteboard))) {
                return Restored::ChangedSince;
            }
            if written > 0 && write_items(&pasteboard, items).is_some() {
                return restore_result(written, failed);
            }
            // Never an empty clipboard: the transcript goes back.
            if write_items(&pasteboard, vec![text_item(transcript, false)]).is_none() {
                return Restored::NotOpened("nothing could be written back".into());
            }
            Restored::TranscriptBack
        })
    }

    pub fn target_answers(_window_id: Option<&str>) -> bool {
        true
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod platform {
    use super::*;

    pub struct Contents;

    pub fn sequence() -> Option<u64> {
        None
    }

    pub fn snapshot(_budget: Duration, _max_bytes: usize) -> Snapshot {
        Snapshot::Unrestorable("not supported on this platform".into())
    }

    pub fn write_text(_text: &str, _transient: bool) -> Result<Option<u64>, String> {
        Err("not supported on this platform".into())
    }

    pub fn rewrite_plain(_text: &str, _seq: Option<u64>) -> Restored {
        Restored::NotOpened("not supported on this platform".into())
    }

    pub fn restore(_contents: &Contents, _seq: u64, _transcript: &str) -> Restored {
        Restored::NotOpened("not supported on this platform".into())
    }

    pub fn target_answers(_window_id: Option<&str>) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_saved_clipboard_is_put_back_only_after_a_paste_that_was_sent_and_answered() {
        assert_eq!(after_paste(true, true, Some(5), true), AfterPaste::Restore);
        assert!(matches!(after_paste(false, true, Some(5), true), AfterPaste::KeepTranscript(_)));
        // The guard's field check no longer said "editable".
        assert!(matches!(after_paste(true, false, Some(5), true), AfterPaste::KeepTranscript(_)));
        // No sequence to compare later: never restore blind.
        assert!(matches!(after_paste(true, true, None, true), AfterPaste::KeepTranscript(_)));
        // A hung or busy app may read the clipboard late: keep the transcript.
        assert!(matches!(after_paste(true, true, Some(5), false), AfterPaste::KeepTranscript(_)));
    }

    #[test]
    fn a_confident_paste_is_put_back_only_while_the_field_still_takes_text() {
        use crate::context::FocusField::*;
        assert!(restore_allowed(RestoreWhen::IfEditable, Some(Editable)));
        for field in [Some(NotEditable), Some(Unknown), None] {
            assert!(!restore_allowed(RestoreWhen::IfEditable, field), "{field:?}");
            // A known terminal or Paste last transcription: always.
            assert!(restore_allowed(RestoreWhen::Always, field), "{field:?}");
        }
        let parse = |s: &str| serde_json::from_str::<RestoreWhen>(s).unwrap();
        assert_eq!(parse("\"if-editable\""), RestoreWhen::IfEditable);
        assert_eq!(parse("\"always\""), RestoreWhen::Always);
    }

    #[test]
    fn a_clipboard_changed_since_the_transcript_is_left_alone() {
        assert!(still_ours(41, Some(41)));
        assert!(!still_ours(41, Some(42)));
        assert!(!still_ours(41, None));
    }

    #[test]
    fn a_restore_with_no_content_written_puts_the_transcript_back() {
        assert_eq!(restore_result(0, 3), Restored::TranscriptBack);
        assert_eq!(restore_result(0, 0), Restored::TranscriptBack);
        assert_eq!(restore_result(3, 0), Restored::All);
        assert_eq!(restore_result(2, 1), Restored::Partly { written: 2, failed: 1 });
    }

    #[test]
    fn windows_formats_are_saved_skipped_or_stop_the_save() {
        use WinFormat::*;
        // Handles, owner-drawn and private formats: skipped (synthesized again).
        for f in [2, 3, 9, 0x80, 0x82, 0x83, 0x8E, 0x200, 0x2FF] {
            assert_eq!(win_format(f, None), Skip, "{f:#x}");
        }
        assert_eq!(win_format(14, None), Emf);
        assert_eq!(win_format(16, None), Bookkeeping); // CF_LOCALE
        // Text, DIB, DIBV5, file lists, the GDIOBJ range (HGLOBAL).
        for f in [1, 7, 8, 13, 15, 17, 0x300] {
            assert_eq!(win_format(f, None), Content, "{f:#x}");
        }
        for name in ["HTML Format", "Rich Text Format", "PNG", "Preferred DropEffect", "Shell IDList Array"] {
            assert_eq!(win_format(0xC100, Some(name)), Content, "{name}");
        }
        for name in ["DataObject", "Ole Private Data", "Embed Source", "Object Descriptor", "Link Source"] {
            assert_eq!(win_format(0xC100, Some(name)), SkipOle, "{name}");
        }
        for name in ["FileContents", "FileGroupDescriptorW"] {
            assert_eq!(win_format(0xC100, Some(name)), Unrestorable, "{name}");
        }
    }

    #[test]
    fn a_private_copy_is_never_put_back_but_our_own_restore_is() {
        use WinFormat::*;
        assert_eq!(win_format(0xC100, Some("ExcludeClipboardContentFromMonitorProcessing")), Private);
        assert_eq!(win_format(0xC100, Some("Clipboard Viewer Ignore")), Private);
        assert_eq!(win_format(0xC100, Some("CanIncludeInClipboardHistory")), Bookkeeping);
        assert_eq!(win_format(0xC100, Some(RESTORED_MARKER)), Bookkeeping);
        assert_eq!(win_format(0xC100, Some("CanUploadToCloudClipboard")), Bookkeeping);
        // An app's "keep out of history" (0, or unreadable) is private...
        assert!(history_flag_is_private(Some(0), false));
        assert!(history_flag_is_private(None, false));
        // ...an explicit "include" (1) is not, nor a clipboard VoiceLnq put
        // back (it carries 0 so it isn't added to history twice).
        assert!(!history_flag_is_private(Some(1), false));
        assert!(!history_flag_is_private(Some(0), true));
    }

    #[test]
    fn mac_remote_promised_and_private_clipboards_are_not_saved() {
        for t in [
            "com.apple.is-remote-clipboard",
            "com.apple.NSFilePromiseItemMetaData",
            "org.nspasteboard.ConcealedType",
            "org.nspasteboard.TransientType",
        ] {
            assert!(mac_type_blocks_restore(t), "{t}");
        }
        for t in ["public.utf8-plain-text", "public.html", "public.rtf", "public.png", "public.file-url"] {
            assert!(!mac_type_blocks_restore(t), "{t}");
        }
    }

    #[test]
    fn retries_stop_at_the_first_success_and_give_up_after_the_last() {
        let mut calls = 0;
        assert_eq!(
            with_retries(5, Duration::ZERO, || {
                calls += 1;
                (calls == 3).then_some(7)
            }),
            Some(7)
        );
        assert_eq!(calls, 3);
        let mut calls = 0;
        assert_eq!(
            with_retries(4, Duration::ZERO, || {
                calls += 1;
                None::<u8>
            }),
            None
        );
        assert_eq!(calls, 4);
    }

    /// Saves the real clipboard and prints what was saved (never contents).
    /// Read only: nothing is written. Run by hand with `--ignored`.
    #[test]
    #[ignore]
    fn live_snapshot_reads_the_clipboard() {
        println!("snapshot: {}", snapshot().describe());
    }
}
