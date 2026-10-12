[CmdletBinding()]
param([string]$Region = "us-east-1", [string]$Environment = "prod")

$ErrorActionPreference = "Stop"
$env:AWS_RETRY_MODE = "standard"
$env:AWS_MAX_ATTEMPTS = "5"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$artifacts = Join-Path $repo "artifacts"
$suffix = (Get-Date).ToUniversalTime().ToString("yyyyMMddHHmmss")
$function = "amzshop-acceptance-ams-$suffix"
$role = "amzshop-acceptance-ams-$suffix"
$sourceName = "amzshop-acceptance-source-$suffix"
$dlqName = "amzshop-acceptance-dlq-$suffix"
$policyName = "amzshop-acceptance-$suffix"
$mappingUuid = ""
$sourceUrl = ""
$dlqUrl = ""
$logGroup = "/aws/lambda/$function"
$failure = $null
$utf8 = New-Object System.Text.UTF8Encoding($false)
$evidence = [ordered]@{ testedAt = (Get-Date).ToUniversalTime().ToString("o"); region = $Region; function = $function; cleaned = $false }

function WriteText([string]$Path, [string]$Text) { [IO.File]::WriteAllText($Path, $Text, $utf8) }

function AwsJson([string[]]$Arguments) {
  $raw = & aws @Arguments --region $Region --no-cli-pager --output json
  if ($LASTEXITCODE -ne 0) { throw "AWS CLI 失败: $($Arguments[0..([Math]::Min(2, $Arguments.Count - 1))] -join ' ')" }
  if (-not $raw) { return $null }
  return $raw | ConvertFrom-Json
}

function QueueState([string]$Url) {
  return (AwsJson @("sqs", "get-queue-attributes", "--queue-url", $Url, "--attribute-names", "ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible", "QueueArn")).Attributes
}

