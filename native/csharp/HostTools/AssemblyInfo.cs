// What HostTools.exe says about itself in its file properties (publisher, product, description, version), so Windows,
// antivirus software and you can tell what it is. It is built on this PC from the sources next to this file.
using System.Reflection;
using System.Runtime.InteropServices;

[assembly: AssemblyTitle("Windows Development Sandbox host helper")]
[assembly: AssemblyDescription("Helper of windows-development-sandbox (open source, MIT): keeps this PC awake while a sandbox runs, shows and hides the Windows Sandbox window, reads the Windows events that end a sandbox and adds its folder to your PATH. Source: https://github.com/JoshDiDuca/windows-development-sandbox")]
[assembly: AssemblyCompany("windows-development-sandbox (open source)")]
[assembly: AssemblyProduct("Windows Development Sandbox")]
[assembly: AssemblyCopyright("MIT License, windows-development-sandbox contributors")]
[assembly: AssemblyVersion("1.13.2.0")]
[assembly: AssemblyFileVersion("1.13.2.0")]
[assembly: AssemblyInformationalVersion("1.13.2")]
[assembly: ComVisible(false)]
