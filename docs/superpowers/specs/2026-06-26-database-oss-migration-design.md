# Coding社区数据库与 OSS 迁移设计

## 背景

Coding社区当前部署在阿里云香港 ECS，线上目录为 `/opt/coding-community`，FastAPI/uvicorn 运行在 `127.0.0.1:8000`，Nginx 已反向代理到服务。线上当前使用 SQLite 数据库 `/opt/coding-community/data/community.db`，本地开发副本位于 `C:\Users\admin\Desktop\Coding社区\data\community.db`。

本设计只覆盖 Coding社区 项目，不覆盖也不触碰 `D:\世界人工智能大会交互装置`。当前本地目录不是 git 仓库，因此本文档保存到工作区后不能直接提交 commit。

## 目标

将 Coding社区 的线上结构化数据从 SQLite 迁移到阿里云 RDS MySQL 8.0 Serverless，并为后续将图片、HTML、视频和用户上传程序文件迁移到阿里云 OSS 建立清晰边界。迁移完成后，现有首页、社区页、作品详情、后台登录、作品审核、上传作品和健康检查应保持可用。

## 非目标

- 不在第一阶段重构成 SQLAlchemy ORM。
- 不在第一阶段把所有静态图片和用户上传文件同时迁到 OSS。
- 不把图片、视频、HTML 文件或程序压缩包直接写入数据库。
- 不把阿里云账号密码、AccessKey Secret、RDS 密码写入代码或本文档。
- 不改变现有前端页面路径和 API 返回契约，除非为了展示数据库模式增加健康检查字段。

## 已确认方案

采用 **阿里云 RDS MySQL 8.0 Serverless/按量付费 + 阿里云 OSS 中国香港 Bucket**。

RDS 存储结构化数据：用户、作品元数据、审核状态、分类、设置、API 配置、登录会话、积分记录等。

OSS 存储非结构化文件：作品封面、预览图、HTML 页面、视频、用户上传程序文件和后续较大的静态资源。数据库只保存 URL、对象 key、文件大小、MIME 类型、作者、作品 ID、状态、分类等元数据。

## 官方依据

- 阿里云 RDS MySQL Serverless 文档：https://help.aliyun.com/zh/rds/apsaradb-rds-for-mysql/rds-mysql-serverless
- 阿里云 RDS 计费项说明：https://www.alibabacloud.com/help/zh/rds/product-overview/billable-items-billing-methods-and-pricing
- 阿里云 OSS 地域与 Endpoint 文档：https://help.aliyun.com/zh/oss/user-guide/regions-and-endpoints

## 当前系统观察

后端主要集中在 `server.py`，数据库入口是 `db()`，SQLite 连接使用 `sqlite3.connect(DB_PATH)`。初始化表结构在 `init_db()` 内，业务 SQL 以 `conn.execute(...)` 形式分布在登录、注册、作品列表、作品详情、上传、后台审核、设置和积分接口中。

本地 SQLite 表包括：

- `users`
- `sessions`
- `admin_sessions`
- `user_profiles`
- `works`
- `points_records`
- `settings`
- `api_configs`

正式迁移应以线上 `/opt/coding-community/data/community.db` 为源。本地 `data/community.db` 只作为开发参考，因为本地统计与已记录的线上统计不完全一致。

## 数据库架构设计

第一阶段保持现有表结构语义，迁移到 MySQL 等价 schema：

- 文本主键继续使用 `varchar`，保留现有 ID，例如 `new-wave-flower-stage`、`work-...`、`u-...`。
- JSON 字段第一阶段继续以 `text` 保存，例如 `profile_json`、`categories_json`、`tags_json`、`settings.value_json`、`api_configs.config_json`。
- 布尔值继续以 `tinyint` 保存，例如 `featured`、`enabled`、`newsletter`、`terms_accepted`。
- 时间字段第一阶段继续以 ISO 字符串或日期字符串保存，避免同时改变业务格式。
- 保留唯一约束：`users.phone`、`users.email`、`users.username`、各表主键。
- 添加常用索引：`works.status`、`works.created_at`、`works.author_id`、`sessions.user_id`、`points_records.user_id`。

