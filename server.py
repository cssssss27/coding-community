from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import shutil
import sqlite3
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from database import DB_PATH, database_engine, database_health_info, db


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
UPLOAD_DIR = ROOT / "uploads"
COVER_DIR = UPLOAD_DIR / "covers"
HTML_DIR = UPLOAD_DIR / "html"
USER_UPLOAD_DIR = UPLOAD_DIR / "users"
VIBE_SESSIONS: dict[str, dict[str, Any]] = {}
ENGAGEMENT_KINDS = {"like", "favorite"}

DEFAULT_WORK_CATEGORIES = [
  "创意组件",
  "AI 实验",
  "效率工具",
  "设计工具",
  "教育工具",
  "数据可视化",
  "运营后台",
  "电商营销",
  "活动运营",
  "文旅工具",
  "生活工具",
  "艺术展览",
]

DEFAULT_ADMIN_AUTH = {"username": "admin", "password": "admin1212"}
OLD_DEFAULT_ADMIN_AUTHS = (
  {"username": "admin", "password": "admin"},
  {"username": "admin", "password": "123456"},
)

LEGACY_CATEGORY_SLOTS = {
  "互动视觉": 0,
  "音乐工具": 0,
  "视觉实验": 3,
  "品牌视觉": 3,
  "知识卡片": 4,
  "知识管理": 4,
  "文博工具": 9,
  "文旅工具": 9,
  "自然观察": 10,
  "身心灵": 10,
}

DATA_DIR.mkdir(exist_ok=True)
COVER_DIR.mkdir(parents=True, exist_ok=True)
HTML_DIR.mkdir(parents=True, exist_ok=True)
USER_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


def now_text() -> str:
  return datetime.now(timezone.utc).isoformat(timespec="seconds")


def default_work_categories() -> list[str]:
  return list(DEFAULT_WORK_CATEGORIES)


def normalize_category_names(names: Any) -> list[str]:
  raw = names if isinstance(names, list) else []
  result: list[str] = []
  for index, fallback in enumerate(DEFAULT_WORK_CATEGORIES):
    name = str(raw[index]).strip() if index < len(raw) else ""
    candidate = name or fallback
    if candidate in result:
      candidate = fallback if fallback not in result else ""
    if not candidate:
      candidate = next((item for item in DEFAULT_WORK_CATEGORIES if item not in result), fallback)
    result.append(candidate)
  return result[:12]


def category_slot_index(value: Any, active_categories: list[str] | None = None) -> int | None:
  name = str(value or "").strip()
  if not name:
    return None
  active = normalize_category_names(active_categories or DEFAULT_WORK_CATEGORIES)
  if name in active:
    return active.index(name)
  if name in DEFAULT_WORK_CATEGORIES:
    return DEFAULT_WORK_CATEGORIES.index(name)
  return LEGACY_CATEGORY_SLOTS.get(name)


def category_values(value: Any) -> list[str]:
  if isinstance(value, list):
    return [str(item).strip() for item in value if str(item).strip()]
  if isinstance(value, tuple):
    return [str(item).strip() for item in value if str(item).strip()]
  text = str(value or "")
  return [item.strip() for item in re.split(r"[,，、|/\s]+", text) if item.strip()]


def normalize_work_categories(values: Any, allowed: list[str] | None = None) -> list[str]:
  active = normalize_category_names(allowed or DEFAULT_WORK_CATEGORIES)
  result: list[str] = []
  for value in category_values(values):
    index = category_slot_index(value, active)
    if index is None or index >= len(active):
      continue
    candidate = active[index]
    if candidate not in result:
      result.append(candidate)
    if len(result) == 3:
      break
  return result or [active[0]]


def canonical_work_categories(values: Any, active_categories: list[str] | None = None) -> list[str]:
  active = normalize_category_names(active_categories or DEFAULT_WORK_CATEGORIES)
  result: list[str] = []
  for value in category_values(values):
    index = category_slot_index(value, active)
    if index is None:
      continue
    candidate = DEFAULT_WORK_CATEGORIES[index]
    if candidate not in result:
      result.append(candidate)
    if len(result) == 3:
      break
  return result or [DEFAULT_WORK_CATEGORIES[0]]


def today_text() -> str:
  return datetime.now().strftime("%Y-%m-%d")


def json_loads(value: Any, fallback: Any) -> Any:
  if value in (None, ""):
    return fallback
  try:
    return json.loads(value)
  except Exception:
    return fallback


def json_dumps(value: Any) -> str:
  return json.dumps(value, ensure_ascii=False)


def hash_password(password: str) -> str:
  salt = secrets.token_hex(16)
  digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 120_000)
  return f"pbkdf2_sha256${salt}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
  try:
    method, salt, digest = stored.split("$", 2)
  except ValueError:
    return False
  if method != "pbkdf2_sha256":
    return False
  check = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 120_000).hex()
  return secrets.compare_digest(check, digest)


def row_value(row: Any, key: str, fallback: Any = None) -> Any:
  if isinstance(row, dict):
    return row.get(key, fallback)
  return row[key] if key in row.keys() else fallback


def refresh_work_lineage(conn: sqlite3.Connection) -> None:
  rows = conn.execute("select * from works order by coalesce(created_at, ''), id").fetchall()
  by_id = {row["id"]: row for row in rows}
  cache: dict[str, dict[str, Any]] = {}

  def lineage_for(row: sqlite3.Row, stack: set[str] | None = None) -> dict[str, Any]:
    work_id = row["id"]
    if work_id in cache:
      return cache[work_id]
    stack = set(stack or set())
    if work_id in stack:
      result = {
        "originalWorkId": "",
        "originalWorkTitle": "",
        "parentWorkId": "",
        "parentWorkTitle": "",
        "generation": 0,
      }
      cache[work_id] = result
      return result
    stack.add(work_id)
    parent_id = (row_value(row, "parent_work_id", "") or row_value(row, "origin_work_id", "") or "").strip()
    parent_title = (row_value(row, "parent_work_title", "") or row_value(row, "origin_work_title", "") or "").strip()
    if not parent_id:
      result = {
        "originalWorkId": "",
        "originalWorkTitle": "",
        "parentWorkId": "",
        "parentWorkTitle": "",
        "generation": 0,
      }
      cache[work_id] = result
      return result
    parent = by_id.get(parent_id)
    if not parent:
      result = {
        "originalWorkId": row_value(row, "original_work_id", "") or parent_id,
        "originalWorkTitle": row_value(row, "original_work_title", "") or parent_title,
        "parentWorkId": parent_id,
        "parentWorkTitle": parent_title,
        "generation": max(1, int(row_value(row, "derivative_generation", 0) or 0)),
      }
      cache[work_id] = result
      return result
    parent_lineage = lineage_for(parent, stack)
    parent_generation = int(parent_lineage.get("generation") or 0)
    original_id = parent_lineage.get("originalWorkId") or parent["id"]
    original_title = parent_lineage.get("originalWorkTitle") or parent["title"]
    result = {
      "originalWorkId": original_id,
      "originalWorkTitle": original_title,
      "parentWorkId": parent["id"],
      "parentWorkTitle": parent["title"],
      "generation": parent_generation + 1,
    }
    cache[work_id] = result
    return result

  for row in rows:
    lineage = lineage_for(row)
    conn.execute(
      """
      update works
      set parent_work_id = ?, parent_work_title = ?, original_work_id = ?, original_work_title = ?,
          origin_work_id = ?, origin_work_title = ?, derivative_generation = ?
      where id = ?
      """,
      (
        lineage["parentWorkId"],
        lineage["parentWorkTitle"],
        lineage["originalWorkId"],
        lineage["originalWorkTitle"],
        lineage["originalWorkId"],
        lineage["originalWorkTitle"],
        lineage["generation"],
        row["id"],
      ),
    )


