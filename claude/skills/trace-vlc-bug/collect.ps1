# Read-only evidence about every vlc.exe on this Windows machine. Run through trace.sh.
#   -OutDir   where the files go (a Windows path)
#   -Hours    how far back the Windows event logs are read (default 6)
#   -Front    also bring each VLC window to the front for one screenshot, then give focus back
#   -Probe    for a PAUSED notesd VLC: play for 6 s to see whether frames move, then pause it again
param([Parameter(Mandatory = $true)][string]$OutDir, [int]$Hours = 6, [switch]$Front, [switch]$Probe)
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public class VlcTrace {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsHungAppWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern void keybd_event(byte v, byte s, uint f, UIntPtr e);
  public struct RECT { public int L, T, R, B; }
  static string Row(IntPtr h, string indent) {
    var c = new StringBuilder(256); GetClassName(h, c, 256); var t = new StringBuilder(256); GetWindowText(h, t, 256); RECT r; GetWindowRect(h, out r);
    return String.Format("{0}{1:X} class={2} visible={3} hung={4} rect={5},{6},{7},{8} title={9}", indent, h.ToInt64(), c, IsWindowVisible(h), IsHungAppWindow(h), r.L, r.T, r.R, r.B, t);
  }
  public static List<string> Tree(uint target) {
    var o = new List<string>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == target) { o.Add(Row(h, "")); EnumChildWindows(h, (c, l2) => { o.Add(Row(c, "    ")); return true; }, IntPtr.Zero); } return true; }, IntPtr.Zero);
    return o;
  }
  public static void Focus(IntPtr h) { keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero); SetForegroundWindow(h); }
}
"@
[VlcTrace]::SetProcessDPIAware() | Out-Null
$out = New-Object System.Collections.Generic.List[string]
function Say([string]$line) { $out.Add($line); Write-Output $line }
function Shot([string]$name) {
  try {
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $w = [Math]::Min(1600, $b.Width); $h = [int]($b.Height * $w / $b.Width)
    (New-Object System.Drawing.Bitmap $bmp, $w, $h).Save((Join-Path $OutDir $name), [System.Drawing.Imaging.ImageFormat]::Jpeg)
    return $true
  } catch { Say "screenshot $name failed: $_"; return $false }
}
function Redact([string]$cmd) { if ($null -eq $cmd) { return '' }; return ($cmd -replace '(--http-password(?:=|\s+)"?)[^\s"]+', '$1***') }
function Status([int]$port, [string]$pw, [string]$query = '') {
  try { return (& curl.exe -s --connect-timeout 1 -m 4 -u ":$pw" "http://127.0.0.1:$port/requests/status.json$query" | ConvertFrom-Json) } catch { return $null }
}

Say "== trace-vlc-bug $(Get-Date -Format o) on $env:COMPUTERNAME, events of the last $Hours h"

Say ''
Say '== graphics adapters'
Get-CimInstance Win32_VideoController | ForEach-Object { Say ("{0} | driver {1} | dated {2:yyyy-MM-dd}" -f $_.Name, $_.DriverVersion, $_.DriverDate) }

$procs = @(Get-CimInstance Win32_Process -Filter "Name='vlc.exe'")
Say ''
Say "== vlc.exe processes: $($procs.Count)"
$stalled = $false
foreach ($c in $procs) {
  $p = Get-Process -Id $c.ProcessId -ErrorAction SilentlyContinue
  if ($null -eq $p) { continue }
  $ours = $c.CommandLine -match '--extraintf(=|\s+)"?http' -and $c.CommandLine -match '--http-password(=|\s+)"?[0-9a-f]{32}'
  Say ("pid {0} started {1:yyyy-MM-dd HH:mm:ss} cpu {2:N1}s ws {3:N0} MB private {4:N0} MB handles {5} threads {6} responding={7} started_by_notesd={8}" -f $p.Id, $p.StartTime, $p.CPU, ($p.WorkingSet64 / 1MB), ($p.PrivateMemorySize64 / 1MB), $p.HandleCount, $p.Threads.Count, $p.Responding, $ours)
  Say ("  cmd: {0}" -f (Redact $c.CommandLine))
  Say '  windows:'
  foreach ($row in [VlcTrace]::Tree([uint32]$p.Id)) { Say "    $row" }
  $port = if ($c.CommandLine -match '--http-port(?:=|\s+)(\d+)') { [int]$Matches[1] } else { 0 }
  $pw = if ($c.CommandLine -match '--http-password(?:=|\s+)"?([^\s"]+)') { $Matches[1] } else { '' }
  if ($port -gt 0 -and $pw -ne '') {
    $a = Status $port $pw
    if ($null -eq $a) { Say "  http: port $port does not answer (a hung or closing VLC)" }
    else {
      $probed = $false
      if ($a.state -eq 'paused' -and $Probe) { Status $port $pw '?command=pl_pause' | Out-Null; $probed = $true; Start-Sleep -Seconds 1; $a = Status $port $pw }
      Start-Sleep -Seconds 5
      $b = Status $port $pw
      if ($probed) { Status $port $pw '?command=pl_pause' | Out-Null }
      if ($null -ne $b) {
        Say ("  http: state={0} fullscreen={1} time {2}->{3} of {4} decodedvideo {5}->{6} displayedpictures {7}->{8} lostpictures {9}{10}" -f $b.state, $b.fullscreen, $a.time, $b.time, $b.length, $a.stats.decodedvideo, $b.stats.decodedvideo, $a.stats.displayedpictures, $b.stats.displayedpictures, $b.stats.lostpictures, $(if ($probed) { ' (probed: played 6 s, paused again)' } else { '' }))
        if ($a.state -eq 'playing' -and $b.state -eq 'playing' -and $b.time -gt $a.time -and $b.stats.decodedvideo -eq $a.stats.decodedvideo -and $b.stats.displayedpictures -eq $a.stats.displayedpictures) {
          $stalled = $true
          Say '  VERDICT: VIDEO STALLED. The clock advances and no frame is decoded or shown: this VLC lost its video device. It will not recover; close it and replay.'
        } elseif ($b.state -eq 'paused' -and -not $probed) {
          Say '  note: paused, so frozen counters prove nothing. Run again with --probe (plays 6 s, then pauses again) when the owner says it cannot be played.'
        }
      }
    }
    $log = if ($c.CommandLine -match '--logfile(?:=|\s+)"?([^\s"]+)') { $Matches[1] } else { '' }
    if ($log -ne '' -and (Test-Path $log)) { Copy-Item $log (Join-Path $OutDir "vlc-$($p.Id).log") -Force; Say "  vlc log: copied $log -> vlc-$($p.Id).log (VLC buffers it; the last lines arrive when VLC exits)" }
  } else { Say '  http: not started with an HTTP interface (opened by hand): no counters' }
  if ($Front -and $p.MainWindowHandle -ne [IntPtr]::Zero) {
    $prev = [VlcTrace]::GetForegroundWindow()
    [VlcTrace]::Focus($p.MainWindowHandle); Start-Sleep -Seconds 2
    if (Shot "screen-vlc-$($p.Id)-a.jpg") { Start-Sleep -Seconds 2; Shot "screen-vlc-$($p.Id)-b.jpg" | Out-Null; Say "  screenshots with this VLC in front: screen-vlc-$($p.Id)-a.jpg, -b.jpg (2 s apart)" }
    [VlcTrace]::Focus($prev)
  }
}
if (Shot 'screen.jpg') { Say ''; Say 'screenshot of the desktop as it is: screen.jpg' }

