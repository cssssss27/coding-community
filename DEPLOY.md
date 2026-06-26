# Coding社区部署说明

本项目支持两种运行方式：

1. 静态预览：直接打开 `index.html`，数据会使用浏览器本地缓存兜底。
2. FastAPI 服务端模式：运行 `server.py`，前端优先读取 `/api/bootstrap`，用户、作品、上传文件写入服务端数据库和 `uploads/`。

## 本地启动

```powershell
pip install -r requirements.txt
python -m uvicorn server:app --host 127.0.0.1 --port 8000 --reload
```

浏览器访问：

```text
http://127.0.0.1:8000/
```

## 服务器部署

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

生产环境建议使用 Nginx 反向代理到 Uvicorn/Gunicorn。SQLite 模式下应定期备份 `data/community.db` 和 `uploads/`。RDS 模式下仍需备份上传文件，数据库备份交给 RDS 自动备份和人工快照。

## 已预留 API

```text
GET  /api/health
GET  /api/bootstrap
POST /api/auth/register
POST /api/auth/login
POST /api/auth/provider-login
GET  /api/me
GET  /api/works
GET  /api/works/{id}
POST /api/works
POST /api/admin/login
GET  /api/admin/overview
```

DeepSeek API Key 只应保存在服务端环境变量或 `api_configs` 表中。前端通过服务端代理调用模型，不得在浏览器 JS 中暴露密钥。

## RDS MySQL Serverless

生产环境可以通过 `DATABASE_URL` 使用阿里云 RDS MySQL 8.0 Serverless。

推荐使用 systemd override：

```bash
sudo systemctl edit coding-community
```

示例配置：

```ini
[Service]
Environment="DATABASE_URL=mysql://coding_app:REPLACE_WITH_RDS_PASSWORD@REPLACE_WITH_RDS_INTERNAL_HOST:3306/coding_community"
Environment="DEEPSEEK_API_KEY=REPLACE_WITH_DEEPSEEK_KEY"
Environment="DEEPSEEK_BASE_URL=https://api.deepseek.com"
Environment="DEEPSEEK_MODEL=deepseek-chat"
```

不要把真实数据库密码、AccessKey 或 API Key 提交到代码、文档或聊天记录。真实值只在服务器 systemd 配置或受保护的环境变量文件中填写。

当 `DEEPSEEK_API_KEY` 存在时，应用启动会自动更新 `api_configs` 表中的 `deepseek-default` 记录。`/api/bootstrap` 仍会隐藏密钥。

## SQLite 到 MySQL 迁移

迁移前先备份生产数据：

```bash
STAMP=$(date +%Y%m%d%H%M%S)
sudo mkdir -p /opt/coding-community-backups/$STAMP
sudo cp /opt/coding-community/data/community.db /opt/coding-community-backups/$STAMP/community.db
sudo tar -C /opt/coding-community -czf /opt/coding-community-backups/$STAMP/uploads.tar.gz uploads
sudo cp /opt/coding-community/server.py /opt/coding-community-backups/$STAMP/server.py
```

设置 `DATABASE_URL` 指向 RDS 后，安装依赖并迁移：

```bash
cd /opt/coding-community
source .venv/bin/activate
pip install -r requirements.txt
python scripts/migrate_sqlite_to_mysql.py --sqlite /opt/coding-community/data/community.db
sudo systemctl daemon-reload
sudo systemctl restart coding-community
curl -s http://127.0.0.1:8000/api/health
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
curl -s http://www.yunhedongli.cloud/api/admin/overview
```

## RDS 回滚

如需回滚到 SQLite，移除 systemd 中的 `DATABASE_URL`，然后重启服务：

```bash
sudo systemctl daemon-reload
sudo systemctl restart coding-community
curl -s http://127.0.0.1:8000/api/health
```

健康检查应显示：

```json
{"databaseEngine":"sqlite"}
```
