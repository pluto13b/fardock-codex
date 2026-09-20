# Docker Gateway 与设备管理面规范

2026-09-09 项目导航验收：项目映射来自官方 thread.cwd 与现有稳定 workspace id，不能依赖用户手动点“加载更多任务”才能发现其余项目。Web 应自动完成活动/归档任务元数据分页，保留首屏及时可用、分页进行/失败/完成的明确状态，拒绝游标循环；只请求任务列表元数据，不预读取全部对话。项目导航应可快速查看/选择全部实际分组，避免单个项目展开的长任务列表遮住后续项目。设备/任务 authority、旧任务 ID 与分组身份保持。

2026-09-07 全会话现场兼容补充：官方 thread/list 的当前页实际包含盘符根目录任务。全本地会话模式应能把由官方元数据给出的合法盘符/UNC 根目录映射为不含完整路径的项目分组，不能由一个根目录任务使整页 remote-rejected。此兼容仅用于已存在任务的 cwd 与动态项目投影；显式工作区配置、设备命名空间、驱动器相对路径、文件路径边界和动作 authority 保持原有拒绝规则。Web 在浏览器授权读取完成前显示“正在恢复设备连接”，只有明确未配对时才显示配对码表单。

2026-09-07 用户明确批准首次连接/恢复入口：Windows 最小启动器增加“连接手机”按钮，只有本机点击才创建五分钟一次性 invitation 并自动批准其有效 join。通过现有已认证 Host WSS 登记 8 位配对码，手机继续 Owner 登录后兑换、保存不可导出设备密钥。该本机邀请来源与已授权 E2EE `/manage` 并列，覆盖之前“只有管理会话能创建自动批准 invitation”的限制；不增加 Windows 管理面板、QR/SAS 或服务器代替 Host 授权。Host 断线/邀请关闭时撤掉对应内存码。

2026-09-07 产品职责校正：Windows 笔记本只运行本地 Codex/Companion 服务及出站连接；本文件的 Docker Gateway 运行在阿里/宝塔服务器；业务客户端是安卓浏览器。Windows 桌面不再承担任务或设备管理界面。该决定不改变现有 Docker、E2EE、Owner 或配对协议。

2026-09-06 范围覆盖：用户已要求正式远程端访问当前 Windows 用户所有项目的 Codex 会话（含归档），不再局限本仓库。复用官方 `thread/list/read/resume` 与现有 E2EE/动作权威；生产 projection 启用全部本地会话，显式包含全部 provider 和已验证 schema 的 source kinds。项目分组由官方 thread.cwd 在 Windows 内生成，只向浏览器给 opaque workspace id 和目录短名称；不上传绝对 cwd。`--workspace` 继续限定 Companion 自身状态/产物目录，不再代表远程会话过滤条件。外部运行中 turn 仍只读，既有已完成任务可按状态复核续聊，P0 控制仍只作用于 Companion-owned turn。本轮不启动/重启或部署任何服务。

> 决策日期：2026-08-30
> 状态（2026-09-05）：D1–D8 与 D9.1–D9.3 已实现并部署，当前进行 D9.4 双浏览器设备恢复/功能验收。第 17 节是当前生产要求，覆盖此前阶段的单设备、二维码、人工 SAS 和尚未部署描述；旧阶段记录用于理解实现边界，不重新执行。新进程从 [`DOCKER_GATEWAY_HANDOFF.md`](DOCKER_GATEWAY_HANDOFF.md) 接手。
> 目标：把 Codex Plus 公网侧打包成标准 OCI 镜像，使任何支持 Docker Compose 的 Linux 系统都能部署；宝塔只是首个管理入口，不成为运行时依赖。

## 1. 结论

Codex Plus 采用“公网 Docker Gateway + Windows Companion”的固定形态：

```text
手机 / 浏览器
    │ HTTPS + WSS :443
    ▼
宿主反向代理（首个目标：宝塔 Nginx）
    │ HTTP/WS -> 127.0.0.1:8787
    ▼
codex-plus-gateway 单容器
    ├── /             正式 Web/PWA
    ├── /pair         配对入口
    ├── /manage       设备与连接管理视图
    ├── /api/ws       E2EE Relay
    └── /healthz      无敏感信息的健康检查
          ▲
          │ Windows 主动建立出站 WSS
          │
Windows Companion
    └── stdio -> Companion 自己启动的官方 codex app-server
```

容器是公网会合点，不是 Codex 执行环境。Windows Companion、官方 `codex.exe app-server`、工作区、Codex 配置和凭据始终留在 Windows 当前用户环境中。

## 2. 产品目标与非目标

### 2.1 目标

- 产出一个标准 OCI 镜像和一份标准 Compose 配置。
- 同一镜像可部署到宝塔、1Panel、Portainer、普通 Docker Compose 或其他兼容环境。
- Web/PWA、配对页、管理视图和 Relay 使用同一 HTTPS origin。
- Windows 不开放入站端口，只向 Gateway 发起出站 WSS。
- 正常运行的 Relay 进程和持久状态只持有路由/授权所需的公开数据，没有会话解密密钥；正式 Web origin 仍是受信代码交付边界，见 5.3。
- 已配对设备可以查看分层连接状态、请求新配对、查看授权设备并执行撤销。
- 容器、反向代理、Windows 或浏览器重启后，不重复执行已经提交的动作。

### 2.2 非目标

- 不在容器中安装或运行 Codex。
- 不把用户代码、工作区、`CODEX_HOME`、SQLite、rollout 或 `auth.json` 挂载到容器。
- 不提供服务器 Shell、文件管理、任意 RPC、任意路径或模型 API。
- 不保存对话、附件明文、代码、命令输出、补丁或离线消息队列。
- 不把宝塔 API、宝塔账号或面板 Cookie交给 Codex Plus。
- 不做宝塔专用插件；首版只交付标准 Docker/Compose 与反向代理说明。
- 不在首版实现多用户、组织、计费、Kubernetes、Redis 或数据库集群。

## 3. 两个管理面的职责

### 3.1 宝塔或宿主管理面

宝塔只负责基础设施：

- 安装和管理 Docker/Compose。
- 启动、停止、更新、回滚 Gateway 容器。
- 配置域名、TLS 证书、80 -> 443 跳转。
- 将 `/` 和 `/api/ws` 反向代理到宿主 loopback 端口。
- 查看容器健康状态、资源占用和经过脱敏的 stdout/stderr。

Codex Plus 不调用宝塔 API。这样可以避免面板版本耦合，也不需要把高权限面板 Token 注入应用。

### 3.2 Codex Plus `/manage`

`/manage` 是正式 PWA 的受信管理视图，只允许已配对设备进入。它不使用生产版 `admin / 123456`，也不建立一套服务器万能管理员账号。

管理视图通过现有认证 WebSocket 与 E2EE 通道读取或执行：

- Gateway/Relay 健康状态。
- Windows Host 在线、离线、重连和最近心跳。
- 当前浏览器到 Relay 的连接状态。
- 端到端 Session 是否 ready。
- Windows Companion 与 app-server 是否兼容、可读、可写。
- 已授权、在线和已撤销设备。
- 设备短标识、公钥指纹、授权 epoch、配对时间和最近在线时间。
- 请求 Windows 生成新的五分钟配对 invitation。
- 重命名设备的本地友好名称。
- 撤销设备并关闭旧连接。
- 查看只含白名单字段的最近连接事件。

管理页不得显示 Relay 无法验证的“Codex 已接受”状态。状态必须分层：

```text
Gateway healthy
    -> Relay socket authenticated
        -> Host online
            -> E2EE session ready
                -> Companion/app-server compatible
                    -> task action accepted
```

