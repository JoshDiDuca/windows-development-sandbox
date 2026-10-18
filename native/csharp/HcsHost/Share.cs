// Live folders (PROTOTYPE, not wired into the CLI; docs/design/hcs-live-folders.md): a vSMB share added to or removed
// from a RUNNING compute system with HcsModifyComputeSystem. The request is built here from checked fields, never
// passed through: only ResourcePath "VirtualMachine/Devices/VirtualSmb/Shares", only Add or Remove, a share name with
// this tool's prefix, and fixed options (NoDirectmap always; read-only unless asked; never TakeBackupPrivilege,
// UseShareRootIdentity, AllowedFiles or any other option that changes whose rights the guest uses).
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

namespace AgentSandbox.HcsHost
{
    /// <summary>One checked share request: {"id", "action": "add"|"remove", "name", "path", "readOnly"}.</summary>
    public sealed class ShareRequest
    {
        public const string ResourcePath = "VirtualMachine/Devices/VirtualSmb/Shares";
        /// <summary>Our share names: never the 64-hex names Windows Sandbox gives its own shares.</summary>
        private static readonly Regex SafeName = new Regex("^agentsbx-[0-9a-f]{8,32}$");
        private const long MaxRequestBytes = 64 * 1024;

        public string Id;
        public bool Add;
        public string Name;
        public string Path;
        public bool ReadOnly = true;

        /// <summary>Reads and checks a request file. Null with `problem` set when it is not allowed.</summary>
        public static ShareRequest Read(string file, out string problem)
        {
            FileInfo info = new FileInfo(file);
            if (!info.Exists || info.Length > MaxRequestBytes)
            {
                problem = "the request must be a file of at most 64 KB";
                return null;
            }
            Dictionary<string, object> raw;
            try
            {
                raw = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(file, Encoding.UTF8));
            }
            catch (ArgumentException)
            {
                problem = "the request is not JSON";
                return null;
            }
            catch (InvalidOperationException)
            {
                problem = "the request is not JSON";
                return null;
            }
            ShareRequest r = new ShareRequest();
            r.Id = Text(raw, "id");
            string action = Text(raw, "action");
            r.Name = Text(raw, "name");
            r.Path = Text(raw, "path");
            object ro;
            if (raw != null && raw.TryGetValue("readOnly", out ro))
            {
                if (!(ro is bool))
                {
                    problem = "readOnly must be true or false";
                    return null;
                }
                r.ReadOnly = (bool)ro;
            }
            if (action != "add" && action != "remove")
            {
                problem = "action must be add or remove";
                return null;
            }
            r.Add = action == "add";
            if (r.Name == null || !SafeName.IsMatch(r.Name))
            {
                problem = "the share name must look like agentsbx-<8 to 32 hex digits>";
                return null;
            }
            problem = r.Add ? FolderProblem(r.Path) : null;
            return problem == null ? r : null;
        }

        private static string Text(Dictionary<string, object> raw, string key)
        {
            object value;
            if (raw == null || !raw.TryGetValue(key, out value))
            {
                return null;
            }
            return value as string;
        }

        /// <summary>
        /// Null when `path` is a full local path to an existing folder (not a drive root, no link anywhere on the way);
        /// otherwise why not. The host's TypeScript checks the same and more (which folders may be shared at all).
        /// </summary>
        public static string FolderProblem(string path)
        {
            // No '/', no ':' after the drive (streams), no wildcards or control characters.
            if (string.IsNullOrEmpty(path) || path.Length > 240 || !Regex.IsMatch(path, "^[A-Za-z]:\\\\[^<>\"|?*:/\\x00-\\x1f]+$"))
            {
                return "only a full local path to a folder can be shared (C:\\...)";
            }
            string trimmed = path.TrimEnd('\\');
            foreach (string part in trimmed.Substring(3).Split('\\'))
            {
                if (part.Length == 0 || part == "." || part == ".." || part.EndsWith(".") || part.EndsWith(" ") || part.Contains("~"))
                {
                    return "the path must be in its plain long form (no . or .. parts, trailing dots or spaces, or short names)";
                }
            }
            string full;
            try
            {
                full = System.IO.Path.GetFullPath(trimmed);
            }
            catch (Exception)
            {
                return "the path cannot be read";
            }
            if (!string.Equals(full, trimmed, StringComparison.Ordinal))
            {
                return "the path must already be in its full form";
            }
            DriveInfo drive = new DriveInfo(trimmed.Substring(0, 1));
            if (drive.DriveType != DriveType.Fixed)
            {
                // A subst drive still reports Fixed: the wsb-share verb adds a QueryDosDevice check (design note).
                return "only folders on a fixed local drive can be shared (not network or removable drives)";
            }
            DirectoryInfo dir = new DirectoryInfo(trimmed);
            if (!dir.Exists)
            {
                return "the folder does not exist";
            }
            if (dir.Parent == null)
            {
                return "a whole drive cannot be shared";
            }
            for (DirectoryInfo d = dir; d != null && d.Parent != null; d = d.Parent)
            {
                if ((d.Attributes & FileAttributes.ReparsePoint) != 0)
                {
                    return "the folder or one above it is a link: " + d.FullName;
                }
            }
            return null;
        }

        /// <summary>The ModifySettingRequest (HCS schema; learn.microsoft.com .../hcsmodifycomputesystem).</summary>
        public string ToModifySettingRequest()
        {
            StringBuilder sb = new StringBuilder();
            sb.Append("{\"ResourcePath\":").Append(Json.Quote(ResourcePath));
            sb.Append(",\"RequestType\":").Append(Json.Quote(Add ? "Add" : "Remove"));
            sb.Append(",\"Settings\":{\"Name\":").Append(Json.Quote(Name));
            if (Add)
            {
                sb.Append(",\"Path\":").Append(Json.Quote(System.IO.Path.GetFullPath(Path.TrimEnd('\\'))));
                // hcsshim's read-only defaults (internal/uvm/vsmb.go DefaultVSMBOptions) plus NoDirectmap: a share that
                // was never direct-mapped can be removed again while the system runs.
                sb.Append(",\"Options\":{\"NoDirectmap\":true");
                if (ReadOnly)
                {
                    sb.Append(",\"ReadOnly\":true,\"ShareRead\":true,\"CacheIo\":true,\"PseudoOplocks\":true");
                }
                sb.Append("}");
            }
            sb.Append("}}");
            return sb.ToString();
        }
    }
}
