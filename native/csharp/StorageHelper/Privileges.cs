// Turns on the privileges the service's own token holds but has switched off: managing volumes (attach, mount points),
// restore (a new image's owner is the user, not the service) and backup. Only what the token already has; a missing
// one is left out and the operation that needs it fails with Windows' own message.
using System;
using System.Runtime.InteropServices;

namespace AgentSandbox.StorageHelper
{
    public static class Privileges
    {
        private const uint TokenAdjustPrivileges = 0x0020;
        private const uint TokenQuery = 0x0008;
        private const uint Enabled = 0x2;

        [StructLayout(LayoutKind.Sequential)]
        private struct Luid
        {
            public uint Low;
            public int High;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct TokenPrivilege
        {
            public uint Count;
            public Luid Luid;
            public uint Attributes;
        }

        private static class NativeMethods
        {
            [DllImport("kernel32.dll")]
            public static extern IntPtr GetCurrentProcess();

            [DllImport("advapi32.dll", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

            [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool LookupPrivilegeValueW(string system, string name, out Luid luid);

            [DllImport("advapi32.dll", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool AdjustTokenPrivileges(IntPtr token, [MarshalAs(UnmanagedType.Bool)] bool disableAll, ref TokenPrivilege state, uint length, IntPtr previous, IntPtr returned);

            [DllImport("kernel32.dll", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool CloseHandle(IntPtr handle);
        }

        public static void Enable(params string[] names)
        {
            IntPtr token;
            if (!NativeMethods.OpenProcessToken(NativeMethods.GetCurrentProcess(), TokenAdjustPrivileges | TokenQuery, out token))
            {
                return;
            }
            try
            {
                foreach (string name in names)
                {
                    TokenPrivilege state = new TokenPrivilege();
                    state.Count = 1;
                    state.Attributes = Enabled;
                    if (NativeMethods.LookupPrivilegeValueW(null, name, out state.Luid))
                    {
                        NativeMethods.AdjustTokenPrivileges(token, false, ref state, 0, IntPtr.Zero, IntPtr.Zero);
                    }
                }
            }
            finally
            {
                NativeMethods.CloseHandle(token);
            }
        }
    }
}
