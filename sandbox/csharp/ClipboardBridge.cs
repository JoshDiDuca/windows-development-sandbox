// The clipboard bridge's guest helper: ClipboardBridge serve --max-bytes N. Reads commands on stdin (set <base64 UTF-8>, get) and reports on stdout (ready, changed <base64>, changed-other, set-ok, set-failed, got <base64>, got-none, got-too-big, get-failed). Compiled with ClipboardText.cs. Exit 0 when stdin closes, 2 on a usage error. C# 5.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.Text;
using System.Threading;

public static class SbxClipboardBridge
{
    private const int PollMs = 150;
    private const int MaxBytesLimit = 4194304;
    private const int ReadAttempts = 5;
    private const int ExitUsage = 2;
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

    private static string Encode(string text)
    {
        return Convert.ToBase64String(Encoding.UTF8.GetBytes(text));
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
                Say("got " + Encode(text));
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

    private static void Command(string line, int maxBytes)
    {
        if (line == "get")
        {
            Get(maxBytes);
        }
        else if (line.StartsWith(SetPrefix, StringComparison.Ordinal))
        {
            Set(line.Substring(SetPrefix.Length).Trim(), maxBytes);
        }
    }

    /// <summary>
    /// Looks at a clipboard change. Returns true when it is settled (reported or skipped), false to look again on the
    /// next round (the clipboard was locked).
    /// </summary>
    private static bool Change(int maxBytes, bool lastTry)
    {
        if (SbxClipboardText.HasMarker())
        {
            return true;
        }
        try
        {
            bool tooBig;
            string text = SbxClipboardText.Read(maxBytes, out tooBig);
            Say(text == null ? "changed-other" : "changed " + Encode(text));
            return true;
        }
        catch (Win32Exception)
        {
            if (lastTry)
            {
                Say("changed-other");
                return true;
            }
            return false;
        }
    }

    public static int Main(string[] args)
    {
        int maxBytes;
        if (args.Length != 3 || args[0] != "serve" || args[1] != "--max-bytes"
            || !int.TryParse(args[2], NumberStyles.None, CultureInfo.InvariantCulture, out maxBytes)
            || maxBytes < 1 || maxBytes > MaxBytesLimit)
        {
            Console.Error.WriteLine("Usage: ClipboardBridge serve --max-bytes N");
            return ExitUsage;
        }
        Thread reader = new Thread(ReadStdin);
        reader.IsBackground = true;
        reader.Start();
        uint last = SbxClipboardText.Sequence();
        int tries = 0;
        Say("ready");
        for (;;)
        {
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
                Command(line, maxBytes);
                last = SbxClipboardText.Sequence();
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
            uint now = SbxClipboardText.Sequence();
            if (now != last)
            {
                tries++;
                if (Change(maxBytes, tries >= ReadAttempts))
                {
                    last = now;
                    tries = 0;
                }
            }
            Thread.Sleep(PollMs);
        }
    }
}
