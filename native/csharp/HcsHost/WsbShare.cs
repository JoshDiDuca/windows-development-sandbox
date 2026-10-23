// wsb-share (docs/design/hcs-live-folders.md): adds or removes one live folder on the running Windows Sandbox, run by
// native\scripts\hcs-live-share.ps1 from an administrator-only copy of this exe. One process holds one handle to the
// system for the whole add:
//  1. the request (its exact bytes hashed and compared), the folder (FolderAccess) and the system (WsbGuard: exactly
//     one candidate, the id asked for if one was recorded, its own properties re-read through the handle);
//  2. a canary: a fresh folder next to this exe (Administrators, SYSTEM and the Virtual Machines group only) holding a
//     random 128-bit token, shared read-only under a random name; canary.json in the request's folder tells the
//     unelevated caller its name; the token our sandbox's daemon read from that share must come back in answer.txt
//     within the time limit;
//  3. only then the real folder is shared. The canary share and folder are always removed again.
// It never terminates, pauses or saves the system, and every HCS operation waits at most 60 seconds.
using System;
using System.Collections.Generic;
using System.IO;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

namespace AgentSandbox.HcsHost
{
    public static class WsbShare
    {
        private const uint OperationMs = 60000;
        private const int CanaryWaitMs = 45000;
        private const int PollMs = 250;
        private const string CanaryFile = "canary.json";
        private const string AnswerFile = "answer.txt";
        private const string TokenFile = "token.txt";
        private static readonly Regex Token = new Regex("^[0-9a-f]{32}$");
        private static readonly SecurityIdentifier VirtualMachines = new SecurityIdentifier("S-1-5-83-0");

        /// <summary>Adds or removes per the request; `values` say what happened (id, canary, the share request).</summary>
        public static bool Run(string requestFile, string sha256, IDictionary<string, string> values, out string message)
        {
            string problem;
            ShareRequest request = ShareRequest.Read(requestFile, sha256, out problem);
            if (problem != null)
            {
                message = "Refused: " + problem;
                return false;
            }
            // Elevated with another account's password (a standard user's prompt): the profile, access and ownership
            // checks would be that account's, so it is refused. Live folders need your own administrator account.
            string me = WindowsIdentity.GetCurrent().User.Value;
            if (string.IsNullOrEmpty(request.UserSid) || !string.Equals(request.UserSid, me, StringComparison.OrdinalIgnoreCase))
            {
                message = "Refused: the permission prompt was answered with another account; live folders need your own administrator account";
                return false;
            }
            string wanted = string.IsNullOrEmpty(request.Id) ? null : request.Id;
            if (wanted != null && (problem = WsbGuard.IdProblem(wanted)) != null)
            {
                message = "Refused: " + problem;
                return false;
            }
            if (!request.Add && wanted == null)
            {
                message = "Refused: a live folder is only removed from the sandbox it was added to (give its id)";
                return false;
            }
            string folder = null;
            IntPtr held = IntPtr.Zero;
            if (request.Add && (problem = FolderAccess.Problem(request.Path, request.ReadOnly, request.StorageRoot, request.DataPath, out folder, out held)) != null)
            {
                message = "Refused: " + problem;
                return false;
            }
            try
            {
                return WithFolder(request, requestFile, folder, held, wanted, values, out message);
            }
            finally
            {
                FolderAccess.Close(held);
            }
        }

        /// <summary>The rest of Run, while the folder to share is held open (it cannot be renamed or replaced).</summary>
        private static bool WithFolder(ShareRequest request, string requestFile, string folder, IntPtr held, string wanted, IDictionary<string, string> values, out string message)
        {
            string problem;
            string id;
            if ((problem = WsbGuard.Find(out id)) != null || (problem = WsbGuard.MatchProblem(id, wanted)) != null)
            {
                message = "Refused: " + problem;
                return false;
            }
            values["id"] = id;
            IntPtr system;
            int hr = Hcs.Open(id, out system);
            if (hr != 0)
            {
                HcsReply failed = new HcsReply();
                failed.HResult = hr;
                message = "Windows Sandbox could not be opened: " + failed.Message();
                return false;
            }
            try
            {
                HcsReply props = Hcs.PropertiesOf(system);
                if (!props.Ok || (problem = WsbGuard.PropertiesProblem(props.Json, id)) != null)
                {
                    message = "Refused: " + (problem ?? "its properties could not be read: " + props.Message());
                    return false;
                }
                if (!request.Add)
                {
                    string remove = ShareRequest.Build(false, request.Name, null, true);
                    values["request"] = remove;
                    return Reply(Hcs.ModifyOn(system, remove, OperationMs), "removed", out message);
                }
                return AddWithCanary(system, request, folder, held, Path.GetDirectoryName(Path.GetFullPath(requestFile)), values, out message);
            }
            finally
            {
                Hcs.Close(system);
            }
        }

        private static bool Reply(HcsReply reply, string done, out string message)
        {
            message = reply.Ok ? done : "The Host Compute Service said: " + reply.Message() + " (0x" + reply.HResult.ToString("X8") + ")";
            return reply.Ok;
        }

        private static string RandomHex(int bytes)
        {
            byte[] b = new byte[bytes];
            using (RandomNumberGenerator rng = RandomNumberGenerator.Create())
            {
                rng.GetBytes(b);
            }
            return BitConverter.ToString(b).Replace("-", "").ToLowerInvariant();
        }

