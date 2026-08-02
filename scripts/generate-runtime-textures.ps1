param(
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$Root = Split-Path -Parent $PSScriptRoot
$SourceDirectory = Join-Path $Root 'assets-source\textures'
$OutputDirectory = Join-Path $Root 'assets\runtime-textures'
$TemporaryDirectory = Join-Path $OutputDirectory '_tmp'
$Basisu = Join-Path $Root 'node_modules\basisu\bin\win\x64_sse\basisu.exe'

if (!(Test-Path -LiteralPath $Basisu)) {
  throw 'Missing basisu encoder. Run npm install first.'
}

$Jobs = @(
  @{ Source = 'T_Player1_BaseColor.png'; Name = 'T_Player1_BaseColor'; Mode = 'srgb'; Tiers = @{ '1K' = 1024; '4K' = 4096; '8K' = 8192 } },
  @{ Source = 'T_Player1_Normal.png'; Name = 'T_Player1_Normal'; Mode = 'normal'; Tiers = @{ '1K' = 1024; '4K' = 4096; '8K' = 8192 } },
  @{ Source = 'T_Player1_OcclusionRoughnessMetallic.png'; Name = 'T_Player1_ORM'; Mode = 'linear'; Tiers = @{ '1K' = 1024; '4K' = 4096; '8K' = 8192 } },
  @{ Source = 'T_Astreoid Rock Black_BaseColor.jpg'; Name = 'T_AsteroidBlack_BaseColor'; Mode = 'srgb'; Tiers = @{ '1K' = 1024; '2K' = 2048 } },
  @{ Source = 'T_Astreoid Rock Black_Normal.jpg'; Name = 'T_AsteroidBlack_Normal'; Mode = 'normal'; Tiers = @{ '1K' = 1024; '2K' = 2048 } },
  @{ Source = 'T_Astreoid Rock Black_Roughness.jpg'; Name = 'T_AsteroidBlack_Roughness'; Mode = 'linear'; Tiers = @{ '1K' = 1024; '2K' = 2048 } },
  @{ Source = 'T_CD1_TestSample.png'; Name = 'T_CD1_TestSample'; Mode = 'srgb'; Tiers = @{ '1K' = 1024 } },
  @{ Source = 'T_ControlBar1.png'; Name = 'T_ControlBar1'; Mode = 'srgb'; Tiers = @{ '1K' = 1024 } }
)

function Resize-Texture([string]$SourcePath, [string]$TargetPath, [int]$MaxSize) {
  $Source = [System.Drawing.Image]::FromFile($SourcePath)
  try {
    $Scale = [Math]::Min(1.0, $MaxSize / [double][Math]::Max($Source.Width, $Source.Height))
    $Width = [Math]::Max(1, [int][Math]::Round($Source.Width * $Scale))
    $Height = [Math]::Max(1, [int][Math]::Round($Source.Height * $Scale))
    $Bitmap = New-Object System.Drawing.Bitmap($Width, $Height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    try {
      $Graphics = [System.Drawing.Graphics]::FromImage($Bitmap)
      try {
        $Graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $Graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $Graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $Graphics.DrawImage($Source, 0, 0, $Width, $Height)
      } finally {
        $Graphics.Dispose()
      }
      $Bitmap.Save($TargetPath, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
      $Bitmap.Dispose()
    }
  } finally {
    if ($null -ne $Source) { $Source.Dispose() }
  }
}

function Encode-Ktx2([string]$InputPath, [string]$OutputPath, [string]$Mode, [int]$Quality) {
  $Arguments = @('-ktx2', '-mipmap', '-no_alpha', '-q', "$Quality", '-comp_level', '1', '-file', $InputPath, '-output_file', $OutputPath)
  if ($Mode -eq 'normal') {
    $Arguments = @('-ktx2', '-mipmap', '-no_alpha', '-normal_map', '-q', "$Quality", '-comp_level', '1', '-file', $InputPath, '-output_file', $OutputPath)
  } elseif ($Mode -eq 'linear') {
    $Arguments = @('-ktx2', '-mipmap', '-no_alpha', '-linear', '-q', "$Quality", '-comp_level', '1', '-file', $InputPath, '-output_file', $OutputPath)
  }
  & $Basisu @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "basisu failed for $InputPath"
  }
}

function Get-Quality([string]$Tier, [string]$Mode) {
  $Quality = switch ($Tier) {
    '1K' { 155 }
    '2K' { 185 }
    '4K' { 195 }
    '8K' { 220 }
  }
  if ($Mode -eq 'normal') { return [Math]::Min(255, $Quality + 10) }
  return $Quality
}

New-Item -ItemType Directory -Force -Path $OutputDirectory, $TemporaryDirectory | Out-Null
$Outputs = 0

try {
  foreach ($Job in $Jobs) {
    $SourcePath = Join-Path $SourceDirectory $Job.Source
    if (!(Test-Path -LiteralPath $SourcePath)) {
      Write-Warning "Skipping missing source texture: $($Job.Source)"
      continue
    }

    foreach ($Tier in $Job.Tiers.Keys) {
      $OutputPath = Join-Path $OutputDirectory "$($Job.Name)_$Tier.ktx2"
      $SourceTimestamp = (Get-Item -LiteralPath $SourcePath).LastWriteTimeUtc
      if (!$Force -and (Test-Path -LiteralPath $OutputPath) -and (Get-Item -LiteralPath $OutputPath).LastWriteTimeUtc -ge $SourceTimestamp) {
        Write-Host "Current  $($Job.Name) $Tier"
        continue
      }

      $TemporaryPath = Join-Path $TemporaryDirectory "$($Job.Name)_$Tier.png"
      $SourceImage = [System.Drawing.Image]::FromFile($SourcePath)
      try {
        $NeedsResize = [Math]::Max($SourceImage.Width, $SourceImage.Height) -gt $Job.Tiers[$Tier]
      } finally {
        $SourceImage.Dispose()
      }
      $EncodePath = $SourcePath
      if ($NeedsResize) {
        Write-Host "Resize   $($Job.Source) -> $Tier"
        Resize-Texture $SourcePath $TemporaryPath $Job.Tiers[$Tier]
        $EncodePath = $TemporaryPath
      }
      Write-Host "Encode   $($Job.Name) $Tier"
      Encode-Ktx2 $EncodePath $OutputPath $Job.Mode (Get-Quality $Tier $Job.Mode)
      if ($NeedsResize) { Remove-Item -LiteralPath $TemporaryPath -Force -ErrorAction SilentlyContinue }
      $Outputs++
    }
  }
} finally {
  Remove-Item -LiteralPath $TemporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Runtime texture generation complete: $Outputs file(s) written to assets/runtime-textures"
