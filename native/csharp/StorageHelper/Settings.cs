// Where a user's contained storage is, worked out the way the CLI does it (src/core/config/loader.ts and
// src/cli/commands/context.ts): the built-in defaults, then the machine file (%ProgramData%\AgentSandbox\config.json),
// then the user's own file (<profile>\.agent-sandbox\config.json, JSON with comments) win (except that a
// size limit set in the machine file is a ceiling); %VARIABLES% expand from the
// user's environment, a leading ~ is the profile, and a relative folder is relative to the folder of the file. Only
// storage.root and storage.containedMaxGb are read. The texts are handed in, so this file reads nothing itself.
using System;
using System.Collections.Generic;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

namespace AgentSandbox.StorageHelper
{
    public sealed class StorageSettings
    {
        public StorageSettings(string storageRoot, long maxGb)
        {
            StorageRoot = storageRoot;
            MaxGb = maxGb;
        }

        public string StorageRoot { get; private set; }
        public long MaxGb { get; private set; }
    }

    public static class Settings
    {
        public const string DefaultRoot = "%ProgramData%\\AgentSandbox\\users\\%USERNAME%";
        public const long DefaultMaxGb = 64;
        public const int MaxConfigBytes = 1024 * 1024;
        private static readonly Regex Variable = new Regex("%([^%]+)%", RegexOptions.CultureInvariant);

        /// <summary>
        /// The storage folder and size limit. `machineText` / `userText` may be null (no file). `userBase` is the folder
        /// of the user's file (a relative root is relative to it), `profile` the user's profile folder.
        /// </summary>
        public static StorageSettings Derive(string machineText, string userText, string userBase, string profile, IDictionary<string, string> environment)
        {
            string root = DefaultRoot;
            string rootBase = userBase;
            long maxGb = DefaultMaxGb;
            long ceiling = long.MaxValue;
            if (machineText != null)
            {
                Dictionary<string, object> machine = Parse(machineText, "the machine settings");
                string value;
                if (TryString(machine, "root", out value))
                {
                    // The machine file must give a full path (the CLI refuses it otherwise).
                    if (!IsRooted(Expand(value, profile, environment)))
                    {
                        throw new RefusedException("storage.root in the machine settings must be a full path.");
                    }
                    root = value;
                }
                long gb;
                if (TryNumber(machine, out gb))
                {
                    // A limit an administrator set for the PC is a ceiling: a user's own file may only go lower.
                    maxGb = gb;
                    ceiling = gb;
                }
            }
            if (userText != null)
            {
                Dictionary<string, object> user = Parse(userText, "your settings");
                string value;
                if (TryString(user, "root", out value))
                {
                    root = value;
                }
                long gb;
                if (TryNumber(user, out gb))
                {
                    maxGb = Math.Min(gb, ceiling);
                }
            }
            string expanded = Expand(root, profile, environment);
            string full = IsRooted(expanded) ? expanded : Combine(rootBase, expanded);
            return new StorageSettings(Normalize(full), maxGb);
        }

        /// <summary>%VAR% from the user's environment (names ignore case, unknown ones stay), then a leading ~.</summary>
        public static string Expand(string input, string profile, IDictionary<string, string> environment)
        {
            string text = Variable.Replace(input, delegate(Match m)
            {
                string name = m.Groups[1].Value;
                foreach (KeyValuePair<string, string> pair in environment)
                {
                    if (string.Equals(pair.Key, name, StringComparison.OrdinalIgnoreCase))
                    {
                        return pair.Value;
                    }
                }
                return m.Value;
            });
            if (text == "~" || text.StartsWith("~\\") || text.StartsWith("~/"))
            {
                text = profile + text.Substring(1);
            }
            return text;
        }

        private static bool IsRooted(string path)
        {
            return path.Length >= 3 && char.IsLetter(path[0]) && path[1] == ':' && (path[2] == '\\' || path[2] == '/');
        }

        private static string Combine(string folder, string relative)
        {
            return folder.TrimEnd('\\', '/') + "\\" + relative;
        }

        /// <summary>Like path.resolve for a drive path: slashes become backslashes, . and .. parts are worked out.</summary>
        public static string Normalize(string path)
        {
            string text = path.Replace('/', '\\');
            if (!IsRooted(text))
            {
                return text;
            }
            List<string> parts = new List<string>();
            foreach (string part in text.Substring(3).Split('\\'))
            {
                if (part.Length == 0 || part == ".")
                {
                    continue;
                }
                if (part == "..")
                {
                    if (parts.Count > 0)
                    {
                        parts.RemoveAt(parts.Count - 1);
                    }
                    continue;
                }
                parts.Add(part);
            }
            return char.ToUpperInvariant(text[0]) + ":\\" + string.Join("\\", parts.ToArray());
        }

