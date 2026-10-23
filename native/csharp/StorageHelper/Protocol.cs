// What goes over the pipe. A request is one line of JSON, at most 512 bytes, with exactly two string fields:
// {"verb":"mount"|"dismount","set":"<data set name>"}; anything else is refused. The client is never asked who it is
// or where its files are: that comes from Windows and from the service's own reading of the settings. The answer is
// one JSON object: {"protocol":1,"ok":..,"message":..,"created":..,"alreadyMounted":..,"fallback":..,"image":..,
// "mount":..,"notes":[..]}. The same shape is checked on the CLI side (src/host/storage/contained/helper-port.ts).
using System;
using System.Collections.Generic;
using System.Text;
using System.Web.Script.Serialization;

namespace AgentSandbox.StorageHelper
{
    public static class Protocol
    {
        public const int Version = 1;
        public const int MaxRequestBytes = 512;

        /// <summary>The verb and set of a request, or a RefusedException that says what is wrong with it.</summary>
        public static void Parse(string text, out string verb, out string set)
        {
            verb = null;
            set = null;
            if (text == null || Encoding.UTF8.GetByteCount(text) > MaxRequestBytes)
            {
                throw new RefusedException("The request is too long.");
            }
            object parsed;
            try
            {
                JavaScriptSerializer serializer = new JavaScriptSerializer();
                serializer.MaxJsonLength = MaxRequestBytes;
                serializer.RecursionLimit = 4;
                parsed = serializer.DeserializeObject(text);
            }
            catch (Exception)
            {
                throw new RefusedException("The request is not valid JSON.");
            }
            Dictionary<string, object> fields = parsed as Dictionary<string, object>;
            if (fields == null || fields.Count != 2 || !fields.ContainsKey("verb") || !fields.ContainsKey("set"))
            {
                throw new RefusedException("The request must have exactly a verb and a set.");
            }
            verb = fields["verb"] as string;
            set = fields["set"] as string;
            if (verb != "mount" && verb != "dismount")
            {
                throw new RefusedException("Unknown verb: only mount and dismount.");
            }
            if (!Rules.IsSetName(set))
            {
                throw new RefusedException("The data set name is not allowed.");
            }
        }

        public static string Answer(Outcome outcome)
        {
            StringBuilder sb = new StringBuilder();
            sb.Append("{\"protocol\":").Append(Version);
            sb.Append(",\"ok\":").Append(outcome.Ok ? "true" : "false");
            sb.Append(",\"message\":").Append(Quote(Safe.Text(outcome.Message, 1500)));
            sb.Append(",\"created\":").Append(outcome.Created ? "true" : "false");
            sb.Append(",\"alreadyMounted\":").Append(outcome.AlreadyMounted ? "true" : "false");
            sb.Append(",\"fallback\":").Append(outcome.Fallback ? "true" : "false");
            sb.Append(",\"image\":").Append(Quote(outcome.Image ?? ""));
            sb.Append(",\"mount\":").Append(Quote(outcome.Mount ?? ""));
            sb.Append(",\"notes\":[");
            for (int i = 0; i < outcome.Notes.Count && i < 20; i++)
            {
                if (i > 0)
                {
                    sb.Append(',');
                }
                sb.Append(Quote(Safe.Text(outcome.Notes[i], 300)));
            }
            sb.Append("]}");
            return sb.ToString();
        }

        public static string Quote(string text)
        {
            StringBuilder sb = new StringBuilder();
            sb.Append('"');
            foreach (char ch in text ?? "")
            {
                if (ch == '"')
                {
                    sb.Append("\\\"");
                }
                else if (ch == '\\')
                {
                    sb.Append("\\\\");
                }
                else if (ch < ' ' || ch > (char)126)
                {
                    sb.Append("\\u").Append(((int)ch).ToString("x4"));
                }
                else
                {
                    sb.Append(ch);
                }
            }
            sb.Append('"');
            return sb.ToString();
        }
    }
}
