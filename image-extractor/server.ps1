# Image extractor local server (no install needed: Windows PowerShell 5.1)
# - serves the editor HTML at http://localhost:8765/
# - /proxy?url=...  fetches a page or image server-side (avoids browser CORS / hotlink blocks)
param([int]$Port = 8765)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$htmlName = (-join [char[]](0xC774,0xBBF8,0xC9C0,0xCD94,0xCD9C,0xD3B8,0xC9D1,0xAE30)) + '.html'
$baseUrl = "http://localhost:$Port/"

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($baseUrl)
try { $listener.Start() } catch {
  Write-Host "Port $Port is already in use - opening the existing editor."
  Start-Process $baseUrl
  exit
}
Write-Host "Image extractor running at $baseUrl  (close this window to stop)"
if (-not $env:NO_BROWSER) { Start-Process $baseUrl }

$handler = {
  param($ctx, $root, $htmlName)
  $req = $ctx.Request; $res = $ctx.Response
  function Send([int]$code, [byte[]]$bytes, [string]$type) {
    $res.StatusCode = $code
    if ($type) { $res.ContentType = $type }
    $res.Headers['Cache-Control'] = 'no-store'
    if ($bytes) { $res.ContentLength64 = $bytes.Length; $res.OutputStream.Write($bytes, 0, $bytes.Length) }
    $res.Close()
  }
  try {
    $path = $req.Url.AbsolutePath
    if ($path -eq '/proxy') {
      $target = $req.QueryString['url']
      $uri = $null
      if (-not [Uri]::TryCreate($target, 'Absolute', [ref]$uri) -or ($uri.Scheme -ne 'http' -and $uri.Scheme -ne 'https')) {
        Send 400 ([Text.Encoding]::UTF8.GetBytes('bad url')) 'text/plain'; return
      }
      # do not proxy into this computer or the local network
      $h = $uri.Host.ToLower()
      if ($h -eq 'localhost' -or $h -match '^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)' -or $h -match '^\[' -or $h.EndsWith('.local')) {
        Send 403 ([Text.Encoding]::UTF8.GetBytes('blocked host')) 'text/plain'; return
      }
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls11
      $wr = [Net.HttpWebRequest]::Create($uri)
      $wr.UserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
      $wr.Accept = 'text/html,application/xhtml+xml,image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
      $wr.Headers['Accept-Language'] = 'ko-KR,ko;q=0.9,en;q=0.8'
      $wr.Referer = $uri.GetLeftPart('Authority') + '/'
      $wr.AutomaticDecompression = [Net.DecompressionMethods]::GZip -bor [Net.DecompressionMethods]::Deflate
      $wr.Timeout = 20000; $wr.ReadWriteTimeout = 20000
      $wr.AllowAutoRedirect = $true; $wr.MaximumAutomaticRedirections = 8
      try { $up = $wr.GetResponse() } catch [Net.WebException] { $up = $_.Exception.Response; if (-not $up) { throw } }
      $ms = New-Object IO.MemoryStream
      $s = $up.GetResponseStream(); $s.CopyTo($ms); $s.Close()
      $code = [int]$up.StatusCode; $type = $up.ContentType; $up.Close()
      Send $code $ms.ToArray() $type
      return
    }
    $rel = [Uri]::UnescapeDataString($path.TrimStart('/'))
    if ($rel -eq '') { $rel = $htmlName }
    $file = [IO.Path]::GetFullPath((Join-Path $root $rel))
    if ($file.StartsWith($root) -and $file.EndsWith('.html') -and (Test-Path $file -PathType Leaf)) {
      Send 200 ([IO.File]::ReadAllBytes($file)) 'text/html; charset=utf-8'
    } else {
      Send 404 ([Text.Encoding]::UTF8.GetBytes('not found')) 'text/plain'
    }
  } catch {
    try { Send 502 ([Text.Encoding]::UTF8.GetBytes("proxy error: $($_.Exception.Message)")) 'text/plain' } catch {}
  }
}

$pool = [RunspaceFactory]::CreateRunspacePool(1, 8); $pool.Open()
$jobs = New-Object System.Collections.ArrayList
while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $ps = [PowerShell]::Create(); $ps.RunspacePool = $pool
  [void]$ps.AddScript($handler).AddArgument($ctx).AddArgument($root).AddArgument($htmlName)
  [void]$jobs.Add(@{ ps = $ps; h = $ps.BeginInvoke() })
  foreach ($j in @($jobs)) { if ($j.h.IsCompleted) { $j.ps.EndInvoke($j.h); $j.ps.Dispose(); $jobs.Remove($j) } }
}
