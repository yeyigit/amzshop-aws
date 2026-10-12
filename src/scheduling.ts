import { ConflictException, CreateScheduleCommand, GetScheduleCommand, SchedulerClient } from "@aws-sdk/client-scheduler";
import type { JobEvent } from "./types.js";
import { sha256 } from "./util.js";

const region = process.env.CONTROL_REGION;
const scheduler = new SchedulerClient(region ? { region } : {});

export async function ensureOneTimeSchedule(event: JobEvent, when: Date): Promise<string> {
  const targetArn = process.env.JOBS_FUNCTION_ARN;
  const roleArn = process.env.SCHEDULER_ROLE_ARN;
  const dlqArn = process.env.SCHEDULER_DLQ_ARN;
  const groupName = process.env.SCHEDULER_GROUP_NAME ?? "amzshop-prod";
  if (!targetArn || !roleArn || !dlqArn) throw new Error("续跑调度缺少 JOBS_FUNCTION_ARN、SCHEDULER_ROLE_ARN 或 SCHEDULER_DLQ_ARN。 ");
  const identity = `${event.taskType}|${event.taskId ?? ""}|${event.scheduledAt ?? ""}|${when.toISOString()}`;
  const name = `amzshop-${event.taskType.replace(/[^A-Za-z0-9-_]/g, "-").slice(0, 30)}-${sha256(identity).slice(0, 16)}`;
  try {
    await scheduler.send(new CreateScheduleCommand({
      Name: name,
      GroupName: groupName,
      ScheduleExpression: `at(${when.toISOString().replace(/\.\d{3}Z$/, "")})`,
      FlexibleTimeWindow: { Mode: "OFF" },
      ActionAfterCompletion: "DELETE",
      Target: {
        Arn: targetArn,
        RoleArn: roleArn,
        Input: JSON.stringify(event),
        DeadLetterConfig: { Arn: dlqArn },
        RetryPolicy: { MaximumEventAgeInSeconds: 3600, MaximumRetryAttempts: 2 },
      },
      State: "ENABLED",
      Description: `AMZShop ${event.taskType} 可靠续跑`,
    }));
  } catch (error) {
    if (!(error instanceof ConflictException)) throw error;
    const existing = await scheduler.send(new GetScheduleCommand({ Name: name, GroupName: groupName }));
    if (existing.Target?.Arn !== targetArn || existing.Target.RoleArn !== roleArn || existing.Target.Input !== JSON.stringify(event) || existing.Target.DeadLetterConfig?.Arn !== dlqArn) {
      throw new Error(`续跑计划 ${name} 已存在但目标或任务内容不同。`);
    }
  }
  return name;
}