第二阶段在业务稳定后，可以再考虑把部分 JSON 字段改为 MySQL `json` 类型，或拆出作品标签、分类、附件等独立关系表。

## 后端改造设计

新增轻量数据库适配层，避免在 `server.py` 内到处散落 MySQL 差异。

核心设计：

- 新增 `DATABASE_URL` 环境变量。
- 本地默认不设置 `DATABASE_URL` 时继续使用 SQLite。
- 线上 `DATABASE_URL` 指向 RDS MySQL。
- 新增数据库类型判断，例如 `sqlite` 和 `mysql`。
- MySQL 驱动优先选择 `pymysql`，因为部署轻、依赖简单，能匹配当前 FastAPI 项目规模。
- 封装连接创建、参数占位符转换、行对象转换和事务提交。

需要处理的 SQL 差异：

- SQLite 参数占位符 `?` 转换为 MySQL `%s`。
- SQLite `insert or ignore` 转换为 MySQL `insert ignore`。
- SQLite `insert or replace` 转换为 MySQL `replace into` 或显式 upsert。
- SQLite `on conflict(id) do update` 转换为 MySQL `on duplicate key update`。
- SQLite `pragma table_info(...)` 替换为 MySQL `information_schema.columns` 查询。
- SQLite `min()`、`max()`、`coalesce()`、`lower()` 在 MySQL 中基本可保留。

`/api/health` 增加数据库模式字段，便于确认线上已切到 RDS，例如返回 `databaseEngine: "mysql"`。不返回数据库账号、密码、host 等敏感信息。

## 迁移流程设计

### 第一阶段：RDS 数据库迁移

1. 在阿里云香港地域创建 RDS MySQL 8.0 Serverless 实例。
2. 创建数据库 `coding_community`。
3. 创建最小权限应用账号，例如 `coding_app`。
4. 配置 RDS 白名单或安全组，只允许当前 ECS 访问。
5. 在 ECS 上备份：
   - `/opt/coding-community/data/community.db`
   - `/opt/coding-community/uploads/`
   - `/opt/coding-community/server.py`
   - systemd 服务配置
   - Nginx 配置
6. 短时间冻结后台审核和上传，避免迁移期间 SQLite 产生新写入。
7. 运行一次性迁移脚本，从线上 SQLite 读取数据并写入 MySQL。
8. 按依赖顺序导入：
   - `users`
   - `user_profiles`
   - `works`
   - `sessions`
   - `admin_sessions`
   - `settings`
   - `api_configs`
   - `points_records`
9. 校验每张表行数、关键作品 ID、作品状态统计、后台账号配置和 API 配置记录。
10. 设置 systemd 环境变量 `DATABASE_URL`，重启 `coding-community` 服务。
11. 验证正式域名和核心 API。

### 第二阶段：OSS 文件迁移

1. 在阿里云 OSS 中国香港地域创建 Bucket。
2. 设计对象 key 规则：
   - `uploads/users/{user_id}/{work_id}/index.html`
   - `uploads/users/{user_id}/{work_id}/cover.{ext}`
   - `images/works/{filename}`
   - `videos/works/{work_id}/{filename}`
3. 先迁移 `uploads/` 用户上传目录。
4. 数据库新增或复用字段保存 OSS URL/key：
   - 第一阶段可继续复用 `image_url`、`html_path`，值从本地相对路径逐步替换成 URL 或 `oss://` key。
   - 后续可增加 `storage_provider`、`image_key`、`html_key`、`file_size`、`mime_type` 等字段。
5. 修改上传接口：新上传文件写入 OSS，数据库保存 URL/key 和元数据。
6. 修改预览接口：如果作品 HTML 在 OSS，后端读取 OSS 内容或重定向到受控 URL；如果还在本地，继续走现有本地路径。
7. 验证上传作品、作品预览、封面加载和后台删除。

