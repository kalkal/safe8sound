<#
.SYNOPSIS
  Gives one demo code a fresh random value (96 bits), without ever printing it, and can make the stage's codes expire.

.DESCRIPTION
  Run by the account owner only (it writes SSM parameters of a live stage); prepared on 22 Oct for the judges' code,
  not run by anyone yet. For one code id (for example `judges`) of one stage it:
    1. makes a new code: 12 random bytes from the system's cryptographic generator = 24 hex characters (96 bits), which
       fits the site's allowlist ^[A-Za-z0-9-]{16,64}$;
    2. keeps it in clear in /cold-reserve/<stage>/codes/<code id> (SecureString; no function may read it; copy it with
       copy-demo-code.ps1 -Stage <stage> -Code <code id>);
    3. replaces only that code's sha256 in /cold-reserve/<stage>/sim-api/demo-codes (what sim-api reads), keeping the
       other codes' entries as they are.
  The clear code is written first and the list second; if the list cannot be written, the clear code is put back as it
  was (or removed if there was none), so a clear code never stays without its hash. If the script stops with an error,
  nothing is half done: fix the cause (SSO session, network) and run it again.
  With -ExpiresOn, both parameters get an SSM Expiration policy (Advanced tier, about 0.05 USD per parameter per month):
  on that day SSM deletes them, and sim-api can no longer load its configuration when an instance starts, so the whole
  API stops answering (every request fails, not a polite "switched off"): the demo is closed for good until new
  parameters exist. For a polite pause use SIM_DEMO_ENABLED=false instead (docs/nova-kill-switch.md, level 3).
  Without -ExpiresOn each parameter keeps the tier it has (an Advanced parameter cannot go back to Standard).
  Values go from memory to SSM through one-parameter JSON files in a private temporary folder (only the current Windows
  user may open it), deleted right after each call: no value on a command line or on screen. The hashes list and the
  previous clear code are read with decryption into memory only.
  sim-api reads the codes when an instance starts: warm instances keep the old list until they end (minutes when the
  site is idle, the warm-up being off). Say so to whoever tests the new code at once.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File infra\scripts\rotate-demo-code.ps1 -AwsProfile <profile> -AccountId <12 digits> -Stage dev -CodeId judges -ExpiresOn 2026-11-21
  (the judging ends on 20 Nov 2026; the codes expire the day after)

.EXAMPLE
  ... -DryRun   prints what would change (names, tiers, the expiry), calls nothing that writes.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$AwsProfile,
  [Parameter(Mandatory = $true)][ValidatePattern('^\d{12}$')][string]$AccountId,
  [ValidateSet('dev', 'demo')][string]$Stage = 'dev',
  [Parameter(Mandatory = $true)][ValidateSet('judges', 'owner')][string]$CodeId,
  [ValidatePattern('^\d{4}-\d{2}-\d{2}$')][string]$ExpiresOn,
  [switch]$DryRun,
  [string]$Aws = 'aws'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Prefix = "/cold-reserve/$Stage"
$ClearName = "$Prefix/codes/$CodeId"
$HashesName = "$Prefix/sim-api/demo-codes"
# The region always comes from config (infra/cdk.json), never from this script.
$cdk = Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot '..\cdk.json') | ConvertFrom-Json
$Region = $cdk.context.'cold-reserve:region'
if ($Region -notmatch '^[a-z]{2}(-[a-z]+)+-\d$') { throw 'infra/cdk.json has no valid cold-reserve:region.' }
$Policies = $null
if ($ExpiresOn) {
  $expiry = [DateTime]::ParseExact($ExpiresOn, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
  if ($expiry -le (Get-Date)) { throw "-ExpiresOn $ExpiresOn is not in the future." }
  $Policies = '[' + (@{ Type = 'Expiration'; Version = '1.0'; Attributes = @{ Timestamp = $expiry.ToString('yyyy-MM-ddT00:00:00.000Z') } } | ConvertTo-Json -Compress -Depth 4) + ']'
}

function New-RandomBytes([int]$Count) {
  $bytes = New-Object byte[] $Count
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  return , $bytes
}
function ConvertTo-Hex([byte[]]$Bytes) { -join ($Bytes | ForEach-Object { $_.ToString('x2') }) }
function Get-Sha256Hex([string]$Text) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return ConvertTo-Hex ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text))) } finally { $sha.Dispose() }
}
function Invoke-Aws([string[]]$Arguments) {
  $out = & $Aws @Arguments --profile $AwsProfile --region $Region
  if ($LASTEXITCODE -ne 0) { throw "aws $($Arguments[0]) $($Arguments[1]) failed (exit $LASTEXITCODE)." }
  return $out
}
# The tier a parameter has now ('' when it does not exist), so a rerun without -ExpiresOn never asks for a downgrade.
function Get-Tier([string]$Name) {
  $tier = Invoke-Aws @('ssm', 'describe-parameters', '--parameter-filters', "Key=Name,Values=$Name", '--query', 'Parameters[0].Tier', '--output', 'text')
  if ($tier -eq 'None') { return '' } else { return "$tier".Trim() }
}
function Get-TierToWrite([string]$Current) { if ($Policies) { 'Advanced' } elseif ($Current) { $Current } else { 'Standard' } }
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
# Writes one parameter (overwrite: this is a rotation). The value goes through a file, never a command line or the screen.
function Set-Parameter([string]$Name, [string]$Value, [string]$Tier, [string]$WithPolicies) {
  $file = Join-Path $PrivateDir ([Guid]::NewGuid().ToString('N') + '.json')
  try {
    $request = @{ Name = $Name; Type = 'SecureString'; Value = $Value; Overwrite = $true; Tier = $Tier }
    if ($WithPolicies) { $request.Policies = $WithPolicies }
    [IO.File]::WriteAllText($file, ($request | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding $false))
    $null = Invoke-Aws @('ssm', 'put-parameter', '--cli-input-json', "file://$file")
  }
  finally {
    Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
  }
}

