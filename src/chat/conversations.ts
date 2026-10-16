/**
 * Conversation memory for the hosted agent. Lambda keeps nothing between requests, so each conversation's
 * agent state is stored in the ledger table under the farm, per user, and expires after a day.
 *
 *   PK = FARM#<farmId>   SK = CONV#<userId>#<conversationId>   (TTL attribute expiresAt)
 */
import { GetCommand, PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { AgentState } from '../agent/agent.js';

export const CONVERSATION_TTL_SECONDS = 24 * 60 * 60;
export const CONVERSATION_ID = /^[A-Za-z0-9_-]{8,64}$/;

export interface ConversationKey {
  farmId: string;
  userId: string;
  conversationId: string;
}

export interface ConversationStore {
  load(key: ConversationKey): Promise<AgentState | undefined>;
  save(key: ConversationKey, state: AgentState): Promise<void>;
}

const sortKey = (key: ConversationKey) => `CONV#${key.userId}#${key.conversationId}`;

export class DynamoConversationStore implements ConversationStore {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async load(key: ConversationKey): Promise<AgentState | undefined> {
    const { Item } = await this.client.send(new GetCommand({ TableName: this.tableName, Key: { PK: `FARM#${key.farmId}`, SK: sortKey(key) } }));
    // TTL deletion can lag by days, so an expired item is treated as gone.
    if (!Item || (typeof Item.expiresAt === 'number' && Item.expiresAt * 1000 < this.now().getTime())) return undefined;
    return JSON.parse(Item.state as string) as AgentState;
  }

  async save(key: ConversationKey, state: AgentState): Promise<void> {
    const now = this.now();
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `FARM#${key.farmId}`,
          SK: sortKey(key),
          type: 'CONVERSATION',
          state: JSON.stringify(state),
          updatedAt: now.toISOString(),
          expiresAt: Math.floor(now.getTime() / 1000) + CONVERSATION_TTL_SECONDS,
        },
      }),
    );
  }
}

export class InMemoryConversationStore implements ConversationStore {
  private readonly items = new Map<string, string>();

  async load(key: ConversationKey): Promise<AgentState | undefined> {
    const json = this.items.get(`${key.farmId}|${sortKey(key)}`);
    return json ? (JSON.parse(json) as AgentState) : undefined;
  }

  async save(key: ConversationKey, state: AgentState): Promise<void> {
    this.items.set(`${key.farmId}|${sortKey(key)}`, JSON.stringify(state));
  }
}
