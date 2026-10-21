/**
 * Farm screen: the herd (with a profile per animal), milk per animal per day, eggs, crops, insurance, animal
 * health, feed stock and what is coming up. Every number, status and amount is worked out by the server (the
 * client adds nothing up). Records imported as demo data carry a notice that is shown with them.
 */
import { readTool } from './api.js';
import { badge, clear, h, icon, label, pageHeader, shortDate } from './dom.js';
import { animalCounts, askAssistant, card, emptyState, fillCard, plural, upcomingList } from './views.js';

interface AnimalView {
  animalId: string;
  name?: string;
  nameKn?: string;
  type: string;
  breed?: string;
  sex?: string;
  tagNumber?: string;
  birthDate?: string;
  age?: string;
  motherName?: string;
  insuredUntil?: string;
  lactationStatus?: string;
  healthStatus?: string;
  usualDailyDisplay?: string;
  purchaseValueDisplay?: string;
  milkFeeding?: string;
  sourceId?: string;
  notes?: string;
  demo?: boolean;
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
  stage?: string;
  harvestCount: number;
  harvestedGrams: number;
  harvestedDisplay: string;
  yieldPerAcreDisplay?: string;
  harvestToSeedRatio?: number;
  soldDisplay?: string;
  retainedDisplay?: string;
  revenueDisplay?: string;
  costDisplay?: string;
  netDisplay?: string;
  figuresToDate?: boolean;
  expectedHarvestWindow?: string;
  demo?: boolean;
}

interface MilkSummary {
  range: { from: string; to: string };
  totalDisplay: string;
  entryCount: number;
  daysWithRecords: number;
  averagePerRecordedDayDisplay?: string;
  groups: Array<{ key: string; display: string; entryCount: number }>;
  animalDays?: Array<{ animalName: string; totalDisplay: string; days: Array<{ date: string; display: string }> }>;
}

interface Policy {
  animalName?: string;
  insurer: string;
  policyNumber?: string;
  endDate: string;
  status: 'overdue' | 'due_soon' | 'active';
  daysLeft: number;
  daysOverdue?: number;
  premiumDisplay?: string;
}

interface Treatment {
  date: string;
  animalName?: string;
  symptoms: string;
  medicineAsRecorded?: string;
  doseAsRecorded?: string;
  veterinarian?: string;
  followUpDate?: string;
  status: string;
  withdrawalPeriodAsRecorded?: string;
}

interface Vaccination {
  animalName?: string;
  vaccine: string;
  dateGiven: string;
  nextDueDate: string;
  status: 'overdue' | 'due_soon' | 'upcoming';
  daysLeft: number;
}

const joinParts = (parts: Array<string | undefined | false>) => parts.filter(Boolean).join(' · ');
const due = (days: number) => (days < 0 ? `${plural(-days, 'day', 'days')} overdue` : days === 0 ? 'Due today' : `In ${plural(days, 'day', 'days')}`);
const tone = (status: string) => (status === 'overdue' ? 'danger' : status === 'due_soon' ? 'warn' : 'ok');
const notices = (list?: string[]) => (list?.length ? h('div', { class: 'demo-notes' }, ...list.map((n) => h('p', { class: 'muted small' }, n))) : null);
const isDemo = (items: Array<{ demo?: boolean }>) => items.some((i) => i.demo);

// ---------------------------------------------------------------- Animal profile (dialog)

interface Profile {
  animal: AnimalView;
  calves: Array<{ name?: string; type: string; age?: string }>;
  milkLast7Days: { totalDisplay: string; days: Array<{ date: string; display: string }> };
  insurance: Policy[];
  treatments: Treatment[];
  vaccinations: Vaccination[];
  notices: string[];
}

const dl = (rows: Array<[string, string | undefined]>) =>
  h('dl', { class: 'facts' }, ...rows.filter(([, v]) => v).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v!)]));

