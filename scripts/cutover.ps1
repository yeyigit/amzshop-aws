[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet("Audit", "Activate", "Verify", "PauseAws", "AlertTest")][string]$Phase,
  [Parameter(Mandatory = $true)][string]$Region,
  [Parameter(Mandatory = $true)][string]$OrderQueueArn,
  [Parameter(Mandatory = $true)][string]$OrderQueueUrl,
  [Parameter(Mandatory = $true)][string]$AmsQueueArn,
  [Parameter(Mandatory = $true)][string]$AmsQueueUrl,
  [string]$PricingQueueArn = "",
  [string]$PricingQueueUrl = "",
  [string]$StackName = "amzshop-prod-control",
  [string]$OrderStackName = "",
  [string]$Environment = "prod",
  [string]$Profile = "",
  [string]$MigrationReport = "",
  [string]$GasStoppedProof = ""
)

# 兼容 Windows PowerShell 5.1：本文件须保存为 UTF-8 with BOM，不用 PowerShell 7 专有语法或 API。
$ErrorActionPreference = "Stop"
$env:AWS_RETRY_MODE = "standard"
$env:AWS_MAX_ATTEMPTS = "5"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$artifactRoot = Join-Path $repo "artifacts"
New-Item -ItemType Directory -Force -Path $artifactRoot | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)
$invariant = [Globalization.CultureInfo]::InvariantCulture
$aws = (Get-Command aws.exe -ErrorAction SilentlyContinue).Source
if (-not $aws) { $aws = "C:\Program Files\Amazon\AWSCLIV2\aws.exe" }
if (-not (Test-Path -LiteralPath $aws)) { throw "未找到官方 AWS CLI。" }

function Get-Common([string]$TargetRegion) {
  $result = @("--region", $TargetRegion, "--no-cli-pager")
  if ($Profile) { $result += @("--profile", $Profile) }
  return $result
}

function Invoke-AwsJson([string]$TargetRegion, [string[]]$Arguments) {
  $raw = & $aws @Arguments @(Get-Common $TargetRegion) --output json
  if ($LASTEXITCODE -ne 0) { throw "AWS CLI 失败: $($Arguments -join ' ')" }
  if (-not $raw) { return $null }
  return ($raw -join "`n") | ConvertFrom-Json
}

function Write-Utf8([string]$Path, [string]$Text) { [IO.File]::WriteAllText($Path, $Text, $utf8) }

function Read-JsonFile([string]$Path) { return [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8) | ConvertFrom-Json }

function Get-StackState([string]$TargetRegion, [string]$Name) {
  $stack = Invoke-AwsJson $TargetRegion @("cloudformation", "describe-stacks", "--stack-name", $Name)
  $outputs = @{}
  foreach ($item in $stack.Stacks[0].Outputs) { $outputs[$item.OutputKey] = $item.OutputValue }
  return @{ stack = $stack.Stacks[0]; outputs = $outputs; region = $TargetRegion }
}

function Get-QueueState([string]$TargetRegion, [string]$Url) {
  return (Invoke-AwsJson $TargetRegion @("sqs", "get-queue-attributes", "--queue-url", $Url, "--attribute-names", "All")).Attributes
}

function Write-Evidence([string]$Name, [object]$Value) {
  $path = Join-Path $artifactRoot $Name
  Write-Utf8 $path (ConvertTo-Json -InputObject $Value -Depth 30)
  return $path
}

function ConvertTo-UtcInstant([object]$Value) {
  if ($Value -is [DateTimeOffset]) { return $Value.ToUniversalTime() }
  if ($Value -is [DateTime]) {
    if ($Value.Kind -eq [DateTimeKind]::Unspecified) { throw "计划时间缺少时区: $Value" }
    return ([DateTimeOffset]$Value).ToUniversalTime()
  }
  $text = [string]$Value
  if ($text -notmatch "(Z|[+-]\d{2}:?\d{2})$") { throw "计划时间必须带 Z 或 UTC 偏移: $text" }
  return [DateTimeOffset]::Parse($text, $invariant).ToUniversalTime()
}

