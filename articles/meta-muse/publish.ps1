# Publishes the article in this folder to aisolution.co.il
# Run from this folder:  powershell -ExecutionPolicy Bypass -File .\publish.ps1
# All Hebrew text lives in article_content.txt, article_meta.json and images.json (UTF-8).
# The application password is read from $env:WP_APP_PASSWORD, or prompted for.

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$wpUser = "shayadmin"
$wpPass = $env:WP_APP_PASSWORD
if (-not $wpPass) { $wpPass = Read-Host "WordPress application password" }
$cred = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("${wpUser}:$wpPass"))
$authHeader = "Basic $cred"
$api = "https://aisolution.co.il/wp-json/wp/v2"

function Upload-ImageFromUrl($imgUrl, $filename, $altText) {
    $headers = @{"User-Agent"="Mozilla/5.0";"Accept"="image/*,*/*"}
    $imgBytes = (Invoke-WebRequest $imgUrl -UseBasicParsing -Headers $headers -TimeoutSec 30).Content
    $boundary = [System.Guid]::NewGuid().ToString()
    $bodyLines = @(
        "--$boundary",
        "Content-Disposition: form-data; name=`"file`"; filename=`"$filename`"",
        "Content-Type: image/jpeg", "",
        [System.Text.Encoding]::GetEncoding("iso-8859-1").GetString($imgBytes),
        "--$boundary--"
    )
    $bodyBytes2 = [System.Text.Encoding]::GetEncoding("iso-8859-1").GetBytes(($bodyLines -join "`r`n"))
    $r = Invoke-WebRequest "$api/media" -Method POST `
        -Headers @{Authorization=$authHeader;"Content-Type"="multipart/form-data; boundary=$boundary"} `
        -Body $bodyBytes2 -UseBasicParsing -TimeoutSec 60
    $d = $r.Content | ConvertFrom-Json
    $altJson = @{alt_text=$altText; caption=""} | ConvertTo-Json -Compress
    Invoke-WebRequest "$api/media/$($d.id)" -Method POST `
        -Headers @{Authorization=$authHeader;"Content-Type"="application/json; charset=utf-8"} `
        -Body ([System.Text.Encoding]::UTF8.GetBytes($altJson)) -UseBasicParsing | Out-Null
    return @{id=$d.id; url=$d.source_url}
}

$content = Get-Content "article_content.txt" -Raw -Encoding UTF8
$images = Get-Content "images.json" -Raw -Encoding UTF8 | ConvertFrom-Json
$featuredId = 0

for ($i = 0; $i -lt $images.Count; $i++) {
    $n = $i + 1
    $im = $images[$i]
    $startTag = "<!-- IMG${n}_START -->"
    $endTag = "<!-- IMG${n}_END -->"
    try {
        $up = Upload-ImageFromUrl $im.url $im.filename $im.alt
        Write-Host "Image $n uploaded: id=$($up.id)"
        $content = $content.Replace("IMAGE_ID_$n", "$($up.id)").Replace("IMAGE_URL_$n", "$($up.url)").Replace("IMAGE_ALT_$n", $im.alt)
        $content = $content.Replace("$startTag`r`n", "").Replace("$startTag`n", "").Replace("$endTag`r`n", "").Replace("$endTag`n", "")
        $content = $content.Replace($startTag, "").Replace($endTag, "")
        if ($featuredId -eq 0) { $featuredId = $up.id }
    } catch {
        Write-Warning "Image $n failed ($($im.url)): $($_.Exception.Message). Removing its block."
        $s = $content.IndexOf($startTag)
        $e = $content.IndexOf($endTag)
        if ($s -ge 0 -and $e -gt $s) { $content = $content.Remove($s, ($e + $endTag.Length) - $s) }
    }
}

$jsonTemplate = Get-Content "article_meta.json" -Raw -Encoding UTF8
$jsonTemplate = $jsonTemplate.Replace("FEATURED_MEDIA_ID", "$featuredId")
$jsonTemplate = $jsonTemplate.Replace("POST_DATE", (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss"))

$bs = [char]92; $dq = [char]34; $nl = [char]10; $cr = [char]13; $tab = [char]9
$contentEscaped = $content.Replace("$bs","$bs$bs").Replace("$dq","$bs$dq")
$contentEscaped = $contentEscaped.Replace("$cr$nl","${bs}n").Replace("$nl","${bs}n").Replace("$tab","${bs}t")
$jsonTemplate = $jsonTemplate.Replace("POST_CONTENT_PLACEHOLDER", $contentEscaped)

$bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($jsonTemplate)
$result = Invoke-WebRequest "$api/posts" -Method POST `
    -Headers @{Authorization=$authHeader; "Content-Type"="application/json; charset=utf-8"} `
    -Body $bodyBytes -UseBasicParsing
$post = $result.Content | ConvertFrom-Json
Write-Host "Published: $($post.link)  (post id $($post.id))"
