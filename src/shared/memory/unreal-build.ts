// UnrealBuildTool's parallel compiles in the sandbox. Left alone it starts one compiler per core whenever the sandbox
// looks free (free RAM / 1.5 GB), and each cl.exe with Unreal's precompiled headers commits about 2.6 GB: a build start
// asks for 50 GB within seconds, faster than the governor can step in, and Windows closes the sandbox.
// MaxParallelActions caps it before the build starts; UnrealBuildTool runs one build per engine at a time, so the cap
// is the whole budget.

/** The XML namespace UnrealBuildTool reads (XmlConfigFile.SchemaNamespaceURI). */
const NAMESPACE = 'https://www.unrealengine.com/BuildConfiguration';

/** BuildConfiguration.xml with at most `jobs` compiles and links at once (pure). */
export function ubtBuildConfiguration(jobs: number): string {
  const max = Math.max(1, Math.floor(jobs));
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<!-- Written by the sandbox at boot: compiles at once from the build budget (run\\budget.json, buildJobs). -->',
    '<Configuration xmlns="' + NAMESPACE + '">',
    '  <BuildConfiguration>',
    '    <MaxParallelActions>' + max + '</MaxParallelActions>',
    '  </BuildConfiguration>',
    '</Configuration>',
    '',
  ].join('\r\n');
}