async function profileBody(animalId: string): Promise<Node> {
  const { data } = await readTool<Profile>('get_animal_profile', { animalId });
  const a = data.animal;
  return h(
    'div',
    { class: 'profile' },
    dl([
      ['Kind', joinParts([label(a.type), a.breed, a.sex])],
      ['Name in Kannada', a.nameKn],
      ['Born', a.birthDate && `${shortDate(a.birthDate)}${a.age ? ` (${a.age})` : ''}`],
      ['Mother', a.motherName],
      ['Calves', data.calves.map((c) => `${c.name ?? c.type}${c.age ? ` (${c.age})` : ''}`).join(', ') || undefined],
      ['Lactation', a.lactationStatus && label(a.lactationStatus)],
      ['Usual milk', a.usualDailyDisplay && `${a.usualDailyDisplay} a day`],
      ['Milk last 7 days', data.milkLast7Days.days.length ? `${data.milkLast7Days.totalDisplay} (${data.milkLast7Days.days.map((d) => `${shortDate(d.date)} ${d.display}`).join(', ')})` : undefined],
      ['Milk feeding', a.milkFeeding],
      ['Health', a.healthStatus && label(a.healthStatus)],
      ['Purchase value', a.purchaseValueDisplay],
      ['Insurance', data.insurance.map((p) => `${p.insurer} until ${shortDate(p.endDate)} (${label(p.status)}${p.premiumDisplay ? `, premium ${p.premiumDisplay}` : ''})`).join('; ') || 'None recorded'],
      ['Vaccinations', data.vaccinations.map((v) => `${v.vaccine}: given ${shortDate(v.dateGiven)}, next ${shortDate(v.nextDueDate)} (${label(v.status)})`).join('; ') || undefined],
      ['Treatments', data.treatments.map((t) => `${shortDate(t.date)} ${t.symptoms} (${label(t.status)})`).join('; ') || undefined],
      ['Record id', a.sourceId],
      ['Notes', a.notes],
    ]),
    notices(data.notices),
  );
}

function openProfile(animal: AnimalView): void {
  const body = h('div');
  const dialog = h(
    'dialog',
    { class: 'profile-dialog', 'aria-label': `${animal.name ?? 'Animal'} profile` },
    h('div', { class: 'card-head' }, h('span', { class: 'card-icon' }, icon('cow')), h('h3', {}, animal.name ?? `Tag ${animal.tagNumber}`), animal.demo ? badge('Demo data', 'neutral') : null, h('button', { class: 'link', type: 'button', onclick: () => dialog.close() }, 'Close')),
    body,
  );
  dialog.addEventListener('close', () => dialog.remove());
  document.body.appendChild(dialog);
  dialog.showModal();
  void fillCard(body, () => profileBody(animal.animalId));
}

// ---------------------------------------------------------------- Cards

async function herdCard(onDemo: (demo: boolean) => void): Promise<Node> {
  const { data } = await readTool<{ animals: AnimalView[]; total: number; byType: Array<{ type: string; count: number }> }>('list_animals');
  onDemo(isDemo(data.animals));
  if (data.total === 0) return emptyState('cow', 'No animals registered yet.', 'In chat, say "I have 3 cows: Lakshmi, Maya and Geeta".');
  const order = data.byType.map((t) => t.type);
  const animals = [...data.animals].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type) || (a.sourceId ?? a.name ?? '').localeCompare(b.sourceId ?? b.name ?? ''));
  return h(
    'div',
    {},
    h('p', { class: 'big' }, plural(data.total, 'animal', 'animals')),
    h('p', { class: 'muted small' }, animalCounts(data.byType), isDemo(data.animals) ? ' · demo data' : ''),
    h(
      'ul',
      { class: 'entries scroll-list' },
      ...animals.map((a) =>
        h(
          'li',
          {},
          h(
            'button',
            { class: 'entry entry-button', type: 'button', onclick: () => openProfile(a), 'aria-label': `Open profile of ${a.name ?? a.tagNumber}` },
            h('span', { class: 'avatar', 'aria-hidden': 'true' }, (a.name ?? a.type).charAt(0).toUpperCase()),
            h(
              'div',
              {},
              h('strong', {}, a.name ?? `Tag ${a.tagNumber}`),
              h('span', { class: 'muted' }, joinParts([a.nameKn, label(a.type), a.breed, a.age, a.motherName && `mother ${a.motherName}`, a.lactationStatus === 'dry' && 'dry'])),
            ),
            a.insuredUntil ? badge(`Insured till ${shortDate(a.insuredUntil)}`, a.insuredUntil < new Date().toISOString().slice(0, 10) ? 'danger' : 'ok') : null,
          ),
        ),
      ),
    ),
  );
}

