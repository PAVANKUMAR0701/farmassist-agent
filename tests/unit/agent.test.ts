import { describe, expect, it } from 'vitest';
import { claimsSuccess, cleanModelText, FarmAgent, numbersIn, quantityNumbersIn } from '../../src/agent/agent.js';
import { FarmMcpClient } from '../../src/agent/mcp-client.js';
import type { AgentModel, ChatBlock, ModelReply, ModelRequest } from '../../src/agent/model.js';
import { handleMcpRequest } from '../../src/mcp/http.js';
import { ENDPOINT, makeTestConfig, TEST_FARM_ID, TEST_TOKEN } from '../helpers/mcp-http.js';

const NOW = new Date('2026-10-14T06:30:00Z'); // 12:00 IST

/** The real MCP SDK client talking to the real server in-process (fetch is routed to handleMcpRequest). */
function setup(model?: AgentModel) {
  const { config, ledger } = makeTestConfig(NOW);
  const tools = new FarmMcpClient({ url: ENDPOINT, token: TEST_TOKEN, fetch: (url, init) => handleMcpRequest(new Request(url, init), config) });
  const agent = new FarmAgent({ tools, model, now: () => NOW });
  const expensesToday = () => ledger.getAllExpenses({ farmId: TEST_FARM_ID, from: '2026-10-14', to: '2026-10-14' });
  return { agent, tools, ledger, expensesToday };
}

/** A model that plays back scripted replies and records what it was sent. */
class ScriptedModel implements AgentModel {
  readonly modelId = 'scripted-test-model';
  readonly requests: ModelRequest[] = [];
  constructor(private readonly script: Array<ModelReply | Error | ((req: ModelRequest) => ModelReply)>) {}
  async respond(request: ModelRequest): Promise<ModelReply> {
    this.requests.push(structuredClone(request));
    const next = this.script.shift();
    if (!next) throw new Error('script exhausted');
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(request) : next;
  }
}
const say = (text: string): ModelReply => ({ content: [{ type: 'text', text }], stopReason: 'end_turn' });
const use = (name: string, input: Record<string, unknown>, id = `tu-${name}`): ModelReply => ({
  content: [{ type: 'tool_use', id, name, input }],
  stopReason: 'tool_use',
});

describe('MCP client', () => {
  it('discovers every server tool with its JSON schema', async () => {
    const { tools } = setup();
    const list = await tools.listTools();
    expect(list.map((t) => t.name).sort()).toEqual(
      [
        'add_insurance',
        'add_reminder',
        'complete_reminder',
        'correct_entry',
        'get_daily_summary',
        'get_expense_summary',
        'get_milk_summary',
        'health_check',
        'list_activities',
        'list_animals',
        'list_crops',
        'list_expenses',
        'list_reminders',
        'record_expense',
        'record_farm_activity',
        'record_harvest',
        'record_milk',
        'record_sowing',
        'register_animal',
        'update_animal',
        'weekly_insights',
      ].sort(),
    );
    const record = list.find((t) => t.name === 'record_expense')!;
    expect(record.inputSchema).toMatchObject({ type: 'object', required: expect.arrayContaining(['amountRupees', 'category']) });
  });

  it('returns tool errors as results, not exceptions', async () => {
    const { tools } = setup();
    const r = await tools.callTool('record_expense', { amountRupees: -1, category: 'feed' });
    expect(r.isError).toBe(true);
  });
});

describe('agent without a model (deterministic fallback)', () => {
  it('records ₹2,500 of feed, then corrects it to ₹900, verified in the ledger', async () => {
    const { agent, ledger, expensesToday } = setup();

    const first = await agent.handle('spent 2500 on feed');
    expect(first).toMatchObject({ mode: 'fallback', reply: 'Recorded ₹2,500.00 on feed for 2026-10-14.' });
    expect(first.toolCalls[0]!.args.clientRequestId).toMatch(/^agent-[0-9A-Z]{26}$/);

    const second = await agent.handle('No, it was 900');
    expect(second.reply).toBe('Corrected the feed expense on 2026-10-14: amount ₹2,500.00 → ₹900.00.');

    const [entry] = await expensesToday();
    expect(entry).toMatchObject({ amountPaise: 90000, version: 2 });
    expect(await ledger.getCorrections(TEST_FARM_ID, entry!.entryId)).toHaveLength(1);
  });

  it('answers a summary question from the server', async () => {
    const { agent } = setup();
    await agent.handle('spent 2500 on feed');
    await agent.handle('paid 800 for medicine');
    const turn = await agent.handle('how much on feed this month');
    expect(turn.reply).toBe('Spent ₹2,500.00 on feed from 2026-10-01 to 2026-10-14 (1 entry).');
  });
});