function Ensure-OneTimeSchedule([object]$Scheduled, [object]$Outputs) {
  $when = ConvertTo-UtcInstant $Scheduled.when
  if ($when -le [DateTimeOffset]::UtcNow) { $when = [DateTimeOffset]::UtcNow.AddMinutes(1) }
  $whenIso = $when.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", $invariant)
  $atUtc = $when.ToString("yyyy-MM-dd'T'HH:mm:ss", $invariant)
  $scheduledEvent = $Scheduled.event
  $scheduleIdentity = "$($scheduledEvent.taskType)|$($scheduledEvent.taskId)|$($scheduledEvent.scheduledAt)|$whenIso"
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  try { $hash = (-join ($algorithm.ComputeHash($utf8.GetBytes($scheduleIdentity)) | ForEach-Object { $_.ToString("x2") })).Substring(0, 16) }
  finally { $algorithm.Dispose() }
  $taskType = ([string]$scheduledEvent.taskType -replace "[^A-Za-z0-9-_]", "-")
  if ($taskType.Length -gt 30) { $taskType = $taskType.Substring(0, 30) }
  $name = "amzshop-$taskType-$hash"
  $payload = ConvertTo-Json -InputObject $scheduledEvent -Depth 10 -Compress
  $target = [ordered]@{ Arn = $Outputs.JobsFunctionArn; RoleArn = $Outputs.SchedulerRoleArn; Input = $payload; DeadLetterConfig = @{ Arn = $Outputs.SchedulerDlqArn }; RetryPolicy = @{ MaximumEventAgeInSeconds = 3600; MaximumRetryAttempts = 2 } }
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try { $raw = & $aws scheduler get-schedule --name $name --group-name $Outputs.SchedulerGroupName @(Get-Common $Region) --output json 2>$null; $code = $LASTEXITCODE }
  finally { $ErrorActionPreference = $previous }
  if ($code -eq 0) {
    $existing = ($raw -join "`n") | ConvertFrom-Json
    if ($existing.Target.Arn -ne $target.Arn -or $existing.Target.RoleArn -ne $target.RoleArn -or $existing.Target.Input -ne $payload) { throw "一次性计划 $name 已存在但目标不一致。" }
    return @{ name = $name; when = $whenIso; existing = $true }
  }
  $targetFile = Join-Path $artifactRoot "schedule-$name-target.json"
  Write-Utf8 $targetFile (ConvertTo-Json -InputObject $target -Depth 10 -Compress)
  Invoke-AwsJson $Region @("scheduler", "create-schedule", "--name", $name, "--group-name", $Outputs.SchedulerGroupName, "--schedule-expression", "at($atUtc)", "--schedule-expression-timezone", "UTC", "--flexible-time-window", "Mode=OFF", "--action-after-completion", "DELETE", "--state", "ENABLED", "--description", "AMZShop 迁移后可靠续跑", "--target", "file://$targetFile") | Out-Null
  return @{ name = $name; when = $whenIso; existing = $false }
}

function Set-AutomationStateOnly([string]$TargetRegion, [object]$Stack, [string]$State) {
  $name = $Stack.StackName
  $before = ($Stack.Parameters | Where-Object { $_.ParameterKey -eq "AutomationState" } | Select-Object -First 1).ParameterValue
  if ($before -eq $State) { return [ordered]@{ stack = $name; region = $TargetRegion; before = $before; after = $State; changed = $false } }
  $parameters = @($Stack.Parameters | ForEach-Object {
    if ($_.ParameterKey -eq "AutomationState") { [ordered]@{ ParameterKey = "AutomationState"; ParameterValue = $State } }
    else { [ordered]@{ ParameterKey = $_.ParameterKey; UsePreviousValue = $true } }
  })
  $file = Join-Path $artifactRoot "automation-state-$name.json"
  Write-Utf8 $file (ConvertTo-Json -InputObject $parameters -Depth 5 -Compress)
  Invoke-AwsJson $TargetRegion @("cloudformation", "update-stack", "--stack-name", $name, "--use-previous-template", "--capabilities", "CAPABILITY_NAMED_IAM", "--parameters", "file://$file") | Out-Null
  & $aws cloudformation wait stack-update-complete --stack-name $name @(Get-Common $TargetRegion)
  if ($LASTEXITCODE -ne 0) { throw "栈 $name 未完成更新，请查看 CloudFormation 事件。" }
  return [ordered]@{ stack = $name; region = $TargetRegion; before = $before; after = $State; changed = $true }
}

