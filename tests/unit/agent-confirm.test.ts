import { describe, expect, it } from 'vitest';
import { FarmAgent } from '../../src/agent/agent.js';
import { confirmationAnswer, confirmationPrompt, describeAction } from '../../src/agent/confirm.js';
import { FarmMcpClient } from '../../src/agent/mcp-client.js';
import type { AgentModel, ModelReply, ModelRequest } from '../../src/agent/model.js';
import { handleMcpRequest } from '../../src/mcp/http.js';
import { ENDPOINT, makeTestConfig, TEST_FARM_ID, TEST_TOKEN } from '../helpers/mcp-http.js';

const NOW = new Date('2026-10-14T06:30:00Z');

function setup(model?: AgentModel) {
  const { config, ledger, records } = makeTestConfig(NOW);
  const tools = new FarmMcpClient({ url: ENDPOINT, token: TEST_TOKEN, fetch: (url, init) => handleMcpRequest(new Request(url, init), config) });
  const agent = new FarmAgent({ tools, model, now: () => NOW });
  const expensesToday = () => ledger.getAllExpenses({ farmId: TEST_FARM_ID, from: '2026-10-14', to: '2026-10-14' });
  return { agent, tools, ledger, records, expensesToday };
}

class ScriptedModel implements AgentModel {
  readonly modelId = 'scripted';
  calls = 0;
  constructor(private readonly script: ModelReply[]) {}
  async respond(_request: ModelRequest): Promise<ModelReply> {
    this.calls++;
    const next = this.script.shift();
    if (!next) throw new Error('script exhausted');
    return next;
  }
}
const use = (name: string, input: Record<string, unknown>): ModelReply => ({ content: [{ type: 'tool_use', id: `tu-${name}`, name, input }], stopReason: 'tool_use' });

describe('confirmationAnswer', () => {
  it.each([
    ['yes', 'yes'],
    ['Yes please', 'yes'],
    ['haan', 'yes'],
    ['Haan ji', 'yes'],
    ['theek hai', 'yes'],
    ['aama', 'yes'],
    ['சரி', 'yes'],
    ['हाँ', 'yes'],
    ['ok go ahead', 'yes'],
    ['no', 'no'],
    ['No, cancel', 'no'],
    ['nahi', 'no'],
    ['venda', 'no'],
    ['வேண்டாம்', 'no'],
    ['no, it was 250 on feed', 'other'],
    ['yes but make it 250', 'other'],
    ["ok don't", 'other'],
    // Live 2026-10-16: the phone's mic picked up the app's own "Okay, nothing was saved." - never a yes.
    ['okay nothing was saved', 'other'],
    ['ok not now', 'other'],
    ['wait', 'no'],
    ['spent 500 on fuel', 'other'],
  ])('%j -> %s', (text, expected) => {
    expect(confirmationAnswer(text)).toBe(expected);
  });
});

describe('describeAction', () => {
  it('reads back exactly what would be saved', () => {
    expect(describeAction('record_expense', { amountRupees: 2500, category: 'feed' })).toBe('record ₹2,500.00 on feed for today');
    expect(describeAction('record_expense', { amountRupees: 149.5, category: 'medicine', date: '2026-10-13' })).toBe('record ₹149.50 on medicine for 2026-10-13');
    expect(describeAction('record_farm_activity', { activityType: 'vaccination', animalOrField: 'brown cow' })).toBe('record vaccination for brown cow for today');
    expect(describeAction('record_farm_activity', { activityType: 'other', animalOrField: 'Lakshmi', note: 'calf named Seetha' })).toBe('record "calf named Seetha" for Lakshmi for today');
    expect(describeAction('correct_entry', { entryId: 'exp_20261013_01J00000000000000000000007', newAmountRupees: 900 })).toBe('change the amount to ₹900.00 on the expense from 2026-10-13');
    expect(describeAction('correct_entry', { match: { category: 'feed' }, newCategory: 'fodder' })).toBe('change the category to fodder on the feed expense from today');
  });
});

