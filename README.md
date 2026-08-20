# aria-ng-cli

用 Node.js 和 [`sirv`](https://github.com/lukeed/sirv) 原样提供内置的官方 AriaNg
Standard release。安装和运行时无需联网。

## 安装

需要 Node.js 22 或更高版本。

```sh
npm install --global aria-ng-cli
```

## 使用

```text
aria-ng [options]
aria-ng start [options]
aria-ng stop
```

`aria-ng` 等价于 `aria-ng start`。

```text
-p, --port <port>  监听端口，默认 6801
    --host <host>  监听地址，默认 127.0.0.1
    --daemon       后台运行
    --open         启动后打开浏览器
-h, --help         显示帮助
-v, --version      显示版本
```

服务默认仅供本机访问。如需允许局域网访问，可指定 `--host 0.0.0.0`。每个用户
只能运行一个实例，`aria-ng stop` 会停止该实例。

## 开发

```sh
pnpm install
pnpm check
pnpm build
pnpm pack:test
```

更新内置 AriaNg release：

```sh
pnpm sync:ariang -- <version>
```
