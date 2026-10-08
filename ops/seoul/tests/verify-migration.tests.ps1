$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$sut=Join-Path $PSScriptRoot '../verify-migration.ps1'
if (-not (Test-Path -LiteralPath $sut -PathType Leaf)) { throw 'RED: migration verifier missing' }
. $sut
function Assert($ok,[string]$message) { if (-not $ok) { throw $message } }
function Fixture {
    $a='a'*64;$b='b'*64;$c='c'*64;$d='d'*64;$e='e'*64;$f='f'*64
    $id='1234567890abcdef1234567890abcdef'
    $source=@{
        host='172.16.240.13'; sourceStopped=$true; snapshotComplete=$true
        snapshotManifestSha256=$a; authDbSha256=$b; storageKeySha256=$c
        accountRowsSha256=$d; sessionRowsSha256=$e; sessionCount=2
        accounts=@(@{storageId='owner';enabled=$true;initialized=$true},@{storageId=$id;enabled=$false;initialized=$false})
        database=@(@{schema='public';tables=@(@{name='projects';rows=2;normalizedSha256=$f},@{name='attachments';rows=1;normalizedSha256=$a})})
        media=@(@{storageId='owner';key="v1/owner/$a";plaintextSha256=$a;plaintextBytes=4;ciphertextSha256=$b;ciphertextBytes=40;references=1})
    }
    $target=ConvertFrom-Json -AsHashtable (ConvertTo-Json -Depth 15 $source)
    $target.Remove('host');$target.Remove('sourceStopped');$target.Remove('snapshotComplete')
    $target.host='43.131.245.43';$target.postgresMajor=18;$target.restoreComplete=$true
    return @{
        schemaVersion=1;complete=$true;source=$source;target=$target
        r2=@{accountId='0910a2f37a347c249c2dce42169b9b65';bucket='sanyulog-media';listComplete=$true
            publicDomainsDisabled=$true;anonymousExistingObjectStatus=403
            objects=@(@{key="v1/owner/$a";headBytes=40;headSha256=$b;getBytes=40;getSha256=$b})}
    }
}
function Reject([string]$name,[scriptblock]$mutate) {
    $f=Fixture;& $mutate $f
    $result=Test-SanyuMigrationEvidence $f
    Assert (-not $result.ok) "$name incorrectly accepted"
    Assert ($result.blockers.Count -gt 0) "$name returned no blocker"
    Write-Host "PASS reject: $name"
}
$valid=Test-SanyuMigrationEvidence (Fixture)
Assert $valid.ok 'valid complete evidence rejected'
Assert ($valid.evidenceOnly -and -not $valid.liveBytesVerified -and -not $valid.cutoverAuthorized) 'comparison falsely claimed live proof'
Reject 'source writable' {param($f) $f.source.sourceStopped=$false}
Reject 'incomplete snapshot' {param($f) $f.source.snapshotComplete=$false}
Reject 'wrong source identity' {param($f) $f.source.host='other'}
Reject 'wrong target identity' {param($f) $f.target.host='other'}
Reject 'string schema version' {param($f) $f.schemaVersion='1'}
Reject 'wrong PG major' {param($f) $f.target.postgresMajor=16}
Reject 'string PG major' {param($f) $f.target.postgresMajor='18'}
Reject 'changed snapshot' {param($f) $f.target.snapshotManifestSha256='f'*64}
Reject 'changed auth bytes' {param($f) $f.target.authDbSha256='f'*64}
Reject 'changed key bytes' {param($f) $f.target.storageKeySha256='f'*64}
Reject 'changed accounts hash' {param($f) $f.target.accountRowsSha256='f'*64}
Reject 'omitted disabled account' {param($f) $f.target.accounts=@($f.target.accounts[0])}
Reject 'enabled flag changed' {param($f) $f.target.accounts[1].enabled=$true}
Reject 'missing schema gained' {param($f) $f.target.accounts[1].initialized=$true}
Reject 'session hash changed' {param($f) $f.target.sessionRowsSha256='f'*64}
Reject 'session count changed' {param($f) $f.target.sessionCount=1}
Reject 'string session count' {param($f) $f.target.sessionCount='2'}
Reject 'database normalized hash changed' {param($f) $f.target.database[0].tables[0].normalizedSha256='e'*64}
Reject 'database table omitted' {param($f) $f.target.database[0].tables=@($f.target.database[0].tables[0])}
Reject 'attachment reference omitted' {param($f) $f.target.media=@()}
Reject 'local ciphertext hash changed' {param($f) $f.target.media[0].ciphertextSha256='f'*64}
Reject 'string ciphertext bytes' {param($f) $f.target.media[0].ciphertextBytes='40'}
Reject 'R2 object omitted' {param($f) $f.r2.objects=@()}
Reject 'R2 extra object' {param($f) $f.r2.objects+=@{key=('v1/owner/'+'f'*64);headBytes=1;headSha256='f'*64;getBytes=1;getSha256='f'*64}}
Reject 'R2 HEAD hash changed' {param($f) $f.r2.objects[0].headSha256='f'*64}
Reject 'R2 GET hash changed' {param($f) $f.r2.objects[0].getSha256='f'*64}
Reject 'R2 GET size changed' {param($f) $f.r2.objects[0].getBytes=39}
Reject 'R2 list incomplete' {param($f) $f.r2.listComplete=$false}
Reject 'R2 public domain' {param($f) $f.r2.publicDomainsDisabled=$false}
Reject 'R2 anonymous readable' {param($f) $f.r2.anonymousExistingObjectStatus=200}
Reject 'string anonymous status' {param($f) $f.r2.anonymousExistingObjectStatus='403'}
Reject 'wrong bucket' {param($f) $f.r2.bucket='other'}
Reject 'wrong account' {param($f) $f.r2.accountId='other'}
Reject 'invalid media key' {param($f) $f.source.media[0].key='v1/owner/other'}
Reject 'unknown media account' {param($f) $f.source.media[0].storageId='ffffffffffffffffffffffffffffffff'}
Reject 'uninitialized account has data' {param($f) $f.source.media[0].storageId=$f.source.accounts[1].storageId;$f.source.media[0].key='v1/'+$f.source.accounts[1].storageId+'/'+('a'*64)}
Reject 'unlisted database schema' {param($f) $f.source.database[0].schema='process_log_user_ffffffffffffffffffffffffffffffff'}
$temp=Join-Path ([IO.Path]::GetTempPath()) ('sanyu-migration-test-'+[guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($temp) | Out-Null
try {
    $path=Join-Path $temp 'evidence.json'
    [IO.File]::WriteAllText($path,((Fixture)|ConvertTo-Json -Depth 20),[Text.UTF8Encoding]::new($false))
    $output=& pwsh -NoProfile -File $sut -EvidencePath $path | ConvertFrom-Json -AsHashtable
    Assert ($LASTEXITCODE -eq 0 -and $output.ok -and $output.evidenceOnly -and -not $output.cutoverAuthorized) 'CLI status overclaims or rejects valid fixture'
    [IO.File]::WriteAllText($path,'{}',[Text.UTF8Encoding]::new($false))
    $output=& pwsh -NoProfile -File $sut -EvidencePath $path | ConvertFrom-Json -AsHashtable
    Assert ($LASTEXITCODE -eq 2 -and -not $output.ok) 'CLI accepted incomplete fixture'
} finally {
    $item=Get-Item -LiteralPath $temp -Force
    Assert ($item.Name -cmatch '^sanyu-migration-test-[a-f0-9]{32}$' -and $item.Parent.FullName -ceq ([IO.Path]::GetTempPath()).TrimEnd('\') -and -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) 'unsafe test cleanup'
    Remove-Item -LiteralPath $item.FullName -Recurse -ErrorAction Stop
}
Write-Host 'PASS verify-migration local fixtures'
