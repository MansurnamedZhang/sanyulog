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

function Test-SanyuInteger($Value) { return (($Value -is [int] -or $Value -is [long]) -and $Value -ge 0) }

function Get-SanyuFailureCode([System.Collections.IDictionary]$Reply) {
    if ($null -eq $Reply -or $Reply['ok'] -cne $false -or $Reply['sourceMayBeDown'] -isnot [bool]) { return 'snapshot_remote_unavailable_source_state_unknown' }
    if ($Reply['sourceMayBeDown']) { return 'snapshot_failed_source_may_be_down' }
    return 'snapshot_failed_source_state_verified_running'
}

function Get-SanyuTransportFailureCode([string]$Reason) {
    if ($Reason -cin @('snapshot_failed_source_may_be_down','snapshot_failed_source_state_verified_running')) { return $Reason }
    return 'snapshot_remote_unavailable_source_state_unknown'
}

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
    if (-not (Test-SanyuInteger $Manifest['keyBytes']) -or $Manifest['keyBytes'] -ne 32) { $errors.Add('key_size') }
    if ($Manifest['members'] -isnot [array] -or $Manifest['roots'] -isnot [array]) { $errors.Add('inventory_missing') }
    $paths=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($entry in @($Manifest['members'])) {
        if ($entry -isnot [System.Collections.IDictionary] -or $entry['kind'] -cne 'file' -or
            $entry['path'] -isnot [string] -or $entry['path'] -cnotmatch '^[a-zA-Z0-9_.-]+(/[a-zA-Z0-9_.-]+)*$' -or
            $entry['path'] -match '(^|/)\.\.?(?:/|$)' -or -not $paths.Add([string]$entry['path']) -or
            $entry['sha256'] -isnot [string] -or $entry['sha256'] -cnotmatch '^[a-f0-9]{64}$' -or
            -not (Test-SanyuInteger $entry['bytes'])) { $errors.Add('member_invalid') }
    }
    $roots=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($entry in @($Manifest['roots'])) {
        if ($entry -isnot [System.Collections.IDictionary] -or $entry['kind'] -cne 'directory' -or
            $entry['path'] -isnot [string] -or $entry['path'] -cnotmatch '^[a-zA-Z0-9_.-]+(/[a-zA-Z0-9_.-]+)*$' -or
            $entry['path'] -match '(^|/)\.\.?(?:/|$)' -or -not $roots.Add([string]$entry['path'])) { $errors.Add('root_invalid') }
    }
    foreach ($required in @('auth','attachments','state','config','secrets')) { if (-not $roots.Contains($required)) { $errors.Add('root_missing') } }
    foreach ($relative in $roots) {
        $separator=$relative.LastIndexOf('/')
        if ($separator -ge 0 -and -not $roots.Contains($relative.Substring(0,$separator))) { $errors.Add('root_parent_missing') }
    }
    foreach ($relative in $paths) {
        $separator=$relative.LastIndexOf('/')
        if ($separator -ge 0 -and -not $roots.Contains($relative.Substring(0,$separator))) { $errors.Add('member_parent_missing') }
    }
    foreach ($required in @('db.dump','auth/auth.db','secrets/storage.key')) { if (-not $paths.Contains($required)) { $errors.Add('member_missing') } }
    $key=@($Manifest['members'] | Where-Object { $_['path'] -ceq 'secrets/storage.key' })
    if ($key.Count -ne 1 -or $key[0]['bytes'] -ne 32) { $errors.Add('key_size') }
    if (-not (Test-SanyuInteger $Manifest['fileCount']) -or $Manifest['fileCount'] -ne $paths.Count) { $errors.Add('file_count') }
    $attachments=@($Manifest['members'] | Where-Object { $_['path'] -clike 'attachments/*' }).Count
    if (-not (Test-SanyuInteger $Manifest['attachmentCount']) -or $Manifest['attachmentCount'] -ne $attachments -or
        -not (Test-SanyuInteger $Manifest['referencedAttachmentCount']) -or
        $Manifest['referencedAttachmentCount'] -gt $attachments) { $errors.Add('attachment_count') }
    return @{ok=($errors.Count -eq 0); blockers=@($errors | Select-Object -Unique)}
}