describe('agent with a model', () => {
  it('runs the tool loop and keeps a reply whose numbers come from the tool result', async () => {
    const model = new ScriptedModel([use('record_expense', { amountRupees: 800, category: 'medicine', note: 'cow medicine' }), say('Saved ₹800.00 for medicine.')]);
    const { agent, expensesToday } = setup(model);

    const turn = await agent.handle('paid 800 for cow medicine');

    expect(turn).toMatchObject({ mode: 'model', reply: 'Saved ₹800.00 for medicine.', numberCheck: 'passed' });
    expect(await expensesToday()).toMatchObject([{ amountPaise: 80000, category: 'medicine' }]);
    // The model received the discovered tools and, in round 2, the server's tool result.
    expect(model.requests[0]!.tools.map((t) => t.name)).toContain('record_expense');
    const toolResult = model.requests[1]!.messages.at(-1)!.content[0] as Extract<ChatBlock, { type: 'tool_result' }>;
    expect(toolResult).toMatchObject({ type: 'tool_result', toolUseId: 'tu-record_expense', isError: false });
    expect(toolResult.text).toContain('Recorded ₹800.00 on medicine');
  });

  it('never shows an invented total: the server said ₹0.00, the model wrote ₹5,000', async () => {
    const model = new ScriptedModel([use('get_expense_summary', { period: 'this_month' }), say('You spent about ₹5,000 this month.')]);
    const { agent } = setup(model);
    const turn = await agent.handle('how much this month');
    expect(turn.numberCheck).toBe('replaced');
    expect(turn.reply).not.toContain('5,000');
    expect(turn.reply).toContain('₹0.00');
  });

  it('falls back to the parser when the model fails before doing anything', async () => {
    const model = new ScriptedModel([Object.assign(new Error('Too many tokens per day'), { name: 'ThrottlingException' })]);
    const { agent, expensesToday } = setup(model);
    const turn = await agent.handle('spent 2500 on feed');
    expect(turn).toMatchObject({ mode: 'fallback', modelError: 'ThrottlingException: Too many tokens per day' });
    expect(await expensesToday()).toHaveLength(1);
  });

  it('does not repeat a write when the model fails after the tool already ran', async () => {
    const model = new ScriptedModel([use('record_expense', { amountRupees: 2500, category: 'feed' }), new Error('connection reset')]);
    const { agent, expensesToday } = setup(model);
    const turn = await agent.handle('spent 2500 on feed');
    expect(turn).toMatchObject({ mode: 'model', reply: 'Recorded ₹2,500.00 on feed for 2026-10-14.', modelError: 'Error: connection reset' });
    expect(await expensesToday()).toHaveLength(1);
  });

  it('stops after the round limit and reports what the tools did', async () => {
    const loop = () => use('health_check', {});
    const model = new ScriptedModel([loop, loop, loop, loop, loop]);
    const { agent } = setup(model);
    const turn = await agent.handle('are you there');
    expect(turn.toolCalls).toHaveLength(4);
    expect(model.requests).toHaveLength(4);
  });

  it('gives the model the earlier entryId so it can correct by id on the next turn', async () => {
    const model = new ScriptedModel([
      use('record_expense', { amountRupees: 800, category: 'medicine' }),
      say('Saved ₹800.00 for medicine.'),
      (req) => {
        const remembered = JSON.stringify(req.messages);
        const entryId = /exp_\d{8}_[0-9A-Z]{26}/.exec(remembered)![0];
        return use('correct_entry', { entryId, newAmountRupees: 900, reason: 'it was 900' });
      },
      say('Changed it from ₹800.00 to ₹900.00.'),
    ]);
    const { agent, expensesToday } = setup(model);
    await agent.handle('paid 800 for medicine');
    const turn = await agent.handle('no, it was 900');
    expect(turn).toMatchObject({ reply: 'Changed it from ₹800.00 to ₹900.00.', numberCheck: 'passed' });
    expect(await expensesToday()).toMatchObject([{ amountPaise: 90000 }]);
  });
});

it('numbersIn normalises money, grouping and percentages', () => {
  expect(numbersIn('₹1,25,000.50 and 74% on 2026-10-14')).toEqual(['125000.5', '74', '2026', '10', '14']);
});

it('cleanModelText removes reasoning blocks and internal id annotations', () => {
  expect(cleanModelText('<thinking>The server is fine.</thinking> Recorded ₹2,500.00. [entryId: act_1]')).toBe('Recorded ₹2,500.00.');
  expect(cleanModelText('Done. <thinking>unclosed')).toBe('Done.');
});

it('does not offer operator-only tools to the model', async () => {
  const model = new ScriptedModel([say('Hello! How can I help?')]);
  const { agent } = setup(model);
  await agent.handle('hi');
  expect(model.requests[0]!.tools.map((t) => t.name)).not.toContain('health_check');
});

it("tells the model today's date in India time, so it never has to guess the year", async () => {
  const model = new ScriptedModel([say('Hello!')]);
  const { agent } = setup(model);
  await agent.handle('hi');
  expect(model.requests[0]!.system).toContain('Today is 2026-10-14 (India time)');
});

