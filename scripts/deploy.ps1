[CmdletBinding()]
param(
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
  [string]$AlertEmail = "",
  [ValidateSet("PRESERVE", "DISABLED", "ENABLED")][string]$AutomationState = "PRESERVE",
  [string[]]$Functions = @(),
  [switch]$SkipStacks,
  [switch]$AllowDirty,
  [string]$Profile = ""
)

# 兼容 Windows PowerShell 5.1：本文件须保存为 UTF-8 with BOM，不用 PowerShell 7 专有语法或 API。
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$env:AWS_RETRY_MODE = "standard"
$env:AWS_MAX_ATTEMPTS = "5"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$template = Join-Path $repo "infra\template.yaml"
$artifactRoot = Join-Path $repo "artifacts"
$recordRoot = Join-Path $artifactRoot "deployments"
$manifestPath = Join-Path $artifactRoot "deployment-manifest.json"
$utf8 = New-Object System.Text.UTF8Encoding($false)
$aws = (Get-Command aws.exe -ErrorAction SilentlyContinue).Source
if (-not $aws) { $aws = "C:\Program Files\Amazon\AWSCLIV2\aws.exe" }
if (-not (Test-Path -LiteralPath $aws)) { throw "未找到官方 AWS CLI。" }

function Get-Common([string]$TargetRegion) {
  $result = @("--region", $TargetRegion, "--no-cli-pager")
  if ($Profile) { $result += @("--profile", $Profile) }
  return $result
}

function ConvertFrom-JsonLines([object[]]$Lines) {
  if (-not $Lines) { return $null }
  return ($Lines -join "`n") | ConvertFrom-Json
}

function Invoke-AwsJson([string]$TargetRegion, [string[]]$Arguments) {
  $raw = & $aws @Arguments @(Get-Common $TargetRegion) --output json
  if ($LASTEXITCODE -ne 0) { throw "AWS CLI 失败: $($Arguments -join ' ')" }
  return ConvertFrom-JsonLines $raw
}

function Get-Stack([string]$TargetRegion, [string]$Name) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try { $raw = & $aws cloudformation describe-stacks --stack-name $Name @(Get-Common $TargetRegion) --output json 2>$null; $code = $LASTEXITCODE }
  finally { $ErrorActionPreference = $previous }
  if ($code -ne 0 -or -not $raw) { return $null }
  return (ConvertFrom-JsonLines $raw).Stacks[0]
}

function Get-StackParameter([object]$Stack, [string]$Key) {
  if (-not $Stack) { return $null }
  return ($Stack.Parameters | Where-Object { $_.ParameterKey -eq $Key } | Select-Object -First 1).ParameterValue
}

function Deploy-Stack([string]$TargetRegion, [string]$Name, [string[]]$Parameters) {
  & $aws cloudformation deploy --template-file $template --stack-name $Name --capabilities CAPABILITY_NAMED_IAM --no-fail-on-empty-changeset --parameter-overrides @Parameters @(Get-Common $TargetRegion) | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "CloudFormation 栈 $Name 部署失败。" }
  $stack = Get-Stack $TargetRegion $Name
  if (-not $stack) { throw "CloudFormation 栈 $Name 部署后无法读取。" }
  return $stack
}

function Resolve-Git {
  $found = Get-Command git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($found) { return $found.Source }
  if ($env:AMZSHOP_GIT) {
    if (Test-Path -LiteralPath $env:AMZSHOP_GIT) { return $env:AMZSHOP_GIT }
    throw "AMZSHOP_GIT 指向的 git 不存在: $env:AMZSHOP_GIT"
  }
  throw "未找到 git：请加入 PATH，或把环境变量 AMZSHOP_GIT 设为 git.exe 路径。"
}

function Invoke-Git([string[]]$Arguments) {
  $output = @(& $git -C $repo @Arguments)
  if ($LASTEXITCODE -ne 0) { throw "git $($Arguments -join ' ') 失败。" }
  return ,$output
}

function Get-TextSha256([string]$Text) {
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  try { $bytes = $algorithm.ComputeHash($utf8.GetBytes($Text)) } finally { $algorithm.Dispose() }
  return -join ($bytes | ForEach-Object { $_.ToString("x2") })
}

function Get-FileSha256([string]$Path) { return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() }

function Write-Json([string]$Path, [object]$Value) { [IO.File]::WriteAllText($Path, (ConvertTo-Json -InputObject $Value -Depth 12) + "`n", $utf8) }

