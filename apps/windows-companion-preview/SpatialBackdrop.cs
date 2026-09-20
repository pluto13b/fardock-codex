using System;
using System.Diagnostics;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Media3D;

namespace CodexPlusUiPreview
{
    // Broad, edge-free studio light on three translucent planes. The foreground
    // carries the detail; the background contributes only depth and illumination.
    internal sealed class SpatialBackdrop : IDisposable
    {
        readonly GradientBrush[] light = new GradientBrush[3];
        readonly TranslateTransform3D[] drift = new TranslateTransform3D[3];
        readonly double[] depths = { -2.2, -3.9, -5.6 };
        readonly RenderClock clock;
        readonly Stopwatch time = new Stopwatch();
        internal readonly TranslateTransform3D ViewShift = new TranslateTransform3D();
        bool active, motion = true, disposed;
        double pulseStart = -1;
        internal int FrameCount { get; private set; }
        internal double LastUpdateMilliseconds { get; private set; }
        internal double PulseStrength { get; private set; }
        internal bool IsRunning { get { return clock.IsRunning; } }
        internal Point3D LightSample { get; private set; }
        internal double DepthSeparation { get { return depths[0] - depths[2]; } }
        internal int VertexCount { get { return 12; } }

        internal SpatialBackdrop(Viewport3D viewport)
        {
            clock = new RenderClock(Tick);
            viewport.Camera = new PerspectiveCamera(new Point3D(0, .1, 9), new Vector3D(0, 0, -1), new Vector3D(0, 1, 0), 54) { NearPlaneDistance = 1, FarPlaneDistance = 30 };
            var scene = new Model3DGroup { Transform = ViewShift };
            light[0] = new LinearGradientBrush { StartPoint = new Point(0, .85), EndPoint = new Point(1, .15) };
            light[1] = new RadialGradientBrush { Center = new Point(.16, .7), GradientOrigin = new Point(.12, .68), RadiusX = .86, RadiusY = .72 };
            light[2] = new RadialGradientBrush { Center = new Point(.5, .03), GradientOrigin = new Point(.5, .03), RadiusX = .72, RadiusY = .8 };
            foreach (var brush in light)
                foreach (double offset in new[] { 0.0, .32, .66, 1.0 }) brush.GradientStops.Add(new GradientStop(Colors.Transparent, offset));
            for (int layer = 2; layer >= 0; layer--) {
                var mesh = new MeshGeometry3D();
                double z = depths[layer];
                Point3D[] corners = layer == 0
                    ? new[] { new Point3D(-10, -5, z), new Point3D(1.8, -5, z + .4), new Point3D(-1.1, 5.5, z - .4), new Point3D(-10, 5.5, z) }
                    : new[] { new Point3D(-10, -5, z), new Point3D(8, -5, z), new Point3D(8, 6, z - .8), new Point3D(-10, 6, z) };
                foreach (var point in corners) mesh.Positions.Add(point);
                foreach (var uv in new[] { new Point(0, 1), new Point(1, 1), new Point(1, 0), new Point(0, 0) }) mesh.TextureCoordinates.Add(uv);
                foreach (int index in new[] { 0, 1, 2, 0, 2, 3 }) mesh.TriangleIndices.Add(index);
                mesh.Freeze();
                drift[layer] = new TranslateTransform3D();
                var material = new EmissiveMaterial(light[layer]);
                scene.Children.Add(new GeometryModel3D(mesh, material) { BackMaterial = material, Transform = drift[layer] });
            }
            viewport.Children.Add(new ModelVisual3D { Content = scene });
            SetState(false, true, false);
        }
        internal void RenderFrame(double seconds, double pulse = -1)
        {
            var watch = Stopwatch.StartNew();
            PulseStrength = pulse >= 0 && pulse < 1 ? Math.Sin(Math.PI * pulse) : 0;
            for (int layer = 0; layer < light.Length; layer++) {
                // Slow translation preserves the shape instead of waving or bending it.
                drift[layer].OffsetX = .16 * Math.Sin(seconds * .13 + layer * 1.4);
                drift[layer].OffsetY = .10 * Math.Cos(seconds * .11 + layer * 1.7);
                light[layer].Opacity = (layer == 0 ? .75 : .60) + PulseStrength * (layer == 0 ? .09 : .12);
            }
            LightSample = new Point3D(drift[0].OffsetX, drift[0].OffsetY, depths[0]);
            FrameCount++; LastUpdateMilliseconds = watch.Elapsed.TotalMilliseconds;
        }
        void Tick()
        {
            double now = time.Elapsed.TotalSeconds;
            double pulse = pulseStart < 0 || now < pulseStart ? -1 : (now - pulseStart) / 1.4;
            if (pulse >= 1) { pulseStart = -1; pulse = -1; }
            RenderFrame(now, pulse);
        }
        internal void SetState(bool connected, bool quiet, bool celebrate)
        {
            Color[] colors = connected
                ? new[] { Color.FromRgb(128, 147, 160), Color.FromRgb(115, 144, 160), Color.FromRgb(163, 170, 177) }
                : new[] { Color.FromRgb(151, 145, 130), Color.FromRgb(151, 140, 118), Color.FromRgb(167, 169, 165) };
            byte[][] opacity = { new byte[] { 8, 32, 17, 0 }, new byte[] { 42, 25, 6, 0 }, new byte[] { 21, 15, 4, 0 } };
            for (int layer = 0; layer < light.Length; layer++)
                for (int stop = 0; stop < opacity[layer].Length; stop++) {
                    Color c = colors[layer];
                    Motion.ColorTo(light[layer].GradientStops[stop], GradientStop.ColorProperty,
                        Color.FromArgb(opacity[layer][stop], c.R, c.G, c.B), quiet || !motion, 480, 0);
                }
            pulseStart = celebrate && active && motion && !quiet ? time.Elapsed.TotalSeconds + .13 : -1;
            RenderFrame(time.Elapsed.TotalSeconds);
        }
        internal void SetPointer(double x, double y, bool quiet)
        {
            if (!motion || !active) x = y = 0;
            Motion.To(ViewShift, TranslateTransform3D.OffsetXProperty, Math.Max(-1, Math.Min(1, x)) * .23, 380, quiet || !motion || !active);
            Motion.To(ViewShift, TranslateTransform3D.OffsetYProperty, -Math.Max(-1, Math.Min(1, y)) * .13, 380, quiet || !motion || !active);
        }
        internal void SetActive(bool value)
        {
            active = value && !disposed; UpdateClock();
            if (!active) { pulseStart = -1; PulseStrength = 0; SetPointer(0, 0, true); }
        }
        internal void SetMotionEnabled(bool value)
        {
            motion = value; UpdateClock();
            if (!motion) { pulseStart = -1; SetPointer(0, 0, true); RenderFrame(time.Elapsed.TotalSeconds); }
        }
        void UpdateClock()
        {
            if (active && motion && !disposed) { time.Start(); clock.Start(); }
            else { time.Stop(); clock.Stop(); }
        }
        public void Dispose() { disposed = true; SetActive(false); clock.Dispose(); }
    }
}
