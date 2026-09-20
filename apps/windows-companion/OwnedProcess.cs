using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Collections.Generic;
using System.Web.Script.Serialization;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

namespace CodexPlusCompanion
{
    internal sealed class PairingReply
    {
        public string State, Code;
        public long ExpiresAt;
        public static PairingReply Parse(string line, long now)
        {
            try {
                var data = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(line);
                if (data == null || !data.ContainsKey("desktopMessage") || (data["desktopMessage"] as string) != "pairing" || !data.ContainsKey("state")) return null;
                var state = data["state"] as string;
                if (state == "paired" || state == "failed" || state == "unavailable") return data.Count == 2 ? new PairingReply { State = state } : null;
                if (state != "code" || data.Count != 4 || !data.ContainsKey("code") || !data.ContainsKey("expiresAt")) return null;
                string code = data["code"] as string;
                if (code == null || !Regex.IsMatch(code, "\\A[0-9A-HJKMNP-TV-Z]{8}\\z") || !(data["expiresAt"] is long || data["expiresAt"] is int)) return null;
                long expiresAt = Convert.ToInt64(data["expiresAt"]);
                if (expiresAt <= now || expiresAt - now > 300000) return null;
                return new PairingReply { State = state, Code = code, ExpiresAt = expiresAt };
            } catch { return null; }
        }
    }

    internal sealed class OwnedJob : SafeHandleZeroOrMinusOneIsInvalid
    {
        [StructLayout(LayoutKind.Sequential)] struct BasicLimits
        {
            public long ProcessTime, JobTime;
            public uint Flags;
            public UIntPtr MinWorkingSet, MaxWorkingSet;
            public uint ActiveProcesses;
            public UIntPtr Affinity;
            public uint Priority, SchedulingClass;
        }
        [StructLayout(LayoutKind.Sequential)] struct IoCounters
        {
            public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
        }
        [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits
        {
            public BasicLimits Basic;
            public IoCounters Io;
            public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(OwnedJob job, int kind, ref ExtendedLimits limits, uint size);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(OwnedJob job, IntPtr process);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        public OwnedJob() : base(true)
        {
            SetHandle(CreateJobObject(IntPtr.Zero, null));
            if (IsInvalid) throw new Win32Exception();
            var limits = new ExtendedLimits();
            limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; no breakaway.
            if (!SetInformationJobObject(this, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))))
            { Dispose(); throw new Win32Exception(); }
        }
        public void Assign(Process process)
        {
            if (!AssignProcessToJobObject(this, process.Handle)) throw new Win32Exception();
        }
        protected override bool ReleaseHandle() { return CloseHandle(handle); }
    }

    internal sealed class OwnedProcess : IDisposable
    {
        private readonly OwnedJob job = new OwnedJob();
        private readonly Process process = new Process();
        private readonly object lifecycleLock = new object();
        private bool started, disposed;
        public event Action<string> Line;
        public event Action<PairingReply> Pairing;
        public event Action<int> Exited;
        public bool IsRunning { get { lock (lifecycleLock) return !disposed && started && !process.HasExited; } }
        public int Id { get { return process.Id; } }
        public void Start(string executable, string arguments, string workingDirectory)
        {
            process.StartInfo = new ProcessStartInfo(executable, arguments) {
                WorkingDirectory = workingDirectory, UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            };
            process.EnableRaisingEvents = true;
            process.OutputDataReceived += (s, e) => Publish(e.Data, true);
            process.ErrorDataReceived += (s, e) => Publish(e.Data, false);
            process.Exited += ProcessExited;
            try {
                process.Start(); started = true;
                job.Assign(process);
                process.BeginOutputReadLine(); process.BeginErrorReadLine();
                process.StandardInput.WriteLine("start"); process.StandardInput.Flush();
            } catch {
                job.Dispose();
                if (started) { try { if (!process.HasExited) process.Kill(); } catch { } }
                throw;
            }
        }
        private void ProcessExited(object sender, EventArgs args)
        {
            Action<int> handler;
            int exitCode;
            lock (lifecycleLock) {
                if (disposed) return;
                exitCode = process.ExitCode;
                handler = Exited;
            }
            job.Dispose(); // A root crash must also remove its owned descendants.
            if (handler != null) handler(exitCode);
        }
        internal void Publish(string line, bool stdout)
        {
            if (line == null || line.Length > 4096) return;
            if (line.Contains("\"desktopMessage\"")) {
                // Consume private replies before the diagnostic event surface.
                var reply = stdout ? PairingReply.Parse(line, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()) : null;
                var receiver = Pairing; if (reply != null && receiver != null) receiver(reply);
                return;
            }
            var handler = Line; if (handler != null) handler(line);
        }
        public void RequestPairing()
        {
            lock (lifecycleLock) {
                if (!IsRunning) throw new InvalidOperationException();
                process.StandardInput.WriteLine("pair"); process.StandardInput.Flush();
            }
        }
        public async Task StopAsync()
        {
            lock (lifecycleLock) {
                if (disposed || !started || process.HasExited) return;
                try { process.StandardInput.WriteLine("stop"); process.StandardInput.Flush(); }
                catch (InvalidOperationException) { }
                catch (System.IO.IOException) { } // The exiting child may already have closed its pipe.
            }
            try {
                bool exited = await Task.Run(() => process.WaitForExit(8000));
                if (!exited) { job.Dispose(); await Task.Run(() => process.WaitForExit(2000)); }
            } catch (InvalidOperationException) {
                // Closing the GUI may dispose the process while this wait is in flight.
                lock (lifecycleLock) { if (!disposed) throw; }
            }
        }
        public void Dispose()
        {
            lock (lifecycleLock) {
                if (disposed) return;
                disposed = true;
                process.Exited -= ProcessExited;
                job.Dispose();
                process.Dispose();
            }
        }
    }
}