function Get-StackSummary([object]$Stack, [bool]$Deployed) {
  $summary = [ordered]@{ name = $Stack.StackName; deployed = $Deployed; automationState = Get-StackParameter $Stack "AutomationState"; outputs = $Stack.Outputs }
  if ($Deployed) { $summary.deployedAt = (Get-Date).ToUniversalTime().ToString("o"); $summary.gitCommit = $commit; $summary.dirty = $dirty; $summary.templateSha256 = $record.templateSha256; $summary.record = $recordName }
  return $summary
}

function Publish-Function([string]$Name) {
  $targetRegion = $available[$Name]
  $functionName = "amzshop-$Environment-$Name"
  $bundle = Join-Path $repo "dist\$Name\index.js"
  if (-not (Test-Path -LiteralPath $bundle)) { throw "缺少构建产物: $bundle" }
  $zip = Join-Path $artifactRoot "$Name-$targetRegion.zip"
  Compress-Archive -LiteralPath $bundle -DestinationPath $zip -Force
  $bundleSha = Get-FileSha256 $bundle
  & $aws lambda wait function-updated --function-name $functionName @(Get-Common $targetRegion)
  if ($LASTEXITCODE -ne 0) { throw "$functionName ($targetRegion) 当前更新未完成或失败，未上传代码。" }
  $updated = Invoke-AwsJson $targetRegion @("lambda", "update-function-code", "--function-name", $functionName, "--zip-file", "fileb://$zip")
  & $aws lambda wait function-updated --function-name $functionName @(Get-Common $targetRegion)
  if ($LASTEXITCODE -ne 0) { throw "$functionName ($targetRegion) 更新等待失败。" }
  $published = Invoke-AwsJson $targetRegion @("lambda", "publish-version", "--function-name", $functionName, "--code-sha256", $updated.CodeSha256, "--description", "AMZShop $shortCommit$dirtyMark bundle $($bundleSha.Substring(0, 16))")
  Write-Host "$functionName ($targetRegion) 已发布 v$($published.Version)"
  return [ordered]@{ function = $functionName; region = $targetRegion; version = $published.Version; codeSha256 = $published.CodeSha256; bundleSha256 = $bundleSha; zipSha256 = (Get-FileSha256 $zip); gitCommit = $commit; dirty = $dirty; deployedAt = (Get-Date).ToUniversalTime().ToString("o"); record = $recordName }
}

if ([bool]$PricingQueueArn -ne [bool]$PricingQueueUrl) { throw "Pricing Queue ARN 与 URL 必须同时提供或同时留空。" }
$orderRegion = ($OrderQueueArn -split ":")[3]
$amsRegion = ($AmsQueueArn -split ":")[3]
if (-not $orderRegion -or -not $amsRegion) { throw "无法从生产队列 ARN 解析区域。" }
if ($amsRegion -ne $Region) { throw "控制区域 $Region 必须与 AMS 队列区域 $amsRegion 一致。" }
if ($PricingQueueArn -and ($PricingQueueArn -split ":")[3] -ne $Region) { throw "Pricing 队列必须位于控制区域 $Region。" }
if (-not $OrderStackName) { $OrderStackName = "amzshop-$Environment-order-$orderRegion" }
if ($SkipStacks -and ($AutomationState -ne "PRESERVE" -or $AlertEmail)) { throw "-SkipStacks 不更新 CloudFormation，不能同时指定 AutomationState 或 AlertEmail。" }

$available = [ordered]@{ jobs = $Region; ams = $Region }
if ($PricingQueueArn) { $available["pricing"] = $Region }
$available["offer"] = $Region
$available["portal"] = $Region
$available["order"] = $orderRegion
$requested = @($Functions | ForEach-Object { $_ -split "[,\s]+" } | Where-Object { $_ } | ForEach-Object { $_.ToLowerInvariant() } | Select-Object -Unique)
$unknown = @($requested | Where-Object { -not $available.Contains($_) })
if ($unknown.Count) { throw "无法发布函数: $($unknown -join ', ')；可选: $(@($available.Keys) -join ', ')。" }
$selected = if ($requested.Count) { @(@($available.Keys) | Where-Object { $requested -contains $_ }) } else { @($available.Keys) }

$git = Resolve-Git
$commit = (Invoke-Git @("rev-parse", "HEAD")) -join ""
$shortCommit = $commit.Substring(0, 7)
$branch = (Invoke-Git @("rev-parse", "--abbrev-ref", "HEAD")) -join ""
$status = Invoke-Git @("status", "--porcelain", "--untracked-files=all")
$dirty = $status.Count -gt 0
if ($dirty -and -not $AllowDirty) { throw "工作区有 $($status.Count) 项未提交改动，拒绝发布。请先提交；确需应急发布时加 -AllowDirty（会记录改动哈希与补丁）。" }
$dirtyMark = if ($dirty) { "-dirty" } else { "" }

