using System;
using System.Diagnostics;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Media.Media3D;

namespace CodexPlusUiPreview
{
    // Local optical approximation: only the original synthetic backplate below
    // is sampled. No window/desktop capture and no external images or shaders.
    internal sealed class GlassOptics
    {
        internal const int Width = 192, Height = 256;
        readonly float[] nx = new float[Width * Height], ny = new float[Width * Height], nz = new float[Width * Height];
        readonly float[] thickness = new float[Width * Height], grain = new float[Width * Height];
        readonly float[] sharp, diffuse;
        readonly byte[] pixels = new byte[Width * Height * 4];
        internal readonly WriteableBitmap Surface = new WriteableBitmap(Width, Height, 96, 96, PixelFormats.Pbgra32, null);
        internal readonly BitmapSource Backplate;
        internal double LastRenderMilliseconds { get; private set; }
        internal int RenderCount { get; private set; }

        internal GlassOptics(Point[] outline)
        {
            sharp = new float[Width * Height];
            uint random = 41073;
            for (int y = 0; y < Height; y++) for (int x = 0; x < Width; x++) {
                int index = y * Width + x;
                double u = (x + .5) / Width, v = (y + .5) / Height;
                double px = (u - .5) * 2.04, py = (.5 - v) * 2.8;
                double distance = double.MaxValue, gx = 0, gy = 0;
                for (int edge = 0; edge < outline.Length; edge++) {
                    Point a = outline[edge], b = outline[(edge + 1) % outline.Length];
                    double ex = b.X - a.X, ey = b.Y - a.Y, length = Math.Sqrt(ex * ex + ey * ey);
                    double inwardX = -ey / length, inwardY = ex / length;
                    double d = (px - a.X) * inwardX + (py - a.Y) * inwardY;
                    if (d < distance) { distance = d; gx = inwardX; gy = inwardY; }
                }
                // A quarter-ellipse bevel gives a flat optical centre and curved rim.
                double q = 1 - Clamp(distance / .15, 0, 1);
                double height = Math.Sqrt(Math.Max(.0001, 1 - q * q));
                double slope = Math.Min(1.8, .035 / .15 * q / height);
                double normalLength = Math.Sqrt(1 + slope * slope);
                nx[index] = (float)(-gx * slope / normalLength);
                ny[index] = (float)(-gy * slope / normalLength);
                nz[index] = (float)(1 / normalLength);
                thickness[index] = (float)(.035 * height);
                random ^= random << 13; random ^= random >> 17; random ^= random << 5;
                grain[index] = (float)((random & 65535) / 65535.0 - .5);

                // An abstract etched backing. It is also drawn on the rear sheet.
                double light = .22 + .13 * (1 - v) + .13 * Math.Exp(-Math.Pow((u - .16) / .19, 2));
                if (v > .23 && v < .69) light += .12 * Math.Exp(-Math.Pow((u - .2) / .009, 2));
                if (u > .2 && u < .77) {
                    light += .075 * Math.Exp(-Math.Pow((v - .73) / .006, 2));
                    light += .045 * Math.Exp(-Math.Pow((v - .78) / .004, 2));
                }
                sharp[index] = (float)light;
            }
            // A separable Gaussian is baked once, then bilinearly sampled at runtime.
            diffuse = Blur(sharp, 5.2);
            var backing = new byte[pixels.Length];
            for (int index = 0; index < sharp.Length; index++) {
                byte tone = (byte)(Clamp(sharp[index], 0, 1) * 220);
                backing[index * 4] = tone; backing[index * 4 + 1] = tone; backing[index * 4 + 2] = tone; backing[index * 4 + 3] = 220;
            }
            Backplate = BitmapSource.Create(Width, Height, 96, 96, PixelFormats.Pbgra32, null, backing, Width * 4);
            Backplate.Freeze();
        }

