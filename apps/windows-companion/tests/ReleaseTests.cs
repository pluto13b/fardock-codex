using System;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Collections.Generic;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Interop;
using System.Windows.Threading;
using CodexPlusCompanion;

internal static class ReleaseTests
{
    [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
    static int assertions;
    static void Check(bool value, string name) { if (!value) throw new Exception(name); assertions++; }
    static bool Gone(int id) { try { using (var p = Process.GetProcessById(id)) return p.HasExited; } catch (ArgumentException) { return true; } }
    static void Pump()
    {
        var frame = new DispatcherFrame();
        Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.ApplicationIdle, new Action(() => frame.Continue = false));
        Dispatcher.PushFrame(frame);
    }
    static async Task StopDisposeRace(string node, string script, string root)
    {
        for (int round = 0; round < 12; round++) {
            var ready = new TaskCompletionSource<bool>();
            using (var child = new OwnedProcess()) {
                child.Line += line => { if (line.Contains("testChild")) ready.TrySetResult(true); };
                child.Exited += code => { }; // Exercise the real exit notification path.
                child.Start(node, AppConfig.Quote(script) + " normal", root);
                if (await Task.WhenAny(ready.Task, Task.Delay(5000)) != ready.Task) throw new Exception("race-start-timeout");
                int id = child.Id;
                var stopping = child.StopAsync();
                child.Dispose(); child.Dispose();
                await stopping;
                for (int attempt = 0; attempt < 100 && !Gone(id); attempt++) await Task.Delay(20);
                Check(Gone(id), "stop-dispose-race-" + round);
            }
        }
    }
    static async Task ProcessTest(string node, string script, string root, bool crash)
    {
        int descendant = 0; var ready = new TaskCompletionSource<bool>();
        using (var child = new OwnedProcess()) {
            child.Line += line => { var row = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(line); if (row.ContainsKey("testChild")) { descendant = Convert.ToInt32(row["testChild"]); ready.TrySetResult(true); } };
            child.Start(node, AppConfig.Quote(script) + (crash ? " stuck" : " normal"), root);
            Check(await Task.WhenAny(ready.Task, Task.Delay(5000)) == ready.Task, "start-gate"); Check(!Gone(descendant), "descendant-created");
            if (crash) child.Dispose(); else await child.StopAsync();
            for (int i = 0; i < 100 && !Gone(descendant); i++) await Task.Delay(20);
            Check(Gone(descendant), crash ? "job-close" : "graceful-stop");
        }
    }
    [STAThread] static int Main(string[] args)
    {
        try {
            if (args[0] == "icon") { using (var icon = MainWindow.BrandIcon()) using (var file = File.Create(args[1])) icon.Save(file); return 0; }
            if (args[0] == "reveal") return Program.RequestReveal(new IntPtr(Int64.Parse(args[1]))) ? 0 : 1;
            if (args[0] == "inspect") { var state = new StartupTask(AppConfig.Load(args[1])).Read(); Console.WriteLine("Existing startup task: exists=" + state.Exists + " legacy=" + state.Legacy + " enabled=" + state.Enabled); return 0; }
            string release = Path.GetFullPath(args[1]), root = Path.GetFullPath(args[2]), script = Path.GetFullPath(args[3]); Directory.CreateDirectory(root);
            string node = Path.Combine(release, "runtime", "node.exe");
            Check(MainWindow.StatusEvent("{\"event\":\"production.host_connected\",\"password\":\"DO_NOT_DISPLAY\"}") == "production.host_connected", "static-status-only");
            Check(MainWindow.StatusEvent("{\"event\":\"production.pairing_confirmation_required\",\"sas\":\"DO_NOT_DISPLAY\"}") == null, "secret-events-hidden");
            Check(MainWindow.StatusEvent("unknown raw output DO_NOT_DISPLAY") == null, "unknown-output-hidden");
            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            string codeReply = "{\"desktopMessage\":\"pairing\",\"state\":\"code\",\"code\":\"23456789\",\"expiresAt\":" + (now + 300000) + "}";
            Check(PairingReply.Parse(codeReply, now) != null, "private-code-reply");
            Check(PairingReply.Parse(codeReply, now + 300001) == null, "expired-code-rejected");
            Check(PairingReply.Parse(codeReply.Replace("23456789", "I2345678"), now) == null, "invalid-code-rejected");
            Check(PairingReply.Parse(codeReply.Replace("\"state\"", "\"extra\":1,\"state\""), now) == null, "private-reply-extra-fields-rejected");
            using (var pipe = new OwnedProcess()) {
                int diagnostics = 0, replies = 0; pipe.Line += line => diagnostics++; pipe.Pairing += reply => replies++;
                pipe.Publish(codeReply, true); pipe.Publish(codeReply, false);
                Check(replies == 1 && diagnostics == 0, "code-never-enters-diagnostics");
            }
            string workspace = Path.Combine(root, "workspace with spaces"); Directory.CreateDirectory(workspace);
            string runner = Path.Combine(workspace, "apps", "windows-agent", "src", "production-runner.ts");
            Check(StartupTask.MatchesLegacyCommand("node tsx " + AppConfig.Quote(runner), workspace), "exact-legacy-path");
            Check(!StartupTask.MatchesLegacyCommand("node tsx " + AppConfig.Quote(runner + ".other"), workspace), "reject-suffix");
            Check(!StartupTask.MatchesLegacyCommand("codex.exe app-server", workspace), "never-match-codex-app");
            Check(StartupTask.MatchesCurrentUser(System.Security.Principal.WindowsIdentity.GetCurrent().Name), "current-account-name");
            Check(!StartupTask.MatchesCurrentUser("S-1-5-18"), "reject-other-principal");
            ProcessTest(node, script, root, false).GetAwaiter().GetResult(); ProcessTest(node, script, root, true).GetAwaiter().GetResult();
            StopDisposeRace(node, script, root).GetAwaiter().GetResult();
            var config = new AppConfig(release, workspace, "https://gateway.example.com"); Check(config.ReadinessProblem() != null, "missing-identity-fails-closed");
            // Real WMI discovery, using only a synthetic Node with a test-only
            // entry label. No production task or process is stopped here.
            using (var legacy = Process.Start(new ProcessStartInfo(node, "-e \"setInterval(()=>{},1000)\" " + AppConfig.Quote(runner)) { UseShellExecute = false, CreateNoWindow = true })) {
                try {
                    var found = new StartupTask(config).FindLegacyProcesses();
                    Check(found.ContainsKey(legacy.Id), "projected-wmi-rebound-to-instance");
                    using (var bound = StartupTask.BindProcess(legacy.Id)) Check(StartupTask.CurrentUserOwnsProcess(bound), "bound-process-owner");
                    Check(!legacy.HasExited, "discovery-does-not-stop-service");
                } finally { if (!legacy.HasExited) { legacy.Kill(); legacy.WaitForExit(2000); } }
            }
            var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
            var window = new MainWindow(config, true);
            window.PreviewState("idle"); window.SavePreview(Path.Combine(root,"service-idle.png"), 520, 410);
            Check(window.Get<Button>("ServiceButton").IsEnabled && (string)window.Get<Button>("ServiceButton").Content == "启动服务", "single-start-action");
            Check(window.Get<Grid>("SettingsPage") == null && window.Get<Grid>("ActivityPage") == null, "no-management-pages");
            Check(window.Get<Button>("WorkbenchButton") == null && window.Get<Button>("ManageButton") == null, "no-business-entrypoints");
            window.PreviewEvent("{\"event\":\"production.host_connected\"}");
            Check(window.Get<TextBlock>("StatusTitle").Text != "服务已就绪", "gateway-alone-not-ready");
            Check(window.Get<TextBlock>("EngineValue").Text == "准备中", "engine-confirmation-required");
            window.PreviewEvent("{\"event\":\"production.runtime_binding\",\"state\":\"write-bound\"}");
            Check(window.Get<TextBlock>("StatusTitle").Text == "服务已就绪", "engine-and-host-ready");
            window.SavePreview(Path.Combine(root,"service-ready.png"), 520, 410);
            Check((string)window.Get<Button>("ServiceButton").Content == "停止服务", "single-stop-action");
            Check(window.Get<Button>("PairingButton").IsEnabled, "local-pairing-enabled-when-connected");
            window.WindowStartupLocation = WindowStartupLocation.Manual; window.Left = -10000; window.Top = -10000; window.ShowActivated = false; window.ShowInTaskbar = false;
            window.Show(); Pump();
            for (int round = 0; round < 3; round++) {
                window.Hide(); Pump();
                Check(!window.IsVisible && !window.Get<Button>("ServiceButton").IsVisible, "wpf-hidden-" + round);
                var handle = new WindowInteropHelper(window).Handle;
                using (var reveal = Process.Start(new ProcessStartInfo(System.Reflection.Assembly.GetExecutingAssembly().Location, "reveal " + handle.ToInt64()) { UseShellExecute = false, CreateNoWindow = true })) {
                    if (!reveal.WaitForExit(3000) || reveal.ExitCode != 0) throw new Exception("reveal-helper-failed");
                }
                Pump();
                Check(window.IsVisible && window.Get<Button>("ServiceButton").IsVisible && window.Get<Button>("PairingButton").IsVisible, "wpf-content-restored-" + round);
                Check(window.Get<TextBlock>("StatusTitle").Text == "服务已就绪", "reveal-retains-service-state-" + round);
                window.Hide(); Pump();
                ShowWindow(handle, 9); Pump();
                Check(window.IsVisible && window.Get<Button>("ServiceButton").IsVisible, "previous-launcher-reveal-" + round);
            }
            window.ApplyPairing(PairingReply.Parse(codeReply, now));
            window.SavePreview(Path.Combine(root,"phone-pairing.png"), 520, 520);
            Check(!window.Get<Button>("PairingButton").IsEnabled && window.Get<Border>("PairingPanel").Visibility == Visibility.Visible, "one-active-code");
            window.ApplyPairing(new PairingReply { State = "paired" });
            Check(window.Get<TextBlock>("PairingCode").Text == "" && window.Get<Button>("PairingButton").IsEnabled, "paired-clears-code");
            window.ApplyPairing(PairingReply.Parse(codeReply, now)); window.RefreshPairingExpiry(now + 300001);
            Check(window.Get<TextBlock>("PairingCode").Text == "" && window.Get<Border>("PairingPanel").Visibility == Visibility.Collapsed, "expiry-clears-code");
            window.ApplyPairing(PairingReply.Parse(codeReply, now)); window.PreviewEvent("{\"event\":\"production.reconnect_pending\"}");
            Check(window.Get<TextBlock>("PairingCode").Text == "" && !window.Get<Button>("PairingButton").IsEnabled, "disconnect-clears-code");
            window.PreviewState("readonly"); window.SavePreview(Path.Combine(root,"service-readonly.png"), 520, 410);
            Check(window.Get<TextBlock>("StatusTitle").Text == "服务仅可读取", "readonly-not-writable");
            window.PreviewState("reconnecting"); window.SavePreview(Path.Combine(root,"service-reconnecting.png"), 520, 410);
            Check(window.Get<TextBlock>("EngineValue").Text == "可用" && window.Get<TextBlock>("GatewayValue").Text == "恢复中", "local-vs-remote-state");
            window.PreviewState("starting"); Check(!window.Get<Button>("ServiceButton").IsEnabled, "busy-action-disabled");
            window.PreviewState("failed"); window.SavePreview(Path.Combine(root,"service-failed.png"), 520, 410);
            Check((string)window.Get<Button>("ServiceButton").Content == "重试启动", "retry-without-extra-panel");
            window.PreviewState("idle"); window.SavePreview(Path.Combine(root,"service-compact.png"), 480, 390);
            Check(window.Get<Button>("ServiceButton").ActualHeight >= 36, "compact-action-size");
            window.SavePreview(Path.Combine(root,"service-150.png"), 520, 410, 1.5);
            window.Close(); app.Shutdown();
            using (var stream = File.OpenRead(Path.Combine(release,"CodexPlusCompanion.exe"))) using (var reader = new BinaryReader(stream)) { stream.Position = 0x3c; int pe = reader.ReadInt32(); stream.Position = pe + 24 + 68; Check(reader.ReadUInt16() == 2, "gui-subsystem"); }
            Console.WriteLine("Desktop release tests passed: " + assertions); return 0;
        } catch (Exception error) { Console.Error.WriteLine(error.ToString()); return 1; }
    }
}
