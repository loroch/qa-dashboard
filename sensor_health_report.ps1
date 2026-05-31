# Sensor Health Report
# Run via RDP on MOR-SQLDB-SRV (10.21.69.58)
# Requires: Invoke-Sqlcmd (already installed via SSMS/Zabbix)

param([switch]$Json)

$SQL_INSTANCE = "MOR-SQLDB-SRV\VULCAN"
$SQL_DB       = "Vulcan"
$ES_URL       = "http://10.21.69.59:9200"

$UNIT_TYPES = @{ 1 = "Fix_Camera"; 2 = "PTZ_Camera"; 7 = "LPR_Camera" }

# ── Helpers ───────────────────────────────────────────────────────────────────

function Get-IndexName {
    $now = Get-Date
    return "detections_genericdetection_sensorhealthstatus_{0}-{1:MM}" -f $now.Year, $now
}

function Get-Last24hRange {
    $end   = (Get-Date).ToUniversalTime()
    $start = $end.AddHours(-24)
    return @{
        start = $start.ToString("yyyy-MM-ddTHH:mm:ss.000Z")
        end   = $end.ToString("yyyy-MM-ddTHH:mm:ss.000Z")
    }
}

function Get-NormalisedStatus($raw) {
    if (-not $raw) { return "Unknown" }
    $low = $raw.Trim().ToLower().Split(",")[0].Trim()
    switch -Wildcard ($low) {
        "working*"  { return "working properly" }
        "ok"        { return "working properly" }
        "active"    { return "working properly" }
        "failed"    { return "Failed" }
        "no_comm*"  { return "Failed" }
        "not_rec*"  { return "Not Recording" }
        "offline"   { return "Offline" }
        default     { return $raw.Trim() }
    }
}

# ── SQL: active units ─────────────────────────────────────────────────────────

Write-Host "`n[SQL] Loading active units from $SQL_INSTANCE ..."
$sqlQuery = "SELECT UnitId, UnitTypeId, Name FROM [Vulcan].[C4IData].[Units] WHERE IsActive = 1"

try {
    $rows = Invoke-Sqlcmd -ServerInstance $SQL_INSTANCE -Database $SQL_DB -Query $sqlQuery -ErrorAction Stop
    $activeUnits = @{}
    foreach ($row in $rows) {
        $typeId      = [int]$row.UnitTypeId
        $deviceType  = if ($UNIT_TYPES.ContainsKey($typeId)) { $UNIT_TYPES[$typeId] } else { "Camera_type$typeId" }
        $activeUnits[[int]$row.UnitId] = @{ DeviceType = $deviceType; Name = $row.Name }
    }
    Write-Host "[SQL] Loaded $($activeUnits.Count) active units"
} catch {
    Write-Host "[SQL] ERROR: $_"
    $activeUnits = @{}
}

# ── ES: query latest doc per sensor ──────────────────────────────────────────

function Query-EsLatestPerSensor($indexPattern, $timeRange) {
    $mustClauses = "[]"
    if ($timeRange) {
        $mustClauses = @"
[{"range":{"Time":{"gte":"$($timeRange.start)","lte":"$($timeRange.end)"}}}]
"@
    }

    $body = @"
{
  "size": 0,
  "query": { "bool": { "must": $mustClauses } },
  "aggs": {
    "by_sensor": {
      "terms": { "field": "UnitID", "size": 20000 },
      "aggs": {
        "latest": {
          "top_hits": {
            "size": 1,
            "sort": [{ "Time": { "order": "desc" } }],
            "_source": ["UnitID","AdditionalParameters","OriginalSensorStates","Time"]
          }
        }
      }
    }
  }
}
"@

    try {
        $url      = "$ES_URL/$indexPattern/_search"
        $response = Invoke-RestMethod -Uri $url -Method POST -Body $body -ContentType "application/json" -ErrorAction Stop
        $result   = @{}
        foreach ($bucket in $response.aggregations.by_sensor.buckets) {
            $hit = $bucket.latest.hits.hits[0]._source
            if ($hit) { $result[[int]$bucket.key] = $hit }
        }
        Write-Host "[ES]  '$indexPattern' → $($result.Count) sensors with data"
        return $result
    } catch {
        Write-Host "[ES]  ERROR on '$indexPattern': $_"
        return @{}
    }
}