D4 只实现上述信息的已认证只读切片，固定使用现有 WebSocket 与应用层 E2EE `manage.read`，不增加 REST 管理 API、服务器管理员账号或 Relay 明文设备目录。Host 在解密并校验当前设备授权后返回一个有界快照：

- `gateway=healthy`、`relaySocket=authenticated`、`host=online`、`e2ee=ready` 只表示本次请求实际穿过对应层并收到 Host 加密响应，不等价于 Codex 动作已接受。
- `companion=online` 表示当前 Host dispatcher 正在服务本次请求；`appServer` 只能是 `compatible`、`read-only` 或 `unavailable`，由 Host 当前 runtime compatibility 决定。
- 设备条目仅含 Host 授权库中的设备 ID/短标识、签名公钥指纹、authorization ID/epoch、active/revoked、配对时间、当前连接 presence 和可空的最近在线时间；不得返回 grant、密钥、路径或任意 metadata。
- presence 是窄状态：当前通过认证的 active 设备可标记 `online`；其他 active 设备没有实时 socket authority 时只能标记 `unknown`，不得猜测在线或离线。
- 最近事件只由本次快照派生并使用固定 category/state 白名单，不建立 Relay 审计数据库，不包含任务正文、提示词、路径、密文或自由文本。
- 响应受既有 canonical frame、generation、seq/ack、host binding 和最大尺寸限制；未配对、撤销、Host 离线、runtime 状态不明确或响应 binding 不匹配时失败关闭。

D4 页面只允许读取和手动刷新。生成 invitation、重命名、撤销、interrupt、问题回答与一次性批准均保持不可执行，严格留给 D5。

## 4. 配对与设备管理权威

### 4.1 新设备配对

1. 当前已授权电脑在 `/manage` 通过E2EE动作请求 Windows Companion 生成五分钟 invitation。
2. 管理页经 owner-authenticated same-origin POST 把 fragment 登记为 8 位配对码；Gateway只在有界内存保存映射。
3. 手机登录同一 owner 后输入短码，兑换成功即删除映射，并在浏览器本地进入既有 `/pair#fragment` E2EE流程。
4. Windows 对这条由已授权管理会话创建的活动 invitation 自动批准；直接/bootstrap/未知 invitation 仍需本机决定或失败关闭。
5. Host 写入本地授权并向 Relay 同步签名授权记录；手机保存自己的不可导出私钥，后续账密登录直接恢复。
6. Relay 保存公开身份、authorization epoch/status/revision，不保存设备私钥、会话密钥、短码或 fragment。

### 4.2 设备撤销

撤销采用 Host-first：

```text
已配对管理页或 Windows 本地 UI
    -> E2EE device.revoke 请求
    -> Windows 先使本地授权失效
    -> Windows 向 Relay 同步 revoked tombstone
    -> Relay 立即关闭该设备的活动 socket
    -> 旧 generation/session/frame 永久失效
```

浏览器不能直接修改 Relay 状态文件。Relay 上的撤销 tombstone 是路由拒绝证据，不替代 Windows 授权真相。

### 4.3 Host 离线

- `/manage` 仍可确认 Gateway 和当前浏览器到 Relay 是否在线。
- Host 状态显示离线与最后心跳，不能伪装成 app-server 可用。
- 需要 Host 签名的配对、撤销和权限动作保持禁用。
- 不使用服务器离线明文队列补发 Codex 动作。

## 5. Gateway 容器边界

### 5.1 容器内包含

- 正式 `apps/codex-web` 构建产物；不得包含 preview fixture。
- R3 Relay 的 production 入口。
- 配对 carrier、设备 challenge/proof、session envelope 路由和 receipt。
- `/manage` 所需的最小 presence/control frame 支持。
- `/healthz`。
- 严格配置解析、结构化脱敏日志和有界资源限制。

首版使用一个镜像、一个 Node 进程、一个内部端口。静态页面和 Relay 同源，避免第二个 Web 容器与跨 origin 配置。

### 5.2 容器内不得包含

- Codex CLI、Codex Desktop 或 app-server。
- OpenAI/Codex 登录态、Cookie、token、`auth.json`。
- Host、浏览器设备私钥、ECDH agreement secret 或 AES session key。
- Windows action journal、approval authority 或本地工作区授权路径。
- 用户工作区、源码、附件明文和任务历史。
- Vite 开发服务器、本机 Demo 登录接口和 `admin / 123456`。

### 5.3 正式 Web 静态资产是信任边界

应用层 E2EE 可以保证 Relay 状态文件、日志、反向代理流量或被动旁路观察者拿不到对话明文，但 Gateway 同时负责交付浏览器 JavaScript。若攻击者可以主动替换正式 SPA，它可以在浏览器解密后窃取内容、调用已配对设备密钥或伪造用户界面。因此首版不得宣称“服务器完全失陷后浏览器正文仍安全”。

生产缓解要求：

- 镜像使用明确版本标签，正式 Web 产物只来自经过测试的同一构建；按用户要求首版不增加独立资产 hash 清单或额外发布仪式。
- 禁止运行时第三方脚本、远程模块、动态分析脚本和未固定 CDN 资源。
- 使用严格 CSP、禁止 inline script/eval，并保持正式/preview 构建隔离。
- 正式资产只来自已通过现有 build/boundary 门禁的同一构建，不再额外生成资产 hash 清单。
- 镜像更新和回滚必须是显式运维动作，不能由网页静默替换自身信任根。

如果未来要抵抗“Gateway 主动投毒 Web 代码”，必须提供与 Gateway 独立签名和分发的受信客户端，例如签名原生壳、浏览器扩展或预安装的离线静态客户端；它不进入首个 Docker 版本。

## 6. 网络、端口与路由契约

### 6.1 端口

| 层 | 监听 | 公网可见 |
| --- | --- | --- |
| 宝塔 Nginx | `0.0.0.0:80/443` | 是；80 只跳转或证书验证 |
| Docker 宿主映射 | `127.0.0.1:8787` | 否 |
| Gateway 容器 | `0.0.0.0:8787` | 仅 Docker/宿主 loopback |
| Windows Companion | 无入站端口 | 否 |

生产服务器安全组不得开放 8787、41744、41745 或 5173。

### 6.2 HTTP/WS 路由

| 路径 | 类型 | 行为 |
| --- | --- | --- |
| `/` | HTTP | 正式 SPA/PWA |
| `/pair` | HTTP | 同一 SPA；秘密只在 fragment |
| `/manage` | HTTP | 同一 SPA；需已配对设备身份 |
| `/api/ws` | WebSocket | Relay challenge、pair/session、E2EE envelope |
| `/healthz` | HTTP | 只返回固定健康字段，不返回设备/版本/连接数 |

反向代理必须：

- 保留 `Host` 与客户端地址的可信代理边界。
- 对 `/api/ws` 使用 HTTP/1.1 Upgrade。
- 关闭 WebSocket buffering，设置合理的长连接 read/send timeout。
- 不缓存 `/api/*`。
- 由 Gateway 对已声明 SPA 路由 `/`、`/pair`、`/manage` 返回正式 index；未知路径继续 404。未来新增任务深链时必须先加入显式路由 allowlist 和测试，不能用无界 fallback 吞掉敏感/拼错路径。
- 不记录 URL fragment；标准 HTTP access log本身不会收到 fragment。

## 7. 持久状态与秘密

### 7.1 唯一必需持久卷

容器内目标路径：

```text
/var/lib/codex-plus/relay-state.json
```

单用户 MVP 继续使用现有 R3 原子状态文件，不引入数据库服务。状态文件只允许保存：

- Host ID、Host device ID、Host signing 公钥和 fingerprint。
- registration closed 标志与 Host authorization revision。
- Client device ID、Client signing 公钥。
- authorization ID、epoch、active/revoked status、revision。
- 撤销 tombstone。

