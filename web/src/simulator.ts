/**
 * Alexa-style voice simulator: Ready (waiting for "Alexa") -> Listening -> Processing -> Speaking -> Ready.
 *
 * Why commands used to be cut off: recognition ran with `continuous = false`, so the browser ended it at the
 * first pause, and whatever had been heard by then was sent. Here recognition runs continuously and is
 * restarted when the browser ends it; a command is complete only after `silenceMs` with no new words and
 * a final (not interim) transcript. The mic is closed while a reply is processed and spoken, so the app
 * never hears itself as the next command.
 *
 * No DOM here: everything the simulator touches comes in through `SimDeps`, so it can be tested.
 */
import { extractCommand, isEcho, joinSegments, readResults, voiceError, type Recognition } from './voice.js';

export type SimState = 'off' | 'ready' | 'listening' | 'processing' | 'speaking' | 'error';

export interface SimView {
  /** Words heard so far for the command (wake word removed), or the command being processed. */
  transcript?: string;
  message?: string;
  /** Listening for a yes/no answer to a read-back, so no wake word is needed. */
  confirming?: boolean;
  /** Listening, but the microphone is not capturing yet: words said now would be lost. */
  starting?: boolean;
}

export interface SimReply {
  reply: string;
  awaitingConfirmation?: boolean;
}

export interface SimDeps {
  createRecognition(): Recognition | undefined;
  lang(): string;
  /** Sends a spoken command to the assistant; undefined when it failed (the chat shows the error). */
  submit(command: string): Promise<SimReply | undefined>;
  speakEnabled(): boolean;
  speak(text: string): Promise<void>;
  stopSpeaking(): void;
  /** Short tone after the wake word: the "Yes?" of a voice assistant, without words the mic could pick up. */
  chime(): void;
  onChange(state: SimState, view: SimView): void;
  /** The words heard never became final: put them in the text box for the farmer to check and send. */
  onIncomplete(text: string): void;
  onNotice(text: string): void;
  /** Optional event log for diagnosing voice problems on a real device (never sent anywhere). */
  trace?(event: string, detail?: string): void;
  /** Hands-free: after each reply, keep the mic on and wait for "Alexa". Off: the mic turns off after each reply. */
  handsFree?(): boolean;
}

export interface SimOptions {
  /** Quiet time after the last word before a command counts as finished. */
  silenceMs: number;
  /** How long to wait for a command after "Alexa" (or a tap) before going back to Ready. */
  commandTimeoutMs: number;
  /** Pause between the end of a spoken reply and reopening the mic, so the speaker has fallen silent. */
  resumeDelayMs: number;
}

export const DEFAULT_SIM_OPTIONS: SimOptions = { silenceMs: 1600, commandTimeoutMs: 8000, resumeDelayMs: 600 };

/** More browser-ended restarts than this within RESTART_WINDOW_MS means recognition is failing in a loop. */
const MAX_RESTARTS = 8;
const RESTART_WINDOW_MS = 20_000;
/** Extra silence periods to wait for an interim phrase to become final before giving it to the farmer to check. */
const MAX_EXTENSIONS = 2;
/** If a browser never reports that audio capture started, treat the mic as live after this long. */
const AUDIO_START_FALLBACK_MS = 1500;
/** A reply to a read-back question this short is sent as soon as it is final (no silence wait). */
const SHORT_ANSWER_WORDS = 3;

export class VoiceSimulator {
  state: SimState = 'off';
  private active = false;
  private rec: Recognition | undefined;
  /** Bumped whenever a recogniser is replaced, so late events from an old one are ignored. */
  private generation = 0;
  /** Final text from earlier recognition sessions of this same utterance (the browser ended one mid-sentence). */
  private carried = '';
  private sessionFinal = '';
  private interim = '';
  private confirming = false;
  /** Guard: one command at a time, and each utterance is sent at most once. */
  private busy = false;
  private extensions = 0;
  private silenceTimer: ReturnType<typeof setTimeout> | undefined;
  private commandTimer: ReturnType<typeof setTimeout> | undefined;
  private restarts: number[] = [];
  private lastSpoken = '';
  /** Results of the current recogniser already set aside (talk not meant for the assistant). */
  private skipResults = 0;
  /** True once the current recogniser is really capturing audio. */
  private micLive = false;
  /** The "your turn" tone has played for this listening phase (once only, not on every mic restart). */
  private cued = false;
  /** The wait for a command has started for this listening phase (once, when the mic first goes live). */
  private waitStarted = false;
  private audioStartTimer: ReturnType<typeof setTimeout> | undefined;
  private trace(event: string, detail?: string): void {
    this.deps.trace?.(event, detail);
  }