async function milkCard(): Promise<Node> {
  const { data } = await readTool<MilkSummary>('get_milk_summary', { period: 'last_7_days', groupBy: 'animal_day' });
  if (data.entryCount === 0) return emptyState('milk', 'No milk recorded in the last 7 days.', 'In chat, say "Lakshmi gave 8 litres this morning".');
  const dates = [...new Set((data.animalDays ?? []).flatMap((r) => r.days.map((d) => d.date)))].sort();
  return h(
    'div',
    {},
    h('p', { class: 'big' }, data.totalDisplay),
    h('p', { class: 'muted small' }, `Average ${data.averagePerRecordedDayDisplay} per day over ${plural(data.daysWithRecords, 'day', 'days')} with records`),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'grid-table' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Animal'), ...dates.map((d) => h('th', { scope: 'col' }, shortDate(d))), h('th', { scope: 'col' }, 'Total'))),
        h(
          'tbody',
          {},
          ...(data.animalDays ?? []).map((r) =>
            h('tr', {}, h('th', { scope: 'row' }, r.animalName), ...dates.map((d) => h('td', {}, r.days.find((x) => x.date === d)?.display.replace(' L', '') ?? '–')), h('td', {}, h('strong', {}, r.totalDisplay))),
          ),
        ),
      ),
    ),
    h('p', { class: 'muted small' }, 'Litres per day, morning and evening added up.'),
  );
}

async function eggsCard(): Promise<Node> {
  const { data } = await readTool<{
    range: { from: string; to: string; label: string };
    totalEggs: number;
    damagedEggs: number;
    days: Array<{ date: string; eggs: number; byChicken: Array<{ name: string; eggs: number }> }>;
    byChicken: Array<{ name: string; eggs: number }>;
    notices: string[];
  }>('get_egg_summary');
  if (data.days.length === 0) return emptyState('calendar', 'No eggs recorded yet.', 'In chat, say how many eggs the hens laid today.');
  const hens = data.byChicken.map((c) => c.name).sort();
  return h(
    'div',
    {},
    h('p', { class: 'big' }, plural(data.totalEggs, 'egg', 'eggs')),
    h('p', { class: 'muted small' }, `${shortDate(data.range.from)} – ${shortDate(data.range.to)}${data.range.label === 'latest_7_days_with_records' ? ' (latest records)' : ''}${data.damagedEggs ? ` · ${data.damagedEggs} damaged` : ''}`),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'grid-table' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Day'), ...hens.map((n) => h('th', { scope: 'col' }, n)), h('th', { scope: 'col' }, 'Total'))),
        h('tbody', {}, ...data.days.map((d) => h('tr', {}, h('th', { scope: 'row' }, shortDate(d.date)), ...hens.map((n) => h('td', {}, String(d.byChicken.find((c) => c.name === n)?.eggs ?? 0))), h('td', {}, h('strong', {}, String(d.eggs)))))),
      ),
    ),
    notices(data.notices),
  );
}

async function cropsCard(): Promise<Node> {
  const { data } = await readTool<{ crops: CropView[] }>('list_crops');
  if (data.crops.length === 0) return emptyState('sprout', 'No crops recorded yet.', 'In chat, say "I planted paddy in the north field, 2 acres, 50 kg seed".');
  return h(
    'ul',
    { class: 'entries' },
    ...data.crops.map((c) => {
      const stage = c.stage ?? c.status;
      return h(
        'li',
        { class: 'entry crop' },
        h(
          'div',
          {},
          h('strong', {}, `${label(c.crop)}${c.variety ? ` (${c.variety})` : ''} · ${c.field}`),
          h('span', { class: 'muted' }, joinParts([`Sown ${shortDate(c.sownDate)}`, c.areaDisplay, c.seedDisplay && `seed ${c.seedDisplay}`, c.costDisplay && `cost ${c.costDisplay}`])),
          c.harvestedGrams
            ? h('span', { class: 'harvest' }, joinParts([`Harvest ${c.harvestedDisplay}${c.figuresToDate ? ' so far' : ''}`, c.soldDisplay && `sold ${c.soldDisplay}`, c.retainedDisplay && `kept ${c.retainedDisplay}`]))
            : c.expectedHarvestWindow
              ? h('span', { class: 'muted' }, `Expected harvest ${c.expectedHarvestWindow}`)
              : null,
          c.revenueDisplay ? h('span', { class: 'harvest' }, joinParts([`Sales ${c.revenueDisplay}`, c.netDisplay && `net ${c.netDisplay} before overheads`])) : null,
        ),
        stage === 'harvested' ? badge('Harvested', 'neutral') : stage === 'ongoing_harvest' ? badge(`Harvesting · day ${c.daysSinceSowing}`, 'warn') : badge(`Growing · day ${c.daysSinceSowing}`, 'ok'),
      );
    }),
  );
}

