// The one exception to "only systems this tool created" (docs/design/hcs-live-folders.md, section 4): the wsb-share
// verb may add a vSMB share to the running Windows Sandbox. It acts only when exactly one compute system is a running
// VirtualMachine with a GUID id and an Owner from a fixed list, and that id is the one asked for. An unknown Owner,
// none or two candidates (another user's sandbox, Application Guard) all fail closed. Ids with this tool's own prefix
// are refused here, and `share` refuses GUIDs, so neither verb reaches the other's systems.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

namespace AgentSandbox.HcsHost
{
    public static class WsbGuard
    {
        /// <summary>The Owner Windows Sandbox's compute system is reported to have (unconfirmed: the PC test records it).</summary>
        private static readonly string[] Owners = new string[] { "Madrid" };
        private static readonly Regex GuidId = new Regex("^[0-9A-Fa-f]{8}-([0-9A-Fa-f]{4}-){3}[0-9A-Fa-f]{12}$");

        /// <summary>Null when `id` has the shape of Windows Sandbox's id (a GUID, never one of ours).</summary>
        public static string IdProblem(string id)
        {
            if (id == null || id.StartsWith(Guard.IdPrefix, StringComparison.OrdinalIgnoreCase) || !GuidId.IsMatch(id))
            {
                return "only the running Windows Sandbox (a GUID id) can be given a live folder";
            }
            return null;
        }

        /// <summary>One system from HCS JSON: its Id, SystemType, Owner and State ("" when missing).</summary>
        private static string Field(Dictionary<string, object> s, string key)
        {
            object value;
            return s != null && s.TryGetValue(key, out value) && value is string ? (string)value : "";
        }

        private static bool IsCandidate(Dictionary<string, object> s)
        {
            return Field(s, "SystemType") == "VirtualMachine" && Field(s, "State") == "Running" &&
                Array.IndexOf(Owners, Field(s, "Owner")) >= 0 && GuidId.IsMatch(Field(s, "Id"));
        }

        /// <summary>
        /// Pure: the Windows Sandbox candidate in HcsEnumerateComputeSystems' answer. Null (with `id`) when there is
        /// exactly one; otherwise why not.
        /// </summary>
        public static string Candidate(string enumerateJson, out string id)
        {
            id = null;
            object parsed;
            try
            {
                parsed = new JavaScriptSerializer().DeserializeObject(enumerateJson ?? "");
            }
            catch (ArgumentException)
            {
                return "the list of compute systems is not JSON";
            }
            catch (InvalidOperationException)
            {
                return "the list of compute systems is not JSON";
            }
            IEnumerable systems = parsed as object[];
            if (systems == null)
            {
                return "the list of compute systems is not a list";
            }
            List<string> found = new List<string>();
            foreach (object o in systems)
            {
                Dictionary<string, object> s = o as Dictionary<string, object>;
                if (IsCandidate(s))
                {
                    found.Add(Field(s, "Id"));
                }
            }
            if (found.Count != 1)
            {
                return "exactly one running Windows Sandbox is needed, and " + found.Count + " were found (another user's sandbox or Application Guard counts too; a Windows Sandbox whose Owner is not " + string.Join(", ", Owners) + " is not recognised)";
            }
            id = found[0];
            return null;
        }

        /// <summary>Pure: null when the candidate is the system asked for (case-insensitive GUIDs).</summary>
        public static string MatchProblem(string candidate, string wanted)
        {
            if (wanted != null && wanted.Length > 0 && !string.Equals(candidate, wanted, StringComparison.OrdinalIgnoreCase))
            {
                return "the running Windows Sandbox is not the one this live folder was recorded for (it was restarted)";
            }
            return null;
        }

        /// <summary>Pure: null when an opened system's own properties still say it is the running Windows Sandbox `id`.</summary>
        public static string PropertiesProblem(string propertiesJson, string id)
        {
            Dictionary<string, object> s;
            try
            {
                s = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(propertiesJson ?? "");
            }
            catch (ArgumentException)
            {
                return "its properties are not JSON";
            }
            catch (InvalidOperationException)
            {
                return "its properties are not JSON";
            }
            if (!IsCandidate(s) || !string.Equals(Field(s, "Id"), id, StringComparison.OrdinalIgnoreCase))
            {
                return "the opened system is no longer the running Windows Sandbox";
            }
            return null;
        }

        /// <summary>Live: asks HCS for every system and finds Windows Sandbox (null with `id`, or why not).</summary>
        public static string Find(out string id)
        {
            id = null;
            HcsReply reply = Hcs.Enumerate(null);
            if (!reply.Ok)
            {
                return "the compute systems could not be listed: " + reply.Message();
            }
            return Candidate(reply.Json, out id);
        }
    }
}
