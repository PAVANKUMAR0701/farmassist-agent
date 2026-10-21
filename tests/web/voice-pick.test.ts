import { describe, expect, it } from 'vitest';
import { pickVoice, voicesFor, type VoiceLike } from '../../web/src/voice.js';

// Voice lists measured on this Windows laptop on 2026-10-21 (Chrome 155 / Edge 155), trimmed to the
// languages the app speaks plus each browser's default voice. Names differ per browser: that is the point.
const v = (name: string, lang: string, local = false): VoiceLike => ({ name, lang, localService: local });
const CHROME = [
  v('Google Deutsch', 'de-DE'), // Chrome's default voice on this machine
  v('Microsoft David - English (United States)', 'en-US', true),
  v('Microsoft Mark - English (United States)', 'en-US', true),
  v('Microsoft Zira - English (United States)', 'en-US', true),
  v('Google US English', 'en-US'),
  v('Google UK English Female', 'en-GB'),
  v('Google UK English Male', 'en-GB'),
  v('Google हिन्दी', 'hi-IN'),
];
const EDGE = [
  v('Microsoft Adri Online (Natural) - Afrikaans (South Africa)', 'af-ZA'), // Edge's default voice here
  v('Microsoft David - English (United States)', 'en-US', true),
  v('Microsoft Zira - English (United States)', 'en-US', true),
  v('Microsoft Sonia Online (Natural) - English (United Kingdom)', 'en-GB'),
  v('Microsoft Ryan Online (Natural) - English (United Kingdom)', 'en-GB'),
  v('Microsoft Neerja Online (Natural) - English (India)', 'en-IN'),
  v('Microsoft Prabhat Online (Natural) - English (India)', 'en-IN'),
  v('Microsoft Guy Online (Natural) - English (United States)', 'en-US'),
  v('Microsoft स्वरा Online (Natural) - Hindi (India)', 'hi-IN'),
  v('Microsoft मधुर Online (Natural) - Hindi (India)', 'hi-IN'),
  v('Microsoft பல்லவி Online (Natural) - Tamil (India)', 'ta-IN'),
  v('Microsoft வள்ளுவர் Online (Natural) - Tamil (India)', 'ta-IN'),
];

describe('pickVoice: a female voice in the farmer\'s language, in every browser', () => {
  it('Edge: the Indian female voices (Neerja, Swara, Pallavi), never the Afrikaans default', () => {
    expect(pickVoice(EDGE, 'en-IN')?.name).toMatch(/Neerja/);
    expect(pickVoice(EDGE, 'hi-IN')?.name).toMatch(/स्वरा/);
    expect(pickVoice(EDGE, 'ta-IN')?.name).toMatch(/பல்லவி/);
  });

  it('Chrome: a female English voice (not "Microsoft David", which the old code picked), and Google Hindi', () => {
    expect(pickVoice(CHROME, 'en-IN')?.name).toBe('Google UK English Female');
    expect(pickVoice(CHROME, 'hi-IN')?.name).toBe('Google हिन्दी');
  });

  it('a browser with no voice for the language gets none, so its default (German) voice never reads Tamil', () => {
    expect(pickVoice(CHROME, 'ta-IN')).toBeUndefined();
  });

  it('a saved voice is used where this browser has it, and ignored gracefully where it does not', () => {
    expect(pickVoice(EDGE, 'en-IN', 'Microsoft Sonia Online (Natural) - English (United Kingdom)')?.name).toMatch(/Sonia/);
    // The same saved name in Chrome does not exist: fall back to the automatic female choice.
    expect(pickVoice(CHROME, 'en-IN', 'Microsoft Sonia Online (Natural) - English (United Kingdom)')?.name).toBe('Google UK English Female');
    // A saved voice from another language is not used for this one.
    expect(pickVoice(EDGE, 'en-IN', 'Microsoft स्वरा Online (Natural) - Hindi (India)')?.name).toMatch(/Neerja/);
  });

  it('Firefox-like systems with only Windows voices still get a female English voice', () => {
    const windowsOnly = [v('Microsoft David - English (United States)', 'en-US', true), v('Microsoft Zira - English (United States)', 'en-US', true)];
    expect(pickVoice(windowsOnly, 'en-IN')?.name).toMatch(/Zira/);
  });

  it('voicesFor lists the language\'s voices for the settings menu, nearest region first', () => {
    expect(voicesFor(EDGE, 'en-IN').map((x) => x.name.split(' ')[1])).toEqual(['Neerja', 'Prabhat', 'Sonia', 'Ryan', 'Zira', 'David', 'Guy']);
    expect(voicesFor(CHROME, 'ta-IN')).toEqual([]);
  });
});
