// HostTools clipboard-bridge: this PC's side of the clipboard bridge. Prints "fg 1" / "fg 0" when the Windows Sandbox window comes to the front or leaves it, and answers "get" (got <base64>, got-none, got-too-big, get-failed) and "set <base64>" (set-ok, set-failed) on stdin until it closes. Shares ClipboardText.cs with the sandbox. C# 5.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Text;
using System.Threading;

namespace AgentSandbox
{
    public static class HostClipboard
    {
        private const int PollMs = 150;
        private const string SetPrefix = "set ";

        private static readonly object QueueLock = new object();
        private static readonly Queue<string> Commands = new Queue<string>();
        private static bool stdinClosed;

        private static void Say(string line)
        {
            Console.Out.WriteLine(line);
            Console.Out.Flush();
        }

        private static void ReadStdin()
        {
            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                lock (QueueLock)
                {
                    Commands.Enqueue(line);
                }
            }
            lock (QueueLock)
            {
                stdinClosed = true;
            }
        }

        /// <summary>The text of a base64 UTF-8 argument, or null when it is not valid.</summary>
        private static string Decode(string base64)
        {
            try
            {
                byte[] bytes = Convert.FromBase64String(base64);
                return new UTF8Encoding(false, true).GetString(bytes);
            }
            catch (FormatException)
            {
                return null;
            }
            catch (ArgumentException)
            {
                return null;
            }
        }

        private static void Get(int maxBytes)
        {
            try
            {
                bool tooBig;
                string text = SbxClipboardText.Read(maxBytes, out tooBig);
                if (tooBig)
                {
                    Say("got-too-big");
                }
                else if (text == null)
                {
                    Say("got-none");
                }
                else
                {
                    Say("got " + Convert.ToBase64String(Encoding.UTF8.GetBytes(text)));
                }
            }
            catch (Win32Exception)
            {
                Say("get-failed");
            }
        }

        private static void Set(string argument, int maxBytes)
        {
            string text = Decode(argument);
            if (text == null || text.IndexOf((char)0) >= 0 || Encoding.UTF8.GetByteCount(text) > maxBytes)
            {
                Say("set-failed");
                return;
            }
            try
            {
                SbxClipboardText.Write(text);
                Say("set-ok");
            }
            catch (Win32Exception)
            {
                Say("set-failed");
            }
        }

        /// <summary>Runs until stdin closes; returns 0.</summary>
        public static int Serve(int maxBytes)
        {
            Thread reader = new Thread(ReadStdin);
            reader.IsBackground = true;
            reader.Start();
            int front = -1;
            for (;;)
            {
                bool now = Win.SandboxInFront();
                int state = now ? 1 : 0;
                if (state != front)
                {
                    front = state;
                    Say("fg " + state);
                }
                for (;;)
                {
                    string line = null;
                    lock (QueueLock)
                    {
                        if (Commands.Count > 0)
                        {
                            line = Commands.Dequeue();
                        }
                    }
                    if (line == null)
                    {
                        break;
                    }
                    if (line == "get")
                    {
                        Get(maxBytes);
                    }
                    else if (line.StartsWith(SetPrefix, StringComparison.Ordinal))
                    {
                        Set(line.Substring(SetPrefix.Length).Trim(), maxBytes);
                    }
                }
                bool done;
                lock (QueueLock)
                {
                    done = stdinClosed && Commands.Count == 0;
                }
                if (done)
                {
                    return 0;
                }
                Thread.Sleep(PollMs);
            }
        }
    }
}
