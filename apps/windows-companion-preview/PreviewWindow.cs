using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;
using System.Windows.Shapes;
using System.Windows.Shell;
using System.Windows.Threading;

namespace CodexPlusUiPreview
{
    internal enum PreviewScene { Idle, Connecting, Ready, Reconnecting }

    // Presentation and local simulation only. No service/config/network dependencies.
    internal sealed class PreviewWindow : Window
    {
        internal const double BaseHeight = 500, PairHeight = 142;
        readonly FrameworkElement view;
        internal readonly ConnectionSculpture Sculpture;
        internal readonly SpatialBackdrop Backdrop;
        readonly List<DispatcherTimer> timers = new List<DispatcherTimer>();
        readonly SolidColorBrush dot = new SolidColorBrush(), glow = new SolidColorBrush(), divider = new SolidColorBrush();
        readonly SolidColorBrush glassEdge = new SolidColorBrush(Color.FromRgb(116, 138, 155));
        readonly SolidColorBrush buttonEdge = new SolidColorBrush();
        readonly Stopwatch pointerClock = Stopwatch.StartNew();
        readonly List<Action> resetButtons = new List<Action>();
        long lastPointerFrame = -1, lastBackdropPointerFrame = -1;
        int simulationRevision;
        bool reduced, pairOpen, closed, demoPlaying, hoveringSculpture;
        PreviewScene scene;
        internal PreviewScene Scene { get { return scene; } }
        internal bool PairOpen { get { return pairOpen; } }
        internal bool Reduced { get { return reduced; } }
        internal int PendingTimers { get { return timers.Count; } }