# 1. The right account, the tiers as they are, and the hashes list of this stage (this script rotates; it creates no stage).
$account = Invoke-Aws @('sts', 'get-caller-identity', '--query', 'Account', '--output', 'text')
if ($account -ne $AccountId) { throw "The profile points at another account; expected $AccountId." }
$clearTier = Get-TierToWrite (Get-Tier $ClearName)
$hashesTier = Get-TierToWrite (Get-Tier $HashesName)
if ($DryRun) {
  Write-Host "Would write $ClearName (SecureString, $clearTier) with a new 96-bit code, then"
  Write-Host "replace the '$CodeId' entry of $HashesName (SecureString, $hashesTier), keeping the others."
  if ($Policies) { Write-Host "Both would expire on $($ExpiresOn): SSM deletes them, and the whole demo API stops answering." }
  return
}
$current = Invoke-Aws @('ssm', 'get-parameter', '--name', $HashesName, '--with-decryption', '--query', 'Parameter.Value', '--output', 'text')
$entries = [ordered]@{}
foreach ($pair in ($current -split ',')) {
  $id, $hash = $pair.Trim() -split ':', 2
  if ($id -notmatch '^[a-z][a-z0-9-]{1,31}$' -or $hash -notmatch '^[0-9a-f]{64}$') { throw "$HashesName has an entry that is not <code id>:<sha256>: nothing was written." }
  $entries[$id] = $hash
}
Remove-Variable current
# The clear code as it is now, to put back if the list cannot be written ($null when there is none yet).
$previous = $null
if (Get-Tier $ClearName) {
  $previous = Invoke-Aws @('ssm', 'get-parameter', '--name', $ClearName, '--with-decryption', '--query', 'Parameter.Value', '--output', 'text')
}

# 2. The new code, in memory only.
$code = ConvertTo-Hex (New-RandomBytes 12)
if ($code -notmatch '^[A-Za-z0-9-]{16,64}$') { throw 'The new code does not fit the site allowlist: nothing was written.' }
$entries[$CodeId] = Get-Sha256Hex $code

$PrivateDir = New-PrivateDirectory
try {
  # 3. The clear code first, then the list; a failed list puts the clear code back as it was.
  Set-Parameter $ClearName $code $clearTier $Policies
  try {
    Set-Parameter $HashesName (($entries.GetEnumerator() | ForEach-Object { "$($_.Key):$($_.Value)" }) -join ',') $hashesTier $Policies
  }
  catch {
    if ($null -ne $previous) { Set-Parameter $ClearName $previous $clearTier $null } else { $null = Invoke-Aws @('ssm', 'delete-parameter', '--name', $ClearName) }
    throw "The hashes list could not be written; the clear code was put back as it was, so nothing changed. Fix the cause and run the script again. ($($_.Exception.Message))"
  }
}
finally {
  Remove-Item -LiteralPath $PrivateDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Variable code, previous -ErrorAction SilentlyContinue
  [GC]::Collect()
}

# 4. Names, tiers and policies only, never a value.
Invoke-Aws @('ssm', 'describe-parameters', '--parameter-filters', "Key=Name,Values=$ClearName,$HashesName", '--query', 'Parameters[].[Name,Tier,length(Policies)]', '--output', 'table')
Write-Host "Done. Copy the new code with infra\scripts\copy-demo-code.ps1 -Stage $Stage -Code $CodeId when you need it; warm sim-api instances keep the old list until they end."
