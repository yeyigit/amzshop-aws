[CmdletBinding()]
param([string]$Region = "us-east-1")

$ErrorActionPreference = "Stop"
$env:AWS_RETRY_MODE = "standard"
$env:AWS_MAX_ATTEMPTS = "5"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$artifacts = Join-Path $repo "artifacts"
$suffix = (Get-Date).ToUniversalTime().ToString("yyyyMMddHHmmss")
$name = "amzshop-acceptance-scheduler-$suffix"
$role = $name
$policy = $name
$queueUrl = ""
$scheduleCreated = $false
$failure = $null
$tempFiles = @()
$utf8 = New-Object System.Text.UTF8Encoding($false)
$evidence = [ordered]@{ testedAt = (Get-Date).ToUniversalTime().ToString("o"); region = $Region; schedule = $name; cleaned = $false }

function AwsJson([string[]]$Arguments) {
  $raw = & aws @Arguments --region $Region --no-cli-pager --output json
  if ($LASTEXITCODE -ne 0) { throw "AWS CLI 失败: $($Arguments[0..([Math]::Min(2, $Arguments.Count - 1))] -join ' ')" }
  if (-not $raw) { return $null }
  return $raw | ConvertFrom-Json
}

function WriteJson([string]$Label, [object]$Value) {
  $path = Join-Path $artifacts "$Label-$suffix.json"
  [IO.File]::WriteAllText($path, ($Value | ConvertTo-Json -Depth 10), $utf8)
  $script:tempFiles += $path
  return $path
}

try {
  $queueUrl = (AwsJson @("sqs", "create-queue", "--queue-name", $name, "--attributes", "MessageRetentionPeriod=3600,SqsManagedSseEnabled=true")).QueueUrl
  $queueArn = (AwsJson @("sqs", "get-queue-attributes", "--queue-url", $queueUrl, "--attribute-names", "QueueArn")).Attributes.QueueArn
  $trustFile = WriteJson "scheduler-trust" @{ Version = "2012-10-17"; Statement = @(@{ Effect = "Allow"; Principal = @{ Service = "scheduler.amazonaws.com" }; Action = "sts:AssumeRole" }) }
  $roleArn = (AwsJson @("iam", "create-role", "--role-name", $role, "--assume-role-policy-document", "file://$trustFile")).Role.Arn
  $policyFile = WriteJson "scheduler-policy" @{ Version = "2012-10-17"; Statement = @(@{ Effect = "Allow"; Action = "sqs:SendMessage"; Resource = $queueArn }) }
  & aws iam put-role-policy --role-name $role --policy-name $policy --policy-document "file://$policyFile" --region $Region --no-cli-pager
  if ($LASTEXITCODE -ne 0) { throw "临时 Scheduler 角色策略创建失败。" }
  Start-Sleep -Seconds 10

  $scheduledFor = [DateTimeOffset]::UtcNow.AddMinutes(2).ToString("yyyy-MM-ddTHH:mm:ss")
  $payload = @{ acceptanceType = "scheduler-isolated"; token = $suffix } | ConvertTo-Json -Compress
  $targetFile = WriteJson "scheduler-target" @{ Arn = $queueArn; RoleArn = $roleArn; Input = $payload }
  AwsJson @("scheduler", "create-schedule", "--name", $name, "--schedule-expression", "at($scheduledFor)", "--schedule-expression-timezone", "UTC", "--flexible-time-window", "Mode=OFF", "--action-after-completion", "DELETE", "--target", "file://$targetFile") | Out-Null
  $scheduleCreated = $true

  $deadline = [DateTimeOffset]::UtcNow.AddMinutes(5)
  $message = $null
  do {
    $response = AwsJson @("sqs", "receive-message", "--queue-url", $queueUrl, "--wait-time-seconds", "20", "--max-number-of-messages", "1")
    if ($response.Messages) { $message = @($response.Messages)[0]; break }
  } while ([DateTimeOffset]::UtcNow -lt $deadline)
  if (-not $message) { throw "隔离 Scheduler 未在 5 分钟内向临时队列投递。" }
  $received = $message.Body | ConvertFrom-Json
  if ($received.acceptanceType -ne "scheduler-isolated" -or $received.token -ne $suffix) { throw "隔离 Scheduler 投递内容不匹配。" }
  & aws sqs delete-message --queue-url $queueUrl --receipt-handle $message.ReceiptHandle --region $Region --no-cli-pager
  if ($LASTEXITCODE -ne 0) { throw "临时消息确认失败。" }
  $evidence.scheduledForUtc = "$scheduledFor`Z"
  $evidence.receivedAt = [DateTimeOffset]::UtcNow.ToString("o")
  $evidence.queueArn = $queueArn
  $evidence.messageId = $message.MessageId
  $evidence.payload = @{ acceptanceType = $received.acceptanceType; token = $received.token }
} catch {
  $failure = $_.Exception.Message
} finally {
  $ErrorActionPreference = "Continue"
  if ($scheduleCreated) { & aws scheduler delete-schedule --name $name --region $Region --no-cli-pager 2>$null | Out-Null }
  if ($queueUrl) { & aws sqs delete-queue --queue-url $queueUrl --region $Region --no-cli-pager 2>$null | Out-Null }
  & aws iam delete-role-policy --role-name $role --policy-name $policy --region $Region --no-cli-pager 2>$null | Out-Null
  & aws iam delete-role --role-name $role --region $Region --no-cli-pager 2>$null | Out-Null
  foreach ($path in $tempFiles) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
  & aws scheduler get-schedule --name $name --region $Region --no-cli-pager 2>$null | Out-Null; $scheduleGone = $LASTEXITCODE -ne 0
  & aws iam get-role --role-name $role --region $Region --no-cli-pager 2>$null | Out-Null; $roleGone = $LASTEXITCODE -ne 0
  & aws sqs get-queue-url --queue-name $name --region $Region --no-cli-pager 2>$null | Out-Null; $queueGone = $LASTEXITCODE -ne 0
  $ErrorActionPreference = "Stop"
  $evidence.cleaned = $scheduleGone -and $roleGone -and $queueGone
  if (-not $evidence.cleaned -and -not $failure) { $failure = "临时 Scheduler 资源清理未完成。" }
  if ($failure) { $evidence.failure = $failure }
  $path = Join-Path $artifacts "scheduler-acceptance-$suffix.json"
  [IO.File]::WriteAllText($path, ($evidence | ConvertTo-Json -Depth 10), $utf8)
}

if ($failure) { throw $failure }
Write-Host "Scheduler 隔离投递验收通过: $path"
