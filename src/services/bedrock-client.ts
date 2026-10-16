import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { fromIni, fromTemporaryCredentials } from '@aws-sdk/credential-providers';

/**
 * Builds a Bedrock runtime client from environment variables. Shared by every Bedrock caller so the account
 * and credentials are chosen the same way everywhere:
 *
 *   BEDROCK_REGION       defaults to AWS_REGION, then ap-south-1
 *   BEDROCK_ROLE_ARN     optional: assume this role first (Bedrock in another AWS account)
 *   BEDROCK_AWS_PROFILE  optional, local development only: use this named profile for Bedrock calls
 *
 * Without either, the default credential chain is used (the Lambda's own role).
 */
export function createBedrockClientFromEnv(env: NodeJS.ProcessEnv, sessionName: string): BedrockRuntimeClient {
  const region = env.BEDROCK_REGION || env.AWS_REGION || 'ap-south-1';
  const credentials = env.BEDROCK_ROLE_ARN
    ? fromTemporaryCredentials({
        params: { RoleArn: env.BEDROCK_ROLE_ARN, RoleSessionName: sessionName, DurationSeconds: 900 },
        clientConfig: { region },
      })
    : env.BEDROCK_AWS_PROFILE
      ? fromIni({ profile: env.BEDROCK_AWS_PROFILE })
      : undefined;
  return new BedrockRuntimeClient({ region, ...(credentials ? { credentials } : {}) });
}
