param(
    [string]$RuntimeDirectory = 'D:/TRAVEL-V1/local-server/p7a'
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath "$PSScriptRoot/..").Path.Replace('\', '/')
$taskRoot = (Resolve-Path -LiteralPath $RuntimeDirectory).Path
$baseline = '4f6b31a262acdf9ac634f0ad58eab437ca79d4cb'
$branch = (git -C $repo branch --show-current).Trim()
if ($branch -ne 'feat/p7a-web-ux-round1') { throw 'This launcher requires the approved UI branch.' }
git -C $repo merge-base --is-ancestor $baseline HEAD
if ($LASTEXITCODE -ne 0) { throw 'UI branch does not descend from the approved baseline.' }
$dependencies = 'C:/Users/jb39/.cache/codex-runtimes/codex-primary-runtime/dependencies'
$node = "$dependencies/node/bin/node.exe"
$env:PATH = "$dependencies/node/bin;$dependencies/bin/fallback;$dependencies/native/git/cmd;$env:PATH"
Get-Content -LiteralPath "$taskRoot/.env.p7a" | ForEach-Object {
    if ($_ -match '^([A-Z_0-9]+)=(.*)$') {
        [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process')
    }
}
$db = [Uri]$env:DATABASE_URL
if ($db.Host -notin @('127.0.0.1', 'localhost') -or $db.AbsolutePath -ne '/travel_p7a_local_test') { throw 'Unexpected local experience database.' }
if ($env:ROUTE_PROVIDER -ne 'synthetic' -or $env:MAIL_PROVIDER -ne 'capture') { throw 'SYNTHETIC routes and captured mail are required.' }
$pg = 'C:/Program Files/PostgreSQL/17/bin'
if (!(Test-Path -LiteralPath "$taskRoot/postgres-data/PG_VERSION")) { throw 'Existing PostgreSQL cluster is required; no cluster will be created.' }
& "$pg/pg_ctl.exe" -D "$taskRoot/postgres-data" status | Out-Null
if ($LASTEXITCODE -ne 0) {
    & "$pg/pg_ctl.exe" -D "$taskRoot/postgres-data" -l "$taskRoot/logs/postgres.log" -o '-p 54327 -h 127.0.0.1' -w start
    if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL startup failed.' }
}
# Backend/schema are unchanged. Reuse the existing compiled services and database.
$specs = @(
    @{ Name='api'; Script="$repo/apps/api/dist/main.js"; Directory=$repo; Arguments=@("$repo/apps/api/dist/main.js") },
    @{ Name='worker'; Script="$repo/apps/worker/dist/main.js"; Directory=$repo; Arguments=@("$repo/apps/worker/dist/main.js") },
    @{ Name='web'; Script="$repo/apps/web/node_modules/vite/bin/vite.js"; Directory="$repo/apps/web"; Arguments=@("$repo/apps/web/node_modules/vite/bin/vite.js", '--host', '127.0.0.1', '--port', '5174', '--strictPort') }
)
$state = @()
foreach ($spec in $specs) {
    $existing = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Replace('\', '/').Contains($spec.Script) })
    if ($existing.Count -gt 1) { throw "Multiple matching $($spec.Name) processes; inspect before starting." }
    if ($existing.Count -eq 1) { $processId = $existing[0].ProcessId } else {
        $tag = Get-Date -Format 'yyyyMMdd-HHmmss'
        $p = Start-Process -FilePath $node -ArgumentList $spec.Arguments -WorkingDirectory $spec.Directory -WindowStyle Hidden -RedirectStandardOutput "$taskRoot/logs/$($spec.Name)-ux-$tag.out.log" -RedirectStandardError "$taskRoot/logs/$($spec.Name)-ux-$tag.err.log" -PassThru
        Start-Sleep -Milliseconds 300
        if ($p.HasExited) { throw "$($spec.Name) process exited during startup; inspect local logs." }
        $processId = $p.Id
    }
    $state += @{ Name=$spec.Name; ProcessId=$processId; Script=$spec.Script }
}
$state | ConvertTo-Json | Set-Content -LiteralPath "$taskRoot/processes.json"
for ($i=0; $i -lt 30; $i++) {
    try {
        $api = Invoke-RestMethod 'http://127.0.0.1:3000/health/ready'
        $web = Invoke-WebRequest 'http://127.0.0.1:5174' -UseBasicParsing
        if ($api.status -eq 'READY' -and $web.StatusCode -eq 200) { break }
    } catch { Start-Sleep -Seconds 1 }
}
& $node "$repo/scripts/check-worker-health.mjs"
if ($LASTEXITCODE -ne 0 -or $api.status -ne 'READY' -or $web.StatusCode -ne 200) { throw 'Startup health check failed; inspect local logs.' }
Write-Output "UI branch $branch running at http://127.0.0.1:5174; existing database/login preserved."