if ([bool]$PricingQueueArn -ne [bool]$PricingQueueUrl) { throw "Pricing Queue ARN 与 URL 必须同时提供或同时留空。" }
$orderRegion = ($OrderQueueArn -split ":")[3]
$amsRegion = ($AmsQueueArn -split ":")[3]
if (-not $orderRegion -or $amsRegion -ne $Region) { throw "队列区域与控制区参数不一致。" }
if ($PricingQueueArn -and ($PricingQueueArn -split ":")[3] -ne $Region) { throw "Pricing 队列必须位于控制区域。" }
if (-not $OrderStackName) { $OrderStackName = "amzshop-$Environment-order-$orderRegion" }

$identity = Invoke-AwsJson $Region @("sts", "get-caller-identity")
$control = Get-StackState $Region $StackName
$order = Get-StackState $orderRegion $OrderStackName

if ($Phase -eq "Audit" -or $Phase -eq "Verify") {
  $schedules = Invoke-AwsJson $Region @("scheduler", "list-schedules", "--group-name", $control.outputs.SchedulerGroupName)
  $orderMappings = Invoke-AwsJson $orderRegion @("lambda", "list-event-source-mappings", "--event-source-arn", $OrderQueueArn)
  $amsMappings = Invoke-AwsJson $Region @("lambda", "list-event-source-mappings", "--event-source-arn", $AmsQueueArn)
  $pricingMappings = if ($PricingQueueArn) { Invoke-AwsJson $Region @("lambda", "list-event-source-mappings", "--event-source-arn", $PricingQueueArn) } else { $null }
  $controlSubscriptions = Invoke-AwsJson $Region @("sns", "list-subscriptions-by-topic", "--topic-arn", $control.outputs.AlertTopicArn)
  $orderSubscriptions = Invoke-AwsJson $orderRegion @("sns", "list-subscriptions-by-topic", "--topic-arn", $order.outputs.AlertTopicArn)
  $gasProof = if ($GasStoppedProof -and (Test-Path -LiteralPath $GasStoppedProof)) { Read-JsonFile $GasStoppedProof } else { $null }
  $evidence = [ordered]@{
    checkedAt = (Get-Date).ToUniversalTime().ToString("o"); phase = $Phase; accountId = $identity.Account; callerArn = $identity.Arn
    controlRegion = $Region; orderRegion = $orderRegion; controlStackStatus = $control.stack.StackStatus; orderStackStatus = $order.stack.StackStatus
    automationState = ($control.stack.Parameters | Where-Object ParameterKey -eq "AutomationState").ParameterValue
    orderQueue = Get-QueueState $orderRegion $OrderQueueUrl; amsQueue = Get-QueueState $Region $AmsQueueUrl; pricingQueue = if ($PricingQueueUrl) { Get-QueueState $Region $PricingQueueUrl } else { $null }
    orderMappings = $orderMappings.EventSourceMappings; amsMappings = $amsMappings.EventSourceMappings; pricingMappings = if ($pricingMappings) { $pricingMappings.EventSourceMappings } else { @() }
    schedules = $schedules.Schedules; controlAlertSubscriptions = $controlSubscriptions.Subscriptions; orderAlertSubscriptions = $orderSubscriptions.Subscriptions
    gasProof = $gasProof
  }
  $path = Write-Evidence "cutover-$($Phase.ToLower())-$((Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')).json" $evidence
  Write-Host "$Phase 证据: $path"
  return
}

