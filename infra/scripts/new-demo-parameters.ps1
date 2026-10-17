<#
.SYNOPSIS
  Creates the SSM parameters of the `demo` stage with fresh random values, without ever printing a value.

.DESCRIPTION
  Run once by the account owner, before the first `cdk deploy "demo/*"`. CDK creates none of these parameters.
  Every value is new (a dev token must never open demo) and goes straight from memory to SSM:
    /cold-reserve/demo/mcp-server/clients              SecureString  agent:, cards: and phone: clients (no read:, the Alexa skill stays on dev)
    /cold-reserve/demo/agent/mcp-token                 SecureString  the agent's MCP token
    /cold-reserve/demo/sim-api/mcp-token               SecureString  sim-api's cards token
    /cold-reserve/demo/sim-api/phone-token             SecureString  sim-api's sandbox phone token
    /cold-reserve/demo/sim-api/demo-codes              SecureString  judges:<sha256>,owner:<sha256> (what sim-api reads)
    /cold-reserve/demo/sim-api/token-keys              SecureString  k1:<32 random bytes, base64url>
    /cold-reserve/demo/sim-api/origin-secret           String        64 hex characters (CloudFront cannot read a SecureString)
    /cold-reserve/demo/sim-api/origin-secret-previous  String        none
    /cold-reserve/demo/codes/judges                    SecureString  the judges' demo code in clear (no function may read it)
    /cold-reserve/demo/codes/owner                     SecureString  the owner's demo code in clear (no function may read it)
  The two codes in clear are read back only with copy-demo-code.ps1, which copies one to the clipboard.
  The code ids `judges` and `owner` must match infra/cdk.json (`cold-reserve:simApi` -> `codeLimits.demo`).

  Nothing is overwritten: the script stops if any parameter exists under /cold-reserve/demo, and put-parameter runs
  without overwrite. Each value travels in a one-parameter JSON file (--cli-input-json) in a private temporary folder
  that only the current Windows user can open; the file is deleted right after its call and the folder at the end,
  so no value is ever on a command line or on screen.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File infra\scripts\new-demo-parameters.ps1 -AwsProfile <profile> -AccountId <12 digits>
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$AwsProfile,
  [Parameter(Mandatory = $true)][ValidatePattern('^\d{12}$')][string]$AccountId,
  [string]$Aws = 'aws'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Stage = 'demo'
$Prefix = "/cold-reserve/$Stage"
# The region always comes from config (infra/cdk.json), never from this script.
$cdk = Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot '..\cdk.json') | ConvertFrom-Json
$Region = $cdk.context.'cold-reserve:region'
if ($Region -notmatch '^[a-z]{2}(-[a-z]+)+-\d$') { throw 'infra/cdk.json has no valid cold-reserve:region.' }

