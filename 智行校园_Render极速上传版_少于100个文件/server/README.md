# 智行校园1.2.1服务

推荐从根目录启动脚本运行。默认所有敏感API启用账号鉴权，历史接口不再匿名访问。

详见根目录README.md与docs/手机联调与账号部署.md、docs/PDF导入说明.md。

新增 /api/auth/status、/bootstrap、/register、/login、/me、/logout、/password、/wechat；管理员 /api/admin/users；PDF解析 POST /api/import/pdf。

用户只能查看自己的事件，管理员才能处理事件、管理用户、导入全局规划和道路观测。PDF与天气需要普通用户登录。Session持久化在auth目录，密码为加盐scrypt哈希，7天有效，退出及改密撤销。

本地运行环境与PDF依赖随压缩包提供。默认绑定127.0.0.1；CAMPUS_HOST=0.0.0.0显式开启手机局域网联调。生产模式必须配置HTTPS。

以下是保留的历史API字段参考（身份与网络规则以1.2.1说明为准）：

# 智行校园本地服务

仅用于本机开发演示，已启用账号鉴权。Node.js 22+，零第三方依赖。

```powershell
cd E:/程序开发skill/zhixing-campus/server
npm start
npm test
```

服务只绑定 `127.0.0.1:3219`。后台：`http://localhost:3219/admin/`。小程序开发工具可将 API base URL 配为 `http://127.0.0.1:3219`，本地调试时关闭合法域名校验。真机的 localhost 不指向开发电脑。

## API contract

所有响应为 JSON（静态资源除外）。失败：`{ "error": { "code": "VALIDATION_ERROR", "message": "…" } }`。请求 JSON 限制 64 KiB。支持本机 localhost / 127.0.0.1 / [::1] 任意端口的 CORS、OPTIONS；`file://` 的 null origin 仅便于本地演示。没有跨设备实时推送：小程序应在页面显示及状态操作后重新 GET，可每 15 秒轮询。

- `GET /api/events?status=pending|processing|resolved&reporterId=...` → `{ events: Event[], total, updatedAt }`。省略筛选获取全部，`status=all` 亦可；`unprocessed` 包含 pending 与 processing，`processed` 对应 resolved。按创建时间倒序。
- `POST /api/events` → 201 `{ event: Event }`。必填 `type`（道路拥堵/施工/临时封路/交通事故/积水）、`location`（1–120 字字符串）、`description`（1–50 个 Unicode 字符）；可选 `reporter`（显示名称，最多 40 字）、`reporterId`（最多 80 字）、`campus`（东校区/西校区）、`photos`（最多 3 个 https/http 地址或小程序 `wxfile://` 临时地址，每个最多 2048 字）、`latitude`、`longitude`（数值，须成对提供），`clientRequestId`（可选，最多100字，同一reporterId下重试会返回原事件）。照片地址由下述图片接口生成；原有http(s)/wxfile地址亦可保存。
- `PATCH /api/events/:id` → `{ event: Event }`。字段 `status`（pending/processing/resolved）、`progress`（1–200 字进展文字），至少一个。每次追加一条 history 记录。允许重新打开事件。未知字段报错。修改仅支持状态和处理进展，原上报内容保持完整。
- Event：`{ id, type, location, description, reporter, reporterId, campus, photos, latitude?, longitude?, status, statusLabel, progress, createdAt, updatedAt, history: [{status, statusLabel, progress, at}] }`。事件初始状态 pending/未处理。processing/处理中，resolved/已处理。新安装不预置虚构上报。`reporterId` 是筛选便利字段，不是身份认证。
- `GET /api/traffic?campus=east|west&horizon=5|15|30` → `{ synthetic: true, source, label, campus, horizon, generatedAt, series: [{time, predicted, actual}], metrics: {mae, rmse, mape, label}, roads: [{id,name,index,risk,status}], summary: {congestionIndex, congestedRoads, highRiskRoads} }`。默认 east/15；也接受中文校区名。指数范围 0–100。所有曲线、道路指数和 MAE/RMSE/MAPE 均为确定性合成演示数据，没有真实观测或模型准确率主张。MAPE 单位百分比，零实际值不参与计算。
- `GET /api/weather?campus=east|west`，或 `GET /api/weather?latitude=36.8106&longitude=118.0335` → `{ available: true, source: "Open-Meteo", observedAt, fetchedAt, temperature, weatherCode, windSpeed, isDay, units, latitude, longitude, locationLabel }`；网络失败/超时/无效上游返回 HTTP 200 `{ available: false, source: "Open-Meteo", message, fetchedAt, locationLabel }`。优先使用指定坐标，其次共享 campus.js 的校区 center，缺失时使用明确标注的淄博附近示例坐标。缓存 10 分钟，超时 4 秒，无模拟回退。
- `GET /data/<name>.json` 安全提供项目 `data/` 下直接子级 JSON 文件，不允许目录穿越、符号链接越界或其他后缀。可选 `require('../data/campus.js')` 支持 `east/west.edges`、`east/west.roads`、`campuses.east/west.roads` 或顶层 `roads` 的道路名称；缺失则使用明确标记的演示道路。道路名称可能来自共享地图，交通指数始终为合成数据。

持久化默认 `server/storage/events.json`，原子替换并串行写入；可用环境变量 `CAMPUS_STORE` 指定文件。损坏的现有文件会阻止启动，避免覆盖数据。单进程运行，不支持多个进程共享存储文件。`PORT` 可覆盖端口，始终只绑定本机回环地址。

测试使用临时目录和注入的天气请求，不依赖互联网，不修改项目共享文件。

## 图片与微信登录扩展

- POST /api/photos：JSON {data: base64}，最多3MiB请求，图片解码后不超过2MiB，支持PNG/JPEG签名；返回201 {path:"/photos/<uuid>.png"}。文件保存在server/storage/photos。
- GET /photos/<uuid>.png 或 .jpg：读取上传的本地图片，不允许任意路径。
- POST /api/auth/wechat：{code}，配置WECHAT_APP_ID与WECHAT_APP_SECRET后由服务端调用微信code2Session。成功返回authenticated、匿名派生user.id和短期本机token，不返回AppSecret或session_key。未配置为503，微信凭证无效为401。该接口验证微信身份，事件/管理接口仍是仅限本机的教学服务，现由1.2.1统一鉴权保护。
- 扩展测试位于项目tests/extensions.test.js。

## 1.1.0新增运行与数据接口

推荐双击根目录启动管理端.cmd，或使用runtime/node.exe server/launch.js。无需全局Node环境。GET /api/health可检查版本和服务可用性。

新增接口：GET /api/search?q=关键词；GET /api/integrations/status；POST /api/integrations/education；GET /api/weather/china；GET/POST /api/planning-inputs；GET/POST /api/observations；GET/POST /api/forecast。教务、天气、数据格式与配置见docs/教务和天气接入.md。主要管理界面使用/api/forecast，缺少真实观测时不生成观测曲线与误差结果。原/api/traffic和/api/weather保留用于旧版API兼容，不用于新的管理端曲线。
