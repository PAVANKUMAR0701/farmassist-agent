import { describe, expect, it } from 'vitest';
import { callTool, makeTestConfig } from '../helpers/mcp-http.js';

// Fixed clock: 2026-10-14 12:00 IST.
const ok = async (p: Promise<{ isError?: boolean; content: Array<{ text: string }>; structuredContent?: any }>) => {
  const r = await p;
  if (r.isError) throw new Error(`tool failed: ${r.content[0]!.text}`);
  return r;
};

describe('herd register', () => {
  it('registers animals one by one and counts the herd in code', async () => {
    const { config } = makeTestConfig();
    await ok(callTool(config, 'register_animal', { animals: [{ name: 'Lakshmi', type: 'cow', breed: 'HF', birthDate: '2022-07-10' }] }));
    await ok(callTool(config, 'register_animal', { animals: [{ name: 'Maya', type: 'cow' }] }));
    const calf = await ok(callTool(config, 'register_animal', { animals: [{ name: 'Seetha', type: 'calf', motherName: 'Lakshmi', birthDate: '2026-10-01' }] }));
    expect(calf.content[0]!.text.split('\n')[0]).toBe('Registered Seetha (calf). The herd now has 3 animals: 2 cows, 1 calf.');

    const list = await ok(callTool(config, 'list_animals', {}));
    expect(list.structuredContent).toMatchObject({ total: 3, byType: [{ type: 'cow', count: 2 }, { type: 'calf', count: 1 }], calculatedBy: 'server' });
    expect(list.structuredContent.animals.find((a: any) => a.name === 'Lakshmi')).toMatchObject({ breed: 'HF', age: '4 years 3 months' });
    expect(list.structuredContent.animals.find((a: any) => a.name === 'Seetha')).toMatchObject({ age: '13 days', motherName: 'Lakshmi' });
    expect(list.content[0]!.text.split('\n')[0]).toBe('3 active animals: 2 cows (Lakshmi, Maya); 1 calf (Seetha).');
  });

  it('refuses a second active animal with the same name, but a retry of the same request is not a clash', async () => {
    const { config } = makeTestConfig();
    const args = { animals: [{ name: 'Lakshmi', type: 'cow' }], clientRequestId: 'req-lakshmi-001' };
    await ok(callTool(config, 'register_animal', args));
    const retry = await ok(callTool(config, 'register_animal', args));
    expect(retry.structuredContent.duplicate).toBe(true);
    const clash = await callTool(config, 'register_animal', { animals: [{ name: 'lakshmi', type: 'cow' }] });
    expect(clash.isError).toBe(true);
    expect(clash.content[0]!.text).toContain('already called Lakshmi');
    expect((await ok(callTool(config, 'list_animals', {}))).structuredContent.total).toBe(1);
  });

  it('needs a name or tag, and refuses future birth dates', async () => {
    const { config } = makeTestConfig();
    expect((await callTool(config, 'register_animal', { animals: [{ type: 'cow' }] })).isError).toBe(true);
    expect((await callTool(config, 'register_animal', { animals: [{ name: 'X', type: 'cow', birthDate: '2026-12-01' }] })).isError).toBe(true);
  });

  it('renames, re-types and marks an animal sold; sold animals leave the active herd', async () => {
    const { config } = makeTestConfig();
    await ok(callTool(config, 'register_animal', { animals: [{ name: 'Gita', type: 'heifer' }] }));
    const renamed = await ok(callTool(config, 'update_animal', { animalName: 'gita', newName: 'Geeta', type: 'cow' }));
    expect(renamed.content[0]!.text.split('\n')[0]).toBe('Updated Geeta (cow): name Gita → Geeta, type heifer → cow.');
    const sold = await ok(callTool(config, 'update_animal', { animalName: 'Geeta', status: 'sold' }));
    expect(sold.structuredContent.animal).toMatchObject({ status: 'sold', statusDate: '2026-10-14' });
    expect((await ok(callTool(config, 'list_animals', {}))).structuredContent.total).toBe(0);
    expect((await ok(callTool(config, 'list_animals', { status: 'sold' }))).structuredContent.total).toBe(1);
    expect((await ok(callTool(config, 'update_animal', { animalName: 'Geeta', status: 'sold' }))).structuredContent.status).toBe('no_change');
  });

  it('an unknown name lists the animals that exist, so the model can ask', async () => {
    const { config } = makeTestConfig();
    await ok(callTool(config, 'register_animal', { animals: [{ name: 'Lakshmi', type: 'cow' }] }));
    const r = await callTool(config, 'update_animal', { animalName: 'Laxmi', breed: 'Gir' });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('(registered: Lakshmi)');
  });
});

