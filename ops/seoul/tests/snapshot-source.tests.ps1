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
Write-Host 'GREEN: snapshot manifest and transfer gates passed (local fixtures; no network).'
