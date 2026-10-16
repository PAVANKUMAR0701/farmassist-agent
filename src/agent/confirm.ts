/**
 * Confirmation before writing, for voice turns. Speech recognition can mishear ("250" vs "2500"), so a spoken
 * request to change the ledger is read back first and only saved after the farmer says yes.
 *
 * The read-back is built by code from the exact tool arguments that would be sent, never written by a model.
 */
import { formatPaise, rupeesToPaise } from '../shared/money.js';

export interface ProposedChange {
  name: string;
  args: Record<string, unknown>;
}

/** The changes the agent is holding until the farmer confirms them (one message may ask for several). */
export interface PendingAction {
  changes: ProposedChange[];
  prompt: string;
  /** Who proposed them, for the turn that finally runs them. */
  mode: 'model' | 'fallback';
  /** The farmer's message that asked for them (kept for the history once they are confirmed or cancelled). */
  request?: string;
}

/** Most changes one confirmation may cover; a longer list is cut and the farmer told to send the rest again. */
export const MAX_CHANGES_PER_CONFIRMATION = 5;

function rupees(value: unknown): string {
  try {
    return formatPaise(rupeesToPaise(Number(value)));
  } catch {
    return `₹${String(value)}`; // invalid amounts are refused by the server when confirmed
  }
}

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const article = (noun: string) => `${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun}`;
const pluralType = (type: string) => ({ calf: 'calves', sheep: 'sheep', buffalo: 'buffaloes' })[type] ?? `${type}s`;

type AnimalArgs = Record<string, unknown>;
/** register_animal takes a list; older single-animal arguments are read as a list of one. */
const animalsOf = (args: Record<string, unknown>): AnimalArgs[] => (Array.isArray(args.animals) ? (args.animals as AnimalArgs[]) : [args]);
const oneAnimal = (a: AnimalArgs) => {
  const details = [
    text(a.breed),
    text(a.name) && text(a.tagNumber) ? `tag ${text(a.tagNumber)}` : undefined,
    text(a.birthDate) ? `born ${text(a.birthDate)}` : undefined,
    text(a.motherName) ? `mother ${text(a.motherName)}` : undefined,
  ].filter(Boolean);
  return `${text(a.name) ?? (text(a.tagNumber) ? `tag ${text(a.tagNumber)}` : 'unnamed')}${details.length ? ` (${details.join(', ')})` : ''}`;
};

/** "register 4 cows: Lakshmi (HF), Maya, Geeta and Rita", or "register a cow named Maya and a calf named Seetha". */
function describeAnimals(animals: AnimalArgs[]): string {
  const join = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
  const type = text(animals[0]?.type) ?? 'animal';
  if (animals.length === 1) return `register ${article(type)}${text(animals[0]!.name) ? ` named ${oneAnimal(animals[0]!)}` : ` (${oneAnimal(animals[0]!)})`}`;
  if (animals.every((a) => a.type === animals[0]!.type)) return `register ${animals.length} ${pluralType(type)}: ${join(animals.map(oneAnimal))}`;
  return `register ${join(animals.map((a) => `${article(text(a.type) ?? 'animal')} named ${oneAnimal(a)}`))}`;
}

/** "the expense from 2026-10-16" (date taken from the entry id) or "the feed expense from today" (match lookup). */
function whichExpense(args: Record<string, unknown>): string {
  const fromId = typeof args.entryId === 'string' ? /^exp_(\d{4})(\d{2})(\d{2})_/.exec(args.entryId) : null;
  if (fromId) return `the expense from ${fromId[1]}-${fromId[2]}-${fromId[3]}`;
  const match = (args.match ?? {}) as { date?: unknown; category?: unknown };
  return `the ${typeof match.category === 'string' ? `${match.category} ` : ''}expense from ${typeof match.date === 'string' ? match.date : 'today'}`;
}

const when = (args: Record<string, unknown>) => (typeof args.date === 'string' ? ` for ${args.date}` : ' for today');

