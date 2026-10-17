# Bedrock access

FarmAssist works without any model. Bedrock adds natural-language chat (the agent) and nicer weekly-insight wording. This page records which accounts can call which models, and what is still needed.

## Status, 2026-10-16

| Account | Model | Result of a real `converse` call |
|---|---|---|
| Personal, 381492152939 (deploys the stack) | Nova Lite, Nova Micro, Nova 2 Lite | `ThrottlingException: Too many tokens per day`. Every Nova quota is 0, and the per-day quotas can't be raised through self-service. |
| Personal | Claude Haiku 4.5 | Cross-region quotas are 0 (checked 2026-10-15). |
| Bedrock account, 231427841372 (IAM user `Pavan_BedRock_MCP`) | Nova Lite, Nova Micro | **Works** (since the policy below was added, 2026-10-16). Evaluated in [model-evaluation.md](model-evaluation.md). |
| Bedrock account | Claude Haiku 4.5 | `AccessDeniedException`: the account's one-time AWS Marketplace subscription isn't done ([FRICTION #5](../FRICTION.md)). |

**Nova Lite and Nova Micro work through the Bedrock account.** Nova Lite drives the agent. The agent still falls back to its deterministic parser on any model error, which was also seen working against the deployed backend with a real `AccessDeniedException`.

## Policy on the Bedrock account (231427841372), added 2026-10-16

Nova is Amazon's own model, so it doesn't need the Marketplace subscription that blocks Haiku. It only needed IAM permission. This statement was added to the IAM user `Pavan_BedRock_MCP`, next to its existing Haiku statement:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "InvokeNovaLiteAndMicro",
      "Effect": "Allow",
      "Action": "bedrock:InvokeModel",
      "Resource": [
        "arn:aws:bedrock:ap-south-1:231427841372:inference-profile/apac.amazon.nova-lite-v1:0",
        "arn:aws:bedrock:ap-south-1:231427841372:inference-profile/apac.amazon.nova-micro-v1:0",
        "arn:aws:bedrock:*::foundation-model/amazon.nova-lite-v1:0",
        "arn:aws:bedrock:*::foundation-model/amazon.nova-micro-v1:0"
      ]
    }
  ]
}
```

The Converse API is authorised by `bedrock:InvokeModel`. An `apac.` inference profile can route to any APAC region, so the foundation-model ARNs use `*` for the region.

Then check from this machine:

```bash
aws bedrock-runtime converse --profile M80PocBedrockKeys --region ap-south-1 --model-id apac.amazon.nova-lite-v1:0 --messages '[{"role":"user","content":[{"text":"Reply with exactly: OK"}]}]'
```

If that call fails with "Too many tokens per day", that account's Nova quotas are also 0 and need an AWS Support case.

## Using it

Local agent runs (`npm run agent`, `npm run agent-eval`) read `AGENT_MODEL_ID` and `BEDROCK_AWS_PROFILE=M80PocBedrockKeys`.

The deployed chat function must not hold that IAM user's keys. Instead it assumes a role in the Bedrock account that trusts only the chat function's own role. The template already limits the function to `sts:AssumeRole` on the one role ARN you pass in.

### Two changes applied (2026-10-18)

1. **Weekly-insights wording:** the trust policy of `Pavan_BedRock_MCP_Role` is now [infra/bedrock-account/trust.json](../infra/bedrock-account/trust.json), which lists both Lambda roles. Verified: `weekly_insights` on the deployed server returns `source: bedrock`.
2. **Retrieval embeddings:** [infra/bedrock-account/invoke-nova-embeddings.json](../infra/bedrock-account/invoke-nova-embeddings.json) was added as an inline policy on the role and on the user `Pavan_BedRock_MCP`. Amazon Nova Multimodal Embeddings exists only in us-east-1. Verified from this machine: the index was built (13 vectors) and `npm run retrieval-eval -- --vectors` ran. The stack is deployed with `KnowledgeEmbeddings=nova`.

### Cross-account role for the deployed agent

**In use since 2026-10-16:** `arn:aws:iam::231427841372:role/Pavan_BedRock_MCP_Role`, created by the account owner with the two policies below (also saved as [infra/bedrock-account/](../infra/bedrock-account/)). It was confirmed working by live signed-in chats answered by Nova Lite, with no Bedrock errors in the chat function's logs.

This needs an **admin of the Bedrock account (231427841372)**. The `Pavan_BedRock_MCP` user cannot create roles.

Role name: `farmassist-agent-bedrock`

**Trust policy.** Only the chat function's role (the stack output `ChatFunctionRoleArn`) may assume it:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::381492152939:role/farmassist-dev-ChatFunctionRole-KmnaKYpptu6w" },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

**Permissions policy** (inline, named `InvokeNovaLite`). It allows only the model the agent uses:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "bedrock:InvokeModel",
      "Resource": [
        "arn:aws:bedrock:ap-south-1:231427841372:inference-profile/apac.amazon.nova-lite-v1:0",
        "arn:aws:bedrock:*::foundation-model/amazon.nova-lite-v1:0"
      ]
    }
  ]
}
```

To create it with the CLI, save the two documents as `trust.json` and `invoke-nova-lite.json`. Use a profile with IAM admin rights in 231427841372:

```bash
aws iam create-role --profile <bedrock-account-admin> --role-name farmassist-agent-bedrock --assume-role-policy-document file://trust.json --description "FarmAssist chat agent (account 381492152939) invokes Nova Lite"
aws iam put-role-policy --profile <bedrock-account-admin> --role-name farmassist-agent-bedrock --policy-name InvokeNovaLite --policy-document file://invoke-nova-lite.json
```

In the console, the same thing is: IAM → Roles → Create role → *Custom trust policy* (paste the trust policy) → no managed policies → name it `farmassist-agent-bedrock` → then *Add permissions → Create inline policy → JSON* (paste the permissions policy).

Then redeploy with the role. In PowerShell:

```powershell
sam deploy --stack-name farmassist-dev --region ap-south-1 --profile MyPersonalAWSAccount --resolve-s3 --capabilities CAPABILITY_IAM --no-confirm-changeset --parameter-overrides AgentModelId=apac.amazon.nova-lite-v1:0 AgentBedrockRoleArn=arn:aws:iam::231427841372:role/farmassist-agent-bedrock
```

Notes:
- The trust names the chat role's exact ARN. If that role is ever replaced (for example after deleting and recreating the stack), its ARN changes and the trust policy must be updated.
- No external ID is needed: both accounts belong to the same owner, and no third party assumes the role.
- Until this is done, the deployed agent runs in basic mode (the deterministic parser), and everything else works.