async function insuranceCard(): Promise<Node> {
  const { data } = await readTool<{ policies: Policy[]; counts: { overdue: number; due_soon: number; active: number }; premiumTotalDisplay: string; notices: string[] }>('list_insurance', { status: 'needs_renewal' });
  const summary = h('p', { class: 'muted small' }, `${data.counts.overdue} overdue · ${data.counts.due_soon} due within 30 days · ${data.counts.active} active`);
  if (data.policies.length === 0) return h('div', {}, summary, emptyState('shield', 'No insurance is overdue or due soon.'));
  return h(
    'div',
    {},
    summary,
    h(
      'ul',
      { class: 'rows' },
      ...data.policies.map((p) =>
        h(
          'li',
          { class: p.status === 'overdue' ? 'row overdue' : 'row' },
          h('span', { class: `row-icon${p.status === 'overdue' ? '' : ' ok'}` }, icon('shield')),
          h('span', { class: 'row-main' }, h('strong', {}, `${p.animalName ?? 'Animal'} · ${p.insurer}`), h('span', { class: 'muted small' }, joinParts([`Ends ${shortDate(p.endDate)}`, p.premiumDisplay && `premium ${p.premiumDisplay}`, p.policyNumber]))),
          badge(due(p.daysLeft), tone(p.status)),
        ),
      ),
    ),
    h('p', { class: 'muted small' }, `Premiums due: ${data.premiumTotalDisplay}`),
    notices(data.notices),
  );
}

async function healthCard(): Promise<Node> {
  const { data } = await readTool<{
    treatments: Treatment[];
    followUps: Array<{ animalName?: string; followUpDate: string; daysLeft: number; overdue: boolean; reason: string }>;
    vaccinationsDue: Vaccination[];
    notices: string[];
  }>('get_health_records');
  if (data.treatments.length === 0 && data.vaccinationsDue.length === 0) return emptyState('pill', 'No treatments or vaccinations recorded.');
  const due30 = [
    ...data.followUps.map((f) => ({ date: f.followUpDate, title: `${f.animalName ?? 'Animal'}: vet follow-up`, sub: f.reason, days: f.daysLeft, status: f.overdue ? 'overdue' : f.daysLeft <= 3 ? 'due_soon' : 'ok' })),
    ...data.vaccinationsDue.map((v) => ({ date: v.nextDueDate, title: `${v.animalName ?? 'Animal'}: ${v.vaccine}`, sub: `Last given ${shortDate(v.dateGiven)}`, days: v.daysLeft, status: v.status })),
  ].sort((a, b) => a.date.localeCompare(b.date));
  return h(
    'div',
    {},
    h('p', { class: 'small strong' }, 'Follow-ups and vaccinations due'),
    due30.length
      ? h(
          'ul',
          { class: 'rows' },
          ...due30.map((d) =>
            h('li', { class: d.status === 'overdue' ? 'row overdue' : 'row' }, h('span', { class: `row-icon${d.status === 'overdue' ? '' : ' ok'}` }, icon('calendar')), h('span', { class: 'row-main' }, h('strong', {}, d.title), h('span', { class: 'muted small' }, `${shortDate(d.date)} · ${d.sub}`)), badge(due(d.days), tone(d.status))),
          ),
        )
      : h('p', { class: 'muted small' }, 'Nothing due in the next 30 days.'),
    h('p', { class: 'small strong' }, 'Treatment history'),
    h(
      'ul',
      { class: 'entries' },
      ...data.treatments.map((t) =>
        h(
          'li',
          { class: 'entry' },
          h(
            'div',
            {},
            h('strong', {}, `${t.animalName ?? 'Animal'} · ${shortDate(t.date)}`),
            h('span', { class: 'muted' }, joinParts([t.symptoms, t.veterinarian, t.followUpDate && `follow-up ${shortDate(t.followUpDate)}`])),
            t.medicineAsRecorded ? h('span', { class: 'muted small' }, `As recorded: ${joinParts([t.medicineAsRecorded, t.doseAsRecorded, t.withdrawalPeriodAsRecorded])}`) : null,
          ),
          badge(label(t.status), t.status === 'completed' ? 'neutral' : 'warn'),
        ),
      ),
    ),
    notices(data.notices),
  );
}

