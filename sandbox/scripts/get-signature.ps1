#Requires -Version 5.1
# Prints the certificate names of a file's Authenticode signature as JSON ({"subject": ..., "issuer": ...}) when the
# signature is valid; prints nothing when the file is unsigned or was tampered with. guest/apps/signature.ts checks
# them against an app's expected signer (AppEntry.signer) before the download is kept or an installer is run.
param([Parameter(Mandatory = $true)][string]$Path)
$ErrorActionPreference = 'Stop'

$signature = Get-AuthenticodeSignature -LiteralPath $Path
if ($signature.Status -eq 'Valid' -and $signature.SignerCertificate) {
    $certificate = $signature.SignerCertificate
    [pscustomobject]@{ subject = [string]$certificate.Subject; issuer = [string]$certificate.Issuer } |
        ConvertTo-Json -Compress
}