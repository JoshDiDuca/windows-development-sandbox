// Reads what Settings.Derive needs for one client: the machine file (read as SYSTEM, accepted only when administrators
// own it and nobody else may change it, never through a link), the user's own file (opened while acting as the user, so only a file the user
// may read is read, never through a link; read after acting as the user has ended), the profile folder (from the
// registry) and the user's environment (CreateEnvironmentBlock with the user's token, called as SYSTEM).
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

namespace AgentSandbox.StorageHelper
{
    public sealed class SettingsSources
    {
        /// <summary>The machine file (%ProgramData%\AgentSandbox\config.json).</summary>
        public string MachineFile { get; set; }

        /// <summary>Test aid (console mode only): the profile folder to use instead of the registry's.</summary>
        public string ProfileOverride { get; set; }
    }

    public static class UserSettings
    {
        private static readonly SecurityIdentifier SystemSid = new SecurityIdentifier("S-1-5-18");
        private static readonly SecurityIdentifier AdministratorsSid = new SecurityIdentifier("S-1-5-32-544");

        private static class NativeMethods
        {
            [DllImport("userenv.dll", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool CreateEnvironmentBlock(out IntPtr environment, SafeAccessTokenHandle token, [MarshalAs(UnmanagedType.Bool)] bool inherit);

            [DllImport("userenv.dll", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool DestroyEnvironmentBlock(IntPtr environment);
        }

        public static StorageSettings For(Client client, SettingsSources sources)
        {
            string profile = sources.ProfileOverride ?? ProfileOf(client.Sid);
            string machineText = ReadMachine(sources.MachineFile);
            string userFile = profile + "\\.agent-sandbox\\config.json";
            string userText = ReadAsUser(client, userFile);
            IDictionary<string, string> environment = EnvironmentOf(client);
            if (sources.ProfileOverride != null)
            {
                environment["USERPROFILE"] = profile;
            }
            return Settings.Derive(machineText, userText, profile + "\\.agent-sandbox", profile, environment);
        }

        public static string ProfileOf(SecurityIdentifier sid)
        {
            using (RegistryKey key = Registry.LocalMachine.OpenSubKey("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\" + sid.Value))
            {
                string value = key == null ? null : key.GetValue("ProfileImagePath") as string;
                if (string.IsNullOrEmpty(value))
                {
                    throw new RefusedException("Windows has no profile folder for this user.");
                }
                string profile = value.TrimEnd('\\');
                if (!Rules.IsPlainAbsolute(profile))
                {
                    throw new RefusedException("The profile folder is not a plain full path.");
                }
                return profile;
            }
        }

        /// <summary>
        /// The machine file's text, or null without one. Refused when someone other than administrators owns it or may
        /// change it. It is read through the handle that was checked, which shares no write or delete, so it cannot be
        /// swapped in between (a file someone else put there instead is theirs, and refused).
        /// </summary>
        public static string ReadMachine(string file)
        {
            if (file == null)
            {
                return null;
            }
            using (SafeFileHandle h = Win32.OpenNoFollow(file, Win32.GenericRead | Win32.ReadControl, Win32.FileShareRead))
            {
                if (h == null)
                {
                    return null;
                }
                if (!Win32.IsAt(h, file))
                {
                    throw new RefusedException("The machine settings are behind a link; ask an administrator to run the installer again.");
                }
                CheckAdminOnly(h, file);
                return ReadText(h, file);
            }
        }

        private static void CheckAdminOnly(SafeFileHandle h, string path)
        {
            Win32.ByHandleFileInformation info = Win32.InfoOf(h, path);
            if ((info.FileAttributes & Win32.AttributeReparsePoint) != 0)
            {
                throw new RefusedException("The machine settings are behind a link; ask an administrator to run the installer again.");
            }
            RawSecurityDescriptor sd = Win32.SecurityOf(h);
            bool adminOwned = sd.Owner != null && (sd.Owner.Equals(SystemSid) || sd.Owner.Equals(AdministratorsSid));
            if (!adminOwned || Pins.OthersWhoMayChange(sd, SystemSid) != null)
            {
                throw new RefusedException("The machine settings (" + path + ") may be changed by someone who is not an administrator; ask an administrator to run the installer again.");
            }
        }

        /// <summary>The user's file as the user may read it (null when there is none), never through a link.</summary>
        private static string ReadAsUser(Client client, string file)
        {
            SafeFileHandle h;
            using (WindowsImpersonationContext acting = WindowsIdentity.Impersonate(client.Token.DangerousGetHandle()))
            {
                try
                {
                    h = Win32.OpenNoFollow(file, Win32.GenericRead, Win32.FileShareRead | Win32.FileShareWrite);
                }
                finally
                {
                    acting.Undo();
                }
            }
            if (h == null)
            {
                return null;
            }
            using (h)
            {
                Win32.ByHandleFileInformation info = Win32.InfoOf(h, file);
                if ((info.FileAttributes & (Win32.AttributeReparsePoint | Win32.AttributeDirectory)) != 0)
                {
                    throw new RefusedException("Your settings file is a link or a folder: " + file);
                }
                return ReadText(h, file);
            }
        }

        private static string ReadText(SafeFileHandle h, string file)
        {
            using (FileStream stream = new FileStream(h, FileAccess.Read))
            {
                if (stream.Length > Settings.MaxConfigBytes)
                {
                    throw new RefusedException("The settings file is too large: " + file);
                }
                byte[] bytes = new byte[stream.Length];
                int done = 0;
                while (done < bytes.Length)
                {
                    int n = stream.Read(bytes, done, bytes.Length - done);
                    if (n <= 0)
                    {
                        break;
                    }
                    done += n;
                }
                return new UTF8Encoding(false, false).GetString(bytes, 0, done);
            }
        }

        /// <summary>The user's own environment (what their programs see), by name.</summary>
        public static IDictionary<string, string> EnvironmentOf(Client client)
        {
            Dictionary<string, string> result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            IntPtr block;
            if (!NativeMethods.CreateEnvironmentBlock(out block, client.Token, false))
            {
                throw Win32.LastError("Could not read the user's environment");
            }
            try
            {
                int offset = 0;
                while (true)
                {
                    string entry = Marshal.PtrToStringUni(new IntPtr(block.ToInt64() + offset));
                    if (string.IsNullOrEmpty(entry))
                    {
                        break;
                    }
                    offset += (entry.Length + 1) * 2;
                    int eq = entry.IndexOf('=', 1);
                    if (eq > 0)
                    {
                        result[entry.Substring(0, eq)] = entry.Substring(eq + 1);
                    }
                    if (offset > 1024 * 1024)
                    {
                        break;
                    }
                }
            }
            finally
            {
                NativeMethods.DestroyEnvironmentBlock(block);
            }
            return result;
        }
    }
}