## 安全设计

- RDS 不开放公网或只使用严格白名单；优先使用 ECS 到 RDS 的内网连接。
- RDS 应用账号只授予 `coding_community` 数据库所需权限。
- 数据库密码、OSS AccessKey、Bucket 信息通过 systemd 环境变量或 `.env` 管理，不提交到代码。
- `api_configs.api_key` 属于敏感数据，`/api/bootstrap` 继续隐藏密钥。
- DeepSeek Key 不写入代码、文档或聊天记录。部署时由服务器环境变量 `DEEPSEEK_API_KEY` 提供，应用启动初始化时自动写入或更新 `api_configs` 表中的 `deepseek-default` 配置。
- 后台默认密码 `admin / 123456` 迁移后必须立即修改。
- OSS Bucket 默认不公开写权限。公开读取、签名 URL、CDN 或后端代理的选择在第二阶段根据预览需求确定。

## 验收清单

数据库切换后必须验证：

- `GET /api/health` 返回成功，并显示 MySQL/RDS 模式。
- `GET /api/bootstrap` 返回用户、作品、分类、设置、积分记录。
- 首页 `http://www.yunhedongli.cloud/` 正常加载作品卡片和封面。
- 社区页 `/community.html` 正常加载和筛选作品。
- 作品详情 `/work.html?id=new-wave-flower-stage` 正常。
- 作品预览 `/api/works/new-wave-flower-stage/preview` 返回可运行 HTML。
- 后台 `/management.html` 能登录。
- 后台作品列表能显示状态、分类、推荐和作者。
- 后台审核能修改作品状态，刷新后仍正确。
- 上传作品能创建 `reviewing` 状态作品。
- 新上传文件可访问，数据库只保存路径、URL 或 key。
- `GET /api/admin/overview` 统计正确。

OSS 切换后必须额外验证：

- 新封面文件写入 OSS。
- 新 HTML 文件写入 OSS。
- 作品预览能读取 OSS HTML。
- 删除作品时能删除或标记对应 OSS 对象。
- 旧本地文件路径作品仍能访问，直到迁移完成。

## 回滚方案

切换 RDS 前保留完整 SQLite 和上传目录备份。如果 MySQL 切换失败：

1. 移除或注释 systemd 中的 `DATABASE_URL`。
2. 重启 `coding-community` 服务。
3. 确认 `/api/health` 回到 SQLite 模式。
4. 如文件被修改，恢复备份的 `server.py` 和配置。
5. 在问题修复前保持上传和后台审核冻结，避免两套数据库产生分叉。

OSS 阶段如果出现问题，应保留本地文件读取分支。新上传失败时回退到本地 `uploads/`，旧作品继续按本地路径读取。

## 风险与应对

- **SQL 方言差异风险**：通过适配层集中处理占位符、upsert、schema 初始化和 metadata 查询。
- **迁移源不一致风险**：正式迁移只以线上 SQLite 为源，本地 SQLite 不作为生产源。
- **文件迁移影响预览风险**：分两阶段迁移，先数据库、后 OSS；OSS 阶段保留本地路径兼容。
- **安全配置泄露风险**：所有密钥只放环境变量或阿里云控制台，不写入代码和文档。
- **后台默认密码风险**：迁移成功后立即在后台修改默认密码。
- **无 git 仓库风险**：当前工作区没有版本管理，正式改造前建议初始化 git 或建立代码备份目录。

## 设计自检

- 本设计没有把数据库迁移和 OSS 迁移强行合并为一次上线。
- 本设计没有要求重写前端。
- 本设计保留 SQLite 回滚路径。
- 本设计明确线上迁移源是 `/opt/coding-community/data/community.db`。
- 本设计没有包含任何账号密码、AccessKey Secret 或 RDS 密码。
