// YOUR PATH (HKCU\Environment), edited unexpanded, then every program told it changed (agent commands, host side).
// HostTools user-path, or Add-Type from scripts\edit-user-path.ps1 when HostTools cannot be built. C# 5.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace AgentSandbox
{
    public static class UserPath
    {
        public const int Done = 0;
        public const int TooLong = 3;
        private const int MaxLength = 32000;
        private static readonly IntPtr Broadcast = new IntPtr(0xffff);
        private const uint SettingChange = 0x1A;
        private const uint AbortIfHung = 2;
        private const uint TimeoutMs = 5000;

        private static class NativeMethods
        {
            [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
            public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);
        }

        /// <summary>Puts dir first on your PATH (add) or takes it off; Done, or TooLong when PATH would pass 32000 characters.</summary>
        public static int Edit(string dir, bool add)
        {
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey("Environment"))
            {
                string raw = Convert.ToString(key.GetValue("Path", "", RegistryValueOptions.DoNotExpandEnvironmentNames));
                List<string> rest = new List<string>();
                foreach (string part in raw.Split(';'))
                {
                    if (part.Length > 0 && !string.Equals(part.TrimEnd('\\'), dir.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
                    {
                        rest.Add(part);
                    }
                }
                // First, so these commands win over the agents' own folders (also on YOUR PATH).
                if (add)
                {
                    rest.Insert(0, dir);
                }
                string next = string.Join(";", rest);
                if (string.Equals(next, raw.TrimEnd(';'), StringComparison.OrdinalIgnoreCase))
                {
                    return Done;
                }
                if (next.Length > MaxLength)
                {
                    return TooLong;
                }
                RegistryValueKind kind = HasValue(key, "Path") ? key.GetValueKind("Path") : RegistryValueKind.ExpandString;
                key.SetValue("Path", next, kind);
            }
            UIntPtr ignored;
            NativeMethods.SendMessageTimeout(Broadcast, SettingChange, UIntPtr.Zero, "Environment", AbortIfHung, TimeoutMs, out ignored);
            return Done;
        }

        /// <summary>Whether dir is on your stored PATH (the registry, not this process's copy): 0 = yes, 1 = no.</summary>
        public static int Has(string dir)
        {
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey("Environment"))
            {
                string raw = Convert.ToString(key.GetValue("Path", "", RegistryValueOptions.DoNotExpandEnvironmentNames));
                foreach (string part in raw.Split(';'))
                {
                    if (part.Length > 0 && string.Equals(part.TrimEnd('\\'), dir.TrimEnd('\\'),StringComparison.OrdinalIgnoreCase))
                    {
                        return 0;
                    }
                }
            }
            return 1;
        }

        private static bool HasValue(RegistryKey key, string name)
        {
            foreach (string existing in key.GetValueNames())
            {
                if (string.Equals(existing, name, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }
            return false;
        }
    }
}
