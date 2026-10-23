// What wsb-share may expose, checked here in the elevated helper without relying on the unelevated caller: the plain
// long path of an existing folder on a fixed local drive (ShareRequest.FolderProblem), not on a subst drive, opened
// without following links and shared in the form Windows itself reports for that handle; never Windows, Program Files,
// ProgramData, the profile root or another user's profile, nor this tool's storage or data folder (or a folder that
// holds them); and only a folder the unelevated user can read (and write, for a writable share) themselves.
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace AgentSandbox.HcsHost
{
    public static class FolderAccess
    {
        private const uint FileReadAttributes = 0x80;
        private const uint FileShareAll = 0x7;
        /// <summary>Read and write, never delete: while the handle is held the folder cannot be renamed or replaced.</summary>
        private const uint FileShareReadWrite = 0x3;
        private const uint OpenExisting = 3;
        private const uint FlagBackupSemantics = 0x02000000;
        private const uint FlagOpenReparsePoint = 0x00200000;
        private const uint AttributeDirectory = 0x10;
        private const uint AttributeReparsePoint = 0x400;
        private const uint TokenQuery = 0x0008;
        private const uint TokenDuplicate = 0x0002;
        private const int TokenLinkedTokenClass = 19;
        private const int SecurityIdentification = 1;
        private const uint OwnerGroupDacl = 0x1 | 0x2 | 0x4;
        private const uint FileGenericRead = 0x120089;
        private const uint FileGenericWrite = 0x120116;
        private const uint FileGenericExecute = 0x1200A0;
        private const uint FileAllAccess = 0x1F01FF;
        private const uint FileTraverse = 0x20;
        private static readonly IntPtr InvalidHandle = new IntPtr(-1);

        [StructLayout(LayoutKind.Sequential)]
        private struct GenericMapping
        {
            public uint GenericRead;
            public uint GenericWrite;
            public uint GenericExecute;
            public uint GenericAll;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ByHandleFileInformation
        {
            public uint FileAttributes;
            public long CreationTime;
            public long LastAccessTime;
            public long LastWriteTime;
            public uint VolumeSerialNumber;
            public uint FileSizeHigh;
            public uint FileSizeLow;
            public uint NumberOfLinks;
            public uint FileIndexHigh;
            public uint FileIndexLow;
        }

        private static class NativeMethods
        {
            [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
            public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

            [DllImport("kernel32.dll", SetLastError = true)]
            public static extern bool GetFileInformationByHandle(IntPtr file, out ByHandleFileInformation info);

            [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
            public static extern uint GetFinalPathNameByHandleW(IntPtr file, StringBuilder path, uint length, uint flags);

            [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
            public static extern uint QueryDosDeviceW(string device, StringBuilder target, uint length);

            [DllImport("kernel32.dll", SetLastError = true)]
            public static extern bool CloseHandle(IntPtr handle);

            [DllImport("kernel32.dll")]
            public static extern IntPtr GetCurrentProcess();

            [DllImport("advapi32.dll", SetLastError = true)]
            public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

            [DllImport("advapi32.dll", SetLastError = true)]
            public static extern bool GetTokenInformation(IntPtr token, int infoClass, out IntPtr linked, int length, out int returned);

            [DllImport("advapi32.dll", SetLastError = true)]
            public static extern bool DuplicateToken(IntPtr token, int level, out IntPtr duplicate);

            [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
            public static extern bool GetFileSecurityW(string name, uint info, byte[] descriptor, uint length, out uint needed);

            [DllImport("advapi32.dll", SetLastError = true)]
            public static extern bool AccessCheck(byte[] descriptor, IntPtr token, uint desired, ref GenericMapping mapping, byte[] privileges, ref uint privilegesLength, out uint granted, out bool status);
        }

        /// <summary>
        /// Null (with the path to share in `finalPath` and the folder still open in `held`, without delete sharing, so it
        /// cannot be renamed or swapped for a link until the caller closes it after the share) when the folder may be
        /// shared with Windows Sandbox; otherwise why not.
        /// </summary>
        public static string Problem(string path, bool readOnly, string storageRoot, string dataPath, out string finalPath, out IntPtr held)
        {
            finalPath = null;
            held = IntPtr.Zero;
            if (string.IsNullOrEmpty(storageRoot) || string.IsNullOrEmpty(dataPath))
            {
                return "the request must name this tool's storage and data folders (they are never shared)";
            }
            string problem = ShareRequest.FolderProblem(path);
            if (problem != null)
            {
                return problem;
            }
            string folder = path.TrimEnd('\\');
            if (IsSubst(folder.Substring(0, 2)))
            {
                return "the folder is on a subst drive: give its real path";
            }
            string real;
            problem = Open(folder, out real, out held);
            if (problem != null)
            {
                return problem;
            }
            problem = CheckOpened(folder, real, readOnly, storageRoot, dataPath);
            if (problem != null)
            {
                Close(held);
                held = IntPtr.Zero;
                return problem;
            }
            finalPath = real;
            return null;
        }

        private static string CheckOpened(string folder, string real, bool readOnly, string storageRoot, string dataPath)
        {
            string problem;
            if (!string.Equals(real, folder, StringComparison.OrdinalIgnoreCase))
            {
                return "the folder's real path is " + real + ": give that one";
            }
            problem = DeniedProblem(real, storageRoot, dataPath);
            if (problem != null)
            {
                return problem;
            }
            return UserAccessProblem(real, readOnly);
        }

        public static void Close(IntPtr held)
        {
            if (held != IntPtr.Zero && held != InvalidHandle)
            {
                NativeMethods.CloseHandle(held);
            }
        }

        /// <summary>After the share: the held folder is still at `path` (null), or why not.</summary>
        public static string MovedProblem(IntPtr held, string path)
        {
            string now;
            string problem = FinalPath(held, out now);
            if (problem != null)
            {
                return problem;
            }
            return string.Equals(now, path, StringComparison.OrdinalIgnoreCase) ? null : "the folder moved while it was being shared";
        }

        private static bool IsSubst(string drive)
        {
            StringBuilder target = new StringBuilder(1024);
            if (NativeMethods.QueryDosDeviceW(drive, target, (uint)target.Capacity) == 0)
            {
                return true; // unknown: treated like a subst (fail closed)
            }
            return target.ToString().StartsWith("\\??\\", StringComparison.Ordinal);
        }

        /// <summary>
        /// Opens the folder itself without following a link and without delete sharing (kept open in `handle`), and
        /// says the path Windows reports for it.
        /// </summary>
        private static string Open(string folder, out string real, out IntPtr handle)
        {
            real = null;
            handle = NativeMethods.CreateFileW(folder, FileReadAttributes, FileShareReadWrite, IntPtr.Zero, OpenExisting, FlagBackupSemantics | FlagOpenReparsePoint, IntPtr.Zero);
            if (handle == InvalidHandle)
            {
                handle = IntPtr.Zero;
                return "the folder cannot be opened (or something is renaming it): " + new Win32Exception(Marshal.GetLastWin32Error()).Message;
            }
            bool keep = false;
            try
            {
                ByHandleFileInformation info;
                if (!NativeMethods.GetFileInformationByHandle(handle, out info))
                {
                    return "the folder cannot be read: " + new Win32Exception(Marshal.GetLastWin32Error()).Message;
                }
                if ((info.FileAttributes & AttributeDirectory) == 0 || (info.FileAttributes & AttributeReparsePoint) != 0)
                {
                    return "only a plain folder (not a file or a link) can be shared";
                }
                string problem = FinalPath(handle, out real);
                keep = problem == null;
                return problem;
            }
            finally
            {
                if (!keep)
                {
                    NativeMethods.CloseHandle(handle);
                    handle = IntPtr.Zero;
                }
            }
        }

        private static string FinalPath(IntPtr handle, out string real)
        {
            real = null;
            StringBuilder sb = new StringBuilder(1024);
            uint length = NativeMethods.GetFinalPathNameByHandleW(handle, sb, (uint)sb.Capacity, 0);
            if (length == 0 || length >= sb.Capacity)
            {
                return "the folder's real path cannot be read";
            }
            string text = sb.ToString();
            {
                if (!text.StartsWith("\\\\?\\", StringComparison.Ordinal) || text.StartsWith("\\\\?\\UNC\\", StringComparison.OrdinalIgnoreCase))
                {
                    return "only folders on a local drive can be shared";
                }
                real = text.Substring(4).TrimEnd('\\');
                return null;
            }
        }

        private static bool Within(string parent, string child)
        {
            if (string.IsNullOrEmpty(parent))
            {
                return false;
            }
            string p = parent.TrimEnd('\\');
            return string.Equals(p, child, StringComparison.OrdinalIgnoreCase) ||
                child.StartsWith(p + "\\", StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>Pure apart from the special folders: the folders that are never shared.</summary>
        public static string DeniedProblem(string real, string storageRoot, string dataPath)
        {
            string[] system = new string[]
            {
                Environment.GetFolderPath(Environment.SpecialFolder.Windows),
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
            };
            foreach (string s in system)
            {
                if (Within(s, real) || Within(real, s))
                {
                    return "system folders cannot be shared: " + real;
                }
            }
            string profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile).TrimEnd('\\');
            string users = Path.GetDirectoryName(profile);
            if (Within(users, real) && !(Within(profile, real) && !string.Equals(profile, real, StringComparison.OrdinalIgnoreCase)))
            {
                return "only a folder inside your own profile can be shared from the users folder (never the profile itself or another user's)";
            }
            foreach (string own in new string[] { storageRoot, dataPath })
            {
                if (!string.IsNullOrEmpty(own) && (Within(own, real) || Within(real, own)))
                {
                    return "this tool's own storage or data folder cannot be shared: " + real;
                }
            }
            return null;
        }

        /// <summary>The token of the user who asked: the unelevated half of an elevated token, else this one.</summary>
        private static IntPtr UserToken()
        {
            IntPtr process;
            if (!NativeMethods.OpenProcessToken(NativeMethods.GetCurrentProcess(), TokenQuery | TokenDuplicate, out process))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            try
            {
                IntPtr linked;
                int returned;
                if (NativeMethods.GetTokenInformation(process, TokenLinkedTokenClass, out linked, IntPtr.Size, out returned) && linked != IntPtr.Zero)
                {
                    return linked;
                }
                IntPtr duplicate;
                if (!NativeMethods.DuplicateToken(process, SecurityIdentification, out duplicate))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
                return duplicate;
            }
            finally
            {
                NativeMethods.CloseHandle(process);
            }
        }

        /// <summary>Null when the unelevated user may list (and, for a writable share, change) the folder themselves.</summary>
        public static string UserAccessProblem(string folder, bool readOnly)
        {
            uint needed;
            NativeMethods.GetFileSecurityW(folder, OwnerGroupDacl, null, 0, out needed);
            if (needed == 0 || needed > 1024 * 1024)
            {
                return "the folder's permissions cannot be read";
            }
            byte[] descriptor = new byte[needed];
            if (!NativeMethods.GetFileSecurityW(folder, OwnerGroupDacl, descriptor, needed, out needed))
            {
                return "the folder's permissions cannot be read: " + new Win32Exception(Marshal.GetLastWin32Error()).Message;
            }
            IntPtr token = IntPtr.Zero;
            try
            {
                token = UserToken();
                GenericMapping mapping = new GenericMapping();
                mapping.GenericRead = FileGenericRead;
                mapping.GenericWrite = FileGenericWrite;
                mapping.GenericExecute = FileGenericExecute;
                mapping.GenericAll = FileAllAccess;
                uint desired = FileGenericRead | FileTraverse | (readOnly ? 0u : FileGenericWrite);
                byte[] privileges = new byte[256];
                uint privilegesLength = (uint)privileges.Length;
                uint granted;
                bool allowed;
                if (!NativeMethods.AccessCheck(descriptor, token, desired, ref mapping, privileges, ref privilegesLength, out granted, out allowed))
                {
                    return "the folder's permissions cannot be checked: " + new Win32Exception(Marshal.GetLastWin32Error()).Message;
                }
                if (!allowed)
                {
                    return readOnly ? "you cannot read this folder yourself, so it cannot be shared" : "you cannot change this folder yourself, so it cannot be shared writable";
                }
                return null;
            }
            finally
            {
                if (token != IntPtr.Zero)
                {
                    NativeMethods.CloseHandle(token);
                }
            }
        }
    }
}
