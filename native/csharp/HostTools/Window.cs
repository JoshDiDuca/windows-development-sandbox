// The Windows Sandbox client window: hidden for a headless sandbox (the VM keeps running), shown again by sandbox show.
// HostTools hide-window / show-window, or Add-Type from scripts\*-window.ps1 when HostTools cannot be built. C# 5.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace AgentSandbox
{
    public static class Win
    {
        private const uint GwOwner = 4;
        private const int SwHide = 0;
        private const int SwShow = 5;
        private const int SwRestore = 9;
        private const int TitleChars = 256;
        private const int PollMs = 200;
        // Windows re-shows the window while it connects: keep hiding for this long after the first one.
        private const int SettleSeconds = 15;
        private const uint GaRootOwner = 3;
        private const int FrontCacheSeconds = 5;
        private static uint cachedPid;
        private static bool cachedAnswer;
        private static DateTime cachedAt = DateTime.MinValue;

        public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

        private static class NativeMethods
        {
            [DllImport("user32.dll")]
            public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);

            [DllImport("user32.dll")]
            public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

            [DllImport("user32.dll")]
            public static extern bool IsWindowVisible(IntPtr hWnd);

            [DllImport("user32.dll")]
            public static extern bool IsWindow(IntPtr hWnd);

            [DllImport("user32.dll")]
            public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);

            [DllImport("user32.dll", CharSet = CharSet.Unicode)]
            public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);

            [DllImport("user32.dll")]
            public static extern bool ShowWindow(IntPtr hWnd, int cmd);

            [DllImport("user32.dll")]
            public static extern bool SetForegroundWindow(IntPtr hWnd);

            [DllImport("user32.dll")]
            public static extern IntPtr GetForegroundWindow();

            [DllImport("user32.dll")]
            public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
        }

        /// <summary>The top-level Windows Sandbox windows (title contains "Sandbox"), visible ones only if asked.</summary>
        public static List<long> SandboxWindows(bool visibleOnly)
        {
            List<long> found = new List<long>();
            HashSet<uint> pids = new HashSet<uint>();
            foreach (Process p in Process.GetProcesses())
            {
                using (p)
                {
                    if (p.ProcessName.StartsWith("WindowsSandbox", StringComparison.OrdinalIgnoreCase))
                    {
                        pids.Add((uint)p.Id);
                    }
                }
            }
            if (pids.Count == 0)
            {
                return found;
            }
            NativeMethods.EnumWindows(delegate(IntPtr h, IntPtr l)
            {
                uint pid;
                NativeMethods.GetWindowThreadProcessId(h, out pid);
                if (pids.Contains(pid) && NativeMethods.GetWindow(h, GwOwner) == IntPtr.Zero)
                {
                    StringBuilder title = new StringBuilder(TitleChars);
                    NativeMethods.GetWindowText(h, title, TitleChars);
                    if (title.ToString().IndexOf("Sandbox", StringComparison.OrdinalIgnoreCase) >= 0 && (!visibleOnly || NativeMethods.IsWindowVisible(h)))
                    {
                        found.Add(h.ToInt64());
                    }
                }
                return true;
            }, IntPtr.Zero);
            return found;
        }

        /// <summary>True when the window in front belongs to a Windows Sandbox process (answer cached 5 s per process).</summary>
        public static bool SandboxInFront()
        {
            IntPtr front = NativeMethods.GetForegroundWindow();
            if (front == IntPtr.Zero)
            {
                return false;
            }
            IntPtr root = NativeMethods.GetAncestor(front, GaRootOwner);
            if (root != IntPtr.Zero)
            {
                front = root;
            }
            uint pid;
            NativeMethods.GetWindowThreadProcessId(front, out pid);
            if (pid == 0)
            {
                return false;
            }
            DateTime now = DateTime.UtcNow;
            if (pid == cachedPid && (now - cachedAt).TotalSeconds < FrontCacheSeconds)
            {
                return cachedAnswer;
            }
            bool answer = false;
            try
            {
                using (Process p = Process.GetProcessById((int)pid))
                {
                    answer = p.ProcessName.StartsWith("WindowsSandbox", StringComparison.OrdinalIgnoreCase);
                }
            }
            catch (ArgumentException)
            {
                answer = false;
            }
            catch (InvalidOperationException)
            {
                answer = false;
            }
            cachedPid = pid;
            cachedAnswer = answer;
            cachedAt = now;
            return answer;
        }

        /// <summary>Waits up to waitSeconds for the sandbox window and hides it; returns the hidden handles.</summary>
        public static List<long> Hide(int waitSeconds)
        {
            List<long> hidden = new List<long>();
            DateTime deadline = DateTime.Now.AddSeconds(waitSeconds);
            DateTime? settle = null;
            while (DateTime.Now < deadline)
            {
                foreach (long h in SandboxWindows(true))
                {
                    NativeMethods.ShowWindow(new IntPtr(h), SwHide);
                    if (!hidden.Contains(h))
                    {
                        hidden.Add(h);
                    }
                }
                if (hidden.Count > 0 && !settle.HasValue)
                {
                    settle = DateTime.Now.AddSeconds(SettleSeconds);
                }
                if (settle.HasValue && DateTime.Now > settle.Value)
                {
                    break;
                }
                Thread.Sleep(PollMs);
            }
            return hidden;
        }

        /// <summary>Shows the recorded windows that still exist (else any sandbox window) and brings them to the front.</summary>
        public static int Show(IEnumerable<long> recorded)
        {
            List<long> handles = new List<long>();
            foreach (long h in recorded)
            {
                if (NativeMethods.IsWindow(new IntPtr(h)))
                {
                    handles.Add(h);
                }
            }
            if (handles.Count == 0)
            {
                handles = SandboxWindows(false);
            }
            foreach (long h in handles)
            {
                IntPtr window = new IntPtr(h);
                NativeMethods.ShowWindow(window, SwShow);
                NativeMethods.ShowWindow(window, SwRestore);
                NativeMethods.SetForegroundWindow(window);
            }
            return handles.Count;
        }
    }
}
