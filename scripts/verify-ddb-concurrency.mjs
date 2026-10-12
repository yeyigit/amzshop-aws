import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

const region = process.argv[2] ?? "us-east-1";
const table = process.argv[3] ?? "amzshop-prod-state";
const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const key = { pk: "ACCEPTANCE#DDB", sk: randomUUID() };
try {
  const attempts = await Promise.allSettled(["owner-a", "owner-b"].map((owner) => client.send(new PutCommand({
    TableName: table,
    Item: { ...key, owner, createdAt: new Date().toISOString() },
    ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
  }))));
  const fulfilled = attempts.filter((item) => item.status === "fulfilled");
  const rejected = attempts.filter((item) => item.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]?.reason?.name, "ConditionalCheckFailedException");
  const stored = await client.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }));
  assert.ok(stored.Item?.owner === "owner-a" || stored.Item?.owner === "owner-b");
  console.log(JSON.stringify({ region, table, contenders: 2, winners: 1, conditionalFailures: 1, stored: true }));
} finally {
  await client.send(new DeleteCommand({ TableName: table, Key: key }));
}
