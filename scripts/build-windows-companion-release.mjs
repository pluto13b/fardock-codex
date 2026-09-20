import { build } from 'esbuild'
import { mkdir, readFile, writeFile, copyFile, cp, readdir, stat } from 'node:fs/promises'
import { dirname, resolve, join, relative, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { buildDesktopView } from './build-desktop-view.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const configuredOrigin = process.env.CODEX_PLUS_PUBLIC_ORIGIN
if (!configuredOrigin) throw new Error('Set CODEX_PLUS_PUBLIC_ORIGIN to your own HTTPS Gateway before packaging')
const parsedOrigin = new URL(configuredOrigin)
if (parsedOrigin.protocol !== 'https:' || parsedOrigin.username || parsedOrigin.password || parsedOrigin.pathname !== '/' || parsedOrigin.search || parsedOrigin.hash) throw new Error('Invalid public Gateway Origin')
const publicOrigin = parsedOrigin.origin
const source = join(root, 'apps/windows-companion')
const staging = join(root, '.tmp/windows-companion-build')
const name = 'CodexPlusCompanion-0.5.3-win-x64'
const output = join(root, '.tmp/releases', name)
const runtime = join(output, 'runtime')
const compiler = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe'
if (process.platform !== 'win32' || process.arch !== 'x64' || !/^26\./u.test(process.versions.node)) throw new Error('Build requires Windows x64 and Node 26')
await mkdir(staging, { recursive: true })
await mkdir(runtime, { recursive: true })
await mkdir(join(output, 'licenses'), { recursive: true })
await mkdir(join(output, 'scripts'), { recursive: true })
function command(executable, args, options = {}) {
  return new Promise((done, fail) => {
    const child = spawn(executable, args, { cwd: root, windowsHide: true, stdio: 'inherit', ...options })
    child.once('error', fail)
    child.once('exit', code => code === 0 ? done() : fail(new Error(`${basename(executable)} failed: ${code}`)))
  })
}
const result = await build({
  entryPoints: [join(root, 'apps/windows-agent/src/desktop-entry.ts')], outfile: join(runtime, 'companion.cjs'),
  bundle: true, platform: 'node', format: 'cjs', target: 'node26', metafile: true, logLevel: 'info',
  define: { 'import.meta.filename': 'undefined', 'import.meta.dirname': '__dirname' },
})
await copyFile(process.execPath, join(runtime, 'node.exe'))
await copyFile(join(root, 'apps/windows-agent/scripts/dpapi.ps1'), join(output, 'scripts/dpapi.ps1'))
await cp(join(root, '.cache/codex-runtime-0.153.4/package/vendor/x86_64-pc-windows-msvc'), join(runtime, 'codex'), { recursive: true })
await writeFile(join(output, 'companion.config.json'), JSON.stringify({ workspaceRoot: root, origin: publicOrigin }, null, 2) + '\n')
await writeFile(join(output, 'CodexPlusCompanion.exe.config'), '<?xml version="1.0"?><configuration><startup><supportedRuntime version="v4.0" sku=".NETFramework,Version=v4.8" /></startup></configuration>\n')
const sources = (await readdir(source)).filter(file => file.endsWith('.cs')).map(file => join(source, file))
const references = ['System.dll','System.Core.dll','System.Xaml.dll','System.Windows.Forms.dll','System.Drawing.dll','System.Web.Extensions.dll','System.Management.dll','Microsoft.CSharp.dll', ...['PresentationFramework.dll','PresentationCore.dll','WindowsBase.dll'].map(file => `C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\WPF\\${file}`)].map(value => `/reference:${value}`)
const view = await buildDesktopView(source, staging)
const common = ['/nologo','/optimize+','/platform:x64','/codepage:65001','/utf8output', ...references, `/resource:${view},CodexPlusCompanion.MainView.xaml`]
const tests = join(staging, 'ReleaseTests.exe')
await command(compiler, [...common, '/target:exe','/main:ReleaseTests', `/out:${tests}`, ...sources, join(source, 'tests/ReleaseTests.cs')])
const icon = join(staging, 'companion.ico')
await command(tests, ['icon', icon])
await command(compiler, [...common, '/target:winexe', '/main:CodexPlusCompanion.Program', `/win32icon:${icon}`, `/win32manifest:${join(source, 'app.manifest')}`, `/out:${join(output, 'CodexPlusCompanion.exe')}`, ...sources])

// Bundler inputs identify only the dependencies actually shipped. Do not copy
// repository caches, credentials, runtime state, or a whole node_modules tree.
const packages = new Map()
for (const input of Object.keys(result.metafile.inputs)) {
  if (!input.includes('node_modules/')) continue
  let path = dirname(resolve(root, input))
  while (path !== root && path !== dirname(path)) {
    try {
      const data = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'))
      if (data.name && data.version) packages.set(`${data.name}@${data.version}`, path)
      break
    } catch { path = dirname(path) }
  }
}
const notices = []
for (const [label, directory] of packages) {
  notices.push(label)
  for (const file of await readdir(directory)) if (/^(license|licence|copying|notice)(\.|$)/iu.test(file) && (await stat(join(directory,file))).isFile()) notices.push(await readFile(join(directory,file), 'utf8'))
}
await writeFile(join(output, 'licenses/javascript-notices.txt'), notices.join('\n\n'))
await copyFile(join(source, 'assets/lucide/LICENSE'), join(output, 'licenses/lucide-LICENSE'))
await copyFile(join(root, '.upstream/openai-codex/LICENSE'), join(output, 'licenses/codex-LICENSE'))
try { await copyFile(join(root, '.upstream/openai-codex/NOTICE'), join(output, 'licenses/codex-NOTICE')) } catch (error) { if (error.code !== 'ENOENT') throw error }
const nodeLicense = join(root, `.cache/node-${process.versions.node}-LICENSE`)
try { await stat(nodeLicense) } catch {
  const response = await fetch(`https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`)
  if (!response.ok) throw new Error('Cannot obtain Node license')
  await writeFile(nodeLicense, await response.text())
}
await copyFile(nodeLicense, join(output, 'licenses/node-LICENSE'))
await writeFile(join(output, '使用说明.txt'), `Codex Plus 本地服务启动器 0.5.3

三个平台：Windows 笔记本运行本地 Codex；阿里服务器用 Docker 运行 Gateway；安卓手机使用浏览器。

1. 完整解压，双击 CodexPlusCompanion.exe，点击“启动服务”。
2. 等待本机 Codex 和远程通道就绪。
3. 在安卓浏览器打开 ${publicOrigin}，自行登录。若要求配对码，点击 Windows 软件“连接手机”，把窗口显示的 8 位码输入手机网页；五分钟有效，一次使用。
4. 关闭窗口会保留托盘；点击“停止服务”或托盘“退出并停止”才关闭后台。

Windows 窗口只负责启停和必要状态，不含业务管理页面。
已有登录自启设置继续保留，无需在 Windows 中重新设置。

本机工作区：${root}
复用原工作区 .data 中的 Windows 用户授权，请勿删除或复制到其他 Windows 用户。
release 不含身份、密码、任务或日志。软件未代码签名，面向 Windows 10/11 x64，使用系统 .NET Framework 4.8。
包含 Node ${process.versions.node}、官方 Codex CLI 0.153.4、Companion 与许可证；无需 pnpm 或命令行日常启动。
`, 'utf8')
await command(join(runtime, 'node.exe'), [join(runtime, 'companion.cjs'), '--check', '--origin', publicOrigin, '--codex-executable', join(runtime, 'codex/bin/codex.exe'), '--workspace', root])
await command(tests, ['test', output, join(root, '.tmp/windows-release-tests'), join(source, 'tests/fake-backend.cjs')])
await writeFile(join(staging, 'release-path.txt'), output)
console.log(`Release directory ready: ${relative(root, output)}`)