function Get-SensorStatus($doc) {
    $params     = $doc.AdditionalParameters._parameters
    $sensorType = if ($params.SensorType) { $params.SensorType } else { "Camera" }
    $rawStatus  = if ($params.Status)     { $params.Status }
                  elseif ($doc.OriginalSensorStates) { $doc.OriginalSensorStates -join "," }
                  else { "Unknown" }
    return @{ SensorType = $sensorType; Status = Get-NormalisedStatus $rawStatus }
}

# ── Build reports ─────────────────────────────────────────────────────────────

function Build-Report($activeUnits, $esDocs, $unknownLabel) {
    $groups = @{}
    foreach ($uid in $activeUnits.Keys) {
        $deviceType = $activeUnits[$uid].DeviceType
        if ($esDocs.ContainsKey($uid)) {
            $s          = Get-SensorStatus $esDocs[$uid]
            $sensorType = $s.SensorType
            $status     = $s.Status
        } else {
            $sensorType = "Camera"
            $status     = $unknownLabel
        }
        $key = "${deviceType}_${sensorType}"
        if (-not $groups.ContainsKey($key))        { $groups[$key] = @{} }
        if (-not $groups[$key].ContainsKey($status)) { $groups[$key][$status] = 0 }
        $groups[$key][$status]++
    }
    return $groups
}

function Print-Report($title, $groups, $countLabel) {
    $line = "=" * 60
    Write-Host "`n$line"
    Write-Host $title
    Write-Host ("Generated: {0} UTC" -f (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd HH:mm:ss"))
    Write-Host $line
    $total = 0
    foreach ($groupKey in ($groups.Keys | Sort-Object)) {
        foreach ($status in ($groups[$groupKey].Keys | Sort-Object)) {
            $count  = $groups[$groupKey][$status]
            $total += $count
            Write-Host ("  {0,-35} | {1,-40} {2} = {3}" -f $groupKey, $status, $countLabel, $count)
        }
    }
    Write-Host ("-" * 60)
    Write-Host "  TOTAL active units: $total"
}

# ── Run ───────────────────────────────────────────────────────────────────────

$timeRange = Get-Last24hRange
$index24h  = Get-IndexName

Write-Host "`n[*] Report 1 — last 24h  ($($timeRange.start) → $($timeRange.end))"
$es24h   = Query-EsLatestPerSensor $index24h $timeRange
$groups1 = Build-Report $activeUnits $es24h "UNKNOWN (not reported in last 24h)"

Write-Host "`n[*] Report 2 — latest ever  (all indices)"
$esAll   = Query-EsLatestPerSensor "detections_genericdetection_sensorhealthstatus_*" $null
$groups2 = Build-Report $activeUnits $esAll "UNKNOWN (no record found)"

if ($Json) {
    $out = @{
        generated_utc          = (Get-Date).ToUniversalTime().ToString("o")
        report_1_last_24h      = @()
        report_2_latest_ever   = @()
    }
    foreach ($g in $groups1.Keys) { foreach ($s in $groups1[$g].Keys) {
        $out.report_1_last_24h += @{ group=$g; status=$s; last_24h=$groups1[$g][$s] }
    }}
    foreach ($g in $groups2.Keys) { foreach ($s in $groups2[$g].Keys) {
        $out.report_2_latest_ever += @{ group=$g; status=$s; last_update=$groups2[$g][$s] }
    }}
    $out | ConvertTo-Json -Depth 5
} else {
    Print-Report "REPORT 1 — Sensor Status (Last 24 hours)" $groups1 "last 24h"
    Print-Report "REPORT 2 — Sensor Status (Latest Ever)"   $groups2 "last_update"
    Write-Host ""
}