        internal PreviewWindow()
        {
            Title = "Codex Plus · 动效预览（模拟）";
            Width = 740; Height = BaseHeight; MinWidth = 700; MinHeight = BaseHeight;
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
            WindowStyle = WindowStyle.None; ResizeMode = ResizeMode.CanMinimize;
            Background = new SolidColorBrush(Color.FromRgb(27, 28, 32));
            WindowChrome.SetWindowChrome(this, new WindowChrome { CaptionHeight = 34, CornerRadius = new CornerRadius(14), ResizeBorderThickness = new Thickness(0), GlassFrameThickness = new Thickness(0), UseAeroCaptionButtons = false });
            using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("PreviewView.xaml")) {
                if (stream == null) throw new InvalidDataException("preview-view-missing");
                view = (FrameworkElement)XamlReader.Load(stream);
            }
            Content = view;
            Get<Ellipse>("StatusDot").Fill = dot;
            Get<Ellipse>("StatusGlow").Fill = glow;
            Get<Grid>("Divider").Background = divider;
            Get<Button>("ServiceButton").BorderBrush = buttonEdge;
            Sculpture = new ConnectionSculpture(Get<Viewport3D>("SculptureViewport"), Get<Grid>("PlateArtwork"), Get<LinearGradientBrush>("GlassSurface"), glassEdge, Get<TranslateTransform>("GlassScanY"));
            Backdrop = new SpatialBackdrop(Get<Viewport3D>("BackgroundViewport"));
            for (int index = 0; index < 8; index++) {
                var slot = new TextBlock { Text = "•", FontSize = 29, FontFamily = new FontFamily("Consolas"), Margin = new Thickness(index == 4 ? 12 : 2, 0, 2, 0), RenderTransform = new TranslateTransform() };
                Get<StackPanel>("CodeSlots").Children.Add(slot);
            }
            foreach (string name in new[] { "ServiceButton", "PairingButton", "ReplayButton", "DisconnectButton", "ReducedButton" }) WireButton(Get<Button>(name));
            Get<Button>("ServiceButton").Click += (s, e) => ToggleService();
            Get<Button>("PairingButton").Click += (s, e) => { CancelSimulation(); SetPairing(!pairOpen, true); };
            Get<Button>("ReplayButton").Click += (s, e) => { if (demoPlaying) CancelSimulation(); else PlayDemo(); };
            Get<Button>("DisconnectButton").Click += (s, e) => { CancelSimulation(); SetScene(scene == PreviewScene.Ready ? PreviewScene.Reconnecting : PreviewScene.Ready, true); };
            Get<Button>("ReducedButton").Click += (s, e) => SetReduced(!reduced);
            Get<Button>("MinimizeButton").Click += (s, e) => SystemCommands.MinimizeWindow(this);
            Get<Button>("CloseButton").Click += (s, e) => Close();
            Get<Grid>("SculptureDeck").MouseMove += (s, e) => {
                long frame = (long)(pointerClock.Elapsed.TotalSeconds * Motion.FramesPerSecond);
                if (reduced || frame == lastPointerFrame) return;
                lastPointerFrame = frame;
                var deck = Get<Grid>("SculptureDeck"); var point = e.GetPosition(deck);
                SetParallax(Math.Max(-1, Math.Min(1, point.X / Math.Max(1, deck.ActualWidth) * 2 - 1)), Math.Max(-1, Math.Min(1, point.Y / Math.Max(1, deck.ActualHeight) * 2 - 1)), true);
            };
            Get<Grid>("SculptureDeck").MouseEnter += (s, e) => Sculpture.SetEngaged(!reduced, reduced);
            Get<Grid>("SculptureDeck").MouseLeave += (s, e) => { Sculpture.SetEngaged(false, reduced); SetParallax(0, 0, true); };
            view.MouseMove += (s, e) => {
                long frame = (long)(pointerClock.Elapsed.TotalSeconds * Motion.FramesPerSecond);
                if (reduced || frame == lastBackdropPointerFrame) return;
                lastBackdropPointerFrame = frame;
                var point = e.GetPosition(view);
                Backdrop.SetPointer(point.X / Math.Max(1, view.ActualWidth) * 2 - 1, point.Y / Math.Max(1, view.ActualHeight) * 2 - 1, false);
            };
            view.MouseLeave += (s, e) => Backdrop.SetPointer(0, 0, false);
            Loaded += (s, e) => {
                Motion.From(Get<Grid>("Entrance"), UIElement.OpacityProperty, 0, 1, 340, reduced);
                Motion.From(Get<TranslateTransform>("EntranceY"), TranslateTransform.YProperty, 10, 0, 420, reduced);
                StartAmbient();
            };
            StateChanged += (s, e) => {
                Sculpture.SetActive(IsVisible && WindowState != WindowState.Minimized);
                Backdrop.SetActive(IsVisible && WindowState != WindowState.Minimized);
                if (WindowState == WindowState.Minimized) { CancelSimulation(); StopAmbient(); ResetImpact(true); SetParallax(0, 0, false); }
                else StartAmbient();
            };
            IsVisibleChanged += (s, e) => { Sculpture.SetActive(IsVisible && WindowState != WindowState.Minimized); Backdrop.SetActive(IsVisible && WindowState != WindowState.Minimized); if (IsVisible) StartAmbient(); else { CancelSimulation(); StopAmbient(); ResetImpact(true); } };
            Closed += (s, e) => { closed = true; CancelSimulation(); StopAmbient(); ResetImpact(true); Sculpture.Dispose(); Backdrop.Dispose(); };
            reduced = !SystemParameters.ClientAreaAnimation;
            Backdrop.SetMotionEnabled(!reduced);
            SetScene(PreviewScene.Idle, false);
            UpdateReducedLabel();
        }

        internal T Get<T>(string name) where T : class { return view.FindName(name) as T; }
        static Color Rgb(string color) { return (Color)ColorConverter.ConvertFromString(color); }

