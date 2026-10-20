/**
 * Farm screen: the herd, milk, crops and what is coming up. Every number and amount is a display string
 * worked out by the server (the client adds nothing up).
 */
import { readTool } from './api.js';
import { badge, h, icon, label, pageHeader, shortDate } from './dom.js';
import { animalCounts, askAssistant, breakdown, card, emptyState, fillCard, plural, upcomingList } from './views.js';

interface AnimalView {
  animalId: string;
  name?: string;
  type: string;
  breed?: string;
  tagNumber?: string;
  age?: string;
  motherName?: string;
  insuredUntil?: string;
}

interface CropView {
  cropId: string;
  crop: string;
  variety?: string;
  field: string;
  areaDisplay?: string;
  sownDate: string;
  daysSinceSowing: number;
  seedDisplay?: string;
  status: string;
  harvestCount: number;
  harvestedDisplay: string;
  yieldPerAcreDisplay?: string;
  harvestToSeedRatio?: number;
}

interface MilkSummary {
  totalDisplay: string;
  entryCount: number;
  daysWithRecords: number;
  averagePerRecordedDayDisplay?: string;
  groups: Array<{ key: string; display: string; entryCount: number }>;
}

const joinParts = (parts: Array<string | undefined | false>) => parts.filter(Boolean).join(' · ');

async function herdCard(): Promise<Node> {
  const { data } = await readTool<{ animals: AnimalView[]; total: number; byType: Array<{ type: string; count: number }> }>('list_animals');
  if (data.total === 0) return emptyState('cow', 'No animals registered yet.', 'In chat, say "I have 3 cows: Lakshmi, Maya and Geeta".');
  return h(
    'div',
    {},
    h('p', { class: 'big' }, plural(data.total, 'animal', 'animals')),
    h('p', { class: 'muted small' }, animalCounts(data.byType)),
    h(
      'ul',
      { class: 'entries' },
      ...data.animals.map((a) =>
        h(
          'li',
          { class: 'entry' },
          h('span', { class: 'avatar', 'aria-hidden': 'true' }, (a.name ?? a.type).charAt(0).toUpperCase()),
          h(
            'div',
            {},
            h('strong', {}, `${a.name ?? `Tag ${a.tagNumber}`}${a.breed ? ` · ${a.breed}` : ''}`),
            h('span', { class: 'muted' }, joinParts([label(a.type), a.age, a.motherName && `mother ${a.motherName}`])),
          ),
          a.insuredUntil ? badge(`Insured till ${shortDate(a.insuredUntil)}`, 'ok') : null,
        ),
      ),
    ),
  );
}

async function milkCard(): Promise<Node> {
  const { data } = await readTool<MilkSummary>('get_milk_summary', { period: 'last_7_days', groupBy: 'animal' });
  if (data.entryCount === 0) return emptyState('milk', 'No milk recorded in the last 7 days.', 'In chat, say "Lakshmi gave 8 litres this morning".');
  return h(
    'div',
    {},
    h('p', { class: 'big' }, data.totalDisplay),
    h('p', { class: 'muted small' }, `Average ${data.averagePerRecordedDayDisplay} per day over ${plural(data.daysWithRecords, 'day', 'days')} with records`),
    breakdown(data.groups.map((g) => ({ name: g.key, value: g.display, count: g.entryCount }))),
  );
}

async function cropsCard(): Promise<Node> {
  const { data } = await readTool<{ crops: CropView[] }>('list_crops');
  if (data.crops.length === 0) return emptyState('sprout', 'No crops recorded yet.', 'In chat, say "I planted paddy in the north field, 2 acres, 50 kg seed".');
  return h(
    'ul',
    { class: 'entries' },
    ...data.crops.map((c) =>
      h(
        'li',
        { class: 'entry crop' },
        h(
          'div',
          {},
          h('strong', {}, `${label(c.crop)}${c.variety ? ` (${c.variety})` : ''} · ${c.field}`),
          h('span', { class: 'muted' }, joinParts([`Sown ${shortDate(c.sownDate)}`, c.areaDisplay, c.seedDisplay && `seed ${c.seedDisplay}`])),
          c.harvestCount
            ? h('span', { class: 'harvest' }, joinParts([`Harvest ${c.harvestedDisplay}`, c.yieldPerAcreDisplay, c.harvestToSeedRatio ? `${c.harvestToSeedRatio}× the seed` : undefined]))
            : null,
        ),
        c.status === 'growing' ? badge(`Growing · day ${c.daysSinceSowing}`, 'ok') : badge('Harvested', 'neutral'),
      ),
    ),
  );
}

export function farmView(): HTMLElement {
  const upcoming = h('div');
  const herd = h('div');
  const milk = h('div');
  const crops = h('div');
  const load = () => {
    void fillCard(upcoming, () => upcomingList(30));
    void fillCard(herd, herdCard);
    void fillCard(milk, milkCard);
    void fillCard(crops, cropsCard);
  };
  load();
  return h(
    'section',
    { class: 'view' },
    pageHeader('Farm', 'Your animals, milk, crops and what is coming up.', h('button', { class: 'btn-outline', type: 'button', onclick: load }, icon('refresh'), 'Refresh')),
    h(
      'div',
      { class: 'dash-grid' },
      h(
        'div',
        { class: 'dash-col' },
        card('Herd', herd, { icon: 'cow', action: h('button', { class: 'link', type: 'button', onclick: () => askAssistant('I have a cow named ') }, 'Add in chat') }),
        card('Crops', crops, { icon: 'sprout', action: h('button', { class: 'link', type: 'button', onclick: () => askAssistant('I planted ') }, 'Add in chat') }),
      ),
      h(
        'div',
        { class: 'dash-col' },
        card('Coming up (30 days)', upcoming, { icon: 'bell' }),
        card('Milk, last 7 days', milk, { icon: 'milk', action: h('button', { class: 'link', type: 'button', onclick: () => askAssistant('') }, 'Record in chat') }),
      ),
    ),
  );
}
