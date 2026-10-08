#Requires -Version 7.2
[CmdletBinding()]
param([string]$ConfigDirectory = (Join-Path $PSScriptRoot '..'))
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:passed = 0
function Assert-True($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Case([string]$Name, [scriptblock]$Body) {
    & $Body
    $script:passed++
    Write-Host "PASS $Name"
}
function Assert-Keys($Map, [string[]]$Expected, [string]$Message) {
    Assert-True (($Map.Keys | Sort-Object) -join ',' -ceq ($Expected | Sort-Object) -join ',') $Message
}

# JSON is a YAML 1.2 subset: parse the actual Compose artifact without dependencies
# or opening env_file / bind sources. These are structural contracts, not a claim
# that Docker Compose or Nginx has executed on the target host.
$composePath = Join-Path $ConfigDirectory 'docker-compose.yml'
$nginxPath = Join-Path $ConfigDirectory 'notes.896364.xyz.conf'
Case 'required isolated Compose exists' { Assert-True (Test-Path -LiteralPath $composePath -PathType Leaf) 'RED: Compose artifact missing' }
Case 'required maintenance Nginx template exists' { Assert-True (Test-Path -LiteralPath $nginxPath -PathType Leaf) 'RED: Nginx artifact missing' }
$raw = Get-Content -Raw -LiteralPath $composePath
$compose = $raw | ConvertFrom-Json -AsHashtable
$projectExpression = '${SANYU_PROJECT:?Select sanyulog-fixture or sanyulog}'
$imageExpression = '${SANYU_IMAGE_ID:?Set verified local sha256 image ID}'
$gatewayExpression = '${SANYU_PROXY_IP:?Set observed dedicated bridge gateway IP}'
Case 'only app and PostgreSQL share a dedicated non-external network and volume' {
    Assert-Keys $compose @('name','services','networks','volumes') 'unexpected top-level sharing or extension'
    Assert-True ($compose.name -ceq $projectExpression) 'project must be explicitly selected'
    Assert-Keys $compose.services @('app','postgres') 'unexpected service'
    Assert-Keys $compose.networks @('private') 'unexpected network'
    Assert-Keys $compose.networks.private @('driver') 'network must not be external or globally named'
    Assert-True ($compose.networks.private.driver -ceq 'bridge') 'dedicated bridge required for server R2 egress'
    Assert-Keys $compose.volumes @('pgdata') 'unexpected volume'
    Assert-True ($compose.volumes.pgdata.Count -eq 0) 'database volume must be project scoped'
    foreach ($service in $compose.services.Values) {
        Assert-True (($service.networks -join ',') -ceq 'private') 'service escaped dedicated network'
        foreach ($field in @('network_mode','container_name','privileged','devices','volumes_from','extends','include','build','entrypoint','command','env_file_secret')) {
            Assert-True (-not $service.ContainsKey($field)) "unsafe service override: $field"
        }
    }
}
$app = $compose.services.app
$db = $compose.services.postgres
Case 'application publishes only the approved loopback TCP socket' {
    Assert-True (($app.ports -join ',') -ceq '127.0.0.1:18765:8765') 'application must only bind loopback 18765'
    Assert-True (-not $db.ContainsKey('ports')) 'PostgreSQL must not publish ports'
}
Case 'application requires a preverified local image and cannot silently pull or build' {
    Assert-True ($app.image -ceq $imageExpression -and $app.pull_policy -ceq 'never') 'local image identity required'
    Assert-True ($app.user -ceq '1000:1000') 'application must use image UID 1000'
    Assert-True ($app.read_only -eq $true) 'application image filesystem must be read-only'
    Assert-True (($app.cap_drop -join ',') -ceq 'ALL') 'unexpected app capabilities'
    Assert-True (($app.security_opt -join ',') -ceq 'no-new-privileges:true') 'privilege escalation must be disabled'
    Assert-True ($app.depends_on.postgres.condition -ceq 'service_healthy') 'database readiness required'
}
Case 'environment matches server interface with secure auth and fixed private R2 scope' {
    Assert-Keys $app.environment @('PROCESS_LOG_HOST','PROCESS_LOG_PORT','PROCESS_LOG_DATA','PROCESS_LOG_AUTH_ENABLED','PROCESS_LOG_AUTH_DB','PROCESS_LOG_ATTACHMENTS','PROCESS_LOG_ENCRYPTION_KEY_FILE','PROCESS_LOG_COOKIE_SECURE','PROCESS_LOG_ALLOWED_ORIGINS','PROCESS_LOG_TRUSTED_PROXIES','PROCESS_LOG_R2_ACCOUNT_ID','PROCESS_LOG_R2_BUCKET','PROCESS_LOG_R2_CREDENTIALS_FILE') 'unexpected environment including possible secret/public config'
    $want = @{
        PROCESS_LOG_HOST='0.0.0.0'; PROCESS_LOG_PORT='8765'; PROCESS_LOG_DATA='/state'
        PROCESS_LOG_AUTH_ENABLED='1'; PROCESS_LOG_AUTH_DB='/auth/auth.db'; PROCESS_LOG_ATTACHMENTS='/attachments'
        PROCESS_LOG_ENCRYPTION_KEY_FILE='/run/secrets/storage.key'; PROCESS_LOG_COOKIE_SECURE='1'
        PROCESS_LOG_ALLOWED_ORIGINS='https://notes.896364.xyz,http://127.0.0.1:18765'
        PROCESS_LOG_TRUSTED_PROXIES=$gatewayExpression
        PROCESS_LOG_R2_ACCOUNT_ID='0910a2f37a347c249c2dce42169b9b65'; PROCESS_LOG_R2_BUCKET='sanyulog-media'
        PROCESS_LOG_R2_CREDENTIALS_FILE='/run/secrets/r2.json'
    }
    foreach ($key in $want.Keys) { Assert-True ($app.environment[$key] -ceq $want[$key]) "incorrect interface: $key" }
    Assert-True (($app.env_file -join ',') -ceq "/home/ubuntu/apps/$projectExpression/runtime/app.env") 'database secret must come from selected restricted file'
}
Case 'all five app mounts are explicit, preexisting and slot-contained; only secret mounts read-only' {
    Assert-True ($app.volumes.Count -eq 5) 'unexpected application mount'
    $expected = @{
        '/auth'=@('auth',$false); '/attachments'=@('attachments',$false); '/state'=@('state',$false)
        '/run/secrets/storage.key'=@('secrets/storage.key',$true); '/run/secrets/r2.json'=@('secrets/r2.json',$true)
    }
    $seen = @{}
    foreach ($mount in $app.volumes) {
        Assert-Keys $mount @('type','source','target','read_only','bind') 'unexpected bind option'
        Assert-True ($expected.ContainsKey($mount.target) -and -not $seen.ContainsKey($mount.target)) 'unexpected or duplicate mount destination'
        $seen[$mount.target]=$true
        $wanted=$expected[$mount.target]
        Assert-True ($mount.type -ceq 'bind' -and $mount.source -ceq "/home/ubuntu/apps/$projectExpression/$($wanted[0])") 'mount escapes selected slot'
        Assert-True ($mount.read_only -is [bool] -and $mount.read_only -eq $wanted[1]) 'wrong mount read/write mode'
        Assert-Keys $mount.bind @('create_host_path') 'unexpected bind behavior'
        Assert-True ($mount.bind.create_host_path -eq $false) 'missing files must not become directories'
    }
}
Case 'PostgreSQL 16 stores data in its project volume and loads password from a read-only file' {
    Assert-True ($db.image -ceq 'postgres:16-bookworm') 'PostgreSQL major must remain 16'
    Assert-Keys $db.environment @('POSTGRES_USER','POSTGRES_DB','POSTGRES_PASSWORD_FILE') 'no literal password or trust authentication'
    Assert-True ($db.environment.POSTGRES_USER -ceq 'sanyulog') 'unexpected database role'
    Assert-True ($db.environment.POSTGRES_DB -ceq $projectExpression) 'fixture and restored database identities must differ'
    Assert-True ($db.environment.POSTGRES_PASSWORD_FILE -ceq '/run/secrets/postgres-password') 'file password required'
    Assert-True ($db.volumes.Count -eq 2) 'unexpected PostgreSQL mount'
    $data=$db.volumes[0]; $secret=$db.volumes[1]
    Assert-True ($data.type -ceq 'volume' -and $data.source -ceq 'pgdata' -and $data.target -ceq '/var/lib/postgresql/data') 'database persistent storage escaped project'
    Assert-True ($secret.type -ceq 'bind' -and $secret.source -ceq "/home/ubuntu/apps/$projectExpression/secrets/postgres-password" -and $secret.target -ceq '/run/secrets/postgres-password' -and $secret.read_only -eq $true -and $secret.bind.create_host_path -eq $false) 'unsafe database secret mount'
    Assert-True (($db.healthcheck.test -join ' ') -ceq 'CMD-SHELL pg_isready -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"') 'healthcheck must avoid password and check selected database'
    Assert-True ($db.healthcheck.interval -ceq '10s' -and $db.healthcheck.timeout -ceq '5s' -and $db.healthcheck.retries -eq 5) 'bounded database readiness required'
}
Case 'fixture and production render to disjoint local storage and Docker identities' {
    # Only substitute nonsecret project names; never resolve a real runtime env.
    $fixture=$raw.Replace($projectExpression,'sanyulog-fixture') | ConvertFrom-Json -AsHashtable
    $production=$raw.Replace($projectExpression,'sanyulog') | ConvertFrom-Json -AsHashtable
    Assert-True ($fixture.name -ceq 'sanyulog-fixture' -and $production.name -ceq 'sanyulog') 'wrong project split'
    Assert-True ($fixture.services.postgres.environment.POSTGRES_DB -cne $production.services.postgres.environment.POSTGRES_DB) 'shared database name'
    $fixtureSources=@($fixture.services.app.volumes.source) + @($fixture.services.postgres.volumes | Where-Object type -EQ 'bind' | ForEach-Object source)
    $productionSources=@($production.services.app.volumes.source) + @($production.services.postgres.volumes | Where-Object type -EQ 'bind' | ForEach-Object source)
    foreach ($path in $fixtureSources) {
        Assert-True ($path.StartsWith('/home/ubuntu/apps/sanyulog-fixture/') -and $path -cnotin $productionSources) 'fixture storage overlaps restored data'
    }
}
Case 'runtime and credentials remain ignored by Git' {
    $repo=(Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    foreach ($path in @('ops/seoul/runtime/app.env','ops/seoul/secrets/r2.json','ops/seoul/secrets/storage.key')) {
        & git -C $repo check-ignore --quiet -- $path
        Assert-True ($LASTEXITCODE -eq 0) 'runtime secret path not ignored'
    }
}

# Parse the executable directive tree, not source-line presence. This deliberately
# accepts a small template grammar and rejects unsupported syntax; nginx -t and
# real HTTPS requests remain mandatory host gates. Quoted HTML stays one token.
function Read-NginxTree([string]$Text) {
    $clean=[regex]::Replace($Text,'(?m)^\s*#.*$','')
    $tokens=@([regex]::Matches($clean,'"(?:\\.|[^"\\])*"|''(?:\\.|[^''\\])*''|[{};]|[^\s{};]+') | ForEach-Object Value)
    $cursor=@{i=0}
    function Read-Block([bool]$Nested) {
        $nodes=[Collections.Generic.List[object]]::new()
        while ($cursor.i -lt $tokens.Count) {
            if ($tokens[$cursor.i] -ceq '}') {
                Assert-True $Nested 'unmatched closing brace'
                $cursor.i++; return ,$nodes.ToArray()
            }
            $words=[Collections.Generic.List[string]]::new()
            while ($cursor.i -lt $tokens.Count -and $tokens[$cursor.i] -cnotin @(';','{','}')) { $words.Add($tokens[$cursor.i]); $cursor.i++ }
            Assert-True ($words.Count -gt 0 -and $cursor.i -lt $tokens.Count) 'invalid directive'
            $end=$tokens[$cursor.i]; $cursor.i++
            Assert-True ($end -cin @(';','{')) 'unterminated directive'
            $children=@()
            if ($end -ceq '{') { $children=Read-Block $true }
            $nodes.Add(@{name=$words[0]; args=@($words | Select-Object -Skip 1); children=$children})
        }
        Assert-True (-not $Nested) 'unclosed directive block'
        return ,$nodes.ToArray()
    }
    return ,(Read-Block $false)
}
function Named($Nodes,[string]$Name) { return @($Nodes | Where-Object name -CEQ $Name) }
function All-Nodes($Nodes) { foreach ($n in $Nodes) { $n; if ($n.children.Count) { All-Nodes $n.children } } }
$nginx=Get-Content -Raw -LiteralPath $nginxPath
$servers=Read-NginxTree $nginx
Case 'only this domain has HTTP/HTTPS servers with no default host or extra include' {
    Assert-True ($servers.Count -eq 2 -and @(Named $servers 'server').Count -eq 2) 'exactly two server blocks required'
    foreach ($s in $servers) {
        Assert-True (((Named $s.children 'server_name').args -join ' ') -ceq 'notes.896364.xyz') 'another site would be affected'
        Assert-True (@(All-Nodes $s.children | Where-Object name -CEQ 'include').Count -eq 0) 'unreviewed include could enable business'
    }
    Assert-True (((Named $servers[0].children 'listen').args -join ' ') -ceq '80') 'HTTP listener changed'
    Assert-True (((Named $servers[1].children 'listen').args -join ' ') -ceq '443 ssl') 'TLS listener required'
}
Case 'active public entry returns maintenance and never proxies or serves application files' {
    foreach ($s in $servers) {
        $root=@(Named $s.children 'location' | Where-Object { ($_.args -join ' ') -ceq '/' })
        Assert-True ($root.Count -eq 1) 'maintenance root missing'
        $returns=@(Named $root[0].children 'return')
        Assert-True ($returns.Count -eq 1 -and $returns[0].args[0] -ceq '503') 'business traffic not blocked by maintenance'
        Assert-True (@(All-Nodes $root[0].children | Where-Object name -CIN @('proxy_pass','root','alias','try_files','include')).Count -eq 0) 'maintenance root exposes business or filesystem'
    }
    $all=@(All-Nodes $servers)
    Assert-True (@($all | Where-Object name -CIN @('proxy_pass','fastcgi_pass','uwsgi_pass','error_page')).Count -eq 0) 'active alternative upstream or error redirect'
    $locations=@($all | Where-Object name -CEQ 'location')
    Assert-True ($locations.Count -eq 3) 'unreviewed public location'
    $acme=@($locations | Where-Object { ($_.args -join ' ') -ceq '^~ /.well-known/acme-challenge/' })
    Assert-True ($acme.Count -eq 1) 'dedicated ACME challenge location missing'
}
Case 'ACME static challenge is outside restricted app roots without bypassing maintenance' {
    $http=$servers[0].children
    $acme=@(Named $http 'location' | Where-Object { ($_.args -join ' ') -ceq '^~ /.well-known/acme-challenge/' })
    Assert-True ($acme.Count -eq 1) 'HTTP ACME prefix location missing'
    $roots=@(Named $acme[0].children 'root')
    Assert-True ($roots.Count -eq 1 -and ($roots[0].args -join ' ') -ceq '/var/www/notes.896364.xyz-acme') 'ACME must use site-only public webroot outside restricted application roots'
    Assert-True (((Named $acme[0].children 'try_files').args -join ' ') -ceq '$uri =404') 'existing challenge must be served; missing challenge must be 404'
    Assert-True (((Named $acme[0].children 'default_type').args -join ' ') -ceq 'text/plain') 'challenge response must be plain text'
    Assert-True (@(All-Nodes $acme[0].children | Where-Object name -CIN @('return','proxy_pass','alias','rewrite','include','deny')).Count -eq 0) 'ACME challenge must not inherit maintenance or proxy behavior'
    Assert-True (@($http | Where-Object name -CIN @('return','rewrite','if')).Count -eq 0) 'server-level maintenance must not preempt the ACME location'
    $allRoots=@(All-Nodes $servers | Where-Object name -CEQ 'root')
    Assert-True ($allRoots.Count -eq 1) 'only this site ACME directory may be publicly served'
}
Case 'TLS references only dedicated certificate files' {
    Assert-True (((Named $servers[1].children 'ssl_certificate').args -join ' ') -ceq '/etc/letsencrypt/live/notes.896364.xyz/fullchain.pem') 'wrong certificate'
    Assert-True (((Named $servers[1].children 'ssl_certificate_key').args -join ' ') -ceq '/etc/letsencrypt/live/notes.896364.xyz/privkey.pem') 'wrong certificate key'
}
Case 'inactive final proxy preserves host/proto and replaces untrusted client forwarding' {
    $section=[regex]::Match($nginx,'(?s)# FINAL-PROXY-BEGIN\r?\n(.*?)# FINAL-PROXY-END')
    Assert-True $section.Success 'final proxy template missing'
    $candidate=[regex]::Replace($section.Groups[1].Value,'(?m)^# ?','')
    $final=Read-NginxTree $candidate
    Assert-True ($final.Count -eq 1 -and $final[0].name -ceq 'location' -and ($final[0].args -join ' ') -ceq '/') 'final proxy must replace only HTTPS root location'
    $directives=$final[0].children
    Assert-True (((Named $directives 'proxy_pass').args -join ' ') -ceq 'http://127.0.0.1:18765') 'final upstream must only be this app'
    $headers=@{}
    foreach ($h in @(Named $directives 'proxy_set_header')) { $headers[$h.args[0]]=$h.args[1] }
    Assert-True ($headers['Host'] -ceq '$host' -and $headers['X-Forwarded-Proto'] -ceq '$scheme') 'host/proto not preserved'
    Assert-True ($headers['X-Forwarded-For'] -ceq '$remote_addr') 'client supplied forwarding must be replaced'
    Assert-True (((Named $directives 'client_max_body_size').args -join ' ') -ceq '64m') 'JSON attachment upload envelope needs headroom'
}
Write-Host "$script:passed configuration contracts passed (no Docker, Nginx, credentials or external resources accessed)."