def sqlite_legacy_init_db() -> None:
  with db() as conn:
    conn.executescript(
      """
      create table if not exists users (
        id text primary key,
        phone text unique,
        email text unique,
        username text unique,
        name text not null,
        avatar text,
        password_hash text,
        role text default 'creator',
        profile_json text default '{}',
        points integer default 100,
        points_earned integer default 0,
        activity_score integer default 30,
        subscription_plan text default 'Free',
        subscription_status text default 'free',
        login_provider text,
        created_at text,
        last_login_at text,
        last_active_at text
      );

      create table if not exists sessions (
        token text primary key,
        user_id text not null,
        created_at text,
        last_seen_at text,
        foreign key(user_id) references users(id)
      );

      create table if not exists admin_sessions (
        token text primary key,
        created_at text,
        last_seen_at text
      );

      create table if not exists user_profiles (
        user_id text primary key,
        avatar text,
        signature text,
        field text,
        account_type text,
        title text,
        organization text,
        location text,
        website text,
        bio text,
        language text default 'zh-CN',
        timezone text default 'Asia/Shanghai',
        visibility text default 'public',
        newsletter integer default 1,
        terms_accepted integer default 1,
        updated_at text,
        foreign key(user_id) references users(id)
      );

      create table if not exists works (
        id text primary key,
        title text not null,
        category text,
        author text,
        author_id text,
        points integer default 0,
        paid_trial integer default 0,
        view_count integer default 0,
        trial_count integer default 0,
        vibe_count integer default 0,
        featured integer default 0,
        status text default 'published',
        image_url text,
        html_path text,
        html_content text,
        description text,
        categories_json text default '[]',
        tags_json text default '[]',
        highlights_json text default '[]',
        use_cases_json text default '[]',
        creator_note text,
        version text,
        source_type text default 'user-upload',
        origin_work_id text,
        origin_work_title text,
        original_work_id text,
        original_work_title text,
        parent_work_id text,
        parent_work_title text,
        derivative_generation integer default 0,
        created_at text,
        updated_at text,
        sales_count integer default 0,
        revenue_points integer default 0,
        foreign key(author_id) references users(id)
      );

      create table if not exists points_records (
        id text primary key,
        user_id text,
        amount integer,
        kind text,
        note text,
        created_at text
      );

      create table if not exists work_engagements (
        user_id text not null,
        work_id text not null,
        kind text not null,
        created_at text,
        primary key(user_id, work_id, kind),
        foreign key(user_id) references users(id),
        foreign key(work_id) references works(id)
      );

      create table if not exists settings (
        id text primary key,
        value_json text not null
      );

      create table if not exists api_configs (
        id text primary key,
        provider text,
        base_url text,
        model text,
        api_key text,
        enabled integer default 0,
        config_json text default '{}',
        updated_at text
      );
      """
    )
    work_columns = {row["name"] for row in conn.execute("pragma table_info(works)").fetchall()}
    if "html_content" not in work_columns:
      conn.execute("alter table works add column html_content text")
    if "categories_json" not in work_columns:
      conn.execute("alter table works add column categories_json text default '[]'")
    if "origin_work_id" not in work_columns:
      conn.execute("alter table works add column origin_work_id text")
    if "origin_work_title" not in work_columns:
      conn.execute("alter table works add column origin_work_title text")
    if "original_work_id" not in work_columns:
      conn.execute("alter table works add column original_work_id text")
    if "original_work_title" not in work_columns:
      conn.execute("alter table works add column original_work_title text")
    if "parent_work_id" not in work_columns:
      conn.execute("alter table works add column parent_work_id text")
    if "parent_work_title" not in work_columns:
      conn.execute("alter table works add column parent_work_title text")
    if "derivative_generation" not in work_columns:
      conn.execute("alter table works add column derivative_generation integer default 0")
    if "paid_trial" not in work_columns:
      conn.execute("alter table works add column paid_trial integer default 0")
    if "view_count" not in work_columns:
      conn.execute("alter table works add column view_count integer default 0")
    if "trial_count" not in work_columns:
      conn.execute("alter table works add column trial_count integer default 0")
    if "vibe_count" not in work_columns:
      conn.execute("alter table works add column vibe_count integer default 0")
    refresh_work_lineage(conn)
    conn.execute(
      """
      insert or ignore into settings(id, value_json)
      values('adminAuth', ?)
      """,
      (json_dumps(DEFAULT_ADMIN_AUTH),),
    )
    auth_row = conn.execute("select value_json from settings where id = 'adminAuth'").fetchone()
    auth_value = json_loads(auth_row["value_json"], {}) if auth_row else {}
    if auth_value in OLD_DEFAULT_ADMIN_AUTHS:
      conn.execute(
        "update settings set value_json = ? where id = 'adminAuth'",
        (json_dumps(DEFAULT_ADMIN_AUTH),),
      )
    conn.execute(
      """
      insert or ignore into settings(id, value_json)
      values('site', ?)
      """,
      (json_dumps({"siteName": "Coding社区", "announcement": "", "tagline": ""}),),
    )
    conn.execute(
      """
      insert or ignore into settings(id, value_json)
      values('workCategories', ?)
      """,
      (json_dumps({"categories": default_work_categories()}),),
    )
    conn.execute(
      """
      insert or ignore into api_configs(id, provider, base_url, model, api_key, enabled, config_json, updated_at)
      values('deepseek-default', 'DeepSeek', 'https://api.deepseek.com', 'deepseek-chat', '', 0, '{}', ?)
      """,
      (now_text(),),
    )


def mysql_schema_sql() -> str:
  return """
  create table if not exists users (
    id varchar(80) primary key,
    phone varchar(80) unique,
    email varchar(255) unique,
    username varchar(120) unique,
    name varchar(255) not null,
    avatar text,
    password_hash text,
    role varchar(40) default 'creator',
    profile_json text,
    points int default 100,
    points_earned int default 0,
    activity_score int default 30,
    subscription_plan varchar(80) default 'Free',
    subscription_status varchar(80) default 'free',
    login_provider varchar(80),
    created_at varchar(40),
    last_login_at varchar(40),
    last_active_at varchar(40)
  ) engine=InnoDB default charset=utf8mb4;

  create table if not exists sessions (
    token varchar(255) primary key,
    user_id varchar(80) not null,
    created_at varchar(40),
    last_seen_at varchar(40),
    index idx_sessions_user_id(user_id)
  ) engine=InnoDB default charset=utf8mb4;

  create table if not exists admin_sessions (
    token varchar(255) primary key,
    created_at varchar(40),
    last_seen_at varchar(40)
  ) engine=InnoDB default charset=utf8mb4;

  create table if not exists user_profiles (
    user_id varchar(80) primary key,
    avatar text,
    signature text,
    field text,
    account_type text,
    title text,
    organization text,
    location text,
    website text,
    bio text,
    language varchar(40) default 'zh-CN',
    timezone varchar(80) default 'Asia/Shanghai',
    visibility varchar(40) default 'public',
    newsletter tinyint default 1,
    terms_accepted tinyint default 1,
    updated_at varchar(40)
  ) engine=InnoDB default charset=utf8mb4;

  create table if not exists works (
    id varchar(120) primary key,
    title varchar(255) not null,
    category varchar(120),
    author varchar(255),
    author_id varchar(80),
    points int default 0,
    paid_trial tinyint default 0,
    view_count int default 0,
    trial_count int default 0,
    vibe_count int default 0,
    featured tinyint default 0,
    status varchar(40) default 'published',
    image_url text,
    html_path text,
    html_content mediumtext,
    description text,
    categories_json text,
    tags_json text,
    highlights_json text,
    use_cases_json text,
    creator_note text,
    version varchar(120),
    source_type varchar(80) default 'user-upload',
    origin_work_id varchar(120),
    origin_work_title varchar(255),
    original_work_id varchar(120),
    original_work_title varchar(255),
    parent_work_id varchar(120),
    parent_work_title varchar(255),
    derivative_generation int default 0,
    created_at varchar(40),
    updated_at varchar(40),
    sales_count int default 0,
    revenue_points int default 0,
    index idx_works_status(status),
    index idx_works_created_at(created_at),
    index idx_works_author_id(author_id),
    index idx_works_parent_work_id(parent_work_id),
    index idx_works_original_work_id(original_work_id)
  ) engine=InnoDB default charset=utf8mb4;

  create table if not exists points_records (
    id varchar(120) primary key,
    user_id varchar(80),
    amount int,
    kind varchar(40),
    note text,
    created_at varchar(40),
    index idx_points_records_user_id(user_id)
  ) engine=InnoDB default charset=utf8mb4;

  create table if not exists work_engagements (
    user_id varchar(80) not null,
    work_id varchar(120) not null,
    kind varchar(40) not null,
    created_at varchar(40),
    primary key(user_id, work_id, kind),
    index idx_work_engagements_work_id(work_id),
    index idx_work_engagements_user_id(user_id)
  ) engine=InnoDB default charset=utf8mb4;

  create table if not exists settings (
    id varchar(120) primary key,
    value_json text not null
  ) engine=InnoDB default charset=utf8mb4;

  create table if not exists api_configs (
    id varchar(120) primary key,
    provider varchar(120),
    base_url text,
    model varchar(120),
    api_key text,
    enabled tinyint default 0,
    config_json text,
    updated_at varchar(40)
  ) engine=InnoDB default charset=utf8mb4;
  """


def work_column_names(conn: Any) -> set[str]:
  if database_engine() == "mysql":
    return {row["Field"] for row in conn.execute("show columns from works").fetchall()}
  return {row["name"] for row in conn.execute("pragma table_info(works)").fetchall()}


def ensure_work_schema_columns(conn: Any) -> None:
  column_types = [
    ("html_content", "text", "mediumtext"),
    ("categories_json", "text default '[]'", "text"),
    ("origin_work_id", "text", "varchar(120)"),
    ("origin_work_title", "text", "varchar(255)"),
    ("original_work_id", "text", "varchar(120)"),
    ("original_work_title", "text", "varchar(255)"),
    ("parent_work_id", "text", "varchar(120)"),
    ("parent_work_title", "text", "varchar(255)"),
    ("derivative_generation", "integer default 0", "int default 0"),
    ("paid_trial", "integer default 0", "tinyint default 0"),
    ("view_count", "integer default 0", "int default 0"),
    ("trial_count", "integer default 0", "int default 0"),
    ("vibe_count", "integer default 0", "int default 0"),
  ]
  existing = work_column_names(conn)
  use_mysql = database_engine() == "mysql"
  for name, sqlite_type, mysql_type in column_types:
    if name not in existing:
      conn.execute(f"alter table works add column {name} {mysql_type if use_mysql else sqlite_type}")


