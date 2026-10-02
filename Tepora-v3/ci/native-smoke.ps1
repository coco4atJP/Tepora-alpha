$ErrorActionPreference = 'Stop'
$out = Join-Path $PWD '.qa-native'
New-Item -ItemType Directory -Force $out | Out-Null
$setup = Get-ChildItem desktop/target/release/bundle -Recurse -Filter '*setup.exe' | Select-Object -First 1
if (-not $setup) { throw 'NSIS installer was not found' }
$install = Join-Path $env:RUNNER_TEMP 'TeporaSmoke'
$installer = Start-Process -FilePath $setup.FullName -ArgumentList @('/S', "/D=$install") -PassThru
if (-not $installer.WaitForExit(120000)) { $installer.Kill(); throw 'Installer timed out' }
if ($installer.ExitCode -ne 0) { throw "Installer failed: $($installer.ExitCode)" }
$exe = Get-ChildItem $install -Recurse -Filter 'tepora-v3.exe' | Select-Object -First 1
if (-not $exe) { throw 'Installed executable was not found' }
$app = Start-Process -FilePath $exe.FullName -PassThru
try {
  $expectedVersion=(Get-Content package.json -Raw | ConvertFrom-Json).version
  $health=$null
  for ($i=0; $i -lt 40; $i++) {
    Start-Sleep -Seconds 1; $app.Refresh()
    if ($app.HasExited) { throw "App exited: $($app.ExitCode)" }
    $children=Get-CimInstance Win32_Process -Filter "ParentProcessId = $($app.Id)" | Where-Object { $_.Name -like 'node-runtime*' }
    foreach ($child in $children) {
      $listeners=Get-NetTCPConnection -OwningProcess $child.ProcessId -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -eq '127.0.0.1' }
      foreach ($listener in $listeners) {
        try { $candidate=Invoke-RestMethod -Uri "http://127.0.0.1:$($listener.LocalPort)/health" -TimeoutSec 3; if ($candidate.ok -and $candidate.version -eq $expectedVersion) { $health=$candidate; break } } catch { }
      }
      if ($health) { break }
    }
    if ($health) { break }
  }
  if (-not $health) { throw 'Bundled service never became ready' }
  Start-Sleep -Seconds 25; $app.Refresh()
  if ($app.HasExited) { throw 'Native app exited after readiness' }
  @{source_commit=$env:GITHUB_SHA;platform='windows-x64';service_health=$health;native_alive=$true;window_title=$app.MainWindowTitle;window_handle_nonzero=($app.MainWindowHandle -ne 0);visual_assertion='Inspect desktop.png';actual_model_tested=$false} | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $out 'result.json')
  Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing
  $bounds=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $image=New-Object System.Drawing.Bitmap $bounds.Width,$bounds.Height
  $graphics=[System.Drawing.Graphics]::FromImage($image)
  $graphics.CopyFromScreen($bounds.Location,[System.Drawing.Point]::Empty,$bounds.Size)
  $image.Save((Join-Path $out 'desktop.png'),[System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose(); $image.Dispose()
} finally { & taskkill.exe /PID $app.Id /T /F 2>$null | Out-Null }