describe('voice turns: nothing is written until the farmer says yes', () => {
  it('fallback: asks, then saves exactly once on "haan"', async () => {
    const { agent, expensesToday } = setup();
    const ask = await agent.handle('spent 2500 on feed', { confirmWrites: true });
    expect(ask).toMatchObject({ reply: 'Shall I record ₹2,500.00 on feed for today? Say yes to save it, or no to cancel.', confirmation: {}, toolCalls: [] });
    expect(await expensesToday()).toHaveLength(0);

    const done = await agent.handle('haan', { confirmWrites: true });
    expect(done).toMatchObject({ confirmed: true, reply: 'Recorded ₹2,500.00 on feed for 2026-10-14.' });
    expect(await expensesToday()).toMatchObject([{ amountPaise: 250000 }]);
  });

  it('"no" cancels and writes nothing', async () => {
    const { agent, expensesToday } = setup();
    await agent.handle('spent 2500 on feed', { confirmWrites: true });
    expect(await agent.handle('no', { confirmWrites: true })).toMatchObject({ confirmed: false, reply: 'Okay, nothing was saved.' });
    expect(await expensesToday()).toHaveLength(0);
  });

  it('anything else drops the pending write, and a later "yes" does not revive it', async () => {
    const { agent, expensesToday } = setup();
    await agent.handle('spent 2500 on feed', { confirmWrites: true });
    const other = await agent.handle('how much on feed this month', { confirmWrites: true });
    expect(other.toolCalls.map((c) => c.name)).toEqual(['get_expense_summary']);
    await agent.handle('yes', { confirmWrites: true });
    expect(await expensesToday()).toHaveLength(0);
  });

  it('typed messages are saved straight away (no confirmation)', async () => {
    const { agent, expensesToday } = setup();
    expect((await agent.handle('spent 2500 on feed')).confirmation).toBeUndefined();
    expect(await expensesToday()).toHaveLength(1);
  });

  it('model: reads run, the write is held; confirmed after a storage round trip, with the same clientRequestId', async () => {
    const model = new ScriptedModel([
      use('get_expense_summary', { period: 'today' }),
      use('record_expense', { amountRupees: 800, category: 'medicine' }),
      { content: [{ type: 'text', text: 'Waiting for your answer.' }], stopReason: 'end_turn' },
    ]);
    const { agent, tools, expensesToday } = setup(model);
    const ask = await agent.handle('paid 800 for medicine', { confirmWrites: true });
    expect(ask.toolCalls.map((c) => c.name)).toEqual(['get_expense_summary']);
    expect(ask.reply).toBe('Shall I record ₹800.00 on medicine for today? Say yes to save it, or no to cancel.');
    expect(await expensesToday()).toHaveLength(0);

    // The hosted backend stores state between requests; the "yes" arrives in a new agent.
    const state = JSON.parse(JSON.stringify(agent.exportState()));
    const heldId = state.pending.changes[0].args.clientRequestId;
    const next = new FarmAgent({ tools, model, state, now: () => NOW });
    const done = await next.handle('yes', { confirmWrites: true });
    expect(done.toolCalls[0]!.args.clientRequestId).toBe(heldId);
    expect(model.calls).toBe(3); // asked once more for other changes, then not again to run the confirmed write
    expect(await expensesToday()).toMatchObject([{ amountPaise: 80000, category: 'medicine' }]);
  });

  it('a confirmed write the server refuses is reported honestly', async () => {
    const { agent, expensesToday } = setup();
    await agent.handle('spent 20000000 on feed', { confirmWrites: true }); // over the ₹1 crore limit
    const done = await agent.handle('yes', { confirmWrites: true });
    expect(done.reply).toMatch(/^Nothing was saved\./);
    expect(await expensesToday()).toHaveLength(0);
  });
});