describe('milk', () => {
  it('records milk per animal and session, and totals it exactly in code', async () => {
    const { config } = makeTestConfig();
    await ok(callTool(config, 'register_animal', { animals: [{ name: 'Lakshmi', type: 'cow' }] }));
    await ok(callTool(config, 'register_animal', { animals: [{ name: 'Maya', type: 'cow' }] }));
    const first = await ok(callTool(config, 'record_milk', { litres: 8.5, session: 'morning', animalName: 'Lakshmi' }));
    expect(first.content[0]!.text.split('\n')[0]).toBe('Recorded 8.5 L of milk from Lakshmi (morning) on 2026-10-14. Milk recorded on 2026-10-14 so far: 8.5 L.');
    await ok(callTool(config, 'record_milk', { litres: 7.25, session: 'evening', animalName: 'Lakshmi' }));
    await ok(callTool(config, 'record_milk', { litres: 6, session: 'morning', animalName: 'Maya', date: '2026-10-13' }));
    await ok(callTool(config, 'record_milk', { litres: 0.1, animalName: 'Maya', date: '2026-10-13' }));

    const byAnimal = await ok(callTool(config, 'get_milk_summary', { groupBy: 'animal' }));
    // Hand-calculated: 8.5 + 7.25 + 6 + 0.1 = 21.85 L over 2 days -> 10.925 L/day -> 10.93 L (rounded to the ml: 10925 ml).
    expect(byAnimal.structuredContent).toMatchObject({
      totalMillilitres: 21850,
      totalDisplay: '21.85 L',
      daysWithRecords: 2,
      averagePerRecordedDayDisplay: '10.93 L',
      groups: [{ key: 'Lakshmi', millilitres: 15750 }, { key: 'Maya', millilitres: 6100 }],
      calculatedBy: 'server',
    });
    const lakshmi = await ok(callTool(config, 'get_milk_summary', { animalName: 'Lakshmi', period: 'today' }));
    expect(lakshmi.content[0]!.text.split('\n')[0]).toBe(
      'Milk from Lakshmi from 2026-10-14 to 2026-10-14: 15.75 L over 1 day with records (average 15.75 L per day). Records: 2026-10-14 morning Lakshmi 8.5 L; 2026-10-14 evening Lakshmi 7.25 L.',
    );
  });

  it("answers 'each cow's milk today' with every cow and every record, and never invents any (seen live 2026-10-21)", async () => {
    const { config } = makeTestConfig();
    await ok(callTool(config, 'register_animal', { animals: [{ name: 'Geeta', type: 'cow' }, { name: 'Maya', type: 'cow' }, { name: 'Lakshmi', type: 'cow' }, { name: 'Sita', type: 'cow' }] }));
    await ok(callTool(config, 'record_milk', { litres: 7, session: 'morning', animalName: 'Geeta' }));
    await ok(callTool(config, 'record_milk', { litres: 6, session: 'morning', animalName: 'Maya' }));
    await ok(callTool(config, 'record_milk', { litres: 5, session: 'evening', animalName: 'Lakshmi' }));
    await ok(callTool(config, 'record_milk', { litres: 2, session: 'evening' })); // not for one animal
    await ok(callTool(config, 'record_milk', { litres: 9, session: 'morning', animalName: 'Sita', date: '2026-10-13' })); // yesterday

    const perCow = await ok(callTool(config, 'get_milk_summary', { period: 'today', groupBy: 'animal' }));
    expect(perCow.content[0]!.text.split('\n')[0]).toBe(
      'Milk from 2026-10-14 to 2026-10-14: 20 L over 1 day with records (average 20 L per day). By animal: Geeta 7 L, Maya 6 L, Lakshmi 5 L, whole herd 2 L. ' +
        'Records: 2026-10-14 morning Geeta 7 L; 2026-10-14 morning Maya 6 L; 2026-10-14 evening Lakshmi 5 L; 2026-10-14 evening whole herd 2 L.',
    );
    expect(perCow.structuredContent).toMatchObject({
      records: [
        { date: '2026-10-14', session: 'morning', animalName: 'Geeta', litresDisplay: '7 L' },
        { date: '2026-10-14', session: 'morning', animalName: 'Maya', litresDisplay: '6 L' },
        { date: '2026-10-14', session: 'evening', animalName: 'Lakshmi', litresDisplay: '5 L' },
        { date: '2026-10-14', session: 'evening', animalName: 'whole herd', litresDisplay: '2 L' },
      ],
    });
    // Sita gave nothing today: she is not listed, and yesterday's milk is not counted as today's.
    expect(perCow.content[0]!.text).not.toContain('Sita');

    // The plain total question still answers with the total, and now also lists today's records.
    const total = await ok(callTool(config, 'get_milk_summary', { period: 'today' }));
    expect(total.structuredContent).toMatchObject({ totalDisplay: '20 L', entryCount: 4 });
    expect(total.content[0]!.text.split('\n')[0]).toContain('Records: 2026-10-14 morning Geeta 7 L;');

    const none = await ok(callTool(config, 'get_milk_summary', { period: 'today', animalName: 'Sita' }));
    expect(none.content[0]!.text.split('\n')[0]).toBe('No milk recorded from Sita from 2026-10-14 to 2026-10-14.');
    expect(none.structuredContent).not.toHaveProperty('records');
  });

  it("works out the rupee value of the milk at the farmer's rate, exactly, in the server (seen live 2026-10-21)", async () => {
    const { config } = makeTestConfig();
    await ok(callTool(config, 'register_animal', { animals: [{ name: 'Geeta', type: 'cow' }, { name: 'Maya', type: 'cow' }, { name: 'Lakshmi', type: 'cow' }] }));
    await ok(callTool(config, 'record_milk', { litres: 7, session: 'whole_day', animalName: 'Geeta' }));
    await ok(callTool(config, 'record_milk', { litres: 6, session: 'whole_day', animalName: 'Maya' }));
    await ok(callTool(config, 'record_milk', { litres: 5, session: 'whole_day', animalName: 'Lakshmi' }));

    // Hand-calculated: 18 L x ₹36.50 = ₹657.00; Geeta 7 x 36.5 = 255.50, Maya 219.00, Lakshmi 182.50.
    const value = await ok(callTool(config, 'get_milk_value', { ratePerLitreRupees: 36.5 }));
    expect(value.content[0]!.text.split('\n')[0]).toBe(
      'Milk from 2026-10-14 to 2026-10-14: 18 L at ₹36.50 per litre = ₹657.00. By animal: Geeta 7 L = ₹255.50, Maya 6 L = ₹219.00, Lakshmi 5 L = ₹182.50.',
    );
    expect(value.structuredContent).toMatchObject({ valuePaise: 65700, valueDisplay: '₹657.00', calculatedBy: 'server' });

    // Litres with millilitres and a rate with paise: 7.25 L x ₹33.33 = ₹241.6425 -> ₹241.64 (rounded once).
    await ok(callTool(config, 'record_milk', { litres: 7.25, session: 'morning', animalName: 'Geeta', date: '2026-10-13' }));
    const yesterday = await ok(callTool(config, 'get_milk_value', { period: 'yesterday', ratePerLitreRupees: 33.33 }));
    expect(yesterday.structuredContent).toMatchObject({ valuePaise: 24164, valueDisplay: '₹241.64' });

    const none = await ok(callTool(config, 'get_milk_value', { from: '2026-10-01', to: '2026-10-02', ratePerLitreRupees: 36.5 }));
    expect(none.content[0]!.text.split('\n')[0]).toBe('No milk recorded from 2026-10-01 to 2026-10-02, so there is nothing to value.');
    expect((await callTool(config, 'get_milk_value', { ratePerLitreRupees: 0 })).isError).toBe(true);
    expect((await callTool(config, 'get_milk_value', { ratePerLitreRupees: 36.555 })).isError).toBe(true);
  });

  it('refuses milk for an animal that is not registered, and impossible amounts', async () => {
    const { config } = makeTestConfig();
    expect((await callTool(config, 'record_milk', { litres: 5, animalName: 'Ghost' })).content[0]!.text).toContain('no animals are registered yet');
    expect((await callTool(config, 'record_milk', { litres: 0 })).isError).toBe(true);
    expect((await callTool(config, 'record_milk', { litres: 2.555 })).isError).toBe(true);
  });
});

