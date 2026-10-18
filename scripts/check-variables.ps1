#Requires -Version 5.1
# Variable hygiene check for PowerShell files, by the parser's own syntax tree (the self-test runs it on every .ps1).
# Prints one line per finding to stderr as "path:line: kind: message"; exit 1 when there is any, 0 when clean.
# Kinds: automatic (assigning, iterating, declaring or [ref]-ing an automatic variable), case (a variable spelled
# differently from a parameter or from itself in the same scope), preference (a preference variable set inside a
# function), dotsource (a name a dot-sourced file and its caller both assign), env (writing an environment variable
# that is not in the allowed list), unassigned (read before any assignment), script-scope ($global:, or $script: that
# a file does not need).
param(
    [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)][string[]]$Path
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$automaticNames = @(
    '_', 'psitem', 'args', 'input', 'this', 'sender', 'event', 'eventargs', 'eventsubscriber', 'matches', 'error',
    'host', 'home', 'pid', 'profile', 'pwd', 'shellid', 'stacktrace', 'myinvocation', 'pscmdlet',
    'psboundparameters', 'psscriptroot', 'pscommandpath', 'null', 'true', 'false', 'lastexitcode', 'ofs',
    'psversiontable', 'executioncontext', 'consolefilename', 'nestedpromptlevel', 'switch', 'foreach', 'iswindows',
    'islinux', 'ismacos', 'psculture', 'psuiculture', 'psedition', 'pshome', 'psdebugcontext', 'psissafemode',
    'psemailserver', 'pssessionapplicationname', 'pssessionconfigurationname', 'pssessionoption'
)
$preferenceNames = @(
    'erroractionpreference', 'warningpreference', 'verbosepreference', 'debugpreference', 'informationpreference',
    'progresspreference', 'confirmpreference', 'whatifpreference', 'errorview', 'maximumhistorycount',
    'outputencoding', 'psdefaultparametervalues'
)
$envAllowed = @('path', 'pathext', 'psmodulepath', 'temp', 'tmp')

function Get-VarName {
    param($Variable)
    $user = $Variable.VariablePath.UserPath
    $scope = ''
    $name = $user
    $colon = $user.IndexOf(':')
    if ($colon -ge 0) {
        $scope = $user.Substring(0, $colon).ToLowerInvariant()
        $name = $user.Substring($colon + 1)
    }
    return [pscustomobject]@{ Scope = $scope; Name = $name }
}

function Get-ScopeOf {
    param($Node)
    $up = $Node.Parent
    while ($null -ne $up) {
        if ($up -is [System.Management.Automation.Language.FunctionDefinitionAst]) { return $up }
        $up = $up.Parent
    }
    return $null
}

function Test-InScriptBlock {
    param($Node)
    $up = $Node.Parent
    while ($null -ne $up) {
        if ($up -is [System.Management.Automation.Language.ScriptBlockExpressionAst]) { return $true }
        $up = $up.Parent
    }
    return $false
}

function Get-ParamNames {
    param($Block)
    $found = @()
    if ($null -ne $Block -and $null -ne $Block.ParamBlock) {
        foreach ($one in $Block.ParamBlock.Parameters) { $found += $one.Name.VariablePath.UserPath }
    }
    return $found
}

# Names assigned outside functions (the script level, which a dot-sourcing script shares).
function Get-TopAssigned {
    param($Ast)
    $set = @{}
    $isAssign = { param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] }
    $isVar = { param($n) $n -is [System.Management.Automation.Language.VariableExpressionAst] }
    foreach ($a in $Ast.FindAll($isAssign, $true)) {
        if ($null -ne (Get-ScopeOf $a)) { continue }
        foreach ($v in $a.Left.FindAll($isVar, $true)) {
            $parsed = Get-VarName $v
            if ($parsed.Scope -eq '' -or $parsed.Scope -eq 'script') { $set[$parsed.Name.ToLowerInvariant()] = $true }
        }
    }
    return $set
}

$findings = New-Object System.Collections.Generic.List[string]
function Add-Finding {
    param($File, $Node, [string]$Kind, [string]$Message)
    $findings.Add(('{0}:{1}: {2}: {3}' -f $File, $Node.Extent.StartLineNumber, $Kind, $Message))
}

