// The Windows calls the storage helper makes that are shared by several files: opening files and folders as handles
// (never following a link), the facts a handle can tell (attributes, identity, final path, owner and permissions,
// volume), and device I/O. Signatures from the Microsoft Win32 reference.
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace AgentSandbox.StorageHelper
{
    public static class Win32
    {
        public const uint GenericRead = 0x80000000;
        public const uint GenericWrite = 0x40000000;
        public const uint ReadControl = 0x00020000;
        public const uint Synchronize = 0x00100000;
        public const uint FileReadAttributes = 0x0080;
        public const uint FileWriteAttributes = 0x0100;
        public const uint FileReadData = 0x0001;
        public const uint FileWriteData = 0x0002;
        public const uint Delete = 0x00010000;
        public const uint FileShareRead = 0x1;
        public const uint FileShareWrite = 0x2;
        public const uint FileShareDelete = 0x4;
        public const uint OpenExisting = 3;
        public const uint FlagBackupSemantics = 0x02000000;
        public const uint FlagOpenReparsePoint = 0x00200000;
        public const uint AttributeDirectory = 0x10;
        public const uint AttributeReparsePoint = 0x400;
        public const int ErrorFileNotFound = 2;
        public const int ErrorPathNotFound = 3;
        public const int ErrorSharingViolation = 32;
        public const int ErrorMoreData = 234;
        public const int ErrorNoMoreFiles = 18;
        public const uint SeFileObject = 1;
        public const uint OwnerSecurityInformation = 0x1;
        public const uint GroupSecurityInformation = 0x2;
        public const uint DaclSecurityInformation = 0x4;
        public const uint DriveFixed = 3;

        [StructLayout(LayoutKind.Sequential)]
        public struct FileTime
        {
            public uint Low;
            public uint High;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct ByHandleFileInformation
        {
            public uint FileAttributes;
            public FileTime CreationTime;
            public FileTime LastAccessTime;
            public FileTime LastWriteTime;
            public uint VolumeSerialNumber;
            public uint FileSizeHigh;
            public uint FileSizeLow;
            public uint NumberOfLinks;
            public uint FileIndexHigh;
            public uint FileIndexLow;
        }

        public static class NativeMethods
        {
            [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
            public static extern SafeFileHandle CreateFileW(string fileName, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);

            [DllImport("kernel32.dll", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool GetFileInformationByHandle(SafeFileHandle file, out ByHandleFileInformation information);

            [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
            public static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder path, uint size, uint flags);

            [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool GetVolumeInformationByHandleW(SafeFileHandle file, StringBuilder volumeName, uint volumeNameSize, out uint serial, out uint maxComponent, out uint flags, StringBuilder fileSystem, uint fileSystemSize);

            [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
            public static extern uint GetDriveTypeW(string root);

            [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
            public static extern uint GetLongPathNameW(string shortPath, StringBuilder longPath, uint size);

            [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool GetVolumePathNameW(string fileName, StringBuilder volumePath, uint size);

            [DllImport("advapi32.dll", SetLastError = false)]
            public static extern uint GetSecurityInfo(SafeFileHandle handle, uint objectType, uint securityInfo, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr securityDescriptor);

            [DllImport("advapi32.dll")]
            public static extern uint GetSecurityDescriptorLength(IntPtr securityDescriptor);

            [DllImport("kernel32.dll")]
            public static extern IntPtr LocalFree(IntPtr memory);

            [DllImport("kernel32.dll", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool DeviceIoControl(SafeFileHandle device, uint code, byte[] input, int inputSize, byte[] output, int outputSize, out int returned, IntPtr overlapped);
        }

        public static Win32Exception LastError(string what)
        {
            int code = Marshal.GetLastWin32Error();
            return new Win32Exception(code, what + ": " + new Win32Exception(code).Message);
        }

        /// <summary>A handle to a file or folder that is never followed through a link. Null when it does not exist.</summary>
        public static SafeFileHandle OpenNoFollow(string path, uint access, uint share)
        {
            SafeFileHandle handle = NativeMethods.CreateFileW(path, access, share, IntPtr.Zero, OpenExisting, FlagBackupSemantics | FlagOpenReparsePoint, IntPtr.Zero);
            if (handle.IsInvalid)
            {
                int code = Marshal.GetLastWin32Error();
                handle.Dispose();
                if (code == ErrorFileNotFound || code == ErrorPathNotFound)
                {
                    return null;
                }
                if (code == ErrorSharingViolation)
                {
                    throw new RefusedException("Something else has " + path + " open (it may be in the middle of a move); try again.");
                }
                throw new Win32Exception(code, "Could not open " + path + ": " + new Win32Exception(code).Message);
            }
            return handle;
        }

        public static ByHandleFileInformation InfoOf(SafeFileHandle handle, string what)
        {
            ByHandleFileInformation info;
            if (!NativeMethods.GetFileInformationByHandle(handle, out info))
            {
                throw LastError("Could not read " + what);
            }
            return info;
        }

        /// <summary>The path Windows says the handle has (with its drive letter, without the \\?\ prefix).</summary>
        public static string FinalPath(SafeFileHandle handle)
        {
            StringBuilder sb = new StringBuilder(1024);
            uint n = NativeMethods.GetFinalPathNameByHandleW(handle, sb, (uint)sb.Capacity, 0);
            if (n == 0 || n >= sb.Capacity)
            {
                throw LastError("Could not read where a folder is");
            }
            string path = sb.ToString();
            if (path.StartsWith("\\\\?\\UNC\\", StringComparison.Ordinal))
            {
                throw new RefusedException("A network folder cannot hold contained storage.");
            }
            return path.StartsWith("\\\\?\\", StringComparison.Ordinal) ? path.Substring(4) : path;
        }

        /// <summary>The owner and the permissions of what the handle points to (it needs READ_CONTROL).</summary>
        public static System.Security.AccessControl.RawSecurityDescriptor SecurityOf(SafeFileHandle handle)
        {
            IntPtr owner;
            IntPtr group;
            IntPtr dacl;
            IntPtr sacl;
            IntPtr descriptor;
            uint error = NativeMethods.GetSecurityInfo(handle, SeFileObject, OwnerSecurityInformation | GroupSecurityInformation | DaclSecurityInformation, out owner, out group, out dacl, out sacl, out descriptor);
            if (error != 0)
            {
                throw new Win32Exception((int)error, "Could not read the permissions: " + new Win32Exception((int)error).Message);
            }
            try
            {
                int length = (int)NativeMethods.GetSecurityDescriptorLength(descriptor);
                byte[] bytes = new byte[length];
                Marshal.Copy(descriptor, bytes, 0, length);
                return new System.Security.AccessControl.RawSecurityDescriptor(bytes, 0);
            }
            finally
            {
                NativeMethods.LocalFree(descriptor);
            }
        }

        public static string FileSystemOf(SafeFileHandle handle)
        {
            StringBuilder name = new StringBuilder(261);
            StringBuilder fs = new StringBuilder(261);
            uint serial;
            uint max;
            uint flags;
            if (!NativeMethods.GetVolumeInformationByHandleW(handle, name, (uint)name.Capacity, out serial, out max, out flags, fs, (uint)fs.Capacity))
            {
                throw LastError("Could not read the drive's file system");
            }
            return fs.ToString();
        }

        /// <summary>The root of the volume a path is on (C:\, or a folder when a volume is mounted there).</summary>
        public static string VolumePathOf(string path)
        {
            StringBuilder sb = new StringBuilder(1024);
            if (!NativeMethods.GetVolumePathNameW(path, sb, (uint)sb.Capacity))
            {
                throw LastError("Could not tell which drive " + path + " is on");
            }
            return sb.ToString();
        }

        /// <summary>True when the handle is at exactly this path (8.3 short names in it are fine).</summary>
        public static bool IsAt(SafeFileHandle handle, string expected)
        {
            string actual = FinalPath(handle);
            return Rules.SamePath(actual, expected) || Rules.SamePath(actual, LongPath(expected));
        }

        /// <summary>The path with 8.3 short names spelled out (the path itself when Windows cannot say).</summary>
        public static string LongPath(string path)
        {
            StringBuilder sb = new StringBuilder(1024);
            uint n = NativeMethods.GetLongPathNameW(path, sb, (uint)sb.Capacity);
            return n == 0 || n >= sb.Capacity ? path : sb.ToString();
        }

        public static uint DriveTypeOf(string root)
        {
            return NativeMethods.GetDriveTypeW(root);
        }

        /// <summary>DeviceIoControl with byte buffers; throws on failure.</summary>
        public static int Ioctl(SafeFileHandle device, uint code, byte[] input, byte[] output, string what)
        {
            int returned;
            if (!NativeMethods.DeviceIoControl(device, code, input, input == null ? 0 : input.Length, output, output == null ? 0 : output.Length, out returned, IntPtr.Zero))
            {
                throw LastError(what);
            }
            return returned;
        }

        /// <summary>DeviceIoControl that reports the Windows error code instead of throwing (0 = done).</summary>
        public static int TryIoctl(SafeFileHandle device, uint code, byte[] input, byte[] output, out int returned)
        {
            if (NativeMethods.DeviceIoControl(device, code, input, input == null ? 0 : input.Length, output, output == null ? 0 : output.Length, out returned, IntPtr.Zero))
            {
                return 0;
            }
            return Marshal.GetLastWin32Error();
        }
    }
}
