using System;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Threading;
using System.Windows;

[assembly: System.Reflection.AssemblyTitle("Codex Plus Companion")]
[assembly: System.Reflection.AssemblyDescription("Windows Companion for Codex Plus")]
[assembly: System.Reflection.AssemblyVersion("0.5.2.0")]
[assembly: System.Reflection.AssemblyFileVersion("0.5.2.0")]

namespace CodexPlusCompanion
{
    internal static class Program
    {
        internal const int RevealMessage = 0x8000 + 43;
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string className, string title);
        [DllImport("user32.dll")] static extern bool PostMessage(IntPtr window, int message, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] internal static extern bool IsWindowVisible(IntPtr window);
        internal static bool RequestReveal(IntPtr window) { return PostMessage(window, RevealMessage, IntPtr.Zero, IntPtr.Zero); }
        [STAThread] static void Main(string[] args)
        {
            System.Windows.Forms.Application.EnableVisualStyles();
            bool first;
            using (var mutex = new Mutex(true, "Local\\CodexPlusCompanion.Desktop." + WindowsIdentity.GetCurrent().User.Value, out first)) {
                if (!first) {
                    var window = FindWindow(null, "Codex Plus Companion");
                    if (window != IntPtr.Zero) RequestReveal(window);
                    return;
                }
                try {
                    if (args.Length > 1 || (args.Length == 1 && args[0] != "--background")) throw new ArgumentException();
                    var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
                    app.Run(new MainWindow(AppConfig.Load(AppDomain.CurrentDomain.BaseDirectory), false, args.Length == 1));
                } catch {
                    MessageBox.Show("无法打开 Codex Plus Companion。请完整解压 release，并检查 companion.config.json 中的本机工作区配置。", "Codex Plus Companion", MessageBoxButton.OK, MessageBoxImage.Error);
                } finally { mutex.ReleaseMutex(); }
            }
        }
    }
}
