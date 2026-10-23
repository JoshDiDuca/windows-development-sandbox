// HcsHost.exe <verb> [arguments] --out <response.json>
// Verbs: check, enumerate, properties <id>, create <request.json>, start <id>, terminate <id>,
//        grant-vm-access <vmId> <file>, create-vhdx <path> <maxGb>, share <request.json> (our own systems),
//        wsb-share <request.json> --sha256 <hex> (live folders on the running Windows Sandbox, WsbShare.cs),
//        wsb-rules <enumerate.json> [id] (pure: applies WsbGuard's rules to a recorded list; asks HCS nothing).
// The answer is one JSON file (see Json.Response); exit code 0 = ok, 1 = failed, 2 = wrong use. A create request is
// {"id": "...", "document": "<the HCS document as a JSON string>"}. Never attaches a disk to this PC.
using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;

namespace AgentSandbox.HcsHost
{
    public static class Program
    {
        private const long MaxRequestBytes = 1024 * 1024;
        private const int ExitOk = 0;
        private const int ExitFailed = 1;
        private const int ExitUsage = 2;
        private static readonly SecurityIdentifier HyperVAdministrators = new SecurityIdentifier("S-1-5-32-578");

        public static int Main(string[] args)
        {
            string outFile = null;
            string sha256 = null;
            List<string> rest = new List<string>();
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--out" && i + 1 < args.Length)
                {
                    outFile = args[i + 1];
                    i++;
                }
                else if (args[i] == "--sha256" && i + 1 < args.Length)
                {
                    sha256 = args[i + 1];
                    i++;
                }
                else
                {
                    rest.Add(args[i]);
                }
            }
            string response;
            int code;
            try
            {
                code = Dispatch(rest, sha256, out response);
            }
            catch (Exception ex)
            {
                response = Json.Response(false, ex.HResult, ex.Message, "", null);
                code = ExitFailed;
            }
            Write(outFile, response);
            return code;
        }

        private static void Write(string outFile, string text)
        {
            if (outFile == null)
            {
                Console.Out.WriteLine(text);
                return;
            }
            File.WriteAllText(outFile, text, new UTF8Encoding(false));
        }

        private static int Usage(out string response, string what)
        {
            response = Json.Response(false, 0, "Usage: " + what, "", null);
            return ExitUsage;
        }

        private static int FromReply(HcsReply reply, IDictionary<string, string> values, out string response)
        {
            response = Json.Response(reply.Ok, reply.HResult, reply.Message(), reply.Json, values);
            return reply.Ok ? ExitOk : ExitFailed;
        }

        private static int Dispatch(List<string> args, string sha256, out string response)
        {
            if (args.Count == 0)
            {
                return Usage(out response, "HcsHost <check|enumerate|properties|create|start|terminate|grant-vm-access|create-vhdx|share|wsb-share|wsb-rules> ... --out file");
            }
            string verb = args[0];
            if (verb == "check")
            {
                return Check(out response);
            }
            if (verb == "enumerate")
            {
                return FromReply(Hcs.Enumerate(null), null, out response);
            }
            if (verb == "properties" && args.Count == 2)
            {
                if (Refused(Guard.IdProblem(args[1]), out response))
                {
                    return ExitUsage;
                }
                return FromReply(Hcs.Properties(args[1], "{\"PropertyTypes\":[]}"), null, out response);
            }
            if (verb == "create" && args.Count == 2)
            {
                return Create(args[1], out response);
            }
            if ((verb == "start" || verb == "terminate") && args.Count == 2)
            {
                // Twice guarded: the id must look like ours, and HCS itself must say the system is ours.
                if (Refused(Guard.IdProblem(args[1]), out response) || Refused(Guard.OwnerProblem(args[1]), out response))
                {
                    return ExitUsage;
                }
                return FromReply(verb == "start" ? Hcs.Start(args[1]) : Hcs.Terminate(args[1]), null, out response);
            }
            if (verb == "share" && args.Count == 2)
            {
                return Share(args[1], out response);
            }
            if (verb == "wsb-share" && args.Count == 2)
            {
                if (sha256 == null || !System.Text.RegularExpressions.Regex.IsMatch(sha256, "^[0-9A-Fa-f]{64}$"))
                {
                    return Usage(out response, "wsb-share <request.json> --sha256 <its SHA-256>");
                }
                Dictionary<string, string> values = new Dictionary<string, string>();
                string message;
                bool ok = WsbShare.Run(args[1], sha256, values, out message);
                response = Json.Response(ok, 0, message, "", values);
                return ok ? ExitOk : (message.StartsWith("Refused: ") ? ExitUsage : ExitFailed);
            }
            if (verb == "wsb-rules" && (args.Count == 2 || args.Count == 3))
            {
                return WsbRules(args[1], args.Count == 3 ? args[2] : null, out response);
            }
            if (verb == "grant-vm-access" && args.Count == 3)
            {
                if (Refused(Guard.IdProblem(args[1]), out response) || Refused(Guard.DiskProblem(args[2]), out response))
                {
                    return ExitUsage;
                }
                return FromReply(Hcs.GrantVmAccess(args[1], args[2]), null, out response);
            }
            if (verb == "create-vhdx" && args.Count == 3)
            {
                long maxGb;
                if (!long.TryParse(args[2], out maxGb))
                {
                    return Usage(out response, "create-vhdx <path> <maxGb>");
                }
                VirtualDisk.Create(args[1], maxGb);
                response = Json.Response(true, 0, "ok", "", null);
                return ExitOk;
            }
            return Usage(out response, "unknown verb or wrong number of arguments: " + verb);
        }

