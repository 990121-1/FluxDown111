---
title: 安装
description: 在 Windows 上安装当前的 FluxDown GPUI 桌面版。
section: getting-started
order: 1
---

# 安装

目前正式桌面版为 Rust + GPUI 的 Windows 客户端，下载引擎、本机 Agent 与浏览器 Native Messaging 中继会与主程序一起提供。

## Windows

需求：Windows 10 64 位或更新版本，x64。

发行包：
- **安装版** — `FluxDown-<版本>-windows-x64-setup.exe`
- **便携 ZIP** — `FluxDown-<版本>-windows-x64-portable.zip`

便携版的四个 EXE 必须放在同一个目录，只运行 `fluxdown-desktop.exe`。ZIP 内的 `portable` 标记会让程序数据保存在便携目录。

目前安装包未做代码签名，因此 SmartScreen 可能显示未知发布者提示。

## 浏览器扩充

Desktop 会自动注册 Native Messaging Host。安装 FluxDown 扩充后重新载入目标网页，扩充会通过 NMH -> Agent -> Daemon 与本机解析/下载核心通讯。

## 其他平台

Repo 仍保留跨平台 Rust 下载引擎，以及独立的 headless server / CLI。旧 Flutter macOS/Linux/Android App wrapper 已在桌面端切换到 GPUI 后移除。

## 卸载

安装版请从 Windows 设置 -> 应用卸载；便携版从系统匣退出 FluxDown 后直接删除解压目录即可。已经下载的文件不会被删除。
