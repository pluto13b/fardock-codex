using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Media3D;

namespace CodexPlusUiPreview
{
    // Two original chamfered glass sheets. UI controls stay outside the scene.
    internal sealed class ConnectionSculpture : IDisposable
    {
        internal readonly AxisAngleRotation3D Yaw = new AxisAngleRotation3D(new Vector3D(0, 1, 0), -24);
        internal readonly AxisAngleRotation3D Pitch = new AxisAngleRotation3D(new Vector3D(1, 0, 0), 11);
        internal readonly TranslateTransform3D Front = new TranslateTransform3D(0, 0, .5);
        internal readonly TranslateTransform3D Rear = new TranslateTransform3D(0, 0, -.5);
        internal readonly TranslateTransform3D Extraction = new TranslateTransform3D();
        internal readonly GlassOptics Optics;
        readonly Transform3DGroup pose = new Transform3DGroup();
        readonly LinearGradientBrush palette;
        readonly TranslateTransform scan;
        readonly SpecularMaterial finish = new SpecularMaterial(new SolidColorBrush(Color.FromArgb(18, 238, 244, 248)), 42);
        readonly RenderClock materialClock;
        bool active, dirty = true, disposed, connected, engaged;
        internal bool MaterialUpdatePending { get { return materialClock.IsRunning; } }
        readonly Point[] outline = {
            new Point(-.84, -1.4), new Point(.84, -1.4), new Point(1.02, -1.22),
            new Point(1.02, 1.22), new Point(.84, 1.4), new Point(-.84, 1.4),
            new Point(-1.02, 1.22), new Point(-1.02, -1.22),
        };

        internal ConnectionSculpture(Viewport3D viewport, Grid artwork, Brush tint, Brush edge, TranslateTransform scan)
        {
            this.scan = scan;
            materialClock = new RenderClock(MaterialTick);
            palette = (LinearGradientBrush)tint;
            Optics = new GlassOptics(outline);
            viewport.Camera = new PerspectiveCamera(new Point3D(0, .08, 6.1), new Vector3D(0, 0, -1), new Vector3D(0, 1, 0), 35);
            var scene = new Model3DGroup();
            scene.Children.Add(new AmbientLight(Color.FromRgb(140, 146, 152)));
            scene.Children.Add(new DirectionalLight(Color.FromRgb(213, 220, 225), new Vector3D(-2, -3, -4)));
            var sheets = new Model3DGroup();
            pose.Children.Add(new RotateTransform3D(Pitch));
            pose.Children.Add(new RotateTransform3D(Yaw));
            pose.Children.Add(new RotateTransform3D(new AxisAngleRotation3D(new Vector3D(0, 0, 1), -9)));
            pose.Children.Add(Extraction);
            sheets.Transform = pose;

            var rear = Sheet(new EmissiveMaterial(new ImageBrush(Optics.Backplate) { Opacity = .68 }), edge);
            rear.Transform = Rear;
            sheets.Children.Add(rear);
            // Composite ink over optics in 2D first. Separate emissive passes add
            // their light and wash out the surface instead of doing alpha-over.
            artwork.Background = new ImageBrush(Optics.Surface);
            var visual = new VisualBrush(artwork) { Viewbox = new Rect(0, 0, 210, 280), ViewboxUnits = BrushMappingMode.Absolute, Stretch = Stretch.Fill };
            var frontMaterial = new MaterialGroup();
            frontMaterial.Children.Add(new DiffuseMaterial(visual));
            frontMaterial.Children.Add(finish);
            var front = Sheet(frontMaterial, edge);
            front.Transform = Front;
            sheets.Children.Add(front);
            scene.Children.Add(sheets);
            viewport.Children.Add(new ModelVisual3D { Content = scene });
            Yaw.Changed += OpticalChange; Pitch.Changed += OpticalChange;
            Front.Changed += OpticalChange; Rear.Changed += OpticalChange;
            palette.Changed += OpticalChange; finish.Changed += OpticalChange;
            scan.Changed += OpticalChange;
        }

