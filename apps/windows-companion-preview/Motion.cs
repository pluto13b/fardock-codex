using System;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Animation;

namespace CodexPlusUiPreview
{
    internal static class Motion
    {
        internal const int FramesPerSecond = 60;
        internal const double FrameMilliseconds = 1000.0 / FramesPerSecond;
        internal static void Begin(DependencyObject target, DependencyProperty property, AnimationTimeline animation)
        {
            if (animation != null) Timeline.SetDesiredFrameRate(animation, FramesPerSecond);
            var element = target as UIElement;
            if (element != null) element.BeginAnimation(property, animation, HandoffBehavior.SnapshotAndReplace);
            else ((Animatable)target).BeginAnimation(property, animation, HandoffBehavior.SnapshotAndReplace);
        }
        internal static void To(DependencyObject target, DependencyProperty property, double value, int milliseconds, bool reduced, bool spring = false)
        {
            double from = (double)target.GetValue(property);
            From(target, property, from, value, milliseconds, reduced, 0, spring);
        }
        internal static void From(DependencyObject target, DependencyProperty property, double from, double to, int milliseconds, bool reduced, int delay = 0, bool spring = false)
        {
            Begin(target, property, null);
            if (reduced || milliseconds == 0) { target.SetValue(property, to); return; }
            // Keep the displayed value until the new WPF clock ticks. Setting
            // the destination first briefly jumps during a reversed animation.
            target.SetValue(property, from);
            var animation = new DoubleAnimation(from, to, TimeSpan.FromMilliseconds(milliseconds)) {
                BeginTime = TimeSpan.FromMilliseconds(delay), FillBehavior = FillBehavior.HoldEnd,
                EasingFunction = spring ? (IEasingFunction)new BackEase { EasingMode = EasingMode.EaseOut, Amplitude = .35 }
                    : new CubicEase { EasingMode = EasingMode.EaseOut },
            };
            Begin(target, property, animation);
        }
        internal static void Frames(DependencyObject target, DependencyProperty property, int[] times, double[] values, bool repeat = false)
        {
            // Key times express anticipation, impact and settling directly.
            Begin(target, property, null);
            target.SetValue(property, values[0]);
            var animation = new DoubleAnimationUsingKeyFrames {
                Duration = TimeSpan.FromMilliseconds(times[times.Length - 1]),
                FillBehavior = FillBehavior.HoldEnd,
                RepeatBehavior = repeat ? RepeatBehavior.Forever : new RepeatBehavior(1),
            };
            for (int index = 0; index < times.Length; index++) {
                animation.KeyFrames.Add(new SplineDoubleKeyFrame(values[index], KeyTime.FromTimeSpan(TimeSpan.FromMilliseconds(times[index])), new KeySpline(.3, 0, .2, 1)));
            }
            Begin(target, property, animation);
        }
        internal static void ColorTo(SolidColorBrush brush, Color color, bool reduced, int milliseconds = 320, int delay = 0)
        {
            ColorTo(brush, SolidColorBrush.ColorProperty, color, reduced, milliseconds, delay);
        }
        internal static void ColorTo(Animatable target, DependencyProperty property, Color color, bool reduced, int milliseconds, int delay)
        {
            Color from = (Color)target.GetValue(property);
            target.BeginAnimation(property, null);
            target.SetValue(property, reduced ? color : from);
            if (reduced) return;
            Begin(target, property, new ColorAnimation(from, color, TimeSpan.FromMilliseconds(milliseconds)) {
                BeginTime = TimeSpan.FromMilliseconds(delay),
                FillBehavior = FillBehavior.HoldEnd, EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut },
            });
        }
    }
}