describe('several changes in one spoken message (live phone test, 2026-10-16)', () => {
  const threeExpenses: ModelReply = {
    stopReason: 'tool_use',
    content: [
      { type: 'tool_use', id: 't1', name: 'record_expense', input: { amountRupees: 3500, category: 'other', note: 'salt' } },
      { type: 'tool_use', id: 't2', name: 'record_expense', input: { amountRupees: 6000, category: 'feed' } },
      { type: 'tool_use', id: 't3', name: 'record_expense', input: { amountRupees: 400, category: 'medicine', note: 'vaccination' } },
    ],
  };

  it('reads all of them back in one question and saves all on one "yes"', async () => {
    const { agent, expensesToday } = setup(new ScriptedModel([threeExpenses]));
    const ask = await agent.handle('today I spent 3500 for salt, 6000 for feed and 400 for the vaccination', { confirmWrites: true });
    expect(ask.reply).toBe(
      'Shall I record 3 expenses for today: ₹3,500.00 on other, ₹6,000.00 on feed and ₹400.00 on medicine? Say yes to save them, or no to cancel.',
    );
    expect(await expensesToday()).toHaveLength(0);

    const done = await agent.handle('haan', { confirmWrites: true });
    expect(done.toolCalls).toHaveLength(3);
    expect(done.reply).toBe(
      'Recorded ₹3,500.00 on other for 2026-10-14. Recorded ₹6,000.00 on feed for 2026-10-14. Recorded ₹400.00 on medicine for 2026-10-14.',
    );
    expect((await expensesToday()).map((e) => e.amountPaise).sort((a, b) => a - b)).toEqual([40000, 350000, 600000]);
  });

  it('says exactly which ones were not saved when the server refuses some', async () => {
    const mixed: ModelReply = {
      stopReason: 'tool_use',
      content: [
        { type: 'tool_use', id: 't1', name: 'record_expense', input: { amountRupees: 600, category: 'feed' } },
        { type: 'tool_use', id: 't2', name: 'record_expense', input: { amountRupees: 500, category: 'fuel', date: '2027-01-01' } }, // only the server knows "today"
      ],
    };
    const { agent, expensesToday } = setup(new ScriptedModel([mixed]));
    await agent.handle('600 on feed and 500 on diesel next January', { confirmWrites: true });
    const done = await agent.handle('yes', { confirmWrites: true });
    expect(done.reply).toMatch(/^Recorded ₹600\.00 on feed for 2026-10-14\. Not saved: /);
    expect(await expensesToday()).toHaveLength(1);
  });

  it('confirms a conversation stored in the older single-change format', async () => {
    const { tools, expensesToday } = setup();
    const state = {
      history: [],
      pending: { name: 'record_expense', args: { amountRupees: 250, category: 'feed', clientRequestId: 'agent-legacy-0001' }, prompt: 'Shall I…', mode: 'fallback' },
    };
    const agent = new FarmAgent({ tools, state: state as never, now: () => NOW });
    expect((await agent.handle('yes', { confirmWrites: true })).confirmed).toBe(true);
    expect(await expensesToday()).toMatchObject([{ amountPaise: 25000 }]);
  });
});

describe('corrections are checked before the farmer is asked (live phone test, 2026-10-16)', () => {
  it('an invented activity id never reaches a read-back; the model recovers with a new activity', async () => {
    const requests: ModelRequest[] = [];
    const script: ModelReply[] = [
      use('correct_entry', { entryId: 'act_20261016_01M52935999999999999999999', newNote: 'Three more cows named Maya, Geeta and Saraswati' }),
      use('record_farm_activity', { activityType: 'other', animalOrField: 'three new cows', note: 'named Maya, Geeta and Saraswati' }),
    ];
    const model: AgentModel = { modelId: 'scripted', respond: async (r) => (requests.push(structuredClone(r)), script.shift()!) };
    const { agent, ledger } = setup(model);

    const ask = await agent.handle('I have named three more cows Maya Geeta Saraswati', { confirmWrites: true });

    // The model was told why, in the same turn, and its second attempt is what the farmer is asked about.
    const refusal = requests[1]!.messages.at(-1)!.content[0] as { text: string; isError: boolean };
    expect(refusal).toMatchObject({ isError: true, text: expect.stringContaining('saved activities cannot be edited') });
    expect(ask.reply).toBe('Shall I record "named Maya, Geeta and Saraswati" for three new cows for today? Say yes to save it, or no to cancel.');
    await agent.handle('yes', { confirmWrites: true });
    expect(await ledger.getActivities({ farmId: TEST_FARM_ID, from: '2026-10-14', to: '2026-10-14' })).toMatchObject([{ animalOrField: 'three new cows' }]);
  });

  it('a guessed expense id is refused without calling the server, also for typed messages', async () => {
    const script: ModelReply[] = [use('correct_entry', { entryId: 'exp_20261014_01J00000000000000000000099', newAmountRupees: 900 }), { content: [{ type: 'text', text: 'Which expense should I change?' }], stopReason: 'end_turn' }];
    const model: AgentModel = { modelId: 'scripted', respond: async () => script.shift()! };
    const { agent } = setup(model);
    const turn = await agent.handle('no, it was 900');
    expect(turn.toolCalls).toMatchObject([{ name: 'correct_entry', result: { isError: true, text: expect.stringContaining('did not come from a tool result') } }]);
    expect(turn.reply).toBe('Which expense should I change?');
  });
});

