// Starts an installed Store (packaged) app by its app user model id, with a command line. Loaded by
// scripts\start-store-app.ps1 (Add-Type). C# 5.
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class SbxAppActivation
{
    private const int OptionsNone = 0;

    [ComImport]
    [Guid("2e941141-7f97-4756-ba1d-9decde894a3d")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IApplicationActivationManager
    {
        [PreserveSig]
        int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, [MarshalAs(UnmanagedType.LPWStr)] string arguments, int options, out uint processId);
    }

    [ComImport]
    [Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
    private class ApplicationActivationManager
    {
    }

    /// <summary>Starts the app and returns its process id; throws a Win32Exception when Windows refuses.</summary>
    public static uint Start(string appUserModelId, string arguments)
    {
        IApplicationActivationManager manager = (IApplicationActivationManager)new ApplicationActivationManager();
        uint processId;
        int result = manager.ActivateApplication(appUserModelId, arguments, OptionsNone, out processId);
        if (result < 0)
        {
            throw new Win32Exception(result, "ActivateApplication failed for " + appUserModelId);
        }
        return processId;
    }
}
