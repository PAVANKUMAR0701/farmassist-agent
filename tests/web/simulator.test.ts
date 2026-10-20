import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceSimulator, type SimDeps, type SimReply, type SimState } from '../../web/src/simulator.js';
import { extractCommand, joinSegments, type Recognition, type RecognitionResultEvent } from '../../web/src/voice.js';

/** A stand-in for the browser recogniser: the test says what it "hears". */
class FakeRecognition implements Recognition {
  lang = '';
  interimResults = false;
  continuous = false;
  maxAlternatives = 1;
  onresult: ((event: RecognitionResultEvent) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  running = false;
  private results: Array<{ isFinal: boolean; 0: { transcript: string } }> = [];
  start() {
    this.running = true;
  }
  stop() {
    this.end();
  }
  abort() {
    this.running = false;
  }
  /** Adds a result. Interim results are replaced by the next one, like the browser does. */
  hear(text: string, isFinal = true) {
    if (this.results.length && !this.results.at(-1)!.isFinal) this.results.pop();
    this.results.push({ isFinal, 0: { transcript: text } });
    this.onresult?.({ resultIndex: this.results.length - 1, results: this.results });
  }
  error(code: string) {
    this.onerror?.({ error: code });
    this.end();
  }
  end() {
    this.running = false;
    this.onend?.();
  }
}

function setup(reply: SimReply | undefined = { reply: 'Spent ₹3,700.00 today.' }, speakEnabled = true) {
  const recognisers: FakeRecognition[] = [];
  const states: SimState[] = [];
  const views: Array<{ state: SimState; transcript?: string; message?: string }> = [];
  const deps = {
    createRecognition: () => {
      const r = new FakeRecognition();
      recognisers.push(r);
      return r;
    },
    lang: () => 'en-IN',
    submit: vi.fn(async (_command: string) => reply),
    speakEnabled: () => speakEnabled,
    speak: vi.fn(async (_text: string) => {}),
    stopSpeaking: vi.fn(),
    chime: vi.fn(),
    onChange: (state: SimState, view: { transcript?: string; message?: string }) => {
      if (states.at(-1) !== state) states.push(state);
      views.push({ state, ...view });
    },
    onIncomplete: vi.fn(),
    onNotice: vi.fn(),
  } satisfies SimDeps;
  const sim = new VoiceSimulator(deps, { silenceMs: 1000, commandTimeoutMs: 5000, resumeDelayMs: 100 });
  const mic = () => recognisers.filter((r) => r.running).at(-1)!;
  return { sim, deps, states, views, mic, recognisers };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('extractCommand', () => {
  it('finds the wake word and keeps the words after it', () => {
    expect(extractCommand('Alexa, how much did I spend today?')).toEqual({ wake: true, command: 'how much did I spend today?' });
    expect(extractCommand('hey alexa record ₹500 for feed')).toEqual({ wake: true, command: 'record ₹500 for feed' });
    expect(extractCommand('Alexa')).toEqual({ wake: true, command: '' });
    expect(extractCommand('एलेक्सा आज कितना खर्च हुआ')).toEqual({ wake: true, command: 'आज कितना खर्च हुआ' });
    expect(extractCommand('அலெக்சா இன்று எவ்வளவு செலவு')).toEqual({ wake: true, command: 'இன்று எவ்வளவு செலவு' });
  });
  it('does not see a wake word inside other words', () => {
    expect(extractCommand('how much did I spend').wake).toBe(false);
    expect(extractCommand('alexander bought feed').wake).toBe(false);
  });
});

describe('joinSegments', () => {
  it('joins separate final segments', () => {
    expect(joinSegments(['how much did I', ' spend today'])).toBe('how much did I spend today');
  });
  it("does not double Android's repeated (cumulative) results", () => {
    expect(joinSegments(['how much', 'how much did I spend'])).toBe('how much did I spend');
    expect(joinSegments(['how much did I spend', 'how much did I spend'])).toBe('how much did I spend');
    expect(joinSegments(['alexa', 'spend today', 'spend today'])).toBe('alexa spend today');
  });
});

describe('VoiceSimulator', () => {
  it('waits in Ready, and "Alexa" alone starts Listening without sending anything', async () => {
    const { sim, deps, states, mic } = setup();
    sim.start();
    expect(sim.state).toBe('ready');
    mic().hear('Alexa');
    expect(sim.state).toBe('listening');
    expect(deps.chime).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3000);
    expect(deps.submit).not.toHaveBeenCalled();
    expect(states).toEqual(['ready', 'listening']);
  });

  it('"Alexa" then a separate command sends only the command, once', async () => {
    const { sim, deps, mic } = setup();
    sim.start();
    mic().hear('Alexa');
    await vi.advanceTimersByTimeAsync(1500);
    mic().hear('how much did I spend today');
    await vi.advanceTimersByTimeAsync(1000);
    expect(deps.submit).toHaveBeenCalledExactlyOnceWith('how much did I spend today');
  });

  it('"Alexa, <command>" in one breath works', async () => {
    const { sim, deps, mic } = setup();
    sim.start();
    mic().hear('Alexa how much milk did my cows give', false);
    expect(sim.state).toBe('listening');
    mic().hear('Alexa how much milk did my cows give today');
    await vi.advanceTimersByTimeAsync(1000);
    expect(deps.submit).toHaveBeenCalledExactlyOnceWith('how much milk did my cows give today');
  });

  it('a pause mid-sentence does not cut the command short', async () => {
    const { sim, deps, mic } = setup();
    sim.start();
    mic().hear('Alexa record 500 rupees');
    await vi.advanceTimersByTimeAsync(800); // shorter than the silence period
    mic().hear('for cattle feed');
    await vi.advanceTimersByTimeAsync(999);
    expect(deps.submit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.submit).toHaveBeenCalledExactlyOnceWith('record 500 rupees for cattle feed');
  });

  it('keeps the start of the sentence when the browser ends recognition mid-sentence (Android)', async () => {
    const { sim, deps, mic, recognisers } = setup();
    sim.start();
    mic().hear('Alexa how much did I');
    mic().end(); // the browser stops after a phrase; the simulator reopens the mic
    expect(recognisers.length).toBe(2);
    mic().hear('spend on feed this month');
    await vi.advanceTimersByTimeAsync(1000);
    expect(deps.submit).toHaveBeenCalledExactlyOnceWith('how much did I spend on feed this month');
  });

  it('never sends words that are still interim; hands them to the farmer to check instead', async () => {
    const { sim, deps, mic } = setup();
    sim.start();
    mic().hear('Alexa spent 600 on', false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(deps.submit).not.toHaveBeenCalled();
    expect(deps.onIncomplete).toHaveBeenCalledWith('spent 600 on');
    expect(sim.state).toBe('ready');
  });

  it('never sends the same command twice, even if results keep arriving', async () => {
    let finishSubmit: (r: SimReply) => void = () => {};
    const { sim, deps, mic, recognisers } = setup();
    deps.submit.mockImplementation(() => new Promise<SimReply>((resolve) => (finishSubmit = resolve)));
    sim.start();
    const first = mic();
    first.hear('Alexa spent 500 on feed');
    await vi.advanceTimersByTimeAsync(1000);
    expect(sim.state).toBe('processing');
    expect(first.running).toBe(false); // the mic is closed while processing
    first.hear('Alexa spent 500 on feed'); // a late event from the old recogniser
    await vi.advanceTimersByTimeAsync(5000);
    finishSubmit({ reply: 'Recorded ₹500.00 on feed.' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(deps.submit).toHaveBeenCalledOnce();
    expect(recognisers.filter((r) => r.running)).toHaveLength(1);
  });

  it('closes the mic while speaking, so its own reply is never taken as a command', async () => {
    let finishSpeaking: () => void = () => {};
    const { sim, deps, mic, states } = setup();
    deps.speak.mockImplementation(() => new Promise<void>((resolve) => (finishSpeaking = resolve)));
    sim.start();
    mic().hear('Alexa how much did I spend today');
    await vi.advanceTimersByTimeAsync(1000);
    expect(sim.state).toBe('speaking');
    expect(mic()).toBeUndefined(); // no recogniser running
    finishSpeaking();
    await vi.advanceTimersByTimeAsync(100);
    expect(sim.state).toBe('ready');
    expect(states).toEqual(['ready', 'listening', 'processing', 'speaking', 'ready']);
    // The reply coming back through the mic after the wake word is recognised as an echo.
    mic().hear('Alexa spent 3700 rupees today');
    await vi.advanceTimersByTimeAsync(1000);
    expect(deps.submit).toHaveBeenCalledOnce();
    expect(deps.onNotice).toHaveBeenCalled();
  });

  it('after a read-back question, listens for yes/no without the wake word', async () => {
    const { sim, deps, mic } = setup({ reply: 'Shall I record ₹500.00 on feed? Say yes to save it, or no to cancel.', awaitingConfirmation: true });
    sim.start();
    mic().hear('Alexa spent 500 on feed');
    await vi.advanceTimersByTimeAsync(1000 + 100);
    expect(sim.state).toBe('listening');
    mic().hear('yes');
    await vi.advanceTimersByTimeAsync(1000);
    expect(deps.submit).toHaveBeenNthCalledWith(2, 'yes');
  });

  it('a blocked microphone shows a useful error and stops trying', () => {
    const { sim, views, mic, recognisers } = setup();
    sim.start();
    mic().error('not-allowed');
    expect(sim.state).toBe('error');
    expect(views.at(-1)!.message).toMatch(/Microphone access is blocked/);
    expect(recognisers.filter((r) => r.running)).toHaveLength(0);
    expect(sim.isActive).toBe(false);
  });

  it('keeps waiting through "no-speech" timeouts, but gives up on a restart loop', () => {
    const { sim, mic } = setup();
    sim.start();
    mic().error('no-speech');
    expect(sim.state).toBe('ready');
    for (let i = 0; i < 9 && sim.state === 'ready'; i++) mic().end();
    expect(sim.state).toBe('error');
  });

  it('the orb: tap in Ready talks without the wake word; tap while Listening cancels', async () => {
    const { sim, deps, mic } = setup();
    sim.tap();
    expect(sim.state).toBe('ready');
    sim.tap();
    expect(sim.state).toBe('listening');
    sim.tap();
    expect(sim.state).toBe('ready');
    sim.tap();
    mic().hear('show my crop details');
    await vi.advanceTimersByTimeAsync(1000);
    expect(deps.submit).toHaveBeenCalledExactlyOnceWith('show my crop details');
  });

  it('chatter without the wake word is never sent', async () => {
    const { sim, deps, mic } = setup();
    sim.start();
    mic().hear('the calf needs water');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deps.submit).not.toHaveBeenCalled();
    expect(sim.state).toBe('ready');
  });
});