describe('requests are checked against the tool schema before a read-back (live phone test, 2026-10-16)', () => {
  it('a missing activityType is sent back to the model, never read out as "undefined"', async () => {
    const requests: ModelRequest[] = [];
    const script: ModelReply[] = [
      use('record_farm_activity', { animalOrField: 'three cows', note: 'named Aisa, Sita and Geeta' }),
      use('record_farm_activity', { activityType: 'other', animalOrField: 'three cows', note: 'named Aisa, Sita and Geeta' }),
    ];
    const model: AgentModel = { modelId: 'scripted', respond: async (r) => (requests.push(structuredClone(r)), script.shift()!) };
    const { agent } = setup(model);

    const ask = await agent.handle('I just wanted to name the three cows Aisa Sita Geeta', { confirmWrites: true });

    const bounced = requests[1]!.messages.at(-1)!.content[0] as { text: string; isError: boolean };
    expect(bounced).toMatchObject({ isError: true, text: expect.stringContaining('"activityType" is required') });
    expect(ask.reply).toBe('Shall I record "named Aisa, Sita and Geeta" for three cows for today? Say yes to save it, or no to cancel.');
    expect(ask.reply).not.toContain('undefined');
  });

  it('read-backs never print "undefined" even for incomplete arguments', () => {
    expect(describeAction('record_farm_activity', { animalOrField: 'Lakshmi' })).toBe('record an activity for Lakshmi for today');
    expect(describeAction('record_expense', { amountRupees: 100 })).toBe('record ₹100.00 on an unknown category for today');
  });
});

describe('read-backs for farm records', () => {
  it('says plainly what will be saved', () => {
    expect(describeAction('register_animal', { name: 'Maya', type: 'cow', breed: 'HF' })).toBe('register a cow named Maya (HF)');
    expect(describeAction('update_animal', { animalName: 'Gita', newName: 'Geeta' })).toBe('rename Gita to Geeta');
    expect(describeAction('update_animal', { animalName: 'Raju', status: 'sold' })).toBe('mark Raju as sold');
    expect(describeAction('record_milk', { litres: 8.5, animalName: 'Lakshmi', session: 'morning' })).toBe('record 8.5 litres of milk from Lakshmi (morning) for today');
    expect(describeAction('record_sowing', { crop: 'paddy', field: 'north field', areaAcres: 2, seedQuantity: 50 })).toBe('record sowing of paddy in north field (2 acres, 50 kg of seed) today');
    expect(describeAction('record_harvest', { crop: 'ragi', quantity: 4, unit: 'quintal', final: true })).toBe('record a final harvest of 4 quintal of ragi for today');
    expect(describeAction('add_insurance', { animalName: 'Lakshmi', insurer: 'United India', endDate: '2027-03-31' })).toBe('save insurance for Lakshmi with United India ending 2027-03-31');
    expect(describeAction('add_reminder', { title: 'Deworm the calves', dueDate: '2026-11-01' })).toBe('remind you to "Deworm the calves" on 2026-11-01');
  });

  it('groups several new animals of one kind into one question', () => {
    expect(
      confirmationPrompt([
        { name: 'register_animal', args: { name: 'Maya', type: 'cow' } },
        { name: 'register_animal', args: { name: 'Geeta', type: 'cow' } },
        { name: 'register_animal', args: { name: 'Saraswati', type: 'cow', breed: 'Gir' } },
      ]),
    ).toBe('Shall I register 3 cows: Maya, Geeta and Saraswati (Gir)? Say yes to save them, or no to cancel.');
  });
});


it('voice: collects changes the model asks for one per round, and reads them all back together', async () => {
  const one = (name: string): ModelReply => use('register_animal', { animals: [{ name, type: 'cow' }] });
  const done: ModelReply = { content: [{ type: 'text', text: 'All four are ready.' }], stopReason: 'end_turn' };
  // The same request twice (a model repeating itself) is held once.
  const model = new ScriptedModel([one('Lakshmi'), one('Maya'), one('Maya'), one('Geeta'), one('Rita'), done]);
  const { agent, records } = setup(model);
  const ask = await agent.handle('I have 4 cows: Lakshmi, Maya, Geeta and Rita', { confirmWrites: true });
  expect(ask.reply).toBe('Shall I register 4 cows: Lakshmi, Maya, Geeta and Rita? Say yes to save them, or no to cancel.');
  expect(await records.list(TEST_FARM_ID, 'animal')).toHaveLength(0);
  await agent.handle('yes', { confirmWrites: true });
  expect((await records.list<{ name: string }>(TEST_FARM_ID, 'animal')).map((a) => a.data.name)).toEqual(['Lakshmi', 'Maya', 'Geeta', 'Rita']);
});

