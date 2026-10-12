import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

interface Statement { Sid?: string; Effect: string; Principal?: unknown; Action: string | string[]; Resource: string | string[]; Condition?: Record<string, Record<string, unknown>> }

const root = path.resolve(import.meta.dirname, "..");
const ACCOUNT = "123456789012";
const ORDER_QUEUE = `arn:aws:sqs:us-east-2:${ACCOUNT}:amzn-order-queue`;
const AMS_QUEUE = `arn:aws:sqs:us-east-1:${ACCOUNT}:adsbudget-usage-que`;
const load = async (file: string): Promise<Statement[]> => (JSON.parse(await readFile(path.join(root, "infra", file), "utf8")) as { Statement: Statement[] }).Statement;
const list = (value: string | string[]): string[] => (Array.isArray(value) ? value : [value]);
// IAM 通配：* 任意串、? 单字符；动作名不区分大小写，资源 ARN 区分。
const matches = (pattern: string, value: string, ignoreCase = false): boolean => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, ignoreCase ? "i" : "").test(value);

test("两条源队列只放行 Amazon 官方发送方：订单队列为 SP-API 账号，广告预算队列为 Amazon Ads budget-usage 主题经 SNS 投递，均无 Principal *", async () => {
  const order = await load("source-queue-policies/amzn-order-queue.json");
  assert.deepEqual(order.map((item) => [item.Effect, item.Principal, list(item.Action).sort(), item.Resource, item.Condition]), [
    ["Allow", { AWS: "437568002678" }, ["sqs:GetQueueAttributes", "sqs:SendMessage"], ORDER_QUEUE, undefined],
  ]);
  const ams = await load("source-queue-policies/adsbudget-usage-que.json");
  assert.deepEqual(ams.map((item) => [item.Effect, item.Principal, list(item.Action), item.Resource, item.Condition]), [
    ["Allow", { Service: "sns.amazonaws.com" }, ["sqs:SendMessage"], AMS_QUEUE, { ArnLike: { "aws:SourceArn": "arn:aws:sns:us-east-1:055588217351:*" } }],
    ["Allow", { AWS: "arn:aws:iam::926844853897:role/ReviewerRole" }, ["sqs:GetQueueAttributes"], AMS_QUEUE, undefined],
  ]);
  for (const item of [...order, ...ams]) assert.ok(!JSON.stringify(item.Principal).includes('"*"'), `${item.Sid} 不得放行任意主体`);
});

test("部署专用 IAM 用户策略不放行清空队列、收取或删除源队列消息、删状态表或栈、建 IAM 用户与访问密钥，发布与改源队列策略所需权限仍在", async () => {
  const statements = await load("deployer-policy.json");
  const grants = (action: string, resource: string): boolean => statements.some((item) => item.Effect === "Allow"
    && list(item.Action).some((pattern) => matches(pattern, action, true))
    && list(item.Resource).some((pattern) => matches(pattern, resource)));
  for (const [action, resource] of [
    ["sqs:PurgeQueue", ORDER_QUEUE],
    ["sqs:PurgeQueue", `arn:aws:sqs:us-east-2:${ACCOUNT}:amzshop-prod-order-dlq`],
    ["sqs:ReceiveMessage", ORDER_QUEUE],
    ["sqs:DeleteMessage", AMS_QUEUE],
    ["dynamodb:DeleteTable", `arn:aws:dynamodb:us-east-1:${ACCOUNT}:table/amzshop-prod-state`],
    ["cloudformation:DeleteStack", `arn:aws:cloudformation:us-east-1:${ACCOUNT}:stack/amzshop-prod-control/x`],
    ["iam:CreateUser", `arn:aws:iam::${ACCOUNT}:user/x`],
    ["iam:CreateAccessKey", `arn:aws:iam::${ACCOUNT}:user/amzshop-deployer`],
  ] as const) assert.equal(grants(action, resource), false, `${action} 不得放行：${resource}`);
  for (const [action, resource] of [
    ["lambda:UpdateFunctionCode", `arn:aws:lambda:us-east-1:${ACCOUNT}:function:amzshop-prod-jobs`],
    ["cloudformation:CreateChangeSet", `arn:aws:cloudformation:us-east-2:${ACCOUNT}:stack/amzshop-prod-order-us-east-2/x`],
    ["sqs:SetQueueAttributes", ORDER_QUEUE],
    ["sqs:SetQueueAttributes", AMS_QUEUE],
    ["sqs:StartMessageMoveTask", `arn:aws:sqs:us-east-1:${ACCOUNT}:amzshop-prod-ams-dlq`],
    ["signin:CreateOAuth2Token", "*"],
    ["sqs:CreateQueue", `arn:aws:sqs:us-east-1:${ACCOUNT}:amzshop-prod-offer-events`],
    ["sqs:SetQueueAttributes", `arn:aws:sqs:us-east-1:${ACCOUNT}:amzshop-prod-offer-events`],
    ["lambda:CreateFunction", `arn:aws:lambda:us-east-1:${ACCOUNT}:function:amzshop-prod-offer`],
    ["iam:CreateRole", `arn:aws:iam::${ACCOUNT}:role/amzshop-prod-offer`],
    ["scheduler:CreateSchedule", `arn:aws:scheduler:us-east-1:${ACCOUNT}:schedule/amzshop-prod/amzshop-prod-offer-reconcile`],
    ["cloudwatch:PutMetricAlarm", `arn:aws:cloudwatch:us-east-1:${ACCOUNT}:alarm:amzshop-prod-offer-dlq`],
  ] as const) assert.equal(grants(action, resource), true, `${action} 应放行：${resource}`);
});
