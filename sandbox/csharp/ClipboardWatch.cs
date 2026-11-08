// Reports each change of the clipboard on stdout until a parent process ends. Loaded by scripts\watch-clipboard.ps1 (Add-Type, with ClipboardText.cs). Changes the clipboard bridge made (marker format) are not reported: they are not your copy. C# 5.
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class SbxClipboardWatch
{
    private const uint Synchronize = 0x00100000;
    private const uint WaitObject0 = 0;
    private const int PollMs = 150;

    private static class NativeMethods
    {
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr handle);
    }

    /// <summary>
    /// Writes the line "changed" for every clipboard change, until process parentPid ends. 0 = the parent ended,
    /// 2 = the parent could not be opened.
    /// </summary>
    public static int Run(uint parentPid)
    {
        IntPtr parent = NativeMethods.OpenProcess(Synchronize, false, parentPid);
        if (parent == IntPtr.Zero)
        {
            return 2;
        }
        try
        {
            uint last = SbxClipboardText.Sequence();
            while (NativeMethods.WaitForSingleObject(parent, 0) != WaitObject0)
            {
                uint now = SbxClipboardText.Sequence();
                if (now != last)
                {
                    last = now;
                    if (!SbxClipboardText.HasMarker())
                    {
                        Console.Out.WriteLine("changed");
                        Console.Out.Flush();
                    }
                }
                Thread.Sleep(PollMs);
            }
            return 0;
        }
        finally
        {
            NativeMethods.CloseHandle(parent);
        }
    }
}