def seed_default_rows(conn: Any) -> None:
  conn.execute(
    """
    insert or ignore into settings(id, value_json)
    values('adminAuth', ?)
    """,
    (json_dumps(DEFAULT_ADMIN_AUTH),),
  )
  auth_row = conn.execute("select value_json from settings where id = 'adminAuth'").fetchone()
  auth_value = json_loads(auth_row["value_json"], {}) if auth_row else {}
  if auth_value in OLD_DEFAULT_ADMIN_AUTHS:
    conn.execute(
      "update settings set value_json = ? where id = 'adminAuth'",
      (json_dumps(DEFAULT_ADMIN_AUTH),),
    )
  conn.execute(
    """
    insert or ignore into settings(id, value_json)
    values('site', ?)
    """,
    (json_dumps({"siteName": "Coding绀惧尯", "announcement": "", "tagline": ""}),),
  )
  conn.execute(
    """
    insert or ignore into settings(id, value_json)
    values('workCategories', ?)
    """,
    (json_dumps({"categories": default_work_categories()}),),
  )
  conn.execute(
    """
    insert or ignore into api_configs(id, provider, base_url, model, api_key, enabled, config_json, updated_at)
    values('deepseek-default', 'DeepSeek', 'https://api.deepseek.com', 'deepseek-chat', '', 0, '{}', ?)
    """,
    (now_text(),),
  )


def seed_deepseek_from_env(conn: Any) -> None:
  api_key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
  if not api_key:
    return
  base_url = os.environ.get("DEEPSEEK_BASE_URL", "").strip() or "https://api.deepseek.com"
  model = os.environ.get("DEEPSEEK_MODEL", "").strip() or "deepseek-chat"
  conn.execute(
    """
    insert into api_configs(id, provider, base_url, model, api_key, enabled, config_json, updated_at)
    values('deepseek-default', 'DeepSeek', ?, ?, ?, 1, '{}', ?)
    on conflict(id) do update set
      provider = excluded.provider,
      base_url = excluded.base_url,
      model = excluded.model,
      api_key = excluded.api_key,
      enabled = excluded.enabled,
      updated_at = excluded.updated_at
    """,
    (base_url, model, api_key, now_text()),
  )


def init_db() -> None:
  if database_engine() == "sqlite":
    sqlite_legacy_init_db()
    with db() as conn:
      seed_deepseek_from_env(conn)
    return
  with db() as conn:
    conn.executescript(mysql_schema_sql())
    ensure_work_schema_columns(conn)
    refresh_work_lineage(conn)
    seed_default_rows(conn)
    seed_deepseek_from_env(conn)


def public_user(row: sqlite3.Row) -> dict[str, Any]:
  profile = json_loads(row["profile_json"], {})
  return {
    **profile,
    "id": row["id"],
    "phone": row["phone"] or "",
    "email": row["email"] or "",
    "username": row["username"] or "",
    "name": row["name"],
    "avatar": row["avatar"] or "images/avatars/avatar-dog.png",
    "role": row["role"] or "creator",
    "points": row["points"] or 0,
    "pointsEarned": row["points_earned"] or 0,
    "activityScore": row["activity_score"] or 0,
    "subscriptionPlan": row["subscription_plan"] or "Free",
    "subscriptionStatus": row["subscription_status"] or "free",
    "loginProvider": row["login_provider"] or "",
    "joinedAt": (row["created_at"] or "")[:10],
    "lastLoginAt": row["last_login_at"] or "",
    "lastActiveAt": row["last_active_at"] or "",
  }


def profile_row_to_dict(row: Optional[sqlite3.Row]) -> dict[str, Any]:
  if not row:
    return {}
  return {
    "avatar": row["avatar"] or "",
    "signature": row["signature"] or "",
    "field": row["field"] or "",
    "accountType": row["account_type"] or "",
    "title": row["title"] or "",
    "organization": row["organization"] or "",
    "location": row["location"] or "",
    "website": row["website"] or "",
    "bio": row["bio"] or "",
    "language": row["language"] or "zh-CN",
    "timezone": row["timezone"] or "Asia/Shanghai",
    "visibility": row["visibility"] or "public",
    "newsletter": bool(row["newsletter"]),
    "termsAccepted": bool(row["terms_accepted"]),
  }


