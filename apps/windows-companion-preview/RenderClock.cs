using System;
using System.Windows.Media;

namespace CodexPlusUiPreview
{
    // WPF may call Rendering twice for one timestamp, or on a 120/144 Hz screen.
    // Preserve the deadline remainder so throttling does not drift down to 48 Hz.
    internal sealed class RenderClock : IDisposable
    {
        readonly Action update;
        long lastTimestamp = -1;
        double nextDueMilliseconds;
        bool disposed;
        internal bool IsRunning { get; private set; }
        internal RenderClock(Action update) { this.update = update; }

        internal bool IsFrameDue(TimeSpan timestamp)
        {
            long ticks = timestamp.Ticks;
            if (ticks == lastTimestamp) return false;
            if (ticks < lastTimestamp) nextDueMilliseconds = 0;
            lastTimestamp = ticks;
            double now = timestamp.TotalMilliseconds;
            const double tolerance = 1; // Allow WPF's millisecond timestamp rounding.
            if (now + tolerance < nextDueMilliseconds) return false;
            double periods = Math.Max(1, Math.Floor((now + tolerance - nextDueMilliseconds) / Motion.FrameMilliseconds) + 1);
            nextDueMilliseconds += periods * Motion.FrameMilliseconds;
            return true;
        }
        void Render(object sender, EventArgs args)
        {
            if (IsRunning && IsFrameDue(((RenderingEventArgs)args).RenderingTime)) update();
        }
        internal void Start()
        {
            if (IsRunning || disposed) return;
            IsRunning = true; CompositionTarget.Rendering += Render;
        }
        internal void Stop()
        {
            if (!IsRunning) return;
            IsRunning = false; CompositionTarget.Rendering -= Render;
        }
        public void Dispose() { disposed = true; Stop(); }
    }
}
