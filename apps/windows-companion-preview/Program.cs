using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Media3D;
using System.Windows.Shapes;
using System.Windows.Threading;

namespace CodexPlusUiPreview
{
    internal static class Program
    {
        static int assertions;
        static void Check(bool ok, string name) { if (!ok) throw new InvalidOperationException(name); assertions++; }
        static void Pump(int milliseconds)
        {
            var watch = Stopwatch.StartNew();
            do {
                var frame = new DispatcherFrame();
                Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.Background, new Action(() => frame.Continue = false));
                Dispatcher.PushFrame(frame); Thread.Sleep(8);
            } while (watch.ElapsedMilliseconds < milliseconds);
        }
        static void Capture(PreviewWindow window, string root, string name, double scale = 1)
        {
            window.UpdateLayout(); window.SaveImage(System.IO.Path.Combine(root, name + ".png"), scale);
        }
        static double PixelDifference(byte[] first, byte[] second, int fromRow = 0, int toRow = GlassOptics.Height)
        {
            double total = 0;
            for (int index = fromRow * GlassOptics.Width * 4; index < toRow * GlassOptics.Width * 4; index += 4) for (int channel = 0; channel < 3; channel++) total += Math.Abs(first[index + channel] - second[index + channel]);
            return total / ((toRow - fromRow) * GlassOptics.Width * 3);
        }
        static void VerifyFramePolicy()
        {
            Check(Motion.FramesPerSecond == 60, "default-animation-target-is-60");
            foreach (int refresh in new[] { 30, 60, 120, 144 }) {
                using (var policy = new RenderClock(() => { })) {
                    int accepted = 0; bool duplicate = false;
                    for (int frame = 0; frame < refresh; frame++) {
                        var stamp = TimeSpan.FromTicks((long)Math.Round(frame * (double)TimeSpan.TicksPerSecond / refresh));
                        if (policy.IsFrameDue(stamp)) accepted++;
                        duplicate |= policy.IsFrameDue(stamp);
                    }
                    Check(accepted == Math.Min(60, refresh), "render-deadlines-at-" + refresh + "hz");
                    Check(!duplicate, "same-composition-timestamp-only-once-" + refresh);
                }
            }
            using (var policy = new RenderClock(() => { })) {
                policy.IsFrameDue(TimeSpan.Zero);
                Check(policy.IsFrameDue(TimeSpan.FromMilliseconds(100)), "delayed-frame-is-rendered");
                Check(!policy.IsFrameDue(TimeSpan.FromMilliseconds(101)), "no-catchup-burst-after-delay");
            }
            var animation = new System.Windows.Media.Animation.DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(200));
            var target = new TranslateTransform(); Motion.Begin(target, TranslateTransform.XProperty, animation);
            Check(System.Windows.Media.Animation.Timeline.GetDesiredFrameRate(animation) == 60, "native-timelines-share-60fps-policy");
            Motion.Begin(target, TranslateTransform.XProperty, null);
        }
        static void VerifyOptics(PreviewWindow window, string directory)
        {
            var optics = window.Sculpture.Optics;
            var tint = Color.FromRgb(210, 219, 224);
            var view = new Vector3D(.36, -.18, .915);
            optics.Render(view, .13, tint, .82); var frosted = optics.CopyPixels();
            optics.Render(view, .13, tint, .82);
            Check(PixelDifference(frosted, optics.CopyPixels()) == 0, "stable-grain-does-not-shimmer");
            optics.Render(view, .13, tint, .25);
            Check(PixelDifference(frosted, optics.CopyPixels()) > 1, "roughness-changes-scatter-and-transmission");
            var clear = optics.CopyPixels();
            optics.Render(new Vector3D(-.3, .12, .95), .13, tint, .25);
            Check(PixelDifference(clear, optics.CopyPixels()) > .25, "view-dependent-refraction-and-highlights");
            optics.Render(view, .13, tint, .4, 140); var halfClear = optics.CopyPixels();
            optics.Render(view, .13, tint, .4, 330); var fullyClear = optics.CopyPixels();
            Check(PixelDifference(halfClear, fullyClear, 32, 72) == 0, "scan-already-cleared-upper-material");
            Check(PixelDifference(halfClear, fullyClear, 180, 225) > 1, "scan-keeps-lower-material-frosted");
            for (int mode = 0; mode < 2; mode++) {
                var timings = new double[30];
                for (int index = 0; index < timings.Length; index++) {
                    optics.Render(new Vector3D(-.35 + index * .025, .14, .94), .13, tint, .6, mode == 0 ? 330 : index * 11 - 15);
                    timings[index] = optics.LastRenderMilliseconds;
                }
                Array.Sort(timings);
                Console.WriteLine(string.Format(System.Globalization.CultureInfo.InvariantCulture,
                    "Glass material ({4}): {0}x{1}, 30 renders, CPU+bitmap-write p50={2:F2} ms, p95={3:F2} ms", GlassOptics.Width, GlassOptics.Height, timings[14], timings[28], mode == 0 ? "clear" : "scan"));
            }
            window.Sculpture.SetEngaged(true, false); window.SetParallax(.8, -.5, true); Pump(450);
            Capture(window, directory, "11-glass-clear");
            window.Sculpture.SetEngaged(false, true); window.SetParallax(0, 0, false);
            window.Sculpture.RefreshMaterial(); Pump(100);
            int settled = optics.RenderCount; Pump(180);
            Check(optics.RenderCount == settled && !window.Sculpture.MaterialUpdatePending, "stationary-material-stops-updates");
        }
        static void VerifyBackdrop(PreviewWindow window, string directory)
        {
            var backdrop = window.Backdrop;
            window.SetReduced(false);
            int runningFrames = backdrop.FrameCount; Pump(120);
            Check(backdrop.IsRunning && backdrop.FrameCount > runningFrames, "visible-background-flows");
            int callbackStart = backdrop.FrameCount; var callbackWatch = Stopwatch.StartNew(); Pump(1200);
            Console.WriteLine(string.Format(System.Globalization.CultureInfo.InvariantCulture,
                "WPF background callbacks: {0:F1}/s over {1:F2}s (not display presentation)", (backdrop.FrameCount - callbackStart) / callbackWatch.Elapsed.TotalSeconds, callbackWatch.Elapsed.TotalSeconds));
            backdrop.RenderFrame(2); Point3D earlier = backdrop.LightSample;
            backdrop.RenderFrame(6);
            Check((backdrop.LightSample - earlier).Length > .03 && backdrop.DepthSeparation > 2, "background-has-slow-motion-and-depth");
            backdrop.RenderFrame(2);
            Check((backdrop.LightSample - earlier).Length < .000001, "background-is-time-based-not-frame-count-based");
            Check(backdrop.VertexCount <= 1500 && !window.Get<Grid>("BackgroundScene").IsHitTestVisible, "background-budget-and-input-isolation");
            var mask = (LinearGradientBrush)window.Get<Grid>("BackgroundScene").OpacityMask;
            Check(mask.GradientStops[mask.GradientStops.Count - 1].Color.A < mask.GradientStops[0].Color.A, "background-fades-behind-reading-area");
            backdrop.SetPointer(.8, -.6, true);
            Check(backdrop.ViewShift.OffsetX > .1 && backdrop.ViewShift.OffsetY > .05, "background-pointer-parallax");
            backdrop.RenderFrame(4, .4); Capture(window, directory, "13-spatial-background");
            var timings = new double[30];
            for (int index = 0; index < timings.Length; index++) { backdrop.RenderFrame(4 + index / (double)Motion.FramesPerSecond, index / 30.0); timings[index] = backdrop.LastUpdateMilliseconds; }
            Array.Sort(timings);
            Console.WriteLine(string.Format(System.Globalization.CultureInfo.InvariantCulture,
                "Background: {0} vertices, 30 lighting/pose updates, CPU p50={1:F3} ms, p95={2:F3} ms", backdrop.VertexCount, timings[14], timings[28]));
            window.SetScene(PreviewScene.Reconnecting, false); window.SetScene(PreviewScene.Ready, true); Pump(450);
            Check(backdrop.PulseStrength > .1 && window.Get<Button>("PairingButton").IsEnabled, "connection-light-keeps-actions-available");
            Capture(window, directory, "14-connection-wave");
            window.SetScene(PreviewScene.Reconnecting, true);
            Check(backdrop.PulseStrength == 0, "disconnect-cancels-background-light");
            window.SetReduced(true);
            int quietFrames = backdrop.FrameCount; backdrop.SetPointer(1, 1, false); Pump(100);
            Check(!backdrop.IsRunning && quietFrames == backdrop.FrameCount && backdrop.ViewShift.OffsetX == 0, "reduced-motion-freezes-background");
            window.SetScene(PreviewScene.Ready, false); window.SetReduced(false);
        }
        static void Verify(PreviewWindow window, string directory)
        {
            Directory.CreateDirectory(directory);
            VerifyFramePolicy();
            foreach (var type in Assembly.GetExecutingAssembly().GetTypes()) {
                Check(type.Name != "OwnedProcess" && type.Name != "StartupTask" && type.Name != "AppConfig", "frontend-only-types");
            }
            window.SetReduced(true); window.SetScene(PreviewScene.Idle, false); Pump(30);
            Check((string)window.Get<Button>("ServiceButton").Content == "启动服务", "idle-start-action");
            Check(!window.Get<Button>("PairingButton").IsEnabled, "pair-disabled-until-connected");
            Check(window.Get<TranslateTransform>("LinkUpper").X > 2.5, "waiting-chain-separated");
            var idleColor = window.Get<LinearGradientBrush>("IconSurface").GradientStops[1].Color;
            Check(idleColor.R > idleColor.B, "waiting-amber");
            var warmSurface = window.Get<LinearGradientBrush>("WindowSurface").GradientStops;
            Check(warmSurface[0].Color.R > warmSurface[0].Color.B && warmSurface[0].Color != warmSurface[2].Color, "whole-window-warm-gradient");
            Capture(window, directory, "01-waiting");

            window.SetScene(PreviewScene.Ready, false); Pump(20);
            Check(window.Get<TranslateTransform>("LinkUpper").X == 0 && window.Get<TranslateTransform>("LinkLower").X == 0, "connected-chain-joined");
            var readyColor = window.Get<LinearGradientBrush>("IconSurface").GradientStops[1].Color;
            Check(readyColor.B > readyColor.R, "connected-blue");
            Check(warmSurface[0].Color.B > warmSurface[0].Color.R && warmSurface[0].Color != warmSurface[2].Color, "whole-window-cool-gradient");
            Check(window.Get<TextBlock>("StatusTitle").Text == "服务已就绪" && window.Get<Button>("PairingButton").IsEnabled, "ready-view");
            Check(window.Get<Button>("ServiceButton").ActualHeight >= 44 && window.Get<Button>("PairingButton").ActualHeight >= 44, "usable-button-height");
            Capture(window, directory, "02-ready");

            window.Get<Button>("PairingButton").RaiseEvent(new RoutedEventArgs(Button.ClickEvent)); Pump(30);
            Check(window.PairOpen && window.Get<Grid>("PairingReveal").Height == PreviewWindow.PairHeight, "pair-button-opens-view");
            Check(window.Sculpture.Extraction.OffsetY > .14 && window.Sculpture.Extraction.OffsetZ > .11, "pairing-lifts-and-approaches-sheets");
            Check(window.Get<ScaleTransform>("PairTopScale").ScaleX == 1 && window.Get<ScaleTransform>("PairBottomScale").ScaleX == 1, "reduced-pair-lines-complete-immediately");
            Check(window.Get<StackPanel>("CodeSlots").Children.Count == 8, "eight-placeholder-slots");
            foreach (TextBlock slot in window.Get<StackPanel>("CodeSlots").Children) Check(slot.Text == "•", "no-real-pairing-code");
            Capture(window, directory, "03-pairing");
            Capture(window, directory, "04-pairing-150", 1.5);

            window.SetReduced(false); window.SetPairing(false, false); window.SetPairing(true, true); Pump(300);
            Check(window.Get<ScaleTransform>("PairTopScale").ScaleX > .1 && window.Get<ScaleTransform>("PairBottomScale").ScaleX < .95, "first-open-lines-reveal-with-content");
            Capture(window, directory, "10-pair-lines-opening");
            window.SetPairing(false, true); Pump(100);
            window.SetPairing(true, true); Pump(90);
            double topLength = window.Get<ScaleTransform>("PairTopScale").ScaleX;
            double bottomLength = window.Get<ScaleTransform>("PairBottomScale").ScaleX;
            Check(topLength > 0 && topLength < 1 && bottomLength > 0 && bottomLength < 1, "both-pair-lines-grow-progressively");
            Check(window.Get<Border>("PairTopLine").RenderTransformOrigin.X == .5 && window.Get<Border>("PairBottomLine").RenderTransformOrigin.X == .5, "pair-lines-expand-from-centre");
            topLength = window.Get<ScaleTransform>("PairTopScale").ScaleX;
            window.SetPairing(false, true);
            Check(Math.Abs(window.Get<ScaleTransform>("PairTopScale").ScaleX - topLength) < .05, "line-close-continues-from-current-length");
            Pump(530);
            Check(!window.PairOpen && window.Get<Grid>("PairingReveal").ActualHeight < 1, "pair-reversal-settles-closed");
            Check(window.Get<ScaleTransform>("PairTopScale").ScaleX == 0 && window.Get<ScaleTransform>("PairBottomScale").ScaleX == 0, "closed-lines-return-to-centre");
            Check(Math.Abs(window.Height - PreviewWindow.BaseHeight) < .5, "window-size-restored");
            Check(window.Sculpture.Extraction.OffsetY == 0 && window.Sculpture.Extraction.OffsetZ == 0, "pairing-reversal-returns-sheets");

            window.SetScene(PreviewScene.Reconnecting, false); Pump(90);
            var tremor = window.Get<TranslateTransform>("UpperTremor");
            Check(tremor.HasAnimatedProperties && Math.Abs(tremor.X) > .05, "waiting-tremor-moves");
            int waitingMaterialRenders = window.Sculpture.Optics.RenderCount;
            Pump(810);
            Check(window.Sculpture.Optics.RenderCount == waitingMaterialRenders && !window.Sculpture.MaterialUpdatePending, "ink-animation-does-not-recompute-material");
            Check(Math.Abs(window.Get<TranslateTransform>("UpperReach").X) > .2, "waiting-parts-reach-inward");
            window.SetScene(PreviewScene.Ready, true); Pump(65);
            Check(window.Get<TranslateTransform>("LinkUpper").X > 2.8, "connection-anticipation-pulls-back");
            Check(!tremor.HasAnimatedProperties && tremor.X == 0, "connection-stops-waiting-loop");
            Capture(window, directory, "08-anticipation");
            Pump(120);
            Check(Math.Abs(window.Get<TranslateTransform>("LinkUpper").X) < 1, "connection-snaps-in-early");
            Check(window.Get<Ellipse>("LinkHalo").Opacity > .1, "single-impact-halo");
            Capture(window, directory, "09-impact");
            Pump(200);
            Check(window.Get<TranslateTransform>("GlassScanY").Y > 0 && window.Get<TranslateTransform>("GlassScanY").Y < 330, "scan-moves-after-coupling");
            Check(window.Get<Button>("PairingButton").IsEnabled, "scan-does-not-delay-actions");
            Capture(window, directory, "12-glass-clearing");
            Pump(700);
            Check(window.Get<ScaleTransform>("DeckScale").ScaleX == 1 && window.Get<TranslateTransform>("DeckKick").Y == 0, "impact-settles-without-drift");
            Check(window.Get<Ellipse>("LinkHalo").Opacity == 0 && window.Get<RotateTransform>("LinkTilt").Angle == 0, "success-stays-calm");
            Check(warmSurface[0].Color.B > warmSurface[0].Color.R, "snap-completes-cool-theme");
            Check(Math.Abs(window.Sculpture.Front.OffsetZ - .065) < .001 && Math.Abs(window.Sculpture.Rear.OffsetZ + .065) < .001, "glass-sheets-dock-with-clearance");
            Check(window.Get<TranslateTransform>("GlassScanY").Y == 330 && window.Get<System.Windows.Shapes.Path>("GlassScanLine").Opacity == 0, "scan-finishes-on-clear-material");

            window.SetScene(PreviewScene.Reconnecting, false); window.SetScene(PreviewScene.Ready, true); Pump(130);
            double before = window.Get<TranslateTransform>("LinkUpper").X;
            window.SetScene(PreviewScene.Reconnecting, true);
            Check(Math.Abs(window.Get<TranslateTransform>("LinkUpper").X - before) < .3, "reverse-from-current-position");
            Pump(530);
            Check(window.Get<TranslateTransform>("LinkUpper").X > 2.5 && window.Get<TextBlock>("StatusTitle").Text == "正在恢复连接", "reverse-ends-in-new-state");
            Check(window.Get<Ellipse>("LinkHalo").Opacity == 0 && warmSurface[0].Color.R > warmSurface[0].Color.B, "disconnect-cancels-impact-and-cool-theme");
            Check(window.Sculpture.Front.OffsetZ > .49 && window.Sculpture.Rear.OffsetZ < -.49, "disconnect-separates-sheets");
            Check(window.Get<TranslateTransform>("GlassScanY").Y == 330 && window.Get<System.Windows.Shapes.Path>("GlassScanLine").Opacity == 0, "disconnect-cancels-delayed-scan");
            Capture(window, directory, "05-reconnecting");

            window.SetScene(PreviewScene.Idle, false);
            window.Get<Button>("ServiceButton").RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
            Check(window.Scene == PreviewScene.Connecting && window.PendingTimers == 1, "local-start-simulation");
            window.CancelSimulation(); window.SetScene(PreviewScene.Reconnecting, false); Pump(1800);
            Check(window.Scene == PreviewScene.Reconnecting && window.PendingTimers == 0, "cancel-prevents-stale-success");

            window.SetReduced(true); Pump(20);
            Check(!tremor.HasAnimatedProperties && !window.Get<TranslateTransform>("UpperReach").HasAnimatedProperties && !window.Get<RotateTransform>("UpperTwist").HasAnimatedProperties, "reduced-stops-all-waiting-motion");
            window.SetReduced(false); window.SetScene(PreviewScene.Ready, true); Pump(150); window.SetReduced(true);
            Check(!window.Get<ScaleTransform>("DeckScale").HasAnimatedProperties && window.Get<Ellipse>("LinkHalo").Opacity == 0, "reduced-interrupts-impact");
            Check(!warmSurface[0].HasAnimatedProperties && warmSurface[0].Color.B > warmSurface[0].Color.R, "reduced-applies-final-palette");
            window.SetReduced(true); window.SetScene(PreviewScene.Ready, false); window.SetParallax(1, -1, true); Pump(20);
            Check(window.Sculpture.Yaw.Angle == -24 && window.Sculpture.Pitch.Angle == 11, "reduced-motion-default-3d-pose");
            Check(!DependencyPropertyHelper.GetValueSource(window.Get<System.Windows.Shapes.Ellipse>("StatusGlow"), UIElement.OpacityProperty).IsAnimated, "reduced-motion-stops-breathing");
            window.SetReduced(false); window.SetParallax(.8, -.6, false); Pump(20);
            Check(window.Sculpture.Yaw.Angle > -24 && window.Sculpture.Pitch.Angle > 11, "pointer-changes-real-3d-pose");
            Capture(window, directory, "06-parallax");
            VerifyOptics(window, directory);
            VerifyBackdrop(window, directory);
            window.PlayDemo(); window.SetScene(PreviewScene.Ready, true); Pump(350); window.Hide(); Pump(20);
            Check(window.PendingTimers == 0, "hidden-cancels-demo-timers");
            Check(!DependencyPropertyHelper.GetValueSource(window.Get<System.Windows.Shapes.Ellipse>("StatusGlow"), UIElement.OpacityProperty).IsAnimated, "hidden-stops-ambient");
            Check(!tremor.HasAnimatedProperties && !window.Get<TranslateTransform>("UpperReach").HasAnimatedProperties, "hidden-stops-chain-loops");
            int hiddenRenders = window.Sculpture.Optics.RenderCount, hiddenBackground = window.Backdrop.FrameCount; Pump(150);
            Check(!window.Sculpture.MaterialUpdatePending && hiddenRenders == window.Sculpture.Optics.RenderCount, "hidden-stops-material-updates");
            Check(window.Get<System.Windows.Shapes.Path>("GlassScanLine").Opacity == 0 && !window.Get<TranslateTransform>("GlassScanY").HasAnimatedProperties, "hidden-cancels-active-scan");
            Check(!window.Backdrop.IsRunning && hiddenBackground == window.Backdrop.FrameCount, "hidden-stops-background-clock");
            window.Show(); window.SetReduced(false); Pump(100);
            Check(window.Backdrop.IsRunning && window.Backdrop.FrameCount > hiddenBackground, "show-resumes-background");
            window.SetReduced(true); window.SetScene(PreviewScene.Ready, false);
            window.Width = window.MinWidth; Pump(20); Capture(window, directory, "07-compact");
            Check(window.Get<Button>("PairingButton").ActualWidth >= 140, "compact-controls-fit");
            Check(window.Get<Grid>("StatusPanel").ActualWidth >= 310 && Math.Abs(window.Get<Grid>("SculptureDeck").ActualWidth - 286) < 1, "open-layout-keeps-text-and-scene-separate");
            window.Close(); Check(window.PendingTimers == 0 && !window.Sculpture.MaterialUpdatePending && !window.Backdrop.IsRunning, "closed-cleans-up");
            Console.WriteLine("Windows UI preview checks passed: " + assertions);
        }
        [STAThread]
        static int Main(string[] args)
        {
            try {
                var app = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
                var window = new PreviewWindow();
                if (args.Length > 0) {
                    if (args.Length != 2 || args[0] != "--check") throw new ArgumentException("preview-arguments");
                    var root = System.IO.Path.GetFullPath(args[1]);
                    var ownDirectory = System.IO.Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location) + System.IO.Path.DirectorySeparatorChar;
                    if (!root.StartsWith(ownDirectory, StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("preview-output-boundary");
                    window.WindowStartupLocation = WindowStartupLocation.Manual; window.Left = -12000; window.Top = -12000; window.ShowActivated = false; window.ShowInTaskbar = false;
                    app.ShutdownMode = ShutdownMode.OnExplicitShutdown; window.Show(); Pump(40);
                    Verify(window, root); app.Shutdown(); return 0;
                }
                app.Run(window); return 0;
            } catch (Exception error) { Console.Error.WriteLine(error); return 1; }
        }
    }
}