在线 socket、心跳 RTT 和瞬时连接状态只保存在内存。设备友好名称优先保存在 Windows/客户端，由 Host 在 E2EE 管理响应中合并，不写 Relay 日志。

### 7.2 首次 bootstrap secret

- 通过只读 secret 文件挂载，例如 `/run/secrets/relay-bootstrap`。
- 不把 secret 值放入镜像、Compose、普通环境变量或日志。
- 仅 state 尚不存在且 registration 未关闭时允许使用。
- 首个 Host 注册成功并持久化 `registrationClosed=true` 后，使用不挂载 bootstrap secret 的正常 Compose 配置重启。
- 确认正常配置可以从持久状态启动后，再删除宿主 bootstrap 文件；删除或轮换 secret 不得重新开放注册。
- 状态文件损坏、部分写入或版本不明时失败关闭，不能自动清空重建。

### 7.3 同一 bootstrap credential 的 Windows 交付

Host 和 Gateway 必须持有同一份一次性 32-byte bootstrap credential。规范交付路径是由 Windows Companion 生成，而不是由服务器生成后明文复制回 Windows：

1. Windows Companion 的生产 helper 生成 credential，并立即把 Host 副本写入当前用户 DPAPI/CNG 保护存储。
2. helper 另写一个一次性 Gateway secret 文件；文件只允许当前 Windows 用户读取，不在终端打印 credential。
3. 用户通过自己控制的安全通道把该文件复制到服务器 `./secrets/relay-bootstrap`。
4. Gateway 以 bootstrap override 挂载同一文件；Windows 使用 DPAPI/CNG 中的同一值进行首次 Host 注册。
5. Gateway 持久化 registration closed 与 Host 公钥后，Windows 收到已认证注册结果，再删除本地 bootstrap 值并只保留正式 Host 身份/resume 状态。
6. 服务器切换到无 secret 的基础 Compose 并验证可重启后，删除服务器 secret 文件。

两端 credential 不一致必须统一表现为不可枚举的认证失败；不得回退弱口令、重新开放注册或把值放入 URL/二维码。若注册尚未成功且 state 不存在，可以显式重新生成一套；state 已存在或 registration 已关闭时不得换 secret 重新注册。

### 7.4 宿主目录与权限初始化

固定 `user: "10001:10001"` 与 bind mount 需要一个随交付物提供的幂等 Linux 初始化 helper。它必须：

- 拒绝符号链接、设备路径、工作区根或不明确目标。
- 创建 `./data`，owner 为 `10001:10001`、mode 为 `0700`。
- 创建 `./secrets`，owner 为 `root:10001`、mode 为 `0750`。
- 将 bootstrap 文件设为 `root:10001`、mode 为 `0440`，并验证 Gateway 用户可读、其他用户不可读。
- 验证 Gateway 用户可以在 `data` 中 create、fsync、rename 和 reopen 状态文件。
- 重复执行不清空已有 state、不改变 registration 状态、不生成新 secret。

权限或原子写验证失败时 Gateway 不得监听业务端口。宝塔步骤必须先执行该 helper，再启动 Compose。

### 7.5 备份

允许备份 Gateway 配置、Relay 公开授权状态和撤销 tombstone。不得备份对话、附件、Codex profile 或 Windows action 数据。

## 8. 配置契约

非秘密配置可以使用显式环境变量；秘密只使用 `*_FILE`：

```dotenv
CODEX_PLUS_MODE=production
CODEX_PLUS_BIND=0.0.0.0
CODEX_PLUS_PORT=8787
CODEX_PLUS_PUBLIC_ORIGIN=https://gateway.example.com
CODEX_PLUS_TRUSTED_PROXY_IPS=127.0.0.1
CODEX_PLUS_STATE_FILE=/var/lib/codex-plus/relay-state.json
CODEX_PLUS_WEB_ROOT=/opt/codex-plus/web
# 仅首次 bootstrap override 提供：
# CODEX_PLUS_BOOTSTRAP_CREDENTIAL_FILE=/run/secrets/relay-bootstrap
CODEX_PLUS_LOG_LEVEL=info
```

规范：

- `MODE` 只能显式为 production；不得从 `NODE_ENV` 猜测安全模式。
- `PUBLIC_ORIGIN` 必须是一个精确 HTTPS origin，不允许路径、fragment、通配符或 HTTP。
- 浏览器 `Origin` allowlist 默认只包含 `PUBLIC_ORIGIN`。
- `TRUSTED_PROXY_IPS` 是逗号分隔的精确 IP literal 白名单，至少一项且不接受 CIDR、主机名、通配符或转发头自报地址；Gateway 只信任这些直连 peer 设置的固定 `Host` / `X-Forwarded-Proto` / `X-Forwarded-Host`。
- Web 从当前 HTTPS origin 推导 `wss://<host>/api/ws`，不把部署域名编译成协议常量。
- `STATE_FILE` 必须位于持久卷内的绝对路径。
- `WEB_ROOT` 必须是正式 `apps/codex-web` 构建产物的绝对目录；启动时必须存在常规 `index.html`，不得回退到 preview、Vite 或当前工作目录猜测。
- Bootstrap secret 文件权限必须限制为容器运行用户可读。
- `STATE_FILE` 与 bootstrap secret file 在 lexical path 和 realpath/junction 解析后都不得位于 `WEB_ROOT`；任一路径重叠或父目录别名均在监听前失败。
- 未知变量不获得任何额外权限。

## 9. Compose 目标模板

以下是实现目标，不是当前可直接运行的发布物：

```yaml
services:
  gateway:
    image: ${CODEX_PLUS_GATEWAY_IMAGE:?set-a-pinned-image}
    container_name: codex-plus-gateway
    restart: unless-stopped
    init: true
    user: "10001:10001"
    read_only: true

    ports:
      - "127.0.0.1:8787:8787"

    environment:
      CODEX_PLUS_MODE: production
      CODEX_PLUS_BIND: 0.0.0.0
      CODEX_PLUS_PORT: "8787"
      CODEX_PLUS_PUBLIC_ORIGIN: ${CODEX_PLUS_PUBLIC_ORIGIN:?set-public-origin}
      CODEX_PLUS_TRUSTED_PROXY_IPS: ${CODEX_PLUS_TRUSTED_PROXY_IPS:?set-trusted-proxy-ips}
      CODEX_PLUS_STATE_FILE: /var/lib/codex-plus/relay-state.json
      CODEX_PLUS_WEB_ROOT: /opt/codex-plus/web
      CODEX_PLUS_LOG_LEVEL: info

    volumes:
      - ./data:/var/lib/codex-plus

    tmpfs:
      - /tmp:size=16m,noexec,nosuid,nodev

    cap_drop:
      - ALL

    security_opt:
      - no-new-privileges:true

    healthcheck:
      test:
        - CMD
        - node
        - -e
        - "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s

```

首次安装额外使用一次性 override；正式交付必须提供等价的 bootstrap helper，不能要求用户把 secret 永久留在基础 Compose 中：

```yaml
# compose.bootstrap.yaml
services:
  gateway:
    environment:
      CODEX_PLUS_BOOTSTRAP_CREDENTIAL_FILE: /run/secrets/relay-bootstrap
    volumes:
      - ./secrets/relay-bootstrap:/run/secrets/relay-bootstrap:ro
```

首次运行：

```text
docker compose -f compose.yaml -f compose.bootstrap.yaml up -d
```

Host 注册成功后，先停止该组合，再只使用基础 `compose.yaml` 启动并验证 registration 仍关闭，最后删除 bootstrap secret 文件。

镜像发布后必须使用明确版本 tag；不得在生产文档中默认 `latest`。按用户要求不额外实现 digest/hash 核验层。