        internal void SetScene(PreviewScene next, bool animate)
        {
            StopAmbient();
            scene = next;
            bool connected = scene == PreviewScene.Ready, quiet = reduced || !animate;
            string title, detail, engine, gateway;
            switch (scene) {
                case PreviewScene.Connecting: title = "正在连接"; detail = "正在准备本机服务与远程通道。"; engine = "准备中"; gateway = "连接中"; break;
                case PreviewScene.Ready: title = "服务已就绪"; detail = "可在安卓浏览器中使用本机 Codex。"; engine = "可用"; gateway = "已连接"; break;
                case PreviewScene.Reconnecting: title = "正在恢复连接"; detail = "连接暂时中断，正在等待恢复。"; engine = "可用"; gateway = "恢复中"; break;
                default: title = "等待启动"; detail = "启动后，可在安卓浏览器中使用 Codex。"; engine = "未启动"; gateway = "未连接"; break;
            }
            var status = Get<TextBlock>("StatusTitle"); bool changed = status.Text != title;
            status.Text = title;
            Get<TextBlock>("StatusDescription").Text = detail;
            Get<TextBlock>("EngineValue").Text = engine;
            Get<TextBlock>("GatewayValue").Text = gateway;
            if (changed || quiet) {
                Motion.From(status, UIElement.OpacityProperty, 0, 1, 220, quiet);
                Motion.From(Get<TranslateTransform>("TitleY"), TranslateTransform.YProperty, 8, 0, 260, quiet);
                Motion.From(Get<TextBlock>("StatusDescription"), UIElement.OpacityProperty, .35, 1, 300, quiet);
            }
            SetTheme(quiet, connected && changed && !quiet ? 85 : 0);
            Sculpture.SetConnected(connected, quiet || !changed);
            if (connected && changed && !quiet) SnapTogether();
            else {
                double gap = connected ? 0 : 2.6;
                Motion.To(Get<TranslateTransform>("LinkUpper"), TranslateTransform.XProperty, gap, 300, quiet);
                Motion.To(Get<TranslateTransform>("LinkUpper"), TranslateTransform.YProperty, -gap, 300, quiet);
                Motion.To(Get<TranslateTransform>("LinkLower"), TranslateTransform.XProperty, -gap, 300, quiet);
                Motion.To(Get<TranslateTransform>("LinkLower"), TranslateTransform.YProperty, gap, 300, quiet);
                if (quiet || !connected) ResetImpact(quiet);
            }
            bool running = next == PreviewScene.Ready || next == PreviewScene.Reconnecting;
            var service = Get<Button>("ServiceButton");
            service.Content = next == PreviewScene.Connecting ? "正在启动…" : running ? "停止服务" : "启动服务";
            service.IsEnabled = next != PreviewScene.Connecting;
            Get<Button>("PairingButton").IsEnabled = connected;
            Get<Button>("DisconnectButton").Content = connected ? "断线演示" : "连接演示";
            if (!connected) SetPairing(false, animate);
            Backdrop.SetState(connected, quiet, connected && changed && !quiet);
            if (quiet) Sculpture.RefreshMaterial();
            StartAmbient();
        }

        void TintGradient(string name, string[] colors, bool quiet, int duration, int delay)
        {
            var stops = Get<LinearGradientBrush>(name).GradientStops;
            for (int index = 0; index < stops.Count; index++) Motion.ColorTo(stops[index], GradientStop.ColorProperty, Rgb(colors[index]), quiet, duration, delay);
        }
        Color EdgeColor()
        {
            return Rgb(scene == PreviewScene.Ready ? (hoveringSculpture ? "#BBA4C7DF" : "#8570899C") : (hoveringSculpture ? "#BBD9C49A" : "#85A49678"));
        }
        void SetTheme(bool quiet, int delay)
        {
            bool connected = scene == PreviewScene.Ready;
            bool running = connected || scene == PreviewScene.Reconnecting;
            int duration = connected ? 170 : 290;
            TintGradient("WindowSurface", connected ? new[] { "#29343B", "#272D34", "#22272E" } : new[] { "#34322C", "#2C2D2B", "#23292C" }, quiet, duration, delay);
            TintGradient("GlassSurface", connected ? new[] { "#D2DBE0", "#ABB9C1", "#969FAA" } : new[] { "#D7D2C4", "#B8B3A3", "#A59E8C" }, quiet, duration, delay);
            TintGradient("IconSurface", connected ? new[] { "#BACFD9", "#96B4C5", "#8798AE" } : new[] { "#DFD5BB", "#C9BE9D", "#ACA187" }, quiet, duration, delay);
            TintGradient("PairSurface", connected ? new[] { "#8DA8B6", "#8C9FB3", "#929BAB" } : new[] { "#CFC5AA", "#BEB498", "#A9A086" }, quiet, duration, delay);
            TintGradient("ServiceSurface", running ? (connected ? new[] { "#4E5964", "#444E5B", "#3D4550" } : new[] { "#605D51", "#535146", "#45463F" }) : new[] { "#D4CCB4", "#C6BEA4", "#B2AA92" }, quiet, duration, delay);
            Motion.ColorTo(dot, Rgb(connected ? "#B1C9D5" : "#D4C69F"), quiet, duration, delay);
            Motion.ColorTo(glow, Rgb(connected ? "#99B7C9" : "#C1B18A"), quiet, duration, delay);
            Motion.ColorTo(glassEdge, EdgeColor(), quiet, duration, delay);
            Motion.ColorTo(buttonEdge, Rgb(connected ? "#778C9D" : "#A69C81"), quiet, duration, delay);
            Motion.ColorTo(divider, Rgb(connected ? "#4B5964" : "#605E51"), quiet, duration, delay);
            Get<Button>("ServiceButton").Foreground = new SolidColorBrush(Rgb(running ? "#F2F3F6" : "#251F16"));
            Get<Button>("PairingButton").Foreground = new SolidColorBrush(Rgb("#D7E0E9"));
        }