        /// <summary>Read-only facts: can computecore load, who am I, what does the service say.</summary>
        private static int Check(out string response)
        {
            Dictionary<string, string> values = new Dictionary<string, string>();
            values["computecore"] = Hcs.CanLoad("computecore.dll") ? "yes" : "no";
            WindowsPrincipal principal = new WindowsPrincipal(WindowsIdentity.GetCurrent());
            values["administrator"] = principal.IsInRole(WindowsBuiltInRole.Administrator) ? "yes" : "no";
            values["hyperVAdministrators"] = principal.IsInRole(HyperVAdministrators) ? "yes" : "no";
            if (values["computecore"] != "yes")
            {
                response = Json.Response(false, 0, "computecore.dll is not on this PC", "", values);
                return ExitFailed;
            }
            HcsReply reply = Hcs.ServiceProperties(null);
            return FromReply(reply, values, out response);
        }

        private static int Create(string requestFile, out string response)
        {
            FileInfo info = new FileInfo(requestFile);
            if (!info.Exists || info.Length > MaxRequestBytes)
            {
                return Usage(out response, "create <request.json> (a file of at most 1 MB)");
            }
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            Dictionary<string, object> request = serializer.Deserialize<Dictionary<string, object>>(File.ReadAllText(requestFile, Encoding.UTF8));
            object id;
            object document;
            if (!request.TryGetValue("id", out id) || !request.TryGetValue("document", out document) || !(id is string) || !(document is string))
            {
                return Usage(out response, "the request needs a text id and a text document");
            }
            if (Refused(Guard.IdProblem((string)id), out response) || Refused(Guard.DocumentProblem((string)document), out response))
            {
                return ExitUsage;
            }
            return FromReply(Hcs.Create((string)id, (string)document), null, out response);
        }

        /// <summary>
        /// Adds or removes a vSMB share on a running system of OURS (id prefix and Owner, as for start/terminate).
        /// Windows Sandbox's own system is refused like any other: that is wsb-share's, with its own rules.
        /// </summary>
        private static int Share(string requestFile, out string response)
        {
            string problem;
            ShareRequest request = ShareRequest.Read(requestFile, out problem);
            if (Refused(problem, out response))
            {
                return ExitUsage;
            }
            if (Refused(Guard.IdProblem(request.Id), out response) || Refused(Guard.OwnerProblem(request.Id), out response))
            {
                return ExitUsage;
            }
            Dictionary<string, string> values = new Dictionary<string, string>();
            values["request"] = request.ToModifySettingRequest();
            return FromReply(Hcs.Modify(request.Id, values["request"]), values, out response);
        }

        /// <summary>The test hook for WsbGuard: its rules on a recorded enumerate answer. Never calls HCS.</summary>
        private static int WsbRules(string file, string id, out string response)
        {
            FileInfo info = new FileInfo(file);
            if (!info.Exists || info.Length > MaxRequestBytes)
            {
                return Usage(out response, "wsb-rules <enumerate.json> [id]");
            }
            string found;
            string problem = WsbGuard.Candidate(File.ReadAllText(file, Encoding.UTF8), out found);
            if (problem == null && id != null)
            {
                problem = WsbGuard.IdProblem(id) ?? WsbGuard.MatchProblem(found, id);
            }
            Dictionary<string, string> values = new Dictionary<string, string>();
            values["id"] = found ?? "";
            if (Refused(problem, out response))
            {
                return ExitUsage;
            }
            response = Json.Response(true, 0, "ok", "", values);
            return ExitOk;
        }

        /// <summary>True (with the refusal as the response) when `problem` says why the request is not allowed.</summary>
        private static bool Refused(string problem, out string response)
        {
            if (problem == null)
            {
                response = null;
                return false;
            }
            response = Json.Response(false, 0, "Refused: " + problem, "", null);
            return true;
        }
    }
}
