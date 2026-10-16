/**
 * Confirmation before writing, for voice turns. Speech recognition can mishear ("250" vs "2500"), so a spoken
 * request to change the ledger is read back first and only saved after the farmer says yes.
 *
 * The read-back is built by code from the exact tool arguments that would be sent, never written by a model.
 */
import { formatPaise, rupeesToPaise } from '../shared/money.js';

/** A write the agent is holding until the farmer confirms it. */
export interface PendingAction {
  name: string;
  args: Record<string, unknown>;
  prompt: string;
  /** Who proposed it, for the turn that finally runs it. */
  mode: 'model' | 'fallback';
}

function rupees(value: unknown): string {
  try {
    return formatPaise(rupeesToPaise(Number(value)));
  } catch {
    return `₹${String(value)}`; // invalid amounts are refused by the server when confirmed
  }
}

const when = (args: Record<string, unknown>) => (typeof args.date === 'string' ? ` for ${args.date}` : ' for today');

/** "record ₹2,500.00 on feed for today", "record vaccination for brown cow for 2026-10-14", ... */
export function describeAction(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'record_expense':
      return `record ${rupees(args.amountRupees)} on ${String(args.category)}${when(args)}`;
    case 'record_farm_activity': {
      const what = args.activityType === 'other' && typeof args.note === 'string' ? `"${args.note}"` : String(args.activityType);
      return `record ${what}${typeof args.animalOrField === 'string' ? ` for ${args.animalOrField}` : ''}${when(args)}`;
    }
    case 'correct_entry': {
      const changes = [
        args.newAmountRupees !== undefined ? `the amount to ${rupees(args.newAmountRupees)}` : '',
        typeof args.newCategory === 'string' ? `the category to ${args.newCategory}` : '',
        typeof args.newNote === 'string' ? (args.newNote ? `the note to "${args.newNote}"` : 'remove the note') : '',
      ].filter(Boolean);
      return `change ${changes.join(' and ') || 'that expense'}${changes.length ? ' on that expense' : ''}`;
    }
    default:
      return `run ${name}`;
  }
}

export const confirmationPrompt = (name: string, args: Record<string, unknown>) =>
  `Shall I ${describeAction(name, args)}? Say yes to save it, or no to cancel.`;

// English, Hindi/Hinglish and Tamil (romanised and native script).
const YES = new Set(['yes', 'yeah', 'yep', 'ya', 'ok', 'okay', 'sure', 'confirm', 'confirmed', 'correct', 'right', 'save', 'haan', 'han', 'ha', 'haa', 'ji', 'sari', 'seri', 'aama', 'aamaa', 'ama', 'हाँ', 'हां', 'हा', 'जी', 'ठीक', 'ஆமா', 'ஆம்', 'சரி']);
const YES_PHRASES = ['go ahead', 'do it', 'theek hai', 'thik hai', 'save it', 'yes please'];
const NO = new Set(['no', 'nope', 'cancel', 'stop', 'wrong', 'dont', "don't", 'nahi', 'nahin', 'na', 'mat', 'illa', 'illai', 'venda', 'vendam', 'नहीं', 'ना', 'मत', 'இல்லை', 'வேண்டாம்', 'வேணாம்']);

/**
 * Reads a reply to a confirmation question. Only short answers count: "no, it was 250" is a new
 * request (the pending write is dropped and the message handled normally), not a bare "no".
 */
export function confirmationAnswer(message: string): 'yes' | 'no' | 'other' {
  const text = message.toLowerCase().replace(/['’]/g, '').replace(/[.,!?।"]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = text.split(' ').filter(Boolean);
  if (words.length === 0) return 'other';
  const negated = words.some((w) => NO.has(w));
  if (!negated && words.length <= 4 && (YES.has(words[0]!) || YES_PHRASES.some((p) => text.startsWith(p)))) return 'yes';
  if (words.length <= 3 && NO.has(words[0]!)) return 'no';
  return 'other';
}
