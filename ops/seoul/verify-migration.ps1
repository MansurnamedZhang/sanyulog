param([string]$EvidencePath)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest

function Test-SanyuMigrationHash($value) {
    return ($value -is [string] -and $value -cmatch '^[a-f0-9]{64}$')
}
function Test-SanyuMigrationCount($value) {
    return (($value -is [int] -or $value -is [long]) -and $value -ge 0)
}
function Get-SanyuMigrationAccountId($entry) {
    if ($entry -isnot [Collections.IDictionary]) { return $null }
    $id=$entry['storageId']
    if ($id -isnot [string] -or ($id -cne 'owner' -and $id -cnotmatch '^[a-f0-9]{32}$')) { return $null }
    if ($entry['enabled'] -isnot [bool] -or $entry['initialized'] -isnot [bool]) { return $null }
    return $id
}
function Get-SanyuMigrationSide {
    param($Side,[string]$Role,[Collections.Generic.List[string]]$Errors)
    if ($Side -isnot [Collections.IDictionary]) { $Errors.Add("${Role}_missing");return $null }
    if ($Role -eq 'source') {
        if ($Side['host'] -cne '172.16.240.13' -or $Side['sourceStopped'] -cne $true -or $Side['snapshotComplete'] -cne $true) { $Errors.Add('source_identity_or_snapshot') }
    } else {
        if ($Side['host'] -cne '43.131.245.43' -or -not (Test-SanyuMigrationCount $Side['postgresMajor']) -or $Side['postgresMajor'] -ne 18 -or $Side['restoreComplete'] -cne $true) { $Errors.Add('target_identity_or_restore') }
    }
    foreach ($field in @('snapshotManifestSha256','authDbSha256','storageKeySha256','accountRowsSha256','sessionRowsSha256')) {
        if (-not (Test-SanyuMigrationHash $Side[$field])) { $Errors.Add("${Role}_${field}_invalid") }
    }
    if (-not (Test-SanyuMigrationCount $Side['sessionCount'])) { $Errors.Add("${Role}_session_count_invalid") }
    if ($Side['accounts'] -isnot [array] -or $Side['database'] -isnot [array] -or $Side['media'] -isnot [array]) {
        $Errors.Add("${Role}_inventory_incomplete");return $null
    }
    $accounts=[Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
    $schemaExpected=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($entry in $Side['accounts']) {
        $id=Get-SanyuMigrationAccountId $entry
        if ($null -eq $id -or -not $accounts.TryAdd($id,"$id|$($entry['enabled'])|$($entry['initialized'])")) { $Errors.Add("${Role}_account_invalid");continue }
        if ($entry['initialized']) { [void]$schemaExpected.Add($(if ($id -ceq 'owner') {'public'} else {"process_log_user_$id"})) }
    }
    if (-not $accounts.ContainsKey('owner')) { $Errors.Add("${Role}_owner_missing") }
    $schemas=[Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
    $attachmentRows=0L
    foreach ($schemaEntry in $Side['database']) {
        if ($schemaEntry -isnot [Collections.IDictionary] -or $schemaEntry['schema'] -isnot [string] -or -not $schemaExpected.Contains($schemaEntry['schema']) -or $schemaEntry['tables'] -isnot [array]) { $Errors.Add("${Role}_schema_invalid");continue }
        $tables=[Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
        $hasAttachments=$false
        foreach ($table in $schemaEntry['tables']) {
            if ($table -isnot [Collections.IDictionary] -or $table['name'] -isnot [string] -or $table['name'] -cnotmatch '^[a-z][a-z0-9_]{0,62}$' -or -not (Test-SanyuMigrationCount $table['rows']) -or -not (Test-SanyuMigrationHash $table['normalizedSha256'])) { $Errors.Add("${Role}_table_invalid");continue }
            if (-not $tables.TryAdd($table['name'],"$($table['name'])|$($table['rows'])|$($table['normalizedSha256'])")) { $Errors.Add("${Role}_table_duplicate") }
            if ($table['name'] -ceq 'attachments') { $hasAttachments=$true;$attachmentRows+=$table['rows'] }
        }
        if (-not $hasAttachments -or $tables.Count -eq 0 -or -not $schemas.TryAdd($schemaEntry['schema'],"$($schemaEntry['schema'])|$([string]::Join(';',@($tables.Values | Sort-Object -CaseSensitive)))")) { $Errors.Add("${Role}_schema_incomplete") }
    }
    if ($schemas.Count -ne $schemaExpected.Count) { $Errors.Add("${Role}_schema_count") }
    $media=[Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
    $references=0L
    foreach ($item in $Side['media']) {
        if ($item -isnot [Collections.IDictionary] -or $item['storageId'] -isnot [string] -or -not $accounts.ContainsKey($item['storageId']) -or
            -not $schemaExpected.Contains($(if ($item['storageId'] -ceq 'owner') {'public'} else {"process_log_user_$($item['storageId'])"})) -or
            -not (Test-SanyuMigrationHash $item['plaintextSha256']) -or -not (Test-SanyuMigrationHash $item['ciphertextSha256']) -or
            -not (Test-SanyuMigrationCount $item['plaintextBytes']) -or -not (Test-SanyuMigrationCount $item['ciphertextBytes']) -or
            -not (Test-SanyuMigrationCount $item['references']) -or $item['references'] -lt 1 -or
            $item['key'] -cne "v1/$($item['storageId'])/$($item['plaintextSha256'])") { $Errors.Add("${Role}_media_invalid");continue }
        if (-not $media.TryAdd($item['key'],"$($item['key'])|$($item['plaintextBytes'])|$($item['ciphertextBytes'])|$($item['ciphertextSha256'])|$($item['references'])")) { $Errors.Add("${Role}_media_duplicate") }
        $references+=$item['references']
    }
    if ($references -ne $attachmentRows) { $Errors.Add("${Role}_attachment_references") }
    return @{accountSignature=[string]::Join("`n",@($accounts.Values | Sort-Object -CaseSensitive));schemaSignature=[string]::Join("`n",@($schemas.Values | Sort-Object -CaseSensitive));mediaSignature=[string]::Join("`n",@($media.Values | Sort-Object -CaseSensitive));media=$media}
}
function Test-SanyuMigrationEvidence {
    param([Collections.IDictionary]$Evidence)
    $errors=[Collections.Generic.List[string]]::new()
    if ($null -eq $Evidence -or -not (Test-SanyuMigrationCount $Evidence['schemaVersion']) -or $Evidence['schemaVersion'] -ne 1 -or $Evidence['complete'] -cne $true) { $errors.Add('evidence_incomplete') }
    $source=Get-SanyuMigrationSide $Evidence['source'] 'source' $errors
    $target=Get-SanyuMigrationSide $Evidence['target'] 'target' $errors
    if ($source -and $target) {
        foreach ($field in @('snapshotManifestSha256','authDbSha256','storageKeySha256','accountRowsSha256','sessionRowsSha256','sessionCount')) {
            if ($Evidence['source'][$field] -cne $Evidence['target'][$field]) { $errors.Add("${field}_mismatch") }
        }
        foreach ($field in @('accountSignature','schemaSignature','mediaSignature')) {
            if ($source[$field] -cne $target[$field]) { $errors.Add("${field}_mismatch") }
        }
    }
    $r2=$Evidence['r2']
    if ($r2 -isnot [Collections.IDictionary] -or $r2['accountId'] -cne '0910a2f37a347c249c2dce42169b9b65' -or
        $r2['bucket'] -cne 'sanyulog-media' -or $r2['listComplete'] -cne $true -or
        $r2['publicDomainsDisabled'] -cne $true -or -not (Test-SanyuMigrationCount $r2['anonymousExistingObjectStatus']) -or $r2['anonymousExistingObjectStatus'] -ne 403 -or $r2['objects'] -isnot [array]) {
        $errors.Add('r2_identity_privacy_or_inventory');
    } elseif ($source) {
        $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($object in $r2['objects']) {
            if ($object -isnot [Collections.IDictionary] -or $object['key'] -isnot [string] -or
                -not $seen.Add($object['key']) -or -not $source.media.ContainsKey($object['key'])) { $errors.Add('r2_object_unexpected');continue }
            $match=@($Evidence['source']['media'] | Where-Object { $_['key'] -ceq $object['key'] })[0]
            if (-not (Test-SanyuMigrationCount $object['headBytes']) -or -not (Test-SanyuMigrationCount $object['getBytes']) -or
                -not (Test-SanyuMigrationHash $object['headSha256']) -or -not (Test-SanyuMigrationHash $object['getSha256']) -or
                $object['headBytes'] -ne $match['ciphertextBytes'] -or $object['getBytes'] -ne $match['ciphertextBytes'] -or
                $object['headSha256'] -cne $match['ciphertextSha256'] -or $object['getSha256'] -cne $match['ciphertextSha256']) { $errors.Add('r2_object_bytes_mismatch') }
        }
        if ($seen.Count -ne $source.media.Count) { $errors.Add('r2_object_count_mismatch') }
    }
    return @{ok=($errors.Count -eq 0);blockers=@($errors | Select-Object -Unique);evidenceOnly=$true;liveBytesVerified=$false;cutoverAuthorized=$false;
        accountCount=$(if ($source) {@($Evidence['source']['accounts']).Count} else {0});objectCount=$(if ($source) {$source.media.Count} else {0})}
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        if (-not $EvidencePath) { throw 'evidence_missing' }
        $item=Get-Item -LiteralPath $EvidencePath -Force -ErrorAction Stop
        if ($item -isnot [IO.FileInfo] -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -gt 16MB) { throw 'evidence_unsafe' }
        $parent=$item.Directory
        while ($null -ne $parent) {
            if ($parent.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'evidence_unsafe' }
            $parent=$parent.Parent
        }
        $inputEvidence=Get-Content -LiteralPath $item.FullName -Raw | ConvertFrom-Json -AsHashtable -Depth 30
        $result=Test-SanyuMigrationEvidence $inputEvidence
    } catch {
        $result=@{ok=$false;blockers=@('evidence_unavailable_or_invalid');evidenceOnly=$true;liveBytesVerified=$false;cutoverAuthorized=$false;accountCount=0;objectCount=0}
    }
    $result | ConvertTo-Json -Depth 5 -Compress
    if (-not $result.ok) { exit 2 }
}
