using System;
using System.Collections.Generic;
using System.IO;
using System.Web.Script.Serialization;

namespace CodexPlusCompanion
{
    internal sealed class AppConfig
    {
        public readonly string DirectoryPath;
        public readonly string Workspace;
        public readonly string Origin;
        public string NodePath { get { return Path.Combine(DirectoryPath, "runtime", "node.exe"); } }
        public string BackendPath { get { return Path.Combine(DirectoryPath, "runtime", "companion.cjs"); } }
        public string CodexPath { get { return Path.Combine(DirectoryPath, "runtime", "codex", "bin", "codex.exe"); } }
        public string ExecutablePath { get { return Path.Combine(DirectoryPath, "CodexPlusCompanion.exe"); } }
        public string IdentityPath { get { return Path.Combine(Workspace, ".data", "windows-companion", "identity.dpapi"); } }
        public AppConfig(string directory, string workspace, string origin)
        {
            DirectoryPath = Path.GetFullPath(directory);
            Workspace = Path.GetFullPath(workspace).TrimEnd('\\');
            Uri url;
            if (Workspace.Length < 4 || Workspace.StartsWith("\\") || !Uri.TryCreate(origin, UriKind.Absolute, out url)
                || url.Scheme != "https" || url.UserInfo != "" || url.GetLeftPart(UriPartial.Authority) != origin)
                throw new InvalidDataException("配置无效。");
            Origin = origin;
        }
        public static AppConfig Load(string directory)
        {
            var text = File.ReadAllText(Path.Combine(directory, "companion.config.json"));
            if (text.Length > 4096) throw new InvalidDataException("配置过大。");
            var data = new JavaScriptSerializer().Deserialize<Dictionary<string, string>>(text);
            if (data == null || data.Count != 2 || !data.ContainsKey("workspaceRoot") || !data.ContainsKey("origin"))
                throw new InvalidDataException("配置不完整。");
            return new AppConfig(directory, data["workspaceRoot"], data["origin"]);
        }
        public string ReadinessProblem()
        {
            if (!Directory.Exists(Workspace)) return "找不到本机数据工作区，请检查 companion.config.json。";
            if (!File.Exists(NodePath) || !File.Exists(BackendPath) || !File.Exists(CodexPath)
                || !File.Exists(Path.Combine(DirectoryPath, "scripts", "dpapi.ps1")))
                return "软件文件不完整，请完整解压 release 文件夹。";
            if (!File.Exists(IdentityPath)) return "未找到本机设备授权，请保留原工作区的 .data 数据。";
            return null;
        }
        public static string Quote(string value)
        {
            // Windows argv quoting, including quotes and trailing backslashes.
            var result = new System.Text.StringBuilder("\"");
            int slashes = 0;
            foreach (char c in value)
            {
                if (c == '\\') { slashes++; continue; }
                if (c == '"') result.Append('\\', slashes * 2 + 1);
                else result.Append('\\', slashes);
                result.Append(c); slashes = 0;
            }
            result.Append('\\', slashes * 2).Append('"');
            return result.ToString();
        }
        public string BackendArguments()
        {
            return Quote(BackendPath) + " --origin " + Quote(Origin) + " --codex-executable " + Quote(CodexPath)
                + " --workspace " + Quote(Workspace);
        }
    }
}