        internal void Render(Vector3D view, double gap, Color tint, double roughness, double clearFront = 330)
        {
            var watch = Stopwatch.StartNew();
            view.Normalize(); roughness = Clamp(roughness, 0, 1);
            double vx = view.X, vy = view.Y, vz = Math.Max(.25, view.Z);
            double airX = vx / vz, airY = vy / vz;
            const double eta = 1 / 1.46, f0 = .034965;
            double tintR = .7 + .3 * tint.R / 255, tintG = .7 + .3 * tint.G / 255, tintB = .7 + .3 * tint.B / 255;
            bool fullyClear = clearFront >= 320;
            for (int y = 0; y < Height; y++) for (int x = 0; x < Width; x++) {
                int index = y * Width + x;
                double localRoughness = roughness;
                if (!fullyClear) {
                    // Same diagonal and local coordinates as the visible scan line.
                    double row = (y + .5) * 280 / Height + ((x + .5) * 210 / Width - 105) * .2126;
                    double revealed = Clamp((clearFront - row + 17) / 34, 0, 1);
                    revealed = revealed * revealed * (3 - 2 * revealed);
                    localRoughness += (1 - localRoughness) * (1 - revealed) * .9;
                }
                double a = nx[index], b = ny[index], c = nz[index];
                double cosine = Clamp(a * vx + b * vy + c * vz, 0, 1);
                double root = Math.Sqrt(1 - eta * eta * (1 - cosine * cosine));
                double bend = eta * cosine - root;
                double tx = -eta * vx + bend * a, ty = -eta * vy + bend * b, tz = -eta * vz + bend * c;
                tz = Math.Min(-.15, tz);
                double sampleX = x + ((gap - thickness[index]) * airX + thickness[index] * tx / tz) * Width / 2.04;
                double sampleY = y - ((gap - thickness[index]) * airY + thickness[index] * ty / tz) * Height / 2.8;
                double clear = Sample(sharp, sampleX, sampleY), frost = Sample(diffuse, sampleX, sampleY);
                double transmitted = clear + (frost - clear) * localRoughness;
                transmitted += (.66 - transmitted) * localRoughness * .24;

                double oneMinus = 1 - cosine, squared = oneMinus * oneMinus;
                double fresnel = f0 + (1 - f0) * squared * squared * oneMinus;
                double rx = 2 * cosine * a - vx, ry = 2 * cosine * b - vy, rz = 2 * cosine * c - vz;
                double highlight = Math.Max(0, -.38 * rx + .55 * ry + .744 * rz);
                double h2 = highlight * highlight, h4 = h2 * h2, h8 = h4 * h4;
                double h16 = h8 * h8, h32 = h16 * h16, h64 = h32 * h32;
                double sheen = h64 * (1 - localRoughness) + h8 * localRoughness;
                double reflected = fresnel * (.36 + sheen * .64) + sheen * .055;
                double grainLight = grain[index] * (.002 + .006 * localRoughness);
                double baseLight = transmitted * (1 - fresnel);
                // Subpixel channel separation is confined to the bevel, not text.
                double dispersion = (Sample(sharp, sampleX + a * .6, sampleY - b * .6) - clear) * (1 - localRoughness) * .25;
                int offset = index * 4;
                pixels[offset] = Tone(baseLight * tintB + reflected + grainLight - dispersion);
                pixels[offset + 1] = Tone(baseLight * tintG + reflected + grainLight);
                pixels[offset + 2] = Tone(baseLight * tintR + reflected + grainLight + dispersion);
                pixels[offset + 3] = 255;
            }
            Surface.WritePixels(new Int32Rect(0, 0, Width, Height), pixels, Width * 4, 0);
            RenderCount++; LastRenderMilliseconds = watch.Elapsed.TotalMilliseconds;
        }
        internal byte[] CopyPixels() { return (byte[])pixels.Clone(); }
        static byte Tone(double value) { return (byte)(Clamp(value, 0, 1) * 255 + .5); }
        static double Clamp(double value, double min, double max) { return Math.Max(min, Math.Min(max, value)); }
        static double Sample(float[] field, double x, double y)
        {
            x = Clamp(x, 0, Width - 1.001); y = Clamp(y, 0, Height - 1.001);
            int ix = (int)x, iy = (int)y, offset = iy * Width + ix;
            double fx = x - ix, fy = y - iy;
            double top = field[offset] + (field[offset + 1] - field[offset]) * fx;
            double bottom = field[offset + Width] + (field[offset + Width + 1] - field[offset + Width]) * fx;
            return top + (bottom - top) * fy;
        }
        static float[] Blur(float[] source, double sigma)
        {
            int radius = (int)Math.Ceiling(sigma * 3);
            var kernel = new double[radius * 2 + 1]; double total = 0;
            for (int k = -radius; k <= radius; k++) { kernel[k + radius] = Math.Exp(-k * k / (2 * sigma * sigma)); total += kernel[k + radius]; }
            for (int k = 0; k < kernel.Length; k++) kernel[k] /= total;
            var horizontal = new float[source.Length]; var result = new float[source.Length];
            for (int y = 0; y < Height; y++) for (int x = 0; x < Width; x++) {
                double sum = 0;
                for (int k = -radius; k <= radius; k++) sum += source[y * Width + (int)Clamp(x + k, 0, Width - 1)] * kernel[k + radius];
                horizontal[y * Width + x] = (float)sum;
            }
            for (int y = 0; y < Height; y++) for (int x = 0; x < Width; x++) {
                double sum = 0;
                for (int k = -radius; k <= radius; k++) sum += horizontal[(int)Clamp(y + k, 0, Height - 1) * Width + x] * kernel[k + radius];
                result[y * Width + x] = (float)sum;
            }
            return result;
        }
    }
}
