// ptyhost: runs one console program inside a Windows pseudo console (ConPTY) and shares it with any number of TCP
// clients (the terminal tab inside the sandbox and `--terminal` on the host). Compiled inside the sandbox with the
// .NET Framework csc.exe, so this is C# 5 (no string interpolation, no ?., no expression-bodied members).
//
// Usage: ptyhost.exe <port> <token> <cols> <rows> <logFile> <commandLine> [<restartCommandLine>]
//        ptyhost.exe --end-tree <recordFile>   ends what a ptyhost that was itself ended (Task Manager, a crash) left
//                                              running, from the process tree it recorded (PTYHOST_TREE_FILE)
//
// PTYHOST_TREE_FILE: where the program's process tree (ProcessTree: what it started, by id and start time) is kept
// while it runs; deleted when ptyhost ends it itself. A file left behind means ptyhost did not get to: the session
// daemon then runs --end-tree on it.
// Wire format, both directions: [type:1][length:4, little endian][payload]
//   client -> host  1 HELLO   [cols:2][rows:2][flags:1][token utf8]   flags bit 0 = control-only (no output, no sizing),
//                                                                    bit 1 = status query (answered with STATUS, then closed)
//                   2 INPUT   bytes for the program
//                   3 RESIZE  [cols:2][rows:2]
//                   4 RESTART restart the program with <restartCommandLine> (e.g. after switching accounts)
//                   5 PING    "still here": viewers send it every few seconds, so a closed terminal stops counting
//                   6 CLOSE   end the program (and everything it started) and with it the session
//   host -> client 16 OUTPUT  VT output
//                  17 EXIT    [exitCode:4]
//                  18 ERROR   utf8 message
//                  19 RESTARTING
//                  20 STATUS  [viewers:2][remoteViewers:2]  viewers heard from recently (remote = not loopback, i.e. the PC)
//                  21 CONSOLE utf8 "conpty.dll" or "windows", sent after HELLO. With conpty.dll the output is passed
//                             through (real scrollback, no repaint on resize): a viewer that joins later is sent the
//                             terminal modes in force (mouse tracking ...) and the output since the last screen clear
//                             instead, and must not clear its screen on a resize.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32.SafeHandles;

static class PtyHost
{
    static int Main(string[] args)
    {
        if (args.Length == 2 && args[0] == "--end-tree")
        {
            return ProcessTree.EndRecorded(args[1]);
        }
        if (args.Length < 6)
        {
            Console.Error.WriteLine("usage: ptyhost <port> <token> <cols> <rows> <logFile> <commandLine> [<restartCommandLine>]");
            return 2;
        }
        Log log = new Log(args[4]);
        try
        {
            ClientHub hub = new ClientHub(Encoding.UTF8.GetBytes(args[1]), short.Parse(args[2]), short.Parse(args[3]));
            SessionHost host = new SessionHost(hub, log, args[5], args.Length > 6 && args[6].Length > 0 ? args[6] : args[5]);
            new Listener(int.Parse(args[0]), hub, host, log).Start();
            return host.Run();
        }
        catch (Exception e)
        {
            log.Write("FATAL " + e);
            return 1;
        }
    }
}

/// <summary>Runs the program (and restarts it on request) until it exits on its own.</summary>
sealed class SessionHost
{
    private readonly ClientHub hub;
    private readonly Log log;
    private readonly string restartCommand;
    private string command;
    private volatile bool restartRequested;
    private volatile bool closeRequested;

    public SessionHost(ClientHub hub, Log log, string command, string restartCommand)
    {
        this.hub = hub;
        this.log = log;
        this.command = command;
        this.restartCommand = restartCommand;
    }

    public int Run()
    {
        log.Write("starting: " + command);
        while (true)
        {
            using (PseudoConsole console = PseudoConsole.Start(command, hub.Cols, hub.Rows, hub.Broadcast, log))
            {
                hub.Attach(console);
                log.Write("pseudo console: " + Native.ConsoleKind);
                int exitCode = console.WaitForExit();
                if (!restartRequested)
                {
                    log.Write("program exited with code " + exitCode + ". Last output:" + Environment.NewLine + hub.TailText());
                    hub.Exit(exitCode);
                    return exitCode;
                }
            }
            restartRequested = false;
            command = restartCommand;
            log.Write("restarting: " + command);
        }
    }

    public void Restart()
    {
        if (closeRequested)
        {
            return;
        }
        restartRequested = true;
        hub.ResetReplay();
        hub.Notify(Frame.Restarting);
        hub.KillProgram();
    }

    /// <summary>Ends the program for good (CLOSE): the session exits the way it does when the program exits.</summary>
    public void Close()
    {
        closeRequested = true;
        restartRequested = false;
        log.Write("closing the session on request");
        hub.KillProgram();
    }
}

/// <summary>Accepts TCP clients and turns their frames into actions.</summary>
sealed class Listener
{
    private const int MaxConnections = 32;
    private const int HandshakeTimeoutMs = 10000;
    private const int KeepAliveIdleMs = 10000;
    private const int KeepAliveIntervalMs = 3000;

    private readonly int port;
    private readonly ClientHub hub;
    private readonly SessionHost host;
    private readonly Log log;
    private int connections;

    public Listener(int port, ClientHub hub, SessionHost host, Log log)
    {
        this.port = port;
        this.hub = hub;
        this.host = host;
        this.log = log;
    }

    public void Start()
    {
        // Reachable from the host only when attach is enabled; otherwise just from inside the sandbox.
        bool remote = Environment.GetEnvironmentVariable("PTYHOST_BIND") == "any";
        TcpListener listener = new TcpListener(remote ? IPAddress.Any : IPAddress.Loopback, port);
        listener.Start();
        log.Write("listening on " + (remote ? "all addresses" : "loopback") + ", port " + port);
        Background(delegate
        {
            while (true)
            {
                TcpClient tcp = listener.AcceptTcpClient();
                if (Interlocked.Increment(ref connections) > MaxConnections)
                {
                    Interlocked.Decrement(ref connections);
                    tcp.Close();
                    continue;
                }
                tcp.NoDelay = true;
                KeepAlive(tcp.Client);
                Background(delegate
                {
                    try
                    {
                        Serve(tcp);
                    }
                    finally
                    {
                        Interlocked.Decrement(ref connections);
                    }
                });
            }
        });
    }

    private void Serve(TcpClient tcp)
    {
        Client client = new Client(tcp);
        try
        {
            byte type;
            byte[] payload;
            // The handshake must arrive quickly; idle unauthenticated connections are not kept.
            tcp.ReceiveTimeout = HandshakeTimeoutMs;
            if (!Frame.Read(client.Stream, out type, out payload) || type != Frame.Hello || payload.Length < 5)
            {
                return;
            }
            if (!hub.Admit(client, payload))
            {
                return;
            }
            if (client.Query)
            {
                hub.SendStatus(client);
                return;
            }
            tcp.ReceiveTimeout = 0;
            while (Frame.Read(client.Stream, out type, out payload))
            {
                client.Seen();
                if (type == Frame.Input)
                {
                    hub.Input(client, payload);
                }
                else if (type == Frame.Resize && payload.Length >= 4)
                {
                    hub.Resize(client, BitConverter.ToInt16(payload, 0), BitConverter.ToInt16(payload, 2));
                }
                else if (type == Frame.Restart)
                {
                    host.Restart();
                }
                else if (type == Frame.Close)
                {
                    host.Close();
                }
            }
        }
        catch (IOException)
        {
            // The connection dropped.
        }
        catch (ObjectDisposedException)
        {
            // Closed while reading.
        }
        finally
        {
            hub.Kill(client);
        }
    }