function Test-SanyuTransferIdentity {
    param([System.Collections.IDictionary]$Source,[System.Collections.IDictionary]$Target)
    if ($null -eq $Source -or $null -eq $Target -or $Source['members'] -isnot [array] -or $Target['members'] -isnot [array] -or
        $Source['roots'] -isnot [array] -or $Target['roots'] -isnot [array]) { return $false }
    $left=@($Source['members'] | Sort-Object path | ForEach-Object { "$($_['path'])|$($_['bytes'])|$($_['sha256'])" })
    $right=@($Target['members'] | Sort-Object path | ForEach-Object { "$($_['path'])|$($_['bytes'])|$($_['sha256'])" })
    $leftDirs=@($Source['roots'] | Sort-Object path | ForEach-Object { "$($_['path'])|$($_['kind'])" })
    $rightDirs=@($Target['roots'] | Sort-Object path | ForEach-Object { "$($_['path'])|$($_['kind'])" })
    return ($left.Count -eq $right.Count -and [string]::Join("`n",$left) -ceq [string]::Join("`n",$right) -and
        $leftDirs.Count -eq $rightDirs.Count -and [string]::Join("`n",$leftDirs) -ceq [string]::Join("`n",$rightDirs))
}

function Test-SanyuPathAncestors {
    param([string]$Path)
    try {
        $item=Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        while ($null -ne $item) {
            if ($item -isnot [IO.DirectoryInfo] -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return $false }
            $item=$item.Parent
        }
        return $true
    } catch { return $false }
}

