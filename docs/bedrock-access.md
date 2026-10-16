# Bedrock access

FarmAssist works without any model. Bedrock adds natural-language chat (the agent) and nicer weekly-insight wording. This page records which accounts can call which models, and what is still needed.

## Status, 2026-10-16

| Account | Model | Result of a real `converse` call |
|---|---|---|
| Personal, 381492152939 (deploys the stack) | Nova Lite, Nova Micro, Nova 2 Lite | `ThrottlingException: Too many tokens per day`. Every Nova quota is 0, and the per-day quotas can't be raised through self-service. |
| Personal | Claude Haiku 4.5 | Cross-region quotas are 0 (checked 2026-10-15). |
| Bedrock account, 231427841372 (IAM user `Pavan_BedRock_MCP`) | Nova Lite, Nova Micro, Nova 2 Lite | `AccessDeniedException`: the user's policy doesn't allow these models. |
| Bedrock account | Claude Haiku 4.5 | `AccessDeniedException`: the account's one-time AWS Marketplace subscription isn't done ([FRICTION #5](../FRICTION.md)). |

**No live model invocation has succeeded yet.** Everything model-related is tested against mocked Bedrock responses. The agent falls back to its deterministic parser on any model error. That fallback was seen working against the deployed backend with the real `AccessDeniedException`.

## Request for the Bedrock account admin (231427841372)

Nova is Amazon's own model, so it doesn't need the Marketplace subscription that blocks Haiku. It only needs IAM permission. Add this inline policy to the IAM user `Pavan_BedRock_MCP`:

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

Local agent runs (`npm run agent`, see the README) read `AGENT_MODEL_ID` and `BEDROCK_AWS_PROFILE=M80PocBedrockKeys`.

The deployed Lambda shouldn't hold that user's keys. When the agent runs in AWS (Step 4), the Bedrock account should create a role that trusts the stack's `FunctionRoleArn` output and has the policy above. Set its ARN as `BedrockRoleArn`. The template already limits the function to `sts:AssumeRole` on that one role.