    private static void Background(ThreadStart work)
    {
        Thread thread = new Thread(work);
        thread.IsBackground = true;
        thread.Start();
    }

    /// <summary>TCP keepalive after 10 s idle, probing every 3 s: a peer that vanished (PC asleep, network gone) is dropped.</summary>
    private static void KeepAlive(Socket socket)
    {
        try
        {
            byte[] values = new byte[12];
            BitConverter.GetBytes(1).CopyTo(values, 0);
            BitConverter.GetBytes(KeepAliveIdleMs).CopyTo(values, 4);
            BitConverter.GetBytes(KeepAliveIntervalMs).CopyTo(values, 8);
            socket.IOControl(IOControlCode.KeepAliveValues, values, null);
        }
        catch (SocketException)
        {
            // Keepalive is a convenience.
        }
    }
}

/// <summary>One connection. Frames go through a bounded outbox written by its own thread, so a slow viewer never blocks the agent.</summary>
sealed class Client
{
    private const int OutboxFrames = 4096;
    private const int ActiveSeconds = 15;

    public readonly TcpClient Tcp;
    public readonly NetworkStream Stream;
    public readonly BlockingCollection<byte[]> Outbox = new BlockingCollection<byte[]>(OutboxFrames);
    public readonly bool Remote;
    /// <summary>Set by the writer thread once everything queued has been written and the connection is closed.</summary>
    public readonly ManualResetEvent Finished = new ManualResetEvent(false);
    public bool ControlOnly;
    public bool Query;
    public short Cols;
    public short Rows;
    private long lastSeen = DateTime.UtcNow.Ticks;

    public Client(TcpClient tcp)
    {
        Tcp = tcp;
        Stream = tcp.GetStream();
        IPEndPoint endpoint = tcp.Client.RemoteEndPoint as IPEndPoint;
        Remote = endpoint != null && !IPAddress.IsLoopback(endpoint.Address);
        Thread writer = new Thread(Write);
        writer.IsBackground = true;
        writer.Start();
    }

    public void Seen()
    {
        Interlocked.Exchange(ref lastSeen, DateTime.UtcNow.Ticks);
    }

    /// <summary>Heard from in the last 15 s. Viewers ping every 5 s, so anything quieter is a terminal that went away.</summary>
    public bool Active
    {
        get { return DateTime.UtcNow.Ticks - Interlocked.Read(ref lastSeen) < TimeSpan.FromSeconds(ActiveSeconds).Ticks; }
    }

    private void Write()
    {
        try
        {
            foreach (byte[] frame in Outbox.GetConsumingEnumerable())
            {
                Stream.Write(frame, 0, frame.Length);
            }
        }
        catch (Exception)
        {
            // The peer went away: stop writing.
        }
        finally
        {
            try
            {
                Tcp.Close();
            }
            catch (Exception)
            {
                // Already closed.
            }
            Finished.Set();
        }
    }
}

/// <summary>
/// Everyone connected to the session. Output goes to all of them; the most recent client to connect, type or resize
/// decides the size (like tmux "latest"), and every size change forces a full repaint so no viewer is left with a
/// half-drawn screen. When the owner leaves, the most recently active viewer left takes over at its own size.
/// </summary>
sealed class ClientHub
{
    private const int MaxReplay = 4 << 20;
    private const int TailBytes = 8192;
    private const int MaxModeParams = 64;
    private const int ExitDeliveryMs = 1000;
    private const int KillWaitMs = 3000;

    /// <summary>
    /// Terminal modes the program (or conpty.dll) turned on that a late viewer's terminal must have too, or its clicks and
    /// wheel never reach the program: mouse tracking (1000, 1002, 1003, 1005, 1006, 1015), focus events (1004), bracketed
    /// paste (2004), win32 input (9001), application cursor keys (1), cursor visibility (25), the alternate screen (1049).
    /// The replay is cut at the last screen clear, which may come after the program turned them on.
    /// </summary>
    private static readonly int[] ReplayedModes = { 1, 25, 1000, 1002, 1003, 1004, 1005, 1006, 1015, 1049, 2004, 9001 };

    private readonly object gate = new object();
    private readonly List<Client> clients = new List<Client>();
    private readonly byte[] token;
    private readonly byte[] tail = new byte[TailBytes];
    private readonly object replayGate = new object();
    private readonly MemoryStream replay = new MemoryStream();
    private readonly Dictionary<int, bool> modes = new Dictionary<int, bool>();
    private readonly StringBuilder modeParams = new StringBuilder();
    private int tailLength;
    private PseudoConsole console;
    private Client sizeOwner;
    private short cols;
    private short rows;
    /// <summary>DECSET / DECRST parser, kept across chunks: 0 text, 1 after ESC, 2 after ESC[, 3 in ESC[? parameters.</summary>
    private int modeState;

    public ClientHub(byte[] token, short cols, short rows)
    {
        this.token = token;
        this.cols = cols;
        this.rows = rows;
    }

    public short Cols
    {
        get
        {
            lock (gate)
            {
                return cols;
            }
        }
    }

    public short Rows
    {
        get
        {
            lock (gate)
            {
                return rows;
            }
        }
    }

    public void Attach(PseudoConsole next)
    {
        lock (gate)
        {
            console = next;
        }
    }

    public bool Admit(Client client, byte[] hello)
    {
        byte[] offered = new byte[hello.Length - 5];
        Buffer.BlockCopy(hello, 5, offered, 0, offered.Length);
        if (!TokenMatches(offered))
        {
            Send(client, Frame.Error, Encoding.UTF8.GetBytes("access denied"));
            Retire(client);
            return false;
        }
        client.Cols = BitConverter.ToInt16(hello, 0);
        client.Rows = BitConverter.ToInt16(hello, 2);
        client.ControlOnly = (hello[4] & 3) != 0;
        client.Query = (hello[4] & 2) != 0;
        if (client.Query)
        {
            return true;
        }
        if (client.ControlOnly)
        {
            lock (gate)
            {
                clients.Add(client);
            }
            return true;
        }
        bool passthrough = Native.ConsoleKind.StartsWith("conpty");
        Send(client, Frame.Console, Encoding.UTF8.GetBytes(passthrough ? "conpty.dll" : "windows"));
        // Taken and queued under the replay lock, so no output falls between the replay and the live stream.
        lock (replayGate)
        {
            if (passthrough)
            {
                byte[] prefix = ModePrefix();
                if (prefix.Length > 0)
                {
                    Send(client, Frame.Output, prefix);
                }
                if (replay.Length > 0)
                {
                    Send(client, Frame.Output, replay.ToArray());
                }
            }
            lock (gate)
            {
                clients.Add(client);
            }
        }
        // Passed through, a size change makes the program redraw for everyone (a second copy of the screen in some),
        // so a viewer that only looks leaves the size to the one in use; it takes over when it types or is resized.
        bool owned;
        lock (gate)
        {
            owned = sizeOwner != null;
        }
        if (!passthrough || !owned)
        {
            TakeOwnership(client);
        }
        return true;
    }

