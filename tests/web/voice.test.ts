import { describe, expect, it } from 'vitest';
import { isEcho, plainText, speakable } from '../../web/src/voice.js';

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