it('history shows a confirmed voice change as plain tool calls, never the read-back question', async () => {
  const requests: ModelRequest[] = [];
  const script: ModelReply[] = [
    use('record_expense', { amountRupees: 1200, category: 'fuel' }),
    { content: [{ type: 'text', text: 'Ready.' }], stopReason: 'end_turn' },
    { content: [{ type: 'text', text: 'Hello again.' }], stopReason: 'end_turn' },
  ];
  const model: AgentModel = { modelId: 'scripted', respond: async (r) => (requests.push(structuredClone(r)), script.shift()!) };
  const { agent } = setup(model);
  await agent.handle('spent 1200 on diesel', { confirmWrites: true });
  await agent.handle('yes', { confirmWrites: true });
  await agent.handle('hi', { confirmWrites: true });

  const seen = requests.at(-1)!.messages;
  expect(JSON.stringify(seen)).not.toContain('Shall I');
  expect(seen.map((m) => [m.role, m.content[0]!.type])).toEqual([
    ['user', 'text'], // "spent 1200 on diesel"
    ['assistant', 'tool_use'],
    ['user', 'tool_result'],
    ['assistant', 'text'], // the server's "Recorded ₹1,200.00 on fuel ..."
    ['user', 'text'], // "hi"
  ]);
});

it('ignores a clientRequestId the model sends (live: copied from history, so the server refused it as reused)', async () => {
  const copied = 'agent-01M52DBD79D32ZXDD1CG63HZN9';
  const requests: ModelRequest[] = [];
  const script: ModelReply[] = [
    use('record_expense', { amountRupees: 100, category: 'feed', clientRequestId: copied }),
    { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
  ];
  const model: AgentModel = { modelId: 'scripted', respond: async (r) => (requests.push(structuredClone(r)), script.shift()!) };
  const { agent, expensesToday } = setup(model);
  await agent.handle('spent 100 on feed', { confirmWrites: true });
  const done = await agent.handle('yes', { confirmWrites: true });
  expect(done.toolCalls[0]!.args.clientRequestId).not.toBe(copied);
  expect(await expensesToday()).toHaveLength(1);
  // The model is not even offered the field.
  const offered = requests[0]!.tools.find((t) => t.name === 'record_expense')!.inputSchema as { properties: object };
  expect(offered.properties).not.toHaveProperty('clientRequestId');
});

it('reads back every insurance detail, so a premium saved as the cover or an invented policy number is heard (live, 2026-10-16)', () => {
  expect(describeAction('add_insurance', { animalName: 'Lakshmi', insurer: 'United India', endDate: '2026-11-05', policyNumber: 'UND001', sumInsuredRupees: 1850 })).toBe(
    'save insurance for Lakshmi with United India ending 2026-11-05, policy number UND001, cover ₹1,850.00',
  );
  expect(describeAction('register_animal', { animals: [{ name: 'Seetha', type: 'calf', birthDate: '2026-10-01', motherName: 'Lakshmi' }] })).toBe(
    'register a calf named Seetha (born 2026-10-01, mother Lakshmi)',
  );
});


describe('arguments are cleaned and checked before a read-back (live, 2026-10-16)', () => {
  it('drops placeholders and zero amounts the farmer never said', async () => {
    const { cleanArgs } = await import('../../src/agent/agent.js');
    const schema = {
      type: 'object',
      required: ['insurer', 'endDate'],
      properties: { insurer: { type: 'string' }, endDate: { type: 'string' }, policyNumber: { type: 'string' }, sumInsuredRupees: { type: 'number', exclusiveMinimum: 0 } },
    };
    expect(cleanArgs(schema, { insurer: 'United India', endDate: '2026-11-05', policyNumber: 'N/A', sumInsuredRupees: 0 })).toEqual({ insurer: 'United India', endDate: '2026-11-05' });
  });

  it('fixes enum case and plurals inside lists, and still bounces a truly invalid value', async () => {
    const { cleanArgs, schemaProblems } = await import('../../src/agent/agent.js');
    const schema = { type: 'object', required: ['animals'], properties: { animals: { type: 'array', items: { type: 'object', required: ['type'], properties: { type: { type: 'string', enum: ['cow', 'calf'] } } } } } };
    expect(cleanArgs(schema, { animals: [{ type: 'Cows' }, { type: 'Calf' }] })).toEqual({ animals: [{ type: 'cow' }, { type: 'calf' }] });
    expect(schemaProblems(schema, { animals: [{ type: 'cow' }, { type: 'dragon' }] })).toEqual(['"animals[1].type" must be one of "cow", "calf"']);
  });
});