    public void Input(Client client, byte[] data)
    {
        if (client.ControlOnly)
        {
            return;
        }
        if (sizeOwner != client)
        {
            TakeOwnership(client);
        }
        PseudoConsole current;
        lock (gate)
        {
            current = console;
        }
        if (current != null)
        {
            current.Write(data);
        }
    }

    /// <summary>A viewer being resized is the one being looked at, so it takes over the size.</summary>
    public void Resize(Client client, short width, short height)
    {
        if (client.ControlOnly)
        {
            return;
        }
        client.Cols = width;
        client.Rows = height;
        TakeOwnership(client);
    }

    public void SendStatus(Client client)
    {
        int viewers = 0;
        int remote = 0;
        foreach (Client c in Snapshot())
        {
            if (!c.ControlOnly && c.Active)
            {
                viewers++;
                if (c.Remote)
                {
                    remote++;
                }
            }
        }
        byte[] payload = new byte[4];
        BitConverter.GetBytes((short)viewers).CopyTo(payload, 0);
        BitConverter.GetBytes((short)remote).CopyTo(payload, 2);
        Send(client, Frame.Status, payload);
        Retire(client);
    }

    public void Broadcast(byte[] output)
    {
        Remember(output);
        lock (replayGate)
        {
            Record(output);
            foreach (Client c in Snapshot())
            {
                if (!c.ControlOnly)
                {
                    Send(c, Frame.Output, output);
                }
            }
        }
    }

    /// <summary>The program's last output as plain text (escape sequences removed), for the log when it exits.</summary>
    public string TailText()
    {
        string text;
        lock (tail)
        {
            text = Encoding.UTF8.GetString(tail, 0, tailLength);
        }
        text = Regex.Replace(text, "\x1b(\\[[0-9;?]*[ -/]*[@-~]|\\][^\x07\x1b]*(\x07|\x1b\\\\)|[@-Z\\\\-_])", "");
        return Regex.Replace(text, "[\\x00-\\x08\\x0b-\\x1f]", "").Trim();
    }

    /// <summary>A restarted program starts on a clean screen (viewers clear theirs on RESTARTING).</summary>
    public void ResetReplay()
    {
        lock (replayGate)
        {
            replay.SetLength(0);
            modes.Clear();
            modeState = 0;
        }
    }

    public void Notify(byte type)
    {
        foreach (Client c in Snapshot())
        {
            if (!c.ControlOnly)
            {
                Send(c, type, new byte[0]);
            }
        }
    }

    public void KillProgram()
    {
        PseudoConsole current;
        lock (gate)
        {
            current = console;
        }
        if (current != null)
        {
            current.Kill();
        }
    }

    public void Exit(int exitCode)
    {
        byte[] code = BitConverter.GetBytes(exitCode);
        List<Client> everyone = Snapshot();
        foreach (Client c in everyone)
        {
            Send(c, Frame.Exit, code);
            Retire(c);
        }
        // Give the writer threads a moment to deliver the EXIT frame before the process ends.
        foreach (Client c in everyone)
        {
            c.Finished.WaitOne(ExitDeliveryMs);
        }
    }

    /// <summary>Stops sending to a client after what is already queued (its writer closes the connection when done).</summary>
    public void Retire(Client client)
    {
        Client next = null;
        lock (gate)
        {
            clients.Remove(client);
            if (sizeOwner == client)
            {
                sizeOwner = null;
                for (int i = clients.Count - 1; i >= 0 && next == null; i--)
                {
                    if (!clients[i].ControlOnly)
                    {
                        next = clients[i];
                    }
                }
            }
        }
        try
        {
            client.Outbox.CompleteAdding();
        }
        catch (ObjectDisposedException)
        {
            // Already retired.
        }
        if (next != null)
        {
            TakeOwnership(next);
        }
    }

    /// <summary>
    /// Disconnects a client. Frames already queued (e.g. "access denied", STATUS) are written first: the client's writer
    /// thread closes the connection when it is done, so wait for that rather than for an empty queue (the writer takes a
    /// frame off the queue before it has written it, so an empty queue does not mean "sent"), and only force the close
    /// if the peer is not reading.
    /// </summary>
    public void Kill(Client client)
    {
        Retire(client);
        client.Finished.WaitOne(KillWaitMs);
        try
        {
            client.Tcp.Close();
        }
        catch (Exception)
        {
            // Already closed.
        }
    }

    /// <summary>
    /// The output a viewer joining now needs to see the screen (conpty.dll does not repaint for it): everything since the
    /// last "clear screen", capped. Cut at a line start when capped, so the replay never begins inside an escape sequence.
    /// </summary>
    private void Record(byte[] output)
    {
        if (!Native.ConsoleKind.StartsWith("conpty"))
        {
            return;
        }
        TrackModes(output);
        int clear = LastClear(output);
        if (clear >= 0)
        {
            replay.SetLength(0);
            replay.Write(output, clear, output.Length - clear);
        }
        else
        {
            replay.Write(output, 0, output.Length);
        }
        if (replay.Length <= MaxReplay)
        {
            return;
        }
        byte[] all = replay.ToArray();
        int from = all.Length - MaxReplay / 2;
        while (from < all.Length && all[from] != (byte)'\n')
        {
            from++;
        }
        replay.SetLength(0);
        if (from + 1 < all.Length)
        {
            replay.Write(all, from + 1, all.Length - from - 1);
        }
    }

    private void TrackModes(byte[] output)
    {
        foreach (byte b in output)
        {
            if (b == 0x1b)
            {
                modeState = 1;
                continue;
            }
            switch (modeState)
            {
                case 1:
                    modeState = b == (byte)'[' ? 2 : 0;
                    break;
                case 2:
                    modeState = b == (byte)'?' ? 3 : 0;
                    modeParams.Length = 0;
                    break;
                case 3:
                    if ((b >= (byte)'0' && b <= (byte)'9') || b == (byte)';')
                    {
                        if (modeParams.Length < MaxModeParams)
                        {
                            modeParams.Append((char)b);
                        }
                    }
                    else
                    {
                        if (b == (byte)'h' || b == (byte)'l')
                        {
                            SetModes(b == (byte)'h');
                        }
                        modeState = 0;
                    }
                    break;
            }
        }
    }

    private void SetModes(bool on)
    {
        foreach (string p in modeParams.ToString().Split(';'))
        {
            int mode;
            if (int.TryParse(p, out mode) && Array.IndexOf(ReplayedModes, mode) >= 0)
            {
                modes[mode] = on;
            }
        }
    }

