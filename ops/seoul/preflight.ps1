#Requires -Version 7.2
[CmdletBinding()]
param(
    [string]$ReleaseSha,
    [long]$ChecksRunId,
    [string]$CloudflareEvidencePath,
    [string]$SourceIdentityFile,
    [string]$TargetIdentityFile,
    [string]$SourceBackupPath = '/home/hans/services/process-log/backups/v0.11.1-20261008-161548'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Test-TrueBoolean($Value) { return $Value -is [bool] -and $Value }
function Test-FalseBoolean($Value) { return $Value -is [bool] -and -not $Value }

function Test-FreshObservation($Value, [datetimeoffset]$Now) {
    try { $age = ($Now - [datetimeoffset]::Parse([string]$Value)).TotalSeconds; return $age -ge 0 -and $age -le 900 }
    catch { return $false }
}

function Test-SeoulPreflight {
    [CmdletBinding()]
    param([System.Collections.IDictionary]$Snapshot, [string]$ExpectedSha, [datetimeoffset]$Now = [datetimeoffset]::UtcNow)
    $blocked = [System.Collections.Generic.List[string]]::new()
    if ($ExpectedSha -cnotmatch '^[a-f0-9]{40}$') { $blocked.Add('release_sha') }
    if (-not (Test-FreshObservation $Snapshot['observedAtUtc'] $Now)) { $blocked.Add('snapshot_stale') }
    $release = $Snapshot['release']; $source = $Snapshot['source']; $target = $Snapshot['target']; $cf = $Snapshot['cloudflare']
    if ($release -isnot [System.Collections.IDictionary]) { $release = @{} }
    if ($source -isnot [System.Collections.IDictionary]) { $source = @{} }
    if ($target -isnot [System.Collections.IDictionary]) { $target = @{} }
    if ($cf -isnot [System.Collections.IDictionary]) { $cf = @{} }
    $run = $release['run']; if ($run -isnot [System.Collections.IDictionary]) { $run = @{} }
    if ($release['sha'] -cne $ExpectedSha) { $blocked.Add('release_sha') }
    if ([string]$release['reconcileSha256'] -cnotmatch '^[a-f0-9]{64}$') { $blocked.Add('release_artifact') }
    $validRun = $run['headSha'] -ceq $ExpectedSha -and $run['workflowName'] -ceq 'Checks' -and
        $run['status'] -ceq 'completed' -and $run['conclusion'] -ceq 'success' -and $run['event'] -ceq 'push' -and
        [string]$run['databaseId'] -match '^[1-9][0-9]+$' -and
        $run['url'] -ceq "https://github.com/MansurnamedZhang/sanyulog/actions/runs/$($run['databaseId'])" -and
        @($run['jobs']).Count -gt 0
    foreach ($job in @($run['jobs'])) {
        if ($job -isnot [System.Collections.IDictionary] -or $job['status'] -cne 'completed' -or $job['conclusion'] -cne 'success') { $validRun = $false }
    }
    if (-not $validRun) { $blocked.Add('release_checks') }
    $steps=@($run['jobs'] | ForEach-Object { if ($_ -is [System.Collections.IDictionary]) { $_['steps'] } })
    foreach ($required in @('Build exact checked-out application image','Verify private media modules in image without credentials','Record checked-out revision and built image ID')) {
        $verified=@($steps | Where-Object { $_ -is [System.Collections.IDictionary] -and $_['name'] -ceq $required -and $_['status'] -ceq 'completed' -and $_['conclusion'] -ceq 'success' })
        if ($verified.Count -ne 1) { $blocked.Add('release_image') }
    }
    if (-not (Test-TrueBoolean $source['complete']) -or $source['host'] -cne '172.16.240.13') { $blocked.Add('source_incomplete') }
    if (-not (Test-TrueBoolean $source['health']) -or -not (Test-TrueBoolean $source['containerHealthy'])) { $blocked.Add('source_health') }
    if (-not (Test-TrueBoolean $source['backupReadable']) -or $source['backupFileCount'] -isnot [ValueType] -or
        $source['backupFileCount'] -le 0 -or [string]$source['backupManifestSha256'] -cnotmatch '^[a-f0-9]{64}$') { $blocked.Add('source_backup') }
    $counts = @{}; $countsValid = $source['counts'] -is [System.Collections.IDictionary]
    foreach ($key in @('accounts','enabledAccounts','sessions','initializedSchemas','projects','notebooks','attachments')) {
        $v = if ($countsValid) { $source['counts'][$key] } else { $null }
        if ($v -isnot [ValueType] -or $v -is [bool] -or [string]$v -notmatch '^\d+$') { $blocked.Add('source_counts') }
        else { $counts[$key] = [long]$v }
    }
    if ($counts.ContainsKey('accounts') -and ($counts['accounts'] -lt 1 -or $counts['enabledAccounts'] -gt $counts['accounts'] -or $counts['initializedSchemas'] -gt $counts['accounts'])) { $blocked.Add('source_counts') }
    if (-not (Test-TrueBoolean $target['complete']) -or $target['host'] -cne '43.131.245.43') { $blocked.Add('target_incomplete') }
    if (-not (Test-TrueBoolean $target['nginxOk']) -or -not (Test-TrueBoolean $target['dockerOk'])) { $blocked.Add('target_services') }
    # Conservative staging floors, not a capacity/performance certification.
    if ($target['diskAvailableBytes'] -isnot [ValueType] -or $target['diskAvailableBytes'] -lt 10GB -or
        $target['memoryAvailableBytes'] -isnot [ValueType] -or $target['memoryAvailableBytes'] -lt 1GB) { $blocked.Add('target_resources') }
    if (-not $target.Contains('ports') -or @($target['ports']) -contains 18765) { $blocked.Add('target_port') }
    foreach ($port in @($target['ports'])) { if ($port -isnot [ValueType] -or $port -is [bool] -or [string]$port -notmatch '^\d+$' -or $port -lt 1 -or $port -gt 65535) { $blocked.Add('target_port') } }
    if (-not $target.Contains('sites') -or @($target['sites'] | Where-Object { $n=([string]$_).TrimEnd('.').ToLowerInvariant(); $n -eq 'notes.896364.xyz' -or ($n.Contains('*') -and 'notes.896364.xyz' -like $n) -or $n -eq '.896364.xyz' }).Count) { $blocked.Add('target_site') }
    foreach ($site in @($target['sites'])) { if ($site -isnot [string] -or $site -cnotmatch '^[a-zA-Z0-9_.*-]+$') { $blocked.Add('target_site') } }
    if (-not $target.Contains('containers') -or @($target['containers'] | Where-Object { $_ -match '^sanyulog([_|.-]|$)' }).Count) { $blocked.Add('target_container') }
    foreach ($container in @($target['containers'])) { if ($container -isnot [string] -or $container -cnotmatch '^[a-zA-Z0-9_.-]+\|(running|exited|created|restarting|paused|dead|removing)\|(healthy|unhealthy|starting|none)$') { $blocked.Add('target_container') } }
    foreach ($kind in @('volumes','networks')) {
        if (-not $target.Contains($kind) -or $null -eq $target[$kind]) { $blocked.Add('target_storage') }
        foreach ($name in @($target[$kind])) { if ($name -isnot [string] -or $name -cnotmatch '^[a-zA-Z0-9_.-]+$' -or $name -match '^sanyulog([_.-]|$)') { $blocked.Add('target_storage') } }
    }
    $expectedPaths = @('/home/ubuntu/apps/sanyulog','/home/ubuntu/backups/sanyulog','/etc/nginx/sites-available/notes.896364.xyz.conf','/etc/nginx/sites-enabled/notes.896364.xyz.conf')
    $paths = @()
    foreach ($path in $expectedPaths) {
        $matches = @($target['paths'] | Where-Object { $_ -is [System.Collections.IDictionary] -and $_['path'] -ceq $path })
        if ($matches.Count -ne 1 -or -not (Test-FalseBoolean $matches[0]['exists']) -or -not (Test-FalseBoolean $matches[0]['unsafeAncestor'])) { $blocked.Add('target_paths') }
        else { $paths += @{ path=$path; exists=$false; unsafeAncestor=$false } }
    }
    if (-not (Test-TrueBoolean $cf['complete']) -or $cf['provenance'] -cne 'controller-attested-read-only' -or -not $cf.Contains('dns') -or -not $cf.Contains('buckets') -or $null -eq $cf['dns'] -or $null -eq $cf['buckets']) { $blocked.Add('cloudflare_incomplete') }
    if (-not (Test-FreshObservation $cf['observedAtUtc'] $Now)) { $blocked.Add('cloudflare_stale') }
    if ($cf['accountId'] -cne '0910a2f37a347c249c2dce42169b9b65' -or $cf['zoneId'] -cne '67edc27e351abaa1eee7d945a5b0b0f8' -or $cf['zoneName'] -cne '896364.xyz' -or $cf['zoneStatus'] -cne 'active') { $blocked.Add('cloudflare_identity') }
    $dns = @(); $buckets = @()
    foreach ($record in @($cf['dns'])) {
        if ($record -isnot [System.Collections.IDictionary] -or [string]$record['name'] -notmatch '^[a-zA-Z0-9_.*-]+$' -or [string]$record['type'] -notmatch '^[A-Z]+$') { $blocked.Add('cloudflare_incomplete'); continue }
        $name = ([string]$record['name']).TrimEnd('.').ToLowerInvariant()
        if ($name -eq 'notes.896364.xyz') { $blocked.Add('cloudflare_collision') }
        $dns += @{ name=$name; type=$record['type'] }
    }
    foreach ($bucket in @($cf['buckets'])) {
        if ($bucket -isnot [System.Collections.IDictionary] -or [string]$bucket['name'] -notmatch '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$') { $blocked.Add('cloudflare_incomplete'); continue }
        if ($bucket['name'] -ceq 'sanyulog-media') { $blocked.Add('cloudflare_collision') }
        $buckets += @{ name=$bucket['name'] }
    }
    # Project only allowed, typed values. Never serialize the raw snapshot or native diagnostics.
    $safeHosts = @{}
    foreach ($pair in @(@('source',$source),@('target',$target))) {
        $h=$pair[1]; $safe=@{}
        foreach ($key in @('diskAvailableBytes','memoryAvailableBytes','backupFileCount')) {
            if ($h[$key] -is [ValueType] -and [string]$h[$key] -match '^\d+$') { $safe[$key]=[long]$h[$key] }
        }
        foreach ($key in @('complete','health','containerHealthy','backupReadable','nginxOk','dockerOk')) { $safe[$key]=Test-TrueBoolean $h[$key] }
        $safe.host = if ($pair[0] -eq 'source') { '172.16.240.13' } else { '43.131.245.43' }
        $safe.containers=@($h['containers'] | Where-Object { $_ -is [string] -and $_ -cmatch '^[a-zA-Z0-9_.-]+\|(running|exited|created|restarting|paused|dead|removing)\|(healthy|unhealthy|starting|none)$' })
        $safe.ports=@($h['ports'] | Where-Object { $_ -is [ValueType] -and $_ -ge 1 -and $_ -le 65535 })
        $safe.sites=@($h['sites'] | Where-Object { $_ -is [string] -and $_ -cmatch '^[a-zA-Z0-9_.*-]+$' })
        foreach ($kind in @('volumes','networks')) { $safe[$kind]=@($h[$kind] | Where-Object { $_ -is [string] -and $_ -cmatch '^[a-zA-Z0-9_.-]+$' }) }
        if ([string]$h['imageId'] -cmatch '^sha256:[a-f0-9]{64}$') { $safe.imageId=$h['imageId'] }
        if ([string]$h['backupManifestSha256'] -cmatch '^[a-f0-9]{64}$') { $safe.backupManifestSha256=$h['backupManifestSha256'] }
        $safeHosts[$pair[0]]=$safe
    }
    $safeHosts.source.counts=$counts; $safeHosts.target.paths=$paths
    $safeRelease=@{ verifiedChecks=$validRun; imageEvidence='CI build/import only; no published or deployed image attested' }
    if ($ExpectedSha -cmatch '^[a-f0-9]{40}$') { $safeRelease.expectedSha=$ExpectedSha }
    if ([string]$release['sha'] -cmatch '^[a-f0-9]{40}$') { $safeRelease.sha=$release['sha'] }
    if ([string]$release['reconcileSha256'] -cmatch '^[a-f0-9]{64}$') { $safeRelease.reconcileSha256=$release['reconcileSha256'] }
    if ($validRun) { $safeRelease.checksUrl=$run['url']; $safeRelease.runId=[long]$run['databaseId'] }
    return [ordered]@{ schemaVersion=1; generatedAtUtc=$Now.ToString('o'); readyForStaging=($blocked.Count -eq 0)
        deploymentAuthorized=$false; blockers=@($blocked | Select-Object -Unique); release=$safeRelease
        source=$safeHosts.source; target=$safeHosts.target
        cloudflare=@{ provenance='controller-attested-read-only (not direct API verification or cryptographic proof)'; identityVerified= -not ($blocked -contains 'cloudflare_identity'); fresh= -not ($blocked -contains 'cloudflare_stale'); dns=$dns; buckets=$buckets }
        limitations=@('Read-only preflight is not deployment or migration acceptance.','Source counts are live aggregates, not a maintenance-window consistent snapshot.','Recheck all external state immediately before any write.') }
}

function Invoke-CheckedNative {
    param([string]$Command, [string[]]$Arguments, [string]$InputText, [switch]$PreserveOutput)
    # Capture stderr; never propagate command output/exception text on failure.
    $start=[Diagnostics.ProcessStartInfo]::new(); $start.FileName=$Command
    $start.UseShellExecute=$false; $start.CreateNoWindow=$true
    $start.RedirectStandardOutput=$true; $start.RedirectStandardError=$true; $start.RedirectStandardInput=$true
    foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
    $process=[Diagnostics.Process]::new(); $process.StartInfo=$start
    try {
        if (-not $process.Start()) { throw 'native_failed' }
        $output=$process.StandardOutput.ReadToEndAsync(); $errorOutput=$process.StandardError.ReadToEndAsync()
        if ($InputText) { $process.StandardInput.Write($InputText.Replace("`r`n","`n")) }
        $process.StandardInput.Close()
        if (-not $process.WaitForExit(90000)) { $process.Kill($true); throw 'native_timeout' }
        if ($process.ExitCode -ne 0) { throw 'native_failed' }
        $result=$output.GetAwaiter().GetResult()
        if ($PreserveOutput) { return $result }
        return $result.Trim()
    } catch { throw 'read_only_probe_failed' } finally { $process.Dispose() }
}

function Get-SeoulReleaseObservation([string]$Sha, [long]$RunId) {
    if ($Sha -cnotmatch '^[a-f0-9]{40}$' -or $RunId -le 0) { throw 'invalid_release_request' }
    $root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
    $resolved=Invoke-CheckedNative git @('-C',$root,'rev-parse','--verify',"$Sha^{commit}")
    $run=Invoke-CheckedNative gh @('run','view',"$RunId",'--repo','MansurnamedZhang/sanyulog','--json','headSha,databaseId,workflowName,status,conclusion,event,url,jobs')
    $reconcile=Invoke-CheckedNative git @('-C',$root,'show',"${Sha}:r2_reconcile.py") -PreserveOutput
    $digest=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($reconcile))).ToLowerInvariant()
    return @{ sha=$resolved; run=($run | ConvertFrom-Json -AsHashtable); reconcileSha256=$digest }
}