  constructor(
    private readonly deps: SimDeps,
    private readonly opts: SimOptions = DEFAULT_SIM_OPTIONS,
  ) {}

  get isActive(): boolean {
    return this.active;
  }

  /** Turns the mic on and waits for the wake word. Needs a user gesture the first time (browser permission). */
  start(): void {
    this.active = true;
    this.restarts = [];
    this.toReady();
  }

  /** Mic off, nothing pending. */
  stop(): void {
    this.active = false;
    this.clearTimers();
    this.closeMic();
    this.resetUtterance();
    this.deps.stopSpeaking();
    this.set('off');
  }

  /** The mic button: talk now (no wake word needed); while listening it cancels; while speaking it stops the voice. */
  talk(): void {
    switch (this.state) {
      case 'off':
      case 'error':
      case 'ready':
        this.active = true;
        if (this.state !== 'ready') this.restarts = [];
        this.listenForCommand(false);
        break;
      case 'listening':
        this.idle();
        break;
      case 'speaking':
        this.deps.stopSpeaking();
        break;
      case 'processing':
        break;
    }
  }

  /** Hands-free switched on: wait for "Alexa" now. Switched off: stop waiting (a command in progress finishes first). */
  handsFreeChanged(on: boolean): void {
    if (on && (this.state === 'off' || this.state === 'error')) this.start();
    else if (!on && this.state === 'ready') this.stop();
  }

  /** The orb: off/error -> on; ready -> talk now (no wake word); listening -> cancel; speaking -> stop talking. */
  tap(): void {
    switch (this.state) {
      case 'off':
      case 'error':
        this.start();
        break;
      case 'ready':
        this.listenForCommand(false);
        break;
      case 'listening':
        this.idle();
        break;
      case 'speaking':
        this.deps.stopSpeaking(); // the speak() promise resolves and the simulator moves on
        break;
      case 'processing':
        break;
    }
  }

  /** The farmer answered with a button or typed instead: drop any voice command in progress. */
  cancelCommand(): void {
    if (this.active && this.state === 'listening') this.idle();
  }

  /** Reads text aloud as the assistant (e.g. a photo answer), pausing the mic so it is not heard as a command. */
  async say(text: string): Promise<void> {
    if (!this.deps.speakEnabled() || !text) return;
    if (!this.active) return this.deps.speak(text);
    if (this.state === 'processing') return;
    this.clearTimers();
    this.closeMic();
    await this.speakReply(text);
    if (this.active && this.state === 'speaking') this.idle();
  }

  // ---------------------------------------------------------------- states

  private set(state: SimState, view: SimView = {}): void {
    if (state !== this.state) this.trace(`state:${state}`);
    this.state = state;
    this.deps.onChange(state, state === 'listening' ? { ...view, starting: !this.micLive } : view);
  }

  private toReady(): void {
    this.clearTimers();
    this.resetUtterance();
    this.confirming = false;
    this.set('ready');
    this.openMic();
  }

  /** After a command (or a cancelled one): wait for "Alexa" when hands-free is on, otherwise turn the mic off. */
  private idle(): void {
    if (this.deps.handsFree?.() ?? true) this.toReady();
    else this.stop();
  }

  private listenForCommand(confirming: boolean): void {
    this.clearTimers();
    this.resetUtterance();
    this.confirming = confirming;
    this.cued = false;
    this.waitStarted = false;
    this.openMic(); // before set(): the screen says "One moment" until the mic is really capturing
    this.set('listening', { confirming });
    this.armCommandTimeout();
  }