    /// <summary>The modes to set before the replay, e.g. ESC[?1000h ESC[?1006h.</summary>
    private byte[] ModePrefix()
    {
        StringBuilder text = new StringBuilder();
        foreach (int mode in ReplayedModes)
        {
            bool on;
            if (modes.TryGetValue(mode, out on))
            {
                text.Append("\x1b[?" + mode + (on ? "h" : "l"));
            }
        }
        return Encoding.ASCII.GetBytes(text.ToString());
    }

    /// <summary>Where the last ESC[2J (clear screen) or ESC c (reset) starts in `data`, or -1.</summary>
    private static int LastClear(byte[] data)
    {
        for (int i = data.Length - 2; i >= 0; i--)
        {
            if (data[i] != 0x1b)
            {
                continue;
            }
            if (data[i + 1] == (byte)'c')
            {
                return i;
            }
            if (i + 3 < data.Length && data[i + 1] == (byte)'[' && data[i + 2] == (byte)'2' && data[i + 3] == (byte)'J')
            {
                return i;
            }
        }
        return -1;
    }

    private void Remember(byte[] output)
    {
        lock (tail)
        {
            int keep = Math.Min(tailLength, tail.Length - Math.Min(output.Length, tail.Length));
            Buffer.BlockCopy(tail, tailLength - keep, tail, 0, keep);
            int add = Math.Min(output.Length, tail.Length);
            Buffer.BlockCopy(output, output.Length - add, tail, keep, add);
            tailLength = keep + add;
        }
    }

    private void TakeOwnership(Client client)
    {
        lock (gate)
        {
            // Kept in order of activity, so a departing owner hands over to whoever was active most recently.
            if (clients.Remove(client))
            {
                clients.Add(client);
            }
            sizeOwner = client;
        }
        Apply(client.Cols, client.Rows);
    }

    private void Apply(short width, short height)
    {
        if (width < 2 || height < 2)
        {
            return;
        }
        PseudoConsole current;
        bool same;
        lock (gate)
        {
            current = console;
            same = cols == width && rows == height;
            cols = width;
            rows = height;
        }
        if (current == null)
        {
            return;
        }
        if (Native.ConsoleKind.StartsWith("conpty"))
        {
            // Passed through: nothing repaints, the program redraws itself on every resize. Programs like Claude Code
            // leave a second copy of their screen behind when they do, so resize only when the size really changes.
            if (!same)
            {
                current.Resize(width, height);
            }
            return;
        }
        // Windows' own ConPTY repaints everything on a size change; resizing by one row first forces that even for the
        // same size.
        current.Resize(width, (short)(height - 1));
        current.Resize(width, height);
    }

    private bool TokenMatches(byte[] offered)
    {
        int diff = offered.Length ^ token.Length;
        for (int i = 0; i < offered.Length && i < token.Length; i++)
        {
            diff |= offered[i] ^ token[i];
        }
        return diff == 0;
    }

    private List<Client> Snapshot()
    {
        lock (gate)
        {
            return new List<Client>(clients);
        }
    }

    /// <summary>Queues a frame; a client whose outbox is full has stopped reading and is disconnected.</summary>
    private void Send(Client client, byte type, byte[] payload)
    {
        bool queued;
        try
        {
            queued = client.Outbox.TryAdd(Frame.Encode(type, payload));
        }
        catch (InvalidOperationException)
        {
            return;
        }
        if (!queued)
        {
            Kill(client);
        }
    }
}

