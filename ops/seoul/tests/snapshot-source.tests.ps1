$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$sut = Join-Path $PSScriptRoot '../snapshot-source.ps1'
if (-not (Test-Path -LiteralPath $sut -PathType Leaf)) { throw 'RED: snapshot implementation is missing' }
. $sut

function Assert-True($condition, [string]$message) { if (-not $condition) { throw $message } }
function Fixture {
    return @{
        schemaVersion = 1; sourceStopped = $true; databaseName = 'process_log'; databaseUser = 'process_log'
        dumpDatabase = 'process_log'; dumpFormat = 'custom'; keyBytes = 32
        complete = $true; fileCount = 5; attachmentCount = 2; referencedAttachmentCount = 2
        members = @(
            @{ path='db.dump'; bytes=4; sha256=('a'*64); kind='file' },
            @{ path='auth/auth.db'; bytes=8; sha256=('b'*64); kind='file' },
            @{ path='attachments/owner/one'; bytes=8; sha256=('c'*64); kind='file' },
            @{ path='attachments/accounts/abc/two'; bytes=8; sha256=('d'*64); kind='file' },
            @{ path='secrets/storage.key'; bytes=32; sha256=('e'*64); kind='file' }
        )
        roots = @(
            @{path='auth'; kind='directory'}, @{path='attachments'; kind='directory'},
            @{path='state'; kind='directory'}, @{path='config'; kind='directory'},
            @{path='secrets'; kind='directory'}
        )
    }
}
function Reject([string]$name, [scriptblock]$mutate) {
    $sample=Fixture; & $mutate $sample
    $result=Test-SanyuSnapshotManifest $sample -ExpectedDatabase 'process_log' -ExpectedUser 'process_log'
    Assert-True (-not $result.ok) "$name incorrectly accepted"
    Write-Host "PASS reject: $name"
}
$valid=Test-SanyuSnapshotManifest (Fixture) -ExpectedDatabase 'process_log' -ExpectedUser 'process_log'
Assert-True $valid.ok 'valid complete stopped snapshot rejected'
Assert-True ((Get-SanyuFailureCode @{ok=$false;sourceMayBeDown=$true}) -ceq 'snapshot_failed_source_may_be_down') 'failed restart hidden from operator'
Assert-True ((Get-SanyuFailureCode @{ok=$false;sourceMayBeDown=$false}) -ceq 'snapshot_failed_source_state_verified_running') 'verified running status not distinguished'
Assert-True ((Get-SanyuFailureCode @{}) -ceq 'snapshot_remote_unavailable_source_state_unknown') 'unknown state falsely treated as running'
foreach ($reason in @('source_ssh_failed','snapshot_timeout','connection reset','')) {
    Assert-True ((Get-SanyuTransportFailureCode $reason) -ceq 'snapshot_remote_unavailable_source_state_unknown') "transport failure $reason obscured source-state uncertainty"
}
Assert-True ((Get-SanyuTransportFailureCode 'snapshot_failed_source_may_be_down') -ceq 'snapshot_failed_source_may_be_down') 'remote down warning lost'
Assert-True ((Get-SanyuTransportFailureCode 'snapshot_failed_source_state_verified_running') -ceq 'snapshot_failed_source_state_verified_running') 'remote health result lost'
$withOrphan=Fixture; $withOrphan.referencedAttachmentCount=1
Assert-True (Test-SanyuSnapshotManifest $withOrphan -ExpectedDatabase 'process_log' -ExpectedUser 'process_log').ok 'full copied tree may contain an unreferenced ciphertext file'
Reject 'container writable' { param($f) $f.sourceStopped=$false }
Reject 'unknown stop state' { param($f) $f.sourceStopped='true' }
Reject 'wrong database' { param($f) $f.dumpDatabase='other' }
Reject 'wrong configured database' { param($f) $f.databaseName='other' }
Reject 'wrong configured user' { param($f) $f.databaseUser='other' }
Reject 'dump not custom format' { param($f) $f.dumpFormat='plain' }
Reject 'missing key' { param($f) $f.members=@($f.members | Where-Object path -ne 'secrets/storage.key') }
Reject 'wrong key size' { param($f) $f.keyBytes=31 }
Reject 'missing auth' { param($f) $f.members=@($f.members | Where-Object path -ne 'auth/auth.db') }
Reject 'missing attachment' { param($f) $f.attachmentCount=1 }
Reject 'unaccounted attachment' { param($f) $f.referencedAttachmentCount=3 }
Reject 'negative referenced count' { param($f) $f.referencedAttachmentCount=-1 }
Reject 'member symlink' { param($f) $f.members[2].kind='symlink' }
Reject 'root symlink' { param($f) $f.roots[1].kind='symlink' }
Reject 'duplicate member' { param($f) $f.members+=@{path='auth/auth.db';bytes=8;sha256=('f'*64);kind='file'} }
Reject 'path traversal' { param($f) $f.members[2].path='../escape' }
Reject 'invalid hash' { param($f) $f.members[2].sha256=('g'*64) }
Reject 'missing state root' { param($f) $f.roots=@($f.roots | Where-Object path -ne 'state') }
Reject 'missing config root' { param($f) $f.roots=@($f.roots | Where-Object path -ne 'config') }
Reject 'incomplete copy' { param($f) $f.complete=$false }
Reject 'count mismatch' { param($f) $f.fileCount=4 }