if ($Phase -eq "PauseAws") {
  $results = @()
  $pauseFailures = @()
  foreach ($item in @(@{ region = $orderRegion; stack = $order.stack }, @{ region = $Region; stack = $control.stack })) {
    try { $results += Set-AutomationStateOnly $item.region $item.stack "DISABLED" }
    catch {
      $pauseFailures += "$($item.stack.StackName): $($_.Exception.Message)"
      $results += [ordered]@{ stack = $item.stack.StackName; region = $item.region; error = $_.Exception.Message }
    }
  }
  $path = Write-Evidence "cutover-pauseaws-$((Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')).json" ([ordered]@{ pausedAt = (Get-Date).ToUniversalTime().ToString("o"); callerArn = $identity.Arn; stacks = $results; scope = "只改 AutomationState，沿用已部署模板与函数代码；代码创建的一次性续跑计划不受影响。" })
  if ($pauseFailures.Count) { throw "部分栈暂停失败（证据 $path）: $($pauseFailures -join '；')" }
  Write-Host "AWS 两区自动入口已暂停（只改 AutomationState，未发布代码），证据: $path；未恢复任何 GAS 入口。修复后用 npm run deploy 并显式 -AutomationState ENABLED 恢复。"
  return
}

if ($Phase -eq "AlertTest") {
  $message = "AMZShop AWS 邮件告警链路验收。此消息不代表真实订单、退款或邀评。UTC=$((Get-Date).ToUniversalTime().ToString('o'))"
  $results = @()
  foreach ($target in @(@{ region = $Region; outputs = $control.outputs; role = "control" }, @{ region = $orderRegion; outputs = $order.outputs; role = "order" })) {
    if (-not $target.outputs.AlertDeliveryFailureTopicArn) { throw "告警失败主题 ARN 缺失；请先发布包含该输出的 CloudFormation 模板。" }
    $main = Invoke-AwsJson $target.region @("sns", "publish", "--topic-arn", $target.outputs.AlertTopicArn, "--subject", "AMZShop main email alert acceptance", "--message", $message)
    $failure = Invoke-AwsJson $target.region @("sns", "publish", "--topic-arn", $target.outputs.AlertDeliveryFailureTopicArn, "--subject", "AMZShop failure email alert acceptance", "--message", $message)
    $results += @{ role = $target.role; region = $target.region; mainMessageId = $main.MessageId; failureMessageId = $failure.MessageId }
  }
  $path = Write-Evidence "alert-test-$((Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')).json" @{ testedAt = (Get-Date).ToUniversalTime().ToString("o"); results = $results; expectedDelivery = "email-only" }
  Write-Host "两区主/失败告警邮件主题均已发布验收消息，证据: $path"
  return
}

if (-not $MigrationReport -or -not (Test-Path -LiteralPath $MigrationReport)) { throw "Activate 必须提供已应用的 migration-report.json。" }
if (-not $GasStoppedProof -or -not (Test-Path -LiteralPath $GasStoppedProof)) { throw "Activate 必须提供 awsMigrationVerifyStopped() 的 JSON 证明。" }
$migration = Read-JsonFile $MigrationReport
$gas = Read-JsonFile $GasStoppedProof
if ($migration.applied -ne $true) { throw "迁移报告不是 applied=true。" }
if ($gas.stopped -ne $true -or @($gas.triggers).Count -ne 0 -or @($gas.activeLeases).Count -ne 0) { throw "GAS 尚未满足零触发器、零活动租约。" }
$before = [ordered]@{ startedAt = (Get-Date).ToUniversalTime().ToString("o"); order = Get-QueueState $orderRegion $OrderQueueUrl; ams = Get-QueueState $Region $AmsQueueUrl; pricing = if ($PricingQueueUrl) { Get-QueueState $Region $PricingQueueUrl } else { $null }; migration = $migration.snapshot; gas = $gas }
Write-Evidence "cutover-before.json" $before | Out-Null