$identity = Invoke-AwsJson $Region @("sts", "get-caller-identity")
& $aws cloudformation validate-template --template-body "file://$template" @(Get-Common $Region) --output json | Out-Null
if ($LASTEXITCODE -ne 0) { throw "CloudFormation 模板校验失败。" }

$queueAttributes = [ordered]@{}
$queues = @(
  @{ Name = "order"; Region = $orderRegion; Url = $OrderQueueUrl; Arn = $OrderQueueArn },
  @{ Name = "ams"; Region = $Region; Url = $AmsQueueUrl; Arn = $AmsQueueArn }
)
if ($PricingQueueArn) { $queues += @{ Name = "pricing"; Region = $Region; Url = $PricingQueueUrl; Arn = $PricingQueueArn } }
foreach ($queue in $queues) {
  $attributes = Invoke-AwsJson $queue.Region @("sqs", "get-queue-attributes", "--queue-url", $queue.Url, "--attribute-names", "All")
  if ($attributes.Attributes.QueueArn -ne $queue.Arn) { throw "$($queue.Name) Queue URL 与 ARN 不匹配。" }
  $queueAttributes[$queue.Name] = $attributes.Attributes
}

$priorControl = Get-Stack $Region $StackName
$priorOrder = Get-Stack $orderRegion $OrderStackName
if ($SkipStacks -and (-not $priorControl -or -not $priorOrder)) { throw "-SkipStacks 要求两区栈均已存在。" }
$stackPlan = if ($SkipStacks) { "跳过" } else { "两区更新" }
Write-Host "发布计划: 提交 $shortCommit$dirtyMark ($branch)；CloudFormation=$stackPlan；函数=$($selected -join ',')；自动入口=$AutomationState（当前 control=$(Get-StackParameter $priorControl 'AutomationState')，order=$(Get-StackParameter $priorOrder 'AutomationState')）"

Push-Location $repo
try {
  npm run check
  if ($LASTEXITCODE -ne 0) { throw "本地检查失败（npm run check），未发布。" }
} finally { Pop-Location }
$statusAfter = Invoke-Git @("status", "--porcelain", "--untracked-files=all")
if (($statusAfter -join "`n") -ne ($status -join "`n")) { throw "npm run check 期间工作区发生变化，未发布。" }

New-Item -ItemType Directory -Force -Path $recordRoot | Out-Null
$stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd'T'HHmmss'Z'", [Globalization.CultureInfo]::InvariantCulture)
$recordName = "deployments/$stamp.json"
$recordPath = Join-Path $recordRoot "$stamp.json"
$record = [ordered]@{
  schemaVersion = 2; startedAt = (Get-Date).ToUniversalTime().ToString("o"); status = "started"
  accountId = [string]$identity.Account; callerArn = $identity.Arn; gitCommit = $commit; gitBranch = $branch; dirty = $null
  environment = $Environment; controlRegion = $Region; orderRegion = $orderRegion; controlStackName = $StackName; orderStackName = $OrderStackName
  templateSha256 = Get-FileSha256 $template; requestedAutomationState = $AutomationState; selectedFunctions = $selected
  stacks = [ordered]@{ deployed = $false; control = $null; order = $null }; functions = [ordered]@{}; queues = $queueAttributes
}
if ($dirty) {
  $patchPath = Join-Path $recordRoot "$stamp.dirty.patch"
  & $git -C $repo diff HEAD --binary "--output=$patchPath"
  if ($LASTEXITCODE -ne 0) { throw "无法保存未提交改动补丁，未发布。" }
  $record.dirty = [ordered]@{ statusSha256 = Get-TextSha256 ($status -join "`n"); status = $status; patch = "deployments/$stamp.dirty.patch"; patchSha256 = Get-FileSha256 $patchPath }
}