describe('crops', () => {
  it('follows a paddy cycle from sowing to final harvest with yield per acre and harvest-to-seed ratio', async () => {
    const { config } = makeTestConfig();
    const sown = await ok(callTool(config, 'record_sowing', { crop: 'Paddy', variety: 'Sona Masuri', field: 'north field', areaAcres: 2, seedQuantity: 50, sownDate: '2026-06-20' }));
    expect(sown.content[0]!.text.split('\n')[0]).toBe('Recorded sowing of paddy (Sona Masuri) in north field on 2026-06-20 (2 acres, 50 kg of seed).');
    await ok(callTool(config, 'record_harvest', { crop: 'paddy', quantity: 30, unit: 'quintal', date: '2026-10-10' }));
    const last = await ok(callTool(config, 'record_harvest', { crop: 'paddy', quantity: 500, unit: 'kg', final: true }));
    // Hand-calculated: 3000 kg + 500 kg = 3500 kg = 35 quintal; per acre 1750 kg = 17.5 quintal; 3500 / 50 = 70x the seed.
    expect(last.content[0]!.text.split('\n')[0]).toBe(
      'Recorded harvest of 5 quintal (500 kg) of paddy (Sona Masuri) in north field on 2026-10-14. Total harvested from this crop: 35 quintal (3,500 kg), 17.5 quintal (1,750 kg) per acre; crop cycle closed.',
    );
    const list = await ok(callTool(config, 'list_crops', {}));
    expect(list.structuredContent.crops[0]).toMatchObject({ status: 'harvested', harvestedDate: '2026-10-14', daysSinceSowing: 116, harvestCount: 2, harvestToSeedRatio: 70 });
  });

  it('never guesses which crop a harvest belongs to', async () => {
    const { config } = makeTestConfig();
    expect((await callTool(config, 'record_harvest', { crop: 'ragi', quantity: 10 })).content[0]!.text).toContain('Record the sowing first');
    await ok(callTool(config, 'record_sowing', { crop: 'ragi', field: 'east plot', sownDate: '2026-07-01' }));
    await ok(callTool(config, 'record_sowing', { crop: 'ragi', field: 'river plot', sownDate: '2026-07-05' }));
    const ambiguous = await callTool(config, 'record_harvest', { crop: 'ragi', quantity: 10 });
    expect(ambiguous.content[0]!.text).toContain('2 ragi crops are growing');
    expect((await callTool(config, 'record_harvest', { crop: 'ragi', field: 'east plot', quantity: 4, unit: 'quintal' })).isError).toBeFalsy();
    expect((await callTool(config, 'record_harvest', { crop: 'ragi', field: 'river plot', quantity: 1, date: '2026-07-01' })).content[0]!.text).toContain('before this crop was sown');
  });
});

