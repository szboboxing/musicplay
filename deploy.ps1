# 一键发布 MusicPlay 到 Cloudflare Pages（项目 musicplay）
# 用法：.\deploy.ps1
# 说明：先在项目内生成临时目录 .dist（只含 index.html、admin.html、assets/、functions/）再发布，
#       不会把本脚本、笔记或密钥文件传上去；发布完成后自动删除 .dist。
# 注意：wrangler 会从命令的工作目录查找 functions/，所以必须用 --cwd 指向本项目根目录。

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$stage = Join-Path $root '.dist'

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null
foreach ($item in @('index.html', 'admin.html')) {
  Copy-Item (Join-Path $root $item) $stage
}
foreach ($dir in @('assets', 'functions')) {
  Copy-Item (Join-Path $root $dir) $stage -Recurse
}

# 首页把 theme.css + app.css 内联进 <style>：少两次阻塞请求，手机首屏更早出画面
$css = [System.IO.File]::ReadAllText((Join-Path $root 'assets\theme.css'), [System.Text.Encoding]::UTF8) +
       "`n" + [System.IO.File]::ReadAllText((Join-Path $root 'assets\app.css'), [System.Text.Encoding]::UTF8)
$html = [System.IO.File]::ReadAllText((Join-Path $root 'index.html'), [System.Text.Encoding]::UTF8)
if ($html.Contains('<!--INLINE_CSS-->')) {
  $html = $html.Replace('<!--INLINE_CSS-->', ('<style>' + "`n" + $css + "`n" + '</style>'))
}
[System.IO.File]::WriteAllText((Join-Path $stage 'index.html'), $html, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ('发布目录：' + $stage) -ForegroundColor Cyan

# 调用 wrangler：没有 .git 时 wrangler 会打印 git 警告到 stderr，
# 在 $ErrorActionPreference='Stop' 下会被误判为失败，所以这里只按退出码判断
function Invoke-Wrangler {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$WArgs)
  $ErrorActionPreference = 'Continue'
  $lines = & wrangler @WArgs 2>&1
  $code = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  $noise = 'could not open directory|fatal: ambiguous argument|Use .{1,3}--.{1,3} to separate|git <command>|CategoryInfo|FullyQualifiedErrorId|所在位置|^\s*\+ '
  foreach ($l in $lines) {
    $s = [string]$l
    if ($s -match $noise) { continue }
    Write-Host $s
  }
  return $code
}

$code = Invoke-Wrangler pages deploy $stage --cwd $root --project-name musicplay --branch main --commit-dirty=true
if ($code -ne 0) { throw ('Pages 发布失败（退出码 ' + $code + '）') }

Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
Write-Host '完成：https://musicplay-5xd.pages.dev' -ForegroundColor Green