        /// <summary>A new folder only Administrators, SYSTEM and the VM worker processes can use (made with that DACL).</summary>
        private static string MakeCanaryFolder(string token)
        {
            string here = Path.GetDirectoryName(typeof(WsbShare).Assembly.Location);
            string dir = Path.Combine(here, "canary-" + RandomHex(8));
            if (Directory.Exists(dir) || File.Exists(dir))
            {
                throw new IOException("the canary folder exists already");
            }
            DirectorySecurity security = new DirectorySecurity();
            security.SetAccessRuleProtection(true, false);
            security.SetOwner(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null));
            InheritanceFlags inherit = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
            security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
            security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
            security.AddAccessRule(new FileSystemAccessRule(VirtualMachines, FileSystemRights.ReadAndExecute, inherit, PropagationFlags.None, AccessControlType.Allow));
            Directory.CreateDirectory(dir, security);
            File.WriteAllText(Path.Combine(dir, TokenFile), token, new UTF8Encoding(false));
            return dir;
        }

        /// <summary>Writes a small file whole: a temp name first, then moved into place.</summary>
        private static void WriteWhole(string file, string text)
        {
            // The caller's own temp folder: checked for a link right before writing, and only a new file is made there
            // (never over an existing file or link).
            string dir = Path.GetDirectoryName(file);
            if ((File.GetAttributes(dir) & FileAttributes.ReparsePoint) != 0)
            {
                throw new IOException("the request folder became a link");
            }
            string temp = file + "." + RandomHex(4) + ".tmp";
            byte[] bytes = new UTF8Encoding(false).GetBytes(text);
            using (FileStream stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                stream.Write(bytes, 0, bytes.Length);
            }
            File.Move(temp, file);
        }

        /// <summary>The token the caller relays from our sandbox's daemon (32 hex digits), or null until it is there.</summary>
        private static string ReadAnswer(string file)
        {
            try
            {
                FileInfo info = new FileInfo(file);
                if (!info.Exists || info.Length > 64)
                {
                    return null;
                }
                string text = File.ReadAllText(file, Encoding.ASCII).Trim();
                return text.Length > 0 ? text : null;
            }
            catch (IOException)
            {
                return null; // still being written
            }
            catch (UnauthorizedAccessException)
            {
                return null;
            }
        }

        private static bool FixedTimeEquals(string a, string b)
        {
            if (a == null || b == null || a.Length != b.Length)
            {
                return false;
            }
            int diff = 0;
            for (int i = 0; i < a.Length; i++)
            {
                diff |= a[i] ^ b[i];
            }
            return diff == 0;
        }

        private static bool AddWithCanary(IntPtr system, ShareRequest request, string folder, IntPtr held, string exchange, IDictionary<string, string> values, out string message)
        {
            string token = RandomHex(16);
            string canaryName = "agentsbx-" + RandomHex(8);
            string canaryDir = null;
            bool canaryAdded = false;
            try
            {
                canaryDir = MakeCanaryFolder(token);
                // Removed in finally even when the add fails: an add that timed out may still complete.
                canaryAdded = true;
                HcsReply added = Hcs.ModifyOn(system, ShareRequest.Build(true, canaryName, canaryDir, true), OperationMs);
                if (!added.Ok)
                {
                    values["canary"] = "not added";
                    return Reply(added, "", out message);
                }
                WriteWhole(Path.Combine(exchange, CanaryFile), "{\"share\":" + Json.Quote(canaryName) + "}");
                string answer = null;
                for (int waited = 0; waited < CanaryWaitMs && answer == null; waited += PollMs)
                {
                    Thread.Sleep(PollMs);
                    answer = ReadAnswer(Path.Combine(exchange, AnswerFile));
                }
                if (answer == null || answer == "none")
                {
                    values["canary"] = answer == null ? "no answer" : "not read";
                    message = "The sandbox did not read the test share" + (answer == null ? " in time" : "") + ", so this may not be your sandbox; nothing was shared";
                    return false;
                }
                if (!Token.IsMatch(answer) || !FixedTimeEquals(answer, token))
                {
                    values["canary"] = "wrong token";
                    message = "The test share came back with the wrong token, so this is not your sandbox; nothing was shared";
                    return false;
                }
                values["canary"] = "matched";
                string add = ShareRequest.Build(true, request.Name, folder, request.ReadOnly);
                values["request"] = add;
                HcsReply real = Hcs.ModifyOn(system, add, OperationMs);
                string moved = real.Ok ? FolderAccess.MovedProblem(held, folder) : null;
                if (!real.Ok || moved != null)
                {
                    // Failed, timed out (it may still complete) or the folder moved: the share is taken away again.
                    HcsReply undone = Hcs.ModifyOn(system, ShareRequest.Build(false, request.Name, null, true), OperationMs);
                    values["undone"] = undone.Ok ? "yes" : undone.Message();
                    if (moved != null)
                    {
                        message = "Refused: " + moved;
                        return false;
                    }
                }
                return Reply(real, "added", out message);
            }
            finally
            {
                if (canaryAdded)
                {
                    HcsReply removed = Hcs.ModifyOn(system, ShareRequest.Build(false, canaryName, null, true), OperationMs);
                    values["canaryRemoved"] = removed.Ok ? "yes" : removed.Message();
                }
                if (canaryDir != null)
                {
                    try
                    {
                        Directory.Delete(canaryDir, true);
                    }
                    catch (IOException)
                    {
                        // Still open by the VM: the elevated script deletes the whole work folder afterwards.
                    }
                    catch (UnauthorizedAccessException)
                    {
                        // The same.
                    }
                }
            }
        }
    }
}