describe('insurance and reminders', () => {
  it('shows insurance ending soon and open reminders, soonest first; done reminders disappear', async () => {
    const { config } = makeTestConfig();
    await ok(callTool(config, 'register_animal', { animals: [{ name: 'Lakshmi', type: 'cow' }] }));
    const policy = await ok(callTool(config, 'add_insurance', { animalName: 'Lakshmi', insurer: 'United India', policyNumber: 'UI-77', endDate: '2026-11-03', premiumRupees: 1850 }));
    expect(policy.content[0]!.text.split('\n')[0]).toBe(
      'Saved insurance for Lakshmi (cow) with United India (policy UI-77), premium ₹1,850.00, ending 2026-11-03 (in 20 days). It will show in reminders from 30 days before.',
    );
    const reminder = await ok(callTool(config, 'add_reminder', { title: 'Deworm Lakshmi', dueDate: '2026-10-20', animalName: 'Lakshmi' }));
    await ok(callTool(config, 'add_reminder', { title: 'Pay tractor loan', dueDate: '2027-01-05' })); // beyond 30 days

    const upcoming = await ok(callTool(config, 'list_reminders', {}));
    expect(upcoming.structuredContent.items.map((i: any) => [i.source, i.dueDate, i.daysLeft])).toEqual([
      ['reminder', '2026-10-20', 6],
      ['insurance', '2026-11-03', 20],
    ]);
    expect(upcoming.content[0]!.text.split('\n')[0]).toBe(
      '2 things coming up: Deworm Lakshmi (2026-10-20), in 6 days; Insurance for Lakshmi with United India ends (policy UI-77) on 2026-11-03, in 20 days.',
    );

    await ok(callTool(config, 'complete_reminder', { reminderId: reminder.structuredContent.reminderId }));
    expect((await ok(callTool(config, 'list_reminders', {}))).structuredContent.items).toHaveLength(1);
    expect((await ok(callTool(config, 'list_animals', {}))).structuredContent.animals[0].insuredUntil).toBe('2026-11-03');
  });

  it('refuses reminders in the past and insurance that ends before it starts', async () => {
    const { config } = makeTestConfig();
    await ok(callTool(config, 'register_animal', { animals: [{ name: 'Lakshmi', type: 'cow' }] }));
    expect((await callTool(config, 'add_reminder', { title: 'x', dueDate: '2026-10-01' })).content[0]!.text).toContain('in the past');
    expect((await callTool(config, 'add_insurance', { animalName: 'Lakshmi', insurer: 'X', startDate: '2026-12-01', endDate: '2026-11-01' })).isError).toBe(true);
  });
});

