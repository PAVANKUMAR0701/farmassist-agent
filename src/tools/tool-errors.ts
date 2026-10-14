/**
 * An error whose message is safe and useful to show the caller (usually the AI model, so it can fix its request
 * or ask the farmer a clarifying question). Anything else is logged and replaced with a generic message, so
 * internal details such as table names never leak.
 */
export class ToolUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolUserError';
  }
}

export async function runTool<T>(toolName: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ToolUserError) throw error;
    console.error(JSON.stringify({ level: 'error', tool: toolName, error: error instanceof Error ? error.name : 'Unknown', message: error instanceof Error ? error.message : String(error) }));
    throw new ToolUserError(`${toolName} failed because of a temporary server problem. Nothing was changed; please try again.`);
  }
}
