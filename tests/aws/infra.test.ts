import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const template = await readFile(path.join(root, "infra", "template.yaml"), "utf8");

test("模板只含 ASCII：发布脚本用 AWS CLI file:// 读模板，Windows 按本机代码页解码，中文注释会让模板校验失败（2026-10-07 实测）", () => {
  assert.equal([...template].findIndex((char) => char.charCodeAt(0) > 127), -1);
  assert.match(resourceBlocks().get("CompetitorSchedule") ?? "", /ScheduleExpression: cron\(0 0\/2 \* \* \? \*\)\n\s+ScheduleExpressionTimezone: Asia\/Shanghai/, "竞品比价每 2 小时（北京时间偶数整点）触发");
});

function section(name: string): string {
  const lines = template.split(/\r?\n/);
  const start = lines.indexOf(`${name}:`);
  assert.ok(start >= 0, `模板缺少 ${name}`);
  const end = lines.findIndex((line, index) => index > start && /^[A-Za-z]/.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

function logicalIds(name: string): Set<string> {
  return new Set([...section(name).matchAll(/^ {2}([A-Za-z][A-Za-z0-9]*):/gm)].map((match) => match[1] ?? ""));
}

function resourceBlocks(): Map<string, string> {
  const blocks = new Map<string, string>();
  for (const part of section("Resources").split(/^(?= {2}[A-Za-z][A-Za-z0-9]*:)/m)) {
    const id = /^ {2}([A-Za-z][A-Za-z0-9]*):/.exec(part)?.[1];
    if (id) blocks.set(id, part);
  }
  return blocks;
}

function blocksOfType(type: string): Array<[string, string]> {
  return [...resourceBlocks()].filter(([, block]) => block.includes(`Type: ${type}\n`) || block.includes(`Type: ${type}\r\n`));
}

test("CloudFormation 模板的 Ref、GetAtt、DependsOn、条件与 Sub 引用全部可解析", () => {
  const parameters = logicalIds("Parameters");
  const conditions = logicalIds("Conditions");
  const resources = logicalIds("Resources");
  const body = [section("Conditions"), section("Resources"), section("Outputs")].join("\n");
  const missing: string[] = [];
  const need = (kind: string, id: string, ok: boolean) => { if (!ok) missing.push(`${kind} ${id}`); };
  const value = (id: string) => id.startsWith("AWS::") || parameters.has(id) || resources.has(id);
  for (const match of body.matchAll(/!Ref\s+([A-Za-z][\w:]*)/g)) need("Ref", match[1] ?? "", value(match[1] ?? ""));
  for (const match of body.matchAll(/!GetAtt\s+([A-Za-z]\w*)\./g)) need("GetAtt", match[1] ?? "", resources.has(match[1] ?? ""));
  for (const match of body.matchAll(/DependsOn:[ \t]*\[?([^\]\n]+)/g)) {
    for (const id of (match[1] ?? "").split(",").map((item) => item.trim()).filter(Boolean)) need("DependsOn", id, resources.has(id));
  }
  for (const match of body.matchAll(/(?:!Condition\s+|Condition:[ \t]+|!If\s+\[\s*)([A-Za-z]\w*)/g)) need("Condition", match[1] ?? "", conditions.has(match[1] ?? ""));
  for (const match of body.matchAll(/\$\{([A-Za-z][\w:]*)(?:\.\w+)?\}/g)) need("Sub", match[1] ?? "", value(match[1] ?? ""));
  assert.deepEqual(missing, []);
  assert.ok(resources.has("StateTable") && resources.has("JobsFunction") && resources.has("MaintenanceSchedule"));
});

test("所有 Scheduler 计划显式时区、共用 DLQ 与重试并随 AutomationState 启停；维护任务每小时第 5 分钟", () => {
  const schedules = blocksOfType("AWS::Scheduler::Schedule");
  assert.equal(schedules.length, 22, "不含已删除的 ads-decision 计划（跑飞排查由每日广告批次完成后自动排）；含物流商轨迹、店铺报告（洛杉矶 00:15）与店铺健康、库存健康、SQP");
  assert.equal(resourceBlocks().has("AdsDecisionSchedule"), false);
  for (const [id, block] of schedules) {
    assert.match(block, /ScheduleExpressionTimezone: (Asia\/Shanghai|America\/Los_Angeles)\s*$/m, id);
    assert.match(block, /State: !Ref AutomationState/, id);
    assert.match(block, /DeadLetterConfig: \{ Arn: !GetAtt SchedulerDlq\.Arn \}/, id);
    assert.match(block, /RetryPolicy: \{ MaximumEventAgeInSeconds: 3600, MaximumRetryAttempts: 2 \}/, id);
    assert.match(block, /Input: '\{"taskType":"[a-z-]+","scheduledAt":"<aws\.scheduler\.scheduled-time>"\}'/, id);
  }
  const maintenance = resourceBlocks().get("MaintenanceSchedule") ?? "";
  assert.match(maintenance, /ScheduleExpression: cron\(5 \* \* \* \? \*\)/);
  assert.match(maintenance, /ScheduleExpressionTimezone: Asia\/Shanghai/);
  assert.match(maintenance, /"taskType":"maintenance"/);
  assert.match(resourceBlocks().get("AdsEarlySchedule") ?? "", /ScheduleExpressionTimezone: America\/Los_Angeles/);
  for (const [id, cron, taskType] of [["BuyboxWatchSchedule", "cron\\(20 \\* \\* \\* \\? \\*\\)", "buybox-watch"], ["PayoutsSchedule", "cron\\(30 9 \\* \\* \\? \\*\\)", "payouts"], ["TrafficAlertSchedule", "cron\\(0 16 \\* \\* \\? \\*\\)", "traffic-alert"], ["OfferReconcileSchedule", "cron\\(40 \\* \\* \\* \\? \\*\\)", "offer-reconcile"], ["BrandWatchSchedule", "cron\\(40 10 \\* \\* \\? \\*\\)", "brand-watch"], ["ForwarderTrackingSchedule", "cron\\(50 \\* \\* \\* \\? \\*\\)", "forwarder-tracking"], ["OrderPricesSchedule", "cron\\(15,45 \\* \\* \\* \\? \\*\\)", "order-prices"], ["StoreHealthSchedule", "cron\\(25 \\* \\* \\* \\? \\*\\)", "store-health"], ["InventoryHealthSchedule", "cron\\(15 9 \\* \\* \\? \\*\\)", "inventory-health"], ["SqpSchedule", "cron\\(30 11 \\* \\* \\? \\*\\)", "sqp"]] as const) {
    const block = resourceBlocks().get(id) ?? "";
    assert.match(block, new RegExp(`ScheduleExpression: ${cron}`), id);
    assert.match(block, /ScheduleExpressionTimezone: Asia\/Shanghai/, id);
    assert.match(block, new RegExp(`"taskType":"${taskType}"`), id);
  }
});

test("SQS 事件源只随 AutomationState 启用并逐条报告失败", () => {
  const mappings = blocksOfType("AWS::Lambda::EventSourceMapping");
  assert.equal(mappings.length, 4);
  for (const [id, block] of mappings) {
    assert.match(block, /Enabled: !If \[AutomationEnabled, true, false\]/, id);
    assert.match(block, /FunctionResponseTypes: \[ReportBatchItemFailures\]/, id);
  }
});

test("SQS 消费函数超时不超过源队列可见性超时（订单 1800 秒、AMS 720 秒）", () => {
  const blocks = resourceBlocks();
  assert.match(blocks.get("OrderFunction") ?? "", /Timeout: !If \[AutomationEnabled, 300, 30\]/);
  const amsTimeout = Number(/Timeout: (\d+)/.exec(blocks.get("AmsFunction") ?? "")?.[1]);
  assert.equal(amsTimeout, 300);
  assert.ok(amsTimeout <= 720);
});

test("报价队列由模板在控制区创建：照订单源队列配置（SSE、7 天、可见性 1800 秒、5 次进 DLQ），策略只放行 SP-API 账号；函数超时不超过可见性的 1/6；Jobs 拿到队列 ARN", () => {
  const blocks = resourceBlocks();
  const queue = blocks.get("OfferQueue") ?? "";
  assert.match(queue, /Condition: IsControl/);
  assert.match(queue, /QueueName: !Sub amzshop-\$\{Environment\}-offer-events/);
  assert.match(queue, /MessageRetentionPeriod: 604800/);
  assert.match(queue, /SqsManagedSseEnabled: true/);
  assert.match(queue, /RedrivePolicy: \{ deadLetterTargetArn: !GetAtt OfferDlq\.Arn, maxReceiveCount: 5 \}/);
  const visibility = Number(/VisibilityTimeout: (\d+)/.exec(queue)?.[1]);
  const timeout = Number(/Timeout: (\d+)/.exec(blocks.get("OfferFunction") ?? "")?.[1]);
  assert.equal(visibility, 1800);
  assert.ok(timeout > 0 && timeout * 6 <= visibility, "可见性不少于函数超时的 6 倍");
  const policy = blocks.get("OfferQueuePolicy") ?? "";
  assert.deepEqual([...policy.matchAll(/Principal: (.+)/g)].map((match) => match[1]?.trim()), ['{ AWS: "437568002678" }'], "只放行 SP-API 账号");
  assert.match(policy, /Action: \[sqs:GetQueueAttributes, sqs:SendMessage\]/);
  assert.match(blocks.get("OfferRole") ?? "", /Action: \[sqs:ReceiveMessage, sqs:DeleteMessage, sqs:ChangeMessageVisibility, sqs:GetQueueAttributes\]\s+Resource: !GetAtt OfferQueue\.Arn/);
  assert.match(blocks.get("OfferMapping") ?? "", /EventSourceArn: !GetAtt OfferQueue\.Arn/);
  assert.match(blocks.get("JobsFunction") ?? "", /OFFER_QUEUE_ARN: !GetAtt OfferQueue\.Arn/);
  for (const id of ["OfferDlqAlarm", "OfferQueueAgeAlarm"]) assert.match(blocks.get(id) ?? "", /AlarmActions: \[!Ref AlertTopic\]/, id);
});

test("状态表保留策略、表名与主键不变；订单/AMS 可删状态表指针，Jobs 获得告警主题", () => {
  const blocks = resourceBlocks();
  const table = blocks.get("StateTable") ?? "";
  assert.match(table, /DeletionPolicy: Retain/);
  assert.match(table, /UpdateReplacePolicy: Retain/);
  assert.match(table, /TableName: !Sub amzshop-\$\{Environment\}-state/);
  assert.match(table, /- \{ AttributeName: pk, KeyType: HASH \}\s+- \{ AttributeName: sk, KeyType: RANGE \}/);
  assert.match(table, /TimeToLiveSpecification: \{ AttributeName: expiresAt, Enabled: true \}/);
  for (const role of ["OrderRole", "AmsRole"]) {
    assert.match(blocks.get(role) ?? "", /Action: \[dynamodb:GetItem, dynamodb:PutItem, dynamodb:UpdateItem, dynamodb:DeleteItem\]/, role);
  }
  assert.match(blocks.get("JobsFunction") ?? "", /ALERT_TOPIC_ARN: !Ref AlertTopic/);
  assert.match(blocks.get("JobsRole") ?? "", /Action: sns:Publish\s+Resource: !Ref AlertTopic/);
});

test("PowerShell 脚本兼容 Windows PowerShell 5.1：含非 ASCII 必须带 UTF-8 BOM，不用 PS7 专有 API；deploy 走 powershell", async () => {
  const directory = path.join(root, "scripts");
  const scripts = (await readdir(directory)).filter((name) => name.endsWith(".ps1"));
  assert.ok(scripts.includes("deploy.ps1") && scripts.includes("cutover.ps1"));
  for (const name of scripts) {
    const bytes = await readFile(path.join(directory, name));
    const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    if (bytes.some((byte) => byte > 0x7f)) assert.ok(hasBom, `${name} 含非 ASCII 字符但缺少 UTF-8 BOM，Windows PowerShell 5.1 会按 ANSI 代码页误读`);
    assert.doesNotMatch(bytes.toString("utf8"), /utf8NoBOM|\[Convert\]::ToHexString/i, name);
  }
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.equal(packageJson.scripts.deploy, "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/deploy.ps1");
});