/// <summary>
/// Everything a session's program started, followed while it runs (every few seconds, so a process whose parent has
/// already exited is still known) and ended when the program exits: nothing an agent starts outlives its session.
/// A process is recognised by its id and start time, so an id Windows has given to another process is never touched.
/// Shared services an agent may start for every session (databases, the compile cache) are left running.
/// </summary>
sealed class ProcessTree
{
    private const uint SnapProcess = 0x00000002;
    private const uint ProcessTerminate = 0x0001;
    private const uint ProcessQueryLimited = 0x1000;
    private const uint Synchronize = 0x00100000;
    private const uint WaitTimeout = 0x102;
    private const int FollowMs = 3000;
    private const int MaxPath = 260;
    private const uint MoveReplaceExisting = 0x1;
    private const uint MoveWriteThrough = 0x8;
    /// <summary>A record larger than this is not one ptyhost wrote (thousands of processes).</summary>
    private const int MaxRecordBytes = 1 << 20;
    /// <summary>--end-tree exit codes: the ptyhost that wrote the record still runs; no readable record.</summary>
    private const int StillRunning = 3;
    private const int Unreadable = 4;
    private static readonly IntPtr InvalidHandle = new IntPtr(-1);
    private static readonly Regex RecordEntry = new Regex("\\{\"pid\":(\\d{1,10}),\"start\":\"(\\d{1,20})\"\\}");
    /// <summary>The pseudo console's own process (Windows' or conpty.dll's), started by ptyhost itself.</summary>
    private static readonly HashSet<string> ConsoleHosts = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "conhost.exe", "OpenConsole.exe",
    };
    private static readonly HashSet<string> Shared = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "postgres.exe", "pg_ctl.exe", "mysqld.exe", "mariadbd.exe", "redis-server.exe", "mongod.exe", "sccache.exe",
        "sbx-netproxy.exe",
    };

    // PROCESSENTRY32W.
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessEntry
    {
        public uint Size;
        public uint Usage;
        public uint ProcessId;
        public IntPtr DefaultHeapId;
        public uint ModuleId;
        public uint Threads;
        public uint ParentProcessId;
        public int PriorityBase;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = MaxPath)]
        public string ExeFile;
    }

    private static class NativeMethods
    {
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool TerminateProcess(IntPtr process, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern int GetProcessId(IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool MoveFileExW(string existing, string replacement, uint flags);

        [DllImport("kernel32.dll")]
        public static extern int GetCurrentProcessId();

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    }

    private readonly object gate = new object();
    /// <summary>The program and what it started: process id -> start time.</summary>
    private readonly Dictionary<int, long> known = new Dictionary<int, long>();
    /// <summary>The program (closing the console ends it), spared by EndAll (0 in --end-tree: none).</summary>
    private readonly int root;
    private readonly Timer timer;
    /// <summary>Where the tree is recorded (PTYHOST_TREE_FILE), or null.</summary>
    private readonly string recordFile;
    private int recorded = -1;
    /// <summary>The last process snapshot Refresh took (Record reuses it), or null.</summary>
    private List<ProcessEntry> lastSnapshot;
    private bool ended;

    public ProcessTree(IntPtr rootProcess)
    {
        root = NativeMethods.GetProcessId(rootProcess);
        long start = StartTime(root);
        if (root != 0 && start != 0)
        {
            known[root] = start;
        }
        string file = Environment.GetEnvironmentVariable("PTYHOST_TREE_FILE");
        recordFile = string.IsNullOrEmpty(file) ? null : file;
        lock (gate)
        {
            Record();
        }
        timer = new Timer(Follow, null, FollowMs, FollowMs);
    }

    /// <summary>--end-tree: the processes of a record that still run as the same process (id and start time).</summary>
    private ProcessTree(Dictionary<int, long> alive)
    {
        foreach (KeyValuePair<int, long> p in alive)
        {
            known[p.Key] = p.Value;
        }
    }

    private void Follow(object unused)
    {
        lock (gate)
        {
            if (!ended)
            {
                Refresh();
                Record();
            }
        }
    }

    /// <summary>
    /// Writes the tree to the record file when it grew: {"ptyhost":{"pid":1,"start":"2"},"processes":[{...}]}, start
    /// times as FILETIME strings (too large for a JSON number). Written aside and moved over the old one, so a ptyhost
    /// ended at any moment leaves a whole record.
    /// </summary>
    private void Record()
    {
        if (recordFile == null)
        {
            return;
        }
        // The pseudo console's process too: one whose ptyhost was ended does not always go away by itself.
        int self = NativeMethods.GetCurrentProcessId();
        long selfStart = StartTime(self);
        Dictionary<int, long> all = new Dictionary<int, long>(known);
        foreach (ProcessEntry p in lastSnapshot ?? Snapshot())
        {
            int pid = (int)p.ProcessId;
            if ((int)p.ParentProcessId != self || !ConsoleHosts.Contains(p.ExeFile) || all.ContainsKey(pid))
            {
                continue;
            }
            long start = StartTime(pid);
            if (start != 0 && start >= selfStart)
            {
                all[pid] = start;
            }
        }
        if (all.Count == recorded)
        {
            return;
        }
        StringBuilder json = new StringBuilder();
        json.Append("{\"ptyhost\":").Append(Entry(self, selfStart)).Append(",\"processes\":[");
        bool first = true;
        foreach (KeyValuePair<int, long> p in all)
        {
            json.Append(first ? "" : ",").Append(Entry(p.Key, p.Value));
            first = false;
        }
        json.Append("]}");
        string temp = recordFile + ".tmp";
        try
        {
            File.WriteAllText(temp, json.ToString());
            if (NativeMethods.MoveFileExW(temp, recordFile, MoveReplaceExisting | MoveWriteThrough))
            {
                recorded = all.Count;
            }
        }
        catch (IOException)
        {
            // Tried again on the next round (every FollowMs).
        }
        catch (UnauthorizedAccessException)
        {
            // Same.
        }
    }

    private static string Entry(int pid, long start)
    {
        return "{\"pid\":" + pid + ",\"start\":\"" + start + "\"}";
    }

    /// <summary>The tree ended with ptyhost's own help: nothing is left for the daemon to end.</summary>
    private void Unrecord()
    {
        if (recordFile == null)
        {
            return;
        }
        try
        {
            File.Delete(recordFile);
        }
        catch (IOException)
        {
            // The daemon finds the processes gone (their ids and start times no longer match).
        }
        catch (UnauthorizedAccessException)
        {
            // Same.
        }
    }

    /// <summary>
    /// --end-tree: ends what a ptyhost recorded, unless that ptyhost still runs. Only processes that still run as the
    /// recorded process (same id and start time) count, and the processes they started since; the Shared ones
    /// (databases, sccache ...) are spared as always. Prints how many were ended. 0 = done, 3 = the ptyhost still
    /// runs, 4 = no readable record.
    /// </summary>
    public static int EndRecorded(string file)
    {
        string text;
        try
        {
            FileInfo info = new FileInfo(file);
            if (!info.Exists || info.Length > MaxRecordBytes)
            {
                return Unreadable;
            }
            text = File.ReadAllText(file);
        }
        catch (IOException)
        {
            return Unreadable;
        }
        catch (UnauthorizedAccessException)
        {
            return Unreadable;
        }
        if (!text.StartsWith("{\"ptyhost\":"))
        {
            return Unreadable;
        }
        MatchCollection entries = RecordEntry.Matches(text);
        if (entries.Count == 0)
        {
            return Unreadable;
        }
        Dictionary<int, long> alive = new Dictionary<int, long>();
        for (int i = 0; i < entries.Count; i++)
        {
            int pid;
            long start;
            if (!int.TryParse(entries[i].Groups[1].Value, out pid) ||
                !long.TryParse(entries[i].Groups[2].Value, out start))
            {
                return Unreadable;
            }
            bool same = pid != 0 && start != 0 && Running(pid, start);
            if (i == 0)
            {
                if (same)
                {
                    return StillRunning;
                }
            }
            else if (same)
            {
                alive[pid] = start;
            }
        }
        int ended = new ProcessTree(alive).EndAll();
        Console.Out.WriteLine("ended " + ended + " process(es)");
        return 0;
    }

    /// <summary>Adds every process whose parent is known (and that started after it), until nothing new is found.</summary>
    private void Refresh()
    {
        if (known.Count == 0)
        {
            return;
        }
        List<ProcessEntry> all = Snapshot();
        lastSnapshot = all;
        bool added = true;
        while (added)
        {
            added = false;
            foreach (ProcessEntry p in all)
            {
                int pid = (int)p.ProcessId;
                int parent = (int)p.ParentProcessId;
                long parentStart;
                if (known.ContainsKey(pid) || !known.TryGetValue(parent, out parentStart) || Shared.Contains(p.ExeFile))
                {
                    continue;
                }
                long start = StartTime(pid);
                // A child starts after its parent: an older process that names a reused id as its parent is not ours.
                if (start == 0 || start < parentStart)
                {
                    continue;
                }
                known[pid] = start;
                added = true;
            }
        }
    }

    /// <summary>Stops following and ends what the program started that still runs; returns how many were ended.</summary>
    public int EndAll()
    {
        lock (gate)
        {
            if (ended)
            {
                return 0;
            }
            Refresh();
            ended = true;
            if (timer != null)
            {
                timer.Dispose();
            }
            int count = 0;
            foreach (KeyValuePair<int, long> p in known)
            {
                if (p.Key != root && StartTime(p.Key) == p.Value && Terminate(p.Key))
                {
                    count++;
                }
            }
            Unrecord();
            return count;
        }
    }

    private static List<ProcessEntry> Snapshot()
    {
        List<ProcessEntry> all = new List<ProcessEntry>();
        IntPtr snapshot = NativeMethods.CreateToolhelp32Snapshot(SnapProcess, 0);
        if (snapshot == InvalidHandle || snapshot == IntPtr.Zero)
        {
            return all;
        }
        try
        {
            ProcessEntry entry = new ProcessEntry();
            entry.Size = (uint)Marshal.SizeOf(typeof(ProcessEntry));
            bool more = NativeMethods.Process32FirstW(snapshot, ref entry);
            while (more)
            {
                all.Add(entry);
                more = NativeMethods.Process32NextW(snapshot, ref entry);
            }
        }
        finally
        {
            NativeMethods.CloseHandle(snapshot);
        }
        return all;
    }

    /// <summary>When the process started (FILETIME), or 0 when it is gone or cannot be read.</summary>
    private static long StartTime(int pid)
    {
        IntPtr process = NativeMethods.OpenProcess(ProcessQueryLimited, false, pid);
        if (process == IntPtr.Zero)
        {
            return 0;
        }
        try
        {
            long creation;
            long exit;
            long kernel;
            long user;
            return NativeMethods.GetProcessTimes(process, out creation, out exit, out kernel, out user) ? creation : 0;
        }
        finally
        {
            NativeMethods.CloseHandle(process);
        }
    }

    /// <summary>
    /// True while process pid is the one that started at `start` and has not ended (an ended process someone still
    /// holds a handle to keeps its id and start time).
    /// </summary>
    private static bool Running(int pid, long start)
    {
        IntPtr process = NativeMethods.OpenProcess(ProcessQueryLimited | Synchronize, false, pid);
        if (process == IntPtr.Zero)
        {
            return false;
        }
        try
        {
            long creation;
            long exit;
            long kernel;
            long user;
            return NativeMethods.GetProcessTimes(process, out creation, out exit, out kernel, out user) &&
                creation == start && NativeMethods.WaitForSingleObject(process, 0) == WaitTimeout;
        }
        finally
        {
            NativeMethods.CloseHandle(process);
        }
    }

    private static bool Terminate(int pid)
    {
        IntPtr process = NativeMethods.OpenProcess(ProcessTerminate, false, pid);
        if (process == IntPtr.Zero)
        {
            return false;
        }
        try
        {
            return NativeMethods.TerminateProcess(process, 1);
        }
        finally
        {
            NativeMethods.CloseHandle(process);
        }
    }
}
/// <summary>One program running inside a pseudo console, with a thread pumping its output to `onOutput`.</summary>
sealed class PseudoConsole : IDisposable
{
    private const int PumpBufferBytes = 16384;
    private const uint Infinite = 0xFFFFFFFF;
    private const int PumpJoinMs = 5000;

    private readonly IntPtr handle;
    private readonly IntPtr process;
    private readonly FileStream input;
    private readonly Thread pump;
    private readonly ProcessTree tree;
    private readonly Log log;
    private readonly object gate = new object();
    private bool closed;
    private bool disposed;

    private PseudoConsole(IntPtr handle, IntPtr process, FileStream input, Thread pump, Log log)
    {
        this.handle = handle;
        this.process = process;
        this.input = input;
        this.pump = pump;
        this.log = log;
        tree = new ProcessTree(process);
    }

    public static PseudoConsole Start(string commandLine, short cols, short rows, Action<byte[]> onOutput, Log log)
    {
        SafeFileHandle inRead;
        SafeFileHandle inWrite;
        SafeFileHandle outRead;
        SafeFileHandle outWrite;
        Native.Check(Native.CreatePipe(out inRead, out inWrite), "CreatePipe");
        Native.Check(Native.CreatePipe(out outRead, out outWrite), "CreatePipe");
        IntPtr handle;
        int hr = Native.CreatePseudoConsole(Native.Size(cols, rows), inRead, outWrite, 0, out handle);
        if (hr != 0)
        {
            throw new IOException("CreatePseudoConsole failed: 0x" + hr.ToString("X8"));
        }
        inRead.Dispose();
        outWrite.Dispose();
        IntPtr process = Native.Spawn(commandLine, handle, log);
        FileStream output = new FileStream(outRead, FileAccess.Read);
        Thread pump = new Thread(() => Pump(output, onOutput));
        pump.IsBackground = true;
        pump.Start();
        return new PseudoConsole(handle, process, new FileStream(inWrite, FileAccess.Write), pump, log);
    }

    public int WaitForExit()
    {
        Native.WaitForSingleObject(process, Infinite);
        uint code;
        Native.GetExitCodeProcess(process, out code);
        Close();
        pump.Join(PumpJoinMs);
        // Closing the console asked what was attached to it to end; whatever the program started that is still
        // running now (a server in the background, a build that lost its parent) ends with it.
        int ended = tree.EndAll();
        if (ended > 0)
        {
            log.Write("ended " + ended + " process(es) the program left running");
        }
        return (int)code;
    }

    public void Write(byte[] data)
    {
        try
        {
            lock (input)
            {
                input.Write(data, 0, data.Length);
                input.Flush();
            }
        }
        catch (IOException)
        {
            // The program has ended.
        }
        catch (ObjectDisposedException)
        {
            // Same.
        }
    }

    public void Resize(short cols, short rows)
    {
        lock (gate)
        {
            if (!closed)
            {
                Native.ResizePseudoConsole(handle, Native.Size(cols, rows));
            }
        }
    }

    /// <summary>Closing the pseudo console ends every process attached to it (the agent and anything it started).</summary>
    public void Kill()
    {
        lock (gate)
        {
            if (disposed)
            {
                return;
            }
            Native.TerminateProcess(process, 1);
        }
        Close();
    }

    public void Dispose()
    {
        Close();
        lock (gate)
        {
            if (disposed)
            {
                return;
            }
            disposed = true;
            Native.CloseHandle(process);
        }
    }

    private static void Pump(FileStream output, Action<byte[]> onOutput)
    {
        byte[] buffer = new byte[PumpBufferBytes];
        try
        {
            int n;
            while ((n = output.Read(buffer, 0, buffer.Length)) > 0)
            {
                byte[] chunk = new byte[n];
                Buffer.BlockCopy(buffer, 0, chunk, 0, n);
                onOutput(chunk);
            }
        }
        catch (IOException)
        {
            // The pseudo console was closed.
        }
        finally
        {
            output.Dispose();
        }
    }

    private void Close()
    {
        lock (gate)
        {
            if (closed)
            {
                return;
            }
            closed = true;
            try
            {
                input.Dispose();
            }
            catch (IOException)
            {
                // The pipe is broken already.
            }
            Native.ClosePseudoConsole(handle);
        }
    }
}

/// <summary>The wire format (see the top of this file).</summary>
static class Frame
{
    public const byte Hello = 1;
    public const byte Input = 2;
    public const byte Resize = 3;
    public const byte Restart = 4;
    public const byte Ping = 5;
    public const byte Close = 6;
    public const byte Output = 16;
    public const byte Exit = 17;
    public const byte Error = 18;
    public const byte Restarting = 19;
    public const byte Status = 20;
    public const byte Console = 21;
    private const int HeaderBytes = 5;
    private const int MaxPayload = 1 << 20;

    public static bool Read(Stream stream, out byte type, out byte[] payload)
    {
        type = 0;
        payload = null;
        byte[] header = new byte[HeaderBytes];
        if (!ReadExactly(stream, header))
        {
            return false;
        }
        int length = BitConverter.ToInt32(header, 1);
        if (length < 0 || length > MaxPayload)
        {
            return false;
        }
        type = header[0];
        payload = new byte[length];
        return ReadExactly(stream, payload);
    }

    public static byte[] Encode(byte type, byte[] payload)
    {
        byte[] frame = new byte[HeaderBytes + payload.Length];
        frame[0] = type;
        BitConverter.GetBytes(payload.Length).CopyTo(frame, 1);
        Buffer.BlockCopy(payload, 0, frame, HeaderBytes, payload.Length);
        return frame;
    }

    private static bool ReadExactly(Stream stream, byte[] buffer)
    {
        int offset = 0;
        while (offset < buffer.Length)
        {
            int n = stream.Read(buffer, offset, buffer.Length - offset);
            if (n <= 0)
            {
                return false;
            }
            offset += n;
        }
        return true;
    }
}

sealed class Log
{
    private readonly string file;

    public Log(string file)
    {
        this.file = file;
    }

    public void Write(string message)
    {
        try
        {
            File.AppendAllText(file, DateTime.Now.ToString("s") + " " + message + Environment.NewLine);
        }
        catch (Exception)
        {
            // Logging never stops the session.
        }
    }
}

/// <summary>
/// The pseudo console: the newer conpty.dll (+ OpenConsole.exe next to it) when PTYHOST_CONPTY names one, else the one
/// built into Windows. Windows 10/11 before 24H2 ship a ConPTY that re-renders the screen instead of passing the
/// program's output through, which garbles wide characters after a resize and loses mouse input and scrollback.
/// </summary>
static class Native
{
    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private const uint CreateSuspended = 0x00000004;
    // The shared job of everything the agents start (the memory governor in the daemon opens it by this name).
    private const string AgentJobName = "Local\\AgentSandboxAgentsJob";
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JobObjectLimitJobMemory = 0x00000200;
    private const int ErrorAlreadyExists = 183;
    /// <summary>The backstop's headroom for "auto": this much of the commit limit, at least MinHeadroomMb.</summary>
    private const int HeadroomPercent = 3;
    private const long MinHeadroomMb = 1536;
    private const long BytesPerMb = 1024L * 1024L;
    private const int UseStdHandles = 0x00000100;
    private static readonly IntPtr PseudoConsoleAttribute = (IntPtr)0x00020016;

    [StructLayout(LayoutKind.Sequential)]
    public struct Coord
    {
        public short X;
        public short Y;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfoEx
    {
        public StartupInfo StartupInfo;
        public IntPtr lpAttributeList;
    }

    // JOBOBJECT_BASIC_LIMIT_INFORMATION, IO_COUNTERS and JOBOBJECT_EXTENDED_LIMIT_INFORMATION.
    [StructLayout(LayoutKind.Sequential)]
    private struct JobBasicLimit
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    // MEMORYSTATUSEX: ullTotalPageFile is the commit limit (RAM plus paging files).
    [StructLayout(LayoutKind.Sequential)]
    private struct MemoryStatus
    {
        public uint Length;
        public uint MemoryLoad;
        public ulong TotalPhys;
        public ulong AvailPhys;
        public ulong TotalPageFile;
        public ulong AvailPageFile;
        public ulong TotalVirtual;
        public ulong AvailVirtual;
        public ulong AvailExtendedVirtual;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobExtendedLimit
    {
        public JobBasicLimit BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate int CreateFn(Coord size, SafeFileHandle hInput, SafeFileHandle hOutput, uint dwFlags, out IntPtr phPC);

    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate int ResizeFn(IntPtr hPC, Coord size);

    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate void CloseFn(IntPtr hPC);

    private static CreateFn create;
    private static ResizeFn resize;
    private static CloseFn close;

    /// <summary>"conpty.dll" or "windows": which pseudo console is in use (logged, and told to viewers).</summary>
    public static string ConsoleKind = "windows";

    private static class NativeMethods
    {
        [DllImport("kernel32.dll", EntryPoint = "CreatePseudoConsole")]
        public static extern int CreatePseudoConsole(Coord size, SafeFileHandle hInput, SafeFileHandle hOutput, uint dwFlags, out IntPtr phPC);

        [DllImport("kernel32.dll", EntryPoint = "ResizePseudoConsole")]
        public static extern int ResizePseudoConsole(IntPtr hPC, Coord size);

        [DllImport("kernel32.dll", EntryPoint = "ClosePseudoConsole")]
        public static extern void ClosePseudoConsole(IntPtr hPC);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern IntPtr LoadLibraryW(string path);

        [DllImport("kernel32.dll", CharSet = CharSet.Ansi, BestFitMapping = false, SetLastError = true)]
        public static extern IntPtr GetProcAddress(IntPtr module, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CreatePipe(out SafeFileHandle hReadPipe, out SafeFileHandle hWritePipe, IntPtr lpPipeAttributes, int nSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool InitializeProcThreadAttributeList(IntPtr lpAttributeList, int dwAttributeCount, int dwFlags, ref IntPtr lpSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool UpdateProcThreadAttribute(IntPtr lpAttributeList, uint dwFlags, IntPtr attribute, IntPtr lpValue, IntPtr cbSize, IntPtr lpPreviousValue, IntPtr lpReturnSize);

        [DllImport("kernel32.dll")]
        public static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool CreateProcessW(string lpApplicationName, StringBuilder lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory, ref StartupInfoEx lpStartupInfo, out ProcessInformation lpProcessInformation);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GlobalMemoryStatusEx(ref MemoryStatus status);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JobExtendedLimit info, int length);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint ResumeThread(IntPtr thread);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr hObject);
    }

    static Native()
    {
        string dll = Environment.GetEnvironmentVariable("PTYHOST_CONPTY");
        if (string.IsNullOrEmpty(dll) || !File.Exists(dll) || !File.Exists(Path.Combine(Path.GetDirectoryName(dll), "OpenConsole.exe")))
        {
            return;
        }
        IntPtr module = NativeMethods.LoadLibraryW(dll);
        if (module == IntPtr.Zero)
        {
            return;
        }
        IntPtr c = NativeMethods.GetProcAddress(module, "ConptyCreatePseudoConsole");
        IntPtr r = NativeMethods.GetProcAddress(module, "ConptyResizePseudoConsole");
        IntPtr x = NativeMethods.GetProcAddress(module, "ConptyClosePseudoConsole");
        if (c == IntPtr.Zero || r == IntPtr.Zero || x == IntPtr.Zero)
        {
            return;
        }
        create = (CreateFn)Marshal.GetDelegateForFunctionPointer(c, typeof(CreateFn));
        resize = (ResizeFn)Marshal.GetDelegateForFunctionPointer(r, typeof(ResizeFn));
        close = (CloseFn)Marshal.GetDelegateForFunctionPointer(x, typeof(CloseFn));
        ConsoleKind = "conpty.dll";
    }

    public static Coord Size(short cols, short rows)
    {
        Coord size = new Coord();
        size.X = cols;
        size.Y = rows;
        return size;
    }

    public static void Check(bool ok, string what)
    {
        if (!ok)
        {
            throw new IOException(what + " failed: " + Marshal.GetLastWin32Error());
        }
    }

    public static bool CreatePipe(out SafeFileHandle read, out SafeFileHandle write)
    {
        return NativeMethods.CreatePipe(out read, out write, IntPtr.Zero, 0);
    }

    private static IntPtr agentJob;
    private static bool agentJobTried;

    /// <summary>
    /// The shared job of everything the agents start (the governor reads it to slow builds down). Its only limit is a
    /// last-resort backstop: the sandbox's commit limit minus a small headroom (PTYHOST_BACKSTOP_MB: "auto", a number
    /// of MB, or "none"). The job's committed memory is part of the whole sandbox's, so it can reach the backstop only
    /// when Windows inside the sandbox is about to refuse memory to everyone; then a build is refused instead of
    /// Windows' own processes. Only the ptyhost that creates the job sets it: one that joins it never changes it.
    /// ptyhost itself is never in it; the handle stays open for ptyhost's whole life.
    /// </summary>
    private static IntPtr AgentJob(Log log)
    {
        if (agentJobTried)
        {
            return agentJob;
        }
        agentJobTried = true;
        string setting = Environment.GetEnvironmentVariable("PTYHOST_BACKSTOP_MB");
        if (string.IsNullOrEmpty(setting))
        {
            return IntPtr.Zero;
        }
        // The self-test uses a job of its own (a name in the same family), never the agents' real one.
        string name = Environment.GetEnvironmentVariable("PTYHOST_JOB_NAME");
        if (string.IsNullOrEmpty(name) || !name.StartsWith(AgentJobName + "Test", StringComparison.Ordinal))
        {
            name = AgentJobName;
        }
        IntPtr job = NativeMethods.CreateJobObjectW(IntPtr.Zero, name);
        int error = Marshal.GetLastWin32Error();
        if (job == IntPtr.Zero)
        {
            log.Write("agent job: CreateJobObject failed (" + error + "); agents run outside it");
            return IntPtr.Zero;
        }
        agentJob = job;
        if (error == ErrorAlreadyExists)
        {
            log.Write("agent job: joined the existing one (its backstop stays as it was set)");
            return job;
        }
        if (setting == "none")
        {
            log.Write("agent job: no backstop (sandbox.agentMemoryHeadroomMb is none)");
            return job;
        }
        long commitMb;
        long limitMb = BackstopMb(setting, out commitMb);
        if (limitMb <= 0)
        {
            log.Write("agent job: the commit limit cannot be read; no backstop");
            return job;
        }
        JobExtendedLimit info = new JobExtendedLimit();
        info.BasicLimitInformation.LimitFlags = JobObjectLimitJobMemory;
        info.JobMemoryLimit = new UIntPtr((ulong)(limitMb * BytesPerMb));
        if (!NativeMethods.SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref info, Marshal.SizeOf(typeof(JobExtendedLimit))))
        {
            log.Write("agent job: setting the backstop failed (" + Marshal.GetLastWin32Error() + "); no backstop");
            return job;
        }
        log.Write("agent job: last-resort backstop at " + limitMb + " MB committed (the sandbox's commit limit is " + commitMb + " MB)");
        return job;
    }

    /// <summary>The commit limit minus the headroom ("auto" or MB), at least half of it; 0 when it cannot be read.</summary>
    private static long BackstopMb(string setting, out long commitMb)
    {
        commitMb = 0;
        MemoryStatus status = new MemoryStatus();
        status.Length = (uint)Marshal.SizeOf(typeof(MemoryStatus));
        if (!NativeMethods.GlobalMemoryStatusEx(ref status))
        {
            return 0;
        }
        commitMb = (long)(status.TotalPageFile / (ulong)BytesPerMb);
        long headroom;
        if (setting == "auto" || !long.TryParse(setting, out headroom) || headroom < 0)
        {
            headroom = Math.Max(MinHeadroomMb, commitMb * HeadroomPercent / 100);
        }
        return Math.Max(commitMb / 2, commitMb - headroom);
    }

    /// <summary>Starts `commandLine` attached to the pseudo console. Null std handles: never leak our own stdio into the child.</summary>
    public static IntPtr Spawn(string commandLine, IntPtr pseudoConsole, Log log)
    {
        IntPtr job = AgentJob(log);
        IntPtr size = IntPtr.Zero;
        NativeMethods.InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
        IntPtr attributes = Marshal.AllocHGlobal(size);
        try
        {
            Check(NativeMethods.InitializeProcThreadAttributeList(attributes, 1, 0, ref size), "InitializeProcThreadAttributeList");
            Check(NativeMethods.UpdateProcThreadAttribute(attributes, 0, PseudoConsoleAttribute, pseudoConsole, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero), "UpdateProcThreadAttribute");
            StartupInfoEx info = new StartupInfoEx();
            info.StartupInfo.cb = Marshal.SizeOf(typeof(StartupInfoEx));
            info.StartupInfo.dwFlags = UseStdHandles;
            info.lpAttributeList = attributes;
            ProcessInformation pi;
            if (!NativeMethods.CreateProcessW(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, false, ExtendedStartupInfoPresent | (job != IntPtr.Zero ? CreateSuspended : 0), IntPtr.Zero, null, ref info, out pi))
            {
                throw new IOException("CreateProcess failed (" + Marshal.GetLastWin32Error() + "): " + commandLine);
            }
            if (job != IntPtr.Zero)
            {
                // Suspended until it is in the job, so nothing it starts can be outside.
                if (!NativeMethods.AssignProcessToJobObject(job, pi.hProcess))
                {
                    log.Write("agent job: could not add the agent (" + Marshal.GetLastWin32Error() + "); it runs without the memory limit");
                }
                NativeMethods.ResumeThread(pi.hThread);
            }
            NativeMethods.CloseHandle(pi.hThread);
            return pi.hProcess;
        }
        finally
        {
            NativeMethods.DeleteProcThreadAttributeList(attributes);
            Marshal.FreeHGlobal(attributes);
        }
    }

    /// <summary>conpty.dll first; if it cannot start one (OpenConsole.exe blocked or broken), the built-in one for good.</summary>
    public static int CreatePseudoConsole(Coord size, SafeFileHandle hInput, SafeFileHandle hOutput, uint dwFlags, out IntPtr phPC)
    {
        if (create != null)
        {
            int hr = create(size, hInput, hOutput, dwFlags, out phPC);
            if (hr == 0)
            {
                return 0;
            }
            create = null;
            resize = null;
            close = null;
            ConsoleKind = "windows (conpty.dll failed: 0x" + hr.ToString("X8") + ")";
        }
        return NativeMethods.CreatePseudoConsole(size, hInput, hOutput, dwFlags, out phPC);
    }

    public static int ResizePseudoConsole(IntPtr hPC, Coord size)
    {
        return resize != null ? resize(hPC, size) : NativeMethods.ResizePseudoConsole(hPC, size);
    }

    public static void ClosePseudoConsole(IntPtr hPC)
    {
        if (close != null)
        {
            close(hPC);
        }
        else
        {
            NativeMethods.ClosePseudoConsole(hPC);
        }
    }

    public static uint WaitForSingleObject(IntPtr handle, uint milliseconds)
    {
        return NativeMethods.WaitForSingleObject(handle, milliseconds);
    }

    public static bool GetExitCodeProcess(IntPtr process, out uint exitCode)
    {
        return NativeMethods.GetExitCodeProcess(process, out exitCode);
    }

    public static bool TerminateProcess(IntPtr process, uint exitCode)
    {
        return NativeMethods.TerminateProcess(process, exitCode);
    }

    public static bool CloseHandle(IntPtr handle)
    {
        return NativeMethods.CloseHandle(handle);
    }
}