try {
  $identity = AwsJson @("sts", "get-caller-identity")
  $dlqUrl = (AwsJson @("sqs", "create-queue", "--queue-name", $dlqName, "--attributes", "MessageRetentionPeriod=1209600,SqsManagedSseEnabled=true")).QueueUrl
  $sourceUrl = (AwsJson @("sqs", "create-queue", "--queue-name", $sourceName, "--attributes", "VisibilityTimeout=10,MessageRetentionPeriod=3600,SqsManagedSseEnabled=true")).QueueUrl
  $dlqArn = (QueueState $dlqUrl).QueueArn
  $sourceArn = (QueueState $sourceUrl).QueueArn
  $redriveFile = Join-Path $artifacts "acceptance-redrive-$suffix.json"
  WriteText $redriveFile (@{ RedrivePolicy = (@{ deadLetterTargetArn = $dlqArn; maxReceiveCount = "2" } | ConvertTo-Json -Compress) } | ConvertTo-Json -Compress)
  & aws sqs set-queue-attributes --queue-url $sourceUrl --attributes "file://$redriveFile" --region $Region --no-cli-pager
  if ($LASTEXITCODE -ne 0) { throw "临时队列 RedrivePolicy 设置失败。" }

  $trustFile = Join-Path $artifacts "acceptance-trust-$suffix.json"
  WriteText $trustFile (@{ Version = "2012-10-17"; Statement = @(@{ Effect = "Allow"; Principal = @{ Service = "lambda.amazonaws.com" }; Action = "sts:AssumeRole" }) } | ConvertTo-Json -Depth 8)
  $roleArn = (AwsJson @("iam", "create-role", "--role-name", $role, "--assume-role-policy-document", "file://$trustFile")).Role.Arn
  $runtimePolicyFile = Join-Path $artifacts "acceptance-role-$suffix.json"
  WriteText $runtimePolicyFile (@{
    Version = "2012-10-17"
    Statement = @(
      @{ Effect = "Allow"; Action = @("logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"); Resource = "arn:aws:logs:$Region`:$($identity.Account):log-group:$logGroup`:*" },
      @{ Effect = "Allow"; Action = @("ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"); Resource = "arn:aws:ssm:$Region`:$($identity.Account):parameter/amzshop/$Environment/*" },
      @{ Effect = "Allow"; Action = @("sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes"); Resource = $sourceArn }
    )
  } | ConvertTo-Json -Depth 10)
  & aws iam put-role-policy --role-name $role --policy-name $policyName --policy-document "file://$runtimePolicyFile" --region $Region --no-cli-pager
  if ($LASTEXITCODE -ne 0) { throw "临时角色策略创建失败。" }
  Start-Sleep -Seconds 10

  $environmentFile = Join-Path $artifacts "acceptance-env-$suffix.json"
  WriteText $environmentFile (@{ Variables = @{ CONTROL_REGION = $Region; PARAMETER_PREFIX = "/amzshop/$Environment/"; STATE_TABLE_NAME = "amzshop-$Environment-state" } } | ConvertTo-Json -Depth 5)
  $zip = Join-Path $artifacts "ams-$Region.zip"
  AwsJson @("lambda", "create-function", "--function-name", $function, "--runtime", "nodejs24.x", "--architectures", "arm64", "--handler", "index.handler", "--role", $roleArn, "--timeout", "5", "--memory-size", "256", "--environment", "file://$environmentFile", "--zip-file", "fileb://$zip") | Out-Null
  & aws lambda wait function-active-v2 --function-name $function --region $Region --no-cli-pager
  if ($LASTEXITCODE -ne 0) { throw "临时 Lambda 未就绪。" }
  $mappingUuid = (AwsJson @("lambda", "create-event-source-mapping", "--function-name", $function, "--event-source-arn", $sourceArn, "--batch-size", "2", "--function-response-types", "ReportBatchItemFailures", "--scaling-config", "MaximumConcurrency=2")).UUID
  $mappingState = ""
  for ($index = 0; $index -lt 24; $index++) {
    Start-Sleep -Seconds 5
    $mappingState = (AwsJson @("lambda", "get-event-source-mapping", "--uuid", $mappingUuid)).State
    if ($mappingState -eq "Enabled") { break }
    if ($mappingState -eq "Failed") { throw "临时 event source mapping 创建失败。" }
  }
  if ($mappingState -ne "Enabled") { throw "临时 event source mapping 未就绪。" }

  $ignoredFile = Join-Path $artifacts "acceptance-ignored-$suffix.json"
  WriteText $ignoredFile '{"dataset_id":"not-budget-usage"}'
  $ignoredId = (AwsJson @("sqs", "send-message", "--queue-url", $sourceUrl, "--message-body", "file://$ignoredFile")).MessageId
  $failedId = (AwsJson @("sqs", "send-message", "--queue-url", $sourceUrl, "--message-body", "not-json")).MessageId

  $deadline = (Get-Date).AddMinutes(3)
  do {
    Start-Sleep -Seconds 5
    $source = QueueState $sourceUrl
    $dlq = QueueState $dlqUrl
  } while ((Get-Date) -lt $deadline -and -not ([int]$source.ApproximateNumberOfMessages -eq 0 -and [int]$source.ApproximateNumberOfMessagesNotVisible -eq 0 -and [int]$dlq.ApproximateNumberOfMessages -eq 1))
  if ([int]$source.ApproximateNumberOfMessages -ne 0 -or [int]$source.ApproximateNumberOfMessagesNotVisible -ne 0 -or [int]$dlq.ApproximateNumberOfMessages -ne 1) { throw "临时队列未达到 source=0、DLQ=1。" }
  Start-Sleep -Seconds 5
  $logs = (AwsJson @("logs", "filter-log-events", "--log-group-name", $logGroup, "--start-time", ([DateTimeOffset]::UtcNow.AddMinutes(-5).ToUnixTimeMilliseconds()))).events
  $ignoredLogs = @($logs | Where-Object { $_.message -like "*$ignoredId*" -and $_.message -like "*ams_ignored*" }).Count
  $failedLogs = @($logs | Where-Object { $_.message -like "*$failedId*" -and $_.message -like "*ams_failed*" }).Count
  if ($ignoredLogs -lt 1 -or $failedLogs -lt 2) { throw "CloudWatch 日志未证明成功项与失败项独立处理。" }
  $evidence.source = @{ visible = [int]$source.ApproximateNumberOfMessages; inFlight = [int]$source.ApproximateNumberOfMessagesNotVisible }
  $evidence.dlq = @{ visible = [int]$dlq.ApproximateNumberOfMessages }
  $evidence.messages = @{ ignoredMessageId = $ignoredId; failedMessageId = $failedId; ignoredLogCount = $ignoredLogs; failedLogCount = $failedLogs }
  $evidence.mapping = @{ functionResponseTypes = @("ReportBatchItemFailures"); maximumConcurrency = 2 }
} catch {
  $failure = $_.Exception.Message
} finally {
  $ErrorActionPreference = "Continue"
  if ($mappingUuid) {
    for ($index = 0; $index -lt 24; $index++) {
      $current = & aws lambda get-event-source-mapping --uuid $mappingUuid --region $Region --no-cli-pager --output json 2>$null
      if ($LASTEXITCODE -ne 0) { break }
      $state = ($current | ConvertFrom-Json).State
      if ($state -ne "Deleting") { & aws lambda delete-event-source-mapping --uuid $mappingUuid --region $Region --no-cli-pager --output json 2>$null | Out-Null }
      Start-Sleep -Seconds 5
    }
  }
  & aws lambda delete-function --function-name $function --region $Region --no-cli-pager 2>$null | Out-Null
  & aws logs delete-log-group --log-group-name $logGroup --region $Region --no-cli-pager 2>$null | Out-Null
  if ($sourceUrl) { & aws sqs delete-queue --queue-url $sourceUrl --region $Region --no-cli-pager 2>$null | Out-Null }
  if ($dlqUrl) { & aws sqs delete-queue --queue-url $dlqUrl --region $Region --no-cli-pager 2>$null | Out-Null }
  & aws iam delete-role-policy --role-name $role --policy-name $policyName --region $Region --no-cli-pager 2>$null | Out-Null
  & aws iam delete-role --role-name $role --region $Region --no-cli-pager 2>$null | Out-Null
  & aws lambda get-function --function-name $function --region $Region --no-cli-pager 2>$null | Out-Null; $functionGone = $LASTEXITCODE -ne 0
  & aws iam get-role --role-name $role --region $Region --no-cli-pager 2>$null | Out-Null; $roleGone = $LASTEXITCODE -ne 0
  $mappingGone = $true
  if ($mappingUuid) { & aws lambda get-event-source-mapping --uuid $mappingUuid --region $Region --no-cli-pager 2>$null | Out-Null; $mappingGone = $LASTEXITCODE -ne 0 }
  $ErrorActionPreference = "Stop"
  $evidence.cleaned = $functionGone -and $roleGone -and $mappingGone
  if (-not $evidence.cleaned -and -not $failure) { $failure = "临时资源清理未完成。" }
  if ($failure) { $evidence.failure = $failure }
  $path = Join-Path $artifacts "sqs-partial-acceptance-$suffix.json"
  WriteText $path ($evidence | ConvertTo-Json -Depth 10)
}

if ($failure) { throw $failure }
Write-Host "SQS 部分失败与 DLQ 验收通过: $path"