$isFunction = { param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }
$isVariable = { param($n) $n -is [System.Management.Automation.Language.VariableExpressionAst] }
$isAssignment = { param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] }
$isForEach = { param($n) $n -is [System.Management.Automation.Language.ForEachStatementAst] }
$isParameter = { param($n) $n -is [System.Management.Automation.Language.ParameterAst] }
$isConvert = { param($n) $n -is [System.Management.Automation.Language.ConvertExpressionAst] }
$isCommand = { param($n) $n -is [System.Management.Automation.Language.CommandAst] }

foreach ($file in $Path) {
    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors)
    if ($errors.Count -gt 0) {
        foreach ($e in $errors) { $findings.Add(('{0}:{1}: parse: {2}' -f $file, $e.Extent.StartLineNumber, $e.Message)) }
        continue
    }
    $allVars = @($ast.FindAll($isVariable, $true))
    $functions = @($ast.FindAll($isFunction, $true))

    # Every place a variable is written, iterated, declared or passed as [ref].
    $targets = New-Object System.Collections.Generic.List[object]
    foreach ($a in $ast.FindAll($isAssignment, $true)) {
        foreach ($v in $a.Left.FindAll($isVariable, $true)) {
            if ($v.Parent -is [System.Management.Automation.Language.IndexExpressionAst]) { continue }
            if ($v.Parent -is [System.Management.Automation.Language.MemberExpressionAst]) { continue }
            $targets.Add([pscustomobject]@{ Var = $v; How = 'assigned' })
        }
    }
    foreach ($f in $ast.FindAll($isForEach, $true)) {
        $targets.Add([pscustomobject]@{ Var = $f.Variable; How = 'used as a foreach variable' })
    }
    foreach ($p in $ast.FindAll($isParameter, $true)) {
        $targets.Add([pscustomobject]@{ Var = $p.Name; How = 'declared as a parameter' })
    }
    foreach ($c in $ast.FindAll($isConvert, $true)) {
        if ($c.Type.TypeName.Name -eq 'ref' -and $c.Child -is [System.Management.Automation.Language.VariableExpressionAst]) {
            $targets.Add([pscustomobject]@{ Var = $c.Child; How = 'passed as [ref]' })
        }
    }
    $targetSet = New-Object 'System.Collections.Generic.HashSet[object]'
    foreach ($t in $targets) { [void]$targetSet.Add($t.Var) }

    # 1. automatic variables, 1b. environment writes, 3. preference variables inside functions
    foreach ($t in $targets) {
        $vn = Get-VarName $t.Var
        $lower = $vn.Name.ToLowerInvariant()
        if ($vn.Scope -eq 'env') {
            if ($t.How -eq 'assigned' -and $envAllowed -notcontains $lower) {
                Add-Finding $file $t.Var 'env' ('writes $env:' + $vn.Name + ' (not in the allowed list)')
            }
            continue
        }
        # `$null = ...` discards a value; `$global:LASTEXITCODE = 0` resets the exit code on purpose.
        $sink = $lower -eq 'null' -and $t.How -eq 'assigned'
        $resetsExit = $lower -eq 'lastexitcode' -and $vn.Scope -eq 'global'
        if ($automaticNames -contains $lower -and -not $sink -and -not $resetsExit) {
            Add-Finding $file $t.Var 'automatic' ('$' + $vn.Name + ' is an automatic variable, ' + $t.How)
        }
        # A plain assignment inside a function is local to it and gone when it returns; only the wider scopes leak.
        if ($t.How -eq 'assigned' -and $preferenceNames -contains $lower -and $vn.Scope -in @('global', 'script') -and $null -ne (Get-ScopeOf $t.Var)) {
            Add-Finding $file $t.Var 'preference' ('$' + $vn.Name + ' is set in the ' + $vn.Scope + ' scope from inside a function')
        }
    }

    # 1c. a function assigning a name the script level also assigns: a silent local copy, not an update of it
    $topSet = Get-TopAssigned $ast
    foreach ($t in $targets) {
        $vn = Get-VarName $t.Var
        if ($t.How -ne 'assigned' -or $vn.Scope -ne '' -or $null -eq (Get-ScopeOf $t.Var)) { continue }
        if ($topSet.ContainsKey($vn.Name.ToLowerInvariant())) {
            Add-Finding $file $t.Var 'shadow' ('$' + $vn.Name + ' inside a function hides the script-level $' + $vn.Name)
        }
    }

    # 2. spelling against the parameters and against itself, per scope (script level, then each function)
    $scopes = @([pscustomobject]@{ Node = $null; Label = 'the script'; Params = @(Get-ParamNames $ast) })
    foreach ($fn in $functions) {
        $names = @(Get-ParamNames $fn.Body)
        if ($null -ne $fn.Parameters) { foreach ($p in $fn.Parameters) { $names += $p.Name.VariablePath.UserPath } }
        $scopes += [pscustomobject]@{ Node = $fn; Label = 'function ' + $fn.Name; Params = $names }
    }
    foreach ($g in $scopes) {
        $spellings = @{}
        foreach ($p in $g.Params) {
            $spellings[$p.ToLowerInvariant()] = New-Object System.Collections.Hashtable ([System.StringComparer]::Ordinal)
            $spellings[$p.ToLowerInvariant()][$p] = $true
        }
        foreach ($v in $allVars) {
            if ([object]::ReferenceEquals((Get-ScopeOf $v), $g.Node) -eq $false) { continue }
            $vn = Get-VarName $v
            if ($vn.Scope -ne '' -and $vn.Scope -ne 'script' -and $vn.Scope -ne 'local') { continue }
            $k = $vn.Name.ToLowerInvariant()
            if ($automaticNames -contains $k) { continue }
            if (-not $spellings.ContainsKey($k)) { $spellings[$k] = New-Object System.Collections.Hashtable ([System.StringComparer]::Ordinal) }
            if (-not $spellings[$k].ContainsKey($vn.Name)) {
                $spellings[$k][$vn.Name] = $true
                if ($spellings[$k].Count -gt 1) {
                    Add-Finding $file $v 'case' ('$' + $vn.Name + ' in ' + $g.Label + ' is also spelled ' + (($spellings[$k].Keys | Where-Object { $_ -cne $vn.Name }) -join ', '))
                }
            }
        }
    }

    # 4. dot-sourced files and script / global scope
    $dotNames = @{}
    $mine = Get-TopAssigned $ast
    $dots = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.InvocationOperator -eq [System.Management.Automation.Language.TokenKind]::Dot }, $true))
    $dir = Split-Path -Parent (Resolve-Path -LiteralPath $file).Path
    foreach ($d in $dots) {
        $leaf = ($d.CommandElements[0].Extent.Text.Trim('"', "'") -split '[\\/]')[-1]
        $other = Get-ChildItem -LiteralPath $dir -Filter $leaf -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -eq $other) { continue }
        $oTokens = $null
        $oErrors = $null
        $oast = [System.Management.Automation.Language.Parser]::ParseFile($other.FullName, [ref]$oTokens, [ref]$oErrors)
        foreach ($k in (Get-TopAssigned $oast).Keys) {
            $dotNames[$k] = $other.Name
            if ($mine.ContainsKey($k)) {
                Add-Finding $file $d 'dotsource' ('$' + $k + ' is assigned here and in dot-sourced ' + $other.Name)
            }
        }
    }
    # A file that another checked file dot-sources runs in that file's scope: what the caller assigns is visible.
    $callerNames = @{}
    $myLeaf = (Split-Path -Leaf $file).ToLowerInvariant()
    foreach ($other in $Path) {
        if ($other -eq $file) { continue }
        $cTokens = $null
        $cErrors = $null
        $cast = [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path -LiteralPath $other).Path, [ref]$cTokens, [ref]$cErrors)
        $callerDots = @($cast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.InvocationOperator -eq [System.Management.Automation.Language.TokenKind]::Dot }, $true))
        $calls = $false
        foreach ($d in $callerDots) { if ($d.Extent.Text.ToLowerInvariant().Contains($myLeaf)) { $calls = $true } }
        if (-not $calls) { continue }
        foreach ($k in (Get-TopAssigned $cast).Keys) { $callerNames[$k] = $other }
        foreach ($k in (Get-ParamNames $cast)) { $callerNames[$k.ToLowerInvariant()] = $other }
    }
    $scriptUses = @{}
    foreach ($v in $allVars) {
        $vn = Get-VarName $v
        if ($vn.Scope -eq 'global' -and $vn.Name -ine 'LASTEXITCODE') { Add-Finding $file $v 'script-scope' ('$global:' + $vn.Name + ' (use a script or local variable)') }
        if ($vn.Scope -eq 'script') {
            $k = $vn.Name.ToLowerInvariant()
            if (-not $scriptUses.ContainsKey($k)) { $scriptUses[$k] = [pscustomobject]@{ InFunction = $false; First = $v } }
            # Inside a function or a script block (which may run in a child scope) the prefix can matter.
            if (($null -ne (Get-ScopeOf $v)) -or (Test-InScriptBlock $v)) { $scriptUses[$k].InFunction = $true }
        }
    }
    foreach ($k in $scriptUses.Keys) {
        $u = $scriptUses[$k]
        if (-not $u.InFunction -and -not $dotNames.ContainsKey($k)) {
            Add-Finding $file $u.First 'script-scope' ('$script:' + $k + ' is only used at script level (drop the prefix)')
        }
    }

    # 5. reads before any assignment. A function may read what the script level assigns anywhere in the file (it runs
    # later); the script level and a function's own body must assign first, by position.
    $declared = New-Object System.Collections.Generic.List[object]
    foreach ($t in $targets) {
        $declared.Add([pscustomobject]@{ Name = (Get-VarName $t.Var).Name.ToLowerInvariant(); Offset = $t.Var.Extent.StartOffset; Owner = (Get-ScopeOf $t.Var) })
    }
    foreach ($cmd in $ast.FindAll($isCommand, $true)) {
        $els = $cmd.CommandElements
        for ($i = 0; $i -lt $els.Count - 1; $i++) {
            $el = $els[$i]
            if ($el -is [System.Management.Automation.Language.CommandParameterAst] -and $el.ParameterName -match '^(OutVariable|ov|ErrorVariable|ev|WarningVariable|wv|InformationVariable|iv|PipelineVariable|pv)$') {
                $declared.Add([pscustomobject]@{ Name = $els[$i + 1].Extent.Text.Trim('"', "'", '+').ToLowerInvariant(); Offset = $cmd.Extent.StartOffset; Owner = $null })
            }
        }
        $cn = $cmd.GetCommandName()
        if ($null -ne $cn -and $cn -match '^(Set|New)-Variable$' -and $els.Count -gt 1) {
            foreach ($el in $els) {
                if ($el -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $el.Value -ne $cn) {
                    $declared.Add([pscustomobject]@{ Name = $el.Value.ToLowerInvariant(); Offset = 0; Owner = $null })
                }
            }
        }
    }
    $paramSet = @{}
    foreach ($p in $ast.FindAll($isParameter, $true)) { $paramSet[$p.Name.VariablePath.UserPath.ToLowerInvariant()] = $true }
    foreach ($v in $allVars) {
        if ($targetSet.Contains($v)) { continue }
        $vn = Get-VarName $v
        if ($vn.Scope -ne '' -and $vn.Scope -ne 'script' -and $vn.Scope -ne 'local') { continue }
        $k = $vn.Name.ToLowerInvariant()
        if ($automaticNames -contains $k -or $preferenceNames -contains $k -or $paramSet.ContainsKey($k)) { continue }
        if ($dotNames.ContainsKey($k) -or $callerNames.ContainsKey($k)) { continue }
        $owner = Get-ScopeOf $v
        $ok = $false
        foreach ($d in $declared) {
            if ($d.Name -ne $k) { continue }
            if ($null -eq $d.Owner) {
                if ($null -ne $owner -or $d.Offset -lt $v.Extent.StartOffset) { $ok = $true; break }
            }
            elseif ($null -ne $owner -and $d.Offset -lt $v.Extent.StartOffset -and
                $owner.Extent.StartOffset -ge $d.Owner.Extent.StartOffset -and $owner.Extent.EndOffset -le $d.Owner.Extent.EndOffset) {
                $ok = $true
                break
            }
        }
        if (-not $ok) { Add-Finding $file $v 'unassigned' ('$' + $vn.Name + ' is read before it is assigned') }
    }
}

foreach ($f in $findings) { [Console]::Error.WriteLine($f) }
if ($findings.Count -gt 0) { exit 1 }
exit 0