function Set-SourceQueue([string]$Name, [string]$TargetRegion, [string]$Url, [object]$Current, [string]$DlqArn, [int]$MinimumVisibility) {
  $attributes = @{}
  if ([int]$Current.MessageRetentionPeriod -lt 604800) { $attributes.MessageRetentionPeriod = "604800" }
  if ([int]$Current.VisibilityTimeout -lt $MinimumVisibility) { $attributes.VisibilityTimeout = [string]$MinimumVisibility }
  if (-not $Current.RedrivePolicy) { $attributes.RedrivePolicy = (ConvertTo-Json -InputObject @{ deadLetterTargetArn = $DlqArn; maxReceiveCount = "5" } -Compress) }
  if (-not $attributes.Count) { return }
  $file = Join-Path $artifactRoot "queue-$Name-attributes.json"
  Write-Utf8 $file (ConvertTo-Json -InputObject $attributes -Compress)
  & $aws sqs set-queue-attributes --queue-url $Url --attributes "file://$file" @(Get-Common $TargetRegion)
  if ($LASTEXITCODE -ne 0) { throw "$Name 队列保护属性设置失败。" }
}

Set-SourceQueue "order" $orderRegion $OrderQueueUrl $before.order $order.outputs.OrderDlqArn 1800
Set-SourceQueue "ams" $Region $AmsQueueUrl $before.ams $control.outputs.AmsDlqArn 720
if ($PricingQueueUrl) { Set-SourceQueue "pricing" $Region $PricingQueueUrl $before.pricing $control.outputs.PricingDlqArn 1800 }
& (Join-Path $PSScriptRoot "deploy.ps1") -Region $Region -OrderQueueArn $OrderQueueArn -OrderQueueUrl $OrderQueueUrl -AmsQueueArn $AmsQueueArn -AmsQueueUrl $AmsQueueUrl -PricingQueueArn $PricingQueueArn -PricingQueueUrl $PricingQueueUrl -StackName $StackName -OrderStackName $OrderStackName -Environment $Environment -AutomationState ENABLED -Profile $Profile
if ($LASTEXITCODE -ne 0) { throw "启用 AWS 自动入口失败。" }

$control = Get-StackState $Region $StackName
$order = Get-StackState $orderRegion $OrderStackName
$resumeResults = @()
$index = 0
foreach ($resumeEvent in @($migration.resumeEvents)) {
  $index++
  $file = Join-Path $artifactRoot "resume-$index.json"
  Write-Utf8 $file (ConvertTo-Json -InputObject $resumeEvent -Depth 10 -Compress)
  $result = Invoke-AwsJson $Region @("lambda", "invoke", "--function-name", $control.outputs.JobsFunctionName, "--invocation-type", "Event", "--payload", "fileb://$file", (Join-Path $artifactRoot "resume-$index-response.json"))
  $resumeResults += $result
}
$scheduleResults = @()
foreach ($scheduled in @($migration.scheduledEvents)) { $scheduleResults += Ensure-OneTimeSchedule $scheduled $control.outputs }
$controlAlert = Invoke-AwsJson $Region @("sns", "publish", "--topic-arn", $control.outputs.AlertTopicArn, "--subject", "AMZShop migration cutover started", "--message", "AMZShop AWS 单向切换已开始验收。此消息不代表真实订单、退款或邀评。")
$orderAlert = Invoke-AwsJson $orderRegion @("sns", "publish", "--topic-arn", $order.outputs.AlertTopicArn, "--subject", "AMZShop migration cutover started", "--message", "AMZShop AWS 单向切换已开始验收。此消息不代表真实订单、退款或邀评。")
$alertMessages = @($controlAlert, $orderAlert)
$after = [ordered]@{ activatedAt = (Get-Date).ToUniversalTime().ToString("o"); order = Get-QueueState $orderRegion $OrderQueueUrl; ams = Get-QueueState $Region $AmsQueueUrl; pricing = if ($PricingQueueUrl) { Get-QueueState $Region $PricingQueueUrl } else { $null }; resumeInvocations = $resumeResults; scheduledEvents = $scheduleResults; alertMessageIds = @($alertMessages | ForEach-Object MessageId); observationDueAt = (Get-Date).ToUniversalTime().AddHours(48).ToString("o") }
$path = Write-Evidence "cutover-activated.json" $after
Write-Host "AWS 两区单向接管已启用，证据: $path；GAS 不得恢复。"
