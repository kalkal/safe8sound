<#
.SYNOPSIS
  Copies one demo code of a stage (`demo` by default) to the clipboard, without printing it.

.DESCRIPTION
  Reads /cold-reserve/<stage>/codes/<code> (written by new-demo-parameters.ps1 or rotate-demo-code.ps1; no function of the app may read it) with
  the owner's own AWS profile, puts it on the clipboard, waits for Enter, then clears the clipboard.
    judges  the code shared by all judges (pasted into the Devpost testing instructions)
    owner   the owner's own test code (small caps of its own, never counted against the judges' code)

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File infra\scripts\copy-demo-code.ps1 -AwsProfile <profile> -Code owner
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$AwsProfile,
  [Parameter(Mandatory = $true)][ValidateSet('judges', 'owner')][string]$Code,
  [ValidateSet('dev', 'demo')][string]$Stage = 'demo',
  [string]$Aws = 'aws'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$cdk = Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot '..\cdk.json') | ConvertFrom-Json
$Region = $cdk.context.'cold-reserve:region'
if ($Region -notmatch '^[a-z]{2}(-[a-z]+)+-\d$') { throw 'infra/cdk.json has no valid cold-reserve:region.' }

$value = & $Aws ssm get-parameter --name "/cold-reserve/$Stage/codes/$Code" --with-decryption --query Parameter.Value --output text --profile $AwsProfile --region $Region
if ($LASTEXITCODE -ne 0) { throw "Could not read the $Code code (exit $LASTEXITCODE)." }
try {
  Set-Clipboard -Value $value.Trim()
  Write-Host "The $Code code is on the clipboard: paste it where it goes, then press Enter to clear the clipboard."
  [void](Read-Host)
}
finally {
  Set-Clipboard -Value ' '
  Remove-Variable value -ErrorAction SilentlyContinue
  Write-Host 'Clipboard cleared.'
  # Clearing the clipboard does not clear the copies Windows may keep elsewhere.
  Write-Host 'Windows may still keep the code in the clipboard history (Win+V) and, if sync is on, in the cloud clipboard'
  Write-Host 'of your other devices. To remove it: press Win+V, open the "..." menu of that entry and choose Delete'
  Write-Host '(or "Clear all"), or turn the history off in Settings > System > Clipboard and press "Clear" there.'
}
