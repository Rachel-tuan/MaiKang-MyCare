# HTML -> PDF via Microsoft Edge headless
# 规避中文路径：先复制到 ASCII 临时目录，转换后再回写
param(
  [Parameter(Mandatory=$true)][string]$In,
  [Parameter(Mandatory=$true)][string]$Out
)
$ErrorActionPreference = 'Stop'

$edge = @(
  "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
  "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw "Microsoft Edge not found" }
if (-not (Test-Path $In)) { throw "Input not found: $In" }

$work = Join-Path $env:TEMP ("h2p_" + [guid]::NewGuid().ToString("N").Substring(0,8))
New-Item -ItemType Directory -Force -Path $work | Out-Null
$tmpHtml = Join-Path $work "in.html"
$tmpPdf  = Join-Path $work "out.pdf"
Copy-Item -LiteralPath $In -Destination $tmpHtml -Force

$tmpUri = ([System.Uri]$tmpHtml).AbsoluteUri
$bin = ([System.Uri]$tmpPdf).AbsoluteUri

$args = @(
  "--headless=new","--disable-gpu","--no-sandbox","--no-pdf-header-footer",
  "--run-all-compositor-stages-before-draw","--virtual-time-budget=8000",
  "--user-data-dir=$work\ud","--print-to-pdf=$tmpPdf", $tmpUri
)
$p = Start-Process -FilePath $edge -ArgumentList $args -PassThru -Wait -WindowStyle Hidden `
      -RedirectStandardOutput "$work\o.txt" -RedirectStandardError "$work\e.txt"

if (-not (Test-Path $tmpPdf)) { throw "PDF not produced. stderr: " + (Get-Content "$work\e.txt" -Raw) }

$outDir = Split-Path -Parent $Out
if ($outDir -and -not (Test-Path $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }
Copy-Item -LiteralPath $tmpPdf -Destination $Out -Force
Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
Write-Output "OK: $Out ($([math]::Round((Get-Item $Out).Length/1KB,1)) KB)"
