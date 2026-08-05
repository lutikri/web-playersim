param(
  [switch]$Force,
  [switch]$Cinematic,
  [ValidateSet('1K', '2K', '4K', '8K')]
  [string]$OnlyTier
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
  @{ Source = 'T_Player1_BaseColor.png'; Name = 'T_Player1_BaseColor'; Mode = 'srgb'; CinematicTier = '8K'; Tiers = @{ '1K' = 1024; '4K' = 4096 } },
  @{ Source = 'T_Player1_Normal.png'; Name = 'T_Player1_Normal'; Mode = 'normal'; CinematicTier = '8K'; Tiers = @{ '1K' = 1024; '4K' = 4096 } },
  @{ Source = 'T_Player1_OcclusionRoughnessMetallic.png'; Name = 'T_Player1_ORM'; Mode = 'linear'; CinematicTier = '8K'; Tiers = @{ '1K' = 1024; '4K' = 4096 } },
  @{ Source = 'T_PodiumMat1_BaseColor.jpg'; Name = 'T_PodiumMat1_BaseColor'; Mode = 'srgb'; Tiers = @{ '1K' = 1024; '4K' = 4096 } },
  @{ Source = 'T_PodiumMat1_Normal.jpg'; Name = 'T_PodiumMat1_Normal'; Mode = 'normal'; Tiers = @{ '1K' = 1024; '4K' = 4096 } },
  @{ Source = 'T_PodiumMat1_Roughness.jpg'; Name = 'T_PodiumMat1_Roughness'; Mode = 'linear'; Tiers = @{ '1K' = 1024; '4K' = 4096 } },
  @{ Source = 'T_Spekaer1_BaseColor.png'; Name = 'T_Spekaer1_BaseColor'; Mode = 'srgb'; CinematicTier = '4K'; Tiers = @{ '1K' = 1024; '4K' = 4096 } },
  @{ Source = 'T_Spekaer1_Normal.png'; Name = 'T_Spekaer1_Normal'; Mode = 'normal'; CinematicTier = '4K'; Tiers = @{ '1K' = 1024; '4K' = 4096 } },
  @{ Source = 'T_Spekaer1_OcclusionRoughnessMetallic.png'; Name = 'T_Spekaer1_ORM'; Mode = 'linear'; CinematicTier = '4K'; Tiers = @{ '1K' = 1024; '4K' = 4096 } },
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

function Encode-Ktx2([string]$InputPath, [string]$OutputPath, [string]$Mode, [int]$Quality, [int]$CompressionLevel) {
  $Arguments = @('-ktx2', '-mipmap', '-no_alpha', '-q', "$Quality", '-comp_level', "$CompressionLevel", '-file', $InputPath, '-output_file', $OutputPath)
  if ($Mode -eq 'normal') {
    $Arguments = @('-ktx2', '-mipmap', '-no_alpha', '-normal_map', '-q', "$Quality", '-comp_level', "$CompressionLevel", '-file', $InputPath, '-output_file', $OutputPath)
  } elseif ($Mode -eq 'linear') {
    $Arguments = @('-ktx2', '-mipmap', '-no_alpha', '-linear', '-q', "$Quality", '-comp_level', "$CompressionLevel", '-file', $InputPath, '-output_file', $OutputPath)
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
    '4K' { 230 }
    '8K' { 245 }
  }
  if ($Mode -eq 'normal') { return [Math]::Min(255, $Quality + 10) }
  return $Quality
}

function Get-CompressionLevel([string]$Tier) {
  if ($Tier -in @('4K', '8K')) { return 2 }
  return 1
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

    $TargetTiers = @($Job.Tiers.Keys)
    if ($Cinematic) {
      if (!$Job.ContainsKey('CinematicTier')) { continue }
      $TargetTiers = @($Job.CinematicTier)
    }

    foreach ($Tier in $TargetTiers) {
      if ($OnlyTier -and $Tier -ne $OnlyTier) { continue }

      if ($Cinematic) {
        if ([System.IO.Path]::GetExtension($SourcePath).ToLowerInvariant() -ne '.png') {
          Write-Warning "Skipping non-PNG cinematic master: $($Job.Source)"
          continue
        }
        $OutputPath = Join-Path $OutputDirectory "$($Job.Name)_$Tier.png"
        $SourceTimestamp = (Get-Item -LiteralPath $SourcePath).LastWriteTimeUtc
        if (!$Force -and (Test-Path -LiteralPath $OutputPath) -and (Get-Item -LiteralPath $OutputPath).LastWriteTimeUtc -ge $SourceTimestamp) {
          Write-Host "Current  $($Job.Name) $Tier original PNG"
          continue
        }
        Write-Host "Copy     $($Job.Name) $Tier original PNG"
        Copy-Item -LiteralPath $SourcePath -Destination $OutputPath -Force
        $Outputs++
        continue
      }

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
      $NeedsPngConversion = [System.IO.Path]::GetExtension($SourcePath).ToLowerInvariant() -notin @('.png', '.jpg', '.jpeg')
      $EncodePath = $SourcePath
      if ($NeedsResize -or $NeedsPngConversion) {
        Write-Host "Prepare  $($Job.Source) -> $Tier PNG"
        Resize-Texture $SourcePath $TemporaryPath $Job.Tiers[$Tier]
        $EncodePath = $TemporaryPath
      }
      Write-Host "Encode   $($Job.Name) $Tier"
      Encode-Ktx2 $EncodePath $OutputPath $Job.Mode (Get-Quality $Tier $Job.Mode) (Get-CompressionLevel $Tier)
      if ($NeedsResize -or $NeedsPngConversion) {
        Remove-Item -LiteralPath $TemporaryPath -Force -ErrorAction SilentlyContinue
      }
      $Outputs++
    }
  }
} finally {
  Remove-Item -LiteralPath $TemporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Runtime texture generation complete: $Outputs file(s) written to assets/runtime-textures"