        void SnapAxis(TranslateTransform part, DependencyProperty property, double direction)
        {
            double current = (double)part.GetValue(property);
            Motion.Frames(part, property, new[] { 0, 80, 145, 220, 310, 430 }, new[] { current, current + direction, -.75 * direction, .32 * direction, -.10 * direction, 0 });
        }
        void SnapTogether()
        {
            SnapAxis(Get<TranslateTransform>("LinkUpper"), TranslateTransform.XProperty, 1);
            SnapAxis(Get<TranslateTransform>("LinkUpper"), TranslateTransform.YProperty, -1);
            SnapAxis(Get<TranslateTransform>("LinkLower"), TranslateTransform.XProperty, -1);
            SnapAxis(Get<TranslateTransform>("LinkLower"), TranslateTransform.YProperty, 1);
            var timing = new[] { 0, 85, 150, 230, 345, 500 };
            var link = Get<ScaleTransform>("LinkScale");
            Motion.Frames(link, ScaleTransform.ScaleXProperty, timing, new[] { link.ScaleX, .88, 1.18, .95, 1.035, 1 });
            Motion.Frames(link, ScaleTransform.ScaleYProperty, timing, new[] { link.ScaleY, .95, 1.12, .97, 1.025, 1 });
            var tilt = Get<RotateTransform>("LinkTilt");
            Motion.Frames(tilt, RotateTransform.AngleProperty, timing, new[] { tilt.Angle, -7, 4, -2, 1, 0 });
            var deck = Get<ScaleTransform>("DeckScale");
            Motion.Frames(deck, ScaleTransform.ScaleXProperty, timing, new[] { deck.ScaleX, 1, .989, 1.012, .998, 1 });
            Motion.Frames(deck, ScaleTransform.ScaleYProperty, timing, new[] { deck.ScaleY, 1, .985, 1.012, .998, 1 });
            var kick = Get<TranslateTransform>("DeckKick");
            Motion.Frames(kick, TranslateTransform.YProperty, timing, new[] { kick.Y, 0, 2.4, -1.5, .6, 0 });
            Motion.Frames(Get<Border>("LinkFlash"), UIElement.OpacityProperty, new[] { 0, 130, 155, 330 }, new[] { 0.0, 0, .32, 0 });
            Motion.Frames(Get<Ellipse>("LinkHalo"), UIElement.OpacityProperty, new[] { 0, 135, 165, 610 }, new[] { 0.0, 0, .55, 0 });
            var halo = Get<ScaleTransform>("HaloScale");
            Motion.Frames(halo, ScaleTransform.ScaleXProperty, new[] { 0, 135, 450, 610 }, new[] { .8, .8, 2.15, 2.45 });
            Motion.Frames(halo, ScaleTransform.ScaleYProperty, new[] { 0, 135, 450, 610 }, new[] { .8, .8, 2.15, 2.45 });
            // The material's clearing front reads this same displayed position.
            Motion.From(Get<TranslateTransform>("GlassScanY"), TranslateTransform.YProperty, -45, 330, 780, false, 170);
            Motion.Frames(Get<System.Windows.Shapes.Path>("GlassScanLine"), UIElement.OpacityProperty, new[] { 0, 170, 250, 760, 950 }, new[] { 0.0, 0, .68, .5, 0 });
            Sweep(145);
        }
        void ResetImpact(bool quiet)
        {
            foreach (string name in new[] { "LinkScale", "DeckScale", "HaloScale" }) {
                Motion.To(Get<ScaleTransform>(name), ScaleTransform.ScaleXProperty, 1, 100, quiet);
                Motion.To(Get<ScaleTransform>(name), ScaleTransform.ScaleYProperty, 1, 100, quiet);
            }
            Motion.To(Get<RotateTransform>("LinkTilt"), RotateTransform.AngleProperty, 0, 100, quiet);
            Motion.To(Get<TranslateTransform>("DeckKick"), TranslateTransform.YProperty, 0, 100, quiet);
            Motion.To(Get<Border>("LinkFlash"), UIElement.OpacityProperty, 0, 80, quiet);
            Motion.To(Get<Ellipse>("LinkHalo"), UIElement.OpacityProperty, 0, 80, quiet);
            Motion.To(Get<Rectangle>("Glint"), UIElement.OpacityProperty, 0, 80, quiet);
            Motion.To(Get<TranslateTransform>("GlintX"), TranslateTransform.XProperty, -100, 0, true);
            Motion.To(Get<System.Windows.Shapes.Path>("GlassScanLine"), UIElement.OpacityProperty, 0, 0, true);
            Motion.To(Get<TranslateTransform>("GlassScanY"), TranslateTransform.YProperty, 330, 0, true);
        }

