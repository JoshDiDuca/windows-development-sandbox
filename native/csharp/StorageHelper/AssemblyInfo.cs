// What AgentSandboxStorage.exe says about itself in its file properties (publisher, product, description, version), so
// Windows, antivirus software and you can tell what it is. It is built by the all-users installer from the sources next
// to this file, into the Program Files install folder.
using System.Reflection;
using System.Runtime.InteropServices;

[assembly: AssemblyTitle("Windows Development Sandbox storage helper")]
[assembly: AssemblyDescription("Service of windows-development-sandbox (open source, MIT): mounts and dismounts a user's contained-storage disk image without a permission prompt, after checking it is that user's own image in that user's own folder. Source: https://github.com/JoshDiDuca/windows-development-sandbox")]
[assembly: AssemblyCompany("windows-development-sandbox (open source)")]
[assembly: AssemblyProduct("Windows Development Sandbox")]
[assembly: AssemblyCopyright("MIT License, windows-development-sandbox contributors")]
[assembly: AssemblyVersion("1.13.3.0")]
[assembly: AssemblyFileVersion("1.13.3.0")]
[assembly: AssemblyInformationalVersion("1.13.3")]
[assembly: ComVisible(false)]
