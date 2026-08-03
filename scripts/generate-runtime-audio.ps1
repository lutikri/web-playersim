param(
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$SourceDirectory = Join-Path $Root 'assets-source\audio'
$OutputDirectory = Join-Path $Root 'assets\audio'
$Ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue

if ($null -eq $Ffmpeg) {
  throw 'Missing ffmpeg. Install it and make sure ffmpeg is available on PATH.'
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$Outputs = 0

Get-ChildItem -LiteralPath $SourceDirectory -Filter 'Player1_*.wav' | ForEach-Object {
  $OutputPath = Join-Path $OutputDirectory "$($_.BaseName).ogg"
  $IsCurrent = (Test-Path -LiteralPath $OutputPath) `
    -and (Get-Item -LiteralPath $OutputPath).LastWriteTimeUtc -ge $_.LastWriteTimeUtc
  if (!$Force -and $IsCurrent) {
    Write-Host "Current  $($_.Name)"
    return
  }

  Write-Host "Encode   $($_.Name)"
  & $Ffmpeg.Source -hide_banner -loglevel error -y -i $_.FullName -c:a libopus -b:a 96k -vbr on $OutputPath
  if ($LASTEXITCODE -ne 0) {
    throw "ffmpeg failed for $($_.FullName)"
  }
  $Outputs++
}

Write-Host "Runtime audio generation complete: $Outputs file(s) written to assets/audio"