        internal void SetPairing(bool open, bool animate)
        {
            pairOpen = open && scene == PreviewScene.Ready;
            bool quiet = reduced || !animate;
            Sculpture.SetPairing(pairOpen, quiet);
            Motion.To(Get<Grid>("PairingReveal"), FrameworkElement.HeightProperty, pairOpen ? PairHeight : 0, 340, quiet);
            Motion.To(Get<Grid>("PairingReveal"), UIElement.OpacityProperty, pairOpen ? 1 : 0, pairOpen ? 240 : 150, quiet);
            foreach (string name in new[] { "PairTopScale", "PairBottomScale" }) {
                var line = Get<ScaleTransform>(name);
                int delay = pairOpen && line.ScaleX < .01 ? 180 : 0;
                Motion.From(line, ScaleTransform.ScaleXProperty, line.ScaleX, pairOpen ? 1 : 0, pairOpen ? 440 : 190, quiet, delay);
            }
            var sheet = Get<Border>("PairingSheet");
            Motion.From(sheet, UIElement.OpacityProperty, sheet.Opacity, pairOpen ? 1 : 0, pairOpen ? 220 : 120, quiet, pairOpen && sheet.Opacity < .01 ? 170 : 0);
            Motion.To(Get<TranslateTransform>("PairingY"), TranslateTransform.YProperty, pairOpen ? 0 : 8, 340, quiet);
            Motion.To(this, FrameworkElement.HeightProperty, BaseHeight + (pairOpen ? PairHeight : 0), 340, quiet);
            Get<Button>("PairingButton").Content = pairOpen ? "收起示意" : "连接手机";
            if (pairOpen) {
                int index = 0;
                foreach (TextBlock slot in Get<StackPanel>("CodeSlots").Children) {
                    Motion.From(slot, UIElement.OpacityProperty, 0, 1, 200, quiet, 190 + index * 32);
                    Motion.From((TranslateTransform)slot.RenderTransform, TranslateTransform.YProperty, 6, 0, 240, quiet, 190 + index++ * 32);
                }
                if (!quiet) Sweep();
            }
        }