function Get-SeoulHostObservation {
    param([ValidateSet('source','target')][string]$Role, [string]$IdentityFile, [string]$BackupPath)
    if ($BackupPath -cnotmatch '^/home/hans/services/process-log/backups/[a-zA-Z0-9_-][a-zA-Z0-9_.-]+$') { throw 'invalid_backup_path' }
    # Fixed hosts, fixed commands, no password prompt, no trust-on-first-use, no server-side script file.
    $destination=if ($Role -eq 'source') {'hans@172.16.240.13'} else {'ubuntu@43.131.245.43'}
    $arguments=@('-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=8')
    if ($IdentityFile) { if (-not (Test-Path -LiteralPath $IdentityFile -PathType Leaf)) { throw 'identity_path_missing' }; $arguments+=@('-i',$IdentityFile) }
    $arguments+=@($destination,'python3 -B -')
    $script=@'
import hashlib, json, os, pathlib, re, stat, subprocess, sys
ROLE = '__ROLE__'
BACKUP = '__BACKUP__'
def run(args, data=None):
    p = subprocess.run(args, input=data, text=True, capture_output=True, timeout=65)
    if p.returncode: raise RuntimeError('probe_failed')
    return p.stdout
def unsafe(path):
    p=pathlib.Path(path)
    for item in [p, *p.parents]:
        if os.path.lexists(item) and stat.S_ISLNK(item.lstat().st_mode): return True
        if item != p and item.exists() and not item.is_dir(): return True
    return False
try:
    out={'complete': True, 'host': '172.16.240.13' if ROLE=='source' else '43.131.245.43'}
    rows=[json.loads(s) for s in run(['docker','ps','-a','--format','{{json .}}']).splitlines() if s]
    out['containers']=[]
    for row in rows:
        if ROLE=='source' and row['State']!='running': continue
        match=re.search(r'\((healthy|unhealthy|starting)\)',row['Status'])
        health=match.group(1) if match else 'none'
        out['containers'].append(row['Names']+'|'+row['State']+'|'+health)
    out['dockerOk']=True
    out['ports']=sorted({int(line.split()[3].rsplit(':',1)[1]) for line in run(['ss','-H','-ltn']).splitlines()})
    mem=run(['free','-b']).splitlines()
    out['memoryAvailableBytes']=int(next(s for s in mem if s.startswith('Mem:')).split()[-1])
    out['diskAvailableBytes']=int(run(['df','-Pk','/home']).splitlines()[-1].split()[3])*1024
    out['sites']=[]
    if ROLE=='target':
        out['volumes']=run(['docker','volume','ls','--format','{{.Name}}']).splitlines()
        out['networks']=run(['docker','network','ls','--format','{{.Name}}']).splitlines()
        run(['sudo','-n','nginx','-t'])
        config=run(['sudo','-n','nginx','-T'])
        for names in re.findall(r'\bserver_name\s+([^;]+);',config):
            for name in names.split():
                if not re.fullmatch(r'[a-zA-Z0-9_.*-]+',name): raise RuntimeError('unsupported_nginx_server_name')
                out['sites'].append(name)
        out['nginxOk']=True
        paths=['/home/ubuntu/apps/sanyulog','/home/ubuntu/backups/sanyulog','/etc/nginx/sites-available/notes.896364.xyz.conf','/etc/nginx/sites-enabled/notes.896364.xyz.conf']
        out['paths']=[{'path':p,'exists':os.path.lexists(p),'unsafeAncestor':unsafe(p)} for p in paths]
        capacities=[]
        for p in paths[:2]:
            parent=pathlib.Path(p).parent
            while not parent.exists(): parent=parent.parent
            capacities.append(int(run(['df','-Pk',str(parent)]).splitlines()[-1].split()[3])*1024)
        out['diskAvailableBytes']=min(capacities)
    else:
        info=json.loads(run(['docker','inspect','--format','{{json .State}}','process-log']))
        out['containerHealthy']=info['Status']=='running' and info.get('Health',{}).get('Status')=='healthy'
        out['imageId']=run(['docker','inspect','--format','{{.Image}}','process-log']).strip()
        health=json.loads(run(['curl','--fail','--silent','--max-time','10','http://127.0.0.1:8765/api/health']))
        out['health']=health.get('ok') is True
        base=pathlib.Path(BACKUP)
        if unsafe(base) or not base.is_dir(): raise RuntimeError('backup_unavailable')
        hashes=[]
        def unreadable_backup(error): raise RuntimeError('backup_unreadable')
        for root, dirs, files in os.walk(base, followlinks=False, onerror=unreadable_backup):
            for name in dirs+files:
                p=pathlib.Path(root)/name
                if p.is_symlink(): raise RuntimeError('backup_link')
            for name in files:
                p=pathlib.Path(root)/name
                if not p.is_file(): raise RuntimeError('backup_not_regular')
                # Opaque backup hashes only. Never parse archives, keys, env, or auth payloads.
                h=hashlib.sha256()
                with p.open('rb') as f:
                    for chunk in iter(lambda:f.read(1024*1024),b''): h.update(chunk)
                hashes.append((str(p.relative_to(base)),h.hexdigest()))
        out['backupReadable']=bool(hashes)
        out['backupFileCount']=len(hashes)
        out['backupManifestSha256']=hashlib.sha256(json.dumps(sorted(hashes),separators=(',',':')).encode()).hexdigest()
        code="""
import json, os, pathlib, re, sqlite3
import psycopg
from psycopg import sql
try:
    path=pathlib.Path(os.environ.get('PROCESS_LOG_AUTH_DB','/auth/auth.db'))
    if path.is_symlink() or not path.is_file(): raise RuntimeError('auth_unavailable')
    with sqlite3.connect(path.as_uri()+'?mode=ro',uri=True) as a:
        a.execute('PRAGMA query_only=ON'); a.execute('BEGIN')
        users=a.execute('SELECT storage_id,enabled FROM users').fetchall()
        counts={'accounts':len(users),'enabledAccounts':sum(int(row[1]) for row in users),'sessions':a.execute('SELECT count(*) FROM sessions').fetchone()[0], 'initializedSchemas':0,'projects':0,'notebooks':0,'attachments':0}
    with psycopg.connect(os.environ['DATABASE_URL'],connect_timeout=8,options='-c default_transaction_read_only=on -c statement_timeout=15000') as c:
        c.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
        for sid, enabled in users:
            if sid!='owner' and not re.fullmatch('[a-f0-9]{32}',sid): raise RuntimeError('invalid_scope')
            schema='public' if sid=='owner' else 'process_log_user_'+sid
            if not c.execute('SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema=%s AND table_name=%s)',(schema,'projects')).fetchone()[0]: continue
            counts['initializedSchemas']+=1
            for table in ('projects','notebooks','attachments'):
                counts[table]+=c.execute(sql.SQL('SELECT count(*) FROM {}.{}').format(sql.Identifier(schema),sql.Identifier(table))).fetchone()[0]
        c.rollback()
    print(json.dumps(counts))
except Exception:
    print('{}'); raise SystemExit(1)
"""
        out['counts']=json.loads(run(['docker','exec','-i','process-log','python','-B','-'],code))
    print(json.dumps(out))
except Exception:
    # No tracebacks: connection errors can include credentials, file paths or user data.
    print('{"complete":false}'); sys.exit(1)
'@
    $script=$script.Replace('__ROLE__',$Role).Replace('__BACKUP__',$BackupPath)
    return (Invoke-CheckedNative ssh $arguments $script | ConvertFrom-Json -AsHashtable)
}

