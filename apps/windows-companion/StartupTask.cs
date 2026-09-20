using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Management;
using System.Security.Principal;
using System.Text.RegularExpressions;

namespace CodexPlusCompanion
{
    internal sealed class StartupState
    {
        public bool Exists, Legacy, Enabled;
    }
    internal sealed class StartupTask
    {
        private const string Name = "CodexPlusCompanion";
        private const string Description = "Codex Plus Windows Companion desktop application";
        private readonly AppConfig config;
        public StartupTask(AppConfig config) { this.config = config; }
        private dynamic Connect()
        {
            dynamic service = Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service"));
            service.Connect(); return service;
        }
        private dynamic Find(dynamic service)
        {
            try { return service.GetFolder("\\").GetTask(Name); }
            catch (System.Runtime.InteropServices.COMException e) {
                if ((uint)e.ErrorCode == 0x80070002 || (uint)e.ErrorCode == 0x8004130F) return null;
                throw;
            }
        }
        public static bool MatchesLegacyCommand(string commandLine, string workspace)
        {
            if (commandLine == null) return false;
            string runner = Path.Combine(workspace, "apps", "windows-agent", "src", "production-runner.ts");
            return Regex.IsMatch(commandLine.Replace('/', '\\'), "(?:^|[\\s\"])" + Regex.Escape(runner) + "(?=[\\s\"]|$)", RegexOptions.IgnoreCase);
        }
        public static bool MatchesCurrentUser(string user)
        {
            try {
                string sid = user.StartsWith("S-1-", StringComparison.Ordinal)
                    ? new SecurityIdentifier(user).Value
                    : ((SecurityIdentifier)new NTAccount(user).Translate(typeof(SecurityIdentifier))).Value;
                return sid == WindowsIdentity.GetCurrent().User.Value;
            } catch { return false; }
        }
        private bool Validate(dynamic task)
        {
            dynamic definition = task.Definition;
            string user = definition.Principal.UserId;
            if (!MatchesCurrentUser(user))
                throw new InvalidOperationException("该登录任务属于其他用户，未更改。");
            if (definition.Actions.Count != 1) throw new InvalidOperationException("登录任务与本软件不匹配，未更改。");
            dynamic action = definition.Actions.Item(1);
            string executable = Path.GetFullPath((string)action.Path);
            string arguments = action.Arguments;
            string launcher = Path.Combine(config.Workspace, "scripts", "start-windows-companion.ps1");
            string name = Path.GetFileName(executable);
            bool legacy = (name.Equals("powershell.exe", StringComparison.OrdinalIgnoreCase) || name.Equals("pwsh.exe", StringComparison.OrdinalIgnoreCase))
                && arguments.Equals("-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File " + AppConfig.Quote(launcher), StringComparison.OrdinalIgnoreCase);
            string workingDirectory = action.WorkingDirectory;
            bool desktop = name == "CodexPlusCompanion.exe" && arguments == "--background"
                && Path.GetFullPath(workingDirectory).TrimEnd('\\').Equals(config.Workspace, StringComparison.OrdinalIgnoreCase)
                && (string)definition.RegistrationInfo.Description == Description;
            if (!legacy && !desktop) throw new InvalidOperationException("登录任务与本软件不匹配，未更改。");
            return legacy;
        }
        public StartupState Read()
        {
            dynamic service = Connect(); dynamic task = Find(service);
            if (task == null) return new StartupState();
            return new StartupState { Exists = true, Legacy = Validate(task), Enabled = task.Enabled };
        }
        public void SetEnabled(bool enabled)
        {
            dynamic service = Connect(); dynamic existing = Find(service);
            if (existing != null) Validate(existing);
            if (!enabled) { if (existing != null) existing.Enabled = false; return; }
            dynamic definition = service.NewTask(0);
            string user = WindowsIdentity.GetCurrent().Name;
            definition.RegistrationInfo.Description = Description;
            definition.Principal.UserId = user; definition.Principal.LogonType = 3; definition.Principal.RunLevel = 0;
            definition.Settings.Enabled = true; definition.Settings.DisallowStartIfOnBatteries = false;
            definition.Settings.StopIfGoingOnBatteries = false; definition.Settings.ExecutionTimeLimit = "PT0S";
            definition.Settings.MultipleInstances = 2; definition.Settings.StartWhenAvailable = true;
            dynamic trigger = definition.Triggers.Create(9); trigger.UserId = user;
            dynamic action = definition.Actions.Create(0);
            action.Path = config.ExecutablePath; action.Arguments = "--background"; action.WorkingDirectory = config.Workspace;
            service.GetFolder("\\").RegisterTaskDefinition(Name, definition, 6, user, null, 3, null);
        }
        internal static bool CurrentUserOwnsProcess(ManagementObject process)
        {
            using (var owner = process.InvokeMethod("GetOwnerSid", null, null)) {
                return owner != null && Convert.ToUInt32(owner["ReturnValue"]) == 0
                    && (string)owner["Sid"] == WindowsIdentity.GetCurrent().User.Value;
            }
        }
        internal static ManagementObject BindProcess(int id)
        {
            var process = new ManagementObject("Win32_Process.Handle='" + id + "'");
            try { process.Get(); return process; } catch { process.Dispose(); throw; }
        }
        internal Dictionary<int, int> FindLegacyProcesses()
        {
            var matches = new Dictionary<int, int>();
            using (var search = new ManagementObjectSearcher("SELECT ProcessId,ParentProcessId,CommandLine FROM Win32_Process WHERE Name='node.exe' AND CommandLine LIKE '%production-runner.ts%'"))
            using (var results = search.Get()) foreach (ManagementObject projected in results) {
                using (projected) {
                    if (!MatchesLegacyCommand((string)projected["CommandLine"], config.Workspace)) continue;
                    // A projected WMI row has no instance path. Bind the PID
                    // before invoking methods, then validate the live instance.
                    int id = Convert.ToInt32(projected["ProcessId"]);
                    try {
                        using (var item = BindProcess(id)) {
                            if (!string.Equals((string)item["Name"], "node.exe", StringComparison.OrdinalIgnoreCase)
                                || !MatchesLegacyCommand((string)item["CommandLine"], config.Workspace)
                                || !CurrentUserOwnsProcess(item)) continue;
                            matches.Add(id, Convert.ToInt32(item["ParentProcessId"]));
                        }
                    } catch (ManagementException error) { if (error.ErrorCode != ManagementStatus.NotFound) throw; }
                }
            }
            return matches;
        }
        public void StopLegacy()
        {
            // Do not disable a working startup task if read-only discovery fails.
            var matches = FindLegacyProcesses();
            dynamic service = Connect(); dynamic task = Find(service);
            bool legacyTask = task != null && Validate(task);
            bool wasEnabled = legacyTask && (bool)task.Enabled;
            try {
            if (legacyTask) { task.Enabled = false; if (task.GetInstances(0).Count > 0) task.Stop(0); }
            foreach (var entry in matches) {
                if (matches.ContainsKey(entry.Value)) continue;
                // Revalidate the exact PID immediately before asking Windows to
                // stop its tree; never discover or terminate Codex App processes.
                ManagementObject instance;
                try { instance = BindProcess(entry.Key); } catch (ManagementException error) { if (error.ErrorCode == ManagementStatus.NotFound) continue; throw; }
                using (var item = instance) {
                    if (!string.Equals((string)item["Name"], "node.exe", StringComparison.OrdinalIgnoreCase)
                        || !MatchesLegacyCommand((string)item["CommandLine"], config.Workspace)
                        || !CurrentUserOwnsProcess(item)) continue;
                    using (var stop = Process.Start(new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "taskkill.exe"), "/PID " + entry.Key + " /T /F") {
                        UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
                    })) {
                        stop.BeginOutputReadLine(); stop.BeginErrorReadLine();
                        if (!stop.WaitForExit(5000)) { stop.Kill(); throw new InvalidOperationException("旧后台未能停止。"); }
                        if (stop.ExitCode != 0 && stop.ExitCode != 128) throw new InvalidOperationException("旧后台未能停止。");
                    }
                }
            }
            } catch { if (legacyTask && wasEnabled) { try { task.Enabled = true; } catch { } } throw; }
        }
    }
}
