// The two things the service does: mount one data set's image at its mount folder (making and formatting the image
// the very first time) and dismount it. The same rules as mount-contained.ps1 and dismount-contained.ps1, on handles:
// the folders and the image are pinned and checked first (Pins), the image is opened once and that same handle is
// checked by the disk driver and attached, and the mount point is written on the pinned folder's handle. An existing
// image is never formatted or deleted; a new one is only made where no file is. A dry run checks everything and
// changes nothing.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace AgentSandbox.StorageHelper
{
    public sealed class Outcome
    {
        public bool Ok { get; set; }
        public string Message { get; set; }
        public bool Created { get; set; }
        public bool AlreadyMounted { get; set; }

        /// <summary>The helper leaves this one to the Windows permission prompt (the CLI then uses it).</summary>
        public bool Fallback { get; set; }

        public string Image { get; set; }
        public string Mount { get; set; }

        /// <summary>A step on the caller's own files was cancelled after the time limit (the caller may be stalling it).</summary>
        public bool TimedOut { get; set; }
        public List<string> Notes { get; private set; }

        public Outcome()
        {
            Message = "";
            Notes = new List<string>();
        }
    }

    public sealed class Request
    {
        public string Verb { get; set; }
        public string Set { get; set; }
        public SecurityIdentifier User { get; set; }

        /// <summary>The client's token, for the access check before a new image is made; null in a dry run of the tests.</summary>
        public SafeAccessTokenHandle Token { get; set; }

        public StorageSettings Settings { get; set; }
        public bool DryRun { get; set; }

        /// <summary>Dismount only clears a stale mount point; an image that is attached stays (the service's start-up tidy).</summary>
        public bool OnlyIfDetached { get; set; }
    }

    public static class Operations
    {
        private const uint FileAddFile = 0x2;
        private static readonly TimeSpan VolumeWait = TimeSpan.FromSeconds(60);
        private static readonly TimeSpan OpenLimit = TimeSpan.FromSeconds(30);

        private static class NativeMethods
        {
            [DllImport("advapi32.dll", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool AccessCheck(byte[] securityDescriptor, SafeAccessTokenHandle token, uint desiredAccess, ref GenericMapping mapping, byte[] privileges, ref uint privilegesLength, out uint granted, [MarshalAs(UnmanagedType.Bool)] out bool status);

            [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool SetFileSecurityW(string fileName, uint securityInformation, byte[] securityDescriptor);
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct GenericMapping
        {
            public uint Read;
            public uint Write;
            public uint Execute;
            public uint All;
        }

        public static Outcome Run(Request request)
        {
            Outcome outcome = new Outcome();
            using (Watchdog dog = new Watchdog(OpenLimit))
            {
                RunGuarded(request, outcome);
                if (dog.Fired && !outcome.Ok)
                {
                    outcome.TimedOut = true;
                    outcome.Message = new TimedOutException().Message;
                }
            }
            return outcome;
        }

        private static void RunGuarded(Request request, Outcome outcome)
        {
            try
            {
                Rules.CheckMaxGb(request.Settings.MaxGb);
                ContainedPaths paths = Rules.PathsFor(request.Settings.StorageRoot, request.Set);
                outcome.Image = paths.Image;
                outcome.Mount = paths.Mount;
                if (request.Verb == "mount")
                {
                    Mount(request, paths, outcome);
                }
                else if (request.Verb == "dismount")
                {
                    Dismount(request, paths, outcome);
                }
                else
                {
                    throw new RefusedException("Unknown request.");
                }
                outcome.Ok = true;
            }
            catch (LogPendingException e)
            {
                outcome.Ok = false;
                outcome.Fallback = true;
                outcome.Message = e.Message;
            }
            catch (RefusedException e)
            {
                outcome.Ok = false;
                outcome.Message = e.Message;
            }
            catch (Win32Exception e)
            {
                outcome.Ok = false;
                outcome.Message = e.Message;
            }
            catch (InvalidOperationException e)
            {
                outcome.Ok = false;
                outcome.Message = e.Message;
            }
            catch (IOException e)
            {
                outcome.Ok = false;
                outcome.Message = e.Message;
            }
            catch (UnauthorizedAccessException e)
            {
                outcome.Ok = false;
                outcome.Message = e.Message;
            }
            catch (Exception e)
            {
                // Anything else is a fault of this service, not something to show in detail.
                outcome.Ok = false;
                outcome.Message = "The storage helper failed (" + e.GetType().Name + ").";
            }
        }

        private static void Mount(Request request, ContainedPaths paths, Outcome outcome)
        {
            using (Pins pins = Pins.Take(paths, request.User))
            {
                if (pins.Image == null)
                {
                    MountNew(request, paths, pins, outcome);
                }
                else
                {
                    MountExisting(request, paths, pins, outcome);
                }
            }
        }

        private static void MountNew(Request request, ContainedPaths paths, Pins pins, Outcome outcome)
        {
            if (pins.MountIsMountPoint)
            {
                ClearDanglingMountPoint(pins, request.DryRun, outcome);
            }
            RequireEmpty(paths.Mount);
            if (request.Token != null && !MayAddFile(pins.Images, request.Token))
            {
                throw new RefusedException("You may not create files in " + paths.ImagesDir + ".");
            }
            if (request.DryRun)
            {
                outcome.Notes.Add("would create a dynamic VHDX of at most " + request.Settings.MaxGb + " GB, partition, format and mount it");
                outcome.Created = true;
                outcome.Message = "The image would be created and mounted.";
                return;
            }
            DriveInfo drive = new DriveInfo(paths.StorageRoot.Substring(0, 3));
            if (drive.AvailableFreeSpace < 1024L * 1024L * 1024L)
            {
                throw new RefusedException("There is less than 1 GB free where the image would be made.");
            }
            string sddl = "O:" + request.User.Value + "D:P(A;;FA;;;" + request.User.Value + ")(A;;FA;;;SY)(A;;FA;;;BA)";
            RawSecurityDescriptor sd = new RawSecurityDescriptor(sddl);
            byte[] sdBytes = new byte[sd.BinaryLength];
            sd.GetBinaryForm(sdBytes, 0);
            bool attached = false;
            bool mounted = false;
            VirtualDisk disk = VirtualDisk.Create(paths.Image, request.Settings.MaxGb, sdBytes);
            try
            {
                pins.TakeNewImage();
                disk.Attach();
                attached = true;
                int number = disk.DiskNumber();
                if (number < 0)
                {
                    throw new InvalidOperationException("The new image did not show up as a disk.");
                }
                List<string> volumes = null;
                // The service's own new disk: no time limit (a format takes a while).
                Watchdog.Suspended(delegate
                {
                    Volumes.Partition(number);
                    volumes = Volumes.WaitFor(number, 1, VolumeWait);
                    if (volumes.Count != 1)
                    {
                        throw new InvalidOperationException("The new disk has " + volumes.Count + " volumes instead of one.");
                    }
                    Volumes.Format(volumes[0], "AgentData");
                });
                string volume = volumes[0];
                Volumes.RemoveDriveLetters(volume);
                RequirePlainMountFolder(pins);
                Volumes.SetMountPoint(pins.MountFolder, volume);
                mounted = true;
                // The new volume's root is open to Users by default: only the user and the system may use it.
                RawSecurityDescriptor root = new RawSecurityDescriptor("D:P(A;OICI;FA;;;" + request.User.Value + ")(A;OICI;FA;;;SY)");
                byte[] rootBytes = new byte[root.BinaryLength];
                root.GetBinaryForm(rootBytes, 0);
                if (!NativeMethods.SetFileSecurityW(volume, Win32.DaclSecurityInformation, rootBytes))
                {
                    throw Win32.LastError("Could not make the new disk private");
                }
                outcome.Created = true;
                outcome.Message = "The image was created and mounted.";
            }
            catch (Exception e)
            {
                string problem = e.Message;
                if (mounted)
                {
                    TryRemoveMountPoint(pins);
                }
                if (attached)
                {
                    try
                    {
                        disk.Detach();
                    }
                    catch (Win32Exception detach)
                    {
                        problem += " (it could not be detached again: " + detach.Message + ")";
                    }
                }
                disk.Dispose();
                problem += KeepFailedImage(pins, paths);
                throw new InvalidOperationException(problem);
            }
            disk.Dispose();
        }

        private static void MountExisting(Request request, ContainedPaths paths, Pins pins, Outcome outcome)
        {
            // Read the header while nobody may write it. A sharing violation means the disk driver has it (attached).
            using (SafeFileHandle reader = TryOpenExclusiveRead(paths.Image))
            {
                if (reader == null)
                {
                    AlreadyAttached(paths, pins, outcome);
                    return;
                }
                RequireSame(pins, reader);
                using (FileStream stream = new FileStream(reader, FileAccess.Read))
                {
                    Vhdx.CheckPlain(Vhdx.Read(stream), request.Settings.MaxGb);
                }
            }
            if (pins.MountIsMountPoint)
            {
                ClearDanglingMountPoint(pins, request.DryRun, outcome);
            }
            RequireEmpty(paths.Mount);
            if (request.DryRun)
            {
                outcome.Notes.Add("would attach the image and mount its one NTFS volume at the mount folder");
                outcome.Message = "The image would be mounted.";
                return;
            }
            bool attached = false;
            bool mounted = false;
            using (VirtualDisk disk = VirtualDisk.Open(paths.Image))
            {
                try
                {
                    // The path cannot have moved (it is pinned); the file behind it is checked to be the same anyway.
                    using (SafeFileHandle again = Win32.OpenNoFollow(paths.Image, Win32.FileReadAttributes | Win32.GenericRead, Win32.FileShareRead | Win32.FileShareWrite))
                    {
                        if (again == null)
                        {
                            throw new RefusedException("The image went away.");
                        }
                        RequireSame(pins, again);
                        using (FileStream stream = new FileStream(again, FileAccess.Read))
                        {
                            Vhdx.CheckPlain(Vhdx.Read(stream), request.Settings.MaxGb);
                        }
                    }
                    disk.CheckPlain(request.Settings.MaxGb);
                    if (disk.DiskNumber() >= 0)
                    {
                        throw new RefusedException("The image was attached by something else just now. Detach it there first.");
                    }
                    disk.Attach();
                    attached = true;
                    int number = disk.DiskNumber();
                    if (number < 0)
                    {
                        throw new InvalidOperationException("The image did not show up as a disk.");
                    }
                    List<string> volumes = null;
                    Watchdog.Suspended(delegate { volumes = Volumes.WaitFor(number, 1, VolumeWait); });
                    if (Volumes.IsOfflineOrReadOnly(number))
                    {
                        throw new RefusedException("Windows keeps the image's disk offline (is it a copy of another disk?); refusing it.");
                    }
                    if (volumes.Count != 1 || Volumes.PartitionCount(number) != 1)
                    {
                        throw new RefusedException("The image must hold exactly one partition (it has " + Volumes.PartitionCount(number) + ", " + volumes.Count + " volumes); refusing it.");
                    }
                    string volume = volumes[0];
                    if (!string.Equals(Volumes.FileSystemOf(volume), "NTFS", StringComparison.OrdinalIgnoreCase))
                    {
                        throw new RefusedException("The image's volume is not NTFS; refusing it.");
                    }
                    Volumes.RemoveDriveLetters(volume);
                    RequirePlainMountFolder(pins);
                    Volumes.SetMountPoint(pins.MountFolder, volume);
                    mounted = true;
                    outcome.Message = "The image was mounted.";
                }
                catch (Exception)
                {
                    if (mounted)
                    {
                        TryRemoveMountPoint(pins);
                    }
                    if (attached)
                    {
                        try
                        {
                            disk.Detach();
                        }
                        catch (Win32Exception)
                        {
                            // Reported by the next doctor run (the image stays attached, mounted nowhere).
                        }
                    }
                    throw;
                }
            }
        }

        /// <summary>The image is attached already: fine when it is mounted at this mount folder, refused otherwise.</summary>
        private static void AlreadyAttached(ContainedPaths paths, Pins pins, Outcome outcome)
        {
            using (VirtualDisk disk = VirtualDisk.Open(paths.Image))
            {
                int number = disk.DiskNumber();
                if (number < 0)
                {
                    throw new RefusedException("Another program has the image open. Close it and try again.");
                }
                string target = pins.MountIsMountPoint ? Volumes.MountTarget(pins.MountFolder) : null;
                if (target != null && ContainsVolume(Volumes.OnDisk(number), target))
                {
                    outcome.AlreadyMounted = true;
                    outcome.Message = "The image is mounted already.";
                    outcome.Notes.Add("already mounted at the mount folder");
                    return;
                }
                throw new RefusedException("The image is attached somewhere else (Disk Management or another tool). Detach it there first.");
            }
        }

        private static void Dismount(Request request, ContainedPaths paths, Outcome outcome)
        {
            using (Pins pins = Pins.Take(paths, request.User))
            {
                if (pins.Image == null)
                {
                    throw new RefusedException("The image is missing: " + paths.Image);
                }
                if (!request.DryRun && !request.OnlyIfDetached && SandboxRunning())
                {
                    throw new RefusedException("A Windows Sandbox is running and may be using the image. Close it first.");
                }
                if (request.DryRun)
                {
                    outcome.Notes.Add("would take the mount point off the mount folder and detach the image");
                    outcome.Message = "The image would be detached.";
                    return;
                }
                using (VirtualDisk disk = VirtualDisk.Open(paths.Image))
                {
                    using (SafeFileHandle again = Win32.OpenNoFollow(paths.Image, Win32.FileReadAttributes, Win32.FileShareRead | Win32.FileShareWrite | Win32.FileShareDelete))
                    {
                        if (again == null)
                        {
                            throw new RefusedException("The image went away.");
                        }
                        RequireSame(pins, again);
                    }
                    int number = disk.DiskNumber();
                    if (number >= 0 && request.OnlyIfDetached)
                    {
                        outcome.AlreadyMounted = true;
                        outcome.Message = "The image is mounted; left as it is.";
                        return;
                    }
                    if (number < 0)
                    {
                        if (pins.MountIsMountPoint)
                        {
                            ClearDanglingMountPoint(pins, false, outcome);
                        }
                        outcome.Message = "The image is not mounted.";
                        outcome.Notes.Add("not attached: nothing to do");
                        return;
                    }
                    if (pins.MountIsMountPoint)
                    {
                        // Only a mount point of THIS image's volume is taken off; a link to someone else's volume is left.
                        string target = Volumes.MountTarget(pins.MountFolder);
                        if (target == null || !ContainsVolume(Volumes.OnDisk(number), target))
                        {
                            throw new RefusedException("The mount folder is a mount point of another disk; not touching it: " + paths.Mount);
                        }
                        Volumes.RemoveMountPoint(pins.MountFolder);
                    }
                    disk.Detach();
                    if (disk.DiskNumber() >= 0)
                    {
                        throw new InvalidOperationException("The image is still attached (something is using it). Close programs that use files in it and try again.");
                    }
                    outcome.Message = "The image was detached.";
                }
            }
        }

        /// <summary>A mount point whose volume is gone (the PC restarted while mounted) is taken off; any other is refused.</summary>
        private static void ClearDanglingMountPoint(Pins pins, bool dryRun, Outcome outcome)
        {
            string target = Volumes.MountTarget(pins.MountFolder);
            if (target != null && Volumes.Exists(target))
            {
                throw new RefusedException("The mount folder is a mount point already.");
            }
            outcome.Notes.Add("the mount folder had a mount point of a disk that is gone; it is taken off");
            if (!dryRun)
            {
                Volumes.RemoveMountPoint(pins.MountFolder);
            }
        }

        private static void TryRemoveMountPoint(Pins pins)
        {
            try
            {
                Volumes.RemoveMountPoint(pins.MountFolder);
            }
            catch (Win32Exception)
            {
                // The detach that follows takes the volume away; the next mount clears the stale mount point.
            }
        }

        /// <summary>A half-made new image is renamed (never deleted), so the next try starts clean and nothing is lost.</summary>
        private static string KeepFailedImage(Pins pins, ContainedPaths paths)
        {
            pins.Dispose();
            string kept = paths.Image + ".failed-" + DateTime.Now.ToString("yyyyMMddHHmmss");
            try
            {
                if (File.Exists(paths.Image))
                {
                    File.Move(paths.Image, kept);
                    return " (the unfinished image was kept as " + kept + ")";
                }
                return "";
            }
            catch (IOException)
            {
                return " (the unfinished image is still at " + paths.Image + ")";
            }
        }

        private static void RequireEmpty(string folder)
        {
            using (IEnumerator<string> entries = Directory.EnumerateFileSystemEntries(folder).GetEnumerator())
            {
                if (entries.MoveNext())
                {
                    throw new RefusedException("The mount folder is not empty: " + folder);
                }
            }
        }

        private static void RequirePlainMountFolder(Pins pins)
        {
            if (!pins.MountFolderStillPlain())
            {
                throw new RefusedException("The mount folder became a link while it was being checked; nothing was mounted.");
            }
        }

        private static void RequireSame(Pins pins, SafeFileHandle other)
        {
            if (!pins.StillTheImage(other))
            {
                throw new RefusedException("The image was swapped while it was being checked; nothing was done.");
            }
        }

        private static SafeFileHandle TryOpenExclusiveRead(string path)
        {
            SafeFileHandle h = Win32.NativeMethods.CreateFileW(path, Win32.GenericRead | Win32.FileReadAttributes, Win32.FileShareRead, IntPtr.Zero, Win32.OpenExisting, Win32.FlagOpenReparsePoint, IntPtr.Zero);
            if (h.IsInvalid)
            {
                int code = Marshal.GetLastWin32Error();
                h.Dispose();
                if (code == Win32.ErrorSharingViolation)
                {
                    return null;
                }
                throw new Win32Exception(code, "Could not read the image: " + new Win32Exception(code).Message);
            }
            return h;
        }

        private static bool ContainsVolume(List<string> volumes, string target)
        {
            foreach (string v in volumes)
            {
                if (string.Equals(v.TrimEnd('\\'), target.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }
            return false;
        }

        /// <summary>Would the user be allowed to create a file in this folder (checked against their own token)?</summary>
        private static bool MayAddFile(SafeFileHandle folder, SafeAccessTokenHandle token)
        {
            RawSecurityDescriptor sd = Win32.SecurityOf(folder);
            byte[] bytes = new byte[sd.BinaryLength];
            sd.GetBinaryForm(bytes, 0);
            GenericMapping mapping = new GenericMapping();
            mapping.Read = 0x120089;
            mapping.Write = 0x120116;
            mapping.Execute = 0x1200A0;
            mapping.All = 0x1F01FF;
            byte[] privileges = new byte[256];
            uint length = (uint)privileges.Length;
            uint granted;
            bool status;
            if (!NativeMethods.AccessCheck(bytes, token, FileAddFile, ref mapping, privileges, ref length, out granted, out status))
            {
                throw Win32.LastError("Could not check your access to the images folder");
            }
            return status;
        }

        public static bool SandboxRunning()
        {
            foreach (Process p in Process.GetProcesses())
            {
                using (p)
                {
                    if (p.ProcessName.StartsWith("WindowsSandbox", StringComparison.OrdinalIgnoreCase))
                    {
                        return true;
                    }
                }
            }
            return false;
        }
    }
}
