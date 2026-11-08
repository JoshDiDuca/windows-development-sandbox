// Text on the Windows clipboard (CF_UNICODETEXT) for the clipboard bridge and the clipboard watch: read and write with retries (another program may hold it open), and a marker format on what the bridge writes, so neither side takes it for a copy. user32 only (no OLE clipboard, so no STA thread is needed). C# 5.
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class SbxClipboardText
{
    public const string MarkerFormatName = "AgentSandbox.ClipboardBridge";
    private const uint CfUnicodeText = 13;
    private const uint GmemMoveable = 0x0002;
    private const int OpenAttempts = 10;
    private const int OpenRetryMs = 30;
    private const int CharBytes = 2;
    private static readonly IntPtr HwndMessage = new IntPtr(-3);

    private static class NativeMethods
    {
        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool OpenClipboard(IntPtr owner);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool CloseClipboard();

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool EmptyClipboard();

        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr GetClipboardData(uint format);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr SetClipboardData(uint format, IntPtr memory);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool IsClipboardFormatAvailable(uint format);

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern uint RegisterClipboardFormatW(string name);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint GetClipboardSequenceNumber();

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr GlobalLock(IntPtr memory);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GlobalUnlock(IntPtr memory);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern UIntPtr GlobalSize(IntPtr memory);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr GlobalFree(IntPtr memory);

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern IntPtr CreateWindowExW(uint exStyle, string className, string windowName, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool DestroyWindow(IntPtr window);
    }

    /// <summary>The clipboard's change counter.</summary>
    public static uint Sequence()
    {
        return NativeMethods.GetClipboardSequenceNumber();
    }

    /// <summary>True when what is on the clipboard was put there by the bridge (it carries the marker format).</summary>
    public static bool HasMarker()
    {
        uint format = NativeMethods.RegisterClipboardFormatW(MarkerFormatName);
        return format != 0 && NativeMethods.IsClipboardFormatAvailable(format);
    }

    private static void Open(IntPtr owner)
    {
        int error = 0;
        for (int attempt = 0; attempt < OpenAttempts; attempt++)
        {
            if (NativeMethods.OpenClipboard(owner))
            {
                return;
            }
            error = Marshal.GetLastWin32Error();
            Thread.Sleep(OpenRetryMs);
        }
        throw new Win32Exception(error);
    }

    /// <summary>
    /// The clipboard text, or null when there is none. tooBig is true (and null returned) when its UTF-8 form is over
    /// maxBytes. Throws Win32Exception when the clipboard stays locked.
    /// </summary>
    public static string Read(int maxBytes, out bool tooBig)
    {
        tooBig = false;
        Open(IntPtr.Zero);
        try
        {
            if (!NativeMethods.IsClipboardFormatAvailable(CfUnicodeText))
            {
                return null;
            }
            IntPtr handle = NativeMethods.GetClipboardData(CfUnicodeText);
            if (handle == IntPtr.Zero)
            {
                return null;
            }
            IntPtr pointer = NativeMethods.GlobalLock(handle);
            if (pointer == IntPtr.Zero)
            {
                return null;
            }
            string text;
            try
            {
                long size = (long)NativeMethods.GlobalSize(handle).ToUInt64() / CharBytes;
                long limit = (long)maxBytes + 1;
                int chars = (int)Math.Min(size, limit);
                text = Marshal.PtrToStringUni(pointer, chars);
            }
            finally
            {
                NativeMethods.GlobalUnlock(handle);
            }
            int nul = text.IndexOf((char)0);
            if (nul >= 0)
            {
                text = text.Substring(0, nul);
            }
            if (Encoding.UTF8.GetByteCount(text) > maxBytes)
            {
                tooBig = true;
                return null;
            }
            return text;
        }
        finally
        {
            NativeMethods.CloseClipboard();
        }
    }

    /// <summary>Puts a block of global memory filled with data on the clipboard; frees it when the clipboard refuses it.</summary>
    private static void Put(uint format, byte[] data, int length)
    {
        IntPtr memory = NativeMethods.GlobalAlloc(GmemMoveable, new UIntPtr((uint)length));
        if (memory == IntPtr.Zero)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        bool taken = false;
        try
        {
            IntPtr pointer = NativeMethods.GlobalLock(memory);
            if (pointer == IntPtr.Zero)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            try
            {
                Marshal.Copy(data, 0, pointer, length);
            }
            finally
            {
                NativeMethods.GlobalUnlock(memory);
            }
            if (NativeMethods.SetClipboardData(format, memory) == IntPtr.Zero)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            taken = true;
        }
        finally
        {
            if (!taken)
            {
                NativeMethods.GlobalFree(memory);
            }
        }
    }

    /// <summary>Replaces the clipboard with text, tagged with the marker format. Throws Win32Exception on failure.</summary>
    public static void Write(string text)
    {
        // OpenClipboard needs a real owner window: with a NULL owner, EmptyClipboard makes SetClipboardData fail.
        IntPtr window = NativeMethods.CreateWindowExW(0, "STATIC", "", 0, 0, 0, 0, 0, HwndMessage, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        if (window == IntPtr.Zero)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        try
        {
            uint marker = NativeMethods.RegisterClipboardFormatW(MarkerFormatName);
            if (marker == 0)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            byte[] bytes = new byte[(text.Length + 1) * CharBytes];
            Encoding.Unicode.GetBytes(text, 0, text.Length, bytes, 0);
            Open(window);
            try
            {
                if (!NativeMethods.EmptyClipboard())
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
                Put(CfUnicodeText, bytes, bytes.Length);
                Put(marker, new byte[1], 1);
            }
            finally
            {
                NativeMethods.CloseClipboard();
            }
        }
        finally
        {
            NativeMethods.DestroyWindow(window);
        }
    }
}
