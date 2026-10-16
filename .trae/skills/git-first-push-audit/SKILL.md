---
name: git-first-push-audit
description: 把智能调度本地项目首次（或全量）上传到 Git 远程仓库时的安全入库流程。当用户要求上传库、推送 GitHub/Gitee、全量提交项目时使用。涵盖嵌套 Git 解除、凭据扫描与 .gitignore 收敛。
---

# 项目首次上传 Git 仓库（安全入库）

把本工作区项目合并提交并推送到远程。默认**单仓库方案**：所有子项目（unified-scheduler、test-env、x-japan-accounts、docs）作为普通目录进一个仓库。本项目含账号矩阵、SCRM、内网 NAS 运维信息，远程必须是**私有库**。

## 0. 开工前必须确认

- 远程仓库 URL（用户提供）；用 `git ls-remote <url>` 验证可达且为空仓库（无输出=空）
- 单仓库还是多仓库（默认单仓库）
- 仓库为 Private
- 缺 URL 时停下问用户，不要自行猜测或建仓

## 1. 排查（只读，不改任何东西）

```powershell
git status --porcelain | Measure-Object -Line          # 改动量
git remote -v                                           # 现有远程
git ls-files -s test-env                                # 160000 = submodule gitlink
Get-ChildItem -Recurse -Force -Directory -Filter ".git" |
  Where-Object { $_.FullName -notmatch 'node_modules' } # 全部嵌套 .git
```

扫描大文件与数据文件（排除 `.git`、`node_modules`）：大于 5MB 的文件、`*.sqlite/*.db/*.log`、`data/` 目录。

## 2. 解除嵌套 Git（关键坑）

`test-env` 历史上是独立仓库，根索引里是 gitlink（160000），直接 `git add` 不会加入文件内容：

1. **先备份独立历史到仓库外，绝不删除**：
   `Move-Item test-env\.git  d:\下载\git-backups\test-env-<日期>.git`
2. `git rm --cached test-env` 解除 gitlink
3. `git add test-env` 按普通目录暂存
4. **解除后禁止再执行 `git reset`（不带路径）**——它会从 HEAD 恢复 gitlink，导致 test-env 整体丢失。需要清暂存用精确路径 `git reset -- <path>`

## 3. .gitignore 基线

在现有规则上确保覆盖：

```gitignore
# 凭据/环境
.env  .env.*  *.pem  *.key
**/NAS_ACCESS.md
**/.cookie_import_token.txt

# 数据与运行产物
*.sqlite *.sqlite3 *.db *.log
**/data/
**/node_modules/  **/chrome_profile/
__pycache__/  *.pyc  *.pyo

# 一次性排障/运维脚本（本项目常含 NAS 用户名、内网 IP、sudo 密码）
.tmp*  _tmp_*  /tmp-*
test-env/_*  test-env/**/_*  test-env/**/nas_*.sh
# 已知含明文密码的脚本，逐个列出（见第 4 步扫描结果）
```

历史上已被跟踪的临时文件（`tmp-*.js` 等）需 `git rm --cached <file>` 显式移出，加 ignore 不会自动剔除。

## 4. 凭据扫描（暂存后、提交前，必须零命中）

文件名扫描：

```powershell
git diff --cached --name-only |
  Select-String -Pattern 'NAS_ACCESS|cookie_import_token|(^|/)\.env|\.pem$|\.key$|\.sqlite|\.db$|\.log$|node_modules|__pycache__|^tmp-'
```

**内容扫描**（本项目真实出现过的秘密，任何一个命中都必须把对应文件移出暂存并加入 ignore）：

```powershell
git grep --cached -l -I "qq409648402"   # NAS SSH 用户名（排障脚本中常连同内网IP出现）
git grep --cached -l -I "Qq254673346"   # NAS sudo 密码
git grep --cached -l -I "shuai2"        # cookie 恢复脚本硬编码密码
git grep --cached -l -I "sudo -S"       # 明文管道密码
git grep --cached -n -I -E "(PASSWORD|SECRET|API_KEY|ACCESS_TOKEN)\s*[:=]\s*['\""][^'\""]{6,}"
git grep --cached -n -I -E "(auth_token|sessionid)['""]?\s*[:=]\s*['""][A-Za-z0-9%._=-]{20,}"
```

排除正规源码后，命中间隔模式时复核上下文（`process.env`/`getenv`/`example`/占位符不算）。含秘密的文件**保留在磁盘**，仅从版本库排除，并向用户说明。

允许保留：正式配置中的内网地址 `192.168.0.100`（约 40 个文件，config/manifest/文档），前提是私有库；要在交付说明中明确提示转公开前必须清洗。

## 5. 提交与推送

```powershell
git config user.name  "<用户名>"        # 仓库级，全局是占位符 !username! 时必须设
git config user.email "<邮箱>"
git commit -m "<中文提交说明>"
git remote add origin <url>            # 已有则跳过
git push -u origin master              # GCM 弹窗时让用户完成 GitHub 授权
```

CRLF/LF 警告无害，可忽略。提交信息要列清入库模块与安全处理。

## 6. 推送后验证（必须做）

```powershell
git ls-remote origin                              # 远程分支指向本次提交
git ls-tree -r origin/master --name-only | Measure  # 文件总数与本地一致
git ls-tree -r origin/master --name-only |
  Select-String -Pattern 'NAS_ACCESS|\.sqlite$|\.env|node_modules|/_|^tmp-'  # 远程树零敏感
git status --porcelain                            # 干净（或仅剩已知忽略项）
```

## 已知项目事实

- `test-env` 独立 Git 历史备份：`d:\下载\git-backups\test-env-20261016.git`
- 首次全量入库提交：`6bc3395`（426 文件），远程 `https://github.com/tttonylu/zhinengdiaodu.git`
- 提交身份：仓库级 `tttonylu <tttonylu@users.noreply.github.com>`
- `_archive/`、根目录 `tmp-*`、`test-env` 下 `_*` 与 `nas_*.sh` 等为本地一次性文件，不要补传
- PowerShell 5 环境：不使用 `&&`，git 命令加 `--no-pager`，`2>&1` 的 NativeCommandError 红字多为 stderr 正常输出，看内容判断成败