        internal void ToggleService()
        {
            CancelSimulation();
            if (scene == PreviewScene.Idle) { SetScene(PreviewScene.Connecting, true); Schedule(1700, () => SetScene(PreviewScene.Ready, true)); }
            else SetScene(PreviewScene.Idle, true);
        }
        internal void PlayDemo()
        {
            CancelSimulation(); demoPlaying = true; Get<Button>("ReplayButton").Content = "停止演示";
            SetScene(PreviewScene.Idle, true);
            Schedule(700, () => SetScene(PreviewScene.Connecting, true));
            Schedule(2300, () => SetScene(PreviewScene.Ready, true));
            Schedule(3800, () => SetPairing(true, true));
            Schedule(5800, () => SetPairing(false, true));
            Schedule(6800, () => SetScene(PreviewScene.Reconnecting, true));
            Schedule(9000, () => { SetScene(PreviewScene.Ready, true); demoPlaying = false; Get<Button>("ReplayButton").Content = "播放演示"; });
        }
        void Schedule(int milliseconds, Action action)
        {
            int revision = simulationRevision;
            var timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(milliseconds) };
            timer.Tick += (s, e) => { timer.Stop(); timers.Remove(timer); if (!closed && revision == simulationRevision) action(); };
            timers.Add(timer); timer.Start();
        }
        internal void CancelSimulation()
        {
            simulationRevision++; foreach (var timer in timers) timer.Stop(); timers.Clear(); demoPlaying = false;
            Get<Button>("ReplayButton").Content = "播放演示";
        }
        internal void SetReduced(bool value)
        {
            reduced = value;
            Backdrop.SetMotionEnabled(!value);
            if (value) {
                Motion.To(Get<Grid>("Entrance"), UIElement.OpacityProperty, 1, 0, true);
                Motion.To(Get<TranslateTransform>("EntranceY"), TranslateTransform.YProperty, 0, 0, true);
                Motion.To(Get<Rectangle>("Glint"), UIElement.OpacityProperty, 0, 0, true);
            }
            SetScene(scene, false); SetPairing(pairOpen, false); SetParallax(0, 0, false);
            Sculpture.SetEngaged(false, true);
            foreach (var reset in resetButtons) reset();
            UpdateReducedLabel(); StartAmbient();
        }
        void UpdateReducedLabel() { Get<Button>("ReducedButton").Content = reduced ? "启用动效" : "减少动态"; }
        void StartAmbient()
        {
            StopAmbient();
            if (closed || reduced || !IsVisible || WindowState == WindowState.Minimized || scene == PreviewScene.Ready) return;
            var pulse = new DoubleAnimation(.10, .32, TimeSpan.FromMilliseconds(1300)) { AutoReverse = true, RepeatBehavior = RepeatBehavior.Forever, EasingFunction = new SineEase { EasingMode = EasingMode.EaseInOut } };
            Motion.Begin(Get<Ellipse>("StatusGlow"), UIElement.OpacityProperty, pulse);
            // Tiny irregular tremors and a slower inward tug run independently
            // of the base gap, so a new connection can interrupt either safely.
            int[] jitter = { 0, 60, 120, 210, 310, 390, 510, 720 };
            foreach (string side in new[] { "Upper", "Lower" }) {
                double sign = side == "Upper" ? 1 : -1;
                var tremor = Get<TranslateTransform>(side + "Tremor");
                Motion.Frames(tremor, TranslateTransform.XProperty, jitter, new[] { 0, .35 * sign, -.55 * sign, .45 * sign, -.22 * sign, .60 * sign, -.45 * sign, 0 }, true);
                Motion.Frames(tremor, TranslateTransform.YProperty, jitter, new[] { 0, -.24 * sign, .38 * sign, -.32 * sign, .26 * sign, -.40 * sign, .30 * sign, 0 }, true);
                Motion.Frames(Get<RotateTransform>(side + "Twist"), RotateTransform.AngleProperty, jitter, new[] { 0, 2.1 * sign, -2.7 * sign, 1.9 * sign, -1.2 * sign, 2.8 * sign, -2.0 * sign, 0 }, true);
                var reach = Get<TranslateTransform>(side + "Reach");
                Motion.Frames(reach, TranslateTransform.XProperty, new[] { 0, 600, 950, 1170, 2100 }, new[] { 0, 0, -.9 * sign, -.9 * sign, 0 }, true);
                Motion.Frames(reach, TranslateTransform.YProperty, new[] { 0, 600, 950, 1170, 2100 }, new[] { 0, 0, .9 * sign, .9 * sign, 0 }, true);
            }
        }
        void StopAmbient()
        {
            Get<Ellipse>("StatusGlow").BeginAnimation(UIElement.OpacityProperty, null); Get<Ellipse>("StatusGlow").Opacity = .16;
            foreach (string side in new[] { "Upper", "Lower" }) {
                foreach (string name in new[] { "Tremor", "Reach" }) {
                    Motion.To(Get<TranslateTransform>(side + name), TranslateTransform.XProperty, 0, 0, true);
                    Motion.To(Get<TranslateTransform>(side + name), TranslateTransform.YProperty, 0, 0, true);
                }
                Motion.To(Get<RotateTransform>(side + "Twist"), RotateTransform.AngleProperty, 0, 0, true);
            }
        }
        void Sweep(int delay = 0)
        {
            if (reduced || !IsLoaded) return;
            Motion.Frames(Get<Rectangle>("Glint"), UIElement.OpacityProperty, new[] { 0, delay + 15, delay + 620 }, new[] { 0.0, .85, 0 });
            Motion.From(Get<TranslateTransform>("GlintX"), TranslateTransform.XProperty, -100, Get<Grid>("StatusPanel").ActualWidth + 100, 620, false, delay);
        }
        internal void SetParallax(double x, double y, bool animate)
        {
            bool quiet = reduced || !animate;
            if (reduced) x = y = 0;
            Sculpture.PointAt(x, y, quiet);
            hoveringSculpture = Math.Abs(x) + Math.Abs(y) > .05;
            Motion.ColorTo(glassEdge, EdgeColor(), quiet);
        }
        void WireButton(Button button)
        {
            var scale = new ScaleTransform(1, 1); var offset = new TranslateTransform();
            var transform = new TransformGroup(); transform.Children.Add(scale); transform.Children.Add(offset);
            button.RenderTransform = transform; button.RenderTransformOrigin = new Point(.5, .5);
            Action<bool, bool> pose = (pressed, spring) => {
                bool active = button.IsEnabled && button.IsMouseOver;
                double size = pressed ? .965 : active ? 1.012 : 1;
                Motion.To(scale, ScaleTransform.ScaleXProperty, reduced ? 1 : size, 210, reduced || !button.IsEnabled, spring);
                Motion.To(scale, ScaleTransform.ScaleYProperty, reduced ? 1 : size, 210, reduced || !button.IsEnabled, spring);
                Motion.To(offset, TranslateTransform.YProperty, reduced ? 0 : pressed ? 1 : active ? -1 : 0, 210, reduced || !button.IsEnabled, spring);
            };
            button.MouseEnter += (s, e) => pose(false, false); button.MouseLeave += (s, e) => pose(false, false);
            button.PreviewMouseLeftButtonDown += (s, e) => { if (button.IsEnabled) pose(true, false); };
            button.PreviewMouseLeftButtonUp += (s, e) => pose(false, true);
            button.PreviewKeyDown += (s, e) => { if (e.Key == Key.Space || e.Key == Key.Enter) pose(true, false); };
            button.PreviewKeyUp += (s, e) => { if (e.Key == Key.Space || e.Key == Key.Enter) pose(false, true); };
            button.IsEnabledChanged += (s, e) => pose(false, false);
            resetButtons.Add(() => pose(false, false));
        }
        internal void SaveImage(string file, double scale = 1)
        {
            view.Measure(new Size(Width, Height)); view.Arrange(new Rect(0, 0, Width, Height)); view.UpdateLayout();
            var bitmap = new RenderTargetBitmap((int)Math.Ceiling(Width * scale), (int)Math.Ceiling(Height * scale), 96 * scale, 96 * scale, PixelFormats.Pbgra32);
            bitmap.Render(view); var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(bitmap));
            using (var stream = File.Create(file)) encoder.Save(stream);
        }
    }
}