$failure = $null
try {
  if ($SkipStacks) {
    $record.stacks.control = Get-StackSummary $priorControl $false
    $record.stacks.order = Get-StackSummary $priorOrder $false
  } else {
    $account = [string]$identity.Account
    $shared = @(
      "Environment=$Environment", "ControlRegion=$Region", "ControlStateTableName=amzshop-$Environment-state",
      "ControlStateTableArn=arn:aws:dynamodb:$Region`:$account`:table/amzshop-$Environment-state",
      "ControlJobsFunctionArn=arn:aws:lambda:$Region`:$account`:function:amzshop-$Environment-jobs",
      "ControlSchedulerRoleArn=arn:aws:iam::$account`:role/amzshop-$Environment-scheduler", "ControlSchedulerGroupName=amzshop-$Environment",
      "ControlSchedulerDlqArn=arn:aws:sqs:$Region`:$account`:amzshop-$Environment-scheduler-dlq"
    )
    if ($AutomationState -ne "PRESERVE") { $shared += "AutomationState=$AutomationState" }
    if ($AlertEmail) { $shared += "AlertEmail=$AlertEmail" }
    $record.stacks.control = Get-StackSummary (Deploy-Stack $Region $StackName (@("StackRole=CONTROL", "OrderQueueArn=", "AmsQueueArn=$AmsQueueArn", "PricingQueueArn=$PricingQueueArn") + $shared)) $true
    $record.stacks.order = Get-StackSummary (Deploy-Stack $orderRegion $OrderStackName (@("StackRole=ORDER", "OrderQueueArn=$OrderQueueArn", "AmsQueueArn=", "PricingQueueArn=") + $shared)) $true
    $record.stacks.deployed = $true
  }
  foreach ($name in $selected) { $record.functions[$name] = Publish-Function $name }
  $record.status = "succeeded"
} catch {
  $failure = $_
  $record.status = "failed"
  $record.error = $_.Exception.Message
}

$previousManifest = $null
if (Test-Path -LiteralPath $manifestPath) {
  try { $previousManifest = [IO.File]::ReadAllText($manifestPath, [Text.Encoding]::UTF8) | ConvertFrom-Json } catch { $previousManifest = $null }
}
$reusePrevious = $previousManifest -and $previousManifest.schemaVersion -eq 2 -and [string]$previousManifest.accountId -eq $record.accountId -and $previousManifest.environment -eq $Environment
if ((Test-Path -LiteralPath $manifestPath) -and -not $reusePrevious) { Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $recordRoot "$stamp.previous-manifest.json") }
$tracked = [ordered]@{}
if ($reusePrevious -and $previousManifest.functions) {
  foreach ($property in $previousManifest.functions.PSObject.Properties) { if ($available.Contains($property.Name)) { $tracked[$property.Name] = $property.Value } }
}
foreach ($name in @($record.functions.Keys)) { $tracked[$name] = $record.functions[$name] }
$live = [ordered]@{}
$untracked = @()
foreach ($name in @($available.Keys)) {
  try {
    $configuration = Invoke-AwsJson $available[$name] @("lambda", "get-function-configuration", "--function-name", "amzshop-$Environment-$name")
    $isTracked = $tracked.Contains($name) -and ([string]$tracked[$name].codeSha256 -eq [string]$configuration.CodeSha256)
    $live[$name] = [ordered]@{ region = $available[$name]; codeSha256 = $configuration.CodeSha256; lastModified = $configuration.LastModified; tracked = $isTracked }
  } catch {
    $isTracked = $false
    $live[$name] = [ordered]@{ region = $available[$name]; error = $_.Exception.Message; tracked = $false }
  }
  if (-not $isTracked) { $untracked += $name }
}
$record.liveFunctions = $live
$record.finishedAt = (Get-Date).ToUniversalTime().ToString("o")
Write-Json $recordPath $record

$stacksState = [ordered]@{}
foreach ($role in @("control", "order")) {
  $current = $record.stacks[$role]
  $previousStack = if ($reusePrevious -and $previousManifest.stacks) { $previousManifest.stacks.$role } else { $null }
  $stacksState[$role] = if ($current -and $current.deployed) { $current } elseif ($previousStack) { $previousStack } else { $current }
}
Write-Json $manifestPath ([ordered]@{
  schemaVersion = 2; updatedAt = $record.finishedAt; lastRecord = $recordName; lastStatus = $record.status
  accountId = $record.accountId; environment = $Environment; controlRegion = $Region; orderRegion = $orderRegion
  controlStackName = $StackName; orderStackName = $OrderStackName; stacks = $stacksState; functions = $tracked; liveFunctions = $live
})

if ($untracked.Count) { Write-Warning "以下函数的线上代码与部署清单不一致（手工发布、发布失败或尚未经本脚本发布）: $($untracked -join ', ')。请用 npm run deploy 发布这些函数以恢复可追溯。" }
if ($failure) {
  Write-Host "发布失败，已记录: $recordPath"
  throw $failure
}
$versions = ($selected | ForEach-Object { "$_=v$($record.functions[$_].version)" }) -join " "
Write-Host "发布完成: 提交 $shortCommit$dirtyMark；$versions；CloudFormation=$stackPlan；自动入口 control=$($record.stacks.control.automationState) order=$($record.stacks.order.automationState)"
Write-Host "部署记录: $recordPath"
Write-Host "部署清单: $manifestPath"