## 10. 镜像构建规范

- 使用多阶段 Dockerfile。
- Builder 只安装锁文件确定的依赖，执行正式 Web build、Gateway build、测试和边界检查。
- Runtime 镜像只复制正式静态产物、编译后的 Gateway 和必需 production dependencies。
- Runtime 使用非 root 固定 UID/GID。
- 根文件系统只读；只有 `/var/lib/codex-plus` 和受控 `/tmp` 可写。
- 不把 `.git`、`.env*`、`.data`、`.tmp`、`.cache`、测试 fixture、证书、密钥或本机日志复制进镜像。
- 正式 SPA 不引用运行时第三方脚本/CDN，并通过现有正式/preview 隔离、严格 CSP/无 eval 与 DSH boundary 门禁；首版不另造资产 hash 清单。
- 首个必需目标为 `linux/amd64`；验证后可增加 `linux/arm64`，业务协议不得依赖 CPU 架构。
- 镜像必须提供版本、commit 和 protocol version 的非秘密 OCI label，但 `/healthz` 不必公开这些信息。

## 11. 日志与可观测性

### 11.1 允许日志字段

- 时间。
- 事件类别。
- 哈希化设备短标识。
- request ID。
- authorization epoch/revision。
- 结果码。
- 耗时和字节数。
- 限流、背压和连接生命周期状态。

### 11.2 禁止日志字段

- 对话、提示词、推理、代码、命令、补丁。
- 附件名称、内容、缩略图和解密大小摘要。
- 完整路径、工作区、Codex Home。
- 公私钥原文、credential、Cookie、token、二维码 fragment。
- WebSocket ciphertext 原文。

Docker/宝塔直接采集 stdout/stderr；首版不额外挂载日志卷。日志轮换由 Docker/宿主负责。

## 12. 故障、恢复与更新

### 12.1 Gateway 重启

- 严格加载 Relay state；损坏则不监听业务端口。
- Host/Client 重新 challenge/proof，不重用可重放的长期 bearer token。
- 端点用持久 generation、seq/ack 和 raw frame恢复，不生成重复动作。
- 在线 presence 从新连接重建，不把重启前在线状态当真。

### 12.2 Windows 离线或睡眠

- Relay 保持在线但 Host 显示 offline。
- 浏览器动作返回 unavailable，不进入服务器离线队列。
- Windows 恢复后主动重连并重新建立端到端 Session。

### 12.3 更新与回滚

- 更新前备份状态文件和当前 Compose/config。
- 新镜像先通过 `/healthz` 和 protocol compatibility 检查。
- 协议不兼容时拒绝写动作并保留只读/离线状态。
- 回滚镜像必须能读取同一状态版本；涉及状态迁移时先提供 create-new 备份和明确回滚路径。

## 13. 宝塔接入规范

宝塔部署只执行标准操作：

1. 在 Docker/容器编排中导入 Compose。
2. 运行随发布物提供的幂等权限 helper，创建并验证 `data/`、`secrets/` 的 UID/GID/mode；不得由容器入口以 root 临时修权限。
3. Windows Companion helper 生成 bootstrap credential，保存 DPAPI/CNG Host 副本并导出一次性 Gateway 文件。
4. 通过用户控制的安全通道把 Gateway 文件复制到服务器，重新运行权限 helper 验证 `root:10001/0440` 与 Gateway 可读性。
5. 使用基础 Compose + bootstrap override 启动 Gateway，先从宿主验证 `127.0.0.1:8787/healthz`。
6. 建立 `gateway.example.com` 站点并签发精确覆盖该域名的 TLS 证书。
7. 反向代理到 `http://127.0.0.1:8787`，为 `/api/ws` 启用 WebSocket Upgrade。
8. 配置已声明 SPA 路由转发、HTTPS 跳转、HSTS、请求体上限和长连接 timeout；未知路径保持 Gateway 404。
9. 应用公网入口的安全组只开放 80/443。宝塔面板端口默认不向公网开放，优先经 VPN/SSH 隧道访问；若运维条件确实要求直连，必须使用独立安全组规则只允许固定来源 IP，并同时启用强认证和二次验证。
10. Windows Companion 使用 DPAPI/CNG 中的同一 bootstrap credential 连接 `wss://gateway.example.com/api/ws`。
11. Host 注册关闭后改用不挂 secret 的基础 Compose 重启，确认不会重新开放注册，再清除 Windows bootstrap 值和服务器文件。

官方参考：