$left=Fixture; $right=Fixture
Assert-True (Test-SanyuTransferIdentity $left $right) 'same bytes should match'
$right.members[2].sha256=('f'*64)
Assert-True (-not (Test-SanyuTransferIdentity $left $right)) 'different hash escaped transfer gate'
$right=Fixture; $right.members[2].bytes=7
Assert-True (-not (Test-SanyuTransferIdentity $left $right)) 'different length escaped transfer gate'
$temporary=Join-Path ([IO.Path]::GetTempPath()) ('sanyu-snapshot-test-'+[guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($temporary) | Out-Null
try {
    Assert-True (Test-SanyuPathAncestors $temporary) 'ordinary local staging ancestry rejected'
    [IO.File]::WriteAllText((Join-Path $temporary 'manifest.json'),((Fixture) | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
    $verifyOutput=& pwsh -NoProfile -File $sut -Mode verify -ManifestPath (Join-Path $temporary 'manifest.json') -ExpectedDatabase process_log -ExpectedUser process_log | ConvertFrom-Json -AsHashtable
    Assert-True ($LASTEXITCODE -eq 0 -and $verifyOutput.manifestOnly -eq $true -and $verifyOutput.bytesVerified -eq $false -and -not $verifyOutput.ContainsKey('ok')) 'manifest-only CLI falsely claims byte integrity'
    [IO.File]::WriteAllText((Join-Path $temporary 'manifest.json'),'{}',[Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $temporary 'db.dump'),'abc',[Text.UTF8Encoding]::new($false))
    $manifestHash=(Get-FileHash -LiteralPath (Join-Path $temporary 'manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant()
    $copy=@{members=@(@{path='db.dump';kind='file';bytes=3;sha256='ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'})}
    Assert-True (Test-SanyuCopiedFiles $temporary $copy $manifestHash) 'identical local staging bytes rejected'
    [IO.File]::WriteAllText((Join-Path $temporary 'db.dump'),'abd',[Text.UTF8Encoding]::new($false))
    Assert-True (-not (Test-SanyuCopiedFiles $temporary $copy $manifestHash)) 'modified transfer byte escaped SHA gate'
    [IO.File]::WriteAllText((Join-Path $temporary 'db.dump'),'abc',[Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $temporary 'extra'),'x',[Text.UTF8Encoding]::new($false))
    Assert-True (-not (Test-SanyuCopiedFiles $temporary $copy $manifestHash)) 'extra unmanifested file escaped gate'
    [IO.File]::Delete((Join-Path $temporary 'extra'))
    [IO.File]::Delete((Join-Path $temporary 'manifest.json'))
    Assert-True (-not (Test-SanyuCopiedFiles $temporary $copy $manifestHash)) 'missing manifest escaped gate'
} finally {
    $item=Get-Item -LiteralPath $temporary -Force
    if ($item.Name -cnotmatch '^sanyu-snapshot-test-[a-f0-9]{32}$' -or $item.Parent.FullName -cne ([IO.Path]::GetTempPath()).TrimEnd('\') -or
        ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'unsafe_test_cleanup' }
    Remove-Item -LiteralPath $item.FullName -Recurse -ErrorAction Stop
}
$source=Get-Content -LiteralPath $sut -Raw
$block=[regex]::Match($source,'(?s)\$py=@''\r?\n(.*?)\r?\n''@')
Assert-True $block.Success 'remote Python block missing'
$harness=@'
import ast,json,pathlib,sys,types
source=sys.stdin.read(); tree=ast.parse(source)
function=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='copy_tree')
compiled=compile(ast.Module(body=[function],type_ignores=[]),'<remote-copy-tree>','exec')
class Walk:
    def walk(self,path,**kwargs):
        if kwargs.get('onerror') is not None:
            kwargs['onerror'](PermissionError('unreadable child'))
        return iter(())
namespace={'os':Walk(),'pathlib':pathlib,'safe':lambda *a:None,'newdir':lambda *a:None}
exec(compiled,namespace)
try: namespace['copy_tree'](pathlib.Path('/fixture'),pathlib.Path('/dest'))
except (PermissionError,RuntimeError): print('PASS remote walker rejects unreadable child')
else: raise AssertionError('unreadable child silently omitted')
'@
$walkResult=$block.Groups[1].Value | & .\.venv\Scripts\python.exe -B -c $harness
Assert-True ($LASTEXITCODE -eq 0 -and $walkResult -eq 'PASS remote walker rejects unreadable child') 'remote tree walk accepted skipped subtree'
$identityHarness=@'
import ast,pathlib,re,sys,urllib.parse
source=sys.stdin.read();tree=ast.parse(source)
fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='check_source_identity')
P=pathlib.PurePosixPath
ns={'re':re,'urllib':urllib,'DB':'process_log','USER':'process_log','DB_CONTAINER':'dev-postgres',
    'COMPOSE':'/home/hans/services/process-log/compose.yaml',
    'ROOT':P('/home/hans/services/process-log'),
    'AUTH':P('/home/hans/.local/share/process-log-auth/auth.db'),
    'ATTACH':P('/home/hans/services/process-log/attachments'),
    'STATE':P('/home/hans/services/process-log/state'),
    'KEY':P('/home/hans/.config/process-log-secrets/storage.key')}
exec(compile(ast.Module(body=[fn],type_ignores=[]),'<identity>','exec'),ns)
mounts=[{'Type':'bind','Source':src,'Destination':dst,'RW':rw} for src,dst,rw in [
 ('/home/hans/services/process-log/attachments','/attachments',True),
 ('/home/hans/.local/share/process-log-auth','/auth',True),
 ('/home/hans/services/process-log/state','/data',True),
 ('/home/hans/.config/process-log-secrets/storage.key','/run/secrets/process_log_storage_key',False)]]
labels={'com.docker.compose.project.config_files':'/home/hans/services/process-log/compose.yaml',
        'com.docker.compose.project.working_dir':'/home/hans/services/process-log',
        'com.docker.compose.project':'process-log','com.docker.compose.service':'app'}
def reject(name,url='postgresql://process_log:secret@dev-postgres:5432/process_log',m=None,l=None,common=True,owner=True):
    try: ns['check_source_identity'](url, mounts if m is None else m, labels if l is None else l,common,owner)
    except (RuntimeError,ValueError): return
    raise AssertionError(name+' escaped')
ns['check_source_identity']('postgresql://process_log:secret@dev-postgres:5432/process_log',mounts,labels,True,True)
reject('wrong host',url='postgresql://process_log:secret@other-postgres:5432/process_log')
reject('wrong port',url='postgresql://process_log:secret@dev-postgres:5433/process_log')
reject('container default database mistaken for app',url='postgresql://process_log:secret@dev-postgres:5432/app')
reject('container default user mistaken for app',url='postgresql://hans:secret@dev-postgres:5432/process_log')
reject('wrong database',url='postgresql://process_log:secret@dev-postgres:5432/other')
reject('wrong user',url='postgresql://other:secret@dev-postgres:5432/process_log')
reject('disjoint network',common=False)
reject('wrong compose owner or mode',owner=False)
bad=list(mounts);bad[0]=dict(bad[0],Source='/home/hans/other/attachments');reject('stale mount',m=bad)
bad=list(mounts);bad[3]=dict(bad[3],RW=True);reject('writable key',m=bad)
bad=dict(labels);bad['com.docker.compose.project.config_files']='/home/hans/other/compose.yaml';reject('wrong compose',l=bad)
bad=dict(labels);bad['com.docker.compose.project.working_dir']='/home/hans/other';reject('wrong working directory',l=bad)
print('PASS exact DB endpoint, mounts, Compose and network identity')
'@
$identityResult=$block.Groups[1].Value | & .\.venv\Scripts\python.exe -B -c $identityHarness
Assert-True ($LASTEXITCODE -eq 0 -and $identityResult -eq 'PASS exact DB endpoint, mounts, Compose and network identity') 'remote identity gate failed'
$networkHarness=@'
import ast,re,sys
source=sys.stdin.read();tree=ast.parse(source)
fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='check_network_binding')
ns={'re':re,'DB_CONTAINER':'dev-postgres'}
exec(compile(ast.Module(body=[fn],type_ignores=[]),'<network>','exec'),ns)
check=ns['check_network_binding']; key='dev-databases_default'; nid='a'*64
app={key:{'NetworkID':nid}}; db={key:{'NetworkID':nid,'Aliases':['dev-postgres','postgres']}}
assert check(app,db)
for first,second in [
 ({key:{}},{key:{'Aliases':['dev-postgres']}}),
 ({key:{'NetworkID':''}},{key:{'NetworkID':'','Aliases':['dev-postgres']}}),
 ({key:{'NetworkID':'bad'}},{key:{'NetworkID':'bad','Aliases':['dev-postgres']}}),
 ({key:{'NetworkID':nid}},{key:{'NetworkID':'b'*64,'Aliases':['dev-postgres']}}),
 ({key:{'NetworkID':nid}},{key:{'NetworkID':nid,'Aliases':['postgres']}})]:
    assert not check(first,second), 'unverified network identity passed'
print('PASS nonempty shared NetworkID and DB alias')
'@
$networkResult=$block.Groups[1].Value | & .\.venv\Scripts\python.exe -B -c $networkHarness
Assert-True ($LASTEXITCODE -eq 0 -and $networkResult -eq 'PASS nonempty shared NetworkID and DB alias') 'remote network gate failed'
Write-Host 'GREEN: snapshot manifest and transfer gates passed (local fixtures; no network).'