describe('registering several animals at once', () => {
  it('registers a list in one call, and a retry of the same list creates nothing new', async () => {
    const { config } = makeTestConfig();
    const args = { animals: [{ name: 'Maya', type: 'cow' }, { name: 'Geeta', type: 'cow' }, { name: 'Saraswati', type: 'cow', breed: 'Gir' }], clientRequestId: 'req-three-cows-1' };
    const r = await ok(callTool(config, 'register_animal', args));
    expect(r.content[0]!.text.split('\n')[0]).toBe('Registered Maya (cow), Geeta (cow) and Saraswati (cow, Gir). The herd now has 3 animals: 3 cows.');
    expect((await ok(callTool(config, 'register_animal', args))).structuredContent.duplicate).toBe(true);
    expect((await ok(callTool(config, 'list_animals', {}))).structuredContent.total).toBe(3);
  });

  it('refuses the whole list, saving nothing, when a name repeats or is already taken', async () => {
    const { config } = makeTestConfig();
    await ok(callTool(config, 'register_animal', { animals: [{ name: 'Lakshmi', type: 'cow' }] }));
    const twice = await callTool(config, 'register_animal', { animals: [{ name: 'Rita', type: 'cow' }, { name: 'rita', type: 'calf' }] });
    expect(twice.content[0]!.text).toContain('appears twice');
    const taken = await callTool(config, 'register_animal', { animals: [{ name: 'Sita', type: 'cow' }, { name: 'Lakshmi', type: 'cow' }] });
    expect(taken.content[0]!.text).toContain('Nothing was saved');
    expect((await ok(callTool(config, 'list_animals', {}))).structuredContent.total).toBe(1);
  });
});
