# aria-ng-cli

`aria-ng-cli` 是一个小型 Node.js CLI，用 `sirv` 原样提供官方 AriaNg Standard
release。包内固定包含 `package.json` 所记录的 AriaNg 正式版，启动和安装阶段均不联网。

## 安装

要求 Node.js 22 或更高版本。

```sh
npm install --global aria-ng-cli
```

## 使用

直接运行等价于 `aria-ng start`：

```sh
aria-ng
aria-ng start --port 6801 --host 127.0.0.1
aria-ng --daemon --open
aria-ng stop
```

启动选项：

```text
-p, --port <port>  HTTP 端口，默认 6801
    --host <host>  监听地址，默认 127.0.0.1
    --daemon       后台运行
    --open         启动成功后打开默认浏览器
```

默认只监听本机回环地址。需要从其他设备访问时，应显式传入
`--host 0.0.0.0`，并自行配置防火墙和访问控制。

`--daemon` 会等待后台进程真正监听成功后再返回。后台进程不保留标准输入、
标准输出或错误输出；使用 `aria-ng stop` 发送 `SIGTERM` 并等待最多 5 秒。

## 单例与 pidfile

每个用户只能运行一个实例，pidfile 路径不可配置：

- 设置了绝对路径 `$XDG_RUNTIME_DIR` 时：
  `$XDG_RUNTIME_DIR/aria-ng/aria-ng.pid`
- 其他 Unix 环境：`os.tmpdir()/aria-ng-<uid>/aria-ng/aria-ng.pid`
- Windows：用户系统临时目录下的 `aria-ng-user/aria-ng/aria-ng.pid`

pidfile 使用十进制 PID 加换行。启动时会清理已经失效的 pidfile；`stop` 在服务
未运行时也是成功操作。

## 开发

```sh
pnpm install
pnpm check
pnpm build
pnpm pack:test
```

项目使用 TypeScript、tsgo、oxlint、oxfmt 和 tsdown。`pnpm check` 会执行格式、
lint、类型、测试以及 AriaNg vendor 完整性校验。

更新内置 AriaNg 时运行：

```sh
pnpm sync:ariang -- <version>
```

同步脚本只接受正式 GitHub release，校验 GitHub 发布的 SHA-256 后更新
`vendor/ariang/`、完整性 manifest 和 `package.json` 中的 `ariangVersion`。
