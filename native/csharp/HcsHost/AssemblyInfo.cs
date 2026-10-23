// What HcsHost.exe says about itself in its file properties (publisher, product, description, version), so Windows,
// antivirus software and you can tell what it is. It is built on this PC from the sources next to this file.
using System.Reflection;
using System.Runtime.InteropServices;

[assembly: AssemblyTitle("Windows Development Sandbox HCS helper")]
[assembly: AssemblyDescription("Helper of windows-development-sandbox (open source, MIT), used only by the beta HCS engine: asks the Windows Host Compute Service to list, create, start and stop its sandbox virtual machine, gives that machine access to its own disk file and creates a blank virtual disk file. It never mounts a disk on this PC. Source: https://github.com/JoshDiDuca/windows-development-sandbox")]
[assembly: AssemblyCompany("windows-development-sandbox (open source)")]
[assembly: AssemblyProduct("Windows Development Sandbox")]
[assembly: AssemblyCopyright("MIT License, windows-development-sandbox contributors")]
[assembly: AssemblyVersion("1.13.3.0")]
[assembly: AssemblyFileVersion("1.13.3.0")]
[assembly: AssemblyInformationalVersion("1.13.3")]
[assembly: ComVisible(false)]
// computecore.dll and computestorage.dll are not KnownDLLs: load them from System32 only, never from the exe's folder.
[assembly: DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
