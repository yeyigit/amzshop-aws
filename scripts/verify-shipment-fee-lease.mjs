import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const region = process.argv[2] ?? "us-east-1";
const table = process.argv[3] ?? "amzshop-prod-state";
const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const key = { pk: "LEASE#shipment-fee", sk: `acceptance-${randomUUID()}` };
const ownerA = randomUUID();
const ownerB = randomUUID();
const acquire = (owner) => client.send(new UpdateCommand({
  TableName: table, Key: key,
  UpdateExpression: "SET leaseOwner = :owner, leaseExpiresAt = :expires",
  ConditionExpression: "attribute_not_exists(leaseExpiresAt) OR leaseExpiresAt < :now OR leaseOwner = :owner",
  ExpressionAttributeValues: { ":owner": owner, ":expires": Date.now() + 60_000, ":now": Date.now() },
}));
try {
  const attempts = await Promise.allSettled([acquire(ownerA), acquire(ownerB)]);
  assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
  const loser = attempts.find((result) => result.status === "rejected");
  assert.equal(loser?.reason?.name, "ConditionalCheckFailedException");
  const winner = attempts[0]?.status === "fulfilled" ? ownerA : ownerB;
  const other = winner === ownerA ? ownerB : ownerA;
  await assert.rejects(client.send(new DeleteCommand({ TableName: table, Key: key, ConditionExpression: "leaseOwner = :owner", ExpressionAttributeValues: { ":owner": other } })), { name: "ConditionalCheckFailedException" });
  await client.send(new DeleteCommand({ TableName: table, Key: key, ConditionExpression: "leaseOwner = :owner", ExpressionAttributeValues: { ":owner": winner } }));
  await acquire(other);
  console.log(JSON.stringify({ region, table, contenders: 2, winners: 1, wrongOwnerCannotRelease: true, nextOwnerAfterRelease: true }));
} finally {
  await client.send(new DeleteCommand({ TableName: table, Key: key }));
}