function New-RandomBytes([int]$Count) {
  $bytes = New-Object byte[] $Count
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  return , $bytes
}
function ConvertTo-Hex([byte[]]$Bytes) { -join ($Bytes | ForEach-Object { $_.ToString('x2') }) }
function ConvertTo-Base64Url([byte[]]$Bytes) { [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_') }
function Get-Sha256Hex([string]$Text) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return ConvertTo-Hex ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text))) } finally { $sha.Dispose() }
}
function Invoke-Aws([string[]]$Arguments) {
  $out = & $Aws @Arguments --profile $AwsProfile --region $Region
  if ($LASTEXITCODE -ne 0) { throw "aws $($Arguments[0]) $($Arguments[1]) failed (exit $LASTEXITCODE)." }
  return $out
}
# A private folder for the one-parameter input files: only the current Windows user may open it (inheritance off).
function New-PrivateDirectory {
  $dir = Join-Path $env:TEMP ("cr-ssm-" + [Guid]::NewGuid().ToString('N'))
  $null = New-Item -ItemType Directory -Path $dir
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($me, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
  Set-Acl -Path $dir -AclObject $acl
  return $dir
}
# Creates one parameter. The value goes through a file (--cli-input-json), never on a command line or on screen; the
# file is deleted right after the call, whatever happens (the CLI answer holds only the version and tier).
function New-Parameter([string]$Name, [ValidateSet('String', 'SecureString')][string]$Type, [string]$Value) {
  $file = Join-Path $PrivateDir ([Guid]::NewGuid().ToString('N') + '.json')
  try {
    $json = @{ Name = $Name; Type = $Type; Value = $Value; Overwrite = $false } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($file, $json, (New-Object System.Text.UTF8Encoding $false))
    $null = Invoke-Aws @('ssm', 'put-parameter', '--cli-input-json', "file://$file")
  }
  finally {
    Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
  }
  Write-Host "created $Name ($Type)"
}

# 1. The right account, and nothing under the demo prefix yet.
$account = Invoke-Aws @('sts', 'get-caller-identity', '--query', 'Account', '--output', 'text')
if ($account -ne $AccountId) { throw "The profile points at another account; expected $AccountId." }
$existing = Invoke-Aws @('ssm', 'get-parameters-by-path', '--path', $Prefix, '--recursive', '--query', 'length(Parameters)', '--output', 'text')
if ([int]$existing -ne 0) { throw "$existing parameter(s) already exist under $Prefix`: nothing was written. Remove them first, or rotate them by hand." }

# 2. Fresh values, in memory only. Tokens: 32 random bytes = 64 hex characters (32+, no spaces or commas, all different).
$agentToken = ConvertTo-Hex (New-RandomBytes 32)
$cardsToken = ConvertTo-Hex (New-RandomBytes 32)
$phoneToken = ConvertTo-Hex (New-RandomBytes 32)
# Demo codes: 24 hex characters each (the site takes 16 to 128). sim-api only ever sees their sha256.
$judgesCode = ConvertTo-Hex (New-RandomBytes 12)
$ownerCode = ConvertTo-Hex (New-RandomBytes 12)
if (@($agentToken, $cardsToken, $phoneToken | Sort-Object -Unique).Count -ne 3 -or $judgesCode -eq $ownerCode) { throw 'Two random values are equal: run the script again.' }

$PrivateDir = New-PrivateDirectory
try {
  # 3. The codes in clear first: if they cannot be kept, no hash is written that nobody could ever type.
  New-Parameter "$Prefix/codes/judges" SecureString $judgesCode
  New-Parameter "$Prefix/codes/owner" SecureString $ownerCode
  New-Parameter "$Prefix/sim-api/demo-codes" SecureString ("judges:$(Get-Sha256Hex $judgesCode),owner:$(Get-Sha256Hex $ownerCode)")

  # 4. The MCP clients (same prefixes as dev, without read: while the Alexa skill stays on dev) and their tokens.
  New-Parameter "$Prefix/mcp-server/clients" SecureString "agent:agent@demo#*=$agentToken,cards:sim@demo#*=$cardsToken,phone:daughter@demo#*=$phoneToken"
  New-Parameter "$Prefix/agent/mcp-token" SecureString $agentToken
  New-Parameter "$Prefix/sim-api/mcp-token" SecureString $cardsToken
  New-Parameter "$Prefix/sim-api/phone-token" SecureString $phoneToken

  # 5. The token signing key and the CloudFront origin secrets (String: CloudFront cannot resolve a SecureString).
  New-Parameter "$Prefix/sim-api/token-keys" SecureString ('k1:' + (ConvertTo-Base64Url (New-RandomBytes 32)))
  New-Parameter "$Prefix/sim-api/origin-secret" String (ConvertTo-Hex (New-RandomBytes 32))
  New-Parameter "$Prefix/sim-api/origin-secret-previous" String 'none'
}
finally {
  Remove-Item -LiteralPath $PrivateDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Variable agentToken, cardsToken, phoneToken, judgesCode, ownerCode -ErrorAction SilentlyContinue
  [GC]::Collect()
}

# 6. Names and types only, never a value: 10 rows expected.
Invoke-Aws @('ssm', 'get-parameters-by-path', '--path', $Prefix, '--recursive', '--query', 'Parameters[].[Name,Type]', '--output', 'table')
Write-Host 'Done. Copy a code with infra\scripts\copy-demo-code.ps1 -Code judges|owner when you need it.'