def user_with_profile(conn: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
  user = public_user(row)
  profile = conn.execute("select * from user_profiles where user_id = ?", (row["id"],)).fetchone()
  profile_data = profile_row_to_dict(profile)
  if profile_data:
    user.update({key: value for key, value in profile_data.items() if value not in ("", None)})
    if profile_data.get("avatar"):
      user["avatar"] = profile_data["avatar"]
  return user


def read_work_html(path_value: str | None) -> str:
  if not path_value:
    return ""
  path = (ROOT / path_value).resolve()
  try:
    path.relative_to(UPLOAD_DIR.resolve())
  except ValueError:
    return ""
  if path.suffix.lower() not in {".html", ".htm"} or not path.exists() or not path.is_file():
    return ""
  return path.read_text(encoding="utf-8", errors="replace")


def calculate_work_heat(row: sqlite3.Row) -> int:
  views = int(row_value(row, "view_count", 0) or 0)
  likes = int(row_value(row, "like_count", 0) or 0)
  favorites = int(row_value(row, "favorite_count", 0) or 0)
  trials = int(row_value(row, "trial_count", 0) or 0)
  vibes = int(row_value(row, "vibe_count", 0) or 0)
  return max(0, round(views * 0.10 + likes * 0.30 + favorites * 0.15 + trials * 0.15 + vibes * 0.30))


WORK_SELECT_COLUMNS = """
  w.*,
  (select count(*) from work_engagements e where e.work_id = w.id and e.kind = 'like') as like_count,
  (select count(*) from work_engagements e where e.work_id = w.id and e.kind = 'favorite') as favorite_count,
  (
    select count(*)
    from works c
    where c.status = 'published'
      and (
        c.parent_work_id = w.id
        or (coalesce(c.parent_work_id, '') = '' and c.origin_work_id = w.id)
        or c.original_work_id = w.id
      )
  ) as remix_count
"""


def work_rows(
  conn: sqlite3.Connection,
  where_clause: str = "",
  params: tuple[Any, ...] = (),
  order_by: str = "w.created_at desc",
) -> list[sqlite3.Row]:
  where_sql = f" where {where_clause}" if where_clause else ""
  order_sql = f" order by {order_by}" if order_by else ""
  return conn.execute(f"select {WORK_SELECT_COLUMNS} from works w{where_sql}{order_sql}", params).fetchall()


def work_row(conn: sqlite3.Connection, work_id: str) -> sqlite3.Row | None:
  rows = work_rows(conn, "w.id = ?", (work_id,), "")
  return rows[0] if rows else None


def user_work_engagements(conn: sqlite3.Connection, user_id: str) -> list[dict[str, str]]:
  rows = conn.execute(
    "select work_id, kind from work_engagements where user_id = ? order by created_at desc",
    (user_id,),
  ).fetchall()
  return [{"workId": row["work_id"], "kind": row["kind"]} for row in rows]


def user_work_engagement_state(conn: sqlite3.Connection, user_id: str, work_id: str) -> dict[str, bool]:
  rows = conn.execute(
    "select kind from work_engagements where user_id = ? and work_id = ?",
    (user_id, work_id),
  ).fetchall()
  kinds = {row["kind"] for row in rows}
  return {"liked": "like" in kinds, "favorited": "favorite" in kinds}


def public_work(row: sqlite3.Row, include_html: bool = True) -> dict[str, Any]:
  active_categories = getattr(public_work, "_active_categories", default_work_categories())
  stored_categories = []
  if "categories_json" in row.keys():
    stored_categories = json_loads(row["categories_json"], [])
  categories = normalize_work_categories(stored_categories or [row["category"]], active_categories)
  generation = int(row_value(row, "derivative_generation", 0) or 0)
  original_work_id = (row_value(row, "original_work_id", "") or row_value(row, "origin_work_id", "") or "").strip()
  original_work_title = (row_value(row, "original_work_title", "") or row_value(row, "origin_work_title", "") or "").strip()
  parent_work_id = (row_value(row, "parent_work_id", "") or row_value(row, "origin_work_id", "") or "").strip()
  parent_work_title = (row_value(row, "parent_work_title", "") or row_value(row, "origin_work_title", "") or "").strip()
  lineage_label = f"《{original_work_title}》的第{generation}代衍生" if generation > 0 and original_work_title else ""
  work = {
    "id": row["id"],
    "title": row["title"],
    "category": categories[0],
    "categories": categories,
    "author": row["author"] or "匿名创作者",
    "authorId": row["author_id"] or "",
    "points": row["points"] or 0,
    "paidTrial": bool(row_value(row, "paid_trial", 0) or 0),
    "featured": bool(row["featured"]),
    "status": row["status"] or "published",
    "image": row["image_url"] or "images/works/tiny-crm.png",
    "description": row["description"] or "",
    "tags": json_loads(row["tags_json"], []),
    "highlights": json_loads(row["highlights_json"], []),
    "useCases": json_loads(row["use_cases_json"], []),
    "creatorNote": row["creator_note"] or "",
    "version": row["version"] or "",
    "sourceType": row["source_type"] or "user-upload",
    "originWorkId": original_work_id,
    "originWorkTitle": original_work_title,
    "originalWorkId": original_work_id,
    "originalWorkTitle": original_work_title,
    "parentWorkId": parent_work_id,
    "parentWorkTitle": parent_work_title,
    "derivativeGeneration": generation,
    "lineageLabel": lineage_label,
    "createdAt": (row["created_at"] or "")[:10],
    "updatedAt": row["updated_at"] or "",
    "salesCount": row["sales_count"] or 0,
    "revenuePoints": row["revenue_points"] or 0,
    "viewCount": int(row_value(row, "view_count", 0) or 0),
    "trialCount": int(row_value(row, "trial_count", 0) or 0),
    "vibeCount": int(row_value(row, "vibe_count", 0) or 0),
    "likeCount": int(row_value(row, "like_count", 0) or 0),
    "favoriteCount": int(row_value(row, "favorite_count", 0) or 0),
    "remixCount": int(row_value(row, "remix_count", 0) or 0),
    "heat": calculate_work_heat(row),
  }
  if include_html:
    work["html"] = row["html_content"] or read_work_html(row["html_path"])
  return work


def settings_rows(conn: sqlite3.Connection) -> list[dict[str, Any]]:
  rows = conn.execute("select id, value_json from settings").fetchall()
  return [{"id": row["id"], **json_loads(row["value_json"], {})} for row in rows]


def active_work_categories(conn: sqlite3.Connection) -> list[str]:
  row = conn.execute("select value_json from settings where id = 'workCategories'").fetchone()
  data = json_loads(row["value_json"], {}) if row else {}
  return normalize_category_names(data.get("categories") if isinstance(data, dict) else data)


def public_works(rows: list[sqlite3.Row], active_categories: list[str], include_html: bool = False) -> list[dict[str, Any]]:
  previous = getattr(public_work, "_active_categories", None)
  public_work._active_categories = active_categories  # type: ignore[attr-defined]
  try:
    return [public_work(row, include_html=include_html) for row in rows]
  finally:
    if previous is None:
      try:
        delattr(public_work, "_active_categories")
      except AttributeError:
        pass
    else:
      public_work._active_categories = previous  # type: ignore[attr-defined]


def api_config_rows(conn: sqlite3.Connection, include_secret: bool = False) -> list[dict[str, Any]]:
  rows = conn.execute("select * from api_configs order by updated_at desc").fetchall()
  return [
    {
      "id": row["id"],
      "provider": row["provider"],
      "baseUrl": row["base_url"],
      "model": row["model"],
      "apiKey": row["api_key"] if include_secret else "",
      "enabled": bool(row["enabled"]),
      **json_loads(row["config_json"], {}),
    }
    for row in rows
  ]


def points_rows(conn: sqlite3.Connection) -> list[dict[str, Any]]:
  rows = conn.execute("select * from points_records order by created_at desc limit 500").fetchall()
  return [point_row_to_dict(row) for row in rows]


def point_row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
  return {
    "id": row["id"],
    "userId": row["user_id"] or "",
    "type": row["kind"] or "",
    "amount": row["amount"] or 0,
    "note": row["note"] or "",
    "createdAt": row["created_at"] or "",
  }


def deepseek_api_config(conn: sqlite3.Connection) -> dict[str, Any]:
  env_key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
  env_base_url = os.environ.get("DEEPSEEK_BASE_URL", "").strip()
  env_model = os.environ.get("DEEPSEEK_MODEL", "").strip()
  row = conn.execute(
    """
    select * from api_configs
    where provider like '%DeepSeek%'
    order by enabled desc, updated_at desc
    limit 1
    """
  ).fetchone()
  config_json = json_loads(row["config_json"], {}) if row else {}
  api_key = env_key or (row["api_key"] if row else "")
  if not api_key:
    raise HTTPException(status_code=503, detail="DeepSeek API 尚未配置")
  return {
    "baseUrl": env_base_url or (row["base_url"] if row and row["base_url"] else "https://api.deepseek.com"),
    "model": env_model or (row["model"] if row and row["model"] else "deepseek-chat"),
    "apiKey": api_key,
    "temperature": float(config_json.get("temperature", 0.35)),
  }


def strip_markdown_fence(text: str) -> str:
  cleaned = text.strip()
  if cleaned.startswith("```"):
    cleaned = re.sub(r"^```(?:json|html)?\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s*```$", "", cleaned)
  return cleaned.strip()


def parse_vibe_model_response(content: str) -> tuple[str, str]:
  cleaned = strip_markdown_fence(content)
  data: dict[str, Any] | None = None
  try:
    parsed = json.loads(cleaned)
    if isinstance(parsed, dict):
      data = parsed
  except json.JSONDecodeError:
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start >= 0 and end > start:
      try:
        parsed = json.loads(cleaned[start : end + 1])
        if isinstance(parsed, dict):
          data = parsed
      except json.JSONDecodeError:
        data = None
  if data:
    html = str(data.get("html") or "").strip()
    reply = str(data.get("reply") or data.get("summary") or "已更新预览。").strip()
  else:
    html = cleaned
    reply = "已更新预览。"
  if "<html" not in html.lower() and "<!doctype" not in html.lower():
    raise HTTPException(status_code=502, detail="模型返回格式无法生成可预览 HTML")
  return html, reply[:500] or "已更新预览。"


def call_deepseek_vibe(current_html: str, prompt: str, messages: list[dict[str, str]], config: dict[str, Any]) -> tuple[str, str]:
  system_prompt = (
    "你是 Coding社区 的 HTML 小程序二次开发助手。"
    "你会收到当前作品的完整 HTML 源码和用户的修改指令。"
    "只修改 HTML/CSS/JS，返回一个可以直接运行的完整 HTML 文档。"
    "不要读取图片文件内容，不要要求用户上传图片，不要向用户解释或泄露源码。"
    "输出必须是 JSON 对象，字段为 html 和 reply；reply 用中文简短说明改了什么，不得包含源码。"
  )
  recent_messages = [
    {"role": item["role"], "content": item["content"]}
    for item in messages[-6:]
    if item.get("role") in {"user", "assistant"} and item.get("content")
  ]
  user_content = (
    "当前 HTML 源码如下，仅供你在服务端修改，不能在 reply 中透露：\n"
    f"{current_html}\n\n"
    "用户本轮修改指令：\n"
    f"{prompt.strip()}"
  )
  body = {
    "model": config["model"],
    "messages": [
      {"role": "system", "content": system_prompt},
      *recent_messages,
      {"role": "user", "content": user_content},
    ],
    "temperature": max(0, min(2, float(config.get("temperature", 0.35)))),
    "max_tokens": 8192,
  }
  request = urllib.request.Request(
    f"{str(config['baseUrl']).rstrip('/')}/chat/completions",
    data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
    headers={
      "Authorization": f"Bearer {config['apiKey']}",
      "Content-Type": "application/json",
    },
    method="POST",
  )
  try:
    with urllib.request.urlopen(request, timeout=90) as response:
      payload = json.loads(response.read().decode("utf-8"))
  except urllib.error.HTTPError as exc:
    detail_map = {
      401: "模型服务授权无效，请检查后台 API Key",
      402: "模型服务余额不足或计费未开通",
      429: "模型服务请求过于频繁，请稍后再试",
    }
    detail = detail_map.get(exc.code, f"模型服务请求失败（{exc.code}）")
    raise HTTPException(status_code=502, detail=detail) from exc
  except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
    raise HTTPException(status_code=502, detail="模型服务暂时不可用") from exc
  content = payload.get("choices", [{}])[0].get("message", {}).get("content", "")
  if not content:
    raise HTTPException(status_code=502, detail="模型未返回可用内容")
  return parse_vibe_model_response(content)


def vibe_preview_url(session_id: str, version: int = 0) -> str:
  suffix = f"?v={version}" if version else ""
  return f"/api/vibe/sessions/{session_id}/preview{suffix}"


def public_vibe_session(session: dict[str, Any]) -> dict[str, Any]:
  return {
    "id": session["id"],
    "workId": session["work"]["id"],
    "work": session["work"],
    "previewUrl": vibe_preview_url(session["id"], int(session.get("version", 0))),
    "messages": session["messages"],
    "updatedAt": session["updatedAt"],
  }


def require_vibe_session(session_id: str, user: dict[str, Any]) -> dict[str, Any]:
  session = VIBE_SESSIONS.get(session_id)
  if not session or session.get("userId") != user.get("id"):
    raise HTTPException(status_code=404, detail="做同款会话不存在")
  return session


def bearer_token(authorization: Optional[str]) -> str:
  if not authorization:
    return ""
  prefix = "Bearer "
  return authorization[len(prefix):].strip() if authorization.startswith(prefix) else ""


def current_user_optional(authorization: Optional[str] = Header(None)) -> Optional[dict[str, Any]]:
  token = bearer_token(authorization)
  if not token:
    return None
  with db() as conn:
    session = conn.execute("select user_id from sessions where token = ?", (token,)).fetchone()
    if not session:
      return None
    row = conn.execute("select * from users where id = ?", (session["user_id"],)).fetchone()
    if not row:
      return None
    conn.execute("update sessions set last_seen_at = ? where token = ?", (now_text(), token))
    return user_with_profile(conn, row)


def current_user(user: Optional[dict[str, Any]] = Depends(current_user_optional)) -> dict[str, Any]:
  if not user:
    raise HTTPException(status_code=401, detail="需要登录")
  return user


def current_admin(x_admin_token: Optional[str] = Header(None, alias="X-Admin-Token")) -> dict[str, Any]:
  if not x_admin_token:
    raise HTTPException(status_code=401, detail="请先登录后台")
  with db() as conn:
    row = conn.execute("select token from admin_sessions where token = ?", (x_admin_token,)).fetchone()
    if not row:
      raise HTTPException(status_code=401, detail="后台登录已失效")
    conn.execute("update admin_sessions set last_seen_at = ? where token = ?", (now_text(), x_admin_token))
  return {"token": x_admin_token}


def save_upload(upload: UploadFile, folder: Path, fallback_suffix: str) -> str:
  suffix = Path(upload.filename or "").suffix.lower() or fallback_suffix
  filename = f"{datetime.now().strftime('%Y%m%d%H%M%S')}-{secrets.token_hex(8)}{suffix}"
  path = folder / filename
  with path.open("wb") as handle:
    handle.write(upload.file.read())
  return str(path.relative_to(ROOT)).replace("\\", "/")


def safe_path_part(value: str, fallback: str) -> str:
  text = (value or "").strip().lower()
  text = re.sub(r"\s+", "-", text)
  text = re.sub(r"[^0-9a-zA-Z\u4e00-\u9fff._-]+", "-", text)
  text = re.sub(r"-{2,}", "-", text).strip("-._")
  return text[:72] or fallback


def write_upload_to_path(upload: UploadFile, path: Path) -> str:
  path.parent.mkdir(parents=True, exist_ok=True)
  with path.open("wb") as handle:
    handle.write(upload.file.read())
  upload.file.close()
  return str(path.relative_to(ROOT)).replace("\\", "/")


def parsed_tags(value: Any) -> list[str]:
  return [item.strip() for item in str(value or "").replace("，", ",").split(",") if item.strip()][:8]


def parsed_lines(value: Any) -> list[str]:
  return [item.strip() for item in str(value or "").splitlines() if item.strip()][:8]


def truthy_form_value(value: Any) -> bool:
  return str(value or "").strip().lower() in {"1", "true", "yes", "y", "on", "是", "paid", "paidTrial"}


def require_work_submission_fields(
  *,
  title: str,
  categories: Any,
  author: str,
  description: str,
  tags: str,
  cover: Optional[UploadFile],
  html_file: Optional[UploadFile] = None,
  require_html_file: bool = False,
) -> tuple[str, list[str], str, int, str, list[str], UploadFile]:
  clean_title = title.strip()
  if not clean_title:
    raise HTTPException(status_code=400, detail="请填写作品名称")
  selected_categories = category_values(categories)
  if not selected_categories:
    raise HTTPException(status_code=400, detail="请选择 1-3 个作品分类")
  author_name = author.strip()
  if not author_name:
    raise HTTPException(status_code=400, detail="请填写作者显示名")
  clean_description = description.strip()
  if not clean_description:
    raise HTTPException(status_code=400, detail="请填写一句话简介")
  tag_values = parsed_tags(tags)
  if not tag_values:
    raise HTTPException(status_code=400, detail="请填写标签")
  if not cover or not cover.filename:
    raise HTTPException(status_code=400, detail="请选择作品封面图")
  if require_html_file and (not html_file or not html_file.filename):
    raise HTTPException(status_code=400, detail="请选择 HTML 程序文件")
  return clean_title, selected_categories, author_name, clean_description, tag_values, cover


def user_work_folder(user: dict[str, Any], title: str, work_id: str) -> Path:
  user_key = safe_path_part(user.get("username") or user.get("phone") or user.get("id") or "user", "user")
  work_key = safe_path_part(title, "untitled-work")
  folder = USER_UPLOAD_DIR / user_key / f"{work_key}-{work_id.replace('work-', '')[:8]}"
  folder.mkdir(parents=True, exist_ok=True)
  return folder


def normalize_work_status(value: str) -> str:
  status = (value or "published").strip()
  return {
    "published": "published",
    "reviewing": "reviewing",
    "review": "reviewing",
    "hidden": "hidden",
    "draft": "hidden",
  }.get(status, "published")


def create_session(conn: sqlite3.Connection, user_id: str) -> str:
  token = secrets.token_urlsafe(32)
  conn.execute(
    "insert into sessions(token, user_id, created_at, last_seen_at) values(?, ?, ?, ?)",
    (token, user_id, now_text(), now_text()),
  )
  return token


class LoginPayload(BaseModel):
  identifier: str
  password: str


class RegisterPayload(BaseModel):
  phone: str
  name: str
  password: str
  email: str = ""
  avatar: str = ""
  signature: str = ""
  field: str = ""


class ProfilePayload(BaseModel):
  username: str = ""
  name: str = ""
  email: str = ""
  phone: str = ""
  password: str = ""
  avatar: str = ""
  signature: str = ""
  field: str = ""
  accountType: str = ""
  title: str = ""
  organization: str = ""
  location: str = ""
  website: str = ""
  bio: str = ""
  language: str = "zh-CN"
  timezone: str = "Asia/Shanghai"
  visibility: str = "public"
  newsletter: bool = True
  termsAccepted: bool = True


class ProviderPayload(BaseModel):
  provider: str
  label: str = ""


class AdminLoginPayload(BaseModel):
  username: str
  password: str


class AdminWorkPayload(BaseModel):
  title: str = ""
  category: str = ""
  categories: list[str] = []
  author: str = ""
  points: int = 0
  featured: bool = False
  status: str = "published"


class AdminUserPayload(BaseModel):
  email: str = ""
  subscriptionPlan: str = "Free"
  subscriptionStatus: str = "free"
  role: str = "creator"
  points: int = 0


class AdminApiConfigPayload(BaseModel):
  provider: str = "DeepSeek"
  baseUrl: str = ""
  model: str = ""
  apiKey: str = ""
  temperature: float = 0.35
  enabled: bool = False


class VibeSessionPayload(BaseModel):
  workId: str


class VibeMessagePayload(BaseModel):
  prompt: str


class VibeSavePayload(BaseModel):
  title: str = ""


class WorkEngagementPayload(BaseModel):
  kind: str
  active: bool = True


class WorkEventPayload(BaseModel):
  kind: str


class AdminPointPayload(BaseModel):
  userId: str
  type: str = "adjust"
  amount: int
  note: str = ""


class AdminSettingsPayload(BaseModel):
  siteName: str = "Coding社区"
  announcement: str = ""
  tagline: str = ""
  username: str = "admin"
  password: str = "admin1212"
  categories: list[str] = []


app = FastAPI(title="Coding社区 API", version="0.1.0")
app.add_middleware(
  CORSMiddleware,
  allow_origins=["*"],
  allow_credentials=True,
  allow_methods=["*"],
  allow_headers=["*"],
)


@app.on_event("startup")
def on_startup() -> None:
  init_db()


@app.get("/api/health")
def health() -> dict[str, Any]:
  return {"ok": True, "mode": "fastapi", **database_health_info()}


@app.get("/api/bootstrap")
def bootstrap(user: Optional[dict[str, Any]] = Depends(current_user_optional)) -> dict[str, Any]:
  with db() as conn:
    categories = active_work_categories(conn)
    users = [user_with_profile(conn, row) for row in conn.execute("select * from users order by created_at desc").fetchall()]
    works = public_works(work_rows(conn), categories, include_html=False)
    return {
      "serverMode": True,
      "currentUser": user,
      "categories": categories,
      "settings": settings_rows(conn),
      "users": users,
      "works": works,
      "workEngagements": user_work_engagements(conn, user["id"]) if user else [],
      "ads": [],
      "apiConfigs": api_config_rows(conn),
      "pointsRecords": points_rows(conn),
    }


@app.post("/api/auth/login")
def login(payload: LoginPayload) -> dict[str, Any]:
  identifier = payload.identifier.strip().lower()
  with db() as conn:
    row = conn.execute(
      """
      select * from users
      where lower(coalesce(phone, '')) = ?
         or lower(coalesce(email, '')) = ?
         or lower(coalesce(username, '')) = ?
      """,
      (identifier, identifier, identifier),
    ).fetchone()
    if not row or not verify_password(payload.password, row["password_hash"] or ""):
      raise HTTPException(status_code=401, detail="账号或密码不正确")
    stamp = now_text()
    conn.execute("update users set last_login_at = ?, last_active_at = ?, activity_score = min(activity_score + 3, 100) where id = ?", (stamp, stamp, row["id"]))
    token = create_session(conn, row["id"])
    fresh = conn.execute("select * from users where id = ?", (row["id"],)).fetchone()
    return {"token": token, "user": user_with_profile(conn, fresh), "workEngagements": user_work_engagements(conn, row["id"])}


@app.post("/api/auth/register")
def register(payload: RegisterPayload) -> dict[str, Any]:
  phone = payload.phone.strip()
  email = payload.email.strip().lower() or None
  if not phone or not payload.name.strip() or not payload.password:
    raise HTTPException(status_code=400, detail="手机号、昵称和密码不能为空")
  with db() as conn:
    exists = conn.execute(
      "select id from users where phone = ? or (? is not null and email = ?)",
      (phone, email, email),
    ).fetchone()
    if exists:
      raise HTTPException(status_code=409, detail="手机号或邮箱已被注册")
    user_id = f"u-{secrets.token_hex(8)}"
    profile = {
      "signature": payload.signature,
      "field": payload.field,
      "termsAccepted": True,
      "language": "zh-CN",
      "timezone": "Asia/Shanghai",
      "visibility": "public",
    }
    conn.execute(
      """
      insert into users(id, phone, email, username, name, avatar, password_hash, role, profile_json, created_at, last_login_at, last_active_at)
      values(?, ?, ?, ?, ?, ?, ?, 'creator', ?, ?, ?, ?)
      """,
      (
        user_id,
        phone,
        email,
        phone,
        payload.name.strip(),
        payload.avatar or "images/avatars/avatar-dog.png",
        hash_password(payload.password),
        json_dumps(profile),
        now_text(),
        now_text(),
        now_text(),
      ),
    )
    conn.execute(
      """
      insert or replace into user_profiles(
        user_id, avatar, signature, field, account_type, language, timezone, visibility, newsletter, terms_accepted, updated_at
      )
      values(?, ?, ?, ?, ?, 'zh-CN', 'Asia/Shanghai', 'public', 1, 1, ?)
      """,
      (
        user_id,
        payload.avatar or "images/avatars/avatar-dog.png",
        payload.signature,
        payload.field,
        "个人创作者",
        now_text(),
      ),
    )
    token = create_session(conn, user_id)
    row = conn.execute("select * from users where id = ?", (user_id,)).fetchone()
    return {"token": token, "user": user_with_profile(conn, row), "workEngagements": []}


@app.post("/api/auth/provider-login")
def provider_login(payload: ProviderPayload) -> dict[str, Any]:
  provider = payload.provider.strip().lower()
  if not provider:
    raise HTTPException(status_code=400, detail="provider 不能为空")
  label = payload.label or provider
  email = f"{provider}.user@oauth.local"
  with db() as conn:
    row = conn.execute("select * from users where login_provider = ? and email = ?", (provider, email)).fetchone()
    if not row:
      user_id = f"u-{secrets.token_hex(8)}"
      conn.execute(
        """
        insert into users(id, phone, email, username, name, avatar, password_hash, role, profile_json, login_provider, created_at, last_login_at, last_active_at)
        values(?, null, ?, ?, ?, ?, ?, 'creator', ?, ?, ?, ?, ?)
        """,
        (
          user_id,
          email,
          f"{provider}_creator",
          f"{label} 用户",
          "images/avatars/avatar-deer.png" if provider == "github" else "images/avatars/avatar-dog.png",
          hash_password(secrets.token_urlsafe(16)),
          json_dumps({"signature": "通过第三方账号快速加入 Coding社区。", "field": "创意组件"}),
          provider,
          now_text(),
          now_text(),
          now_text(),
        ),
      )
      row = conn.execute("select * from users where id = ?", (user_id,)).fetchone()
      conn.execute(
        """
        insert or replace into user_profiles(
          user_id, avatar, signature, field, account_type, language, timezone, visibility, newsletter, terms_accepted, updated_at
        )
        values(?, ?, ?, ?, ?, 'zh-CN', 'Asia/Shanghai', 'public', 1, 1, ?)
        """,
        (
          user_id,
          "images/avatars/avatar-deer.png" if provider == "github" else "images/avatars/avatar-dog.png",
          "通过第三方账号快速加入 Coding社区。",
          "创意组件",
          "个人创作者",
          now_text(),
        ),
      )
    token = create_session(conn, row["id"])
    return {"token": token, "user": user_with_profile(conn, row), "workEngagements": user_work_engagements(conn, row["id"])}


@app.get("/api/me")
def me(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
  return {"user": user}


@app.put("/api/me/profile")
def update_profile(payload: ProfilePayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
  user_id = user["id"]
  name = payload.name.strip() or user.get("name") or "创作者"
  email = payload.email.strip().lower() or None
  phone = payload.phone.strip() or None

  with db() as conn:
    exists = conn.execute(
      """
      select id from users
      where id != ?
        and (
          (? is not null and phone = ?)
          or (? is not null and lower(email) = ?)
        )
      """,
      (user_id, phone, phone, email, email),
    ).fetchone()
    if exists:
      raise HTTPException(status_code=409, detail="手机号或邮箱已被其他用户使用")

    password_sql = ", password_hash = ?" if payload.password else ""
    params: list[Any] = [name, email, phone, payload.avatar or user.get("avatar") or "", now_text()]
    if payload.password:
      params.append(hash_password(payload.password))
    params.append(user_id)
    conn.execute(
      f"""
      update users
      set name = ?, email = ?, phone = ?, avatar = ?, last_active_at = ?{password_sql}
      where id = ?
      """,
      params,
    )

    conn.execute(
      """
      insert into user_profiles(
        user_id, avatar, signature, field, account_type, title, organization, location, website, bio,
        language, timezone, visibility, newsletter, terms_accepted, updated_at
      )
      values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(user_id) do update set
        avatar = excluded.avatar,
        signature = excluded.signature,
        field = excluded.field,
        account_type = excluded.account_type,
        title = excluded.title,
        organization = excluded.organization,
        location = excluded.location,
        website = excluded.website,
        bio = excluded.bio,
        language = excluded.language,
        timezone = excluded.timezone,
        visibility = excluded.visibility,
        newsletter = excluded.newsletter,
        terms_accepted = excluded.terms_accepted,
        updated_at = excluded.updated_at
      """,
      (
        user_id,
        payload.avatar or user.get("avatar") or "",
        payload.signature,
        payload.field,
        payload.accountType,
        payload.title,
        payload.organization,
        payload.location,
        payload.website,
        payload.bio,
        payload.language,
        payload.timezone,
        payload.visibility,
        int(payload.newsletter),
        int(payload.termsAccepted),
        now_text(),
      ),
    )
    row = conn.execute("select * from users where id = ?", (user_id,)).fetchone()
    return {"user": user_with_profile(conn, row)}


@app.get("/api/works")
def list_works() -> dict[str, Any]:
  with db() as conn:
    categories = active_work_categories(conn)
    rows = work_rows(conn)
    return {"works": public_works(rows, categories, include_html=False)}


@app.get("/api/works/{work_id}")
def get_work(work_id: str) -> dict[str, Any]:
  with db() as conn:
    categories = active_work_categories(conn)
    row = work_row(conn, work_id)
    if not row:
      raise HTTPException(status_code=404, detail="作品不存在")
    return {"work": public_works([row], categories, include_html=False)[0]}


@app.post("/api/works/{work_id}/engagements")
def set_work_engagement(
  work_id: str,
  payload: WorkEngagementPayload,
  user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
  kind = payload.kind.strip().lower()
  if kind not in ENGAGEMENT_KINDS:
    raise HTTPException(status_code=400, detail="互动类型不正确")
  with db() as conn:
    exists = conn.execute("select id from works where id = ?", (work_id,)).fetchone()
    if not exists:
      raise HTTPException(status_code=404, detail="作品不存在")
    if payload.active:
      conn.execute(
        """
        insert or ignore into work_engagements(user_id, work_id, kind, created_at)
        values(?, ?, ?, ?)
        """,
        (user["id"], work_id, kind, now_text()),
      )
    else:
      conn.execute(
        "delete from work_engagements where user_id = ? and work_id = ? and kind = ?",
        (user["id"], work_id, kind),
      )
    categories = active_work_categories(conn)
    row = work_row(conn, work_id)
    return {
      "work": public_works([row], categories, include_html=False)[0],
      "engagement": user_work_engagement_state(conn, user["id"], work_id),
      "workEngagements": user_work_engagements(conn, user["id"]),
    }


@app.post("/api/works/{work_id}/events")
def record_work_event(work_id: str, payload: WorkEventPayload) -> dict[str, Any]:
  kind = payload.kind.strip().lower()
  metric_columns = {
    "view": "view_count",
    "trial": "trial_count",
    "vibe": "vibe_count",
  }
  column = metric_columns.get(kind)
  if not column:
    raise HTTPException(status_code=400, detail="事件类型不正确")
  with db() as conn:
    exists = conn.execute("select id from works where id = ?", (work_id,)).fetchone()
    if not exists:
      raise HTTPException(status_code=404, detail="作品不存在")
    conn.execute(f"update works set {column} = coalesce({column}, 0) + 1, updated_at = ? where id = ?", (now_text(), work_id))
    categories = active_work_categories(conn)
    row = work_row(conn, work_id)
    return {"work": public_works([row], categories, include_html=False)[0]}


@app.get("/api/works/{work_id}/preview")
def preview_work(work_id: str):
  with db() as conn:
    row = conn.execute("select html_path, html_content, title from works where id = ?", (work_id,)).fetchone()
    if not row:
      raise HTTPException(status_code=404, detail="作品不存在")
    if row["html_path"]:
      path = (ROOT / row["html_path"]).resolve()
      uploads_root = UPLOAD_DIR.resolve()
      if (
        str(path).startswith(str(uploads_root))
        and path.suffix.lower() in {".html", ".htm"}
        and path.exists()
        and path.is_file()
      ):
        return FileResponse(path, media_type="text/html")
    html = row["html_content"] or read_work_html(row["html_path"])
    if not html:
      raise HTTPException(status_code=404, detail="作品预览不存在")
    return HTMLResponse(html)


@app.post("/api/vibe/sessions")
def create_vibe_session(payload: VibeSessionPayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
  with db() as conn:
    categories = active_work_categories(conn)
    row = work_row(conn, payload.workId.strip())
    if not row:
      raise HTTPException(status_code=404, detail="作品不存在")
    html = row["html_content"] or read_work_html(row["html_path"])
    if not html:
      raise HTTPException(status_code=404, detail="作品源码不存在")
    conn.execute("update works set vibe_count = coalesce(vibe_count, 0) + 1, updated_at = ? where id = ?", (now_text(), payload.workId.strip()))
    row = work_row(conn, payload.workId.strip())
    work = public_works([row], categories, include_html=False)[0]
  session_id = secrets.token_urlsafe(18)
  session = {
    "id": session_id,
    "userId": user["id"],
    "work": work,
    "currentHtml": html,
    "version": 1,
    "messages": [
      {
        "role": "assistant",
        "content": f"已载入「{work['title']}」。你可以直接描述想改变的文案、风格、布局或交互。",
        "createdAt": now_text(),
      }
    ],
    "createdAt": now_text(),
    "updatedAt": now_text(),
  }
  VIBE_SESSIONS[session_id] = session
  return {"session": public_vibe_session(session)}


@app.get("/api/vibe/sessions/{session_id}/preview")
def preview_vibe_session(session_id: str) -> HTMLResponse:
  session = VIBE_SESSIONS.get(session_id)
  if not session:
    raise HTTPException(status_code=404, detail="做同款会话不存在")
  return HTMLResponse(session["currentHtml"])


@app.post("/api/vibe/sessions/{session_id}/messages")
def create_vibe_message(
  session_id: str,
  payload: VibeMessagePayload,
  user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
  prompt = payload.prompt.strip()
  if len(prompt) < 2:
    raise HTTPException(status_code=400, detail="请输入更明确的修改指令")
  session = require_vibe_session(session_id, user)
  user_message = {"role": "user", "content": prompt, "createdAt": now_text()}
  config: dict[str, Any]
  with db() as conn:
    config = deepseek_api_config(conn)
  html, reply = call_deepseek_vibe(session["currentHtml"], prompt, session["messages"], config)
  assistant_message = {"role": "assistant", "content": reply, "createdAt": now_text()}
  session["messages"] = [*session["messages"], user_message, assistant_message][-30:]
  session["currentHtml"] = html
  session["version"] = int(session.get("version", 1)) + 1
  session["updatedAt"] = now_text()
  return {"message": assistant_message, "session": public_vibe_session(session)}


async def parse_vibe_save_request(request: Request) -> tuple[dict[str, Any], Optional[UploadFile]]:
  content_type = request.headers.get("content-type", "")
  if "multipart/form-data" in content_type or "application/x-www-form-urlencoded" in content_type:
    form = await request.form()
    data = {
      "title": str(form.get("title") or ""),
      "categories": [str(item) for item in form.getlist("categories") if str(item).strip()],
      "author": str(form.get("author") or ""),
      "paidTrial": str(form.get("paidTrial") or "false"),
      "description": str(form.get("description") or ""),
      "tags": str(form.get("tags") or ""),
      "highlights": str(form.get("highlights") or ""),
      "useCases": str(form.get("useCases") or ""),
      "creatorNote": str(form.get("creatorNote") or ""),
      "version": str(form.get("version") or ""),
    }
    cover = form.get("cover")
    return data, cover if hasattr(cover, "filename") and hasattr(cover, "file") else None
  try:
    body = await request.json()
  except Exception:
    body = {}
  data = body if isinstance(body, dict) else {}
  return {
    "title": str(data.get("title") or ""),
    "categories": data.get("categories") or [],
    "author": str(data.get("author") or ""),
    "paidTrial": data.get("paidTrial", False),
    "description": str(data.get("description") or ""),
    "tags": str(data.get("tags") or ""),
    "highlights": str(data.get("highlights") or ""),
    "useCases": str(data.get("useCases") or ""),
    "creatorNote": str(data.get("creatorNote") or ""),
    "version": str(data.get("version") or ""),
  }, None


@app.post("/api/vibe/sessions/{session_id}/save")
async def save_vibe_variant(
  session_id: str,
  request: Request,
  user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
  session = require_vibe_session(session_id, user)
  work = session["work"]
  work_id = f"work-{secrets.token_hex(8)}"
  payload, cover = await parse_vibe_save_request(request)
  if not str(payload.get("title") or "").strip():
    raise HTTPException(status_code=400, detail="请输入新作品名称")
  with db() as conn:
    active_categories = active_work_categories(conn)
  title, requested_categories, author_name, description, tag_values, cover_file = require_work_submission_fields(
    title=str(payload.get("title") or ""),
    categories=payload.get("categories") or [],
    author=str(payload.get("author") or ""),
    description=str(payload.get("description") or ""),
    tags=str(payload.get("tags") or ""),
    cover=cover,
  )
  paid_trial = truthy_form_value(payload.get("paidTrial"))
  categories = canonical_work_categories(requested_categories, active_categories)
  parent_generation = int(work.get("derivativeGeneration") or 0)
  derivative_generation = parent_generation + 1
  original_work_id = work.get("originalWorkId") or work.get("originWorkId") or work["id"]
  original_work_title = work.get("originalWorkTitle") or work.get("originWorkTitle") or work["title"]
  parent_work_id = work["id"]
  parent_work_title = work["title"]
  folder = user_work_folder(user, title, work_id)
  html_path_obj = folder / "index.html"
  html_path_obj.write_text(session["currentHtml"], encoding="utf-8")
  html_path = str(html_path_obj.relative_to(ROOT)).replace("\\", "/")
  cover_suffix = Path(cover_file.filename or "").suffix.lower() or ".png"
  image_url = write_upload_to_path(cover_file, folder / f"cover{cover_suffix}")
  with db() as conn:
    conn.execute(
      """
      insert into works(
        id, title, category, author, author_id, points, paid_trial, featured, status, image_url, html_path,
        html_content, description, categories_json, tags_json, highlights_json, use_cases_json,
        creator_note, version, source_type, origin_work_id, origin_work_title, original_work_id, original_work_title,
        parent_work_id, parent_work_title, derivative_generation, created_at, updated_at, sales_count, revenue_points
      )
      values(?, ?, ?, ?, ?, 0, ?, 0, 'published', ?, ?, '', ?, ?, ?, ?, ?, ?, ?, 'vibe-remix', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
      """,
      (
        work_id,
        title,
        categories[0],
        author_name,
        user["id"],
        1 if paid_trial else 0,
        image_url,
        html_path,
        description,
        json_dumps(canonical_work_categories(categories, active_categories)),
        json_dumps(tag_values),
        json_dumps(parsed_lines(payload.get("highlights"))),
        json_dumps(parsed_lines(payload.get("useCases"))),
        str(payload.get("creatorNote") or "").strip(),
        str(payload.get("version") or "").strip(),
        original_work_id,
        original_work_title,
        original_work_id,
        original_work_title,
        parent_work_id,
        parent_work_title,
        derivative_generation,
        now_text(),
        now_text(),
      ),
    )
    row = work_row(conn, work_id)
    return {"work": public_works([row], active_categories, include_html=False)[0]}


@app.post("/api/works")
def create_work(
  title: str = Form(...),
  category: str = Form(""),
  categories: list[str] = Form([]),
  author: str = Form(""),
  paidTrial: str = Form("false"),
  status: str = Form("published"),
  description: str = Form(""),
  tags: str = Form(""),
  highlights: str = Form(""),
  useCases: str = Form(""),
  creatorNote: str = Form(""),
  version: str = Form(""),
  cover: Optional[UploadFile] = File(None),
  file: Optional[UploadFile] = File(None),
  user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
  work_id = f"work-{secrets.token_hex(8)}"
  with db() as conn:
    active_categories = active_work_categories(conn)
  clean_title, requested_categories, author_name, clean_description, tag_values, cover_file = require_work_submission_fields(
    title=title,
    categories=categories or [category],
    author=author,
    description=description,
    tags=tags,
    cover=cover,
    html_file=file,
    require_html_file=True,
  )
  selected_categories = canonical_work_categories(requested_categories, active_categories)
  paid_trial = truthy_form_value(paidTrial)
  work_folder = user_work_folder(user, clean_title, work_id)
  html_path = write_upload_to_path(file, work_folder / "index.html")
  cover_suffix = Path(cover_file.filename or "").suffix.lower() or ".png"
  image_url = write_upload_to_path(cover_file, work_folder / f"cover{cover_suffix}")
  author_id = user["id"]
  normalized_status = "reviewing"
  with db() as conn:
    conn.execute(
      """
      insert into works(
        id, title, category, author, author_id, points, paid_trial, featured, status, image_url, html_path,
        description, categories_json, tags_json, highlights_json, use_cases_json, creator_note, version, source_type, created_at, updated_at
      )
      values(?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'user-upload', ?, ?)
      """,
      (
        work_id,
        clean_title,
        selected_categories[0],
        author_name,
        author_id,
        1 if paid_trial else 0,
        normalized_status,
        image_url,
        html_path,
        clean_description,
        json_dumps(selected_categories),
        json_dumps(tag_values),
        json_dumps(parsed_lines(highlights)),
        json_dumps(parsed_lines(useCases)),
        creatorNote.strip(),
        version.strip(),
        today_text(),
        now_text(),
      ),
    )
    row = work_row(conn, work_id)
    return {"work": public_works([row], active_categories, include_html=True)[0]}


@app.post("/api/admin/login")
def admin_login(payload: AdminLoginPayload) -> dict[str, Any]:
  with db() as conn:
    row = conn.execute("select value_json from settings where id = 'adminAuth'").fetchone()
    auth = json_loads(row["value_json"], DEFAULT_ADMIN_AUTH) if row else DEFAULT_ADMIN_AUTH
    if payload.username != auth.get("username") or payload.password != auth.get("password"):
      raise HTTPException(status_code=401, detail="后台账号或密码错误")
    token = secrets.token_urlsafe(24)
    stamp = now_text()
    conn.execute("insert into admin_sessions(token, created_at, last_seen_at) values(?, ?, ?)", (token, stamp, stamp))
    return {"ok": True, "token": token}


@app.patch("/api/admin/works/{work_id}")
def admin_update_work(work_id: str, payload: AdminWorkPayload, admin: dict[str, Any] = Depends(current_admin)) -> dict[str, Any]:
  with db() as conn:
    active_categories = active_work_categories(conn)
    exists = conn.execute("select id from works where id = ?", (work_id,)).fetchone()
    if not exists:
      raise HTTPException(status_code=404, detail="作品不存在")
    selected_categories = canonical_work_categories(payload.categories or [payload.category], active_categories)
    conn.execute(
      """
      update works
      set title = ?, category = ?, categories_json = ?, author = ?, points = ?, featured = ?, status = ?, updated_at = ?
      where id = ?
      """,
      (
        payload.title.strip() or "未命名作品",
        selected_categories[0],
        json_dumps(selected_categories),
        payload.author.strip() or "匿名创作者",
        max(0, int(payload.points or 0)),
        1 if payload.featured else 0,
        normalize_work_status(payload.status),
        now_text(),
        work_id,
      ),
    )
    row = work_row(conn, work_id)
    return {"work": public_works([row], active_categories, include_html=True)[0]}


@app.delete("/api/admin/works/{work_id}")
def admin_delete_work(work_id: str, admin: dict[str, Any] = Depends(current_admin)) -> dict[str, Any]:
  with db() as conn:
    row = conn.execute("select html_path, image_url from works where id = ?", (work_id,)).fetchone()
    if not row:
      raise HTTPException(status_code=404, detail="作品不存在")
    conn.execute("delete from work_engagements where work_id = ?", (work_id,))
    conn.execute("delete from works where id = ?", (work_id,))
    work_folders: set[Path] = set()
    for value in (row["html_path"], row["image_url"]):
      if not value or not str(value).startswith("uploads/"):
        continue
      path = (ROOT / value).resolve()
      if str(path).startswith(str(USER_UPLOAD_DIR.resolve())):
        work_folders.add(path.parent)
        continue
      if str(path).startswith(str(UPLOAD_DIR.resolve())) and path.exists() and path.is_file():
        path.unlink()
    for folder in work_folders:
      if str(folder).startswith(str(USER_UPLOAD_DIR.resolve())) and folder.exists():
        shutil.rmtree(folder)
    return {"ok": True, "id": work_id}


@app.patch("/api/admin/users/{user_id}")
def admin_update_user(user_id: str, payload: AdminUserPayload, admin: dict[str, Any] = Depends(current_admin)) -> dict[str, Any]:
  email = payload.email.strip().lower() or None
  role = payload.role.strip() or "creator"
  if role not in {"admin", "creator", "member"}:
    raise HTTPException(status_code=400, detail="用户角色不正确")
  with db() as conn:
    row = conn.execute("select * from users where id = ?", (user_id,)).fetchone()
    if not row:
      raise HTTPException(status_code=404, detail="用户不存在")
    if email:
      exists = conn.execute("select id from users where id != ? and lower(email) = ?", (user_id, email)).fetchone()
      if exists:
        raise HTTPException(status_code=409, detail="邮箱已被其他用户使用")
    conn.execute(
      """
      update users
      set email = ?, subscription_plan = ?, subscription_status = ?, role = ?, points = ?, last_active_at = ?
      where id = ?
      """,
      (
        email,
        payload.subscriptionPlan.strip() or "Free",
        payload.subscriptionStatus.strip() or "free",
        role,
        max(0, int(payload.points or 0)),
        now_text(),
        user_id,
      ),
    )
    fresh = conn.execute("select * from users where id = ?", (user_id,)).fetchone()
    return {"user": user_with_profile(conn, fresh)}


@app.delete("/api/admin/users/{user_id}")
def admin_delete_user(user_id: str, admin: dict[str, Any] = Depends(current_admin)) -> dict[str, Any]:
  if user_id == "u-admin":
    raise HTTPException(status_code=400, detail="默认管理员不可删除")
  with db() as conn:
    row = conn.execute("select role from users where id = ?", (user_id,)).fetchone()
    if not row:
      raise HTTPException(status_code=404, detail="用户不存在")
    if row["role"] == "admin":
      raise HTTPException(status_code=400, detail="管理员用户不可直接删除")
    conn.execute("update works set author_id = '' where author_id = ?", (user_id,))
    conn.execute("delete from sessions where user_id = ?", (user_id,))
    conn.execute("delete from user_profiles where user_id = ?", (user_id,))
    conn.execute("delete from points_records where user_id = ?", (user_id,))
    conn.execute("delete from work_engagements where user_id = ?", (user_id,))
    conn.execute("delete from users where id = ?", (user_id,))
    return {"ok": True, "id": user_id}


@app.put("/api/admin/api-configs/{config_id}")
def admin_update_api_config(config_id: str, payload: AdminApiConfigPayload, admin: dict[str, Any] = Depends(current_admin)) -> dict[str, Any]:
  config_json = {
    "temperature": max(0, min(2, float(payload.temperature))),
  }
  with db() as conn:
    conn.execute(
      """
      insert into api_configs(id, provider, base_url, model, api_key, enabled, config_json, updated_at)
      values(?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        provider = excluded.provider,
        base_url = excluded.base_url,
        model = excluded.model,
        api_key = excluded.api_key,
        enabled = excluded.enabled,
        config_json = excluded.config_json,
        updated_at = excluded.updated_at
      """,
      (
        config_id,
        payload.provider.strip() or "DeepSeek",
        payload.baseUrl.strip(),
        payload.model.strip(),
        payload.apiKey,
        1 if payload.enabled else 0,
        json_dumps(config_json),
        now_text(),
      ),
    )
    row = conn.execute("select * from api_configs where id = ?", (config_id,)).fetchone()
    return {
      "apiConfig": api_config_rows(conn, include_secret=True)[0] if row else None,
      "apiConfigs": api_config_rows(conn, include_secret=True),
    }


@app.post("/api/admin/points-records")
def admin_create_point_record(payload: AdminPointPayload, admin: dict[str, Any] = Depends(current_admin)) -> dict[str, Any]:
  amount = int(payload.amount or 0)
  if amount == 0:
    raise HTTPException(status_code=400, detail="点数数量不能为 0")
  kind = payload.type.strip() or "adjust"
  if kind not in {"recharge", "consume", "reward", "adjust", "sale", "earn", "bonus"}:
    raise HTTPException(status_code=400, detail="点数类型不正确")
  signed_amount = -abs(amount) if kind == "consume" else amount
  record_id = f"p-{secrets.token_hex(8)}"
  with db() as conn:
    user = conn.execute("select * from users where id = ?", (payload.userId,)).fetchone()
    if not user:
      raise HTTPException(status_code=404, detail="用户不存在")
    conn.execute(
      "insert into points_records(id, user_id, amount, kind, note, created_at) values(?, ?, ?, ?, ?, ?)",
      (record_id, payload.userId, signed_amount, kind, payload.note.strip() or "后台调整", today_text()),
    )
    conn.execute(
      """
      update users
      set points = max(points + ?, 0),
          points_earned = points_earned + case when ? > 0 then ? else 0 end,
          last_active_at = ?
      where id = ?
      """,
      (signed_amount, signed_amount, signed_amount, now_text(), payload.userId),
    )
    fresh_user = conn.execute("select * from users where id = ?", (payload.userId,)).fetchone()
    record = conn.execute("select * from points_records where id = ?", (record_id,)).fetchone()
    return {"record": point_row_to_dict(record), "user": user_with_profile(conn, fresh_user)}


@app.put("/api/admin/settings")
def admin_update_settings(payload: AdminSettingsPayload, admin: dict[str, Any] = Depends(current_admin)) -> dict[str, Any]:
  site = {
    "siteName": payload.siteName.strip() or "Coding社区",
    "announcement": payload.announcement.strip(),
    "tagline": payload.tagline.strip(),
  }
  categories = normalize_category_names(payload.categories)
  auth = {
    "username": payload.username.strip() or "admin",
    "password": payload.password.strip() or DEFAULT_ADMIN_AUTH["password"],
  }
  with db() as conn:
    conn.execute(
      """
      insert into settings(id, value_json) values('site', ?)
      on conflict(id) do update set value_json = excluded.value_json
      """,
      (json_dumps(site),),
    )
    conn.execute(
      """
      insert into settings(id, value_json) values('adminAuth', ?)
      on conflict(id) do update set value_json = excluded.value_json
      """,
      (json_dumps(auth),),
    )
    conn.execute(
      """
      insert into settings(id, value_json) values('workCategories', ?)
      on conflict(id) do update set value_json = excluded.value_json
      """,
      (json_dumps({"categories": categories}),),
    )
    return {"settings": settings_rows(conn)}


@app.get("/api/admin/overview")
def admin_overview() -> dict[str, Any]:
  with db() as conn:
    overview_work_rows = work_rows(conn, order_by="")
    heat_rows = [{"id": row["id"], "title": row["title"], "status": row["status"], "heat": calculate_work_heat(row)} for row in overview_work_rows]
    total_heat = sum(item["heat"] for item in heat_rows)
    published_heat = sum(item["heat"] for item in heat_rows if item["status"] == "published")
    top_heat = max((item["heat"] for item in heat_rows), default=0)
    return {
      "users": conn.execute("select count(*) as n from users").fetchone()["n"],
      "works": len(overview_work_rows),
      "publishedWorks": conn.execute("select count(*) as n from works where status = 'published'").fetchone()["n"],
      "points": conn.execute("select coalesce(sum(points), 0) as n from users").fetchone()["n"],
      "totalHeat": total_heat,
      "publishedHeat": published_heat,
      "averageHeat": round(total_heat / len(overview_work_rows)) if overview_work_rows else 0,
      "topHeat": top_heat,
      "heatRanking": sorted(heat_rows, key=lambda item: item["heat"], reverse=True)[:10],
    }


app.mount("/css", StaticFiles(directory=ROOT / "css"), name="css")
app.mount("/js", StaticFiles(directory=ROOT / "js"), name="js")
app.mount("/images", StaticFiles(directory=ROOT / "images"), name="images")
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")


@app.get("/")
def index_page() -> FileResponse:
  return FileResponse(ROOT / "index.html")


@app.get("/{page_name}.html")
def html_page(page_name: str) -> FileResponse:
  path = ROOT / f"{page_name}.html"
  if not path.exists():
    raise HTTPException(status_code=404, detail="页面不存在")
  return FileResponse(path)