- [宝塔 Docker 文档](https://docs.bt.cn/category/docker)
- [宝塔容器编排说明](https://www.bt.cn/bbs/thread-140412-1-1.html)
- [宝塔反向代理与 WebSocket](https://docs.bt.cn/user-guide/site/php/site-config/reverse-proxy)

## 14. 实现任务分解

| 阶段 | 任务 | 主要产物 | 完成标准 |
| --- | --- | --- | --- |
| D0 | 文档冻结 | 本文及架构/安全/部署同步 | 无职责或安全漂移 |
| D1 | Production Gateway 入口 | 配置 schema、独立 CLI、静态服务、`/api/ws`、`/healthz` | 以普通进程完成 production/local-test 隔离与本机 E2EE read |
| D2 | 公网 Relay transport | HTTPS origin、WSS carrier、可信代理和限流 | 经测试 TLS 反代完成浏览器/Windows WSS 握手 |
| D3 | 端点持久化 | Web IndexedDB；Windows DPAPI/CNG；bootstrap helper；generation/seq/raw frame store | 双端重启不重配、不重复动作；同一 bootstrap credential 安全交付 |
| D4 | 管理只读面 | `/manage`、分层状态、设备列表和 presence | 无服务器明文/任意管理 API |
| D5 | 设备与 P0 控制动作 | `pairing.create`、`device.rename`、`device.revoke`；interrupt；question answer；approve-once/deny | Host-first 撤销；live request authority；每个动作最多消费一次 |
| D6 | Docker 交付 | Dockerfile、`.dockerignore`、Compose、bootstrap/权限 helper | 非 root、只读根、可写卷权限、loopback host port、健康检查 |
| D7 | Debian/VMware 闸门 | 容器 + Nginx TLS/WSS、重启、切网、限流、日志扫描 | 全矩阵通过，无正文/秘密落盘 |
| D8 | 宝塔上线 | 域名、证书、反代、备份/回滚记录 | 仅 80/443；手机与 Windows 闭环通过 |

### D1 最小纵向验收

D1 不等待 Dockerfile、TLS 或管理面。它必须先证明：

1. 独立 Gateway CLI 以显式 production 配置启动，不复用 `local-runner`。
2. 同一进程提供正式 Web、`/api/ws` 与无敏感 `/healthz`。
3. 注入的本机测试 Browser/Host transport 完成认证 E2EE workspace/task read。
4. production 与 `r3-local-test` 构造、配置和健康输出互相隔离。
5. Gateway 进程日志扫描无正文、路径、token 或 pairing secret。

D1 本轮实现契约固定如下：

- production 与 `r3-local-test` 使用两个显式 factory/入口，但复用同一个 R3 challenge、pair/session、authorization、路由、限流和背压核心；不得复制第二套 Relay 状态机。
- production 配置必须逐项提供 `MODE/BIND/PORT/PUBLIC_ORIGIN/STATE_FILE/WEB_ROOT/LOG_LEVEL`；只读取命名的 `CODEX_PLUS_*` 字段，不从 `NODE_ENV`、当前目录或 Vite 配置推断。
- production WebSocket 必须携带且精确匹配 `PUBLIC_ORIGIN`；`/api/ws` 以外的 Upgrade、缺失 Origin 和额外 Origin 一律拒绝。D2 已实现公网 `wss` carrier 与反向代理可信边界；D1 注入 socket 测试继续作为较低层回归保留。
- 同一 HTTP server 只为显式 `/`、`/pair`、`/manage` 提供正式 index，并提供 favicon、构建 `assets`、第三方许可、`/api/ws` 和固定 `{"status":"ok"}` 的 `/healthz`。未知路径和其他 `/api/*` 均 404，不增加 REST/RPC；静态文件只允许 `GET/HEAD` 且不能逃出或经符号链接逃出 `WEB_ROOT`。
- state 尚不存在时必须提供有效 bootstrap secret 文件，否则监听前失败；registration 已关闭时允许不再挂载 secret。损坏/未知 state、无效 secret 文件和静态根不完整都在监听前失败关闭。
- D1 聚焦纵向使用真实 canonical E2EE `task.read` request/response、真实 Relay device challenge/authorization 与新 Gateway `/api/ws`；Relay receipt 仍只证明 `relayed`，不能完成业务请求。

D2 HTTPS/WSS 已通过本机 TLS 反代验收；D3 负责跨重启端点状态，D6 负责把已验证进程打成镜像，D7 才负责容器、Nginx、TLS 与重启组合验收。前一阶段不得引用后一阶段产物作为完成证据。

### D2 已通过最小纵向验收

D2 不让 Gateway 自己终止公网 TLS；TLS 仍由受信反向代理终止，Gateway 保持内部 HTTP/WS。实现和验收固定如下：

1. Web pairing runtime、已授权 Client carrier 与 Windows Host carrier 分别新增显式 `production` 构造，只接受同一精确 HTTPS origin 对应的 `wss://<host>/api/ws`；现有 `r3-local-test` 构造继续只接受数值 loopback `http/ws`。
2. Gateway 对正式 SPA 请求和 `/api/ws` Upgrade 复核直连 peer 位于 `TRUSTED_PROXY_IPS`，并要求 `Host == PUBLIC_ORIGIN.host`、`X-Forwarded-Proto == https`、`X-Forwarded-Host == PUBLIC_ORIGIN.host`；不读取或信任 `X-Forwarded-For` 作为认证 authority。
3. 本机测试使用工作区 `.tmp/` 内运行时生成的短期 TLS 证书和最小反向代理，真实完成 Browser-compatible WSS carrier → Gateway → Windows Host WSS carrier → genuine E2EE `task.read`。测试代理不是发布物，也不替代 D7 Nginx。
4. 错误 CA、`ws://` production URL、跨 origin WSS、缺失/伪造转发头、非可信 proxy peer、错误 Origin、query Upgrade、无认证与超限帧均失败关闭。
5. TLS/WSS 链路仍区分 Relay `relayed` 与 Windows encrypted business response；只有后者可以完成 `CodexServeClient` 请求。
6. D2 只证明真实 TLS/WSS transport 与代理边界。浏览器刷新、Windows/Gateway 进程重启后不重配、不复用 nonce 和不重复动作属于 D3，不得由本轮 ephemeral 测试冒充完成。

### D3 已通过端点持久化契约

D3 只补平台持久化与恢复，不改变 D1/D2 Gateway、Relay wire 或前端布局：

- Web 使用原生 IndexedDB structured clone 保存 `extractable:false` 的长期 agreement/signing private `CryptoKey`、已验证 grant 和 generation high-water；禁止 private JWK/PKCS#8、localStorage、字符串化私钥或新依赖数据库包装层。
- Web 同一 IndexedDB 事务持久化当前 generation 的 next outbound seq、max sent、last inbound、last peer ack 与最多 16 帧/8 MiB 未确认 canonical raw envelope。reserve、commit 和 ack-delete 保持现有 E2EE adapter 两阶段边界。
- Windows 生成短暂可导出的 P-256 key bytes 后立即经当前用户 DPAPI 保护，明文字节随即清零；持久 blob、Windows action SQLite 和测试输出只位于工作区 `.data/.tmp`。正式运行代码不把 private key、bootstrap credential 或解密正文放入参数、环境变量、日志或普通 JSON 文件。
- Windows Host authorization/generation reservation 复用并扩展现有 durable authority：每次 `session.init` 在返回 accept 前原子烧掉 generation，并持久拒绝 handshake id/client nonce 重放；进程重启不得从 1 重新开始。
- AES session key、临时 ECDH key、pairing secret 和未完成 pairing session 仍只在内存。浏览器或 Companion 进程重启必须以持久长期 identity 完整新握手；旧 generation raw frame 仅作为不可重复执行/恢复证据保留，不能在新 generation 下重新加密或篡改重发。
- Windows bootstrap helper 一次生成同一 32-byte credential：Host 副本进入 DPAPI blob，Gateway 文件 create-new 导出且 ACL 仅允许当前用户；不得打印值。Host 注册确认后删除 DPAPI 中 bootstrap 值，Gateway 导出文件由后续部署步骤显式清理。
- 状态缺失、损坏、版本未知、CryptoKey 可导出/usage 错误、DPAPI 解密失败、generation 回退、seq gap、raw frame 缺失或 authorization lineage 不匹配均失败关闭；不自动清空重配或伪造恢复成功。

### D4 已通过管理只读面契约

D4 采用一条最小纵向：协议新增 `manage.read`，Windows Host 从当前已验证会话、runtime compatibility 与授权库生成只读快照，正式 Web 的 `/manage` 用同一个 paired `CodexServeClient` 渲染。Relay 仍只路由密文，不解析、保存或拼装管理数据。

验收必须同时证明：已配对链路可以看到六层状态、active/revoked 设备和白名单事件；正式未配对 `/manage` 保持在现有配对等待页且不显示设备数据；360px 页面无横向溢出；任何 D5 动作均未开放。D4 不以 preview fixture 冒充生产链路，preview 只用于独立视觉回归。

### D5 已通过设备与 P0 控制契约

D5 继续使用同一认证 WebSocket 与 E2EE application channel，不增加 REST 管理接口或服务器管理员。三个设备动作均携带唯一 `actionId` 与 expected Host generation；rename/revoke 还必须回显 D4 快照中的 `deviceId + authorizationId + authorizationEpoch`：

- `pairing.create` 只能请求在线 Windows 生成一个最长五分钟、一次性的 invitation。fragment 只出现在 Host 加密响应和用户可见的 `/pair#...` 链接中；Relay receipt、日志和 HTTP URL 不得获得它。同一 action 重试在 invitation 有效期内返回原结果，不重复生成。
- `device.rename` 只修改 Windows DPAPI 授权记录中的 1–80 字符友好名称，不写 Relay，不改变设备密钥或 epoch。目标、epoch 或 action payload 不一致时拒绝。
- `device.revoke` 不允许远程设备撤销自身；自撤销只能从 Windows 本地 UI 发起。远程撤销必须先在 Windows 原子写入 revoked 与新 epoch/revision，再向 Relay 同步 tombstone；Relay 同步失败不得回滚本地撤销，只能返回 queued/待同步，后续 Host 连接继续以 Windows 状态为真。

P0 控制仅适用于 Windows Companion 自己托管的 app-server 和它自己创建、仍拥有的 active turn，不能附着、注入、关闭或中断 Codex App/VS Code 的进程或任务：

- `turn.interrupt` 必须匹配当前 authoritative task revision、active turn id 与 durable `canInterrupt`，经现有 action lease 最多执行一次；结果不明确时保持 blocked/queued，不自动重试。
- app-server command/file/permission approval 与 `request_user_input` 先经固定版本 strict projection 生成 live request。正文 authority 固定绑定 `hostId + generation + taskId + turnId + requestId + nonce + issuedAt + expiresAt`，broker 还绑定首次读取它的已认证 client device/authorization；未知 method/shape、secret question、跨设备、错任务、过期或重复响应一律拒绝。
- command/file 的 `approve-once` 只映射 app-server 单次 `accept`，永不映射 session-wide；permission 只回显本次请求的 exact profile 且 scope 固定 `turn`；deny 使用 `decline` 或空权限。question answer 只接受已声明 question id、选择项与允许的 freeform。
- live request authority 只存在于持有该 app-server child 的 Companion 进程。Companion 崩溃会终止自己持有的 child，未决请求随之失效；重启后的旧 browser response 必须得到 request-not-found，而不是重放。

本轮用户已明确要求不打断正在运行的 Codex App。D5 自动验收只使用仓库内 fake app-server 与本项目自行创建/持有的测试进程；任何真实 app-server smoke 必须另行征得用户同意。

### D6 Docker 交付实施契约

D6 只增加一套最小、可运行的标准交付物：多阶段 `Dockerfile`、严格 `.dockerignore`、基础 `compose.yaml`、一次性 `compose.bootstrap.yaml`、非秘密 `.env.example` 和幂等宿主权限 helper。Builder 执行锁文件安装、正式 Web build/边界门禁并把 production Gateway 打成单文件 Node bundle；runtime 只含该 bundle、正式 Web 与 Node runtime，不含 Codex、Windows Agent、preview fixture、测试源码或本地状态。

受限网络构建器可以通过非秘密 build arg `CODEX_PLUS_NPM_REGISTRY` 同时指定 Corepack 与 pnpm registry；默认仍为 npm 官方 registry。该参数只存在于 builder stage，不进入 runtime 配置或镜像中的应用状态。

2026-09-05 构建修正：builder 单独使用 pnpm isolated linker，使 `--filter @codex-plus/web... / @codex-plus/relay...` 只安装 Gateway 所需依赖。原 workspace hoisted linker 在过滤安装时仍从全仓锁文件下载旧 Expo 依赖，已在受限服务器实际触发 ENOSPC。锁文件与 Windows 开发环境不变，正式 build/test/boundary 继续在 builder 执行。

Compose 固定 non-root `10001:10001`、只读根、loopback `127.0.0.1:8787`、capabilities 全 drop、`no-new-privileges`、受控 `/tmp` tmpfs、唯一 `./data` bind mount 和固定 `/healthz` 检查。bootstrap secret 仅在 override 中以只读单文件挂载。helper 在用户无 sudo 但有 Docker 权限时使用同一 Gateway 镜像的短命 root 容器设置宿主 owner/mode，再以 UID 10001 容器完成 create/fsync/rename/reopen；它不生成、读取或打印 secret 内容，不清空已有 state。

本机没有 Docker CLI，因此源码/静态门禁在 Windows 完成，真实 `linux/amd64` build/run 由用户已授权的 `ssh gateway-host` 当前用户 Docker 权限完成。D6 远程验证只能使用隔离的工作目录和 loopback 测试端口，不改 Nginx/DNS/TLS，不重启服务器，也不使用 mihomo；这些外部入口仍属于 D7/D8。

### D7 实际 Linux/Nginx 闸门实施契约

用户已授权直接在最终阿里服务器推进 D7–D8，因此 D7 不再额外搭建 VMware 副本，而在实际 `linux/amd64` Docker 26 + Nginx 1.30 环境用独立目录、独立 vhost 和临时 D7 状态执行同一套更严格矩阵。该替代不改变阶段顺序：D7 只证明容器、TLS/WSS、代理边界、重启/重连、限流与脱敏日志；D8 才使用 Windows DPAPI helper 生成的正式同值 bootstrap，登记真实 Host、关闭注册并完成手机/Windows 闭环。

D7 的仓库产物保持最小：一个可审阅的 Nginx vhost 模板和一个不持有生产秘密的链路验证入口。服务器只新增 Codex Plus 精确部署目录/vhost，Gateway 仍只发布 `127.0.0.1:8787`；Nginx 必须覆盖 `Host`、`X-Forwarded-Proto=https` 与 `X-Forwarded-Host`，只在精确 `/api/ws` 设置 HTTP/1.1 Upgrade，关闭 WS buffering，设置有界请求体/连接/timeout，并把页面请求交给 Gateway 的显式 SPA 路由 allowlist。实际 Docker bridge peer IP 经只读探测后写入显式 `TRUSTED_PROXY_IPS`，不信任 `X-Forwarded-For`。

D7 至少验证：精确证书和 HTTP→HTTPS；`/`、`/pair`、`/manage` 与固定 `/healthz`，同时未知页面路径 404；正确 WSS Upgrade；错误 Origin、Host/proto、query Upgrade、未认证/超限连接失败；公网 8787 不可达；只重启本项目容器与 reload Nginx 后恢复；服务/卷/日志扫描不含测试正文、secret、私钥或工作区路径。D7 可以使用一次性随机测试 bootstrap 和合成协议端点，但验证结束必须停止测试容器并删除测试 secret/state；不得启动或控制 Codex App/VS Code。

上述 D7 外部前置已解除：`gateway.example.com` 的精确 A 记录、Let's Encrypt 证书和独立 Nginx vhost 已落地，公网 edge、合成 E2EE 与无 bootstrap Gateway 重启矩阵通过；D7 临时 Host secret/state 已删除。

### D8 正式上线实施契约

D8 新增一个独立 `production-runner`，不改名复用 `local-runner`。命令只接受精确 HTTPS origin、当前工作区绝对路径和本地盘符限定的绝对 `codex.exe`；workspace 与 executable 可以分别位于 D/C 盘，但 child 与严格 `--version` probe 必须使用同一个 exact executable。runner 固定从工作区 `.data/windows-companion/` 打开 DPAPI identity、action SQLite/anchor 和附件目录，从 `.tmp/windows-companion/` 生成短时 pairing QR。它只启动、监督和终止自己持有的 stdio app-server child，不查找、附着、关闭或重启 Codex App/VS Code，也不枚举环境变量或读取凭据文件。

生产写能力必须先补齐两个当前缺失的适配器：canonical request fingerprint 使用 DPAPI identity 内单独生成的 32-byte HMAC key；action SQLite 每次事务递增的 `storeId + stateRevision` 由独立当前用户 DPAPI anchor 校验。创建、正常 reopen、DB/anchor rollback、崩溃间隙与替换不明确均失败关闭；runner 关闭前等待所有已进入的 anchored boundary 完成。只有本机显式恢复且验证同一 store、数据库 revision 向前、动作表为空时，才允许修复已知只读 crash-gap；存在任一动作记录继续拒绝。在两项未通过测试前 runner 只能读。Host carrier 还需一次性 unexpected-disconnect signal，runner 才能以封顶退避重建 socket/runtime 和新 generation；不在旧 generation 自动重发动作。同一 Companion 进程可对已完成 DPAPI/签名验证的同一 `hostId + clientDeviceId + authorizationId + epoch` 缓存最小 claims；后续请求只做 exact authority 比对，任何 identity/epoch 变化、撤销、进程重启或重新配对均丢弃缓存并重新打开 DPAPI，不允许跨授权复用。

首次正式流程固定为：Windows bootstrap helper create-new identity/导出 Gateway 文件；安全复制到新的生产部署根；bootstrap Compose 启动；同一 Windows signing identity 完成 Host 注册后清除 DPAPI bootstrap；服务器改用基础 Compose重建并删除 Gateway 文件；runner 生成仅本机可读且五分钟后删除的 QR。手机必须在 join 发出后、Windows 批准前显示本地计算的 SAS 与 client signing fingerprint；Windows 终端同时显示设备名、同一 fingerprint 与 SAS，用户逐项核对后输入精确批准。invitation/QR 不进入普通日志、命令参数、剪贴板自动上传或服务器。

D8 首个最小生产闭环只宣称一个 active Web/PWA 设备：`manage.read`、workspace/task list/read、已完成既有任务的 `turn.send/steer/interrupt` 和该 Companion-owned turn 的 approve-once/deny/非 secret question。生产 task read 先用 `thread/read(includeTurns=false)` 验证任务仍属于授权 workspace，再以有界 `thread/turns/list` 分页读取最近窗口；不得对长任务请求无界完整历史而撞穿 app-server JSONL/E2EE frame 上限。分页明确到达 `nextCursor=null` 且没有兼容性遗漏时，该投影视为完整并可按既有 runtime/状态复核开放 send；达到页数/消息预算上限或发现遗漏时保持 partial/read-only。远程 `task.start` 在 durable start authority 尚未生产化时保持禁用；第二 active authorization 的跨 runner 重启路由尚未实现，因此管理面暂不开放新增第二设备。二者不得用内存 map 或 Demo ownership 假装完成，也不阻塞一个 Host + 一个手机的首个可用 D8。

正式管理页在 Host 未提供 `pairing.create` 时必须直接禁用“生成配对邀请”并说明当前 Host 暂未开放新增设备，不能先展示可点击按钮再依赖远端拒绝。Preview fixture 可以显式开启该按钮用于纯本地 UI 演示。

D8 验收必须包含：真实 Windows DPAPI identity 和 action anchor 跨进程；正式 Host bootstrap 后无 secret Gateway 重启；手机扫码 + Windows 显式 SAS 确认；公网 E2EE 管理/读取与至少一次明确用户授权的安全写纵向；Gateway、Companion 和浏览器分别重连不重配、不重复动作；生产 state/log/备份只含允许的最小数据；证书续期 dry-run 与明确回滚步骤。任何需要操作正在运行的 Codex App/VS Code 的做法不属于验收。

手机配对入口按用户确认的最终交互执行：用户先访问正式首页，点击“扫码配对”后网页请求后置相机并本地扫描电脑端 Companion QR；不是要求用户先离开站点调用系统扫码器。Gateway 的 production headers 因此只对同源页面开放 camera，扫描帧不出设备；识别出的链接仍须精确绑定当前 origin 与 `/pair#fragment` 后才进入既有 E2EE pairing。

## 15. 生产验收矩阵

### 15.1 部署可移植性

- 同一 Compose 可在普通 Docker Compose 与宝塔容器编排启动。
- 除域名、镜像、secret 文件和持久目录外不需要平台特有参数。
- 应用不调用宝塔 API。

### 15.2 网络

- 应用域名/公网扫描只看到预期的 80/443；8787 不可公网访问。宝塔面板要么不暴露公网并经 VPN/SSH 隧道访问，要么只对单独的固定来源 IP 白名单可见，不能成为全网开放端口。
- 错误 Origin、非 TLS 浏览器入口、无认证 WebSocket 均失败。
- WebSocket Upgrade、长连接、切换 Wi-Fi/蜂窝和代理重启均可恢复。

### 15.3 身份与设备

- 第二次或并发 Host bootstrap 均拒绝且不可枚举。
- 未经 Windows 明确批准的设备不能读取任务元数据。
- 撤销后旧 socket、旧 authorization epoch 和旧 generation 立即失效。
- `/manage` 不能给外部设备伪造 active authorization。

### 15.4 E2EE 与动作

- Relay/宿主文件扫描不能恢复对话、附件或工作区路径。
- 明确记录正式 Web origin 是受信代码交付边界；不得宣称 E2EE 能抵抗 Gateway 主动替换浏览器 JavaScript。
- Relay receipt 不能被 UI 当作 Codex accepted。
- Relay/Windows/浏览器任一层重启不会重复 turn、steer 或 approval。
- 未知 schema、task owner、approval authority 或 generation 保持只读。
- interrupt、question answer 与 approve-once/deny 均绑定 live task/turn/request/nonce；重复、过期或错任务请求不能执行。

### 15.5 容器

- 非 root 运行、capabilities 全部 drop、`no-new-privileges`、只读根文件系统。
- 只有声明的数据目录与 tmpfs 可写。
- 全新宿主运行初始化 helper 后，UID/GID/mode 正确；Gateway 用户能原子写 state 且只能读取明确 bootstrap 文件。
- 删除并重建容器后，挂载卷中的公开授权/撤销状态保持；对话不存在于卷中。
- 健康检查不返回设备、配置、路径或版本细节。

## 16. 当前代码与目标之间的明确缺口

当前实现仍不能直接宣称公网闭环完成：

- D1 已新增独立 production Gateway profile/CLI、正式静态服务器、固定 `/healthz` 与精确 Origin `/api/ws`；`r3-local-test` factory 仍只接受数值 loopback，未被放宽。
- Web carrier、pairing runtime 和 Windows Host carrier 已有运行时隔离的 production HTTPS/WSS profile；local-test 仍锁定数值 loopback `http/ws`。
- D6 镜像与 D7 实际公网闸门已通过；D8 正式 Host/手机闭环完成前，该入口仍不能视为产品上线完成。
- 本机 `local-runner` 把 Relay、Demo 登录和 Windows app-server 组合在一个测试进程中。
- `admin / 123456` 只允许本机 Demo，必须从生产镜像和路径中排除。
- 浏览器 IndexedDB 与 Windows DPAPI identity/generation/seq/raw-frame 已完成本机验收，D7 也完成公网 Gateway 重启恢复；生产 Companion 入口、DPAPI action HMAC/SQLite anchor 和 Windows 进程重启仍属于 D8。
- D4 已通过 E2EE `manage.read` 提供 `/manage` 六层状态、Host 授权设备列表和白名单事件；Relay 没有获得明文或新增任意管理 API。
- D5 已接通 `pairing.create/device.rename/device.revoke`、Host-first Relay tombstone、Companion-owned interrupt 和 command/file/permission approve-once/deny 与非 secret question answer；当前远程设备不能自撤销，session-wide approval 不存在。
- 按用户明确要求，D5 未启动或操作真实 Codex App/app-server；P0 自动验收使用仓库 fake child。真实 app-server 复验需后续单独授权，不能把本轮描述为已触碰当前运行任务。

因此下一步严格是 D8 正式 bootstrap/Host/生产 Companion/手机闭环；仍不能用 D7 合成端点声称公网生产完成。

## 17. D9 单一 Owner 账户、单 Host 多浏览器设备与完全访问

用户于 2026-09-03 将产品目标从“单 Host、单浏览器设备”调整为“一个 owner 账户登录后，在电脑浏览器和手机浏览器等多个设备上管理同一台 Windows Host 的 Codex 对话”，并明确要求 production 开放 `full-access`。D9 不做多 Windows Host、公众注册、多人组织、共享或计费；只有一个预配置 owner username/password，多个浏览器设备均归该 owner。

### 17.1 Owner 登录

- Gateway 新增精确 `/api/auth/session | login | logout`；登录只接受 HTTPS same-origin JSON POST，成功设置 `Secure + HttpOnly + SameSite=Strict + Path=/` 的 `__Host-` cookie，登出立即失效。会话随机生成、仅内存保存、数量和 TTL 有界，Gateway 重启后要求重新登录。
- 密码不进入 Git、Compose 环境、命令参数或日志。部署 helper 在交互式本机/服务器终端生成 strict verifier 文件，只保存 username、随机 salt、选择固定 scrypt 参数的格式版本和 derived key；Gateway 以只读文件加载。用户名/密码错误统一返回 401，登录全局限速，日志只记固定结果码。
- Owner cookie 只允许进入浏览器 HTTP/WSS 请求，不发送给 Windows Companion。Host 仍用自己的 signing identity challenge；浏览器发起 pairing/client hello 前必须同时具有有效 owner session 与原有设备/E2EE authority。
- 密码登录不替代新 Host/新浏览器的首次本机确认。获得密码但没有相应设备密钥的人不能解密历史或直接获得 Host authority。

### 17.2 单 Host 多浏览器设备

- Relay 保持一个 owner-owned Host，并复用现有最多16个设备 authorization。每个电脑/手机浏览器分别生成不可导出 signing/agreement key、独立 authorization/epoch/generation/seq；不得复制浏览器私钥或共享同一设备身份。
- Companion 按已认证 `authorizationId + clientDeviceId` 为每个 active 浏览器维护独立 E2EE session/ready handler；多个设备可以同时连接同一 Host。Host 仍串行处理入站 action 边界，task revision 和 action idempotency 继续阻止重复或并发冲突写入。
- `manage.read`仍要求当前请求设备恰好一个`isCurrent + online`，但允许其他由Companion真实ready channel证明的active设备同时为`online`；没有ready channel的非当前active设备保持`unknown`，不能沿用D8“只有当前设备online”的旧单设备schema。
- 配对出现“Windows本机 authorization 已持久化、Relay确认未知”时不得重新签发同一结果或回滚本机权威。Host每次challenge重连后按 `hostAuthorizationRevision` 升序幂等重放本机active authorization的公开路由记录；Relay已有完全相同记录返回idempotent，只补缺失revision。同步只包含公开JWK/fingerprint和路由字段，不包含私钥、grant正文或任务数据；任一不一致继续失败关闭。
- 已登录且已配对的设备可以从 `/manage` 创建五分钟一次性邀请；管理页把E2EE返回的fragment经owner-authenticated same-origin POST登记为8位Crockford配对码，Gateway只在进程内存保存`code → fragment/expiresAt`、容量最多8条、到期清除且绝不记录。新手机登录同一owner账户后输入配对码换回fragment并复用既有pair协议。该邀请由已授权设备的E2EE management action发起，因此Windows自动批准对应join，不再扫码或人工核对SAS；未知/过期/错码统一失败。首次绑定成功后设备私钥仍只保存在本浏览器，后续仅账号密码登录并直接恢复。
- pairing invitation 到期后 Companion 必须在下一次创建请求前释放本机旧 handle；Relay 已按自身 expiry timer清理会合状态，因此 Host不得再发送过期 close帧。未到期或仍在处理join的 invitation继续拒绝并行创建；配对码登记不延长底层invitation有效期。

### 17.3 Production full-access

- 已登记 Host 的 grant 可以声明 `ask | read-only | full-access`。页面明确标记完全访问；选择后固定映射官方 app-server `approvalPolicy=never + dangerFullAccess`，仅对该 Companion 自己启动的 app-server 和已授权 workspace 生效。
- `full-access` 不增加任意 RPC、Shell API、绝对路径接口或跨 Host authority；send/steer/interrupt 仍需 E2EE、current authorization、generation、task revision、action id 和 owned runtime binding。身份/Host/任务/协议状态不明确时继续失败关闭。

### 17.4 实现与验收顺序

2026-09-05 当前验收先使用已有 active 设备：电脑与手机各刷新、Owner 登录一次，核对保存的授权直接恢复及 `/manage` 两台同时 active/online、六层健康。手机完成任务列表、跨任务读取、一次安全发送及模型/推理/full-access 选择，检查终态输入恢复和无重复发送。仅手机本地授权丢失才使用配对码；不主动撤销健康设备。日志检查只解析白名单字段和聚合结果，不读取真实密码、配对码、fragment 或凭据做比对。发现真实阻塞后才最小修复和部署。

1. D9.1 owner verifier/session、登录 UI 与浏览器 WSS session gate；现有单 Host E2EE 流程保持可回滚。
2. D9.2 当前 Host 正式 grant/UI/runtime 开放 `full-access`，完成一次明确用户发起的安全写。
3. D9.3 Companion 多 authorization/session router、`/manage` 新设备邀请和同设备无 Host 重启重连。
4. D9.4 电脑浏览器 + Android 浏览器双设备同时在线、重启/撤销/日志/备份真机矩阵，再部署生产。

### 17.5 诊断日志

- Gateway 继续使用 Docker `json-file` 10 MiB × 3；Companion 增加工作区 `.data/windows-companion/logs/companion.jsonl` 1 MiB × 3 的本地滚动 JSONL。
- Companion 日志只允许固定 event、operation、stage/category/reason、outcome、durationMs、frameBytes 和 generation；禁止 task/turn id、标题、提示词、命令、路径、密码、cookie、SAS、fingerprint、密文或原始异常。
- 每个 Host request 在完成/失败时记录耗时；配对 QR 与批准安全码只留在交互终端，不进入日志。日志写失败不得放宽 authority或伪造成功。
- 同一 E2EE session 内连续出现相同的发送禁用原因时只记录首次；原因变化或新 session 才重新记录，避免轮询把终端和滚动日志淹没。

## 18. 停止规则

### 2026-09-05 可靠性优化验收

- 模型来源改为 Companion 自己的官方 app-server `model/list`：分页读取当前可见模型、原始 model id、displayName、默认/支持推理强度，经现有 E2EE 窄只读动作传到 Web。前端不维护型号清单，显示名称不再用作 wire id；Host 在发送前复核当前目录与 effort，不用任意字符串推导模型。
- 本机旧 CLI 0.151.0 的可见和 hidden 目录均无 GPT-6。官方 0.153.4 在工作区内独立验证，更新 Companion 的 exact executable/runtime binding；不得通过硬编码新模型名冒充上游发现。单浏览器离线导致回包 unavailable 时，只失效该浏览器 channel，不重连整个 Host；已经排队的旧 generation 帧不应打断其他设备。
- Web 短暂后台不主动关闭连接；后台暂停轮询，前台以轻量请求验证存活，只有断开的 session 才重建。E2EE transport 与 socket 共享终止通知，避免已坏 transport 留在 UI。重连保留当前任务、已读快照和草稿，旧 generation 下禁止写；新 generation 用权威快照恢复，不自动重发写动作。
- 任务读取合并同一 client/task 的在途请求；切换以最后一次用户选择为准，旧请求不能把页面切回。只拉取当前需要的历史窗口，轮询串行、后台暂停、失败有界退避，避免积压和无限吞错。
- 写结果区分：模型/参数本地校验失败、`turn/start` 尚未调用的准备失败、上游明确拒绝、可能已提交但响应未知。只有最后一类保留 indeterminate；任何变更仍经过 durable lease/epoch/revision 约束，不能删除已有 tombstone 或自动重试消息。Resume 使用官方 `excludeTurns` 避免无界历史回包。
- 验收覆盖动态新增模型、effort 约束、短后台/断网前台恢复、保留任务草稿、超时/断线联动、快速任务切换、明确拒绝后可继续、模糊结果不重发；正式测试/build 后才沿现有阿里离线流程部署，现场手机验收如实记录。

首个 Docker 产品版本在以下条件全部满足后停止扩展：

- 一个 owner 账户、一台 Windows Host、至少两个已授权浏览器设备可稳定登录、同时连接和独立撤销。
- Docker/Compose 可移植部署、宝塔 Nginx/TLS 可接入。
- `/manage` 可以看清连接层级、生成配对请求和撤销设备。
- interrupt、question answer 与 approve-once/deny 的 P0 控制链通过 live authority 验收。
- 正常 Gateway runtime/state 没有内容解密密钥且不落盘任务内容；正式 Web origin 的主动供应链风险已经明确并有发布缓解。
- 重启恢复、撤销、限流、日志与回滚验收通过。

公众注册、多人组织/共享、数据库集群、复杂指标平台、服务器任务明文浏览和宝塔插件均不进入本轮。