        private static Dictionary<string, object> Parse(string text, string what)
        {
            object value;
            try
            {
                JavaScriptSerializer serializer = new JavaScriptSerializer();
                serializer.MaxJsonLength = MaxConfigBytes;
                serializer.RecursionLimit = 32;
                value = serializer.DeserializeObject(StripJsonc(text));
            }
            catch (Exception)
            {
                // The file's text is never repeated: it may be something the service was not meant to show.
                throw new RefusedException("Could not read " + what + " (not valid JSON). Run sandbox doctor.");
            }
            Dictionary<string, object> top = value as Dictionary<string, object>;
            if (top == null)
            {
                throw new RefusedException("Could not read " + what + " (not a JSON object). Run sandbox doctor.");
            }
            object storage;
            if (!top.TryGetValue("storage", out storage))
            {
                return new Dictionary<string, object>();
            }
            Dictionary<string, object> section = storage as Dictionary<string, object>;
            if (section == null)
            {
                throw new RefusedException("Could not read " + what + " (storage is not an object).");
            }
            return section;
        }

        private static bool TryString(Dictionary<string, object> storage, string key, out string value)
        {
            value = null;
            object raw;
            if (!storage.TryGetValue(key, out raw))
            {
                return false;
            }
            value = raw as string;
            if (value == null || value.Length == 0 || value.Length > 1000)
            {
                throw new RefusedException("storage." + key + " in the settings is not a folder.");
            }
            return true;
        }

        private static bool TryNumber(Dictionary<string, object> storage, out long value)
        {
            value = 0;
            object raw;
            if (!storage.TryGetValue("containedMaxGb", out raw))
            {
                return false;
            }
            if (raw is int)
            {
                value = (int)raw;
                return true;
            }
            if (raw is long)
            {
                value = (long)raw;
                return true;
            }
            throw new RefusedException("storage.containedMaxGb in the settings is not a whole number.");
        }

        /// <summary>JSON with comments and trailing commas (like the CLI's jsonc-parser) made plain JSON. Strings are kept.</summary>
        public static string StripJsonc(string text)
        {
            if (text.Length > 0 && text[0] == '﻿')
            {
                text = text.Substring(1);
            }
            StringBuilder sb = new StringBuilder(text.Length);
            int i = 0;
            while (i < text.Length)
            {
                char ch = text[i];
                if (ch == '"')
                {
                    int start = i;
                    i++;
                    while (i < text.Length && text[i] != '"')
                    {
                        i += text[i] == '\\' ? 2 : 1;
                    }
                    i++;
                    sb.Append(text, start, Math.Min(i, text.Length) - start);
                    continue;
                }
                if (ch == '/' && i + 1 < text.Length && text[i + 1] == '/')
                {
                    while (i < text.Length && text[i] != '\n')
                    {
                        i++;
                    }
                    continue;
                }
                if (ch == '/' && i + 1 < text.Length && text[i + 1] == '*')
                {
                    int end = text.IndexOf("*/", i + 2, StringComparison.Ordinal);
                    i = end < 0 ? text.Length : end + 2;
                    sb.Append(' ');
                    continue;
                }
                if (ch == ',')
                {
                    // A comma followed only by blanks and comments before } or ] is dropped.
                    int j = SkipBlank(text, i + 1);
                    if (j < text.Length && (text[j] == '}' || text[j] == ']'))
                    {
                        i++;
                        continue;
                    }
                }
                sb.Append(ch);
                i++;
            }
            return sb.ToString();
        }

        private static int SkipBlank(string text, int i)
        {
            while (i < text.Length)
            {
                if (char.IsWhiteSpace(text[i]))
                {
                    i++;
                }
                else if (text[i] == '/' && i + 1 < text.Length && text[i + 1] == '/')
                {
                    while (i < text.Length && text[i] != '\n')
                    {
                        i++;
                    }
                }
                else if (text[i] == '/' && i + 1 < text.Length && text[i + 1] == '*')
                {
                    int end = text.IndexOf("*/", i + 2, StringComparison.Ordinal);
                    i = end < 0 ? text.Length : end + 2;
                }
                else
                {
                    break;
                }
            }
            return i;
        }
    }
}