/** "record ₹2,500.00 on feed for today", "record vaccination for brown cow for 2026-10-14", ... */
export function describeAction(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'record_expense':
      return `record ${rupees(args.amountRupees)} on ${typeof args.category === 'string' ? args.category : 'an unknown category'}${when(args)}`;
    case 'record_farm_activity': {
      const note = typeof args.note === 'string' ? `"${args.note}"` : undefined;
      const what = (args.activityType === 'other' || typeof args.activityType !== 'string' ? note : undefined) ?? (typeof args.activityType === 'string' ? args.activityType : 'an activity');
      return `record ${what}${typeof args.animalOrField === 'string' ? ` for ${args.animalOrField}` : ''}${when(args)}`;
    }
    case 'correct_entry': {
      const changes = [
        args.newAmountRupees !== undefined ? `the amount to ${rupees(args.newAmountRupees)}` : '',
        typeof args.newCategory === 'string' ? `the category to ${args.newCategory}` : '',
        typeof args.newNote === 'string' ? (args.newNote ? `the note to "${args.newNote}"` : 'remove the note') : '',
      ].filter(Boolean);
      return `change ${changes.join(' and ') || 'nothing'} on ${whichExpense(args)}`;
    }
    case 'register_animal':
      return describeAnimals(animalsOf(args));
    case 'update_animal': {
      const who = text(args.animalName) ?? 'that animal';
      const changes = [
        text(args.newName) && text(args.newName)!.toLowerCase() !== who.toLowerCase() ? `rename ${who} to ${text(args.newName)}` : '',
        text(args.status) && args.status !== 'active' ? `mark ${who} as ${text(args.status)}` : '',
        ...(['type', 'breed', 'sex', 'tagNumber', 'birthDate', 'motherName', 'notes'] as const).map((f) => (text(args[f]) ? `set ${who}'s ${f === 'tagNumber' ? 'tag' : f === 'birthDate' ? 'birth date' : f === 'motherName' ? 'mother' : f} to ${text(args[f])}` : '')),
      ].filter(Boolean);
      return changes.join(' and ') || `change ${who}`;
    }
    case 'record_milk':
      return `record ${String(args.litres)} litres of milk${text(args.animalName) ? ` from ${text(args.animalName)}` : ' for the whole herd'}${args.session && args.session !== 'whole_day' ? ` (${String(args.session)})` : ''}${when(args)}`;
    case 'record_sowing': {
      const extra = [args.areaAcres !== undefined ? `${String(args.areaAcres)} acre${Number(args.areaAcres) === 1 ? '' : 's'}` : '', args.seedQuantity !== undefined ? `${String(args.seedQuantity)} ${text(args.seedUnit) ?? 'kg'} of seed` : '']
        .filter(Boolean)
        .join(', ');
      return `record sowing of ${text(args.crop) ?? 'a crop'}${text(args.variety) ? ` (${text(args.variety)})` : ''} in ${text(args.field) ?? 'a field'}${extra ? ` (${extra})` : ''}${typeof args.sownDate === 'string' ? ` on ${args.sownDate}` : ' today'}`;
    }
    case 'record_harvest':
      return `record a${args.final ? ' final' : ''} harvest of ${String(args.quantity)} ${text(args.unit) ?? 'kg'} of ${text(args.crop) ?? 'that crop'}${text(args.field) ? ` from ${text(args.field)}` : ''}${when(args)}`;
    case 'add_insurance': {
      // Every detail is read back: a premium saved as the cover, or a made-up policy number, must be audible.
      const details = [
        text(args.policyNumber) ? `policy number ${text(args.policyNumber)}` : '',
        text(args.startDate) ? `starting ${text(args.startDate)}` : '',
        args.premiumRupees !== undefined ? `premium ${rupees(args.premiumRupees)}` : '',
        args.sumInsuredRupees !== undefined ? `cover ${rupees(args.sumInsuredRupees)}` : '',
      ].filter(Boolean);
      return `save insurance for ${text(args.animalName) ?? 'that animal'} with ${text(args.insurer) ?? 'the insurer'} ending ${text(args.endDate) ?? '(no end date)'}${details.length ? `, ${details.join(', ')}` : ''}`;
    }
    case 'add_reminder':
      return `remind you to "${text(args.title) ?? ''}" on ${text(args.dueDate) ?? '(no date)'}`;
    case 'complete_reminder':
      return 'mark that reminder as done';
    default:
      return `run ${name}`;
  }
}

/**
 * One question for all held changes, e.g. "Shall I record 3 expenses for today: ₹3,500.00 on other,
 * ₹6,000.00 on feed and ₹400.00 on medicine? Say yes to save them, or no to cancel."
 */
export function confirmationPrompt(changes: readonly ProposedChange[]): string {
  const list = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
  if (changes.length === 1) return `Shall I ${describeAction(changes[0]!.name, changes[0]!.args)}? Say yes to save it, or no to cancel.`;

  const sameDayExpenses = changes.every((c) => c.name === 'record_expense' && c.args.date === changes[0]!.args.date);
  const allAnimals = changes.every((c) => c.name === 'register_animal');
  const body = sameDayExpenses
    ? `record ${changes.length} expenses${when(changes[0]!.args)}: ${list(changes.map((c) => `${rupees(c.args.amountRupees)} on ${typeof c.args.category === 'string' ? c.args.category : 'an unknown category'}`))}`
    : allAnimals
      ? describeAnimals(changes.flatMap((c) => animalsOf(c.args)))
      : list(changes.map((c) => describeAction(c.name, c.args)));
  return `Shall I ${body}? Say yes to save them, or no to cancel.`;
}

// English, Hindi/Hinglish and Tamil (romanised and native script).
const YES = new Set(['yes', 'yeah', 'yep', 'ya', 'ok', 'okay', 'sure', 'confirm', 'confirmed', 'correct', 'right', 'save', 'haan', 'han', 'ha', 'haa', 'ji', 'sari', 'seri', 'aama', 'aamaa', 'ama', 'हाँ', 'हां', 'हा', 'जी', 'ठीक', 'ஆமா', 'ஆம்', 'சரி']);
const YES_PHRASES = ['go ahead', 'do it', 'theek hai', 'thik hai', 'save it', 'yes please'];
const NO = new Set(['no', 'nope', 'not', 'nothing', 'never', 'wait', 'cancel', 'stop', 'wrong', 'dont', "don't", 'nahi', 'nahin', 'na', 'mat', 'illa', 'illai', 'venda', 'vendam', 'नहीं', 'ना', 'मत', 'இல்லை', 'வேண்டாம்', 'வேணாம்']);

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
