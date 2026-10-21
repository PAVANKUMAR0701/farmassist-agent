import { afterEach, describe, expect, it, vi } from 'vitest';
import { isEcho, plainText, speak, speakable } from '../../web/src/voice.js';

describe('speakable', () => {
  it('reads rupees, paise and dates the way a person would say them', () => {
    expect(speakable('Recorded ₹2,500.00 on feed for 2026-10-16.')).toBe('Recorded 2,500 rupees on feed for 16 October 2026.');
    expect(speakable('₹149.50 → ₹150.00')).toBe('149 rupees 50 paise  to  150 rupees');
  });
});

describe('isEcho', () => {
  const question = 'Shall I record ₹2,500.00 on feed for today? Say yes to save it, or no to cancel.';
  it('recognises the app\'s own reply coming back through the microphone (live, 2026-10-16)', () => {
    expect(isEcho('okay nothing was saved', 'Okay, nothing was saved.')).toBe(true);
    expect(isEcho('say yes to save it', question)).toBe(true);
    expect(isEcho('2500 rupees on feed for today', question)).toBe(true);
  });
  it('never mistakes a real short answer or a new request for an echo', () => {
    expect(isEcho('yes', question)).toBe(false);
    expect(isEcho('haan', question)).toBe(false);
    expect(isEcho('yes please', question)).toBe(false);
    expect(isEcho('spent 600 on fuel', question)).toBe(false);
  });
});

describe('plainText', () => {
  it('shows and speaks Markdown from the model as plain text (seen live 2026-10-21)', () => {
    expect(plainText('Milk for each cow: - **Geeta**: No milk recorded. - **Lakshmi**: 104.5 litres.')).toBe('Milk for each cow:\n• Geeta: No milk recorded.\n• Lakshmi: 104.5 litres.');
    expect(speakable('**Lakshmi** gave ₹2,500.00')).toBe('Lakshmi gave 2,500 rupees');
  });
  it('leaves ordinary text alone, including dates and negative-looking ranges', () => {
    expect(plainText('From 2026-10-14 to 2026-10-20 you spent ₹3,700.00.')).toBe('From 2026-10-14 to 2026-10-20 you spent ₹3,700.00.');
  });
});


describe('speak (reply read aloud)', () => {
  /** A stand-in speech engine: records calls; an utterance "finishes" when the test says so. */
  function fakeEngine(busy: boolean) {
    const calls: string[] = [];
    const spoken: Array<{ text: string; onend?: () => void }> = [];
    const synth = {
      speaking: busy,
      pending: false,
      cancel: () => calls.push('cancel'),
      resume: () => calls.push('resume'),
      speak: (u: { text: string; onend?: () => void }) => (calls.push(`speak:${u.text}`), spoken.push(u)),
      getVoices: () => [{ name: 'Test Female', lang: 'en-IN', localService: true }],
    };
    class Utterance {
      lang = '';
      voice: unknown = null;
      rate = 1;
      onend?: () => void;
      onerror?: () => void;
      constructor(readonly text: string) {}
    }
    vi.stubGlobal('window', { speechSynthesis: synth });
    vi.stubGlobal('SpeechSynthesisUtterance', Utterance);
    return { calls, spoken };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('speaks straight away when nothing is playing (no cancel right before speak)', async () => {
    const { calls, spoken } = fakeEngine(false);
    const done = speak('Recorded ₹500.00 on feed.', 'en-IN');
    await new Promise((r) => setTimeout(r, 0)); // speak() first waits for the voice list
    expect(calls).toEqual(['resume', 'speak:Recorded 500 rupees on feed.']);
    spoken[0]!.onend!();
    await done;
  });

  it('when a reply is still playing, cancels it and starts the new one a moment later', async () => {
    vi.useFakeTimers();
    const { calls } = fakeEngine(true);
    void speak('Okay, nothing was saved.', 'en-IN');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['cancel']);
    await vi.advanceTimersByTimeAsync(120);
    expect(calls).toEqual(['cancel', 'resume', 'speak:Okay, nothing was saved.']);
  });

  it('never cuts a slow voice short while the engine is still speaking (Edge natural voices)', async () => {
    vi.useFakeTimers();
    const { calls, spoken } = fakeEngine(false);
    const text = 'Spent 3,700 rupees in total from 21 October 2026 to 21 October 2026 (2 entries).';
    let finished = false;
    void speak(text, 'en-IN').then(() => (finished = true));
    await vi.advanceTimersByTimeAsync(0);
    (window.speechSynthesis as { speaking: boolean }).speaking = true;
    (spoken[0] as { onstart?: () => void }).onstart?.();
    await vi.advanceTimersByTimeAsync(20000); // well past the old 4 s + 90 ms per character limit
    expect(calls.filter((c) => c === 'cancel')).toEqual([]);
    expect(finished).toBe(false);
    spoken[0]!.onend!();
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(true);
  });

  it('moves on when the engine goes quiet but never fires onend (a Chrome bug)', async () => {
    vi.useFakeTimers();
    const { spoken } = fakeEngine(false);
    let finished = false;
    void speak('Recorded 500 rupees on feed.', 'en-IN').then(() => (finished = true));
    await vi.advanceTimersByTimeAsync(0);
    (spoken[0] as { onstart?: () => void }).onstart?.(); // engine idle from here, no onend
    await vi.advanceTimersByTimeAsync(2500);
    expect(finished).toBe(true);
  });
});

describe('speak: a browser without a voice for the language', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('stays silent (no foreign voice reading Tamil) and reports it, so the app can show the text-only note', async () => {
    const calls: string[] = [];
    vi.stubGlobal('window', { speechSynthesis: { speaking: false, pending: false, cancel: () => calls.push('cancel'), resume: () => calls.push('resume'), speak: () => calls.push('speak'), getVoices: () => [{ name: 'Google Deutsch', lang: 'de-DE' }, { name: 'Google UK English Female', lang: 'en-GB' }] } });
    vi.stubGlobal('SpeechSynthesisUtterance', class { constructor(readonly text: string) {} });
    const voice = await import('../../web/src/voice.js');
    await voice.speak('வணக்கம்', 'ta-IN');
    expect(calls).toEqual([]);
    expect(voice.lastSpeakSkippedFor).toBe('ta-IN');
  });
});
