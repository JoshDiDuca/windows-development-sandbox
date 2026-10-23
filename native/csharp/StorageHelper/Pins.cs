// The folders and the image of one data set, opened as handles and held for the whole call. Each handle is opened
// without following links and without sharing delete, so while it is open nothing on the way can be renamed, deleted
// or swapped for a link. Every handle is then checked: not a link, the path Windows reports is the exact path, on a
// local fixed NTFS drive, and (for the user's own folders and the image) owned by the client with nobody else allowed
// to change it. These are the checks of contained-common.ps1, done on handles instead of on names.
using System;
using System.Collections.Generic;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace AgentSandbox.StorageHelper
{
    public sealed class Pins : IDisposable
    {
        private const uint LookAccess = Win32.ReadControl | Win32.FileReadAttributes | Win32.Synchronize;
        private const uint Share = Win32.FileShareRead | Win32.FileShareWrite;
        private const int WriteRights = 0x2 | 0x4 | 0x10 | 0x40 | 0x100 | 0x10000 | 0x40000 | 0x80000 | 0x10000000 | 0x40000000;
        private static readonly string[] Trusted = { "S-1-5-18", "S-1-5-32-544", "S-1-3-0" };
        private readonly List<SafeFileHandle> held = new List<SafeFileHandle>();
        private readonly ContainedPaths paths;
        private readonly SecurityIdentifier user;

        private Pins(ContainedPaths paths, SecurityIdentifier user)
        {
            this.paths = paths;
            this.user = user;
        }

        public SafeFileHandle Images { get; private set; }
        public SafeFileHandle MountFolder { get; private set; }
        public SafeFileHandle Image { get; private set; }
        public bool MountIsMountPoint { get; private set; }
        public Win32.ByHandleFileInformation ImageIdentity { get; private set; }

        /// <summary>
        /// Opens and checks everything from the drive root down to the mount folder. The mount folder is opened so it can
        /// take a mount point. The image is opened when it exists.
        /// </summary>
        public static Pins Take(ContainedPaths paths, SecurityIdentifier user)
        {
            Pins pins = new Pins(paths, user);
            try
            {
                pins.TakeAll();
                return pins;
            }
            catch
            {
                pins.Dispose();
                throw;
            }
        }

        private void TakeAll()
        {
            string[] above = Rules.FoldersDownTo(paths.StorageRoot);
            SafeFileHandle root = null;
            for (int i = 0; i < above.Length; i++)
            {
                SafeFileHandle h = Folder(above[i], LookAccess, i == above.Length - 1 ? "The storage folder is missing: " : "A folder is missing: ");
                if (i == 0)
                {
                    CheckDrive(h, above[0]);
                }
                root = h;
            }
            string volumeRoot = Win32.VolumePathOf(paths.StorageRoot + "\\");
            if (volumeRoot.TrimEnd('\\').Length != 2)
            {
                throw new RefusedException("The storage folder is inside a mounted disk (" + Safe.Text(volumeRoot, 200) + "); contained storage cannot nest.");
            }
            CheckMine(root, paths.StorageRoot);
            Images = Folder(paths.ImagesDir, LookAccess, "A folder is missing: ");
            CheckMine(Images, paths.ImagesDir);
            SafeFileHandle mounts = Folder(paths.MountsDir, LookAccess, "A folder is missing: ");
            CheckMine(mounts, paths.MountsDir);
            MountFolder = Open(paths.Mount, LookAccess | Win32.FileWriteAttributes | Win32.FileWriteData, true);
            if (MountFolder == null)
            {
                throw new RefusedException("The mount folder is missing: " + paths.Mount);
            }
            Win32.ByHandleFileInformation mountInfo = Win32.InfoOf(MountFolder, paths.Mount);
            if ((mountInfo.FileAttributes & Win32.AttributeDirectory) == 0)
            {
                throw new RefusedException("The mount folder is not a folder: " + paths.Mount);
            }
            MountIsMountPoint = (mountInfo.FileAttributes & Win32.AttributeReparsePoint) != 0;
            CheckPath(MountFolder, paths.Mount);
            CheckMine(MountFolder, paths.Mount);
            Image = Open(paths.Image, LookAccess, false);
            if (Image != null)
            {
                Win32.ByHandleFileInformation info = Win32.InfoOf(Image, paths.Image);
                if ((info.FileAttributes & Win32.AttributeReparsePoint) != 0)
                {
                    throw new RefusedException("Refusing a link: " + paths.Image);
                }
                if ((info.FileAttributes & Win32.AttributeDirectory) != 0)
                {
                    throw new RefusedException("The image is not a file: " + paths.Image);
                }
                if (info.NumberOfLinks != 1)
                {
                    throw new RefusedException("The image has other names (hard links); refusing it: " + paths.Image);
                }
                CheckPath(Image, paths.Image);
                CheckMine(Image, paths.Image);
                ImageIdentity = info;
            }
            RecheckNoLinks();
        }

        /// <summary>
        /// Every pinned folder is looked at again: a folder that was empty when it was checked could have become a link
        /// before the folder below it was opened. Once all are pinned, none can (they are not empty, and cannot be renamed).
        /// </summary>
        private void RecheckNoLinks()
        {
            foreach (SafeFileHandle h in held)
            {
                if (h == MountFolder || h == Image)
                {
                    continue;
                }
                if ((Win32.InfoOf(h, "a folder").FileAttributes & Win32.AttributeReparsePoint) != 0)
                {
                    throw new RefusedException("A folder on the way became a link while it was being checked; nothing was done.");
                }
            }
        }

        /// <summary>True when the mount folder (pinned) is still a plain folder, not a link made after it was checked.</summary>
        public bool MountFolderStillPlain()
        {
            return (Win32.InfoOf(MountFolder, paths.Mount).FileAttributes & Win32.AttributeReparsePoint) == 0;
        }

        /// <summary>Pins the image after this service made it (it did not exist when the folders were taken).</summary>
        public void TakeNewImage()
        {
            Image = Open(paths.Image, LookAccess, false);
            if (Image == null)
            {
                throw new InvalidOperationException("The new image is not there.");
            }
            CheckPath(Image, paths.Image);
            ImageIdentity = Win32.InfoOf(Image, paths.Image);
        }

        /// <summary>True when the file at the image path is still the pinned one (same volume and file id).</summary>
        public bool StillTheImage(SafeFileHandle other)
        {
            Win32.ByHandleFileInformation now = Win32.InfoOf(other, paths.Image);
            return now.VolumeSerialNumber == ImageIdentity.VolumeSerialNumber && now.FileIndexHigh == ImageIdentity.FileIndexHigh && now.FileIndexLow == ImageIdentity.FileIndexLow;
        }

        private SafeFileHandle Folder(string path, uint access, string missing)
        {
            SafeFileHandle h = Open(path, access, true);
            if (h == null)
            {
                throw new RefusedException(missing + path);
            }
            Win32.ByHandleFileInformation info = Win32.InfoOf(h, path);
            if ((info.FileAttributes & Win32.AttributeReparsePoint) != 0)
            {
                throw new RefusedException(path.Length <= paths.StorageRoot.Length && !Rules.SamePath(path, paths.StorageRoot) ? "Refusing a link above the storage folder: " + path : "Refusing a link: " + path);
            }
            if ((info.FileAttributes & Win32.AttributeDirectory) == 0)
            {
                throw new RefusedException("Not a folder: " + path);
            }
            CheckPath(h, path);
            return h;
        }

        private SafeFileHandle Open(string path, uint access, bool folder)
        {
            SafeFileHandle h = Win32.OpenNoFollow(path, access, Share);
            if (h != null)
            {
                held.Add(h);
            }
            return h;
        }

        private static void CheckPath(SafeFileHandle h, string expected)
        {
            // A short 8.3 name (WDAGUT~1) comes back long; the long form of the expected path is accepted too.
            if (!Win32.IsAt(h, expected))
            {
                throw new RefusedException("The folder is not where it says it is (a link on the way?): " + expected);
            }
        }

        private static void CheckDrive(SafeFileHandle h, string driveRoot)
        {
            if (Win32.DriveTypeOf(driveRoot) != Win32.DriveFixed)
            {
                throw new RefusedException("Contained storage must be on a fixed local drive, not " + driveRoot);
            }
            string fs = Win32.FileSystemOf(h);
            if (!string.Equals(fs, "NTFS", StringComparison.OrdinalIgnoreCase))
            {
                throw new RefusedException("Contained storage must be on an NTFS drive (" + driveRoot + " is " + Safe.Text(fs, 20) + ").");
            }
        }

        /// <summary>Owned by the client, and nobody but the client, SYSTEM and Administrators may change or delete it.</summary>
        private void CheckMine(SafeFileHandle h, string path)
        {
            RawSecurityDescriptor sd = Win32.SecurityOf(h);
            if (sd.Owner == null || !sd.Owner.Equals(user))
            {
                throw new RefusedException("Not yours (owner " + (sd.Owner == null ? "none" : sd.Owner.Value) + "): " + path);
            }
            string other = OthersWhoMayChange(sd, user);
            if (other != null)
            {
                throw new RefusedException("Someone else may change " + path + " (" + other + "); make it private first (sandbox repair).");
            }
        }

        /// <summary>The first SID other than the user, SYSTEM, Administrators and CREATOR OWNER with a right to change, or null.</summary>
        public static string OthersWhoMayChange(RawSecurityDescriptor sd, SecurityIdentifier user)
        {
            if (sd.DiscretionaryAcl == null)
            {
                return "Everyone (no permissions set)";
            }
            foreach (GenericAce ace in sd.DiscretionaryAcl)
            {
                if (ace.AceType == AceType.AccessDenied || ace.AceType == AceType.AccessDeniedObject || ace.AceType == AceType.AccessDeniedCallback || ace.AceType == AceType.AccessDeniedCallbackObject)
                {
                    continue;
                }
                KnownAce known = ace as KnownAce;
                if (known == null)
                {
                    return "an entry of an unknown kind";
                }
                if (ace.AceType == AceType.SystemAudit || ace.AceType == AceType.SystemAlarm)
                {
                    continue;
                }
                if ((known.AccessMask & WriteRights) == 0)
                {
                    continue;
                }
                SecurityIdentifier sid = known.SecurityIdentifier;
                if (sid.Equals(user) || Array.IndexOf(Trusted, sid.Value) >= 0)
                {
                    continue;
                }
                return sid.Value;
            }
            return null;
        }

        public void Dispose()
        {
            foreach (SafeFileHandle h in held)
            {
                h.Dispose();
            }
            held.Clear();
        }
    }
}
