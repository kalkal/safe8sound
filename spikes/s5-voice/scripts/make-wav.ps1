# Generates the fake-microphone WAV with the Windows speech engine (local only, never committed).
# Script execution may be disabled on the machine: paste these lines into a PowerShell prompt instead.
param([string]$Out = "$PSScriptRoot\..\.fixtures\question.wav", [string]$Text = "How long will the bedroom stay cool?")
Add-Type -AssemblyName System.Speech
New-Item -ItemType Directory -Force (Split-Path $Out) | Out-Null
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo 16000, ([System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen), ([System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile($Out, $fmt)
$en = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'en-*' } | Select-Object -First 1
if ($en) { $s.SelectVoice($en.VoiceInfo.Name) }
$p = New-Object System.Speech.Synthesis.PromptBuilder
$p.AppendBreak([TimeSpan]::FromMilliseconds(800))
$p.AppendText($Text)
$p.AppendBreak([TimeSpan]::FromMilliseconds(4000))
$s.Speak($p)
$s.Dispose()
Write-Output "wrote $Out"
