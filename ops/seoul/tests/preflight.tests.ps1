$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$sut = Join-Path $PSScriptRoot '../preflight.ps1'
if (-not (Test-Path -LiteralPath $sut)) { throw 'RED: preflight gate implementation is missing' }
. $sut
$script:passed = 0
function Assert-True($value, $message) { if (-not $value) { throw $message } }
function New-Fixture {
    # Independent, hand-authored observations; no production builders establish expected values.
    return @{
        observedAtUtc = '2026-10-08T12:00:00Z'
        release = @{ sha = '450f11d64ce8fa77f9968b870602f18d174937b8'; reconcileSha256 = ('a' * 64)
            run = @{ headSha = '450f11d64ce8fa77f9968b870602f18d174937b8'; databaseId = 37766550561L
                workflowName = 'Checks'; status = 'completed'; conclusion = 'success'; event = 'push'
                url = 'https://github.com/MansurnamedZhang/sanyulog/actions/runs/37766550561'
                jobs = @(@{ name = 'test'; status = 'completed'; conclusion = 'success'; steps=@(
                    @{name='Build exact checked-out application image';status='completed';conclusion='success'},
                    @{name='Verify private media modules in image without credentials';status='completed';conclusion='success'},
                    @{name='Record checked-out revision and built image ID';status='completed';conclusion='success'}) }) } }
        source = @{ complete = $true; host = '172.16.240.13'; health = $true; containerHealthy = $true
            backupReadable = $true; backupFileCount = 4; backupManifestSha256 = ('b' * 64)
            counts = @{ accounts = 2; enabledAccounts = 1; sessions = 3; initializedSchemas = 1; projects = 7; notebooks = 21; attachments = 20 }
            imageId = ('sha256:' + ('c' * 64)); diskAvailableBytes = 20000000000L; memoryAvailableBytes = 4000000000L
            containers = @('process-log|running|healthy'); ports = @(8765); sites = @('existing.example')
            dockerTcpHostPorts=@(8765); dockerPortInventoryComplete=$true; dockerOk=$true
            volumes=@('source_data'); networks=@('bridge'); nginxChecked=$true; nginxStatus='installed'; nginxOk=$true }
        target = @{ complete = $true; host = '43.131.245.43'; nginxOk = $true; dockerOk = $true
            diskAvailableBytes = 20000000000L; memoryAvailableBytes = 2000000000L
            containers = @('other|running|healthy'); ports = @(22,80,443); sites = @('existing.example'); volumes=@('other_data'); networks=@('bridge')
            dockerTcpHostPorts=@(); dockerPortInventoryComplete=$true
            paths = @(@{path='/home/ubuntu/apps/sanyulog'; exists=$false; unsafeAncestor=$false},
                      @{path='/home/ubuntu/backups/sanyulog'; exists=$false; unsafeAncestor=$false},
                      @{path='/etc/nginx/sites-available/notes.896364.xyz.conf'; exists=$false; unsafeAncestor=$false},
                      @{path='/etc/nginx/sites-enabled/notes.896364.xyz.conf'; exists=$false; unsafeAncestor=$false}) }
        cloudflare = @{ observedAtUtc = '2026-10-08T12:00:00Z'; provenance = 'controller-attested-read-only'; complete = $true
            accountId = '0910a2f37a347c249c2dce42169b9b65'; zoneId = '67edc27e351abaa1eee7d945a5b0b0f8'; zoneName = '896364.xyz'; zoneStatus = 'active'
            dns = @(@{name='other.896364.xyz'; type='A'}); buckets = @(@{name='other-bucket'}) }
    }
}
function Evaluate($fixture) {
    Test-SeoulPreflight -Snapshot $fixture -ExpectedSha '450f11d64ce8fa77f9968b870602f18d174937b8' -Now ([datetimeoffset]'2026-10-08T12:01:00Z')
}
function Case($name, [scriptblock]$body) { & $body; $script:passed++; Write-Host "PASS $name" }
function Reject($name, [scriptblock]$mutate, $code) {
    Case $name { $f = New-Fixture; & $mutate $f; $r = Evaluate $f
        Assert-True (-not $r.readyForStaging) "$name incorrectly passed"
        Assert-True ($r.blockers -contains $code) "$name missing blocker $code"
    }.GetNewClosure()
}
Case 'complete exact release and isolated observations permit staging only' {
    $r = Evaluate (New-Fixture)
    Assert-True $r.readyForStaging 'valid evidence rejected'
    Assert-True (-not $r.deploymentAuthorized) 'preflight must never authorize deployment'
}
Reject 'failed Checks' { param($f) $f.release.run.conclusion='failure' } 'release_checks'
Reject 'pending Checks' { param($f) $f.release.run.status='in_progress' } 'release_checks'
Reject 'different run SHA' { param($f) $f.release.run.headSha=('f'*40) } 'release_checks'
Reject 'different local SHA' { param($f) $f.release.sha=('f'*40) } 'release_sha'
Reject 'wrong workflow' { param($f) $f.release.run.workflowName='other' } 'release_checks'
Reject 'wrong repository run URL' { param($f) $f.release.run.url='https://github.com/other/repo/actions/runs/37766550561' } 'release_checks'
Reject 'empty job list' { param($f) $f.release.run.jobs=@() } 'release_checks'
Reject 'skipped job' { param($f) $f.release.run.jobs[0].conclusion='skipped' } 'release_checks'
Reject 'missing reconcile baseline' { param($f) $f.release.Remove('reconcileSha256') } 'release_artifact'
Reject 'occupied DNS mixed case and trailing dot' { param($f) $f.cloudflare.dns+=@{name='Notes.896364.xyz.';type='CNAME'} } 'cloudflare_collision'
Reject 'occupied bucket' { param($f) $f.cloudflare.buckets+=@{name='sanyulog-media'} } 'cloudflare_collision'
Reject 'wrong account' { param($f) $f.cloudflare.accountId=('0'*32) } 'cloudflare_identity'
Reject 'wrong zone' { param($f) $f.cloudflare.zoneId=('0'*32) } 'cloudflare_identity'
Reject 'inactive zone' { param($f) $f.cloudflare.zoneStatus='pending' } 'cloudflare_identity'
Reject 'incomplete pagination' { param($f) $f.cloudflare.complete=$false } 'cloudflare_incomplete'
Reject 'stale Cloudflare evidence' { param($f) $f.cloudflare.observedAtUtc='2026-10-08T11:00:00Z' } 'cloudflare_stale'
Reject 'future Cloudflare evidence' { param($f) $f.cloudflare.observedAtUtc='2026-10-08T13:00:00Z' } 'cloudflare_stale'
Reject 'absent Cloudflare evidence' { param($f) $f.Remove('cloudflare') } 'cloudflare_incomplete'
Reject 'missing bucket list' { param($f) $f.cloudflare.Remove('buckets') } 'cloudflare_incomplete'
Reject 'occupied port' { param($f) $f.target.ports+=18765 } 'target_port'
Reject 'occupied project path' { param($f) $f.target.paths[0].exists=$true } 'target_paths'
Reject 'missing target path observation' { param($f) $f.target.paths=@() } 'target_paths'
Reject 'symlink ancestor' { param($f) $f.target.paths[0].unsafeAncestor=$true } 'target_paths'
Reject 'occupied Nginx server name' { param($f) $f.target.sites+='notes.896364.xyz' } 'target_site'
Reject 'occupied container' { param($f) $f.target.containers+='sanyulog-app|running|healthy' } 'target_container'
Reject 'Nginx test failed' { param($f) $f.target.nginxOk=$false } 'target_services'
Reject 'Docker query failed' { param($f) $f.target.dockerOk=$false } 'target_services'
Reject 'disk too small' { param($f) $f.target.diskAvailableBytes=1024 } 'target_resources'
Reject 'memory too small' { param($f) $f.target.memoryAvailableBytes=1024 } 'target_resources'
Reject 'failed target probe' { param($f) $f.target=@{complete=$false} } 'target_incomplete'
Reject 'wrong target host' { param($f) $f.target.host='127.0.0.1' } 'target_incomplete'
Reject 'source backup unreadable' { param($f) $f.source.backupReadable=$false } 'source_backup'
Reject 'empty source backup' { param($f) $f.source.backupFileCount=0 } 'source_backup'
Reject 'source unhealthy' { param($f) $f.source.health=$false } 'source_health'
Reject 'counts missing' { param($f) $f.source.counts.Remove('sessions') } 'source_counts'
Reject 'negative counts' { param($f) $f.source.counts.accounts=-1 } 'source_counts'
Reject 'unprobed source' { param($f) $f.source=@{complete=$false} } 'source_incomplete'
Reject 'snapshot stale' { param($f) $f.observedAtUtc='2026-10-08T09:00:00Z' } 'snapshot_stale'
Case 'untrusted fields never enter manifest' {
    $f=New-Fixture; $f.secret='secret-canary'; $f.source.DATABASE_URL='secret-canary'; $f.release.run.extra='secret-canary'
    $json = Evaluate $f | ConvertTo-Json -Depth 20
    Assert-True (-not $json.Contains('secret-canary')) 'unknown fields leaked'
}
Case 'bad diagnostic strings are dropped, not echoed' {
    $f=New-Fixture; $f.target.containers=@('DATABASE_URL=secret-canary'); $f.target.sites=@('Cookie: secret-canary')
    $json = Evaluate $f | ConvertTo-Json -Depth 20
    Assert-True (-not $json.Contains('secret-canary')) 'invalid strings leaked'
}
Case 'host collector accepts exact approved dotted backup name and locks SSH options' {
    function Invoke-CheckedNative($Command,$Arguments,$InputText) {
        Assert-True ($Command -eq 'ssh') 'wrong transport'
        foreach ($required in @('BatchMode=yes','IdentitiesOnly=yes','StrictHostKeyChecking=yes','hans@172.16.240.13','python3 -B -')) {
            Assert-True ($Arguments -contains $required) "unsafe transport: missing $required"
        }
        return '{"complete":true}'
    }
    $r=Get-SeoulHostObservation source '' '/home/hans/services/process-log/backups/v0.11.1-20261008-161548'
    Assert-True $r.complete 'valid backup refused before read-only transport'
}
Case 'native reader preserves exact trailing LF when hashing release artifact' {
    $out=Invoke-CheckedNative pwsh @('-NoProfile','-Command','[Console]::Write("hello`n")') -PreserveOutput
    Assert-True ($out -ceq "hello`n") 'release artifact bytes changed'
}
Reject 'string true is not verified boolean' { param($f) $f.target.complete='True' } 'target_incomplete'
Reject 'malformed port list is incomplete' { param($f) $f.target.ports=@('secret-canary') } 'target_port'
Reject 'malformed service listing is incomplete' { param($f) $f.target.containers=@('DATABASE_URL=secret-canary') } 'target_container'
Reject 'malformed site listing is incomplete' { param($f) $f.target.sites=@('Cookie: secret-canary') } 'target_site'
Reject 'missing image build evidence' { param($f) $f.release.run.jobs[0].steps=@() } 'release_image'
Reject 'skipped image import check' { param($f) $f.release.run.jobs[0].steps[1].conclusion='skipped' } 'release_image'
Reject 'existing dedicated volume' { param($f) $f.target.volumes+= 'sanyulog_postgres' } 'target_storage'
Reject 'existing dedicated network' { param($f) $f.target.networks+= 'sanyulog_default' } 'target_storage'
Reject 'missing volume inventory' { param($f) $f.target.Remove('volumes') } 'target_storage'
Reject 'null site inventory' { param($f) $f.target.sites=$null } 'target_site'
Reject 'wildcard Nginx name covers requested domain' { param($f) $f.target.sites+= '*.896364.xyz' } 'target_site'
Case 'native failure suppresses stderr secrets' {
    try { Invoke-CheckedNative pwsh @('-NoProfile','-Command','[Console]::Error.Write("secret-canary"); exit 7'); throw 'did not reject failure' }
    catch { Assert-True ($_.Exception.Message -ceq 'read_only_probe_failed') 'raw native exception leaked' }
}
Case 'target collector refuses unparsed Nginx server names instead of asserting domain absence' {
    $native=${function:Invoke-CheckedNative}
    function Invoke-CheckedNative($Command,$Arguments,$InputText) { $script:targetProbe=$InputText; return '{}' }
    Get-SeoulHostObservation target '' '/home/hans/services/process-log/backups/v0.11.1-20261008-161548' | Out-Null
    $harness=@'
import contextlib, io, json, subprocess, sys
from unittest.mock import patch
code=sys.stdin.read()
site='existing.example'
def fake(args, **kwargs):
    values={
        ('docker','ps','-a','--no-trunc','--format','{{json .}}'):'',
        ('docker','ps','-a','--no-trunc','--format','{{.ID}}'):'',
        ('docker','volume','ls','--format','{{.Name}}'):'',
        ('docker','network','ls','--format','{{.Name}}'):'bridge\n',
        ('ss','-H','-ltn'):'LISTEN 0 128 0.0.0.0:22 0.0.0.0:*\n',
        ('free','-b'):'total used free shared buff/cache available\nMem: 8000000000 1 1 1 1 7000000000\n',
        ('sudo','-n','nginx','-t'):'',
        ('sudo','-n','nginx','-T'):'server { listen 80; server_name '+site+'; }\n'
    }
    if args[:2]==['df','-Pk']: output='Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/test 30000000 1 20000000 1% /\n'
    else: output=values[tuple(args)]
    return subprocess.CompletedProcess(args,0,output,'')
for site,want in [('existing.example',True),('~^notes[.]896364[.]xyz$',False)]:
    output=io.StringIO()
    with patch('subprocess.run',fake),contextlib.redirect_stdout(output):
        try: exec(compile(code,'target-probe','exec'),{})
        except SystemExit as error:
            if error.code!=1: raise
    observed=json.loads(output.getvalue())
    assert observed['complete'] is want
    if want: assert observed['sites']==['existing.example']
'@
    & $native (Join-Path $PSScriptRoot '../../../.venv/Scripts/python.exe') @('-B','-c',$harness) $script:targetProbe | Out-Null
}
Case 'unreadable backup subdirectory cannot yield a successful partial backup hash' {
    $native=${function:Invoke-CheckedNative}
    function Invoke-CheckedNative($Command,$Arguments,$InputText) { $script:sourceProbe=$InputText; return '{}' }
    Get-SeoulHostObservation source '' '/home/hans/services/process-log/backups/v0.11.1-20261008-161548' | Out-Null
    $harness=@'
import contextlib, io, json, os, pathlib, subprocess, sys
from unittest.mock import patch
code=sys.stdin.read()
walk_called=False
def fake(args, **kwargs):
    if args[:2]==['df','-Pk']: value='Filesystem blocks Used Available Capacity Mounted\n/dev/test 30000000 1 20000000 1% /\n'
    elif args[0]=='free': value='total used free shared buff/cache available\nMem: 8000000000 1 1 1 1 7000000000\n'
    elif args[:2]==['docker','ps'] or args[0]=='ss': value=''
    elif args[:3] in (['docker','volume','ls'],['docker','network','ls']): value=''
    elif args[0]=='dpkg-query': value='bash\tinstalled\n'
    elif args[:2]==['docker','inspect']:
        value='{"Status":"running","Health":{"Status":"healthy"}}' if args[3]=='{{json .State}}' else 'sha256:'+'a'*64
    elif args[0]=='curl': value='{"ok":true}'
    elif args[:2]==['docker','exec']: value='{"accounts":2,"enabledAccounts":1,"sessions":4,"initializedSchemas":1,"projects":7,"notebooks":21,"attachments":20}'
    else: raise AssertionError('unexpected command')
    return subprocess.CompletedProcess(args,0,value,'')
def walk(path, followlinks=False, onerror=None):
    global walk_called
    walk_called=True
    yield str(path),[],['readable.backup']
    if onerror: onerror(PermissionError('unreadable child'))
output=io.StringIO()
with patch('subprocess.run',fake),patch('shutil.which',return_value=None),patch('os.walk',walk),patch.object(pathlib.Path,'is_dir',return_value=True),patch.object(pathlib.Path,'is_file',lambda p:not str(p).replace('\\','/').endswith('/usr/sbin/nginx')),patch.object(pathlib.Path,'is_symlink',return_value=False),patch.object(pathlib.Path,'open',side_effect=lambda *a,**k:io.BytesIO(b'fixture')),contextlib.redirect_stdout(output):
    try: exec(compile(code,'source-probe','exec'),{})
    except SystemExit as error:
        if error.code!=1: raise
assert json.loads(output.getvalue())['complete'] is False
assert walk_called
'@
    & $native (Join-Path $PSScriptRoot '../../../.venv/Scripts/python.exe') @('-B','-c',$harness) $script:sourceProbe | Out-Null
}
Case 'structural Docker NAT and stopped bindings reach the port gate independently of ss' {
    $native=${function:Invoke-CheckedNative}
    function Invoke-CheckedNative($Command,$Arguments,$InputText) { $script:bindingProbe=$InputText; return '{}' }
    Get-SeoulHostObservation target '' '/home/hans/services/process-log/backups/v0.11.1-20261008-161548' | Out-Null
    $harness=@'
import contextlib, io, json, subprocess, sys
from unittest.mock import patch
data=json.load(sys.stdin); mode=data['mode']; identifier='a'*64
def fake(args, **kwargs):
    if args[:2]==['docker','ps']:
        if args[-1]=='{{.ID}}': output=identifier+'\n'
        else: output=json.dumps({'ID':identifier,'Names':'other','State':'exited' if mode=='stopped' else 'running','Status':'Exited (0)' if mode=='stopped' else 'Up 1 hour','Ports':'127.0.0.1:18765->80/tcp'})+'\n'
    elif args[:2]==['docker','inspect']:
        assert args[2]=='--format' and '.Env' not in args[3] and args[4:]==[identifier]
        if mode=='inspect-failed': return subprocess.CompletedProcess(args,1,'','private-error')
        if mode=='inspect-missing': output=''
        else:
            binding=[{'HostIp':'127.0.0.1','HostPort':'8080' if mode=='safe' else '18765'}]
            output=json.dumps({'id':identifier,'configured':{'80/tcp':binding},'active':{} if mode=='stopped' else {'80/tcp':binding}})+'\n'
    elif args[:3]==['docker','volume','ls']: output='other_data\n'
    elif args[:3]==['docker','network','ls']: output='bridge\n'
    elif args[0]=='ss': output='LISTEN 0 128 0.0.0.0:22 0.0.0.0:*\n'
    elif args[0]=='free': output='total used free shared buff/cache available\nMem: 8000000000 1 1 1 1 7000000000\n'
    elif args[:2]==['df','-Pk']: output='Filesystem blocks Used Available Capacity Mounted\n/dev/test 30000000 1 20000000 1% /\n'
    elif args==['sudo','-n','nginx','-t']: output=''
    elif args==['sudo','-n','nginx','-T']: output='server_name existing.example;\n'
    else: raise AssertionError('unexpected read-only command')
    return subprocess.CompletedProcess(args,0,output,'')
output=io.StringIO()
with patch('subprocess.run',fake),contextlib.redirect_stdout(output):
    try: exec(compile(data['code'],'target-probe','exec'),{})
    except SystemExit as error:
        if error.code!=1: raise
print(output.getvalue())
'@
    foreach ($mode in @('nat','stopped','safe','inspect-failed','inspect-missing')) {
        $payload=@{code=$script:bindingProbe;mode=$mode} | ConvertTo-Json -Compress
        $collected=& $native (Join-Path $PSScriptRoot '../../../.venv/Scripts/python.exe') @('-B','-c',$harness) $payload | ConvertFrom-Json -AsHashtable
        $f=New-Fixture; $f.target=$collected; $r=Evaluate $f
        if ($mode -eq 'safe') { Assert-True $r.readyForStaging 'safe structural binding refused' }
        else {
            Assert-True (-not $r.readyForStaging) "$mode escaped Docker port gate"
            if ($mode -in @('nat','stopped')) { Assert-True ($r.blockers -contains 'target_port') "$mode missing port blocker" }
            else { Assert-True ($r.blockers -contains 'target_incomplete') "$mode missing incomplete blocker" }
        }
    }
}
Reject 'missing Docker port inventory' { param($f) $f.target.Remove('dockerTcpHostPorts') } 'target_port'
Reject 'incomplete Docker port inventory' { param($f) $f.target.dockerPortInventoryComplete=$false } 'target_port'
foreach ($field in @('containers','ports','sites','volumes','networks','imageId','dockerOk','dockerTcpHostPorts','dockerPortInventoryComplete','nginxChecked','nginxStatus','nginxOk','diskAvailableBytes','memoryAvailableBytes')) {
    Reject "source missing $field" { param($f) $f.source.Remove($field) }.GetNewClosure() 'source_baseline'
}
Reject 'source null port list' { param($f) $f.source.ports=$null } 'source_baseline'
Reject 'source scalar service listing' { param($f) $f.source.containers='process-log|running|healthy' } 'source_baseline'
Reject 'source process-log absent from observed service set' { param($f) $f.source.containers=@('other|running|healthy') } 'source_baseline'
Reject 'source unqueried Nginx cannot claim absence' { param($f) $f.source.nginxStatus='unknown' } 'source_baseline'
Reject 'source absent Nginx cannot contain fabricated sites' { param($f) $f.source.nginxStatus='not-installed';$f.source.nginxOk=$false } 'source_baseline'
Case 'explicit checked Nginx absence is distinct from unqueried' {
    $f=New-Fixture;$f.source.nginxStatus='not-installed';$f.source.nginxOk=$false;$f.source.sites=@()
    $r=Evaluate $f; Assert-True $r.readyForStaging 'verified Nginx absence rejected'
    Assert-True ($r.source.nginxStatus -eq 'not-installed') 'manifest lost absence evidence'
}
Case 'source collector records queried nginx state and actual volume network lists' {
    $native=${function:Invoke-CheckedNative}
    function Invoke-CheckedNative($Command,$Arguments,$InputText) { $script:baselineProbe=$InputText; return '{}' }
    Get-SeoulHostObservation source '' '/home/hans/services/process-log/backups/v0.11.1-20261008-161548' | Out-Null
    $harness=@'
import contextlib, io, json, pathlib, shutil, subprocess, sys
from unittest.mock import patch
data=json.load(sys.stdin); mode=data['mode']; identifier='a'*64
def fake(args, **kwargs):
    if args[:2]==['df','-Pk']: value='Filesystem blocks Used Available Capacity Mounted\n/dev/test 30000000 1 20000000 1% /\n'
    elif args[0]=='free': value='total used free shared buff/cache available\nMem: 8000000000 1 1 1 1 7000000000\n'
    elif args[:2]==['docker','ps']:
        value=identifier+'\n' if args[-1]=='{{.ID}}' else json.dumps({'ID':identifier,'Names':'process-log','State':'running','Status':'Up 1 hour (healthy)'})+'\n'
    elif args[0]=='ss': value='LISTEN 0 128 127.0.0.1:8765 0.0.0.0:*\n'
    elif args[:2]==['docker','inspect']:
        if args[3]=='{{json .State}}': value='{"Status":"running","Health":{"Status":"healthy"}}'
        elif args[3]=='{{.Image}}': value='sha256:'+'a'*64
        else: value=json.dumps({'id':identifier,'configured':{'8765/tcp':[{'HostIp':'127.0.0.1','HostPort':'8765'}]},'active':{}})
    elif args[:3]==['docker','volume','ls']: value='source_pg_data\n'
    elif args[:3]==['docker','network','ls']: value='source_default\n'
    elif args[0]=='dpkg-query':
        if mode=='unknown': return subprocess.CompletedProcess(args,1,'','private-error')
        value='nginx\tinstalled\n' if mode=='installed' else 'bash\tinstalled\n'
    elif args[:3]==['sudo','-n','nginx']: value='server_name source.example;\n' if args[-1]=='-T' else ''
    elif args[0]=='curl': value='{"ok":true}'
    elif args[:2]==['docker','exec']: value='{"accounts":2,"enabledAccounts":1,"sessions":4,"initializedSchemas":1,"projects":7,"notebooks":21,"attachments":20}'
    else: raise AssertionError('unexpected command')
    return subprocess.CompletedProcess(args,0,value,'')
def walk(path, **kwargs): yield str(path),[],['readable.backup']
def is_file(path): return False if str(path).replace('\\','/')=='/usr/sbin/nginx' else True
output=io.StringIO()
with patch('subprocess.run',fake),patch('shutil.which',return_value='nginx' if mode=='installed' else None),patch('os.walk',walk),patch.object(pathlib.Path,'is_dir',return_value=True),patch.object(pathlib.Path,'is_file',is_file),patch.object(pathlib.Path,'is_symlink',return_value=False),patch.object(pathlib.Path,'open',side_effect=lambda *a,**k:io.BytesIO(b'fixture')),contextlib.redirect_stdout(output):
    try: exec(compile(data['code'],'source-probe','exec'),{})
    except SystemExit as error:
        if error.code!=1: raise
print(output.getvalue())
'@
    foreach ($mode in @('absent','installed','unknown')) {
        $payload=@{code=$script:baselineProbe;mode=$mode} | ConvertTo-Json -Compress
        $source=& $native (Join-Path $PSScriptRoot '../../../.venv/Scripts/python.exe') @('-B','-c',$harness) $payload | ConvertFrom-Json -AsHashtable
        $f=New-Fixture; $f.source=$source; $r=Evaluate $f
        if ($mode -eq 'unknown') { Assert-True (-not $r.readyForStaging) 'unavailable Nginx query escaped'; continue }
        Assert-True $r.readyForStaging "observed source $mode baseline refused"
        Assert-True ($r.source.volumes -contains 'source_pg_data') 'lost queried volume'
        Assert-True ($r.source.networks -contains 'source_default') 'lost queried network'
        Assert-True ($r.source.nginxStatus -eq $(if ($mode -eq 'absent') {'not-installed'} else {'installed'})) 'wrong observed nginx state'
    }
}
foreach ($role in @('target','source')) {
    foreach ($field in @('diskAvailableBytes','memoryAvailableBytes')) {
        foreach ($value in @([double]::NaN,[double]::PositiveInfinity,[double]::NegativeInfinity,[double]20000000000,-1,$true,$false,'20000000000',[uint64]::MaxValue)) {
            $code=if ($role -eq 'source') {'source_baseline'} else {'target_resources'}
            Reject "$role $field rejects $($value.GetType().Name):$value" { param($f) $f[$role][$field]=$value }.GetNewClosure() $code
        }
    }
}
Write-Host "GREEN: $script:passed preflight behavioral tests passed (fake observations; no network)."
