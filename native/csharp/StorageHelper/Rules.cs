// The pure rules of contained storage, the same as native\scripts\contained-common.ps1 (Test-PlainAbsolute and
// Assert-ContainedRequest): a data set name, a plain full path, and the two paths a data set may use, which the service
// builds itself from the storage folder: <storage>\images\<set>.vhdx and <storage>\mounts\<set>.
using System;
using System.Text.RegularExpressions;

namespace AgentSandbox.StorageHelper
{
    public sealed class ContainedPaths
    {
        public ContainedPaths(string storageRoot, string set)
        {
            StorageRoot = storageRoot;
            Set = set;
            ImagesDir = storageRoot + "\\images";
            MountsDir = storageRoot + "\\mounts";
            Image = ImagesDir + "\\" + set + ".vhdx";
            Mount = MountsDir + "\\" + set;
        }

        public string StorageRoot { get; private set; }
        public string Set { get; private set; }
        public string ImagesDir { get; private set; }
        public string MountsDir { get; private set; }
        public string Image { get; private set; }
        public string Mount { get; private set; }
    }

    public static class Rules
    {
        public const int MinGb = 8;
        public const int MaxGb = 4096;
        private static readonly Regex NameRule = new Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$", RegexOptions.CultureInvariant);
        private static readonly Regex PathRule = new Regex("^[^\"<>|*?\\x00-\\x1f]+$", RegexOptions.CultureInvariant);
        private static readonly Regex DriveRule = new Regex("^[A-Za-z]:\\\\", RegexOptions.CultureInvariant);
        private const int MaxPathLength = 240;

        public static bool IsSetName(string name)
        {
            return name != null && NameRule.IsMatch(name);
        }

        /// <summary>A drive letter and plain folder names: no UNC or \\?\ form, no . or .. part, no stream, no slash.</summary>
        public static bool IsPlainAbsolute(string path)
        {
            if (string.IsNullOrEmpty(path) || path.Trim().Length == 0 || path.Length > MaxPathLength)
            {
                return false;
            }
            if (!PathRule.IsMatch(path) || !DriveRule.IsMatch(path))
            {
                return false;
            }
            if (path.IndexOf(':', 2) >= 0 || path.IndexOf('/') >= 0)
            {
                return false;
            }
            string rest = path.Substring(3).TrimEnd('\\');
            if (rest.Length == 0)
            {
                return true;
            }
            foreach (string part in rest.Split('\\'))
            {
                if (part.Length == 0 || part == "." || part == ".." || part.EndsWith(" ") || part.EndsWith("."))
                {
                    return false;
                }
            }
            return true;
        }

        /// <summary>The paths of one data set under a storage folder, or an exception that says why not.</summary>
        public static ContainedPaths PathsFor(string storageRoot, string set)
        {
            if (!IsSetName(set))
            {
                throw new RefusedException("The data set name is not allowed: " + Safe.Text(set, 80));
            }
            if (!IsPlainAbsolute(storageRoot))
            {
                throw new RefusedException("The storage folder is not a plain full path (no .., no network path): " + Safe.Text(storageRoot, 300));
            }
            string root = storageRoot.TrimEnd('\\');
            if (root.Length <= 3)
            {
                throw new RefusedException("The storage folder cannot be a drive root.");
            }
            ContainedPaths paths = new ContainedPaths(root, set);
            if (!IsPlainAbsolute(paths.Image) || !IsPlainAbsolute(paths.Mount))
            {
                throw new RefusedException("The storage folder path is too long.");
            }
            return paths;
        }

        public static void CheckMaxGb(long maxGb)
        {
            if (maxGb < MinGb || maxGb > MaxGb)
            {
                throw new RefusedException("The size limit must be between 8 and 4096 GB.");
            }
        }

        /// <summary>The folders from the drive root down to (and with) the storage folder, the drive root first.</summary>
        public static string[] FoldersDownTo(string root)
        {
            string[] parts = root.Substring(3).Split('\\');
            string[] folders = new string[parts.Length + 1];
            folders[0] = root.Substring(0, 3);
            string at = root.Substring(0, 2);
            for (int i = 0; i < parts.Length; i++)
            {
                at = at + "\\" + parts[i];
                folders[i + 1] = at;
            }
            return folders;
        }

        public static bool SamePath(string a, string b)
        {
            return string.Equals(a.TrimEnd('\\'), b.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);
        }
    }

    /// <summary>A request the rules refuse: the message is for the user (no stack, no internals).</summary>
    public sealed class RefusedException : Exception
    {
        public RefusedException(string message) : base(message)
        {
        }
    }

    public static class Safe
    {
        /// <summary>Printable ASCII only, at most max characters: what goes into the log and the answer from outside text.</summary>
        public static string Text(string text, int max)
        {
            if (text == null)
            {
                return "";
            }
            System.Text.StringBuilder sb = new System.Text.StringBuilder();
            foreach (char ch in text)
            {
                if (sb.Length >= max)
                {
                    sb.Append("...");
                    break;
                }
                sb.Append(ch >= ' ' && ch < (char)127 ? ch : '?');
            }
            return sb.ToString();
        }
    }
}