function Test-SanyuCopiedFiles {
    param([string]$Directory,[System.Collections.IDictionary]$Manifest,[string]$ExpectedManifestSha256)
    if ($ExpectedManifestSha256 -cnotmatch '^[a-f0-9]{64}$' -or -not (Test-SanyuPathAncestors $Directory) -or
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
        if ($Manifest['roots'] -isnot [array]) { return $false }
        $expectedDirs=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($entry in $Manifest['roots']) {
            if ($entry -isnot [System.Collections.IDictionary] -or $entry['kind'] -cne 'directory' -or
                $entry['path'] -isnot [string] -or $entry['path'] -cnotmatch '^[a-zA-Z0-9_.-]+(/[a-zA-Z0-9_.-]+)*$' -or
                $entry['path'] -match '(^|/)\.\.?(?:/|$)' -or -not $expectedDirs.Add($entry['path'])) { return $false }
        }
        $stack=[Collections.Generic.Stack[IO.DirectoryInfo]]::new();$stack.Push($root)
        $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        $seenDirs=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        $manifestSeen=$false
        while ($stack.Count) {
            $dir=$stack.Pop()
            foreach ($item in $dir.GetFileSystemInfos()) {
                if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }
                if ($item -is [IO.DirectoryInfo]) {
                    $relative=[IO.Path]::GetRelativePath($root.FullName,$item.FullName).Replace('\','/')
                    if (-not $expectedDirs.Contains($relative) -or -not $seenDirs.Add($relative)) { return $false }
                    $stack.Push($item);continue
                }
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
        return ($manifestSeen -and $seen.Count -eq $expected.Count -and $seenDirs.Count -eq $expectedDirs.Count)
    } catch { return $false }
}

function Read-SanyuSnapshotManifest {
    param([string]$Path,[string]$Database,[string]$User)
    if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw 'manifest_missing' }
    $item=Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not (Test-SanyuPathAncestors $item.DirectoryName) -or $item.Length -gt 16MB) { throw 'manifest_unsafe' }
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
    def unreadable(error): raise RuntimeError('tree_unreadable')
    for root,dirs,files in os.walk(source,followlinks=False,onerror=unreadable):
        current=pathlib.Path(root); safe(current,True)
        rel=current.relative_to(source)
        for name in sorted(dirs):
            src=current/name; safe(src,True)
            newdir(dest/rel/name)
        for name in sorted(files): members.append(copy_file(current/name,dest/rel/name))
def snapshot_roots(base):
    safe(base,True)
    roots=[]
    def unreadable(error): raise RuntimeError('snapshot_directory_unreadable')
    for current,dirs,files in os.walk(base,followlinks=False,onerror=unreadable):
        parent=pathlib.Path(current)
        safe(parent,True)
        for name in dirs:
            child=parent/name
            safe(child,True)
            relative=child.relative_to(base).as_posix()
            if not re.fullmatch('[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*',relative) or '..' in relative.split('/'):
                raise RuntimeError('snapshot_directory_name_invalid')
            roots.append({'path':relative,'kind':'directory'})
    return sorted(roots,key=lambda entry:entry['path'])
def docker_state(name):
    return json.loads(run(['docker','inspect','--format','{{json .State}}',name]))
def check_network_binding(appnets,dbnets):
    network='dev-databases_default'
    if not isinstance(appnets,dict) or not isinstance(dbnets,dict): return False
    app=appnets.get(network); db=dbnets.get(network)
    if not isinstance(app,dict) or not isinstance(db,dict): return False
    identifier=app.get('NetworkID')
    aliases=db.get('Aliases')
    return (isinstance(identifier,str) and re.fullmatch('[a-f0-9]{64}',identifier) is not None and
            identifier==db.get('NetworkID') and isinstance(aliases,list) and DB_CONTAINER in aliases)
def check_source_identity(database_url,mounts,labels,network_bound,compose_owner_ok):
    url=urllib.parse.urlsplit(database_url)
    if (url.scheme not in ('postgres','postgresql') or
        urllib.parse.unquote(url.path.lstrip('/'))!=DB or
        urllib.parse.unquote(url.username or '')!=USER or
        url.hostname!=DB_CONTAINER or url.port!=5432 or not network_bound or not compose_owner_ok):
        raise RuntimeError('database_identity_mismatch')
    expected={
        '/attachments':(str(ATTACH),True),
        '/auth':(str(AUTH.parent),True),
        '/data':(str(STATE),True),
        '/run/secrets/process_log_storage_key':(str(KEY),False),
    }
    if not isinstance(mounts,list) or len(mounts)!=len(expected): raise RuntimeError('mount_count_mismatch')
    seen=set()
    for mount in mounts:
        if not isinstance(mount,dict): raise RuntimeError('mount_invalid')
        target=mount.get('Destination')
        if (target not in expected or target in seen or mount.get('Type')!='bind' or
            mount.get('Source')!=expected[target][0] or type(mount.get('RW')) is not bool or
            mount['RW']!=expected[target][1]): raise RuntimeError('mount_identity_mismatch')
        seen.add(target)
    if not isinstance(labels,dict) or any(labels.get(k)!=v for k,v in {
        'com.docker.compose.project':'process-log',
        'com.docker.compose.service':'app',
        'com.docker.compose.project.config_files':COMPOSE,
        'com.docker.compose.project.working_dir':str(ROOT),
    }.items()): raise RuntimeError('compose_identity_mismatch')
try:
    if docker_state('process-log').get('Status')!='exited': raise RuntimeError('source_must_be_stopped')
    if docker_state(DB_CONTAINER).get('Status')!='running': raise RuntimeError('database_unavailable')
    if run(['docker','inspect','--format','{{.Name}}','process-log']).decode().strip()!='/process-log': raise RuntimeError('app_name_mismatch')
    if run(['docker','inspect','--format','{{.Name}}',DB_CONTAINER]).decode().strip()!='/dev-postgres': raise RuntimeError('database_name_mismatch')
    appnets=json.loads(run(['docker','inspect','--format','{{json .NetworkSettings.Networks}}','process-log']))
    dbnets=json.loads(run(['docker','inspect','--format','{{json .NetworkSettings.Networks}}',DB_CONTAINER]))
    shared=check_network_binding(appnets,dbnets)
    mounts=json.loads(run(['docker','inspect','--format','{{json .Mounts}}','process-log']))
    labels=json.loads(run(['docker','inspect','--format','{{json .Config.Labels}}','process-log']))
    # Docker has no field projection for one Env entry on a stopped container.
    # Keep the Config.Env projection in this process only; never serialize or log it.
    env=json.loads(run(['docker','inspect','--format','{{json .Config.Env}}','process-log']))
    values=dict(item.split('=',1) for item in env if '=' in item)
    for item,kind in ((AUTH,False),(ATTACH,True),(STATE,True),(KEY,False),(COMPOSE,False)):
        safe(item,kind)
    info=COMPOSE.stat()
    compose_owner_ok=(info.st_uid==os.getuid()==1000 and stat.S_IMODE(info.st_mode)==0o600)
    check_source_identity(values.get('DATABASE_URL',''),mounts,labels,shared,compose_owner_ok)
    del env,values
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
    roots=snapshot_roots(backup)
    directories={entry['path'] for entry in roots}
    if not {'auth','attachments','state','config','secrets'}.issubset(directories): raise RuntimeError('snapshot_root_missing')
    for member in members:
        relative=member['path']
        if '/' in relative and relative.rsplit('/',1)[0] not in directories: raise RuntimeError('snapshot_file_parent_missing')
    manifest={'schemaVersion':1,'complete':True,'sourceStopped':True,'databaseName':DB,'databaseUser':USER,'dumpDatabase':DB,'dumpFormat':'custom','keyBytes':32,
              'fileCount':len(members),'attachmentCount':sum(m['path'].startswith('attachments/') for m in members),
              'referencedAttachmentCount':len(refs),'authAccountCount':len(accounts),'authSessionCount':sessions,'roots':roots,'members':sorted(members,key=lambda m:m['path'])}
    encoded=json.dumps(manifest,sort_keys=True,separators=(',',':')).encode()
    output=backup/'manifest.json'; fd=os.open(output,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'wb') as file: file.write(encoded);file.flush();os.fsync(file.fileno())
    print(json.dumps({'ok':True,'backup':BACKUP,'manifestSha256':hashlib.sha256(encoded).hexdigest(),'fileCount':len(members),'attachmentCount':manifest['attachmentCount']}))
except Exception:
    healthy=False
    try:
        if docker_state('process-log').get('Status')=='exited': run(['docker','start','process-log'])
        state=docker_state('process-log')
        healthy=state.get('Status')=='running' and state.get('Health',{}).get('Status')=='healthy'
    except Exception: pass
    print(json.dumps({'ok':False,'error':'snapshot_failed','sourceMayBeDown':not healthy}))
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
        try { $reply=$stdout.GetAwaiter().GetResult() | ConvertFrom-Json -AsHashtable }
        catch { throw 'snapshot_remote_unavailable_source_state_unknown' }
        if ($process.ExitCode -ne 0 -or $reply.ok -cne $true) { throw (Get-SanyuFailureCode $reply) }
        return $reply
    } catch {
        throw (Get-SanyuTransportFailureCode $_.Exception.Message)
    } finally { $process.Dispose() }
}

if ($MyInvocation.InvocationName -ne '.') {
    if ($Mode -eq 'verify') {
        $manifest=Read-SanyuSnapshotManifest $ManifestPath $ExpectedDatabase $ExpectedUser
        [ordered]@{manifestOnly=$true; bytesVerified=$false; fileCount=$manifest.fileCount; attachmentCount=$manifest.attachmentCount} | ConvertTo-Json
    } else {
        if (-not $MaintenanceWindowConfirmed) { throw 'maintenance_window_required' }
        $reply=Invoke-SanyuRemoteSnapshot $SourceIdentityFile $SourceBackupPath $ComposePath $ExpectedDatabase $ExpectedUser $DatabaseContainer
        $reply | ConvertTo-Json
    }
}