function Invoke-SeoulPreflight {
    param([string]$Sha,[long]$RunId,[string]$CloudflarePath,[string]$SourceKey,[string]$TargetKey,[string]$BackupPath)
    $snapshot=@{ observedAtUtc=[datetimeoffset]::UtcNow.ToString('o') }
    try { $snapshot.release=Get-SeoulReleaseObservation $Sha $RunId } catch { $snapshot.release=@{} }
    try { $snapshot.source=Get-SeoulHostObservation source $SourceKey $BackupPath } catch { $snapshot.source=@{complete=$false} }
    try { $snapshot.target=Get-SeoulHostObservation target $TargetKey $BackupPath } catch { $snapshot.target=@{complete=$false} }
    try {
        if (-not $CloudflarePath -or (Get-Item -LiteralPath $CloudflarePath).Length -gt 2MB) { throw 'invalid_evidence' }
        $snapshot.cloudflare=Get-Content -LiteralPath $CloudflarePath -Raw | ConvertFrom-Json -AsHashtable
    } catch { $snapshot.cloudflare=@{} }
    return Test-SeoulPreflight $snapshot $Sha
}

if ($MyInvocation.InvocationName -ne '.') {
    $manifest=Invoke-SeoulPreflight $ReleaseSha $ChecksRunId $CloudflareEvidencePath $SourceIdentityFile $TargetIdentityFile $SourceBackupPath
    $manifest | ConvertTo-Json -Depth 12
    if (-not $manifest.readyForStaging) { exit 2 }
}
