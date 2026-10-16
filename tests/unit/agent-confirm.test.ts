import { describe, expect, it } from 'vitest';
import { FarmAgent } from '../../src/agent/agent.js';
import { confirmationAnswer, describeAction } from '../../src/agent/confirm.js';
import { FarmMcpClient } from '../../src/agent/mcp-client.js';
import type { AgentModel, ModelReply, ModelRequest } from '../../src/agent/model.js';
import { handleMcpRequest } from '../../src/mcp/http.js';
import { ENDPOINT, makeTestConfig, TEST_FARM_ID, TEST_TOKEN } from '../helpers/mcp-http.js';

const NOW = new Date('2026-10-14T06:30:00Z');

function setup(model?: AgentModel) {
  const { config, ledger } = makeTestConfig(NOW);
  const tools = new FarmMcpClient({ url: ENDPOINT, token: TEST_TOKEN, fetch: (url, init) => handleMcpRequest(new Request(url, init), config) });
  const agent = new FarmAgent({ tools, model, now: () => NOW });
  const expensesToday = () => ledger.getAllExpenses({ farmId: TEST_FARM_ID, from: '2026-10-14', to: '2026-10-14' });
  return { agent, tools, ledger, expensesToday };
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
    expect(describeAction('correct_entry', { entryId: 'exp_x', newAmountRupees: 900 })).toBe('change the amount to ₹900.00 on that expense');
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
    const model = new ScriptedModel([use('get_expense_summary', { period: 'today' }), use('record_expense', { amountRupees: 800, category: 'medicine' })]);
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
    expect(model.calls).toBe(2); // the model is not asked again to run a confirmed write
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
        { type: 'tool_use', id: 't2', name: 'record_expense', input: { amountRupees: 50000000, category: 'fuel' } },
      ],
    };
    const { agent, expensesToday } = setup(new ScriptedModel([mixed]));
    await agent.handle('600 on feed and 5 crore on diesel', { confirmWrites: true });
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