async function feedCard(): Promise<Node> {
  const { data } = await readTool<{ items: Array<{ item: string; quantityDisplay: string; reorderLevelDisplay: string; needsReorder: boolean; lastUpdated: string }>; reorderCount: number; notices: string[] }>('get_feed_stock');
  if (data.items.length === 0) return emptyState('leaf', 'No feed stock recorded.');
  return h(
    'div',
    {},
    h('p', { class: 'muted small' }, data.reorderCount ? `${plural(data.reorderCount, 'item needs', 'items need')} reordering` : 'Stock is above every reorder level'),
    h(
      'ul',
      { class: 'rows' },
      ...data.items.map((i) =>
        h(
          'li',
          { class: i.needsReorder ? 'row overdue' : 'row' },
          h('span', { class: `row-icon${i.needsReorder ? '' : ' ok'}` }, icon('leaf')),
          h('span', { class: 'row-main' }, h('strong', {}, i.item), h('span', { class: 'muted small' }, `${i.quantityDisplay} left · reorder at ${i.reorderLevelDisplay} · updated ${shortDate(i.lastUpdated)}`)),
          i.needsReorder ? badge('Reorder', 'danger') : badge('OK', 'ok'),
        ),
      ),
    ),
    notices(data.notices),
  );
}

export function farmView(): HTMLElement {
  const bodies = { upcoming: h('div'), herd: h('div'), milk: h('div'), crops: h('div'), insurance: h('div'), health: h('div'), feed: h('div'), eggs: h('div') };
  // Shown while the farm holds imported demo records, so nobody takes them for a real farm's data.
  const banner = h('p', { class: 'notice notice-info', role: 'note' }, 'Demo data: these are synthetic records for a demo farm (Krishna Farm), not real farm records. Health records are not veterinary advice.');
  banner.hidden = true;
  const load = () => {
    for (const b of Object.values(bodies)) clear(b);
    void fillCard(bodies.herd, () => herdCard((demo) => (banner.hidden = !demo)));
    void fillCard(bodies.insurance, insuranceCard);
    void fillCard(bodies.health, healthCard);
    void fillCard(bodies.feed, feedCard);
    void fillCard(bodies.milk, milkCard);
    void fillCard(bodies.crops, cropsCard);
    void fillCard(bodies.eggs, eggsCard);
    void fillCard(bodies.upcoming, () => upcomingList(30));
  };
  load();
  return h(
    'section',
    { class: 'view' },
    pageHeader('Farm', 'Your animals, milk, eggs, crops, insurance, health and feed.', h('button', { class: 'btn-outline', type: 'button', onclick: load }, icon('refresh'), 'Refresh')),
    banner,
    h(
      'div',
      { class: 'dash-grid' },
      h(
        'div',
        { class: 'dash-col' },
        card('Herd', bodies.herd, { icon: 'cow', action: h('button', { class: 'link', type: 'button', onclick: () => askAssistant('I have a cow named ') }, 'Add in chat') }),
        card('Milk by animal, last 7 days', bodies.milk, { icon: 'milk', action: h('button', { class: 'link', type: 'button', onclick: () => askAssistant('') }, 'Record in chat') }),
        card('Crops', bodies.crops, { icon: 'sprout', action: h('button', { class: 'link', type: 'button', onclick: () => askAssistant('I planted ') }, 'Add in chat') }),
        card('Eggs by chicken', bodies.eggs, { icon: 'calendar' }),
      ),
      h(
        'div',
        { class: 'dash-col' },
        card('Insurance to renew', bodies.insurance, { icon: 'shield' }),
        card('Animal health', bodies.health, { icon: 'pill' }),
        card('Feed stock', bodies.feed, { icon: 'leaf' }),
        card('Coming up (30 days)', bodies.upcoming, { icon: 'bell' }),
      ),
    ),
  );
}

