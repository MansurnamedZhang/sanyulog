param(
    [ValidateSet('verify','snapshot')][string]$Mode = 'verify',
    [string]$ManifestPath,
    [string]$ExpectedDatabase,
    [string]$ExpectedUser,
    [string]$SourceIdentityFile,
    [string]$TargetIdentityFile,
    [string]$SourceBackupPath,
    [string]$TargetBackupPath,
    [string]$ComposePath,
    [string]$DatabaseContainer,
    [switch]$MaintenanceWindowConfirmed
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Test-SanyuSnapshotManifest {
    param([System.Collections.IDictionary]$Manifest,[string]$ExpectedDatabase,[string]$ExpectedUser)
    $errors=[Collections.Generic.List[string]]::new()
    if ($null -eq $Manifest -or $Manifest['schemaVersion'] -ne 1 -or $Manifest['complete'] -cne $true) { $errors.Add('incomplete') }
    if ($Manifest['sourceStopped'] -cne $true) { $errors.Add('source_writable') }
    foreach ($field in @('databaseName','dumpDatabase')) {
        if ($ExpectedDatabase -cnotmatch '^[a-z][a-z0-9_]{0,62}$' -or $Manifest[$field] -cne $ExpectedDatabase) { $errors.Add('database_identity') }
    }
    if ($ExpectedUser -cnotmatch '^[a-z][a-z0-9_]{0,62}$' -or $Manifest['databaseUser'] -cne $ExpectedUser) { $errors.Add('database_user') }
    if ($Manifest['dumpFormat'] -cne 'custom') { $errors.Add('dump_format') }
    if ($Manifest['keyBytes'] -isnot [int] -or $Manifest['keyBytes'] -ne 32) { $errors.Add('key_size') }
    if ($Manifest['members'] -isnot [array] -or $Manifest['roots'] -isnot [array]) { $errors.Add('inventory_missing') }
    $paths=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($entry in @($Manifest['members'])) {
        if ($entry -isnot [System.Collections.IDictionary] -or $entry['kind'] -cne 'file' -or
            $entry['path'] -isnot [string] -or $entry['path'] -cnotmatch '^[a-zA-Z0-9_.-]+(/[a-zA-Z0-9_.-]+)*$' -or
            $entry['path'] -match '(^|/)\.\.?(?:/|$)' -or -not $paths.Add([string]$entry['path']) -or
            $entry['sha256'] -isnot [string] -or $entry['sha256'] -cnotmatch '^[a-f0-9]{64}$' -or
            $entry['bytes'] -isnot [ValueType] -or $entry['bytes'] -lt 0) { $errors.Add('member_invalid') }
    }
    $roots=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($entry in @($Manifest['roots'])) {
        if ($entry -isnot [System.Collections.IDictionary] -or $entry['kind'] -cne 'directory' -or
            $entry['path'] -isnot [string] -or $entry['path'] -cnotmatch '^[a-zA-Z0-9_.-]+(/[a-zA-Z0-9_.-]+)*$' -or
            $entry['path'] -match '(^|/)\.\.?(?:/|$)' -or -not $roots.Add([string]$entry['path'])) { $errors.Add('root_invalid') }
    }
    foreach ($required in @('auth','attachments','state','config','secrets')) { if (-not $roots.Contains($required)) { $errors.Add('root_missing') } }
    foreach ($required in @('db.dump','auth/auth.db','secrets/storage.key')) { if (-not $paths.Contains($required)) { $errors.Add('member_missing') } }
    $key=@($Manifest['members'] | Where-Object { $_['path'] -ceq 'secrets/storage.key' })
    if ($key.Count -ne 1 -or $key[0]['bytes'] -ne 32) { $errors.Add('key_size') }
    if ($Manifest['fileCount'] -isnot [int] -or $Manifest['fileCount'] -ne $paths.Count) { $errors.Add('file_count') }
    $attachments=@($Manifest['members'] | Where-Object { $_['path'] -clike 'attachments/*' }).Count
    if ($Manifest['attachmentCount'] -isnot [int] -or $Manifest['attachmentCount'] -ne $attachments -or
        $Manifest['referencedAttachmentCount'] -isnot [int] -or $Manifest['referencedAttachmentCount'] -lt 0 -or
        $Manifest['referencedAttachmentCount'] -gt $attachments) { $errors.Add('attachment_count') }
    return @{ok=($errors.Count -eq 0); blockers=@($errors | Select-Object -Unique)}
}

function Test-SanyuTransferIdentity {
    param([System.Collections.IDictionary]$Source,[System.Collections.IDictionary]$Target)
    if ($null -eq $Source -or $null -eq $Target -or $Source['members'] -isnot [array] -or $Target['members'] -isnot [array]) { return $false }
    $left=@($Source['members'] | Sort-Object path | ForEach-Object { "$($_['path'])|$($_['bytes'])|$($_['sha256'])" })
    $right=@($Target['members'] | Sort-Object path | ForEach-Object { "$($_['path'])|$($_['bytes'])|$($_['sha256'])" })
    return ($left.Count -eq $right.Count -and [string]::Join("`n",$left) -ceq [string]::Join("`n",$right))
}

function Test-SanyuCopiedFiles {
    param([string]$Directory,[System.Collections.IDictionary]$Manifest,[string]$ExpectedManifestSha256)
    if ($ExpectedManifestSha256 -cnotmatch '^[a-f0-9]{64}$' -or -not (Test-Path -LiteralPath $Directory -PathType Container) -or
        $null -eq $Manifest -or $Manifest['members'] -isnot [array]) { return $false }
    try {
        $root=Get-Item -LiteralPath $Directory -Force
        if ($root.Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }
        $expected=[Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
        foreach ($member in $Manifest['members']) {
            if ($member -isnot [System.Collections.IDictionary] -or $member['path'] -isnot [string] -or
                $member['path'] -cnotmatch '^[a-zA-Z0-9_.-]+(/[a-zA-Z0-9_.-]+)*$' -or
                $member['path'] -match '(^|/)\.\.?(?:/|$)' -or -not $expected.TryAdd($member['path'],$member)) { return $false }
        }
        $stack=[Collections.Generic.Stack[IO.DirectoryInfo]]::new();$stack.Push($root)
        $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        $manifestSeen=$false
        while ($stack.Count) {
            $dir=$stack.Pop()
            foreach ($item in $dir.GetFileSystemInfos()) {
                if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }
                if ($item -is [IO.DirectoryInfo]) { $stack.Push($item);continue }
                if ($item -isnot [IO.FileInfo]) { return $false }
                $relative=[IO.Path]::GetRelativePath($root.FullName,$item.FullName).Replace('\','/')
                if ($relative -ceq 'manifest.json') {
                    if ($item.Length -gt 16MB -or (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExpectedManifestSha256) { return $false }
                    $manifestSeen=$true
                    continue
                }
                if (-not $expected.ContainsKey($relative) -or -not $seen.Add($relative)) { return $false }
                $entry=$expected[$relative]
                if ($item.Length -ne $entry['bytes'] -or
                    (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry['sha256']) { return $false }
            }
        }
        return ($manifestSeen -and $seen.Count -eq $expected.Count)
    } catch { return $false }
}

function Read-SanyuSnapshotManifest {
    param([string]$Path,[string]$Database,[string]$User)
    if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw 'manifest_missing' }
    $item=Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -gt 16MB) { throw 'manifest_unsafe' }
    $manifest=Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -AsHashtable
    $result=Test-SanyuSnapshotManifest $manifest $Database $User
    if (-not $result.ok) { throw ('snapshot_rejected:' + [string]::Join(',', $result.blockers)) }
    return $manifest
}

function Invoke-SanyuRemoteSnapshot {
    param([string]$Identity,[string]$Backup,[string]$Compose,[string]$Database,[string]$User,[string]$DbContainer)
    if (-not (Test-Path -LiteralPath $Identity -PathType Leaf)) { throw 'source_identity_missing' }
    if ($Backup -cnotmatch '^/home/hans/services/process-log/backups/snapshot-[0-9]{8}T[0-9]{6}Z$' -or
        $Compose -cnotmatch '^/home/hans/services/process-log/[a-zA-Z0-9_.-]+\.ya?ml$' -or
        $Database -cnotmatch '^[a-z][a-z0-9_]{0,62}$' -or $User -cnotmatch '^[a-z][a-z0-9_]{0,62}$' -or
        $DbContainer -cne 'dev-postgres') { throw 'snapshot_request_invalid' }
    $py=@'
import hashlib, json, os, pathlib, re, sqlite3, stat, subprocess, sys, urllib.parse
BACKUP='__BACKUP__'; COMPOSE='__COMPOSE__'; DB='__DB__'; USER='__USER__'; DB_CONTAINER='__DB_CONTAINER__'
ROOT=pathlib.Path('/home/hans/services/process-log')
AUTH=pathlib.Path('/home/hans/.local/share/process-log-auth/auth.db')
ATTACH=ROOT/'attachments'; STATE=ROOT/'state'
KEY=pathlib.Path('/home/hans/.config/process-log-secrets/storage.key')
def run(args, *, data=None):
    p=subprocess.run(args,input=data,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=300)
    if p.returncode: raise RuntimeError('subprocess_failed')
    return p.stdout
def safe(path, directory=False):
    p=pathlib.Path(path)
    for part in [p,*p.parents]:
        info=part.lstat()
        if stat.S_ISLNK(info.st_mode): raise RuntimeError('link_rejected')
        if part==p:
            if directory and not stat.S_ISDIR(info.st_mode): raise RuntimeError('directory_required')
            if not directory and (not stat.S_ISREG(info.st_mode) or info.st_nlink!=1): raise RuntimeError('regular_file_required')
        elif not stat.S_ISDIR(info.st_mode): raise RuntimeError('unsafe_ancestor')
    return p
def newdir(path):
    path.mkdir(mode=0o700)
    os.chmod(path,0o700)
def copy_file(source,target):
    source=safe(source); parent=target.parent
    parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    if stat.S_ISLNK(parent.lstat().st_mode): raise RuntimeError('target_link')
    before=source.stat(); digest=hashlib.sha256(); total=0
    fd=os.open(source,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0))
    out=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,'O_NOFOLLOW',0),0o600)
    try:
        with os.fdopen(fd,'rb') as src, os.fdopen(out,'wb') as dst:
            info=os.fstat(src.fileno())
            if (info.st_dev,info.st_ino,info.st_size)!=(before.st_dev,before.st_ino,before.st_size): raise RuntimeError('source_changed')
            while True:
                block=src.read(1024*1024)
                if not block: break
                dst.write(block); digest.update(block); total+=len(block)
            dst.flush(); os.fsync(dst.fileno())
            after=os.fstat(src.fileno())
            if (after.st_size,after.st_mtime_ns)!=(before.st_size,before.st_mtime_ns): raise RuntimeError('source_changed')
    finally:
        pass
    return {'path':str(target.relative_to(pathlib.Path(BACKUP))),'kind':'file','bytes':total,'sha256':digest.hexdigest()}