$from = (Get-Date).AddHours(-$Hours)
Say ''
Say '== display driver events (System log, provider Display; 4101 = the driver hung and was reset, every Direct3D device is removed)'
$disp = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Display'; StartTime = $from } -ErrorAction SilentlyContinue)
if ($disp.Count -eq 0) { Say 'none' }
foreach ($e in $disp) { Say ("{0:yyyy-MM-dd HH:mm:ss} id {1} {2}" -f $e.TimeCreated, $e.Id, ($e.Message -split "`n")[0].Trim()) }
$month = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Display'; Id = 4101; StartTime = (Get-Date).AddDays(-30) } -ErrorAction SilentlyContinue)
Say ("driver resets (4101) in the last 30 days: {0}{1}" -f $month.Count, $(if ($month.Count -gt 0) { ': ' + (($month | ForEach-Object { $_.TimeCreated.ToString('MM-dd HH:mm') }) -join ', ') } else { '' }))

Say ''
Say '== application crashes and hangs (Application log 1000 / 1002)'
$app = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; ProviderName = 'Application Error', 'Application Hang'; StartTime = $from } -ErrorAction SilentlyContinue)
if ($app.Count -eq 0) { Say 'none' }
foreach ($e in $app) { Say ("{0:yyyy-MM-dd HH:mm:ss} id {1} {2} | module {3} | code {4}" -f $e.TimeCreated, $e.Id, $e.Properties[0].Value, $(if ($e.Id -eq 1000) { $e.Properties[3].Value } else { '-' }), $(if ($e.Id -eq 1000) { $e.Properties[6].Value } else { '-' })) }

Say ''
Say '== sleep, resume and unexpected shutdown (System log)'
$pow = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; StartTime = $from; Id = 41, 42, 107, 506, 507, 6008 } -ErrorAction SilentlyContinue)
if ($pow.Count -eq 0) { Say 'none' }
foreach ($e in $pow) { Say ("{0:yyyy-MM-dd HH:mm:ss} id {1} {2}: {3}" -f $e.TimeCreated, $e.Id, $e.ProviderName, ($e.Message -split "`n")[0].Trim()) }

Say ''
Say '== VLC crash dumps (a dump here makes the NEXT VLC open a "VLC just crashed" dialog instead of playing)'
$dumps = @(Get-ChildItem "$env:APPDATA\vlc\crashdump" -ErrorAction SilentlyContinue)
if ($dumps.Count -eq 0) { Say 'none' }
foreach ($d in $dumps) { Say ("{0:yyyy-MM-dd HH:mm:ss} {1} {2:N0} bytes" -f $d.LastWriteTime, $d.FullName, $d.Length) }

Say ''
Say '== VLC settings that matter (vlcrc; a line starting with # is the default)'
$rc = "$env:APPDATA\vlc\vlcrc"
if (Test-Path $rc) { Select-String -Path $rc -Pattern '^#?(vout|avcodec-hw|file-logging|logfile|log-verbose|fullscreen|video-on-top)=' | ForEach-Object { Say $_.Line } } else { Say 'no vlcrc' }

Say ''
Say $(if ($stalled) { '== RESULT: at least one VLC is playing without video (see VERDICT above)' } else { '== RESULT: no playing VLC with frozen video was seen' })
$out | Set-Content -Path (Join-Path $OutDir 'windows.txt') -Encoding UTF8
