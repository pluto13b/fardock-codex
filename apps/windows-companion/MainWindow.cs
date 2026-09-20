using System;
using System.IO;
using System.Reflection;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Collections.Generic;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Markup;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Shapes;
using System.Windows.Shell;
using Forms = System.Windows.Forms;
using Drawing = System.Drawing;

namespace CodexPlusCompanion
{
    internal enum ServicePhase { Idle, Starting, Connected, Reconnecting, Stopping, Failed, Unavailable }
    internal sealed class MainWindow : Window
    {
        internal const string Version = "0.5.3";
        private readonly AppConfig config;
        private readonly StartupTask startup;
        private readonly bool preview, background;
        private readonly FrameworkElement view;
        private readonly Forms.NotifyIcon tray = new Forms.NotifyIcon();
        private OwnedProcess owned;
        private ServicePhase phase;
        private bool busy, stopping, exiting, legacy, startAtLogin, engineReady, readOnly, hostConnected, startupAllowed;
        private string failure;
        private bool prepared, revealRequested;
        private bool pairingBusy;
        private long pairingExpiresAt;
        private string pairingNotice;
        private readonly System.Windows.Threading.DispatcherTimer pairingTimer = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };

        public MainWindow(AppConfig config, bool preview = false, bool background = false)
        {
            this.config = config; this.preview = preview; this.background = background; startup = new StartupTask(config);
            Title = "Codex Plus Companion"; Width = 520; Height = 410; MinWidth = 480; MinHeight = 390;
            WindowStartupLocation = WindowStartupLocation.CenterScreen; WindowStyle = WindowStyle.None; ResizeMode = ResizeMode.CanMinimize;
            Background = new SolidColorBrush(Color.FromRgb(28, 28, 30));
            WindowChrome.SetWindowChrome(this, new WindowChrome { CaptionHeight = 34, ResizeBorderThickness = new Thickness(0), GlassFrameThickness = new Thickness(0), CornerRadius = new CornerRadius(12), UseAeroCaptionButtons = false });
            using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("CodexPlusCompanion.MainView.xaml")) { if (stream == null) throw new InvalidDataException("view-resource-missing"); view = (FrameworkElement)XamlReader.Load(stream); }
            Content = view;
            SourceInitialized += (s, e) => HwndSource.FromHwnd(new WindowInteropHelper(this).Handle).AddHook(HandleWindowMessage);
            using (var icon = BrandIcon()) Icon = System.Windows.Interop.Imaging.CreateBitmapSourceFromHIcon(icon.Handle, Int32Rect.Empty, BitmapSizeOptions.FromEmptyOptions());
            Get<Button>("ServiceButton").Click += async (s, e) => { if (owned == null) await StartAsync(); else await StopAsync(); };
            Get<Button>("PairingButton").Click += (s, e) => StartPairing();
            pairingTimer.Tick += (s, e) => RefreshPairingExpiry(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            Get<Button>("MinimizeButton").Click += (s, e) => SystemCommands.MinimizeWindow(this); Get<Button>("CloseButton").Click += (s, e) => Close();
            var menu = new Forms.ContextMenuStrip(); menu.Items.Add("显示服务状态", null, (s, e) => Reveal()); menu.Items.Add("退出并停止", null, async (s, e) => await ExitAsync());
            tray.Icon = BrandIcon(); tray.Text = "Codex Plus · 等待启动"; tray.ContextMenuStrip = menu; tray.Visible = !preview; tray.DoubleClick += (s, e) => Reveal();
            Loaded += async (s, e) => {
                if (preview || prepared) return;
                prepared = true;
                await PrepareAsync();
                if (background && startupAllowed) { if (!revealRequested) Hide(); await StartAsync(); }
            };
            Closing += (s, e) => { if (!exiting && !preview) { e.Cancel = true; Hide(); } };
            if (Application.Current != null) Application.Current.SessionEnding += (s, e) => exiting = true;
            Closed += (s, e) => { pairingTimer.Stop(); tray.Dispose(); if (owned != null) owned.Dispose(); };
            RenderState();
        }
        internal T Get<T>(string name) where T : FrameworkElement { return (T)view.FindName(name); }
        private void Text(string name, string value) { Get<TextBlock>(name).Text = value; }
        private void OnUi(Action action)
        {
            if (!exiting && !Dispatcher.HasShutdownStarted)
                Dispatcher.BeginInvoke(new Action(() => { if (!exiting) action(); }));
        }
        private IntPtr HandleWindowMessage(IntPtr window, int message, IntPtr wParam, IntPtr lParam, ref bool handled)
        {
            if (message == Program.RevealMessage && !exiting) { Reveal(); handled = true; }
            // A previous launcher can still use native ShowWindow. Repair only
            // the actual visible/managed-hidden mismatch, on the WPF dispatcher.
            if (message == 0x0018 && wParam != IntPtr.Zero && Visibility != Visibility.Visible && !exiting) {
                OnUi(() => { if (Program.IsWindowVisible(window) && Visibility != Visibility.Visible) Reveal(); });
            }
            return IntPtr.Zero;
        }
        private void RenderState()
        {
            string title = "等待启动", detail = "启动后，可在安卓浏览器中使用 Codex。", color = "#8E8E93";
            switch (phase) {
                case ServicePhase.Starting: title = "正在启动"; detail = "正在准备本机 Codex 服务和远程连接。"; color = "#64A8FF"; break;
                case ServicePhase.Connected:
                    title = !engineReady ? "正在准备 Codex" : readOnly ? "服务仅可读取" : "服务已就绪";
                    detail = pairingNotice ?? (!engineReady ? "远程通道已连接，等待 Codex 引擎就绪。" : readOnly ? "Codex 当前处于只读模式，暂不能发送任务。" : "首次连接请点“连接手机”，在手机网页输入配对码。");
                    color = engineReady && !readOnly ? "#64A8FF" : "#FFB340"; break;
                case ServicePhase.Reconnecting: title = "正在恢复连接"; detail = "网络暂时中断，后台会自动重连。"; color = "#FFB340"; break;
                case ServicePhase.Stopping: title = "正在停止"; detail = "正在关闭本机服务并保存状态。"; break;
                case ServicePhase.Failed: title = "服务未就绪"; detail = failure ?? "启动未成功，请确认软件与本机授权完整后重试。"; color = "#FF6961"; break;
                case ServicePhase.Unavailable: title = "本机配置未就绪"; detail = failure ?? "请使用原 Windows 用户和完整软件目录。"; color = "#FFB340"; break;
            }
            Text("StatusTitle", title); Text("StatusDescription", detail); Get<Ellipse>("StatusDot").Fill = new SolidColorBrush((Color)ColorConverter.ConvertFromString(color));
            Text("EngineValue", engineReady ? readOnly ? "只读" : "可用" : phase == ServicePhase.Starting || hostConnected ? "准备中" : "未启动");
            Text("GatewayValue", hostConnected ? "已连接" : phase == ServicePhase.Reconnecting ? "恢复中" : "未连接");
            var button = Get<Button>("ServiceButton"); bool running = owned != null || preview && (phase == ServicePhase.Connected || phase == ServicePhase.Reconnecting);
            string action = busy ? phase == ServicePhase.Stopping ? "正在停止…" : phase == ServicePhase.Starting ? "正在启动…" : "正在检查…" : running ? "停止服务" : phase == ServicePhase.Failed || phase == ServicePhase.Unavailable ? "重试启动" : "启动服务";
            button.Content = action; AutomationProperties.SetName(button, action); button.IsEnabled = !busy;
            button.Background = new SolidColorBrush(running ? Color.FromRgb(72, 72, 74) : Color.FromRgb(10, 132, 255)); tray.Text = "Codex Plus · " + title;
            var pairButton = Get<Button>("PairingButton");
            pairButton.Content = pairingBusy ? "正在生成…" : pairingExpiresAt > 0 ? "等待手机连接" : "连接手机";
            pairButton.IsEnabled = hostConnected && !busy && !pairingBusy && pairingExpiresAt == 0;
        }
        private void ClearPairing(string notice = null)
        {
            pairingBusy = false; pairingExpiresAt = 0; pairingNotice = notice; pairingTimer.Stop();
            Text("PairingCode", ""); Text("PairingExpiry", ""); Get<Border>("PairingPanel").Visibility = Visibility.Collapsed; Height = 410;
        }
        private void StartPairing()
        {
            if (preview || owned == null || !hostConnected || busy || pairingBusy || pairingExpiresAt != 0) return;
            pairingBusy = true; pairingNotice = "正在生成一次性配对码。"; RenderState();
            try { owned.RequestPairing(); } catch { ClearPairing("配对码生成失败，请重试。"); RenderState(); }
        }
        internal void ApplyPairing(PairingReply reply)
        {
            if (reply.State == "code") {
                if (!hostConnected || stopping) return;
                pairingBusy = false; pairingNotice = "在手机浏览器登录账户后，输入下方配对码。"; pairingExpiresAt = reply.ExpiresAt;
                Text("PairingCode", reply.Code.Substring(0, 4) + "  " + reply.Code.Substring(4));
                Get<Border>("PairingPanel").Visibility = Visibility.Visible; Height = 520;
                RefreshPairingExpiry(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()); if (pairingExpiresAt > 0) pairingTimer.Start();
            } else ClearPairing(reply.State == "paired" ? "设备已完成绑定，可在手机继续使用。" : reply.State == "failed" ? "配对码生成失败，请重试。" : null);
            RenderState();
        }
        internal void RefreshPairingExpiry(long now)
        {
            if (pairingExpiresAt <= now) { ClearPairing("配对码已过期，请重新生成。"); RenderState(); return; }
            var remaining = TimeSpan.FromMilliseconds(pairingExpiresAt - now);
            Text("PairingExpiry", "一次有效 · " + remaining.ToString(@"m\:ss") + " 后过期");
        }
        private async Task PrepareAsync()
        {
            busy = true; RenderState();
            try {
                failure = config.ReadinessProblem(); var state = await Task.Run(() => startup.Read()); legacy = state.Legacy; startAtLogin = state.Enabled;
                startupAllowed = failure == null; phase = startupAllowed ? ServicePhase.Idle : ServicePhase.Unavailable;
            } catch { startupAllowed = false; phase = ServicePhase.Unavailable; failure = "无法验证本机启动项，请使用原 Windows 用户运行。"; }
            finally { busy = false; RenderState(); }
        }
        internal static string StatusEvent(string line)
        {
            if (line == null || line.Length > 4096) return null;
            try {
                var data = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(line); object raw;
                if (data == null || !data.TryGetValue("event", out raw) || !(raw is string)) return null;
                switch ((string)raw) {
                    case "production.host_connected": case "production.reconnect_pending": case "production.failed_closed": case "production.app_server_failed": case "desktop.failed_closed": return (string)raw;
                    case "production.runtime_binding": object state; if (!data.TryGetValue("state", out state)) return null; return (state as string) == "write-bound" ? "binding.writable" : (state as string) == "read-only" ? "binding.readonly" : null;
                    default: return null;
                }
            } catch { return null; }
        }
        private void ApplyEvent(string value)
        {
            switch (value) {
                case "binding.writable": engineReady = true; readOnly = false; break;
                case "binding.readonly": engineReady = true; readOnly = true; break;
                case "production.host_connected": hostConnected = true; phase = ServicePhase.Connected; break;
                case "production.reconnect_pending": ClearPairing(); hostConnected = false; phase = ServicePhase.Reconnecting; break;
                case "production.app_server_failed": case "production.failed_closed": case "desktop.failed_closed": ClearPairing(); engineReady = hostConnected = false; phase = ServicePhase.Failed; break;
            }
            RenderState();
        }
        private async Task StartAsync()
        {
            if (preview || busy || owned != null) return;
            if (!startupAllowed) { await PrepareAsync(); if (!startupAllowed) return; }
            failure = config.ReadinessProblem(); if (failure != null) { phase = ServicePhase.Unavailable; RenderState(); return; }
            busy = true; phase = ServicePhase.Starting; engineReady = readOnly = hostConnected = false; RenderState();
            string step = "验证启动配置";
            try {
                var prior = await Task.Run(() => startup.Read()); startAtLogin = prior.Enabled;
                step = "切换旧本地服务";
                await Task.Run(() => startup.StopLegacy()); legacy = false;
                step = "保存启动配置";
                if (startAtLogin) await Task.Run(() => startup.SetEnabled(true));
                step = "启动本地服务进程";
                var child = new OwnedProcess(); owned = child;
                child.Line += line => { var value = StatusEvent(line); if (value != null) OnUi(() => { if (owned == child && !stopping) ApplyEvent(value); }); };
                child.Pairing += reply => OnUi(() => { if (owned == child && !stopping) ApplyPairing(reply); });
                child.Exited += code => OnUi(() => { if (owned != child || stopping) return; ClearPairing(); owned = null; child.Dispose(); engineReady = hostConnected = false; phase = code == 0 ? ServicePhase.Idle : ServicePhase.Failed; RenderState(); });
                child.Start(config.NodePath, config.BackendArguments(), config.Workspace);
            } catch { if (owned != null) { owned.Dispose(); owned = null; } phase = ServicePhase.Failed; engineReady = hostConnected = false; failure = step + "失败，请重试。"; }
            finally { busy = false; RenderState(); }
        }
        private async Task StopAsync()
        {
            if (preview || busy || owned == null && !legacy) return;
            ClearPairing();
            busy = stopping = true; phase = ServicePhase.Stopping; RenderState();
            try {
                var child = owned; if (child != null) { await child.StopAsync(); if (owned == child) owned = null; child.Dispose(); }
                else if (legacy) {
                    var prior = await Task.Run(() => startup.Read());
                    await Task.Run(() => startup.StopLegacy()); legacy = false;
                    if (prior.Enabled) await Task.Run(() => startup.SetEnabled(true));
                }
                engineReady = hostConnected = false; phase = ServicePhase.Idle; failure = null;
            } catch { phase = ServicePhase.Failed; failure = "停止操作未完成，请重试。"; }
            finally { busy = stopping = false; RenderState(); }
        }
        private async Task ExitAsync() { if (preview || busy) return; await StopAsync(); exiting = true; Close(); Application.Current.Shutdown(); }
        public void Reveal() { revealRequested = true; Show(); WindowState = WindowState.Normal; Activate(); }
        internal static Drawing.Icon BrandIcon()
        {
            var geometry = Geometry.Parse("M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71 M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71");
            var visual = new DrawingVisual(); using (var context = visual.RenderOpen()) {
                context.DrawRoundedRectangle(new SolidColorBrush(Color.FromRgb(10, 132, 255)), null, new Rect(0, 0, 64, 64), 16, 16);
                context.PushTransform(new TranslateTransform(10, 10)); context.PushTransform(new ScaleTransform(44D / 24, 44D / 24)); context.DrawGeometry(null, new Pen(Brushes.White, 1.8), geometry); context.Pop(); context.Pop();
            }
            var bitmap = new RenderTargetBitmap(64, 64, 96, 96, PixelFormats.Pbgra32); bitmap.Render(visual); var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(bitmap));
            using (var stream = new MemoryStream()) { encoder.Save(stream); stream.Position = 0; using (var image = new Drawing.Bitmap(stream)) { IntPtr handle = image.GetHicon(); try { return (Drawing.Icon)Drawing.Icon.FromHandle(handle).Clone(); } finally { DestroyIcon(handle); } } }
        }
        [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr icon);
        internal void PreviewState(string state)
        {
            if (!preview) throw new InvalidOperationException(); startupAllowed = true; busy = false; legacy = false; engineReady = readOnly = hostConnected = false; failure = null; phase = ServicePhase.Idle;
            if (state == "starting") { phase = ServicePhase.Starting; busy = true; }
            else if (state == "connected" || state == "reconnecting" || state == "readonly") { ApplyEvent(state == "readonly" ? "binding.readonly" : "binding.writable"); ApplyEvent("production.host_connected"); if (state == "reconnecting") ApplyEvent("production.reconnect_pending"); }
            else if (state == "failed") phase = ServicePhase.Failed;
            RenderState();
        }
        internal void PreviewEvent(string raw) { if (!preview) throw new InvalidOperationException(); var value = StatusEvent(raw); if (value != null) ApplyEvent(value); }
        internal void SavePreview(string path, double width, double height, double scale = 1)
        {
            if (!preview) throw new InvalidOperationException(); Width = width; Height = height; view.Measure(new Size(width, height)); view.Arrange(new Rect(0, 0, width, height)); view.UpdateLayout();
            var bitmap = new RenderTargetBitmap((int)(width * scale), (int)(height * scale), 96 * scale, 96 * scale, PixelFormats.Pbgra32); bitmap.Render(view);
            var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(bitmap)); using (var file = File.Create(path)) encoder.Save(file);
        }
    }
}