        void OpticalChange(object sender, EventArgs args)
        {
            dirty = true;
            if (active && !disposed) materialClock.Start();
        }
        void MaterialTick()
        {
            if (!dirty || !active || disposed) { materialClock.Stop(); return; }
            RefreshMaterial();
        }
        internal void RefreshMaterial()
        {
            if (!active || disposed) return;
            dirty = false; materialClock.Stop();
            var inverse = pose.Value; inverse.Invert();
            var view = inverse.Transform(new Vector3D(0, 0, 1));
            Optics.Render(view, Front.OffsetZ - Rear.OffsetZ, palette.GradientStops[0].Color, 1 - (finish.SpecularPower - 24) / 96, scan.Y);
        }
        internal void SetActive(bool value)
        {
            active = value && !disposed;
            if (!active) materialClock.Stop();
            else if (dirty) RefreshMaterial();
        }
        internal void SetEngaged(bool engaged, bool quiet)
        {
            this.engaged = engaged;
            Motion.To(finish, SpecularMaterial.SpecularPowerProperty, engaged ? 96 : connected ? 64 : 42, 280, quiet);
            if (quiet) RefreshMaterial();
        }
        internal void SetPairing(bool open, bool quiet)
        {
            Motion.To(Extraction, TranslateTransform3D.OffsetYProperty, open ? .15 : 0, 500, quiet);
            Motion.To(Extraction, TranslateTransform3D.OffsetZProperty, open ? .12 : 0, 500, quiet);
        }
        public void Dispose()
        {
            if (disposed) return;
            disposed = true; active = false; materialClock.Dispose();
            Yaw.Changed -= OpticalChange; Pitch.Changed -= OpticalChange;
            Front.Changed -= OpticalChange; Rear.Changed -= OpticalChange;
            palette.Changed -= OpticalChange; finish.Changed -= OpticalChange;
            scan.Changed -= OpticalChange;
        }

        Model3DGroup Sheet(Material material, Brush edge)
        {
            var group = new Model3DGroup();
            var face = new MeshGeometry3D();
            foreach (var point in outline) {
                face.Positions.Add(new Point3D(point.X, point.Y, 0));
                face.TextureCoordinates.Add(new Point((point.X + 1.02) / 2.04, (1.4 - point.Y) / 2.8));
            }
            for (int index = 1; index < outline.Length - 1; index++) {
                face.TriangleIndices.Add(0); face.TriangleIndices.Add(index); face.TriangleIndices.Add(index + 1);
            }
            face.Freeze();
            group.Children.Add(new GeometryModel3D(face, material) { BackMaterial = material });

            // A narrow raised rim and a dark edge make thickness visible at a glance.
            var rim = new MeshGeometry3D();
            var side = new MeshGeometry3D();
            for (int index = 0; index < outline.Length; index++) {
                var a = outline[index]; var b = outline[(index + 1) % outline.Length];
                Quad(rim, new Point3D(a.X, a.Y, .016), new Point3D(b.X, b.Y, .016), new Point3D(b.X * .978, b.Y * .984, .016), new Point3D(a.X * .978, a.Y * .984, .016));
                Quad(side, new Point3D(a.X, a.Y, -.025), new Point3D(b.X, b.Y, -.025), new Point3D(b.X, b.Y, .016), new Point3D(a.X, a.Y, .016));
            }
            rim.Freeze(); side.Freeze();
            var rimMaterial = new EmissiveMaterial(edge);
            group.Children.Add(new GeometryModel3D(side, new DiffuseMaterial(new SolidColorBrush(Color.FromRgb(45, 52, 60)))));
            group.Children.Add(new GeometryModel3D(rim, rimMaterial) { BackMaterial = rimMaterial });
            return group;
        }
        static void Quad(MeshGeometry3D mesh, Point3D a, Point3D b, Point3D c, Point3D d)
        {
            int start = mesh.Positions.Count;
            mesh.Positions.Add(a); mesh.Positions.Add(b); mesh.Positions.Add(c); mesh.Positions.Add(d);
            foreach (int index in new[] { 0, 1, 2, 0, 2, 3 }) mesh.TriangleIndices.Add(start + index);
        }
        internal void SetConnected(bool connected, bool quiet)
        {
            this.connected = connected;
            SetEngaged(engaged, quiet);
            double gap = connected ? .065 : .5;
            if (connected && !quiet) {
                int[] times = { 0, 80, 150, 245, 430 };
                Motion.Frames(Front, TranslateTransform3D.OffsetZProperty, times, new[] { Front.OffsetZ, Front.OffsetZ + .1, .045, .09, gap });
                Motion.Frames(Rear, TranslateTransform3D.OffsetZProperty, times, new[] { Rear.OffsetZ, Rear.OffsetZ - .1, -.045, -.09, -gap });
            } else {
                Motion.To(Front, TranslateTransform3D.OffsetZProperty, gap, 340, quiet);
                Motion.To(Rear, TranslateTransform3D.OffsetZProperty, -gap, 340, quiet);
            }
            if (quiet) RefreshMaterial();
        }
        internal void PointAt(double x, double y, bool quiet)
        {
            Motion.To(Yaw, AxisAngleRotation3D.AngleProperty, -24 + x * 13, 220, quiet);
            Motion.To(Pitch, AxisAngleRotation3D.AngleProperty, 11 - y * 9, 220, quiet);
            if (quiet) RefreshMaterial();
        }
    }
}
