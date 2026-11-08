// swift-tools-version:5.5
// The iOS half of tauri-plugin-flux-webview (ADR 0012): one WKWebView per Flux
// browser tab, the twin of android/'s FluxWebViewPlugin.kt.

import PackageDescription

let package = Package(
  name: "tauri-plugin-flux-webview",
  platforms: [
    .macOS(.v10_13),
    .iOS(.v15),
  ],
  products: [
    .library(
      name: "tauri-plugin-flux-webview",
      type: .static,
      targets: ["tauri-plugin-flux-webview"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-flux-webview",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