  /**
   * The microphone is really capturing now. Until this moment a phone may still be starting it, and words
   * said then are lost (reproduced: "yes" said right after the read-back was never heard).
   */
  private onAudioStart(): void {
    clearTimeout(this.audioStartTimer);
    if (this.micLive) return;
    this.micLive = true;
    this.trace('mic:live');
    if (this.state !== 'listening') return;
    // The "your turn" tone, then the screen switches from "One moment" to "Listening…".
    if (!this.cued && (this.confirming || !this.heardText())) {
      this.cued = true;
      this.deps.chime();
    }
    this.deps.onChange('listening', { confirming: this.confirming, starting: false, transcript: this.commandOf(this.heardText()) || undefined });
    // The wait for an answer starts when the farmer can first be heard. Only once: phones restart the mic
    // every few quiet seconds, and re-arming here kept an unanswered mic open forever (caught in testing).
    if (!this.waitStarted) {
      this.waitStarted = true;
      this.armCommandTimeout();
    }
  }

  private fail(code: string): void {
    const error = voiceError(code);
    this.clearTimers();
    this.closeMic();
    this.resetUtterance();
    this.active = false; // the orb (or "Try again") turns it back on; never keep retrying on our own
    this.set('error', { message: error.message });
  }

  // ---------------------------------------------------------------- microphone

  private openMic(): void {
    this.closeMic();
    const rec = this.deps.createRecognition();
    if (!rec) return this.fail('service-not-allowed');
    const generation = ++this.generation;
    this.skipResults = 0;
    this.micLive = false;
    rec.lang = this.deps.lang();
    rec.continuous = true; // keep listening through pauses; we decide when a command is finished
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = (event) => generation === this.generation && this.onResult(readResults(event, this.skipResults));
    rec.onerror = (event) => generation === this.generation && this.onError(event.error);
    rec.onend = () => generation === this.generation && this.onEnd();
    rec.onaudiostart = () => generation === this.generation && this.onAudioStart();
    this.rec = rec;
    try {
      rec.start();
      this.trace('rec:start', rec.lang);
    } catch {
      return this.fail('start-failed');
    }
    clearTimeout(this.audioStartTimer);
    this.audioStartTimer = setTimeout(() => generation === this.generation && this.onAudioStart(), AUDIO_START_FALLBACK_MS);
  }

  private closeMic(): void {
    this.generation++;
    const rec = this.rec;
    this.rec = undefined;
    this.micLive = false;
    clearTimeout(this.audioStartTimer);
    if (!rec) return;
    this.trace('rec:abort');
    rec.onresult = rec.onerror = rec.onend = rec.onaudiostart = null;
    try {
      rec.abort();
    } catch {
      /* already stopped */
    }
  }

  /** The browser ended recognition (its own time limit, or Android after every phrase). Carry on listening. */
  private onEnd(): void {
    this.rec = undefined;
    this.micLive = false;
    this.trace('rec:end');
    if (!this.active || (this.state !== 'ready' && this.state !== 'listening')) return;
    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
    this.restarts.push(now);
    if (this.restarts.length > MAX_RESTARTS) return this.fail('restart-loop');
    // Keep what was heard: the farmer may still be in the middle of the sentence. Words still marked interim
    // count too: this session is over, so the browser will never revise them (reproduced: a short "yes" that
    // was only ever interim was dropped here and the answer was lost).
    this.carried = joinSegments([this.carried, this.sessionFinal, this.interim]);
    this.sessionFinal = '';
    this.interim = '';
    this.openMic();
  }

  private onError(code: string): void {
    this.trace('rec:error', code);
    // "no-speech" and "aborted" are normal while waiting; onend follows and the mic reopens.
    if (code === 'no-speech' || code === 'aborted') return;
    this.fail(code);
  }

  // ---------------------------------------------------------------- what was heard

  private finalText(): string {
    return joinSegments([this.carried, this.sessionFinal]);
  }

  private heardText(): string {
    return joinSegments([this.finalText(), this.interim]);
  }

  /** The command part: after the wake word when there is one ("Alexa, yes" -> "yes"). */
  private commandOf(text: string): string {
    const { wake, command } = extractCommand(text);
    return wake || this.state === 'listening' ? command : '';
  }