def copy_tree(source,dest):
    safe(source,True); newdir(dest)
    for root,dirs,files in os.walk(source,followlinks=False):
        current=pathlib.Path(root); safe(current,True)
        rel=current.relative_to(source)
        for name in sorted(dirs):
            src=current/name; safe(src,True)
            newdir(dest/rel/name)
        for name in sorted(files): members.append(copy_file(current/name,dest/rel/name))
def docker_state(name):
    return json.loads(run(['docker','inspect','--format','{{json .State}}',name]))
try:
    if docker_state('process-log').get('Status')!='exited': raise RuntimeError('source_must_be_stopped')
    if docker_state(DB_CONTAINER).get('Status')!='running': raise RuntimeError('database_unavailable')
    env=json.loads(run(['docker','inspect','--format','{{json .Config.Env}}','process-log']))
    values=dict(item.split('=',1) for item in env if '=' in item)
    url=urllib.parse.urlsplit(values.get('DATABASE_URL',''))
    if url.scheme not in ('postgres','postgresql') or urllib.parse.unquote(url.path.lstrip('/'))!=DB or urllib.parse.unquote(url.username or '')!=USER:
        raise RuntimeError('database_identity_mismatch')
    if not url.hostname or url.hostname in ('localhost','127.0.0.1'): raise RuntimeError('database_host_invalid')
    for item,kind in ((AUTH,False),(ATTACH,True),(STATE,True),(KEY,False),(COMPOSE,False)):
        safe(item,kind)
    if KEY.stat().st_size!=32: raise RuntimeError('key_size_invalid')
    backup=pathlib.Path(BACKUP); safe(backup.parent,True)
    if os.path.lexists(backup): raise RuntimeError('backup_exists')
    os.umask(0o077); newdir(backup)
    members=[]
    for name in ('auth','attachments','state','config','secrets'): newdir(backup/name)
    dump=backup/'db.dump'
    fd=os.open(dump,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,'O_NOFOLLOW',0),0o600)
    proc=subprocess.Popen(['docker','exec',DB_CONTAINER,'pg_dump','-U',USER,'-d',DB,'-Fc'],stdout=fd,stderr=subprocess.PIPE)
    os.close(fd)
    try: _,error=proc.communicate(timeout=300)
    except subprocess.TimeoutExpired:
        proc.kill();proc.communicate()
        raise RuntimeError('dump_timeout')
    if proc.returncode or dump.stat().st_size<6 or dump.open('rb').read(5)!=b'PGDMP': raise RuntimeError('dump_failed')
    with dump.open('rb') as stream:
        check=subprocess.run(['docker','exec','-i',DB_CONTAINER,'pg_restore','-l'],stdin=stream,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=300)
    if check.returncode: raise RuntimeError('dump_invalid')
    with dump.open('rb') as stream: digest=hashlib.file_digest(stream,'sha256').hexdigest()
    members.append({'path':'db.dump','kind':'file','bytes':dump.stat().st_size,'sha256':digest})
    authdest=backup/'auth/auth.db'
    with sqlite3.connect(AUTH.as_uri()+'?mode=ro',uri=True) as src:
        with sqlite3.connect(authdest) as dst: src.backup(dst)
    os.chmod(authdest,0o600)
    with sqlite3.connect(authdest.as_uri()+'?mode=ro',uri=True) as db:
        if db.execute('PRAGMA quick_check').fetchone()[0]!='ok': raise RuntimeError('auth_invalid')
        accounts=[row[0] for row in db.execute('SELECT storage_id FROM users')]
        sessions=db.execute('SELECT count(*) FROM sessions').fetchone()[0]
    if not accounts or len(accounts)!=len(set(accounts)): raise RuntimeError('account_invalid')
    with authdest.open('rb') as stream: digest=hashlib.file_digest(stream,'sha256').hexdigest()
    members.append({'path':'auth/auth.db','kind':'file','bytes':authdest.stat().st_size,'sha256':digest})
    copy_tree(ATTACH,backup/'attachments-copy')
    (backup/'attachments-copy').rename(backup/'attachments-new')
    # Keep explicit destination roots; the copy staging tree is re-homed atomically.
    (backup/'attachments').rmdir(); (backup/'attachments-new').rename(backup/'attachments')
    for member in members: member['path']=member['path'].replace('attachments-copy/','attachments/')
    copy_tree(STATE,backup/'state-copy')
    (backup/'state').rmdir(); (backup/'state-copy').rename(backup/'state')
    for member in members: member['path']=member['path'].replace('state-copy/','state/')
    members.append(copy_file(COMPOSE,backup/'config'/pathlib.Path(COMPOSE).name))
    members.append(copy_file(KEY,backup/'secrets/storage.key'))
    refs=set()
    for sid in accounts:
        if sid!='owner' and not re.fullmatch('[a-f0-9]{32}',sid): raise RuntimeError('storage_id_invalid')
        schema='public' if sid=='owner' else 'process_log_user_'+sid
        query="SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema='"+schema+"' AND table_name='attachments')"
        exists=run(['docker','exec',DB_CONTAINER,'psql','-X','-A','-t','-U',USER,'-d',DB,'-c',query]).decode().strip()
        if exists not in ('t','f'): raise RuntimeError('schema_probe_invalid')
        if exists=='f': continue
        query='SELECT file FROM "'+schema+'".attachments'
        names=run(['docker','exec',DB_CONTAINER,'psql','-X','-A','-t','-U',USER,'-d',DB,'-c',query]).decode().splitlines()
        for digest in names:
            if not re.fullmatch('[a-f0-9]{64}',digest): raise RuntimeError('digest_invalid')
            suffix=digest if sid=='owner' else 'accounts/'+sid+'/'+digest
            refs.add('attachments/'+suffix)
    copied={m['path'] for m in members}
    if not refs.issubset(copied): raise RuntimeError('attachment_missing')
    if docker_state('process-log').get('Status')!='exited': raise RuntimeError('source_resumed')
    roots=[{'path':name,'kind':'directory'} for name in ('auth','attachments','state','config','secrets')]
    manifest={'schemaVersion':1,'complete':True,'sourceStopped':True,'databaseName':DB,'databaseUser':USER,'dumpDatabase':DB,'dumpFormat':'custom','keyBytes':32,
              'fileCount':len(members),'attachmentCount':sum(m['path'].startswith('attachments/') for m in members),
              'referencedAttachmentCount':len(refs),'authAccountCount':len(accounts),'authSessionCount':sessions,'roots':roots,'members':sorted(members,key=lambda m:m['path'])}
    encoded=json.dumps(manifest,sort_keys=True,separators=(',',':')).encode()
    output=backup/'manifest.json'; fd=os.open(output,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'wb') as file: file.write(encoded);file.flush();os.fsync(file.fileno())
    print(json.dumps({'ok':True,'backup':BACKUP,'manifestSha256':hashlib.sha256(encoded).hexdigest(),'fileCount':len(members),'attachmentCount':manifest['attachmentCount']}))