it('keeps the previous turn\'s tool use and server result in the history the model sees', async () => {
  const model = new ScriptedModel([use('record_expense', { amountRupees: 800, category: 'medicine' }), say('Saved ₹800.00 for medicine.'), say('OK.')]);
  const { agent } = setup(model);
  await agent.handle('paid 800 for medicine');
  await agent.handle('thanks');
  const history = model.requests[2]!.messages;
  expect(history.map((m) => [m.role, m.content[0]!.type])).toEqual([
    ['user', 'text'],
    ['assistant', 'tool_use'],
    ['user', 'tool_result'],
    ['assistant', 'text'],
    ['user', 'text'],
  ]);
  expect((history[2]!.content[0] as Extract<ChatBlock, { type: 'tool_result' }>).text).toMatch(/"entryId":"exp_20261014_/);
});

it('lets the parser answer when a tool-free model reply fails the number check', async () => {
  const model = new ScriptedModel([say('Was the ₹7,000 for feed?')]); // misheard amount: the farmer said 700
  const { agent, expensesToday } = setup(model);
  const turn = await agent.handle('I spent 700');
  expect(turn).toMatchObject({ mode: 'fallback', numberCheck: 'replaced', unverifiedNumbers: ['7000'] });
  expect(turn.reply).toContain('What was the ₹700 for?');
  expect(await expensesToday()).toHaveLength(0);
});

it('continues a conversation from exported state (as the stateless chat backend does)', async () => {
  const { agent, tools, expensesToday } = setup();
  await agent.handle('spent 2500 on feed');
  const state = JSON.parse(JSON.stringify(agent.exportState())); // survives a round trip through storage
  const next = new FarmAgent({ tools, state, now: () => NOW });
  const turn = await next.handle('no, it was 900');
  expect(turn.reply).toContain('₹2,500.00 → ₹900.00');
  expect(await expensesToday()).toMatchObject([{ amountPaise: 90000 }]);
});

describe('never claims a change the server refused', () => {
  it('replaces "has been updated" after a failed correction with the server\'s reason (live bug, 2026-10-16)', async () => {
    const model = new ScriptedModel([
      use('record_farm_activity', { activityType: 'other', animalOrField: 'Lakshmi cow', note: 'New calf born' }),
      say('The birth of the new calf has been recorded.'),
      (req) => {
        const actId = /act_\d{8}_[0-9A-Z]{26}/.exec(JSON.stringify(req.messages))![0];
        return use('correct_entry', { entryId: actId, newNote: 'calf named Seetha' });
      },
      say("The record of the new calf's birth has been updated to include the name Seetha, but I'm unable to edit activities directly."),
    ]);
    const { agent } = setup(model);
    await agent.handle('New calf born for Lakshmi cow');
    const turn = await agent.handle("Lakshmi's calf is named Seetha");
    expect(turn).toMatchObject({ claimCheck: 'replaced', reply: 'Nothing was saved. Saved activities cannot be edited. To add details, record a new activity with them in the note.' });
  });

  it('keeps an honest reply or a question after a failed write', async () => {
    const model = new ScriptedModel([use('record_expense', { amountRupees: -5, category: 'feed' }), say('That amount looks wrong. How much did you spend on feed?')]);
    const { agent } = setup(model);
    const turn = await agent.handle('spent minus 5 on feed');
    expect(turn.claimCheck).toBeUndefined();
    expect(turn.reply).toBe('That amount looks wrong. How much did you spend on feed?');
  });

  it.each([
    ["The record has been updated to include the name Seetha.", true],
    ['I recorded ₹800.00 for medicine.', true],
    ['Saved it for you.', true],
    ['Recorded ₹2,500.00 on feed.', true],
    ['It was successfully saved.', true],
    ["I couldn't update the record because activities cannot be edited.", false],
    ['The record was not changed.', false],
    ['Which expense do you want to correct?', false],
  ])('claimsSuccess(%j) is %s', (text, expected) => {
    expect(claimsSuccess(text)).toBe(expected);
  });
});

describe('number check in turns without tool calls (live phone test, 2026-10-16)', () => {
  it('keeps a clarifying question that numbers its options', async () => {
    const model = new ScriptedModel([say('Do you want to 1. add 3 new cows or 2. rename existing ones?')]);
    const { agent } = setup(model);
    const turn = await agent.handle('I just want to add three more and name them Sita Gita Rita');
    expect(turn).toMatchObject({ mode: 'model', numberCheck: 'passed', reply: 'Do you want to 1. add 3 new cows or 2. rename existing ones?' });
  });

  it('still blocks an invented amount when no tool ran', async () => {
    const model = new ScriptedModel([say('You usually spend about ₹4,000 on feed.')]);
    const { agent } = setup(model);
    const turn = await agent.handle('what do I usually spend on feed');
    expect(turn.numberCheck).toBe('replaced');
    expect(turn.reply).not.toContain('4,000');
  });

  it('quantityNumbersIn finds only amounts and quantities', () => {
    expect(quantityNumbersIn('1. Lakshmi gave 12.5 litres, 2. ₹2,500 for 3 bags, 74% done, 3 cows')).toEqual(['12.5', '2500', '3', '74']);
  });
});