  private onResult(result: { final: string; interim: string; count: number }): void {
    this.sessionFinal = result.final;
    this.interim = result.interim;
    const heard = this.heardText();
    this.trace(result.interim ? 'heard:interim' : 'heard:final', heard);

    if (this.state === 'ready') {
      if (!extractCommand(heard).wake) {
        // Talk that was not meant for the assistant: once it is final, set it aside. The recogniser is not
        // restarted for this: on phones every restart can make the browser's own "listening" sound.
        if (result.final && !result.interim) {
          this.skipResults = result.count;
          this.resetUtterance();
        }
        return;
      }
      this.deps.chime();
      this.cued = true;
      this.waitStarted = true;
      this.confirming = false;
      this.set('listening', {});
      this.armCommandTimeout();
    }
    if (this.state !== 'listening') return;

    const command = this.commandOf(heard);
    this.deps.onChange('listening', { transcript: command, confirming: this.confirming, starting: !this.micLive });
    if (command) {
      clearTimeout(this.commandTimer);
      this.extensions = 0;
      // A short, final answer to a read-back ("yes", "no", "haan") is sent at once.
      const finalCommand = this.commandOf(this.finalText());
      if (this.confirming && !this.interim && finalCommand && finalCommand.split(/\s+/).length <= SHORT_ANSWER_WORDS) {
        clearTimeout(this.silenceTimer);
        void this.finish(finalCommand);
        return;
      }
      this.armSilence();
    }
  }

  private armSilence(): void {
    clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => this.onSilence(), this.opts.silenceMs);
  }

  private armCommandTimeout(): void {
    clearTimeout(this.commandTimer);
    this.commandTimer = setTimeout(() => {
      if (this.state !== 'listening' || this.commandOf(this.heardText())) return;
      this.deps.onNotice(this.confirming ? 'I did not hear yes or no, so nothing was saved yet. Tap Yes or No, or say "Alexa, yes".' : "I didn't hear a question. Say \"Alexa\" and try again, or type below.");
      this.idle();
    }, this.opts.commandTimeoutMs);
  }

  /** No new words for `silenceMs`: send the command if its words are final, otherwise wait a little or hand it over. */
  private onSilence(): void {
    if (this.state !== 'listening') return;
    if (this.interim && this.extensions < MAX_EXTENSIONS) {
      this.extensions++;
      return this.armSilence();
    }
    const command = this.commandOf(this.finalText());
    if (this.interim || !command) {
      // Never send words the recogniser was not sure of: let the farmer check them first.
      const heard = this.commandOf(this.heardText());
      this.idle();
      if (heard) this.deps.onIncomplete(heard);
      return;
    }
    void this.finish(command);
  }

  private async finish(command: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.clearTimers();
    this.closeMic();
    this.resetUtterance();
    try {
      this.trace('send', command);
      if (isEcho(command, this.lastSpoken)) {
        // The speaker came back through the mic (heard live, 2026-10-16). Never send that as the farmer's words.
        this.deps.onNotice('That sounded like my own voice, so I ignored it. Say "Alexa" and speak again.');
        return this.idle();
      }
      this.set('processing', { transcript: command });
      const reply = await this.deps.submit(command);
      if (!this.active) return;
      if (!reply) return this.idle();
      if (this.deps.speakEnabled()) await this.speakReply(reply.reply);
      if (!this.active) return;
      // A read-back question ("Shall I record ₹500…?") is answered without saying "Alexa" again.
      if (reply.awaitingConfirmation) this.listenForCommand(true);
      else this.idle();
    } finally {
      this.busy = false;
    }
  }

  private async speakReply(text: string): Promise<void> {
    this.set('speaking', {});
    this.lastSpoken = text;
    this.trace('speak:start');
    await this.deps.speak(text);
    this.trace('speak:end');
    await new Promise((resolve) => setTimeout(resolve, this.opts.resumeDelayMs));
  }

  private resetUtterance(): void {
    this.carried = '';
    this.sessionFinal = '';
    this.interim = '';
    this.extensions = 0;
  }

  private clearTimers(): void {
    clearTimeout(this.silenceTimer);
    clearTimeout(this.commandTimer);
    clearTimeout(this.audioStartTimer);
  }
}