except Exception:
    try:
        if docker_state('process-log').get('Status')=='exited': run(['docker','start','process-log'])
    except Exception: pass
    print('{"ok":false,"error":"snapshot_failed"}')
    sys.exit(2)
'@
    foreach ($pair in @(@('__BACKUP__',$Backup),@('__COMPOSE__',$Compose),@('__DB__',$Database),@('__USER__',$User),@('__DB_CONTAINER__',$DbContainer))) { $py=$py.Replace($pair[0],$pair[1]) }
    $args=@('-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=8','-i',$Identity,'hans@172.16.240.13','python3 -B -')
    $start=[Diagnostics.ProcessStartInfo]::new(); $start.FileName='ssh';$start.UseShellExecute=$false
    $start.RedirectStandardInput=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
    foreach ($arg in $args) { $start.ArgumentList.Add($arg) }
    $process=[Diagnostics.Process]::new();$process.StartInfo=$start
    try {
        if (-not $process.Start()) { throw 'source_ssh_failed' }
        $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
        $process.StandardInput.Write($py);$process.StandardInput.Close()
        if (-not $process.WaitForExit(600000)) { $process.Kill($true);throw 'snapshot_timeout' }
        $reply=$stdout.GetAwaiter().GetResult() | ConvertFrom-Json -AsHashtable
        if ($process.ExitCode -ne 0 -or $reply.ok -cne $true) { throw 'snapshot_failed' }
        return $reply
    } finally { $process.Dispose() }
}

if ($MyInvocation.InvocationName -ne '.') {
    if ($Mode -eq 'verify') {
        $manifest=Read-SanyuSnapshotManifest $ManifestPath $ExpectedDatabase $ExpectedUser
        [ordered]@{ok=$true; fileCount=$manifest.fileCount; attachmentCount=$manifest.attachmentCount} | ConvertTo-Json
    } else {
        if (-not $MaintenanceWindowConfirmed) { throw 'maintenance_window_required' }
        $reply=Invoke-SanyuRemoteSnapshot $SourceIdentityFile $SourceBackupPath $ComposePath $ExpectedDatabase $ExpectedUser $DatabaseContainer
        $reply | ConvertTo-Json
    }
}
