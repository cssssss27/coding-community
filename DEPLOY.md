# Coding社区部署说明

本项目支持两种运行方式：

1. 静态预览：直接打开 `index.html`，数据会使用浏览器本地缓存兜底。
2. FastAPI 服务端模式：运行 `server.py`，前端优先读取 `/api/bootstrap`，用户、作品、互动、上传文件写入服务端数据库和 `uploads/`。

## 本地启动

```powershell
pip install -r requirements.txt
python -m uvicorn server:app --host 127.0.0.1 --port 8010
```

也可以直接双击 `Start_Coding社区_服务器.bat`，默认本地端口是 `8010`。如需临时换端口，先设置 `CODING_COMMUNITY_PORT`。

浏览器访问：

```text
http://127.0.0.1:8010/
```

## 服务器目录

建议目录保持：

```text
server.py
database.py
requirements.txt
index.html
community.html
work.html
upload.html
mine.html
vibe.html
management.html
css/
js/
images/
uploads/
data/
scripts/
```

生产环境建议使用 Nginx 反向代理到 Uvicorn/Gunicorn。SQLite 模式下应定期备份 `data/community.db` 和 `uploads/`。MySQL/MariaDB 模式下仍需备份上传文件，数据库按 MySQL/MariaDB 方式定期 dump 或快照。

## 已预留 API

```text
GET    /api/health
GET    /api/bootstrap
POST   /api/auth/register
POST   /api/auth/login
POST   /api/auth/provider-login
GET    /api/me
GET    /api/works
GET    /api/works/{id}
POST   /api/works
POST   /api/works/{id}/engagements
POST   /api/works/{id}/events
GET    /api/works/{id}/preview
POST   /api/vibe/sessions
POST   /api/vibe/sessions/{id}/messages
GET    /api/vibe/sessions/{id}/preview
POST   /api/vibe/sessions/{id}/save
POST   /api/admin/login
GET    /api/admin/overview
PATCH  /api/admin/works/{id}
DELETE /api/admin/works/{id}
PATCH  /api/admin/users/{id}
DELETE /api/admin/users/{id}
PUT    /api/admin/api-configs/{id}
POST   /api/admin/points-records
PUT    /api/admin/settings
```

DeepSeek API Key 只应保存在服务端环境变量或 `api_configs` 表中。前端通过服务端代理调用模型，不得在浏览器 JS 中暴露密钥。

当 `DEEPSEEK_API_KEY` 存在时，应用启动会自动更新 `api_configs` 表中的 `deepseek-default` 记录。`/api/bootstrap` 仍会隐藏密钥。

## MySQL/MariaDB

生产环境可以通过 `DATABASE_URL` 使用阿里云 RDS MySQL，也可以使用服务器本机 MariaDB。当前代码会通过 `database.py` 自动判断：

```ini
DATABASE_URL=mysql://coding_app:REPLACE_WITH_PASSWORD@127.0.0.1:3306/coding_community
DEEPSEEK_API_KEY=REPLACE_WITH_DEEPSEEK_KEY
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
```

不要把真实数据库密码、AccessKey 或 API Key 提交到代码、文档或聊天记录。真实值只放在服务器 systemd 配置或受保护的环境变量文件中。

## SQLite 到 MySQL 迁移

迁移前先备份生产数据：

```bash
STAMP=$(date +%Y%m%d%H%M%S)
sudo mkdir -p /opt/coding-community-backups/$STAMP
sudo cp /opt/coding-community/data/community.db /opt/coding-community-backups/$STAMP/community.db
sudo tar -C /opt/coding-community -czf /opt/coding-community-backups/$STAMP/uploads.tar.gz uploads
sudo cp /opt/coding-community/server.py /opt/coding-community-backups/$STAMP/server.py
```

设置 `DATABASE_URL` 指向 MySQL/MariaDB 后，安装依赖并迁移：

```bash
cd /opt/coding-community
source .venv/bin/activate
pip install -r requirements.txt
python scripts/migrate_sqlite_to_mysql.py --sqlite /opt/coding-community/data/community.db
sudo systemctl daemon-reload
sudo systemctl restart coding-community
curl -s http://127.0.0.1:8010/api/health
```

健康检查应包含：

```json
{"databaseEngine":"mysql"}
```

验证公开路由：

```bash
curl -I http://www.yunhedongli.cloud/
curl -I http://www.yunhedongli.cloud/community.html
curl -I "http://www.yunhedongli.cloud/work.html?id=new-wave-flower-stage"
curl -s http://www.yunhedongli.cloud/api/bootstrap | head -c 500
```

## 回滚到 SQLite

如需回滚到 SQLite，移除 systemd 中的 `DATABASE_URL`，然后重启服务：

```bash
sudo systemctl daemon-reload
sudo systemctl restart coding-community
curl -s http://127.0.0.1:8010/api/health
```

健康检查应显示：

```json
{"databaseEngine":"sqlite"}
```
